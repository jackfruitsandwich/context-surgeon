import { randomUUID } from "node:crypto";
import type {
  MutationCommand,
  MutationResponse,
  StateReceipt,
  StateSnapshot,
  StateTransactionStore,
  SurgeryAction,
  SurgeryRecord,
  TruthStatus,
} from "../contracts/index.js";
import type { OperationResult } from "../contracts/truth.js";
import {
  AmbiguousConversationError,
  ExplicitConversationCatalog,
  type BranchSelection,
  type ExplicitBranchSnapshot,
} from "../proxy/conversations.js";
import { RecoveryRequiredError, StaleRevisionError } from "../store/state-snapshot-store.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type ReversalSourceState = "source-present" | "source-absent" | "stale";

export type ControlSkeleton = Readonly<{
  selection: BranchSelection;
  revision: number;
  confidence: ExplicitBranchSnapshot["identity"]["confidence"];
  occurrences: readonly Readonly<{
    occurrenceId: string;
    alias: string;
    kind: string;
    sourceHash: string;
    mutable: boolean;
    protectedReason?: string;
    activeSurgeryIds: readonly string[];
  }>[];
}>;

export type StateControlStatus = Readonly<{
  selection: BranchSelection;
  revision: number;
  surgeries: readonly SurgeryRecord[];
  receipts: number;
  truth?: TruthStatus;
}>;

class UnsupportedTargetError extends Error {
  readonly code = "unsupported-target" as const;
}

function selectionOf(command: MutationCommand): BranchSelection {
  return {
    sessionId: command.sessionId,
    conversationId: command.conversationId,
    branchId: command.branchId,
  };
}

function freezeSnapshot(snapshot: StateSnapshot): StateSnapshot {
  return Object.freeze({
    ...snapshot,
    surgeries: Object.freeze([...snapshot.surgeries]),
    receiptsByOperationId: Object.freeze({ ...snapshot.receiptsByOperationId }),
  });
}

function actionFor(kind: string, action: MutationCommand["action"]): SurgeryAction {
  if (action.kind === "replace") return Object.freeze({ kind: "replace", content: action.content });
  if (kind === "image" || kind === "document") {
    return Object.freeze({ kind: "evict-media", mediaType: kind });
  }
  return Object.freeze({ kind: "evict" });
}

function responseError(error: unknown): MutationResponse {
  if (error instanceof AmbiguousConversationError) {
    return { ok: false, code: "ambiguous-identity", error: error.message };
  }
  if (error instanceof StaleRevisionError) {
    return { ok: false, code: "stale-revision", error: error.message };
  }
  if (error instanceof RecoveryRequiredError) {
    return { ok: false, code: "recovery-required", error: error.message };
  }
  if (error instanceof UnsupportedTargetError) {
    return { ok: false, code: "unsupported-target", error: error.message };
  }
  return {
    ok: false,
    code: "persistence-failed",
    error: error instanceof Error ? error.message : String(error),
  };
}

/** Atomic command semantics over the exact branch selected by every caller. */
export class StateControlService {
  constructor(
    readonly sessionId: string,
    private readonly store: StateTransactionStore,
    private readonly catalog: ExplicitConversationCatalog,
    private readonly now: () => Date = () => new Date(),
    private readonly truthStatus?: () => TruthStatus
  ) {}

  selections(): readonly BranchSelection[] {
    return Object.freeze(this.catalog.list(this.sessionId).map((snapshot) => Object.freeze({
      sessionId: snapshot.identity.sessionId,
      conversationId: snapshot.identity.conversationId,
      branchId: snapshot.identity.branchId,
    })));
  }

  skeleton(selection: BranchSelection): ControlSkeleton {
    const branch = this.exactBranch(selection);
    const state = this.store.current(this.sessionId);
    return Object.freeze({
      selection: Object.freeze({ ...selection }),
      revision: state.revision,
      confidence: branch.identity.confidence,
      occurrences: Object.freeze(branch.occurrences.map((occurrence) => Object.freeze({
        occurrenceId: occurrence.occurrenceId,
        alias: occurrence.displayLabel,
        kind: occurrence.kind,
        sourceHash: occurrence.sourceHash,
        mutable: occurrence.mutable,
        ...(occurrence.protectedReason ? { protectedReason: occurrence.protectedReason } : {}),
        activeSurgeryIds: Object.freeze(state.surgeries
          .filter((surgery) =>
            surgery.state === "committed" &&
            surgery.branchId === selection.branchId &&
            surgery.occurrenceId === occurrence.occurrenceId
          )
          .map((surgery) => surgery.surgeryId)),
      }))),
    });
  }

  status(selection: BranchSelection): StateControlStatus {
    this.exactBranch(selection);
    const state = this.store.current(this.sessionId);
    return Object.freeze({
      selection: Object.freeze({ ...selection }),
      revision: state.revision,
      surgeries: Object.freeze(state.surgeries.filter((surgery) => surgery.branchId === selection.branchId)),
      receipts: Object.keys(state.receiptsByOperationId).length,
      ...(this.truthStatus ? { truth: this.truthStatus() } : {}),
    });
  }

  activeSurgeries(selection: BranchSelection): readonly SurgeryRecord[] {
    this.exactBranch(selection);
    return this.store.current(this.sessionId).surgeries.filter(
      (surgery) => surgery.branchId === selection.branchId && surgery.state === "committed"
    );
  }

  mutate(command: MutationCommand): MutationResponse {
    try {
      return { ok: true, receipt: this.commit(command) };
    } catch (error) {
      return responseError(error);
    }
  }

  private commit(command: MutationCommand): StateReceipt {
    if (!UUID_RE.test(command.operationId)) {
      throw new UnsupportedTargetError("operationId must be a UUID");
    }
    if (command.sessionId !== this.sessionId) {
      throw new AmbiguousConversationError("Command session does not match the owning session");
    }
    const current = this.store.current(this.sessionId);
    const retried = current.receiptsByOperationId[command.operationId];
    if (retried) return retried;
    if (current.revision !== command.expectedRevision) {
      throw new StaleRevisionError(command.expectedRevision, current.revision);
    }
    const branch = this.exactBranch(selectionOf(command));
    if (new Set(command.occurrenceIds).size !== command.occurrenceIds.length) {
      throw new UnsupportedTargetError("A batch may not repeat an occurrence identity");
    }
    if (command.action.kind === "reverse") {
      return this.reverse(command, branch, current);
    }
    return this.surgery(command, branch, current);
  }

  private surgery(
    command: MutationCommand,
    branch: ExplicitBranchSnapshot,
    current: StateSnapshot
  ): StateReceipt {
    if (command.occurrenceIds.length === 0) {
      throw new UnsupportedTargetError("A mutation batch must contain at least one occurrence");
    }
    const byId = new Map(branch.occurrences.map((occurrence) => [occurrence.occurrenceId, occurrence]));
    const targets = command.occurrenceIds.map((id) => {
      const occurrence = byId.get(id);
      if (!occurrence) throw new UnsupportedTargetError(`Unknown exact occurrence ${id}`);
      if (!occurrence.mutable) {
        throw new UnsupportedTargetError(
          `${occurrence.displayLabel} is protected: ${occurrence.protectedReason ?? "not mutable"}`
        );
      }
      if (
        command.action.kind === "replace" &&
        !["user-text", "assistant-text", "tool-result-text"].includes(occurrence.kind)
      ) {
        throw new UnsupportedTargetError(`Replacement is unsupported for ${occurrence.kind}`);
      }
      return occurrence;
    });

    if (command.requireComplete) {
      const selectedPaths = new Set(targets.map((target) => JSON.stringify(target.providerPath.slice(0, -1))));
      const residue = branch.occurrences.filter(
        (occurrence) =>
          !occurrence.mutable &&
          selectedPaths.has(JSON.stringify(occurrence.providerPath.slice(0, -1)))
      );
      if (residue.length > 0) {
        throw new UnsupportedTargetError(
          `requireComplete rejected protected residue: ${residue.map((item) => item.displayLabel).join(", ")}`
        );
      }
    }

    const committedAt = this.now().toISOString();
    const records: SurgeryRecord[] = [];
    const results: OperationResult[] = [];
    for (const target of targets) {
      const surgeryId = randomUUID();
      const action = actionFor(target.kind, command.action);
      records.push(Object.freeze({
        surgeryId,
        state: "committed" as const,
        branchId: command.branchId,
        occurrenceId: target.occurrenceId,
        expectedSourceHash: target.sourceHash,
        action,
        createdAt: committedAt,
      }));
      results.push(Object.freeze({
        surgeryId,
        occurrenceId: target.occurrenceId,
        expectedSourceHash: target.sourceHash,
        outcome: "committed" as const,
        reason: "intended-surgery-committed",
      }));
    }
    return this.persist(command, current, [...current.surgeries, ...records], results, records.map((r) => r.surgeryId), committedAt);
  }

  private reverse(
    command: MutationCommand,
    branch: ExplicitBranchSnapshot,
    current: StateSnapshot
  ): StateReceipt {
    if (command.action.kind !== "reverse") {
      throw new UnsupportedTargetError("Internal reversal action mismatch");
    }
    const surgeryIds = command.action.surgeryIds;
    if (surgeryIds.length === 0) {
      throw new UnsupportedTargetError("A reversal must name at least one surgeryId");
    }
    if (
      command.occurrenceIds.length !== 0 &&
      command.occurrenceIds.length !== surgeryIds.length
    ) {
      throw new UnsupportedTargetError("Reversal occurrenceIds must be empty or pair one-to-one with surgeryIds");
    }
    const surgeryById = new Map(current.surgeries.map((surgery) => [surgery.surgeryId, surgery]));
    const requested = surgeryIds.map((id) => {
      const surgery = surgeryById.get(id);
      if (!surgery || surgery.branchId !== command.branchId) {
        throw new UnsupportedTargetError(`Unknown branch-local surgery ${id}`);
      }
      if (surgery.state !== "committed") {
        throw new UnsupportedTargetError(`Surgery ${id} is already reversed`);
      }
      return surgery;
    });
    if (new Set(surgeryIds).size !== surgeryIds.length) {
      throw new UnsupportedTargetError("A reversal may not repeat a surgeryId");
    }

    const currentOccurrences = new Map(branch.occurrences.map((occurrence) => [occurrence.occurrenceId, occurrence]));
    const reversalId = randomUUID();
    const results: OperationResult[] = requested.map((surgery, index) => {
      const original = currentOccurrences.get(surgery.occurrenceId);
      const supplied = command.occurrenceIds[index]
        ? currentOccurrences.get(command.occurrenceIds[index])
        : undefined;
      const sourceState: ReversalSourceState = original
        ? original.sourceHash === surgery.expectedSourceHash ? "source-present" : "stale"
        : supplied ? "stale" : "source-absent";
      return Object.freeze({
        surgeryId: surgery.surgeryId,
        occurrenceId: supplied?.occurrenceId ?? surgery.occurrenceId,
        expectedSourceHash: surgery.expectedSourceHash,
        outcome: sourceState === "stale" ? "stale" as const : "committed" as const,
        reason: sourceState,
      });
    });
    const surgeries = current.surgeries.map((surgery) =>
      surgeryIds.includes(surgery.surgeryId)
        ? Object.freeze({ ...surgery, state: "reversed" as const, reversedBy: reversalId })
        : surgery
    );
    return this.persist(
      command,
      current,
      surgeries,
      results,
      surgeryIds,
      this.now().toISOString(),
      reversalId
    );
  }

  private persist(
    command: MutationCommand,
    current: StateSnapshot,
    surgeries: readonly SurgeryRecord[],
    operationResults: readonly OperationResult[],
    surgeryIds: readonly string[],
    committedAt: string,
    receiptId = randomUUID()
  ): StateReceipt {
    const receipt: StateReceipt = Object.freeze({
      receiptId,
      operationId: command.operationId,
      sessionId: command.sessionId,
      branchId: command.branchId,
      previousRevision: current.revision,
      committedRevision: current.revision + 1,
      surgeryIds: Object.freeze([...surgeryIds]),
      operationResults: Object.freeze([...operationResults]),
      committedAt,
    });
    const next = freezeSnapshot({
      version: 3,
      sessionId: current.sessionId,
      revision: current.revision + 1,
      surgeries: Object.freeze([...surgeries]),
      receiptsByOperationId: Object.freeze({
        ...current.receiptsByOperationId,
        [command.operationId]: receipt,
      }),
    });
    return this.store.commit({
      expectedRevision: current.revision,
      operationId: command.operationId,
      next,
      receipt,
    });
  }

  private exactBranch(selection: BranchSelection): ExplicitBranchSnapshot {
    if (selection.sessionId !== this.sessionId) {
      throw new AmbiguousConversationError("Selection session does not match the owning session");
    }
    return this.catalog.exact(selection);
  }
}
