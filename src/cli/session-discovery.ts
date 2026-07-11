import { readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ControlRecord } from "../api/control-auth.js";

export type PortRecord = {
  pid: number;
  port: number;
  target?: string;
  startedAt?: string;
};

export type DiscoveredControlRecord = Readonly<{
  path: string;
  record: ControlRecord;
}>;

function isControlRecord(value: unknown): value is ControlRecord {
  if (!value || typeof value !== "object") return false;
  const record = value as Partial<ControlRecord>;
  const identity = record.identity;
  const address = record.address;
  return (
    record.version === 2 &&
    !!identity &&
    typeof identity.sessionId === "string" &&
    typeof identity.nonce === "string" &&
    typeof record.capability === "string" &&
    !!address &&
    ((address.kind === "unix" && typeof address.path === "string") ||
      (address.kind === "http" && typeof address.url === "string"))
  );
}

export function defaultSessionsDirectory(): string {
  return join(homedir(), ".context-surgeon", "sessions");
}

export function readControlRecords(
  sessionsDirectory = defaultSessionsDirectory()
): readonly DiscoveredControlRecord[] {
  let sessions: string[];
  try { sessions = readdirSync(sessionsDirectory); } catch { return []; }
  const records: DiscoveredControlRecord[] = [];
  for (const session of sessions) {
    const path = join(sessionsDirectory, session, "control.json");
    try {
      if ((statSync(path).mode & 0o777) !== 0o600) continue;
      const record = JSON.parse(readFileSync(path, "utf8")) as unknown;
      if (isControlRecord(record) && record.identity.sessionId === session) {
        records.push(Object.freeze({ path, record }));
      }
    } catch {}
  }
  return Object.freeze(records);
}

export function inheritedControlRecord(): DiscoveredControlRecord | null {
  const raw = process.env.CONTEXT_SURGEON_CONTROL_RECORD;
  if (!raw) return null;
  try {
    const record = JSON.parse(raw) as unknown;
    return isControlRecord(record)
      ? Object.freeze({ path: "<environment>", record })
      : null;
  } catch { return null; }
}

export function candidateControlRecords(
  sessionsDirectory = defaultSessionsDirectory(),
  requestedSessionId = process.env.CONTEXT_SURGEON_SESSION_ID
): readonly DiscoveredControlRecord[] {
  const inherited = inheritedControlRecord();
  const all = inherited ? [inherited] : [...readControlRecords(sessionsDirectory)];
  return requestedSessionId
    ? all.filter(({ record }) => record.identity.sessionId === requestedSessionId)
    : all;
}

/** Legacy records are evidence for migration only; PID never proves liveness. */
export function readLivePortRecords(): PortRecord[] {
  const portsDir = join(homedir(), ".context-surgeon", "ports");
  let files: string[];
  try { files = readdirSync(portsDir); } catch { return []; }
  return files.flatMap((file) => {
    if (!file.endsWith(".json")) return [];
    try {
      const parsed = JSON.parse(readFileSync(join(portsDir, file), "utf8")) as PortRecord;
      return typeof parsed.pid === "number" && typeof parsed.port === "number" ? [parsed] : [];
    } catch { return []; }
  });
}

/** @deprecated v2 commands use authenticated control records, never PID/port selection. */
export function getPort(): string {
  return process.env.CONTEXT_SURGEON_PORT ?? "";
}

/** @deprecated retained for source compatibility with third-party imports. */
export function controlUrl(path: string): string {
  const port = getPort();
  if (!port) throw new Error("No legacy control port is selected");
  return `http://127.0.0.1:${port}${path}`;
}
