import { readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type PortRecord = {
  pid: number;
  port: number;
  target?: string;
  startedAt?: string;
};

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function readLivePortRecords(): PortRecord[] {
  const portsDir = join(homedir(), ".context-surgeon", "ports");
  let files: string[];
  try {
    files = readdirSync(portsDir);
  } catch {
    return [];
  }

  const records: PortRecord[] = [];
  for (const file of files) {
    if (!file.endsWith(".json")) continue;
    try {
      const parsed = JSON.parse(
        readFileSync(join(portsDir, file), "utf-8")
      ) as PortRecord;
      if (
        typeof parsed.pid === "number" &&
        typeof parsed.port === "number" &&
        isProcessAlive(parsed.pid)
      ) {
        records.push(parsed);
      }
    } catch {
      // unreadable record — ignore
    }
  }
  return records;
}

export function getPort(): string {
  if (process.env.CONTEXT_SURGEON_PORT) {
    return process.env.CONTEXT_SURGEON_PORT;
  }

  const live = readLivePortRecords();
  if (live.length === 1) {
    return String(live[0].port);
  }
  if (live.length > 1) {
    const listing = live
      .map(
        (record) =>
          `  port ${record.port} — ${record.target ?? "?"} (pid ${record.pid}, started ${record.startedAt ?? "?"})`
      )
      .join("\n");
    throw new Error(
      `${live.length} context-surgeon proxies are running and CONTEXT_SURGEON_PORT is not set — ` +
        `refusing to guess which session you mean:\n${listing}\n` +
        `Set CONTEXT_SURGEON_PORT=<port> to target one.`
    );
  }

  try {
    const portFile = join(homedir(), ".context-surgeon", "port");
    return readFileSync(portFile, "utf-8").trim();
  } catch {
    return "";
  }
}

export function controlUrl(path: string): string {
  return `http://127.0.0.1:${getPort()}${path}`;
}

