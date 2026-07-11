import { requestJson } from "./control-client.js";
import { getPort } from "./session-discovery.js";
export { isRetryableControlError } from "./control-client.js";

type StatusDirectiveRow = {
  id: string;
  fingerprint: string;
  action: string;
  tokens: number | null;
  state: "applied" | "pending" | "inactive";
  preview: string;
};

type StatusResponse = {
  summary: {
    statusLine: string;
    conversation: { preview: string; itemCount: number } | null;
  };
  activeDirectives: StatusDirectiveRow[];
};

export function isToolCallDirectiveKey(key: string): boolean {
  return /^tool call \d+(?:\.\d+)?$/.test(key);
}

type SkeletonRow = {
  id: string;
  kind: "user" | "assistant" | "tool-call" | "tool-result" | "other";
  turn: number | null;
  index: number | null;
  toolName?: string;
  surgery: {
    state: "active" | "applied" | "pending";
    action: string | null;
    tokens: number | null;
  };
};

type SkeletonResponse = {
  summary: {
    statusLine: string;
  };
  items: SkeletonRow[];
};

function looksLikeSyntheticToolId(id: string): boolean {
  return /^\d+\.\d+$/.test(id);
}

function stripCommandIdDecorators(raw: string): string {
  return raw.replace(/^\[?\s*/, "").replace(/\s*\]?$/, "").trim();
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

type EvictSelectorFlag =
  | "--turn"
  | "--user"
  | "--assistant"
  | "--tool-result"
  | "--tool-call";

const EVICT_SELECTOR_FLAGS = new Set<string>([
  "--turn",
  "--user",
  "--assistant",
  "--tool-result",
  "--tool-call",
]);

const EVICT_OPTION_FLAGS = new Set<string>([
  "--media",
  "--occurrences",
]);

function isEvictSelectorFlag(value: string): value is EvictSelectorFlag {
  return EVICT_SELECTOR_FLAGS.has(value);
}

function assertPositiveInteger(value: number, raw: string): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`Invalid selector value: ${raw}`);
  }
}

function parseTurnValues(raw: string): number[] {
  const rangeMatch = /^(\d+)\.\.(\d+)$/.exec(raw);
  if (rangeMatch) {
    const start = Number(rangeMatch[1]);
    const end = Number(rangeMatch[2]);
    assertPositiveInteger(start, raw);
    assertPositiveInteger(end, raw);
    if (end < start) {
      throw new Error(`Invalid descending range: ${raw}`);
    }
    const values: number[] = [];
    for (let value = start; value <= end; value++) {
      values.push(value);
    }
    return values;
  }

  const turnNumber = Number(raw);
  assertPositiveInteger(turnNumber, raw);
  return [turnNumber];
}

function parseDottedRef(raw: string): { turn: number; index: number } | null {
  const match = /^(\d+)\.(\d+)$/.exec(raw);
  if (!match) {
    return null;
  }

  const turn = Number(match[1]);
  const index = Number(match[2]);
  assertPositiveInteger(turn, raw);
  assertPositiveInteger(index, raw);
  return { turn, index };
}

function splitSelectorValues(values: string[]): string[] {
  return values.flatMap((value) =>
    value
      .split(",")
      .map((part) => part.trim())
      .filter(Boolean)
  );
}

function expandSelector(flag: EvictSelectorFlag, raw: string): string[] {
  const dottedRef = parseDottedRef(raw);
  if (dottedRef) {
    if (flag === "--assistant") {
      return [`assistant message ${dottedRef.turn}.${dottedRef.index}`];
    }
    if (flag === "--tool-result") {
      return [`tool result ${dottedRef.turn}.${dottedRef.index}`];
    }
    if (flag === "--tool-call") {
      return [`tool call ${dottedRef.turn}.${dottedRef.index}`];
    }
    throw new Error(`${flag} expects whole-turn values like 3 or 3..7, not ${raw}`);
  }

  const turns = parseTurnValues(raw);
  return turns.map((turn) => {
    switch (flag) {
      case "--turn":
        return `turn ${turn}`;
      case "--user":
        return `user message ${turn}`;
      case "--assistant":
        return `assistant message ${turn}`;
      case "--tool-result":
        return `tool result ${turn}`;
      case "--tool-call":
        return `tool call ${turn}`;
    }
  });
}

function uniquePreservingOrder(values: string[]): string[] {
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const value of values) {
    if (seen.has(value)) {
      continue;
    }
    seen.add(value);
    unique.push(value);
  }
  return unique;
}

export function parseEvictTargetIds(args: string[]): string[] {
  const targets: string[] = [];
  const positionalParts: string[] = [];

  for (let i = 1; i < args.length; i++) {
    const arg = args[i];

    if (isEvictSelectorFlag(arg)) {
      const rawValues: string[] = [];
      i += 1;
      while (i < args.length && !args[i].startsWith("--")) {
        rawValues.push(args[i]);
        i += 1;
      }
      i -= 1;

      const values = splitSelectorValues(rawValues);
      if (values.length === 0) {
        throw new Error(`Missing value for ${arg}`);
      }
      for (const value of values) {
        targets.push(...expandSelector(arg, value));
      }
      continue;
    }

    if (EVICT_OPTION_FLAGS.has(arg)) {
      i += 1;
      continue;
    }

    if (arg === "--dry-run") {
      continue;
    }

    if (arg.startsWith("--")) {
      throw new Error(`Unknown evict flag: ${arg}`);
    }

    positionalParts.push(arg);
  }

  if (targets.length > 0) {
    if (positionalParts.length > 0) {
      throw new Error("Do not mix selector flags with a positional id");
    }
    return uniquePreservingOrder(targets);
  }

  const id = normalizeCommandId(
    "evict",
    stripCommandIdDecorators(positionalParts.join(" "))
  );
  return id ? [id] : [];
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
  if (directive.tokens === null) {
    return directive.state === "pending" ? "pending" : "unknown";
  }
  return `${directive.tokens.toLocaleString()} tokens`;
}

export function formatStatusOutput(result: StatusResponse): string {
  const lines = [result.summary.statusLine];

  if (result.summary.conversation) {
    lines.push(
      `Conversation: "${result.summary.conversation.preview}" (${result.summary.conversation.itemCount} items)`
    );
  }

  lines.push("", "Directives (persisted):");

  if (result.activeDirectives.length === 0) {
    lines.push("none");
    return lines.join("\n");
  }

  for (const directive of result.activeDirectives) {
    lines.push(
      `${directive.id} | ${directive.action} | ${formatDirectiveTokens(
        directive
      )} | ${directive.state}`
    );
  }

  const inactive = result.activeDirectives.filter(
    (directive) => directive.state === "inactive"
  ).length;
  if (inactive > 0) {
    lines.push(
      "",
      `${inactive} directive(s) are 'inactive': their content is not part of the` +
        " current conversation (other session, or history changed). They are" +
        " harmless and will be garbage-collected after 30 days."
    );
  }

  return lines.join("\n");
}

function baseItemToken(item: SkeletonRow): string {
  const turn = item.turn ?? "?";
  const index = item.index ?? "?";

  switch (item.kind) {
    case "user":
      return `u${turn}`;
    case "assistant":
      return `a${turn}.${index}`;
    case "tool-call":
    case "tool-result":
      return `t${turn}.${index}`;
    case "other":
      return item.id;
  }
}

function actionTag(item: SkeletonRow): string {
  if (item.surgery.state === "active" || !item.surgery.action) {
    return "";
  }

  const suffix = item.surgery.state === "pending" ? " pending" : "";
  if (item.surgery.action === "replace") {
    return `[replaced${suffix}]`;
  }
  if (item.surgery.action.startsWith("evict ")) {
    return `[${item.surgery.action.replace(/^evict /, "")} evicted${suffix}]`;
  }
  return `[evicted${suffix}]`;
}

function toolPairTag(call: SkeletonRow, result?: SkeletonRow): string {
  const parts: string[] = [];
  const callTag = actionTag(call);
  const resultTag = result ? actionTag(result) : "";

  if (callTag) {
    parts.push(`call ${callTag.slice(1, -1)}`);
  }
  if (resultTag) {
    parts.push(`result ${resultTag.slice(1, -1)}`);
  }

  return parts.length > 0 ? `[${parts.join(", ")}]` : "";
}

type SkeletonToken = {
  text: string;
  kind: "tool" | "other";
  turn: number | null;
  startIndex: number | null;
  endIndex: number | null;
  tag: string;
};

function makeToolToken(call: SkeletonRow, result?: SkeletonRow): SkeletonToken {
  const tag = toolPairTag(call, result);
  const toolName = call.toolName ? ` ${call.toolName}` : "";
  return {
    text: `${baseItemToken(call)}${toolName}${tag}`,
    kind: "tool",
    turn: call.turn,
    startIndex: call.index,
    endIndex: call.index,
    tag,
  };
}

function compressSkeletonTokens(tokens: SkeletonToken[]): string[] {
  const groups: SkeletonToken[] = [];
  for (const token of tokens) {
    const last = groups[groups.length - 1];
    if (
      last &&
      last.kind === "tool" &&
      token.kind === "tool" &&
      last.turn === token.turn &&
      last.tag === token.tag &&
      last.startIndex !== null &&
      last.endIndex !== null &&
      token.startIndex !== null &&
      token.startIndex === last.endIndex + 1
    ) {
      last.endIndex = token.startIndex;
      last.text = `t${last.turn}.${last.startIndex}-${last.endIndex}${last.tag}`;
      continue;
    }
    groups.push({ ...token });
  }

  return groups.map((token) => token.text);
}

function turnLabel(item: SkeletonRow): string {
  return item.turn === null ? "?" : String(item.turn);
}

export function formatSkeletonOutput(result: SkeletonResponse): string {
  const lines = [
    result.summary.statusLine,
    "",
    "Legend: u=user, a=assistant, t=tool call/result pair",
  ];

  if (result.items.length === 0) {
    lines.push("", "No parsed context skeleton yet. Send one model request first.");
    return lines.join("\n");
  }

  const resultsByPairId = new Map<string, SkeletonRow>();
  for (const item of result.items) {
    if (item.kind === "tool-result" && item.turn !== null && item.index !== null) {
      resultsByPairId.set(`${item.turn}.${item.index}`, item);
    }
  }

  const printedResults = new Set<string>();
  const turns = new Map<string, SkeletonToken[]>();

  for (const item of result.items) {
    const label = turnLabel(item);
    const tokens = turns.get(label) ?? [];

    if (item.kind === "tool-call" && item.turn !== null && item.index !== null) {
      const pairId = `${item.turn}.${item.index}`;
      const resultRow = resultsByPairId.get(pairId);
      if (resultRow) {
        printedResults.add(resultRow.id);
      }
      tokens.push(makeToolToken(item, resultRow));
    } else if (item.kind === "tool-result") {
      if (!printedResults.has(item.id)) {
        tokens.push({
          text: `${baseItemToken(item)} result${actionTag(item)}`,
          kind: "other",
          turn: item.turn,
          startIndex: item.index,
          endIndex: item.index,
          tag: actionTag(item),
        });
      }
    } else {
      tokens.push({
        text: `${baseItemToken(item)}${actionTag(item)}`,
        kind: "other",
        turn: item.turn,
        startIndex: item.index,
        endIndex: item.index,
        tag: actionTag(item),
      });
    }

    turns.set(label, tokens);
  }

  lines.push("");
  for (const [turn, tokens] of turns) {
    lines.push(`${turn}: ${compressSkeletonTokens(tokens).join(", ")}`);
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
    return stripCommandIdDecorators(raw);
  }

  switch (command) {
    case "evict": {
      let ids: string[];
      try {
        ids = parseEvictTargetIds(args);
      } catch (error) {
        console.error(error instanceof Error ? `Error: ${error.message}` : error);
        process.exit(1);
      }
      const mediaType = parseMediaType(args);
      const occurrences = parseOccurrences(args);
      if (ids.length === 0) {
        console.error(
          "Usage: context-surgeon evict <id> [--media image|document] [--occurrences 1,3]\n" +
            "   or: context-surgeon evict --turn 2..5 --assistant 7.1,7.3 --tool-result 8,9.2"
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
      if (mediaType && ids.some((id) => isToolCallDirectiveKey(id))) {
        console.error("Error: media-only eviction is not supported for tool calls");
        process.exit(1);
      }

      if (args.includes("--dry-run")) {
        console.log(ids.join("\n"));
        break;
      }

      const result = (await post("/_control/evict", {
        ids,
        mediaType: mediaType ?? undefined,
        occurrences: occurrences ?? undefined,
      })) as { message?: string; resolvedCount?: number };
      console.log(result.message ?? "ok");
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
      const result = (await post("/_control/replace", { ids: [id], content })) as {
        message?: string;
      };
      console.log(result.message ?? "ok");
      break;
    }

    case "restore": {
      const id = normalizeCommandId(command, extractId(args, 1));
      if (!id) {
        console.error("Usage: context-surgeon restore <id>");
        process.exit(1);
      }
      const result = (await post("/_control/restore", { ids: [id] })) as {
        message?: string;
      };
      console.log(result.message ?? "ok");
      break;
    }

    case "status": {
      const result = await get("/_control/status");
      console.log(formatStatusOutput(result as StatusResponse));
      break;
    }

    case "skeleton": {
      const result = await get("/_control/skeleton");
      if (args.includes("--json")) {
        console.log(JSON.stringify(result, null, 2));
      } else {
        console.log(formatSkeletonOutput(result as SkeletonResponse));
      }
      break;
    }

    default:
      console.error(
        `Unknown command: ${command}\n\nAvailable commands:\n  evict <id> [--media image|document] [--occurrences 1,3]\n  evict --turn 2..5 --assistant 7.1,7.3 --tool-result 8,9.2\n  replace <id> --content "summary"\n  restore <id>\n  status\n  skeleton [--json]`
      );
      process.exit(1);
  }
}
