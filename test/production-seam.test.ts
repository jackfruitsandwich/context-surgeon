import { randomUUID } from "node:crypto";
import { once } from "node:events";
import http from "node:http";
import { describe, expect, it, vi } from "vitest";
import type {
  AttemptReceipt,
  Occurrence,
  StateReceipt,
  StateSnapshot,
  SurgeryAction,
} from "../src/contracts/index.js";
import { TruthCoreError } from "../src/compiler/index.js";
import {
  compileSupportedRequest,
  type HandlerConfig,
} from "../src/proxy/handler.js";
import { handleSupportedRoute } from "../src/proxy/supported-route.js";
import {
  ConversationTracker,
  ExplicitConversationCatalog,
} from "../src/proxy/conversations.js";
import { SessionIdentityResolver, sourceHash } from "../src/state/identity.js";
import { DirectiveStore } from "../src/store/directive-store.js";
import { InMemoryStateStore } from "./fakes/contracts.js";
import { startFakeUpstream } from "./fakes/upstream.js";

type SeamFixture = Readonly<{
  sessionId: string;
  identityResolver: SessionIdentityResolver;
  state: InMemoryStateStore;
  catalog: ExplicitConversationCatalog;
  directiveStore: DirectiveStore;
  tracker: ConversationTracker;
  config: HandlerConfig;
}>;

function seamFixture(upstreamBase = "http://127.0.0.1:9"): SeamFixture {
  const identityResolver = new SessionIdentityResolver({
    launchId: `production-seam-${randomUUID()}`,
  });
  const sessionId = identityResolver.authority.sessionId;
  const state = new InMemoryStateStore();
  const catalog = new ExplicitConversationCatalog();
  const directiveStore = new DirectiveStore(null);
  const tracker = new ConversationTracker();
  const config: HandlerConfig = {
    directiveStore,
    tracker,
    skillMarkdown: "",
    maxTokens: 128_000,
    upstreamOpenAI: `${upstreamBase}/v1`,
    upstreamAnthropic: upstreamBase,
    upstreamChatGPT: `${upstreamBase}/backend-api`,
    v2Session: {
      sessionId,
      identityResolver,
      store: state,
      catalog,
    },
  };
  return {
    sessionId,
    identityResolver,
    state,
    catalog,
    directiveStore,
    tracker,
    config,
  };
}

function responsesBody(texts: readonly string[], structural: readonly unknown[] = []): Buffer {
  return Buffer.from(
    JSON.stringify({
      model: "gpt-5.6",
      instructions: "",
      input: [
        ...texts.map((text) => ({
          type: "message",
          role: "user",
          content: text,
        })),
        ...structural,
      ],
    }),
    "utf8"
  );
}

async function compile(fixture: SeamFixture, body: Buffer) {
  return compileSupportedRequest(
    "/v1/responses",
    body,
    { "content-type": "application/json" },
    fixture.config
  );
}

function commit(
  fixture: SeamFixture,
  branchId: string,
  targets: readonly Readonly<{
    occurrence: Occurrence;
    action: SurgeryAction;
    expectedSourceHash?: string;
  }>[]
): StateReceipt {
  const current = fixture.state.current(fixture.sessionId);
  const operationId = randomUUID();
  const committedAt = "2026-07-11T12:00:00.000Z";
  const records = targets.map((target) => ({
    surgeryId: randomUUID(),
    state: "committed" as const,
    branchId,
    occurrenceId: target.occurrence.occurrenceId,
    expectedSourceHash:
      target.expectedSourceHash ?? target.occurrence.sourceHash,
    action: target.action,
    createdAt: committedAt,
  }));
  const receipt: StateReceipt = Object.freeze({
    receiptId: randomUUID(),
    operationId,
    sessionId: fixture.sessionId,
    branchId,
    previousRevision: current.revision,
    committedRevision: current.revision + 1,
    surgeryIds: Object.freeze(records.map((record) => record.surgeryId)),
    operationResults: Object.freeze(
      records.map((record) =>
        Object.freeze({
          surgeryId: record.surgeryId,
          occurrenceId: record.occurrenceId,
          expectedSourceHash: record.expectedSourceHash,
          outcome: "committed" as const,
          reason: "intended-surgery-committed",
        })
      )
    ),
    committedAt,
  });
  const next: StateSnapshot = Object.freeze({
    version: 3,
    sessionId: fixture.sessionId,
    revision: current.revision + 1,
    surgeries: Object.freeze([...current.surgeries, ...records]),
    receiptsByOperationId: Object.freeze({
      ...current.receiptsByOperationId,
      [operationId]: receipt,
    }),
  });
  fixture.state.commit({
    expectedRevision: current.revision,
    operationId,
    next,
    receipt,
  });
  return receipt;
}

function onlyBranch(fixture: SeamFixture) {
  const branches = fixture.catalog.list(fixture.sessionId);
  expect(branches).toHaveLength(1);
  return branches[0];
}

function post(input: {
  baseUrl: string;
  path: string;
  body: Buffer;
}): Promise<Readonly<{ status: number; body: Buffer }>> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(input.baseUrl);
    const req = http.request(
      {
        hostname: parsed.hostname,
        port: parsed.port,
        path: input.path,
        method: "POST",
        headers: {
          "content-type": "application/json",
          "content-length": String(input.body.length),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () =>
          resolve({
            status: res.statusCode ?? 0,
            body: Buffer.concat(chunks),
          })
        );
      }
    );
    req.on("error", reject);
    req.end(input.body);
  });
}

describe("production v2 compiler session seam", () => {
  it("fails closed on a malformed partial nested seam without using the legacy bridge", async () => {
    const fixture = seamFixture();
    const legacyGet = vi.spyOn(fixture.directiveStore, "get");
    const legacyRecord = vi.spyOn(fixture.tracker, "record");
    fixture.config.v2Session = {
      sessionId: fixture.sessionId,
    } as NonNullable<HandlerConfig["v2Session"]>;

    await expect(compile(fixture, responsesBody(["must not bridge"]))).rejects.toMatchObject({
      code: "v2-session-seam-incomplete",
      statusCode: 500,
    });
    expect(legacyGet).not.toHaveBeenCalled();
    expect(legacyRecord).not.toHaveBeenCalled();
  });

  it("validates the pristine provider shape before identity observation", async () => {
    const fixture = seamFixture();
    const resolve = vi.spyOn(fixture.identityResolver, "resolve");
    const current = vi.spyOn(fixture.state, "current");
    const duplicateCall = {
      type: "function_call",
      call_id: "duplicate",
      name: "read_file",
      arguments: "{}",
    };

    await expect(
      compile(fixture, responsesBody([], [duplicateCall, duplicateCall]))
    ).rejects.toMatchObject({
      code: "provider-envelope-invalid",
      statusCode: 422,
    });
    expect(resolve).not.toHaveBeenCalled();
    expect(current).not.toHaveBeenCalled();
    expect(fixture.catalog.list(fixture.sessionId)).toEqual([]);
  });

  it("extends the resolved branch, publishes exact occurrences, reads its snapshot, and never consults v1", async () => {
    const fixture = seamFixture();
    const legacyGet = vi.spyOn(fixture.directiveStore, "get");
    const legacyRecord = vi.spyOn(fixture.tracker, "record");

    const first = await compile(fixture, responsesBody(["alpha"]));
    const firstBranch = onlyBranch(fixture);
    const target = firstBranch.occurrences.find(
      (occurrence) => occurrence.kind === "user-text"
    )!;
    const stateReceipt = commit(fixture, firstBranch.identity.branchId, [
      { occurrence: target, action: { kind: "evict" } },
    ]);
    const current = vi.spyOn(fixture.state, "current");

    const second = await compile(fixture, responsesBody(["alpha", "beta"]));
    const extendedBranch = onlyBranch(fixture);
    const output = JSON.parse(second.body.toString("utf8")) as {
      input: Array<{ content: string }>;
    };

    expect(first.artifact.compiled.branchId).toBe(firstBranch.identity.branchId);
    expect(second.artifact.compiled.branchId).toBe(firstBranch.identity.branchId);
    expect(extendedBranch.pristineItemHashes).toHaveLength(2);
    expect(extendedBranch.occurrences).toHaveLength(2);
    expect(current).toHaveBeenCalledWith(fixture.sessionId);
    expect(output.input.map((item) => item.content)).toEqual([
      "[context-surgeon: evicted]",
      "beta",
    ]);
    expect(second.artifact.compiled.operationResults).toMatchObject([
      { surgeryId: stateReceipt.surgeryIds[0], outcome: "applied" },
    ]);
    expect(stateReceipt.operationResults[0].outcome).toBe("committed");
    expect(
      fixture.state.current(fixture.sessionId).receiptsByOperationId[
        stateReceipt.operationId
      ].operationResults[0].outcome
    ).toBe("committed");
    expect(legacyGet).not.toHaveBeenCalled();
    expect(legacyRecord).not.toHaveBeenCalled();
  });

  it("rejects ambiguous earlier branch history before reading durable state", async () => {
    const fixture = seamFixture();
    const current = vi.spyOn(fixture.state, "current");
    await compile(fixture, responsesBody(["ancestor"]));
    await compile(fixture, responsesBody(["ancestor", "main"]));
    await compile(fixture, responsesBody(["ancestor", "fork"]));
    expect(fixture.catalog.list(fixture.sessionId)).toHaveLength(2);
    const readsBeforeAmbiguity = current.mock.calls.length;

    await expect(compile(fixture, responsesBody(["ancestor"]))).rejects.toMatchObject({
      code: "ambiguous-identity",
      statusCode: 409,
    });
    expect(current).toHaveBeenCalledTimes(readsBeforeAmbiguity);
  });

  it("fails closed on a stale expected source hash from the matching snapshot", async () => {
    const fixture = seamFixture();
    const body = responsesBody(["original"]);
    await compile(fixture, body);
    const branch = onlyBranch(fixture);
    const target = branch.occurrences[0];
    commit(fixture, branch.identity.branchId, [
      {
        occurrence: target,
        action: { kind: "replace", content: "replacement" },
        expectedSourceHash: sourceHash("stale-source"),
      },
    ]);

    try {
      await compile(fixture, body);
      throw new Error("expected stale compilation rejection");
    } catch (error) {
      expect(error).toBeInstanceOf(TruthCoreError);
      expect(error).toMatchObject({
        code: "operation-reconciliation-failed",
        operationResults: [{ outcome: "stale" }],
      });
    }
  });

  it("reports protected residue while preserving structural provider content exactly", async () => {
    const fixture = seamFixture();
    const functionCall = {
      type: "function_call",
      call_id: "call_protected",
      name: "read_file",
      arguments: '{"path":"src/index.ts"}',
    };
    const body = responsesBody(["evict me"], [functionCall]);
    await compile(fixture, body);
    const branch = onlyBranch(fixture);
    const text = branch.occurrences.find((entry) => entry.kind === "user-text")!;
    const toolCall = branch.occurrences.find((entry) => entry.kind === "tool-call")!;
    commit(fixture, branch.identity.branchId, [
      { occurrence: text, action: { kind: "evict" } },
      { occurrence: toolCall, action: { kind: "evict" } },
    ]);

    const compiled = await compile(fixture, body);
    const output = JSON.parse(compiled.body.toString("utf8")) as {
      input: Array<Record<string, unknown>>;
    };
    expect(compiled.artifact.compiled.operationResults.map((entry) => entry.outcome)).toEqual([
      "applied",
      "protected-residue",
    ]);
    expect(output.input[1]).toEqual(functionCall);
    expect(compiled.artifact.compiled.validation.protectedHashesMatch).toBe(true);
  });

  it("returns the real handed-off attempt id from the supported-route facade", async () => {
    const upstream = await startFakeUpstream();
    const fixture = seamFixture(upstream.baseUrl);
    const receipts: AttemptReceipt[] = [];
    fixture.config.onAttemptReceipt = (receipt) => receipts.push(receipt);
    let handling:
      | Promise<Readonly<{ handled: boolean; attemptId?: string }>>
      | undefined;
    const server = http.createServer((req, res) => {
      handling = handleSupportedRoute(req, res, fixture.config, false);
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("test server did not bind");
    }

    try {
      const response = await post({
        baseUrl: `http://127.0.0.1:${address.port}`,
        path: "/v1/responses",
        body: responsesBody(["attempt evidence"]),
      });
      expect(response.status).toBe(200);
      if (!handling) throw new Error("supported handler was not invoked");
      const result = await handling;
      const completed = receipts.find(
        (receipt) => receipt.state === "response-completed"
      );
      expect(completed).toBeDefined();
      expect(result).toEqual({
        handled: true,
        attemptId: completed!.attemptId,
      });
    } finally {
      server.close();
      await once(server, "close");
      await upstream.close();
    }
  });
});
