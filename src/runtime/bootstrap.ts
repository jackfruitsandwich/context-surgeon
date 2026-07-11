import { chmodSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { GuaranteeState } from "../contracts/control.js";
import { guaranteeLabel } from "./guarantee.js";

const runtimeDirectory = dirname(fileURLToPath(import.meta.url));

export function packageRoot(): string {
  return join(runtimeDirectory, "..", "..");
}

export function loadPackagedText(filename: string): string {
  return readFileSync(join(packageRoot(), filename), "utf8");
}

export function loadPackageVersion(): string {
  try {
    const parsed = JSON.parse(loadPackagedText("package.json")) as { version?: string };
    return parsed.version ?? "unknown";
  } catch {
    return "unknown";
  }
}

export type RuntimeRecord = Readonly<{
  pid: number;
  sessionId: string;
  target: string;
  mode: string;
  modelPort: number;
  controlAddress: string | null;
  startedAt: string;
  guaranteeAtWrite: GuaranteeState;
}>;

export function registerRuntimeRecord(
  record: RuntimeRecord,
  directory = join(homedir(), ".context-surgeon", "runtime")
): () => void {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  chmodSync(directory, 0o700);
  const path = join(directory, `${record.sessionId}.json`);
  writeFileSync(path, JSON.stringify(record, null, 2), { mode: 0o600 });
  chmodSync(path, 0o600);
  return () => {
    try {
      unlinkSync(path);
    } catch {}
  };
}

export function printStartupBanner(input: {
  target: string;
  mode: string;
  upstreamClass: string;
  authClass: string;
  modelPort: number | null;
  controlAddress: string | null;
  sessionId: string;
  identitySource: string;
  persistencePath: string | null;
  guarantee: GuaranteeState;
}): void {
  const persistence = input.persistencePath ?? "not integrated (B2 state/control hook required)";
  console.error(
    [
      "[context-surgeon] Runtime safety check",
      `  target: ${input.target}`,
      `  launch mode: ${input.mode}`,
      `  upstream class: ${input.upstreamClass}`,
      `  auth class: ${input.authClass}`,
      `  model listener: ${input.modelPort === null ? "none" : `127.0.0.1:${input.modelPort}`}`,
      `  control listener: ${input.controlAddress ?? "not integrated"}`,
      `  session: ${input.sessionId} (${input.identitySource})`,
      `  persistence: ${persistence}`,
      `  surgery guarantee: ${guaranteeLabel(input.guarantee)}`,
    ].join("\n")
  );
}
