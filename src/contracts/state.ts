import type { OperationResult } from "./truth.js";

export type IdentityConfidence =
  | "native"
  | "explicit"
  | "unique-extension"
  | "ambiguous";

export type ResolvedIdentity = Readonly<{
  sessionId: string;
  conversationId: string;
  branchId: string;
  revision: number;
  confidence: IdentityConfidence;
  reason?: string;
  parentBranchId?: string;
  forkPoint?: number;
  historyTransition?: "created" | "stable" | "extended" | "trimmed" | "forked";
}>;

export type OccurrenceKind =
  | "user-text"
  | "assistant-text"
  | "tool-result-text"
  | "image"
  | "document"
  | "tool-call"
  | "reasoning"
  | "other";

export type Occurrence = Readonly<{
  occurrenceId: string;
  sessionId: string;
  branchId: string;
  revision: number;
  kind: OccurrenceKind;
  sourceHash: string;
  displayLabel: string;
  providerPath: readonly (string | number)[];
  mutable: boolean;
  protectedReason?: string;
}>;

export type SurgeryAction =
  | Readonly<{ kind: "evict" }>
  | Readonly<{ kind: "replace"; content: string }>
  | Readonly<{ kind: "evict-media"; mediaType: "image" | "document" }>;

export type SurgeryState = "committed" | "reversed";

export type SurgeryRecord = Readonly<{
  surgeryId: string;
  state: SurgeryState;
  branchId: string;
  occurrenceId: string;
  expectedSourceHash: string;
  action: SurgeryAction;
  createdAt: string;
  reversedBy?: string;
}>;

export type StateReceipt = Readonly<{
  receiptId: string;
  operationId: string;
  sessionId: string;
  branchId: string;
  previousRevision: number;
  committedRevision: number;
  surgeryIds: readonly string[];
  operationResults: readonly OperationResult[];
  explanationCodes?: readonly string[];
  bootstrapTransition?: BootstrapTransitionReceipt;
  committedAt: string;
}>;

export type BootstrapDecision = "pending" | "inject" | "preserve";

export type BootstrapAnchor = Readonly<{
  occurrenceId: string;
  providerPath: readonly (string | number)[];
  sourceHash: string;
}>;

export type BootstrapBranchState = Readonly<{
  conversationId: string;
  branchId: string;
  parentBranchId?: string;
  forkPoint?: number;
  history: readonly string[];
  observations: readonly (readonly string[])[];
  decision: BootstrapDecision;
  status: "awaiting-anchor" | "anchored" | "stopped";
  anchor?: BootstrapAnchor;
  reanchorCount: 0 | 1;
  inheritedFromBranchId?: string;
}>;

export type BootstrapTransitionReceipt = Readonly<{
  transitionId: string;
  branchId: string;
  explanationCodes: readonly string[];
  previousDecision?: BootstrapDecision;
  decision: BootstrapDecision;
  previousAnchor?: BootstrapAnchor;
  anchor?: BootstrapAnchor;
}>;

export type StateSnapshot = Readonly<{
  version: 4;
  sessionId: string;
  revision: number;
  surgeries: readonly SurgeryRecord[];
  bootstrapBranches: readonly BootstrapBranchState[];
  receiptsByOperationId: Readonly<Record<string, StateReceipt>>;
}>;

export type SessionOwnershipState =
  | "owned"
  | "live-owner"
  | "wedged-recovery-required"
  | "provably-dead-reclaimable"
  | "read-only";

export type SessionOwner = Readonly<{
  pid: number;
  nonce: string;
  controlAddress: string;
  acquiredAt: string;
}>;

export interface IdentityResolver {
  resolve(input: {
    nativeSessionId?: string;
    explicitSessionId?: string;
    pristineItemHashes: readonly string[];
  }): ResolvedIdentity;
}

export interface StateSnapshotReader {
  current(sessionId: string): StateSnapshot;
}

export interface StateTransactionStore extends StateSnapshotReader {
  commit(input: {
    expectedRevision: number;
    operationId: string;
    next: StateSnapshot;
    receipt: StateReceipt;
  }): StateReceipt;
}
