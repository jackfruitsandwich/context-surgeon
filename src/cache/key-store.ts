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
  writeFileSync,
} from "node:fs";
import { randomBytes } from "node:crypto";
import { dirname, join } from "node:path";

function fsyncDirectory(path: string): void {
  const fd = openSync(path, "r");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

/** Context Surgeon owns this key domain; it is never shared with Wuwei. */
export function loadOrCreateCacheHmacSecret(
  sessionDirectory: string,
  options: Readonly<{ allowCreate?: boolean }> = {}
): Uint8Array {
  const path = join(sessionDirectory, "cache-hmac.key");
  if (existsSync(path)) {
    const mode = statSync(path).mode & 0o777;
    if (mode !== 0o600) {
      throw new Error(`Cache telemetry key permissions are ${mode.toString(8)}, expected 600`);
    }
    const value = readFileSync(path);
    if (value.length !== 32) throw new Error("Cache telemetry key must contain exactly 32 bytes");
    return new Uint8Array(value);
  }

  if (options.allowCreate === false) {
    throw new Error(
      "Cache telemetry key is missing for established bootstrap state; an explicit new cache namespace is required"
    );
  }

  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const value = randomBytes(32);
  const fd = openSync(
    path,
    constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
    0o600
  );
  try {
    writeFileSync(fd, value);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  chmodSync(path, 0o600);
  fsyncDirectory(dirname(path));
  return new Uint8Array(value);
}
