import type {
  IdentityResolver,
  ResolvedIdentity,
  StateReceipt,
  StateSnapshot,
  StateTransactionStore,
} from "../../src/contracts/index.js";

export class FixedIdentityResolver implements IdentityResolver {
  constructor(private readonly identity: ResolvedIdentity) {}

  resolve(): ResolvedIdentity {
    return this.identity;
  }
}

export class InMemoryStateStore implements StateTransactionStore {
  private snapshots = new Map<string, StateSnapshot>();

  constructor(initial?: StateSnapshot) {
    if (initial) this.snapshots.set(initial.sessionId, initial);
  }

  current(sessionId: string): StateSnapshot {
    return (
      this.snapshots.get(sessionId) ?? {
        version: 4,
        sessionId,
        revision: 0,
        surgeries: [],
        bootstrapBranches: [],
        receiptsByOperationId: {},
      }
    );
  }

  commit(input: {
    expectedRevision: number;
    operationId: string;
    next: StateSnapshot;
    receipt: StateReceipt;
  }): StateReceipt {
    const current = this.current(input.next.sessionId);
    const existing = current.receiptsByOperationId[input.operationId];
    if (existing) return existing;
    if (current.revision !== input.expectedRevision) {
      throw new Error(
        `Stale revision: expected ${input.expectedRevision}, current ${current.revision}`
      );
    }
    this.snapshots.set(input.next.sessionId, input.next);
    return input.receipt;
  }
}
