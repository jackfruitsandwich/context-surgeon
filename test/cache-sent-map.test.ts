import { mkdtempSync, rmSync, statSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { canonicalizeSentValue, freezeJsonValue, hmacSentDigest } from "../src/cache/canonical.js";
import { loadOrCreateCacheHmacSecret } from "../src/cache/key-store.js";
import { compileSentMap } from "../src/cache/sent-map.js";
import { ImmutableRequestCompiler, receiveRequest } from "../src/compiler/index.js";
import type { ResolvedIdentity, StateSnapshot } from "../src/contracts/state.js";
import { providerCodec } from "../src/providers/index.js";

const secret = new Uint8Array(32).fill(7);
const identity: ResolvedIdentity = {
  sessionId: "sent-map-session",
  conversationId: "sent-map-conversation",
  branchId: "sent-map-branch",
  revision: 0,
  confidence: "explicit",
};
const temporary: string[] = [];

afterEach(() => temporary.splice(0).forEach((path) => rmSync(path, { recursive: true, force: true })));

function received(provider: "anthropic-messages" | "openai-responses", value: Record<string, unknown>) {
  return receiveRequest({
    requestId: "sent-map-request",
    route: {
      provider,
      incomingPath: provider === "anthropic-messages" ? "/v1/messages" : "/v1/responses",
      upstreamUrl: `https://provider.test/${provider}`,
    },
    receivedBytes: Buffer.from(JSON.stringify(value)),
  });
}

function state(surgeries: StateSnapshot["surgeries"] = []): StateSnapshot {
  return Object.freeze({
    version: 4,
    sessionId: identity.sessionId,
    revision: 0,
    surgeries: Object.freeze([...surgeries]),
    bootstrapBranches: Object.freeze([]),
    receiptsByOperationId: Object.freeze({}),
  });
}

describe("json-insertion-v1 canonicalization", () => {
  it("matches Wuwei's frozen insertion-order golden inputs", () => {
    const left = canonicalizeSentValue({ a: 1, b: 2 });
    const right = canonicalizeSentValue({ b: 2, a: 1 });
    expect(left).toMatchObject({
      canonicalization: "json-insertion-v1",
      json: '{"a":1,"b":2}',
      bytes: 13,
      sha256: "1655fce907dc499796df13899c6e86a0f8327073c1d3f6d888f23aea63e939ed",
    });
    expect(right.sha256).toBe(
      "bd4a3e3dab586d9ce6722392bb5e3437272a6228e0512c5d40a5d196d4badd13"
    );
    expect(Object.isFrozen(freezeJsonValue({ nested: { value: 1 } }))).toBe(true);
    expect(hmacSentDigest(secret, { a: 1 }, "context-surgeon:segment"))
      .not.toBe(hmacSentDigest(secret, { a: 1 }, "wuwei:segment"));
  });

  it("persists an independent mode-0600 local HMAC key across reload", () => {
    const path = mkdtempSync(join(tmpdir(), "cs-cache-key-"));
    temporary.push(path);
    const first = loadOrCreateCacheHmacSecret(path);
    const second = loadOrCreateCacheHmacSecret(path);
    expect(Buffer.from(second).equals(Buffer.from(first))).toBe(true);
    expect(first).toHaveLength(32);
    expect(statSync(join(path, "cache-hmac.key")).mode & 0o777).toBe(0o600);
    unlinkSync(join(path, "cache-hmac.key"));
    expect(() => loadOrCreateCacheHmacSecret(path, { allowCreate: false }))
      .toThrow(/explicit new cache namespace/);
  });
});

describe("compiled provider sent map", () => {
	it("uses one canonical prefix identity for explicit and automatic markers", () => {
		const finalBody = {
			model: "claude-fable-5",
			cache_control: { type: "ephemeral" },
			messages: [{ role: "user", content: [{ type: "text", text: "same", cache_control: { type: "ephemeral" } }] }],
		};
		const map = compileSentMap({
			provider: "anthropic-messages",
			receivedBody: finalBody,
			finalBody,
			exactBodySha256: "exact",
			occurrences: [],
			secret,
		});
		expect(map.breakpoints).toHaveLength(2);
		expect(map.breakpoints[0].sentPrefixDigest).toBe(map.breakpoints[1].sentPrefixDigest);
	});

	it("labels transient legacy telemetry as non-comparable after restart", () => {
		const request = received("openai-responses", { model: "gpt-5.6", input: [] });
		const output = new ImmutableRequestCompiler().compile({
			received: request,
			identity,
			codec: providerCodec("openai-responses"),
			state: state(),
		});
		expect(output.compiled.sentMap.explanationCodes).toContain("ephemeral-telemetry");
		expect(output.compiled.sentMap.explanationCodes).toContain("cache-digests-not-comparable-after-restart");
	});

  it("uses Anthropic tools→system→messages order and preserves explicit breakpoints through surgery", () => {
    const value = {
      model: "claude-opus-4-8",
      max_tokens: 32,
      tools: [{
        name: "read",
        description: "read a file",
        input_schema: { type: "object" },
        cache_control: { type: "ephemeral", ttl: "1h" },
      }],
      system: [{
        type: "text",
        text: "stable system",
        cache_control: { type: "ephemeral", ttl: "1h" },
      }],
      messages: [{
        role: "user",
        content: [{
          type: "text",
          text: "sensitive",
          cache_control: { type: "ephemeral" },
        }],
      }],
    };
    const request = received("anthropic-messages", value);
    const codec = providerCodec("anthropic-messages");
    const projection = codec.parse(request, identity);
    const target = projection.occurrences.find((entry) => entry.kind === "user-text")!;
    const output = new ImmutableRequestCompiler({ cacheHmacSecret: secret }).compile({
      received: request,
      identity,
      codec,
      state: state([{
        surgeryId: "sent-map-replace",
        state: "committed",
        branchId: identity.branchId,
        occurrenceId: target.occurrenceId,
        expectedSourceHash: target.sourceHash,
        action: { kind: "replace", content: "summary" },
        createdAt: "2026-07-11T00:00:00.000Z",
      }]),
    });
    const map = output.compiled.sentMap;
    expect(map.exactBodySha256).toBe(output.exactBody.sha256);
    expect(map.segments.map((segment) => segment.kind)).toEqual([
      "tool",
      "system",
      "message",
    ]);
    expect(map.segments.map((segment) => segment.providerPath)).toEqual([
      ["tools", 0],
      ["system", 0],
      ["messages", 0, "content", 0],
    ]);
    expect(map.breakpoints.map((point) => point.afterSegment)).toEqual([0, 1, 2]);
    expect(map.breakpoints.map((point) => point.requestedTtl)).toEqual(["1h", "1h", undefined]);
    expect(map.preview).toEqual({
      firstDivergenceSegment: 2,
      survivingBreakpoints: [0, 1],
      changedBreakpoints: [2],
    });
    const final = JSON.parse(output.exactBody.inspectCopy().toString("utf8"));
    expect(final.messages[0].content[0]).toEqual({
      type: "text",
      text: "summary",
      cache_control: { type: "ephemeral" },
    });
    expect(map.explanationCodes).toContain("provider-cache-residency-not-claimed");
  });

  it("maps OpenAI tools, schema, instructions, and input without claiming private rendering", () => {
    const value = {
      model: "gpt-5.6",
      tools: [{ type: "function", name: "read", parameters: { type: "object" } }],
      text: { format: { type: "json_schema", name: "answer", schema: { type: "object" } } },
      instructions: "stable instructions",
      input: [{ type: "message", role: "user", content: "hello" }],
    };
    const request = received("openai-responses", value);
    const output = new ImmutableRequestCompiler({ cacheHmacSecret: secret }).compile({
      received: request,
      identity,
      codec: providerCodec("openai-responses"),
      state: state(),
    });
    expect(output.compiled.sentMap.segments.map((segment) => segment.kind)).toEqual([
      "tool",
      "schema",
      "system",
      "message",
    ]);
    expect(output.compiled.sentMap.preview.firstDivergenceSegment).toBeNull();
    expect(output.compiled.sentMap.explanationCodes).toContain(
      "provider-private-rendering-not-claimed"
    );
  });
});
