import { createHash, randomBytes, timingSafeEqual, randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  fsyncSync,
  mkdirSync,
  openSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import type { ControlIdentity } from "../contracts/control.js";

export type ControlAddress =
  | Readonly<{ kind: "unix"; path: string }>
  | Readonly<{ kind: "http"; url: string }>;

export type ControlRecord = Readonly<{
  version: 2;
  identity: ControlIdentity;
  capability: string;
  address: ControlAddress;
}>;

export function createControlCapability(): string {
  return randomBytes(32).toString("base64url");
}

function digest(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

export function capabilityMatches(expected: string, supplied: string | undefined): boolean {
  if (!supplied) return false;
  return timingSafeEqual(digest(expected), digest(supplied));
}

export function bearerCapability(header: string | undefined): string | undefined {
  const match = /^Bearer ([A-Za-z0-9_-]+)$/.exec(header ?? "");
  return match?.[1];
}

export function writeControlRecord(path: string, record: ControlRecord): void {
  const directory = dirname(path);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const tempPath = `${path}.tmp.${randomUUID()}`;
  let fd: number | null = null;
  let renamed = false;
  try {
    fd = openSync(tempPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
    writeFileSync(fd, `${JSON.stringify(record)}\n`, "utf8");
    fsyncSync(fd);
    closeSync(fd);
    fd = null;
    renameSync(tempPath, path);
    renamed = true;
    const dirFd = openSync(directory, "r");
    try { fsyncSync(dirFd); } finally { closeSync(dirFd); }
  } finally {
    if (fd !== null) closeSync(fd);
    if (!renamed) {
      try { unlinkSync(tempPath); } catch {}
    }
  }
}
