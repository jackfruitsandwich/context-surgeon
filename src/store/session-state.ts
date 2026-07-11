import type { OwnershipResult, SessionOwnershipLock } from "./session-ownership.js";
import {
  AtomicStateSnapshotStore,
  type PersistenceFailpoint,
} from "./state-snapshot-store.js";

export type OwnedSessionState = Readonly<{
  ownership: OwnershipResult & Readonly<{ state: "owned" }>;
  store: AtomicStateSnapshotStore;
  close(): void;
}>;

export class SessionAlreadyOwnedError extends Error {
  constructor(readonly ownership: OwnershipResult) {
    super(ownership.reason ?? `Session writer is unavailable: ${ownership.state}`);
    this.name = "SessionAlreadyOwnedError";
  }
}

/** The production entry point: state is never opened writable before ownership. */
export async function openOwnedSessionState(input: {
  sessionId: string;
  sessionDirectory: string;
  ownershipLock: SessionOwnershipLock;
  failpoint?: PersistenceFailpoint;
}): Promise<OwnedSessionState> {
  const ownership = await input.ownershipLock.acquire();
  if (ownership.state !== "owned") throw new SessionAlreadyOwnedError(ownership);
  try {
    const store = AtomicStateSnapshotStore.inSessionDirectory(
      input.sessionDirectory,
      input.sessionId,
      input.failpoint
    );
    return Object.freeze({
      ownership: ownership as OwnershipResult & Readonly<{ state: "owned" }>,
      store,
      close: () => input.ownershipLock.release(),
    });
  } catch (error) {
    input.ownershipLock.release();
    throw error;
  }
}
