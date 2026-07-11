import {
  closeSync,
  constants,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import type { SessionOwner, SessionOwnershipState } from "../contracts/state.js";

export type OwnerProbeResult =
  | Readonly<{ kind: "live"; sessionId: string; nonce: string }>
  | Readonly<{ kind: "no-listener" }>
  | Readonly<{ kind: "timeout" }>
  | Readonly<{ kind: "wrong-response"; reason: string }>;

export type OwnerProbe = (owner: SessionOwner) => Promise<OwnerProbeResult>;

export type OwnershipResult = Readonly<{
  state: SessionOwnershipState;
  owner: SessionOwner | null;
  stalePath?: string;
  reason?: string;
}>;

function ownerRecordPath(lockPath: string): string {
  return join(lockPath, "owner.json");
}

function fsyncDirectory(path: string): void {
  const fd = openSync(path, "r");
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

function parseOwner(path: string): SessionOwner {
  const value = JSON.parse(readFileSync(path, "utf8")) as Partial<SessionOwner>;
  if (
    typeof value.pid !== "number" ||
    typeof value.nonce !== "string" ||
    typeof value.controlAddress !== "string" ||
    typeof value.acquiredAt !== "string"
  ) {
    throw new Error("Owner record is invalid");
  }
  return value as SessionOwner;
}

export function createSessionOwner(controlAddress: string): SessionOwner {
  return Object.freeze({
    pid: process.pid,
    nonce: randomBytes(32).toString("hex"),
    controlAddress,
    acquiredAt: new Date().toISOString(),
  });
}

/**
 * Atomic lock-directory fallback for platforms/runtime seams where the Unix
 * listener itself cannot be the ownership primitive. PID is informational;
 * only an authenticated nonce response proves a live owner.
 */
export class SessionOwnershipLock {
  private held = false;

  constructor(
    readonly sessionId: string,
    readonly lockPath: string,
    readonly owner: SessionOwner,
    private readonly probe: OwnerProbe,
    private readonly reclaimGraceMs = 5_000,
    private readonly now: () => number = () => Date.now()
  ) {}

  async acquire(): Promise<OwnershipResult> {
    const directory = dirname(this.lockPath);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    try {
      this.createOwnedLock(directory);
      return { state: "owned", owner: this.owner };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }

    let incumbent: SessionOwner;
    try {
      incumbent = parseOwner(ownerRecordPath(this.lockPath));
    } catch (error) {
      return {
        state: "wedged-recovery-required",
        owner: null,
        reason: `Ownership record cannot be authenticated: ${error instanceof Error ? error.message : String(error)}`,
      };
    }

    const probe = await this.probe(incumbent);
    if (
      probe.kind === "live" &&
      probe.sessionId === this.sessionId &&
      probe.nonce === incumbent.nonce
    ) {
      return { state: "live-owner", owner: incumbent };
    }
    if (probe.kind !== "no-listener") {
      return {
        state: "wedged-recovery-required",
        owner: incumbent,
        reason:
          probe.kind === "timeout"
            ? "Owner liveness timed out; manual recovery is required"
            : probe.kind === "live"
              ? "A listener responded with the wrong authenticated identity"
              : probe.reason,
      };
    }
    const acquiredAt = Date.parse(incumbent.acquiredAt);
    if (Number.isFinite(acquiredAt) && this.now() - acquiredAt < this.reclaimGraceMs) {
      return {
        state: "wedged-recovery-required",
        owner: incumbent,
        reason: "Owner record is still within its listener-start grace period",
      };
    }

    const reclaimPath = `${this.lockPath}.reclaim`;
    try {
      mkdirSync(reclaimPath, { mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        return {
          state: "wedged-recovery-required",
          owner: incumbent,
          reason: "Another contender is performing the atomic reclaim",
        };
      }
      throw error;
    }

    let checked: SessionOwner;
    try {
      checked = parseOwner(ownerRecordPath(this.lockPath));
    } catch (error) {
      rmSync(reclaimPath, { recursive: true, force: true });
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return this.acquire();
      throw error;
    }
    if (checked.nonce !== incumbent.nonce) {
      rmSync(reclaimPath, { recursive: true, force: true });
      return this.acquire();
    }

    const stalePath = `${this.lockPath}.stale.${randomUUID()}`;
    try {
      renameSync(this.lockPath, stalePath);
      fsyncDirectory(directory);
    } catch (error) {
      rmSync(reclaimPath, { recursive: true, force: true });
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return this.acquire();
      }
      throw error;
    }

    try {
      this.createOwnedLock(directory);
      rmSync(reclaimPath, { recursive: true, force: true });
      return {
        state: "owned",
        owner: this.owner,
        stalePath,
      };
    } catch (error) {
      rmSync(reclaimPath, { recursive: true, force: true });
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        return this.acquire();
      }
      throw error;
    }
  }

  release(): void {
    if (!this.held) return;
    let incumbent: SessionOwner;
    try { incumbent = parseOwner(ownerRecordPath(this.lockPath)); } catch { return; }
    if (incumbent.nonce !== this.owner.nonce) return;
    rmSync(this.lockPath, { recursive: true, force: true });
    try { fsyncDirectory(dirname(this.lockPath)); } catch {}
    this.held = false;
  }

  inspection(): Readonly<{ exists: boolean; mode: string | null; owner: SessionOwner | null }> {
    try {
      return {
        exists: true,
        mode: (statSync(this.lockPath).mode & 0o777).toString(8).padStart(3, "0"),
        owner: parseOwner(ownerRecordPath(this.lockPath)),
      };
    } catch {
      return { exists: false, mode: null, owner: null };
    }
  }

  private createOwnedLock(parent: string): void {
    mkdirSync(this.lockPath, { mode: 0o700 });
    const record = ownerRecordPath(this.lockPath);
    let fd: number | null = null;
    try {
      fd = openSync(record, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
      writeFileSync(fd, `${JSON.stringify(this.owner)}\n`, "utf8");
      fsyncSync(fd);
      closeSync(fd);
      fd = null;
      fsyncDirectory(this.lockPath);
      fsyncDirectory(parent);
      this.held = true;
    } catch (error) {
      if (fd !== null) closeSync(fd);
      rmSync(this.lockPath, { recursive: true, force: true });
      throw error;
    }
  }
}
