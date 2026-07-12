import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { canonicalizeItem } from "../src/context/fingerprint.js";
import { reconcileBootstrapState } from "../src/compiler/bootstrap-state.js";
import { ImmutableRequestCompiler, receiveRequest } from "../src/compiler/index.js";
import type { ResolvedIdentity, StateSnapshot } from "../src/contracts/state.js";
import { providerCodec } from "../src/providers/index.js";
import { PristineHistoryTracker } from "../src/state/identity.js";
import { AtomicStateSnapshotStore } from "../src/store/state-snapshot-store.js";

const bootstrap = "# Test Skill\n\ngenuin-joging-awkwerd-febuary";
const signature = "genuin-joging-awkwerd-febuary";
const secret = new Uint8Array(32).fill(19);
const temporary: string[] = [];

afterEach(() => {
  temporary.splice(0).forEach((path) => rmSync(path, { recursive: true, force: true }));
});

function directory(): string {
  const path = mkdtempSync(join(tmpdir(), "cs-bootstrap-truth-"));
  temporary.push(path);
  return path;
}

function body(input: unknown[]): Record<string, unknown> {
  return { model: "gpt-5.6", instructions: "be exact", input };
}

function user(text: string) {
  return { type: "message", role: "user", content: [{ type: "input_text", text }] };
}

function assistant(text: string) {
  return { type: "message", role: "assistant", content: [{ type: "output_text", text }] };
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function request(value: Record<string, unknown>) {
  const bytes = Buffer.from(JSON.stringify(value));
  return receiveRequest({
    requestId: randomUUID(),
    route: {
      provider: "openai-responses",
      incomingPath: "/v1/responses",
      upstreamUrl: "https://provider.test/v1/responses",
    },
    receivedBytes: bytes,
  });
}

function pristineHashes(value: ReturnType<typeof request>): readonly string[] {
  const pending: ResolvedIdentity = {
    sessionId: "pending",
    conversationId: "pending",
    branchId: "pending",
    revision: 0,
    confidence: "explicit",
  };
  return providerCodec("openai-responses")
    .parse(value, pending)
    .context.items.map((item) => hash(canonicalizeItem(item)));
}

function compile(input: {
  value: Record<string, unknown>;
  tracker: PristineHistoryTracker;
  store: AtomicStateSnapshotStore;
  history?: readonly string[];
}) {
  const received = request(input.value);
  const history = input.history ?? pristineHashes(received);
  const identity = input.tracker.observe(history).identity;
  const codec = providerCodec("openai-responses");
  const projection = codec.parse(received, identity);
  const reconciliation = reconcileBootstrapState({
    store: input.store,
    identity,
    projection,
    receivedValue: received.providerValue,
    pristineItemHashes: history,
    skillSignature: signature,
    skillBootstrap: bootstrap,
  });
  const output = new ImmutableRequestCompiler({
    skillBootstrap: bootstrap,
    skillSignature: signature,
    cacheHmacSecret: secret,
  }).compile({
    received,
    identity,
    state: reconciliation.state,
    codec,
  });
  return { received, identity, projection, reconciliation, output };
}

function firstText(output: ReturnType<typeof compile>): string {
  const parsed = JSON.parse(output.output.exactBody.inspectCopy().toString("utf8")) as {
    input: Array<{ content: Array<{ text?: string }> }>;
  };
  return parsed.input[0].content[0].text ?? "";
}

describe("sticky anchored bootstrap", () => {
  it("anchors Anthropic at the first user text without changing system arrays", () => {
    const path = directory();
    const sessionId = hash("anthropic-bootstrap-session");
    const store = AtomicStateSnapshotStore.inSessionDirectory(path, sessionId);
    const tracker = new PristineHistoryTracker(sessionId);
    const value = {
      model: "claude-fable-5",
      max_tokens: 16,
      stream: true,
      system: [{ type: "text", text: "stable system", cache_control: { type: "ephemeral" } }],
      messages: [{ role: "user", content: [{ type: "text", text: "original", cache_control: { type: "ephemeral" } }] }],
    };
    const bytes = Buffer.from(JSON.stringify(value));
    const received = receiveRequest({
      requestId: randomUUID(),
      route: { provider: "anthropic-messages", incomingPath: "/v1/messages", upstreamUrl: "https://provider.test/v1/messages" },
      receivedBytes: bytes,
    });
    const pending: ResolvedIdentity = { sessionId: "pending", conversationId: "pending", branchId: "pending", revision: 0, confidence: "explicit" };
    const codec = providerCodec("anthropic-messages");
    const pristine = codec.parse(received, pending).context.items.map((item) => hash(canonicalizeItem(item)));
    const identity = tracker.observe(pristine).identity;
    const projection = codec.parse(received, identity);
    const reconciliation = reconcileBootstrapState({
      store,
      identity,
      projection,
      receivedValue: received.providerValue,
      pristineItemHashes: pristine,
      skillSignature: signature,
      skillBootstrap: bootstrap,
    });
    const output = new ImmutableRequestCompiler({ skillBootstrap: bootstrap, cacheHmacSecret: secret }).compile({
      received,
      identity,
      state: reconciliation.state,
      codec,
    });
    const final = JSON.parse(output.exactBody.inspectCopy().toString("utf8"));
    expect(final.system).toEqual(value.system);
    expect(final.messages[0].content[0]).toEqual({
      type: "text",
      text: `${bootstrap}\n\noriginal`,
      cache_control: { type: "ephemeral" },
    });
    expect(output.compiled.sentMap.preview).toMatchObject({ firstDivergenceSegment: 1 });
  });

  it("cannot be toggled by later model echo, user paste, or tool output", () => {
    const path = directory();
    const sessionId = hash("echo-session");
    const store = AtomicStateSnapshotStore.inSessionDirectory(path, sessionId);
    const tracker = new PristineHistoryTracker(sessionId);
    const first = compile({ value: body([user("original")]), tracker, store });
    expect(firstText(first)).toBe(`${bootstrap}\n\noriginal`);

    const echo = compile({
      value: body([user("original"), assistant(`model echo ${signature}`)]),
      tracker,
      store,
    });
    const pasted = compile({
      value: body([
        user("original"),
        assistant(`model echo ${signature}`),
        user(`later paste ${signature}`),
        { type: "function_call", call_id: "c1", name: "read", arguments: "{}" },
        { type: "function_call_output", call_id: "c1", output: `tool ${signature}` },
      ]),
      tracker,
      store,
    });
    const echoesRemoved = compile({
      value: body([user("original")]),
      tracker,
      store,
    });

    expect(firstText(echo)).toBe(`${bootstrap}\n\noriginal`);
    expect(firstText(pasted)).toBe(`${bootstrap}\n\noriginal`);
    expect(firstText(echoesRemoved)).toBe(`${bootstrap}\n\noriginal`);
    expect(
      store.current(sessionId).bootstrapBranches[0].decision
    ).toBe("inject");
    expect(
      pasted.output.compiled.operationResults.find((result) => result.surgeryId === "compiler-bootstrap")
        ?.reason
    ).toBe("bootstrap-applied-at-committed-anchor");
  });

  it("is byte-identical across stable repeats, reload, restart, and branch inheritance", () => {
    const path = directory();
    const sessionId = hash("durable-session");
    const store = AtomicStateSnapshotStore.inSessionDirectory(path, sessionId);
    const tracker = new PristineHistoryTracker(sessionId);
    const value = body([user("root")]);
    const first = compile({ value, tracker, store });
    const repeated = compile({ value, tracker, store });
    expect(repeated.output.exactBody.inspectCopy().equals(first.output.exactBody.inspectCopy())).toBe(true);
    expect(repeated.output.compiled.sentMap.sentMapDigest).toBe(
      first.output.compiled.sentMap.sentMapDigest
    );

    const restartedStore = AtomicStateSnapshotStore.inSessionDirectory(path, sessionId);
    const restartedTracker = new PristineHistoryTracker(
      sessionId,
      restartedStore.current(sessionId).bootstrapBranches
    );
    const restarted = compile({ value, tracker: restartedTracker, store: restartedStore });
    expect(restarted.identity.branchId).toBe(first.identity.branchId);
    expect(restarted.output.exactBody.inspectCopy().equals(first.output.exactBody.inspectCopy())).toBe(true);

    const main = compile({
      value: body([user("root"), assistant("main")]),
      tracker: restartedTracker,
      store: restartedStore,
    });
    const fork = compile({
      value: body([user("root"), assistant("fork")]),
      tracker: restartedTracker,
      store: restartedStore,
    });
    expect(fork.identity.branchId).not.toBe(main.identity.branchId);
    expect(fork.identity.parentBranchId).toBe(main.identity.branchId);
    expect(fork.reconciliation.explanationCodes).toContain("bootstrap-branch-inherited");
    expect(firstText(fork)).toBe(`${bootstrap}\n\nroot`);
  });

  it("re-anchors once after trimming, then stops visibly on a second anchor loss", () => {
    const path = directory();
    const sessionId = hash("trim-session");
    const store = AtomicStateSnapshotStore.inSessionDirectory(path, sessionId);
    const tracker = new PristineHistoryTracker(sessionId);
    compile({
      value: body([user("a"), assistant("b"), user("c"), assistant("d")]),
      tracker,
      store,
      history: [hash("a"), hash("b"), hash("c"), hash("d")],
    });
    const trimmed = compile({
      value: body([user("c"), assistant("d"), user("e")]),
      tracker,
      store,
      history: [hash("c"), hash("d"), hash("e")],
    });
    expect(trimmed.reconciliation.explanationCodes).toContain(
      "bootstrap-anchor-reanchored-after-history-trim"
    );
    expect(firstText(trimmed)).toBe(`${bootstrap}\n\nc`);

    const stopped = compile({
      value: body([user("d"), assistant("e"), user("f")]),
      tracker,
      store,
      history: [hash("d"), hash("e"), hash("f")],
    });
    expect(stopped.reconciliation.explanationCodes).toContain(
      "bootstrap-anchor-loss-stopped-visible"
    );
    expect(firstText(stopped)).toBe("d");
    expect(stopped.output.compiled.operationResults.at(-1)).toMatchObject({
      reason: "bootstrap-anchor-loss-stopped-visible",
      attribution: "bootstrap-prefix",
    });
    const receiptedCodes = Object.values(store.current(sessionId).receiptsByOperationId)
      .flatMap((receipt) => receipt.bootstrapTransition?.explanationCodes ?? []);
    expect(receiptedCodes).toContain("bootstrap-anchor-reanchored-after-history-trim");
    expect(receiptedCodes).toContain("bootstrap-anchor-loss-stopped-visible");
  });

  it("attributes user surgery and bootstrap composition on the same first-user path", () => {
    const path = directory();
    const sessionId = hash("composition-session");
    const store = AtomicStateSnapshotStore.inSessionDirectory(path, sessionId);
    const tracker = new PristineHistoryTracker(sessionId);
    const base = compile({ value: body([user("sensitive")]), tracker, store });
    const target = base.projection.occurrences.find((entry) => entry.kind === "user-text")!;
    const surgery = Object.freeze({
          surgeryId: "replace-first",
          state: "committed" as const,
          branchId: base.identity.branchId,
          occurrenceId: target.occurrenceId,
          expectedSourceHash: target.sourceHash,
          action: Object.freeze({ kind: "replace" as const, content: "summary" }),
          createdAt: "2026-07-11T00:00:00.000Z",
    });
    const current = store.current(sessionId);
    const operationId = randomUUID();
    const receipt = Object.freeze({
      receiptId: randomUUID(),
      operationId,
      sessionId,
      branchId: base.identity.branchId,
      previousRevision: current.revision,
      committedRevision: current.revision + 1,
      surgeryIds: Object.freeze([surgery.surgeryId]),
      operationResults: Object.freeze([Object.freeze({
        surgeryId: surgery.surgeryId,
        occurrenceId: surgery.occurrenceId,
        expectedSourceHash: surgery.expectedSourceHash,
        outcome: "committed" as const,
      })]),
      committedAt: surgery.createdAt,
    });
    const next: StateSnapshot = Object.freeze({
      ...current,
      revision: current.revision + 1,
      surgeries: Object.freeze([...current.surgeries, surgery]),
      receiptsByOperationId: Object.freeze({
        ...current.receiptsByOperationId,
        [operationId]: receipt,
      }),
    });
    store.commit({ expectedRevision: current.revision, operationId, next, receipt });
    const applied = compile({ value: body([user("sensitive")]), tracker, store });
    const results = applied.output.compiled.operationResults;
    expect(results).toMatchObject([
      {
        surgeryId: "replace-first",
        attribution: "user-surgery",
        sharedProviderPath: true,
        reason: "user-surgery-composed-before-bootstrap-same-path",
      },
      {
        surgeryId: "compiler-bootstrap",
        attribution: "bootstrap-prefix",
        sharedProviderPath: true,
        reason: "bootstrap-applied-after-user-surgery-same-path",
      },
    ]);
    expect(JSON.parse(applied.output.exactBody.inspectCopy().toString("utf8")).input[0].content[0].text)
      .toBe(`${bootstrap}\n\nsummary`);

    const repeated = compile({ value: body([user("sensitive")]), tracker, store });
    expect(repeated.output.exactBody.inspectCopy().equals(applied.output.exactBody.inspectCopy()))
      .toBe(true);
    const restartedStore = AtomicStateSnapshotStore.inSessionDirectory(path, sessionId);
    const restartedTracker = new PristineHistoryTracker(
      sessionId,
      restartedStore.current(sessionId).bootstrapBranches
    );
    const restarted = compile({
      value: body([user("sensitive")]),
      tracker: restartedTracker,
      store: restartedStore,
    });
    expect(restarted.output.exactBody.inspectCopy().equals(applied.output.exactBody.inspectCopy()))
      .toBe(true);
  });

  it("bounds persisted bootstrap observations and compiler receipts", () => {
    const path = directory();
    const sessionId = hash("bounded-bootstrap-session");
    const store = AtomicStateSnapshotStore.inSessionDirectory(path, sessionId);
    const tracker = new PristineHistoryTracker(sessionId);
    for (let index = 1; index <= 70; index += 1) {
      compile({
        value: body([user("root")]),
        tracker,
        store,
        history: Array.from({ length: index }, (_, item) => hash(`bounded-${item}`)),
      });
    }
    const snapshot = store.current(sessionId);
    expect(snapshot.bootstrapBranches[0].observations.length).toBeLessThanOrEqual(8);
    expect(Object.values(snapshot.receiptsByOperationId).filter((receipt) => receipt.bootstrapTransition).length)
      .toBeLessThanOrEqual(64);
  });
});

describe("v3 bootstrap schema migration", () => {
  it("atomically upgrades v3 state to v4 without inventing bootstrap history", () => {
    const path = directory();
    const sessionId = hash("migration-session");
    const source = hash("legacy source");
    const receipt = {
      receiptId: randomUUID(),
      operationId: randomUUID(),
      sessionId,
      branchId: "legacy-branch",
      previousRevision: 0,
      committedRevision: 1,
      surgeryIds: ["legacy-surgery"],
      operationResults: [{
        surgeryId: "legacy-surgery",
        occurrenceId: "legacy-occurrence",
        expectedSourceHash: source,
        outcome: "committed",
      }],
      committedAt: "2026-07-11T00:00:00.000Z",
    };
    writeFileSync(
      join(path, "state.json"),
      `${JSON.stringify({
        version: 3,
        sessionId,
        revision: 1,
        surgeries: [{
          surgeryId: "legacy-surgery",
          state: "committed",
          branchId: "legacy-branch",
          occurrenceId: "legacy-occurrence",
          expectedSourceHash: source,
          action: { kind: "evict" },
          createdAt: "2026-07-11T00:00:00.000Z",
        }],
        receiptsByOperationId: { [receipt.operationId]: receipt },
      })}\n`,
      { mode: 0o600 }
    );
    const store = AtomicStateSnapshotStore.inSessionDirectory(path, sessionId);
    expect(store.current(sessionId)).toMatchObject({
      version: 4,
      revision: 1,
      surgeries: [{ surgeryId: "legacy-surgery" }],
      bootstrapBranches: [],
    });
    expect(JSON.parse(readFileSync(join(path, "state.json"), "utf8"))).toMatchObject({
      version: 4,
      bootstrapBranches: [],
    });
  });
});
