import { randomUUID } from "node:crypto";
import type { ProviderProjection } from "../contracts/provider.js";
import type {
  BootstrapAnchor,
  BootstrapBranchState,
  BootstrapDecision,
  ResolvedIdentity,
  StateReceipt,
  StateSnapshot,
  StateTransactionStore,
} from "../contracts/state.js";
import { getAtPath, sha256Value } from "../providers/shared.js";

const EMPTY_HASH = "0".repeat(64);

function anchorFor(
  occurrence: ProviderProjection["occurrences"][number]
): BootstrapAnchor {
  return Object.freeze({
    occurrenceId: occurrence.occurrenceId,
    providerPath: Object.freeze([...occurrence.providerPath]),
    sourceHash: occurrence.sourceHash,
  });
}

function samePath(
  left: readonly (string | number)[],
  right: readonly (string | number)[]
): boolean {
  return left.length === right.length && left.every((part, index) => part === right[index]);
}

function findAnchorOccurrence(
  projection: ProviderProjection,
  anchor: BootstrapAnchor,
  receivedValue: Readonly<Record<string, unknown>>,
  skillBootstrap: string
) {
  const exact = projection.occurrences.find(
    (occurrence) =>
      occurrence.occurrenceId === anchor.occurrenceId &&
      occurrence.sourceHash === anchor.sourceHash &&
      samePath(occurrence.providerPath, anchor.providerPath)
  );
  if (exact) return exact;
  const prefix = `${skillBootstrap}\n\n`;
  return projection.occurrences.find((occurrence) => {
    if (!samePath(occurrence.providerPath, anchor.providerPath)) return false;
    const value = getAtPath(receivedValue, occurrence.providerPath);
    return (
      typeof value === "string" &&
      value.startsWith(prefix) &&
      sha256Value(value.slice(prefix.length)) === anchor.sourceHash
    );
  });
}

function findInheritedAnchorOccurrence(
  projection: ProviderProjection,
  anchor: BootstrapAnchor
) {
  return projection.occurrences.find(
    (occurrence) =>
      occurrence.sourceHash === anchor.sourceHash &&
      samePath(occurrence.providerPath, anchor.providerPath)
  );
}

function firstUser(projection: ProviderProjection) {
  return projection.occurrences.find(
    (occurrence) => occurrence.kind === "user-text" && occurrence.mutable
  );
}

function initialDecision(
  receivedValue: Readonly<Record<string, unknown>>,
  signature: string,
  anchor: BootstrapAnchor
): BootstrapDecision {
  const value = getAtPath(receivedValue, anchor.providerPath);
  return signature && typeof value === "string" && value.includes(signature)
    ? "preserve"
    : "inject";
}

function branchState(input: {
  identity: ResolvedIdentity;
  history: readonly string[];
  observations?: readonly (readonly string[])[];
  decision: BootstrapDecision;
  status: BootstrapBranchState["status"];
  anchor?: BootstrapAnchor;
  reanchorCount?: 0 | 1;
  inheritedFromBranchId?: string;
}): BootstrapBranchState {
  return Object.freeze({
    conversationId: input.identity.conversationId,
    branchId: input.identity.branchId,
    ...(input.identity.parentBranchId
      ? { parentBranchId: input.identity.parentBranchId }
      : {}),
    ...(input.identity.forkPoint !== undefined
      ? { forkPoint: input.identity.forkPoint }
      : {}),
    history: Object.freeze([...input.history]),
    observations: Object.freeze(
      (input.observations ?? [input.history]).map((entry) => Object.freeze([...entry]))
    ),
    decision: input.decision,
    status: input.status,
    ...(input.anchor ? { anchor: input.anchor } : {}),
    reanchorCount: input.reanchorCount ?? 0,
    ...(input.inheritedFromBranchId
      ? { inheritedFromBranchId: input.inheritedFromBranchId }
      : {}),
  });
}

function appendObservation(
  branch: BootstrapBranchState,
  history: readonly string[]
): readonly (readonly string[])[] {
  const last = branch.observations.at(-1);
  if (
    last &&
    last.length === history.length &&
    last.every((part, index) => part === history[index])
  ) {
    return branch.observations;
  }
  return Object.freeze([
    ...branch.observations,
    Object.freeze([...history]),
  ]);
}

function replaceBranch(
  snapshot: StateSnapshot,
  branch: BootstrapBranchState
): readonly BootstrapBranchState[] {
  const existing = snapshot.bootstrapBranches.findIndex(
    (candidate) => candidate.branchId === branch.branchId
  );
  if (existing < 0) return Object.freeze([...snapshot.bootstrapBranches, branch]);
  const next = [...snapshot.bootstrapBranches];
  next[existing] = branch;
  return Object.freeze(next);
}

export type BootstrapStateReconciliation = Readonly<{
  state: StateSnapshot;
  branch: BootstrapBranchState;
  explanationCodes: readonly string[];
}>;

/**
 * Commits the causal bootstrap decision before compilation. The only signature
 * check is against the selected first-user anchor on its exact provider path.
 */
export function reconcileBootstrapState(input: {
  store: StateTransactionStore;
  identity: ResolvedIdentity;
  projection: ProviderProjection;
  receivedValue: Readonly<Record<string, unknown>>;
  pristineItemHashes: readonly string[];
  skillSignature: string;
  skillBootstrap: string;
  now?: Date;
}): BootstrapStateReconciliation {
  const current = input.store.current(input.identity.sessionId);
  const existing = current.bootstrapBranches.find(
    (branch) => branch.branchId === input.identity.branchId
  );
  const first = firstUser(input.projection);
  const codes: string[] = [];
  let nextBranch: BootstrapBranchState;

  if (!existing) {
    const parent = input.identity.parentBranchId
      ? current.bootstrapBranches.find(
          (branch) => branch.branchId === input.identity.parentBranchId
        )
      : undefined;
    if (parent) {
      codes.push("bootstrap-branch-inherited");
      let decision = parent.decision;
      let status: BootstrapBranchState["status"] = parent.status;
      let anchor: BootstrapAnchor | undefined;
      let reanchorCount = parent.reanchorCount;
      if (parent.anchor) {
        const inherited = findInheritedAnchorOccurrence(input.projection, parent.anchor);
        if (inherited) {
          anchor = anchorFor(inherited);
          codes.push("bootstrap-inherited-anchor-stable");
        } else if (reanchorCount === 0 && first) {
          anchor = anchorFor(first);
          reanchorCount = 1;
          status = "anchored";
          codes.push("bootstrap-anchor-reanchored-after-history-trim");
        } else {
          status = "stopped";
          codes.push("bootstrap-anchor-loss-stopped-visible");
        }
      } else if (status === "awaiting-anchor" && first) {
        anchor = anchorFor(first);
        decision = initialDecision(input.receivedValue, input.skillSignature, anchor);
        status = "anchored";
        codes.push(
          decision === "inject"
            ? "bootstrap-anchor-created-inject"
            : "bootstrap-anchor-created-preserve-existing"
        );
      }
      nextBranch = branchState({
        identity: input.identity,
        history: input.pristineItemHashes,
        decision,
        status,
        ...(anchor ? { anchor } : {}),
        reanchorCount,
        inheritedFromBranchId: parent.branchId,
      });
    } else if (first) {
      const anchor = anchorFor(first);
      const decision = initialDecision(input.receivedValue, input.skillSignature, anchor);
      codes.push("bootstrap-branch-created");
      codes.push(
        decision === "inject"
          ? "bootstrap-anchor-created-inject"
          : "bootstrap-anchor-created-preserve-existing"
      );
      nextBranch = branchState({
        identity: input.identity,
        history: input.pristineItemHashes,
        decision,
        status: "anchored",
        anchor,
      });
    } else {
      codes.push("bootstrap-branch-created", "bootstrap-awaiting-first-user-anchor");
      nextBranch = branchState({
        identity: input.identity,
        history: input.pristineItemHashes,
        decision: "pending",
        status: "awaiting-anchor",
      });
    }
  } else {
    const observations = appendObservation(existing, input.pristineItemHashes);
    nextBranch = branchState({
      identity: input.identity,
      history: input.pristineItemHashes,
      observations,
      decision: existing.decision,
      status: existing.status,
      ...(existing.anchor ? { anchor: existing.anchor } : {}),
      reanchorCount: existing.reanchorCount,
      ...(existing.inheritedFromBranchId
        ? { inheritedFromBranchId: existing.inheritedFromBranchId }
        : {}),
    });

    if (input.identity.historyTransition === "extended") {
      codes.push("bootstrap-branch-history-extended");
    } else if (input.identity.historyTransition === "trimmed") {
      codes.push("bootstrap-branch-history-trimmed");
    }

    if (existing.status === "awaiting-anchor" && first) {
      const anchor = anchorFor(first);
      const decision = initialDecision(input.receivedValue, input.skillSignature, anchor);
      nextBranch = Object.freeze({
        ...nextBranch,
        decision,
        status: "anchored" as const,
        anchor,
      });
      codes.push(
        decision === "inject"
          ? "bootstrap-anchor-created-inject"
          : "bootstrap-anchor-created-preserve-existing"
      );
    } else if (existing.status === "anchored" && existing.anchor) {
      const anchored = findAnchorOccurrence(
        input.projection,
        existing.anchor,
        input.receivedValue,
        input.skillBootstrap
      );
      if (!anchored) {
        if (existing.reanchorCount === 0 && first) {
          const anchor = anchorFor(first);
          nextBranch = Object.freeze({
            ...nextBranch,
            anchor,
            reanchorCount: 1 as const,
          });
          codes.push("bootstrap-anchor-reanchored-after-history-trim");
        } else {
          nextBranch = Object.freeze({
            ...nextBranch,
            status: "stopped" as const,
            anchor: undefined,
          });
          codes.push("bootstrap-anchor-loss-stopped-visible");
        }
      }
    }
  }

  const changed = JSON.stringify(existing) !== JSON.stringify(nextBranch);
  if (!changed) {
    return Object.freeze({
      state: current,
      branch: existing!,
      explanationCodes: Object.freeze(["bootstrap-anchor-stable"]),
    });
  }

  if (codes.length === 0) codes.push("bootstrap-branch-state-updated");
  const operationId = randomUUID();
  const transitionId = randomUUID();
  const committedAt = (input.now ?? new Date()).toISOString();
  const transition = Object.freeze({
    transitionId,
    branchId: input.identity.branchId,
    explanationCodes: Object.freeze([...codes]),
    ...(existing ? { previousDecision: existing.decision } : {}),
    decision: nextBranch.decision,
    ...(existing?.anchor ? { previousAnchor: existing.anchor } : {}),
    ...(nextBranch.anchor ? { anchor: nextBranch.anchor } : {}),
  });
  const receipt: StateReceipt = Object.freeze({
    receiptId: randomUUID(),
    operationId,
    sessionId: current.sessionId,
    branchId: input.identity.branchId,
    previousRevision: current.revision,
    committedRevision: current.revision + 1,
    surgeryIds: Object.freeze([]),
    operationResults: Object.freeze([
      Object.freeze({
        surgeryId: "compiler-bootstrap",
        occurrenceId: nextBranch.anchor?.occurrenceId ?? "bootstrap-anchor-unavailable",
        expectedSourceHash: nextBranch.anchor?.sourceHash ?? EMPTY_HASH,
        outcome: "committed" as const,
        reason: codes.join(","),
        attribution: "bootstrap-prefix" as const,
      }),
    ]),
    explanationCodes: Object.freeze([...codes]),
    bootstrapTransition: transition,
    committedAt,
  });
  const next: StateSnapshot = Object.freeze({
    version: 4,
    sessionId: current.sessionId,
    revision: current.revision + 1,
    surgeries: current.surgeries,
    bootstrapBranches: replaceBranch(current, nextBranch),
    receiptsByOperationId: Object.freeze({
      ...current.receiptsByOperationId,
      [operationId]: receipt,
    }),
  });
  input.store.commit({
    expectedRevision: current.revision,
    operationId,
    next,
    receipt,
  });
  return Object.freeze({
    state: next,
    branch: nextBranch,
    explanationCodes: Object.freeze([...codes]),
  });
}
