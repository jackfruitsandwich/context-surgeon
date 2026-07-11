import {
  closeSync,
  chmodSync,
  copyFileSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
  constants,
} from "node:fs";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import type {
  StateReceipt,
  StateSnapshot,
  StateTransactionStore,
  SurgeryAction,
} from "../contracts/state.js";

export type PersistenceStep =
  | "after-temp-open"
  | "after-temp-write"
  | "after-file-fsync"
  | "after-rename"
  | "after-directory-fsync"
  | "before-memory-publication";

export type PersistenceFailpoint = (step: PersistenceStep) => void;

export class RecoveryRequiredError extends Error {
  readonly code = "recovery-required" as const;

  constructor(message: string, readonly quarantinePath?: string) {
    super(message);
    this.name = "RecoveryRequiredError";
  }
}

export class StaleRevisionError extends Error {
  readonly code = "stale-revision" as const;

  constructor(readonly expected: number, readonly actual: number) {
    super(`Stale revision: expected ${expected}, current ${actual}`);
    this.name = "StaleRevisionError";
  }
}

function emptySnapshot(sessionId: string): StateSnapshot {
  return Object.freeze({
    version: 3 as const,
    sessionId,
    revision: 0,
    surgeries: Object.freeze([]),
    receiptsByOperationId: Object.freeze({}),
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function onlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  const set = new Set(allowed);
  return Object.keys(value).every((key) => set.has(key));
}

function isAction(value: unknown): value is SurgeryAction {
  if (!isRecord(value) || typeof value.kind !== "string") return false;
  if (value.kind === "evict") return Object.keys(value).length === 1;
  if (value.kind === "replace") {
    return typeof value.content === "string" && Object.keys(value).every((key) => key === "kind" || key === "content");
  }
  return (
    value.kind === "evict-media" &&
    (value.mediaType === "image" || value.mediaType === "document") &&
    Object.keys(value).every((key) => key === "kind" || key === "mediaType")
  );
}

function validateReceipt(value: unknown, operationId: string, sessionId: string): value is StateReceipt {
  if (!isRecord(value)) return false;
  if (!onlyKeys(value, [
    "receiptId", "operationId", "sessionId", "branchId", "previousRevision",
    "committedRevision", "surgeryIds", "operationResults", "committedAt",
  ])) return false;
  return (
    typeof value.receiptId === "string" &&
    value.operationId === operationId &&
    value.sessionId === sessionId &&
    typeof value.branchId === "string" &&
    Number.isInteger(value.previousRevision) &&
    Number.isInteger(value.committedRevision) &&
    Array.isArray(value.surgeryIds) &&
    value.surgeryIds.every((id) => typeof id === "string") &&
    Array.isArray(value.operationResults) &&
    value.operationResults.every((result) =>
      isRecord(result) &&
      onlyKeys(result, ["surgeryId", "occurrenceId", "expectedSourceHash", "outcome", "outputHash", "reason"]) &&
      typeof result.surgeryId === "string" &&
      typeof result.occurrenceId === "string" &&
      typeof result.expectedSourceHash === "string" &&
      ["applied", "protected-residue", "unsupported", "stale", "rejected"].includes(String(result.outcome)) &&
      (result.outputHash === undefined || typeof result.outputHash === "string") &&
      (result.reason === undefined || typeof result.reason === "string")
    ) &&
    typeof value.committedAt === "string"
  );
}

export function validateStateSnapshot(value: unknown, expectedSessionId?: string): StateSnapshot {
  if (!isRecord(value) || value.version !== 3) {
    throw new Error("State snapshot has an unsupported or missing version");
  }
  if (!onlyKeys(value, ["version", "sessionId", "revision", "surgeries", "receiptsByOperationId"])) {
    throw new Error("State snapshot contains unsupported fields");
  }
  if (typeof value.sessionId !== "string" || !value.sessionId) {
    throw new Error("State snapshot sessionId is invalid");
  }
  if (expectedSessionId && value.sessionId !== expectedSessionId) {
    throw new Error("State snapshot belongs to a different session");
  }
  if (!Number.isInteger(value.revision) || (value.revision as number) < 0) {
    throw new Error("State snapshot revision is invalid");
  }
  if (!Array.isArray(value.surgeries)) throw new Error("State surgeries must be an array");
  const surgeryIds = new Set<string>();
  for (const raw of value.surgeries) {
    if (!isRecord(raw)) throw new Error("Invalid surgery record");
    if (
      !onlyKeys(raw, [
        "surgeryId", "state", "branchId", "occurrenceId", "expectedSourceHash",
        "action", "createdAt", "reversedBy",
      ]) ||
      typeof raw.surgeryId !== "string" ||
      surgeryIds.has(raw.surgeryId) ||
      (raw.state !== "committed" && raw.state !== "reversed") ||
      typeof raw.branchId !== "string" ||
      typeof raw.occurrenceId !== "string" ||
      typeof raw.expectedSourceHash !== "string" ||
      !/^[a-f0-9]{64}$/.test(raw.expectedSourceHash) ||
      !isAction(raw.action) ||
      typeof raw.createdAt !== "string" ||
      (raw.reversedBy !== undefined && typeof raw.reversedBy !== "string")
    ) {
      throw new Error("Invalid surgery record");
    }
    if (raw.state === "reversed" && !raw.reversedBy) {
      throw new Error("Reversed surgery is missing reversedBy");
    }
    surgeryIds.add(raw.surgeryId);
  }
  if (!isRecord(value.receiptsByOperationId)) {
    throw new Error("State receiptsByOperationId must be an object");
  }
  for (const [operationId, receipt] of Object.entries(value.receiptsByOperationId)) {
    if (!validateReceipt(receipt, operationId, value.sessionId)) {
      throw new Error(`Invalid receipt for operation ${operationId}`);
    }
  }
  return value as unknown as StateSnapshot;
}

function fsyncDirectory(path: string): void {
  const fd = openSync(path, "r");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function writeWholeFile(fd: number, payload: string): void {
  writeFileSync(fd, payload, { encoding: "utf8" });
}

export type SnapshotStoreInspection = Readonly<{
  statePath: string;
  exists: boolean;
  version: number | null;
  revision: number | null;
  mode: string | null;
  recoveryRequired: boolean;
  quarantinePath: string | null;
}>;

/** One process-local publication point backed by one whole v3 revision. */
export class AtomicStateSnapshotStore implements StateTransactionStore {
  private snapshot: StateSnapshot;
  private recovery: RecoveryRequiredError | null = null;
  private quarantine: string | null = null;

  constructor(
    readonly sessionId: string,
    readonly statePath: string,
    private readonly failpoint?: PersistenceFailpoint
  ) {
    this.snapshot = emptySnapshot(sessionId);
    this.load();
  }

  static inSessionDirectory(
    sessionDirectory: string,
    sessionId: string,
    failpoint?: PersistenceFailpoint
  ): AtomicStateSnapshotStore {
    return new AtomicStateSnapshotStore(sessionId, join(sessionDirectory, "state.json"), failpoint);
  }

  current(sessionId: string): StateSnapshot {
    if (sessionId !== this.sessionId) throw new Error("Store session mismatch");
    if (this.recovery) throw this.recovery;
    return this.snapshot;
  }

  commit(input: {
    expectedRevision: number;
    operationId: string;
    next: StateSnapshot;
    receipt: StateReceipt;
  }): StateReceipt {
    if (this.recovery) throw this.recovery;
    const existing = this.snapshot.receiptsByOperationId[input.operationId];
    if (existing) return existing;
    if (this.snapshot.revision !== input.expectedRevision) {
      throw new StaleRevisionError(input.expectedRevision, this.snapshot.revision);
    }
    const next = validateStateSnapshot(input.next, this.sessionId);
    if (
      next.revision !== this.snapshot.revision + 1 ||
      input.receipt.previousRevision !== this.snapshot.revision ||
      input.receipt.committedRevision !== next.revision ||
      next.receiptsByOperationId[input.operationId]?.receiptId !== input.receipt.receiptId
    ) {
      throw new Error("Next snapshot and receipt do not describe one complete revision");
    }

    const directory = dirname(this.statePath);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const tempPath = `${this.statePath}.tmp.${randomUUID()}`;
    let fd: number | null = null;
    let renamed = false;
    try {
      fd = openSync(tempPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
      this.failpoint?.("after-temp-open");
      writeWholeFile(fd, `${JSON.stringify(next)}\n`);
      this.failpoint?.("after-temp-write");
      fsyncSync(fd);
      this.failpoint?.("after-file-fsync");
      closeSync(fd);
      fd = null;
      renameSync(tempPath, this.statePath);
      renamed = true;
      this.failpoint?.("after-rename");
      fsyncDirectory(directory);
      this.failpoint?.("after-directory-fsync");
      this.failpoint?.("before-memory-publication");
      this.snapshot = next;
      return input.receipt;
    } finally {
      if (fd !== null) closeSync(fd);
      if (!renamed) {
        try { unlinkSync(tempPath); } catch {}
      }
    }
  }

  inspection(): SnapshotStoreInspection {
    let version: number | null = null;
    let revision: number | null = null;
    let mode: string | null = null;
    if (existsSync(this.statePath)) {
      try {
        const parsed = JSON.parse(readFileSync(this.statePath, "utf8")) as Record<string, unknown>;
        version = typeof parsed.version === "number" ? parsed.version : null;
        revision = typeof parsed.revision === "number" ? parsed.revision : null;
      } catch {}
      try { mode = (statSync(this.statePath).mode & 0o777).toString(8).padStart(3, "0"); } catch {}
    }
    return Object.freeze({
      statePath: this.statePath,
      exists: existsSync(this.statePath),
      version,
      revision,
      mode,
      recoveryRequired: !!this.recovery,
      quarantinePath: this.quarantine,
    });
  }

  private load(): void {
    const markerPath = `${this.statePath}.recovery-required`;
    if (existsSync(markerPath)) {
      let quarantinePath: string | undefined;
      let reason = "A prior load quarantined corrupt or incompatible state";
      try {
        const marker = JSON.parse(readFileSync(markerPath, "utf8")) as { quarantinePath?: unknown; reason?: unknown };
        if (typeof marker.quarantinePath === "string") quarantinePath = marker.quarantinePath;
        if (typeof marker.reason === "string") reason = marker.reason;
      } catch {
        reason = "The durable recovery-required marker is itself unreadable";
      }
      this.quarantine = quarantinePath ?? null;
      this.recovery = new RecoveryRequiredError(reason, quarantinePath);
      return;
    }
    if (!existsSync(this.statePath)) return;
    try {
      const mode = statSync(this.statePath).mode & 0o777;
      if (mode !== 0o600) {
        throw new Error(`State snapshot permissions are ${mode.toString(8)}, expected 600`);
      }
      this.snapshot = validateStateSnapshot(
        JSON.parse(readFileSync(this.statePath, "utf8")),
        this.sessionId
      );
    } catch (error) {
      const directory = dirname(this.statePath);
      const quarantine = `${this.statePath}.quarantine.${Date.now()}.${randomUUID()}`;
      const reason = `State is corrupt or incompatible: ${error instanceof Error ? error.message : String(error)}`;
      try {
        mkdirSync(directory, { recursive: true, mode: 0o700 });
        copyFileSync(this.statePath, quarantine, constants.COPYFILE_EXCL);
        chmodSync(quarantine, 0o600);
        const quarantineFd = openSync(quarantine, "r");
        try { fsyncSync(quarantineFd); } finally { closeSync(quarantineFd); }
        this.quarantine = quarantine;
      } catch {
        this.quarantine = null;
      }
      try {
        const markerFd = openSync(markerPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
        try {
          writeFileSync(markerFd, `${JSON.stringify({ reason, quarantinePath: this.quarantine })}\n`, "utf8");
          fsyncSync(markerFd);
        } finally { closeSync(markerFd); }
        fsyncDirectory(directory);
      } catch {}
      this.recovery = new RecoveryRequiredError(reason, this.quarantine ?? undefined);
    }
  }
}
