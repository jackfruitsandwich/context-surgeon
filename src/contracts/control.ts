import type { StateReceipt } from "./state.js";
import type { AttemptReceipt, UsageProvenance } from "./truth.js";

export type GuaranteeState =
  | Readonly<{ kind: "unverified"; reason: "no-proxied-request-observed" }>
  | Readonly<{ kind: "active"; lastAttemptId: string }>
  | Readonly<{ kind: "rejected"; reason: string }>
  | Readonly<{ kind: "bypass-explicit" }>;

export type ControlIdentity = Readonly<{
  pid: number;
  version: string;
  sessionId: string;
  nonce: string;
  target: string;
  startedAt: string;
  guarantee: GuaranteeState;
}>;

export type MutationCommand = Readonly<{
  operationId: string;
  sessionId: string;
  conversationId: string;
  branchId: string;
  expectedRevision: number;
  occurrenceIds: readonly string[];
  requireComplete: boolean;
  action:
    | Readonly<{ kind: "evict" }>
    | Readonly<{ kind: "replace"; content: string }>
    | Readonly<{ kind: "reverse"; surgeryIds: readonly string[] }>;
}>;

export type MutationResponse =
  | Readonly<{ ok: true; receipt: StateReceipt }>
  | Readonly<{
      ok: false;
      code:
        | "ambiguous-identity"
        | "stale-revision"
        | "unsupported-target"
        | "persistence-failed"
        | "recovery-required";
      error: string;
    }>;

export type TruthStatus = Readonly<{
  guarantee: GuaranteeState;
  lastAttempt: AttemptReceipt | null;
  usage: Readonly<{
    value: number | null;
    provenance: UsageProvenance;
  }>;
  ledger: Readonly<{
    path: string;
    persisted: boolean;
    error?: string;
  }>;
}>;
