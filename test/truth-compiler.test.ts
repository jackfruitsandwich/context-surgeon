import { describe, expect, it } from "vitest";
import {
  ImmutableRequestCompiler,
  receiveRequest,
  TruthCoreError,
} from "../src/compiler/index.js";
import {
  createDispatchArtifact,
  type ProviderKind,
} from "../src/contracts/truth.js";
import type {
  ResolvedIdentity,
  StateSnapshot,
  SurgeryAction,
} from "../src/contracts/state.js";
import type { ProviderCodec } from "../src/contracts/provider.js";
import { providerCodec } from "../src/providers/index.js";

const identity: ResolvedIdentity = Object.freeze({
  sessionId: "session-truth",
  conversationId: "conversation-truth",
  branchId: "branch-truth",
  revision: 7,
  confidence: "explicit",
});

function received(provider: ProviderKind, value: Record<string, unknown>) {
  const bytes = Buffer.from(JSON.stringify(value), "utf8");
  return receiveRequest({
    requestId: "request-truth",
    route: {
      provider,
      incomingPath:
        provider === "anthropic-messages"
          ? "/v1/messages"
          : provider === "openai-chat-completions"
            ? "/v1/chat/completions"
            : "/v1/responses",
      upstreamUrl: `https://provider.test/${provider}`,
    },
    receivedBytes: bytes,
  });
}

function stateFor(
  codec: ProviderCodec,
  request: ReturnType<typeof received>,
  targets: Array<{ occurrenceId: string; action: SurgeryAction }>
): StateSnapshot {
  const projection = codec.parse(request, identity);
  return Object.freeze({
    version: 4,
    sessionId: identity.sessionId,
    revision: identity.revision,
    surgeries: Object.freeze(
      targets.map((target, index) => {
        const occurrence = projection.occurrences.find(
          (candidate) => candidate.occurrenceId === target.occurrenceId
        );
        if (!occurrence) throw new Error("missing test occurrence");
        return Object.freeze({
          surgeryId: `surgery-${index + 1}`,
          state: "committed" as const,
          branchId: identity.branchId,
          occurrenceId: occurrence.occurrenceId,
          expectedSourceHash: occurrence.sourceHash,
          action: target.action,
          createdAt: "2026-01-01T00:00:00.000Z",
        });
      })
    ),
    bootstrapBranches: Object.freeze([]),
    receiptsByOperationId: Object.freeze({}),
  });
}

function emptyState(): StateSnapshot {
  return Object.freeze({
    version: 4,
    sessionId: identity.sessionId,
    revision: identity.revision,
    surgeries: Object.freeze([]),
    bootstrapBranches: Object.freeze([]),
    receiptsByOperationId: Object.freeze({}),
  });
}

describe("immutable truth compiler", () => {
  it("replaces text while preserving OpenAI reasoning and tool structures byte-equivalent", () => {
    const value = {
      model: "gpt-5.6",
      instructions: "be exact",
      input: [
        {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "secret history" }],
        },
        {
          type: "reasoning",
          id: "rs_1",
          encrypted_content: "opaque-ciphertext",
          summary: [{ type: "summary_text", text: "opaque summary" }],
        },
        {
          type: "function_call",
          call_id: "call_1",
          name: "read_file",
          arguments: '{"path":"a.ts"}',
        },
        {
          type: "function_call_output",
          call_id: "call_1",
          output: "file body",
        },
      ],
    };
    const request = received("openai-responses", value);
    const codec = providerCodec("openai-responses");
    const projection = codec.parse(request, identity);
    const text = projection.occurrences.find((entry) => entry.kind === "user-text")!;
    const reasoning = projection.occurrences.find((entry) => entry.kind === "reasoning")!;
    const toolCall = projection.occurrences.find((entry) => entry.kind === "tool-call")!;
    const state = stateFor(codec, request, [
      { occurrenceId: text.occurrenceId, action: { kind: "evict" } },
      { occurrenceId: reasoning.occurrenceId, action: { kind: "evict" } },
      {
        occurrenceId: toolCall.occurrenceId,
        action: { kind: "replace", content: "must not touch arguments" },
      },
    ]);

    const output = new ImmutableRequestCompiler().compile({
      received: request,
      identity,
      state,
      codec,
    });
    const parsed = JSON.parse(output.exactBody.inspectCopy().toString("utf8")) as {
      input: Array<Record<string, unknown>>;
    };

    expect(parsed.input).toHaveLength(value.input.length);
    expect(parsed.input[0].content).toEqual([
      { type: "input_text", text: "[context-surgeon: evicted]" },
    ]);
    expect(parsed.input[1]).toEqual(value.input[1]);
    expect(parsed.input[2]).toEqual(value.input[2]);
    expect(output.compiled.operationResults.map((result) => result.outcome)).toEqual([
      "applied",
      "protected-residue",
      "protected-residue",
    ]);
    expect(output.compiled.validation).toMatchObject({
      valid: true,
      itemCountBefore: 4,
      itemCountAfter: 4,
      protectedHashesMatch: true,
    });
  });

  it("preserves Anthropic thinking order, signatures, tool input, and item count", () => {
    const thinking = {
      type: "thinking",
      thinking: "private chain",
      signature: "signed-thinking",
    };
    const value = {
      model: "claude-sonnet-4-5",
      max_tokens: 1024,
      messages: [
        { role: "user", content: "inspect a.ts" },
        {
          role: "assistant",
          content: [
            thinking,
            { type: "text", text: "I will inspect it" },
            {
              type: "tool_use",
              id: "toolu_1",
              name: "Read",
              input: { file_path: "a.ts" },
            },
          ],
        },
        {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "toolu_1", content: "source" },
          ],
        },
      ],
    };
    const request = received("anthropic-messages", value);
    const codec = providerCodec("anthropic-messages");
    const projection = codec.parse(request, identity);
    const assistantText = projection.occurrences.find(
      (entry) => entry.kind === "assistant-text"
    )!;
    const thinkingOccurrence = projection.occurrences.find(
      (entry) => entry.kind === "reasoning"
    )!;
    const state = stateFor(codec, request, [
      {
        occurrenceId: assistantText.occurrenceId,
        action: { kind: "replace", content: "Inspection summarized" },
      },
      { occurrenceId: thinkingOccurrence.occurrenceId, action: { kind: "evict" } },
    ]);

    const output = new ImmutableRequestCompiler().compile({
      received: request,
      identity,
      state,
      codec,
    });
    const parsed = JSON.parse(output.exactBody.inspectCopy().toString("utf8")) as {
      messages: Array<{ content: unknown }>;
    };
    const assistant = parsed.messages[1].content as Array<Record<string, unknown>>;
    expect(assistant).toHaveLength(3);
    expect(assistant[0]).toEqual(thinking);
    expect(assistant[1]).toEqual({ type: "text", text: "Inspection summarized" });
    expect(assistant[2]).toEqual(value.messages[1].content[2]);
    expect(output.compiled.operationResults[1].outcome).toBe("protected-residue");
  });

  it("replaces media in place with a provider-valid typed marker", () => {
    const value = {
      model: "gpt-5.6",
      instructions: "",
      input: [
        {
          type: "message",
          role: "user",
          content: [
            { type: "input_text", text: "inspect" },
            { type: "input_image", image_url: "data:image/png;base64,AAA" },
            { type: "input_text", text: "continue" },
          ],
        },
      ],
    };
    const request = received("openai-responses", value);
    const codec = providerCodec("openai-responses");
    const media = codec
      .parse(request, identity)
      .occurrences.find((entry) => entry.kind === "image")!;
    const output = new ImmutableRequestCompiler().compile({
      received: request,
      identity,
      state: stateFor(codec, request, [
        {
          occurrenceId: media.occurrenceId,
          action: { kind: "evict-media", mediaType: "image" },
        },
      ]),
      codec,
    });
    const parsed = JSON.parse(output.exactBody.inspectCopy().toString("utf8")) as {
      input: Array<{ content: Array<Record<string, unknown>> }>;
    };
    expect(parsed.input[0].content).toHaveLength(3);
    expect(parsed.input[0].content[1]).toEqual({
      type: "input_text",
      text: "[context-surgeon: evicted]",
    });
    expect(output.compiled.validation.orderHashAfter).toBe(
      output.compiled.validation.orderHashBefore
    );
  });

  it("rejects duplicate Chat Completions tool identities before an artifact exists", () => {
    const request = received("openai-chat-completions", {
      model: "gpt-4o",
      messages: [
        { role: "user", content: "go" },
        {
          role: "assistant",
          content: null,
          tool_calls: [
            { id: "dup", type: "function", function: { name: "a", arguments: "{}" } },
            { id: "dup", type: "function", function: { name: "b", arguments: "{}" } },
          ],
        },
      ],
    });
    expect(() =>
      new ImmutableRequestCompiler().compile({
        received: request,
        identity,
        state: emptyState(),
        codec: providerCodec("openai-chat-completions"),
      })
    ).toThrow(/Duplicate tool call id/);
  });

  it.each([
    [
      "openai-responses" as const,
      {
        model: "gpt-5.6",
        instructions: "",
        input: [
          { type: "function_call_output", call_id: "call_1", output: "early" },
          { type: "function_call", call_id: "call_1", name: "read", arguments: "{}" },
        ],
      },
    ],
    [
      "openai-chat-completions" as const,
      {
        model: "gpt-4o",
        messages: [
          { role: "tool", tool_call_id: "call_1", content: "early" },
          {
            role: "assistant",
            content: null,
            tool_calls: [
              { id: "call_1", type: "function", function: { name: "read", arguments: "{}" } },
            ],
          },
        ],
      },
    ],
    [
      "anthropic-messages" as const,
      {
        model: "claude-sonnet-4-5",
        messages: [
          {
            role: "user",
            content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "early" }],
          },
          {
            role: "assistant",
            content: [
              { type: "tool_use", id: "toolu_1", name: "Read", input: {} },
            ],
          },
        ],
      },
    ],
  ])("rejects %s tool results that precede their calls", (provider, value) => {
    const request = received(provider, value);
    expect(() =>
      new ImmutableRequestCompiler().compile({
        received: request,
        identity,
        state: emptyState(),
        codec: providerCodec(provider),
      })
    ).toThrow(/no preceding/);
  });

  it("accepts parallel calls with results in a different order without reordering items", () => {
    const value = {
      model: "gpt-5.6",
      instructions: "",
      input: [
        { type: "function_call", call_id: "call_a", name: "read", arguments: '{"path":"a"}' },
        { type: "function_call", call_id: "call_b", name: "read", arguments: '{"path":"b"}' },
        { type: "function_call_output", call_id: "call_b", output: "b" },
        { type: "function_call_output", call_id: "call_a", output: "a" },
      ],
    };
    const request = received("openai-responses", value);
    const output = new ImmutableRequestCompiler().compile({
      received: request,
      identity,
      state: emptyState(),
      codec: providerCodec("openai-responses"),
    });
    const parsed = JSON.parse(output.exactBody.inspectCopy().toString("utf8")) as {
      input: Array<{ call_id?: string }>;
    };
    expect(parsed.input.map((item) => item.call_id)).toEqual([
      "call_a",
      "call_b",
      "call_b",
      "call_a",
    ]);
    expect(output.compiled.validation.valid).toBe(true);
  });

  it("rejects a committed operation whose provider path is absent", () => {
    const request = received("openai-responses", {
      model: "gpt-5.6",
      instructions: "",
      input: [{ type: "message", role: "user", content: "hello" }],
    });
    const state: StateSnapshot = {
      ...emptyState(),
      surgeries: [
        {
          surgeryId: "missing",
          state: "committed",
          branchId: identity.branchId,
          occurrenceId: "occ_missing",
          expectedSourceHash: "missing",
          action: { kind: "evict" },
          createdAt: "2026-01-01T00:00:00.000Z",
        },
      ],
    };
    try {
      new ImmutableRequestCompiler().compile({
        received: request,
        identity,
        state,
        codec: providerCodec("openai-responses"),
      });
      throw new Error("expected compiler rejection");
    } catch (error) {
      expect(error).toBeInstanceOf(TruthCoreError);
      expect((error as TruthCoreError).code).toBe("operation-reconciliation-failed");
      expect((error as TruthCoreError).operationResults[0].outcome).toBe("stale");
    }
  });

  it("detects a codec that mutates protected tool arguments during serialization", () => {
    const request = received("openai-responses", {
      model: "gpt-5.6",
      instructions: "",
      input: [
        {
          type: "function_call",
          call_id: "call_1",
          name: "shell",
          arguments: '{"cmd":"pwd"}',
        },
      ],
    });
    const real = providerCodec("openai-responses");
    const malicious: ProviderCodec = {
      provider: real.provider,
      parse: real.parse.bind(real),
      validate: real.validate.bind(real),
      serialize(context) {
        const value = structuredClone(real.serialize(context)) as {
          input: Array<Record<string, unknown>>;
        };
        value.input[0].arguments = "{}";
        return value;
      },
    };
    expect(() =>
      new ImmutableRequestCompiler().compile({
        received: request,
        identity,
        state: emptyState(),
        codec: malicious,
      })
    ).toThrow(/Untargeted occurrence changed|Protected provider structure changed/);
  });

  it("creates distinct attempt artifacts for retries over identical compiled bytes", () => {
    const request = received("openai-responses", {
      model: "gpt-5.6",
      instructions: "",
      input: [{ type: "message", role: "user", content: "same" }],
    });
    const output = new ImmutableRequestCompiler().compile({
      received: request,
      identity,
      state: emptyState(),
      codec: providerCodec("openai-responses"),
    });
    const envelope = { safeEntries: [], secretSlots: [] };
    const first = createDispatchArtifact({
      compiled: output.compiled,
      exactBody: output.exactBody,
      semanticEnvelope: envelope,
    });
    const second = createDispatchArtifact({
      compiled: output.compiled,
      exactBody: output.exactBody,
      semanticEnvelope: envelope,
    });
    expect(first.attemptId).not.toBe(second.attemptId);
    expect(first.bodySha256).toBe(second.bodySha256);
    expect(first.exactScopeSha256).toBe(second.exactScopeSha256);
  });
});
