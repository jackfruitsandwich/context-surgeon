import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  statSync,
  writeSync,
} from "node:fs";
import { dirname, join } from "node:path";
import type { AttemptReceipt } from "../contracts/truth.js";

export type AttemptLedgerObservation = Readonly<{
  observedAt: string;
  receipt: AttemptReceipt;
}>;

function isObservation(value: unknown): value is AttemptLedgerObservation {
  if (!value || typeof value !== "object") return false;
  const observation = value as Partial<AttemptLedgerObservation>;
  const receipt = observation.receipt as Partial<AttemptReceipt> | undefined;
  return (
    typeof observation.observedAt === "string" &&
    !!receipt &&
    typeof receipt.attemptId === "string" &&
    typeof receipt.requestId === "string" &&
    typeof receipt.sessionId === "string" &&
    typeof receipt.branchId === "string" &&
    Number.isInteger(receipt.stateRevision) &&
    Array.isArray(receipt.operationResults) &&
    typeof receipt.state === "string" &&
    receipt.method === "POST" &&
    typeof receipt.fullUrl === "string" &&
    typeof receipt.exactScopeSha256 === "string" &&
    typeof receipt.bodySha256 === "string" &&
    Number.isInteger(receipt.bodyLength) &&
    typeof receipt.connected === "boolean"
  );
}

function loadLatest(path: string): AttemptLedgerObservation | null {
  if (!existsSync(path)) return null;
  const lines = readFileSync(path, "utf8").split("\n");
  let latest: AttemptLedgerObservation | null = null;
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const value = JSON.parse(line) as unknown;
      if (isObservation(value)) latest = Object.freeze(value);
    } catch {
      // The ledger is observational, never authoritative surgery state. A
      // crash may tear its final append; retain the latest complete receipt.
    }
  }
  return latest;
}

function persistenceSafeReceipt(receipt: AttemptReceipt): AttemptReceipt {
  const url = new URL(receipt.fullUrl);
  if (!url.search && !url.hash) return receipt;
  const fullUrl = `${url.origin}${url.pathname}${url.search ? "?<redacted>" : ""}`;
  return Object.freeze({ ...receipt, fullUrl, urlValuesRedacted: true });
}

/**
 * Append-only, non-authoritative attempt evidence. It contains hashes,
 * lengths, lifecycle, safe header classifications, operation outcomes, and
 * provider usage only; exact request/response bytes and credentials never
 * enter this file.
 */
export class AttemptLedger {
  readonly path: string;
  #latest: AttemptLedgerObservation | null;

  constructor(sessionDirectory: string) {
    mkdirSync(sessionDirectory, { recursive: true, mode: 0o700 });
    chmodSync(sessionDirectory, 0o700);
    this.path = join(sessionDirectory, "attempts.jsonl");
    this.#latest = loadLatest(this.path);
    if (existsSync(this.path)) chmodSync(this.path, 0o600);
  }

  record(receipt: AttemptReceipt, observedAt = new Date().toISOString()): AttemptLedgerObservation {
    const observation = Object.freeze({ observedAt, receipt });
    const persisted = Object.freeze({
      observedAt,
      receipt: persistenceSafeReceipt(receipt),
    });
    const payload = `${JSON.stringify(persisted)}\n`;
    const fd = openSync(
      this.path,
      constants.O_CREAT | constants.O_APPEND | constants.O_WRONLY,
      0o600
    );
    try {
      writeSync(fd, payload, undefined, "utf8");
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    chmodSync(this.path, 0o600);
    this.#latest = observation;
    return observation;
  }

  latest(): AttemptLedgerObservation | null {
    return this.#latest;
  }

  inspection(): Readonly<{ path: string; exists: boolean; mode: string | null }> {
    try {
      return Object.freeze({
        path: this.path,
        exists: true,
        mode: (statSync(this.path).mode & 0o777).toString(8).padStart(3, "0"),
      });
    } catch {
      return Object.freeze({ path: this.path, exists: false, mode: null });
    }
  }
}
