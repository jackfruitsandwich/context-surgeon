import { readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const CONTROL_RETRY_DELAYS_MS = [0, 150, 500];

type StatusDirectiveRow = {
  id: string;
  action: string;
  tokens: number | null;
  tokenState: "known" | "pending" | "unknown";
};

type StatusResponse = {
  summary: {
    statusLine: string;
  };
  activeDirectives: StatusDirectiveRow[];
};

function getPort(): string {
  // Try env var first, then fall back to port file
  if (process.env.CONTEXT_SURGEON_PORT) {
    return process.env.CONTEXT_SURGEON_PORT;
  }
  try {
    const portFile = join(homedir(), ".context-surgeon", "port");
    return readFileSync(portFile, "utf-8").trim();
  } catch {
    return "";
  }
}

function controlUrl(path: string): string {
  const port = getPort();
  return `http://127.0.0.1:${port}${path}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function flattenErrorText(error: unknown): string {
  if (error instanceof Error) {
    const causeText =
      "cause" in error && error.cause !== undefined
        ? ` ${flattenErrorText(error.cause)}`
        : "";
    return `${error.name} ${error.message}${causeText}`;
  }
  return String(error);
}

export function isRetryableControlError(error: unknown): boolean {
  const text = flattenErrorText(error);
  return /fetch failed|econnreset|econnrefused|epipe|etimedout|socket hang up|networkerror/i.test(
    text
  );
}

function controlUnavailableError(lastError: unknown): Error {
  const detail = lastError ? ` Last error: ${flattenErrorText(lastError)}.` : "";
  return new Error(
    "Context-surgeon is temporarily unavailable." +
      " If your Mac just woke from sleep, wait a moment and retry." +
      " If it keeps failing, restart the wrapped session." +
      detail
  );
}

async function requestJson(
  path: string,
  init?: RequestInit
): Promise<unknown> {
  let lastError: unknown;

  for (let attempt = 0; attempt < CONTROL_RETRY_DELAYS_MS.length; attempt++) {
    if (CONTROL_RETRY_DELAYS_MS[attempt] > 0) {
      await sleep(CONTROL_RETRY_DELAYS_MS[attempt]);
    }

    try {
      const res = await fetch(controlUrl(path), init);
      return res.json();
    } catch (error) {
      lastError = error;
      if (
        attempt === CONTROL_RETRY_DELAYS_MS.length - 1 ||
        !isRetryableControlError(error)
      ) {
        break;
      }
    }
  }

  throw controlUnavailableError(lastError);
}

function looksLikeSyntheticToolId(id: string): boolean {
  return /^\d+\.\d+$/.test(id);
}

export function normalizeCommandId(command: string, id: string): string {
  const trimmed = id.trim();
  if (!trimmed) {
    return trimmed;
  }

  if (
    trimmed.startsWith("tool result ") ||
    trimmed.startsWith("tool call ") ||
    trimmed.startsWith("user message ") ||
    trimmed.startsWith("assistant message ")
  ) {
    return trimmed;
  }

  if (
    looksLikeSyntheticToolId(trimmed) &&
    (command === "evict" || command === "replace" || command === "restore")
  ) {
    return `tool result ${trimmed}`;
  }

  return trimmed;
}

async function post(
  path: string,
  body: Record<string, unknown>
): Promise<unknown> {
  return requestJson(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function get(path: string): Promise<unknown> {
  return requestJson(path);
}

function getFlagValue(args: string[], flag: string): string | null {
  const idx = args.indexOf(flag);
  if (idx === -1 || idx + 1 >= args.length) {
    return null;
  }
  return args[idx + 1];
}

function parseMediaType(args: string[]): "image" | "document" | null {
  const mediaType = getFlagValue(args, "--media");
  if (mediaType === "image" || mediaType === "document") {
    return mediaType;
  }
  return null;
}

function parseOccurrences(args: string[]): number[] | null {
  const raw = getFlagValue(args, "--occurrences");
  if (!raw) {
    return null;
  }

  const values = raw
    .split(",")
    .map((part) => parseInt(part.trim(), 10))
    .filter((value) => Number.isInteger(value) && value > 0);

  if (values.length === 0) {
    return null;
  }

  return [...new Set(values)].sort((a, b) => a - b);
}

function formatDirectiveTokens(directive: StatusDirectiveRow): string {
  if (directive.tokenState === "pending") {
    return "pending";
  }
  if (directive.tokenState === "unknown" || directive.tokens === null) {
    return "unknown";
  }
  return `${directive.tokens.toLocaleString()} tokens`;
}

export function formatStatusOutput(result: StatusResponse): string {
  const lines = [result.summary.statusLine, "", "Active directives:"];

  if (result.activeDirectives.length === 0) {
    lines.push("none");
    return lines.join("\n");
  }

  for (const directive of result.activeDirectives) {
    lines.push(
      `${directive.id} | ${directive.action} | ${formatDirectiveTokens(
        directive
      )}`
    );
  }

  return lines.join("\n");
}

export async function runCommand(args: string[]): Promise<void> {
  const port = getPort();
  if (!port) {
    console.error(
      "Error: No running context-surgeon session found.\n" +
        "Start one with: context-surgeon codex or context-surgeon claude"
    );
    process.exit(1);
  }

  const command = args[0];

  // The agent passes IDs like '[assistant message 4.2]' which the shell
  // may split into multiple args. Rejoin everything between command and
  // any flags (like --content), then strip brackets.
  function extractId(args: string[], startIdx: number): string {
    const parts: string[] = [];
    for (let i = startIdx; i < args.length; i++) {
      if (args[i].startsWith("--")) break;
      parts.push(args[i]);
    }
    const raw = parts.join(" ");
    // Strip surrounding brackets and quotes
    return raw.replace(/^\[?\s*/, "").replace(/\s*\]?$/, "").trim();
  }

  switch (command) {
    case "evict": {
      const id = normalizeCommandId(command, extractId(args, 1));
      const mediaType = parseMediaType(args);
      const occurrences = parseOccurrences(args);
      if (!id) {
        console.error(
          "Usage: context-surgeon evict <id> [--media image|document] [--occurrences 1,3]"
        );
        process.exit(1);
      }
      if (args.includes("--media") && !mediaType) {
        console.error("Error: --media must be 'image' or 'document'");
        process.exit(1);
      }
      if (args.includes("--occurrences") && !occurrences) {
        console.error("Error: --occurrences must be a comma-separated list like 1,3");
        process.exit(1);
      }
      if (mediaType && id.startsWith("tool call ")) {
        console.error("Error: media-only eviction is not supported for tool calls");
        process.exit(1);
      }
      const result = await post("/_control/evict", {
        id,
        mediaType: mediaType ?? undefined,
        occurrences: occurrences ?? undefined,
      });
      void result;
      console.log("ok");
      break;
    }

    case "replace": {
      const contentIdx = args.indexOf("--content");
      const id = normalizeCommandId(command, extractId(args, 1));
      const content =
        contentIdx !== -1 ? args.slice(contentIdx + 1).join(" ") : null;

      if (!id || !content) {
        console.error(
          'Usage: context-surgeon replace <id> --content "summary text"'
        );
        process.exit(1);
      }
      const result = await post("/_control/replace", { id, content });
      void result;
      console.log("ok");
      break;
    }

    case "restore": {
      const id = normalizeCommandId(command, extractId(args, 1));
      if (!id) {
        console.error("Usage: context-surgeon restore <id>");
        process.exit(1);
      }
      const result = await post("/_control/restore", { id });
      void result;
      console.log("ok");
      break;
    }

    case "status": {
      const result = await get("/_control/status");
      console.log(formatStatusOutput(result as StatusResponse));
      break;
    }

    default:
      console.error(
        `Unknown command: ${command}\n\nAvailable commands:\n  evict <id> [--media image|document] [--occurrences 1,3]\n  replace <id> --content "summary"\n  restore <id>\n  status`
      );
      process.exit(1);
  }
}
