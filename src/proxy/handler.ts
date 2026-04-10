import zlib from "node:zlib";
import { promisify } from "node:util";
import type {
  ContextItem,
  ContextObject,
  Directive,
  FormatAdapter,
} from "../context/types.js";
import type { DirectiveStore } from "../store/directive-store.js";
import type { ShadowStore } from "../store/shadow-store.js";
import { assignIds } from "../context/id-assigner.js";
import {
  injectIds,
  injectStatusLine,
  prependTextToFirstUserMessage,
} from "../context/injector.js";
import { applyDirectives } from "../context/transformer.js";
import {
  buildStatusSummary,
  computeTextCharStats,
  estimateTokensFromChars,
  type StatusSummary,
} from "../context/status.js";
import { AnthropicMessagesAdapter } from "../adapters/anthropic-messages.js";
import { OpenAIResponsesAdapter } from "../adapters/openai-responses.js";

/** Snapshot passed to optional hooks (e.g. tests). */
export type DebugSnapshotInput = {
  timestamp: string;
  path: string;
  format: "openai-responses" | "anthropic-messages";
  upstreamUrl: string;
  systemPrompt: string;
  items: ContextItem[];
  directives: Record<string, string>;
  shadowEntries: Record<string, number | null>;
  totalEvictedTokens: number;
  statusSummary: StatusSummary;
  rawRequest: Record<string, unknown>;
};

export type HandlerConfig = {
  directiveStore: DirectiveStore;
  shadowStore: ShadowStore;
  skillMarkdown: string;
  maxTokens: number;
  upstreamOpenAI: string;
  upstreamAnthropic: string;
  upstreamChatGPT: string;
  getLatestExactPromptTokens: () => number | null;
  getPreviousSkeleton: () => string[] | null;
  setPreviousSkeleton: (skeleton: string[]) => void;
  onDebugSnapshot?: (snapshot: DebugSnapshotInput) => void;
};

type TransformResult = {
  body: Buffer;
  upstreamUrl: string;
  headers: Record<string, string>;
  format: SupportedFormat;
  statusSummary: StatusSummary;
};

type SupportedFormat = "openai-responses" | "anthropic-messages";

const openaiAdapter = new OpenAIResponsesAdapter();
const anthropicAdapter = new AnthropicMessagesAdapter();
const SKILL_SIGNATURE = "genuin-joging-awkwerd-febuary";

type HistoryTransition = "append" | "truncate" | "rewrite";

function detectFormat(path: string): SupportedFormat | null {
  if (path.startsWith("/v1/responses")) return "openai-responses";
  if (path.includes("/codex/responses")) return "openai-responses"; // ChatGPT backend uses same format
  if (path.startsWith("/anthropic/v1/messages")) return "anthropic-messages";
  if (path.startsWith("/v1/messages")) return "anthropic-messages"; // legacy root path
  return null;
}

function getAdapter(format: SupportedFormat): FormatAdapter {
  if (format === "openai-responses") return openaiAdapter;
  return anthropicAdapter;
}

function stripAnthropicProxyPrefix(path: string): string {
  return path.startsWith("/anthropic") ? path.replace(/^\/anthropic/, "") || "/" : path;
}

function getUpstreamUrl(
  format: SupportedFormat,
  path: string,
  config: HandlerConfig
): string {
  // ChatGPT backend paths: /backend-api/codex/responses
  if (path.includes("/codex/responses")) {
    const base = config.upstreamChatGPT.replace(/\/+$/, "");
    // path is like /backend-api/codex/responses — strip the /backend-api prefix
    const pathSuffix = path.replace(/^\/backend-api/, "");
    return base + pathSuffix;
  }
  if (format === "openai-responses") {
    const base = config.upstreamOpenAI.replace(/\/+$/, "");
    const pathSuffix = path.replace(/^\/v1/, "");
    return base + pathSuffix;
  }
  if (format === "anthropic-messages") {
    const base = config.upstreamAnthropic.replace(/\/+$/, "");
    return base + stripAnthropicProxyPrefix(path);
  }
  throw new Error(`Unknown format: ${format}`);
}

function canTransformRequest(
  json: Record<string, unknown>,
  format: SupportedFormat
): boolean {
  if (format === "openai-responses") {
    return Array.isArray(json.input);
  }
  return Array.isArray(json.messages);
}

async function decompressBody(
  rawBody: Buffer,
  contentEncoding: string | undefined
): Promise<Buffer> {
  if (!contentEncoding) return rawBody;

  const encoding = contentEncoding.toLowerCase().trim();
  if (encoding === "zstd") {
    // Node 22+ has zstd support in zlib behind experimental flag
    // Try native first, fall back to raw passthrough
    try {
      if (typeof zlib.zstdDecompress === "function") {
        const decompress = promisify(zlib.zstdDecompress);
        return await decompress(rawBody);
      }
    } catch {
      // fall through
    }
    // Can't decompress — return raw and let it fail at JSON.parse
    // which will trigger the passthrough path
    return rawBody;
  }

  if (encoding === "gzip") {
    return await promisify(zlib.gunzip)(rawBody);
  }

  if (encoding === "deflate") {
    return await promisify(zlib.inflate)(rawBody);
  }

  return rawBody;
}

function buildUpstreamHeaders(
  incomingHeaders: Record<string, string>,
  outputBody: Buffer
): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const [key, value] of Object.entries(incomingHeaders)) {
    if (key === "content-length") continue;
    if (key === "content-encoding") continue; // we decoded it
    if (key === "accept-encoding") continue; // ask upstream for plain text so usage parsing can read SSE/JSON directly
    if (key === "host") continue;
    headers[key] = value;
  }
  headers["content-length"] = String(outputBody.length);
  headers["content-type"] = "application/json";
  return headers;
}

function snapshotDirectives(
  directiveStore: DirectiveStore
): Record<string, string> {
  const directives: Record<string, string> = {};
  for (const [id, directive] of directiveStore.getAll()) {
    directives[id] = describeDirective(directive);
  }
  return directives;
}

function describeDirective(directive: Directive): string {
  if (directive.type === "replace") {
    return `replace: ${directive.content}`;
  }

  if (!directive.mediaType) {
    return "evict";
  }

  const occurrences =
    directive.occurrences && directive.occurrences.length > 0
      ? ` (${directive.occurrences.join(",")})`
      : "";

  return `evict ${directive.mediaType}${occurrences}`;
}

function snapshotShadows(shadowStore: ShadowStore): Record<string, number | null> {
  const shadows: Record<string, number | null> = {};
  for (const [id, entry] of shadowStore.getAll()) {
    shadows[id] = entry.tokenEstimate;
  }
  return shadows;
}

function buildSkeleton(items: ContextItem[]): string[] {
  return items.map((item) => {
    switch (item.kind) {
      case "user-message":
        return "u";
      case "assistant-message":
        return "a";
      case "tool-call":
        return "tc";
      case "tool-result":
        return "tr";
      case "other":
        return "o";
    }
  });
}

function startsWithSkeleton(full: string[], prefix: string[]): boolean {
  if (prefix.length > full.length) {
    return false;
  }

  for (let i = 0; i < prefix.length; i++) {
    if (full[i] !== prefix[i]) {
      return false;
    }
  }

  return true;
}

function classifyHistoryTransition(
  previousSkeleton: string[] | null,
  nextSkeleton: string[]
): HistoryTransition {
  if (!previousSkeleton || previousSkeleton.length === 0) {
    return "append";
  }

  if (startsWithSkeleton(nextSkeleton, previousSkeleton)) {
    return "append";
  }

  if (startsWithSkeleton(previousSkeleton, nextSkeleton)) {
    return "truncate";
  }

  return "rewrite";
}

function pruneMissingDirectiveState(
  currentIds: Set<string>,
  directiveStore: DirectiveStore,
  shadowStore: ShadowStore
): void {
  for (const [id] of directiveStore.getAll()) {
    if (!currentIds.has(id)) {
      directiveStore.delete(id);
      shadowStore.delete(id);
    }
  }

  for (const [id] of shadowStore.getAll()) {
    if (!currentIds.has(id)) {
      shadowStore.delete(id);
    }
  }
}

function contextHasSkillSignature(ctx: ContextObject): boolean {
  if (ctx.systemPrompt.includes(SKILL_SIGNATURE)) {
    return true;
  }

  for (const item of ctx.items) {
    if (item.kind === "user-message" || item.kind === "assistant-message") {
      for (const block of item.content) {
        if (block.type === "text" && block.text.includes(SKILL_SIGNATURE)) {
          return true;
        }
      }
      continue;
    }

    if (item.kind === "tool-result") {
      if (typeof item.output === "string") {
        if (item.output.includes(SKILL_SIGNATURE)) {
          return true;
        }
      } else {
        for (const block of item.output) {
          if (block.type === "text" && block.text.includes(SKILL_SIGNATURE)) {
            return true;
          }
        }
      }
    }
  }

  return false;
}

export async function transformRequest(
  path: string,
  rawBody: Buffer,
  incomingHeaders: Record<string, string>,
  config: HandlerConfig
): Promise<TransformResult | null> {
  const format = detectFormat(path);
  if (!format) return null;

  // Try to decompress if needed
  let bodyBuf: Buffer;
  try {
    bodyBuf = await decompressBody(rawBody, incomingHeaders["content-encoding"]);
  } catch {
    return null; // will fall through to raw forward
  }

  // Try to parse JSON
  let json: Record<string, unknown>;
  try {
    json = JSON.parse(bodyBuf.toString("utf-8")) as Record<string, unknown>;
  } catch {
    return null; // will fall through to raw forward
  }

  if (!canTransformRequest(json, format)) {
    return null;
  }

  const adapter = getAdapter(format);
  const ctx: ContextObject = adapter.parse(json);
  if (config.skillMarkdown.trim() && !contextHasSkillSignature(ctx)) {
    prependTextToFirstUserMessage(ctx, config.skillMarkdown.trim());
  }
  const previousSkeleton = config.getPreviousSkeleton();
  const nextSkeleton = buildSkeleton(ctx.items);
  const historyTransition = classifyHistoryTransition(previousSkeleton, nextSkeleton);
  config.setPreviousSkeleton(nextSkeleton);

  if (historyTransition === "rewrite") {
    config.directiveStore.clear();
    config.shadowStore.clear();
  }

  const latestExactPromptTokens = config.getLatestExactPromptTokens();

  // Pipeline:
  // 1. Assign IDs
  assignIds(ctx.items);

  const currentIds = new Set(ctx.items.map((item) => item.id));
  if (historyTransition === "truncate") {
    pruneMissingDirectiveState(currentIds, config.directiveStore, config.shadowStore);
  }

  const textCharStats = computeTextCharStats(ctx);
  const promptTokensForCurrentRequest =
    latestExactPromptTokens ?? estimateTokensFromChars(textCharStats.totalChars);

  // 2. Apply evict/replace directives
  applyDirectives(ctx, config.directiveStore, config.shadowStore, {
    textCharStats,
    latestExactPromptTokens: promptTokensForCurrentRequest,
  });

  // 3. Inject IDs into content text
  injectIds(ctx);

  // 4. Inject status line into last user message
  const injectedTextCharStats = computeTextCharStats(ctx);
  const statusSummary = buildStatusSummary(
    latestExactPromptTokens ?? estimateTokensFromChars(injectedTextCharStats.totalChars),
    config.shadowStore,
    config.maxTokens
  );
  injectStatusLine(ctx, statusSummary);

  // 5. The full skill is prepended to the first user message whenever its
  // signature is absent from the current transcript.

  // 6. Serialize back
  const outputJson = adapter.serialize(ctx);
  const outputBody = Buffer.from(JSON.stringify(outputJson), "utf-8");

  // Build upstream URL
  const upstreamUrl = getUpstreamUrl(format, path, config);

  config.onDebugSnapshot?.({
    timestamp: new Date().toISOString(),
    path,
    format,
    upstreamUrl,
    systemPrompt: ctx.systemPrompt,
    items: structuredClone(ctx.items),
    directives: snapshotDirectives(config.directiveStore),
    shadowEntries: snapshotShadows(config.shadowStore),
    totalEvictedTokens: config.shadowStore.totalEvictedTokens(),
    statusSummary,
    rawRequest: structuredClone(outputJson),
  });

  const headers = buildUpstreamHeaders(incomingHeaders, outputBody);

  return { body: outputBody, upstreamUrl, headers, format, statusSummary };
}
