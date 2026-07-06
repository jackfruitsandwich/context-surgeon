import zlib from "node:zlib";
import { promisify } from "node:util";
import type {
  ContextObject,
  ContentBlock,
  FormatAdapter,
} from "../context/types.js";
import type { DirectiveStore } from "../store/directive-store.js";
import { assignIds } from "../context/id-assigner.js";
import { computeFingerprints } from "../context/fingerprint.js";
import {
  injectIds,
  injectStatusLine,
  prependTextToFirstUserMessage,
} from "../context/injector.js";
import { applyDirectives, type AppliedDirective } from "../context/transformer.js";
import {
  buildStatusSummary,
  computeTextCharStats,
  estimateTokensFromChars,
  type StatusSummary,
} from "../context/status.js";
import type { ConversationTracker } from "./conversations.js";
import { AnthropicMessagesAdapter } from "../adapters/anthropic-messages.js";
import { OpenAIResponsesAdapter } from "../adapters/openai-responses.js";
import { OpenAIChatCompletionsAdapter } from "../adapters/openai-chat-completions.js";

/** Snapshot passed to optional hooks (e.g. tests). */
export type DebugSnapshotInput = {
  timestamp: string;
  path: string;
  format: SupportedFormat;
  upstreamUrl: string;
  systemPrompt: string;
  items: ContextObject["items"];
  applied: AppliedDirective[];
  statusSummary: StatusSummary;
  rawRequest: Record<string, unknown>;
};

export type HandlerConfig = {
  directiveStore: DirectiveStore;
  tracker: ConversationTracker;
  skillMarkdown: string;
  maxTokens: number;
  upstreamOpenAI: string;
  upstreamAnthropic: string;
  upstreamChatGPT: string;
  onDebugSnapshot?: (snapshot: DebugSnapshotInput) => void;
};

type TransformResult = {
  body: Buffer;
  upstreamUrl: string;
  headers: Record<string, string>;
  format: SupportedFormat;
  statusSummary: StatusSummary;
  rootFingerprint: string | null;
  translateResponse?: "responses-to-chat";
};

type SupportedFormat =
  | "openai-responses"
  | "anthropic-messages"
  | "openai-chat-completions";

const openaiAdapter = new OpenAIResponsesAdapter();
const anthropicAdapter = new AnthropicMessagesAdapter();
const chatCompletionsAdapter = new OpenAIChatCompletionsAdapter();
const SKILL_SIGNATURE = "genuin-joging-awkwerd-febuary";

type ZlibWithOptionalZstd = typeof zlib & {
  zstdDecompress?: (
    buffer: Buffer,
    callback: (error: Error | null, result: Buffer) => void
  ) => void;
};

function detectFormat(path: string): SupportedFormat | null {
  if (path.startsWith("/v1/responses")) return "openai-responses";
  if (path.includes("/codex/responses")) return "openai-responses"; // ChatGPT backend uses same format
  if (path.startsWith("/anthropic/v1/messages")) return "anthropic-messages";
  if (path.startsWith("/v1/messages")) return "anthropic-messages"; // legacy root path
  if (path.startsWith("/v1/chat/completions")) return "openai-chat-completions"; // Cursor BYOK base URL override
  if (path.startsWith("/chat/completions")) return "openai-chat-completions"; // base URL entered without /v1
  return null;
}

function getAdapter(format: SupportedFormat): FormatAdapter {
  if (format === "openai-responses") return openaiAdapter;
  if (format === "openai-chat-completions") return chatCompletionsAdapter;
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
  if (format === "openai-responses" || format === "openai-chat-completions") {
    const base = config.upstreamOpenAI.replace(/\/+$/, "");
    const pathSuffix = path.startsWith("/v1") ? path.replace(/^\/v1/, "") : path;
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
  return Array.isArray(json.messages); // anthropic-messages and openai-chat-completions
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
      const zstdDecompress = (zlib as ZlibWithOptionalZstd).zstdDecompress;
      if (typeof zstdDecompress === "function") {
        const decompress = promisify(zstdDecompress);
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
  let format = detectFormat(path);
  if (!format) return null;
  let effectivePath = path;
  let translateResponse: "responses-to-chat" | undefined;

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

  // Cursor BYOK sends Responses-format bodies ("input", no "messages") to the
  // chat completions path for newer GPT models. Trust the body shape over the
  // path and reroute to the Responses endpoint.
  if (
    format === "openai-chat-completions" &&
    !Array.isArray(json.messages) &&
    Array.isArray(json.input)
  ) {
    format = "openai-responses";
    effectivePath = "/v1/responses";
    // Cursor parses only chat-completions SSE, so the Responses stream must
    // be translated back on the way out.
    translateResponse = "responses-to-chat";

    // Translate chat-completions-only params the Responses endpoint rejects.
    delete json.stream_options; // Responses streams always include usage
    delete json.logit_bias;
    delete json.presence_penalty;
    delete json.frequency_penalty;
    delete json.n;
    if (json.max_tokens !== undefined && json.max_output_tokens === undefined) {
      json.max_output_tokens = json.max_tokens;
    }
    delete json.max_tokens;
  }

  if (!canTransformRequest(json, format)) {
    return null;
  }

  const adapter = getAdapter(format);
  const ctx: ContextObject = adapter.parse(json);

  // Fingerprints and the resolution snapshot are computed on the pristine
  // incoming content, before any injection, so they are stable across
  // requests, resumes, and forks (and previews stay readable).
  computeFingerprints(ctx.items);
  assignIds(ctx.items);
  const rootFingerprint = config.tracker.record(ctx.items);
  const snapshot = rootFingerprint ? config.tracker.get(rootFingerprint) : undefined;

  if (config.skillMarkdown.trim() && !contextHasSkillSignature(ctx)) {
    prependTextToFirstUserMessage(ctx, config.skillMarkdown.trim());
  }

  const textCharStats = computeTextCharStats(ctx);
  const promptTokensForCurrentRequest =
    snapshot?.promptTokens ?? estimateTokensFromChars(textCharStats.totalChars);

  // 2. Apply evict/replace directives — pure fingerprint match, no
  //    conversation identity involved. Foreign traffic matches nothing.
  const applied = applyDirectives(ctx, config.directiveStore, {
    textCharStats,
    latestExactPromptTokens: promptTokensForCurrentRequest,
  });
  for (const entry of applied) {
    config.directiveStore.noteMatched(
      entry.fingerprint,
      entry.itemId,
      entry.tokenEstimate
    );
  }
  if (rootFingerprint) {
    config.tracker.noteApplied(
      rootFingerprint,
      applied.map((entry) => entry.fingerprint)
    );
  }

  // 3. Inject IDs into content text
  injectIds(ctx);

  // 4. Inject status line into last user message
  const injectedTextCharStats = computeTextCharStats(ctx);
  const statusSummary = buildStatusSummary(
    snapshot?.promptTokens ?? estimateTokensFromChars(injectedTextCharStats.totalChars),
    applied.length,
    applied.reduce((sum, entry) => sum + (entry.tokenEstimate ?? 0), 0),
    config.maxTokens
  );
  injectStatusLine(ctx, statusSummary);

  // 5. The full skill is prepended to the first user message whenever its
  // signature is absent from the current transcript.

  // 6. Serialize back
  const outputJson = adapter.serialize(ctx);
  const outputBody = Buffer.from(JSON.stringify(outputJson), "utf-8");

  // Build upstream URL
  const upstreamUrl = getUpstreamUrl(format, effectivePath, config);

  config.onDebugSnapshot?.({
    timestamp: new Date().toISOString(),
    path,
    format,
    upstreamUrl,
    systemPrompt: ctx.systemPrompt,
    items: structuredClone(ctx.items),
    applied,
    statusSummary,
    rawRequest: structuredClone(outputJson),
  });

  const headers = buildUpstreamHeaders(incomingHeaders, outputBody);

  return {
    body: outputBody,
    upstreamUrl,
    headers,
    format,
    statusSummary,
    rootFingerprint,
    translateResponse,
  };
}
