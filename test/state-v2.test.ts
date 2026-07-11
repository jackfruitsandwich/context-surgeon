import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import type { MutationCommand, Occurrence } from "../src/contracts/index.js";
import {
  AmbiguousAliasError,
  PristineHistoryTracker,
  createOccurrence,
  occurrenceIdentity,
  resolveOccurrenceAliases,
  resolveSessionAuthority,
  sourceHash,
} from "../src/state/identity.js";
import { ExplicitConversationCatalog } from "../src/proxy/conversations.js";
import { StateControlService } from "../src/api/state-control.js";
import {
  AtomicStateSnapshotStore,
  RecoveryRequiredError,
  type PersistenceStep,
} from "../src/store/state-snapshot-store.js";
import { DirectiveStore } from "../src/store/directive-store.js";

const temporary: string[] = [];
afterEach(() => {
  for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true });
});

function temp(): string {
  const path = mkdtempSync(join(tmpdir(), "cs-v2-state-"));
  temporary.push(path);
  return path;
}

function hash(label: string): string {
  return sourceHash(label);
}

function occurrence(input: {
  sessionId: string;
  branchId: string;
  revision?: number;
  label?: string;
  text?: string;
  path?: readonly (string | number)[];
  kind?: Occurrence["kind"];
  mutable?: boolean;
  protectedReason?: string;
}): Occurrence {
  return createOccurrence({
    sessionId: input.sessionId,
    branchId: input.branchId,
    revision: input.revision ?? 0,
    kind: input.kind ?? "user-text",
    sourceHash: hash(input.text ?? "hello"),
    displayLabel: input.label ?? "user message 1",
    structuralRelation: "item-content",
    providerPath: input.path ?? ["input", 0, "content", 0, "text"],
    mutable: input.mutable ?? true,
    protectedReason: input.protectedReason,
  });
}

function fixture(options?: { occurrences?: Occurrence[]; directory?: string }) {
  const sessionId = options?.occurrences?.[0]?.sessionId ?? hash(`session-${randomUUID()}`);
  const conversationId = randomUUID();
  const branchId = options?.occurrences?.[0]?.branchId ?? randomUUID();
  const occurrences = options?.occurrences ?? [occurrence({ sessionId, branchId })];
  const catalog = new ExplicitConversationCatalog();
  catalog.publish({
    identity: { sessionId, conversationId, branchId, revision: 0, confidence: "unique-extension" },
    pristineItemHashes: [hash("history")],
    occurrences,
    observedAt: new Date().toISOString(),
  });
  const directory = options?.directory ?? temp();
  const store = AtomicStateSnapshotStore.inSessionDirectory(directory, sessionId);
  const service = new StateControlService(sessionId, store, catalog);
  return { sessionId, conversationId, branchId, occurrences, catalog, directory, store, service };
}

function command(
  value: ReturnType<typeof fixture>,
  overrides: Partial<MutationCommand> = {}
): MutationCommand {
  return {
    operationId: randomUUID(),
    sessionId: value.sessionId,
    conversationId: value.conversationId,
    branchId: value.branchId,
    expectedRevision: value.store.current(value.sessionId).revision,
    occurrenceIds: [value.occurrences[0].occurrenceId],
    requireComplete: true,
    action: { kind: "evict" },
    ...overrides,
  };
}

describe("v2 identity", () => {
  it("never shares authority or occurrence ids across identical independent sessions", () => {
    const a = resolveSessionAuthority({ launchId: "launch-a" });
    const b = resolveSessionAuthority({ launchId: "launch-b" });
    expect(a.sessionId).not.toBe(b.sessionId);
    const branch = randomUUID();
    expect(occurrence({ sessionId: a.sessionId, branchId: branch }).occurrenceId)
      .not.toBe(occurrence({ sessionId: b.sessionId, branchId: branch }).occurrenceId);
  });

  it("prioritizes proven native authority, then explicit binding, never transcript content", () => {
    expect(resolveSessionAuthority({ provenNativeSessionId: "native", explicitSessionId: "explicit" }).source)
      .toBe("native");
    expect(resolveSessionAuthority({ explicitSessionId: "explicit" }).source).toBe("explicit");
    expect(resolveSessionAuthority({ launchId: "same" }).sessionId)
      .toBe(resolveSessionAuthority({ launchId: "same" }).sessionId);
  });

  it("uses full length-delimited SHA-256 occurrence identities", () => {
    const base = {
      sessionId: hash("session"), branchId: randomUUID(), kind: "user-text" as const,
      sourceHash: hash("source"), structuralRelation: "content",
    };
    const one = occurrenceIdentity({ ...base, providerPath: ["ab", "c"] });
    const two = occurrenceIdentity({ ...base, providerPath: ["a", "bc"] });
    expect(one).toMatch(/^[a-f0-9]{64}$/);
    expect(one).not.toBe(two);
  });

  it("forks only from a unique observed ancestor and rejects earlier/non-unique histories", () => {
    const tracker = new PristineHistoryTracker(hash("session"));
    const a = tracker.observe([hash("a")]);
    const main = tracker.observe([hash("a"), hash("b")]);
    const fork = tracker.observe([hash("a"), hash("c")]);
    expect(fork.identity.conversationId).toBe(a.identity.conversationId);
    expect(fork.identity.branchId).not.toBe(main.identity.branchId);
    expect(tracker.observe([hash("a")]).identity.confidence).toBe("ambiguous");
    expect(tracker.observe([hash("a"), hash("d")]).identity.confidence).toBe("ambiguous");
  });

  it("rejects duplicate ordinal aliases, including reused tool call ids", () => {
    const sessionId = hash("session");
    const branchId = randomUUID();
    const occurrences = [
      occurrence({ sessionId, branchId, label: "tool result 1.1", text: "first", path: ["messages", 1] }),
      occurrence({ sessionId, branchId, label: "tool result 1.1", text: "second", path: ["messages", 3] }),
    ];
    expect(() => resolveOccurrenceAliases(occurrences, ["tool result 1.1"]))
      .toThrow(AmbiguousAliasError);
    expect(resolveOccurrenceAliases(occurrences, [occurrences[1].occurrenceId]))
      .toEqual([occurrences[1].occurrenceId]);
  });

  it("keeps repeated messages, tools-before-users, and reordered duplicate-id results unique by occurrence", () => {
    const sessionId = hash("session");
    const branchId = randomUUID();
    const call = occurrence({ sessionId, branchId, label: "tool call 1.1", text: "same", path: ["input", 0], kind: "tool-call", mutable: false });
    const resultBeforeUser = createOccurrence({
      sessionId, branchId, revision: 0, predecessorOccurrenceId: call.occurrenceId,
      kind: "tool-result-text", sourceHash: hash("same"), displayLabel: "tool result 1.1",
      structuralRelation: "duplicate-call-id", providerPath: ["input", 1], mutable: true,
    });
    const reorderedResult = createOccurrence({
      sessionId, branchId, revision: 0, predecessorOccurrenceId: resultBeforeUser.occurrenceId,
      kind: "tool-result-text", sourceHash: hash("same"), displayLabel: "tool result 1.1",
      structuralRelation: "duplicate-call-id", providerPath: ["input", 3], mutable: true,
    });
    expect(new Set([call.occurrenceId, resultBeforeUser.occurrenceId, reorderedResult.occurrenceId]).size).toBe(3);
  });
});

describe("v3 transactional state", () => {
  it("never loads or mutates persisted global v1 fingerprint authority", () => {
    const directory = temp();
    const path = join(directory, "directives.json");
    const legacy = JSON.stringify({ version: 2, entries: { abc: {
      directive: { type: "evict" }, humanId: "user message 1", preview: "secret",
      tokenEstimate: null, createdAt: 1, lastMatchedAt: null,
    } } });
    writeFileSync(path, legacy, { mode: 0o600 });
    const store = new DirectiveStore(path);
    expect(store.size()).toBe(0);
    expect(() => store.set("abc", {
      directive: { type: "evict" }, humanId: "user message 1", preview: "",
      tokenEstimate: null, createdAt: 1, lastMatchedAt: null,
    })).toThrow(/v1 directives are disabled/);
    expect(readFileSync(path, "utf8")).toBe(legacy);
  });

  it("rolls back an entire generated batch when any exact target is invalid", () => {
    const value = fixture();
    const response = value.service.mutate(command(value, {
      occurrenceIds: [value.occurrences[0].occurrenceId, hash("missing")],
    }));
    expect(response).toMatchObject({ ok: false, code: "unsupported-target" });
    expect(value.store.current(value.sessionId)).toMatchObject({ revision: 0, surgeries: [] });
  });

  it("rejects protected residue under requireComplete without committing", () => {
    const base = fixture();
    const protectedItem = occurrence({
      sessionId: base.sessionId,
      branchId: base.branchId,
      label: "tool call 1.1",
      text: "arguments",
      path: ["input", 0, "content", 0, "arguments"],
      kind: "tool-call",
      mutable: false,
      protectedReason: "tool arguments are structural",
    });
    base.catalog.publish({
      identity: { sessionId: base.sessionId, conversationId: base.conversationId, branchId: base.branchId, revision: 0, confidence: "unique-extension" },
      pristineItemHashes: [hash("history")],
      occurrences: [...base.occurrences, protectedItem],
      observedAt: new Date().toISOString(),
    });
    expect(base.service.mutate(command(base))).toMatchObject({ ok: false, code: "unsupported-target" });
    expect(base.store.current(base.sessionId).revision).toBe(0);
  });

  it("commits once, publishes once, and returns the original receipt on retry and restart", () => {
    const value = fixture();
    const operation = command(value);
    const first = value.service.mutate(operation);
    expect(first).toMatchObject({ ok: true, receipt: { committedRevision: 1 } });
    expect(value.service.mutate(operation)).toEqual(first);
    expect(value.store.current(value.sessionId).revision).toBe(1);

    const restartedStore = AtomicStateSnapshotStore.inSessionDirectory(value.directory, value.sessionId);
    const restartedService = new StateControlService(value.sessionId, restartedStore, value.catalog);
    expect(restartedService.mutate(operation)).toEqual(first);
    expect(restartedStore.current(value.sessionId).surgeries).toHaveLength(1);
  });

  it("persists only hashes and replacement text, never previews or source bodies", () => {
    const value = fixture();
    const response = value.service.mutate(command(value, { action: { kind: "replace", content: "safe summary" } }));
    expect(response.ok).toBe(true);
    const raw = readFileSync(join(value.directory, "state.json"), "utf8");
    expect(raw).toContain("safe summary");
    expect(raw).toContain(value.occurrences[0].sourceHash);
    expect(raw).not.toContain("preview");
    expect(raw).not.toContain("hello");
  });

  for (const step of [
    "after-temp-open",
    "after-temp-write",
    "after-file-fsync",
    "after-rename",
    "after-directory-fsync",
    "before-memory-publication",
  ] as PersistenceStep[]) {
    it(`recovers a whole old or new revision after failpoint ${step}`, () => {
      const directory = temp();
      const seed = fixture({ directory });
      const failing = new AtomicStateSnapshotStore(seed.sessionId, join(directory, "state.json"), (at) => {
        if (at === step) throw new Error(`crash at ${step}`);
      });
      const service = new StateControlService(seed.sessionId, failing, seed.catalog);
      expect(service.mutate(command({ ...seed, store: failing, service }))).toMatchObject({ ok: false });
      const restarted = new AtomicStateSnapshotStore(seed.sessionId, join(directory, "state.json"));
      expect([0, 1]).toContain(restarted.current(seed.sessionId).revision);
      expect(restarted.current(seed.sessionId).surgeries.length)
        .toBe(restarted.current(seed.sessionId).revision === 0 ? 0 : 1);
    });
  }

  it("quarantines corrupt state and never empty-heals", () => {
    const directory = temp();
    const sessionId = hash("session");
    writeFileSync(join(directory, "state.json"), "{truncated", { mode: 0o600 });
    const store = new AtomicStateSnapshotStore(sessionId, join(directory, "state.json"));
    expect(() => store.current(sessionId)).toThrow(RecoveryRequiredError);
    expect(readdirSync(directory).some((name) => name.includes(".quarantine."))).toBe(true);
    expect(store.inspection().recoveryRequired).toBe(true);
    const restarted = new AtomicStateSnapshotStore(sessionId, join(directory, "state.json"));
    expect(() => restarted.current(sessionId)).toThrow(RecoveryRequiredError);
  });

  it("quarantines a valid-JSON wrong-version snapshot", () => {
    const directory = temp();
    const sessionId = hash("session");
    writeFileSync(join(directory, "state.json"), JSON.stringify({ version: 2, entries: {} }), { mode: 0o600 });
    const store = new AtomicStateSnapshotStore(sessionId, join(directory, "state.json"));
    expect(() => store.current(sessionId)).toThrow(/unsupported or missing version/);
  });

  it("keeps surgery branch-local", () => {
    const value = fixture();
    expect(value.service.mutate(command(value)).ok).toBe(true);
    const otherBranch = randomUUID();
    value.catalog.publish({
      identity: { sessionId: value.sessionId, conversationId: value.conversationId, branchId: otherBranch, revision: 0, confidence: "unique-extension" },
      pristineItemHashes: [hash("history"), hash("fork")],
      occurrences: [occurrence({ sessionId: value.sessionId, branchId: otherBranch })],
      observedAt: new Date().toISOString(),
    });
    expect(value.service.activeSurgeries({ sessionId: value.sessionId, conversationId: value.conversationId, branchId: otherBranch })).toEqual([]);
    expect(() => value.service.activeSurgeries({ sessionId: value.sessionId, conversationId: value.conversationId, branchId: randomUUID() }))
      .toThrow(/exact session\/conversation\/branch/);
  });

  it("records reversal source-present, source-absent, and stale as non-destructive events", () => {
    for (const sourceState of ["source-present", "source-absent", "stale"] as const) {
      const value = fixture();
      const committed = value.service.mutate(command(value));
      if (!committed.ok) throw new Error(committed.error);
      let reversalIds: string[] = [];
      if (sourceState === "source-present") reversalIds = [value.occurrences[0].occurrenceId];
      if (sourceState === "source-absent") {
        value.catalog.publish({
          identity: { sessionId: value.sessionId, conversationId: value.conversationId, branchId: value.branchId, revision: 0, confidence: "unique-extension" },
          pristineItemHashes: [hash("history without source")], occurrences: [], observedAt: new Date().toISOString(),
        });
      }
      if (sourceState === "stale") {
        const changed = occurrence({ sessionId: value.sessionId, branchId: value.branchId, text: "changed" });
        value.catalog.publish({
          identity: { sessionId: value.sessionId, conversationId: value.conversationId, branchId: value.branchId, revision: 0, confidence: "unique-extension" },
          pristineItemHashes: [hash("changed history")], occurrences: [changed], observedAt: new Date().toISOString(),
        });
        reversalIds = [changed.occurrenceId];
      }
      const reversed = value.service.mutate(command(value, {
        expectedRevision: 1,
        occurrenceIds: reversalIds,
        action: { kind: "reverse", surgeryIds: committed.receipt.surgeryIds },
      }));
      expect(reversed).toMatchObject({ ok: true, receipt: { operationResults: [{ reason: sourceState }] } });
      expect(value.store.current(value.sessionId).surgeries).toHaveLength(1);
      expect(value.store.current(value.sessionId).surgeries[0]).toMatchObject({ state: "reversed" });
    }
  });
});
