import type { IncomingHttpHeaders } from "node:http";
import { StringDecoder } from "node:string_decoder";
import zlib from "node:zlib";
import {
  CACHE_USAGE_MERGE_VERSION,
  type FrozenJsonValue,
  type RawProviderUsageReceipt,
} from "../contracts/cache.js";
import { freezeJsonValue } from "../cache/canonical.js";

export type ProviderFormat =
  | "openai-responses"
  | "anthropic-messages"
  | "openai-chat-completions";

export type ProviderUsage = Readonly<Record<string, number | null>>;

export type UsageTap = {
  onChunk: (chunk: Buffer) => void;
  onEnd: () => void;
  onAborted: () => void;
  latestUsage: () => ProviderUsage | undefined;
  latestRawUsage: () => RawProviderUsageReceipt | undefined;
};

const MAX_USAGE_BYTES = 1024 * 1024;
const MAX_EVENT_CHARS = 512 * 1024;

function getHeader(headers: IncomingHttpHeaders, name: string): string {
  const value = headers[name];
  return Array.isArray(value) ? value.join(", ") : value ?? "";
}

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function rawUsageSubtree(payload: unknown, format: ProviderFormat): unknown {
  if (!payload || typeof payload !== "object") return undefined;
  const record = payload as Record<string, unknown>;
  if (format === "anthropic-messages") {
    const message =
      record.message && typeof record.message === "object"
        ? (record.message as Record<string, unknown>)
        : undefined;
    return message?.usage ?? record.usage;
  }
  const response =
    format === "openai-responses" &&
    record.response &&
    typeof record.response === "object"
      ? (record.response as Record<string, unknown>)
      : record;
  return response.usage;
}

function usageRecord(payload: unknown, format: ProviderFormat): ProviderUsage | undefined {
  if (!payload || typeof payload !== "object") return undefined;
  const record = payload as Record<string, unknown>;

  if (format === "anthropic-messages") {
    const message =
      record.message && typeof record.message === "object"
        ? (record.message as Record<string, unknown>)
        : record;
    const usage =
      message.usage && typeof message.usage === "object"
        ? (message.usage as Record<string, unknown>)
        : record.usage && typeof record.usage === "object"
          ? (record.usage as Record<string, unknown>)
          : undefined;
    if (!usage) return undefined;
    const creation =
      usage.cache_creation && typeof usage.cache_creation === "object"
        ? (usage.cache_creation as Record<string, unknown>)
        : undefined;
    return Object.freeze({
      ...(Object.hasOwn(usage, "input_tokens")
        ? { uncached_input_tokens: numberOrNull(usage.input_tokens) }
        : {}),
      ...(Object.hasOwn(usage, "cache_creation_input_tokens")
        ? { cache_creation_input_tokens: numberOrNull(usage.cache_creation_input_tokens) }
        : {}),
      ...(Object.hasOwn(usage, "cache_read_input_tokens")
        ? { cache_read_input_tokens: numberOrNull(usage.cache_read_input_tokens) }
        : {}),
      ...(creation && "ephemeral_5m_input_tokens" in creation
        ? {
            cache_creation_5m_input_tokens: numberOrNull(
              creation.ephemeral_5m_input_tokens
            ),
          }
        : {}),
      ...(creation && "ephemeral_1h_input_tokens" in creation
        ? {
            cache_creation_1h_input_tokens: numberOrNull(
              creation.ephemeral_1h_input_tokens
            ),
          }
        : {}),
      ...(Object.hasOwn(usage, "output_tokens")
        ? { output_tokens: numberOrNull(usage.output_tokens) }
        : {}),
    });
  }

  const response =
    format === "openai-responses" &&
    record.response &&
    typeof record.response === "object"
      ? (record.response as Record<string, unknown>)
      : record;
  const usage =
    response.usage && typeof response.usage === "object"
      ? (response.usage as Record<string, unknown>)
      : undefined;
  if (!usage) return undefined;

  if (format === "openai-chat-completions") {
    const details =
      usage.prompt_tokens_details && typeof usage.prompt_tokens_details === "object"
        ? (usage.prompt_tokens_details as Record<string, unknown>)
        : undefined;
    return Object.freeze({
      ...(Object.hasOwn(usage, "prompt_tokens")
        ? { prompt_tokens: numberOrNull(usage.prompt_tokens) }
        : {}),
      ...(Object.hasOwn(usage, "completion_tokens")
        ? { completion_tokens: numberOrNull(usage.completion_tokens) }
        : {}),
      ...(Object.hasOwn(usage, "total_tokens")
        ? { total_tokens: numberOrNull(usage.total_tokens) }
        : {}),
      ...(details && "cached_tokens" in details
        ? { cached_input_tokens: numberOrNull(details.cached_tokens) }
        : {}),
      ...(details && "cache_write_tokens" in details
        ? { cache_write_input_tokens: numberOrNull(details.cache_write_tokens) }
        : Object.hasOwn(usage, "cache_write_tokens")
          ? { cache_write_input_tokens: numberOrNull(usage.cache_write_tokens) }
        : {}),
    });
  }

  const details =
    usage.input_tokens_details && typeof usage.input_tokens_details === "object"
      ? (usage.input_tokens_details as Record<string, unknown>)
      : undefined;
  return Object.freeze({
    ...(Object.hasOwn(usage, "input_tokens")
      ? { input_tokens: numberOrNull(usage.input_tokens) }
      : {}),
    ...(details && Object.hasOwn(details, "cached_tokens")
      ? { cached_input_tokens: numberOrNull(details.cached_tokens) }
      : {}),
    ...(details && "cache_write_tokens" in details
      ? { cache_write_input_tokens: numberOrNull(details.cache_write_tokens) }
      : Object.hasOwn(usage, "cache_write_tokens")
        ? { cache_write_input_tokens: numberOrNull(usage.cache_write_tokens) }
      : {}),
    ...(Object.hasOwn(usage, "output_tokens")
      ? { output_tokens: numberOrNull(usage.output_tokens) }
      : {}),
    ...(Object.hasOwn(usage, "total_tokens")
      ? { total_tokens: numberOrNull(usage.total_tokens) }
      : {}),
  });
}

function promptTokens(format: ProviderFormat, usage: ProviderUsage): number | null {
  if (format === "openai-responses") return usage.input_tokens ?? null;
  if (format === "openai-chat-completions") return usage.prompt_tokens ?? null;
  const input = usage.uncached_input_tokens;
  if (input === null || input === undefined) return null;
  return (
    input +
    (usage.cache_creation_input_tokens ?? 0) +
    (usage.cache_read_input_tokens ?? 0)
  );
}

function createCollector(
  format: ProviderFormat,
  onPromptTokens?: (tokens: number) => void,
  onUsage?: (usage: ProviderUsage) => void
) {
  let latest: ProviderUsage | undefined;
  const rawEvents: FrozenJsonValue[] = [];
  let rawState: RawProviderUsageReceipt["state"] = "partial";

  const mergeRaw = (left: FrozenJsonValue, right: FrozenJsonValue): FrozenJsonValue => {
    if (
      left !== null &&
      right !== null &&
      typeof left === "object" &&
      typeof right === "object" &&
      !Array.isArray(left) &&
      !Array.isArray(right)
    ) {
      const merged: Record<string, FrozenJsonValue> = {
        ...(left as { readonly [key: string]: FrozenJsonValue }),
      };
      for (const [key, value] of Object.entries(right)) {
        merged[key] = key in merged ? mergeRaw(merged[key], value) : value;
      }
      return freezeJsonValue(merged);
    }
    return right;
  };

  const rawReceipt = (): RawProviderUsageReceipt | undefined => {
    if (rawEvents.length === 0) return undefined;
    const merged = rawEvents.slice(1).reduce(mergeRaw, rawEvents[0]);
    return Object.freeze({
      mergeVersion: CACHE_USAGE_MERGE_VERSION,
      state: rawState,
      events: Object.freeze(
        rawEvents.map((raw, sequence) => Object.freeze({ sequence, raw }))
      ),
      merged,
    });
  };
  return {
    accept(payload: unknown) {
      const raw = rawUsageSubtree(payload, format);
      if (raw !== undefined) rawEvents.push(freezeJsonValue(raw));
      const usage = usageRecord(payload, format);
      if (!usage) return;
      latest = Object.freeze({ ...latest, ...usage });
      onUsage?.(latest);
      const prompt = promptTokens(format, latest);
      if (prompt !== null) onPromptTokens?.(prompt);
    },
    latestUsage() {
      return latest;
    },
    finalize(state: RawProviderUsageReceipt["state"]) {
      rawState = state;
    },
    latestRawUsage: rawReceipt,
  };
}

function createSseTap(
  format: ProviderFormat,
  onPromptTokens?: (tokens: number) => void,
  onUsage?: (usage: ProviderUsage) => void
): UsageTap {
  const decoder = new StringDecoder("utf8");
  const collector = createCollector(format, onPromptTokens, onUsage);
  let buffer = "";
  let bytes = 0;
  let disabled = false;

  function processEvent(block: string): void {
    const dataLines = block
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).replace(/^ /, ""));
    if (dataLines.length === 0) return;
    const data = dataLines.join("\n");
    if (!data || data === "[DONE]") return;
    try {
      collector.accept(JSON.parse(data) as unknown);
    } catch {
      // Usage is optional; malformed provider events never contaminate an attempt.
    }
  }

  function drain(final: boolean): void {
    let match: RegExpExecArray | null;
    const boundary = /\r?\n\r?\n/g;
    let consumed = 0;
    while ((match = boundary.exec(buffer)) !== null) {
      processEvent(buffer.slice(consumed, match.index));
      consumed = match.index + match[0].length;
    }
    if (consumed > 0) buffer = buffer.slice(consumed);
    if (final && buffer.trim()) {
      processEvent(buffer);
      buffer = "";
    }
    if (buffer.length > MAX_EVENT_CHARS) {
      buffer = "";
      disabled = true;
    }
  }

  function finish(finalEvent: boolean): void {
    if (disabled) return;
    buffer += decoder.end();
    drain(finalEvent);
  }

  return {
    onChunk(chunk) {
      if (disabled) return;
      bytes += chunk.length;
      if (bytes > MAX_USAGE_BYTES) {
        disabled = true;
        buffer = "";
        return;
      }
      buffer += decoder.write(chunk);
      drain(false);
    },
    onEnd() {
      finish(true);
      collector.finalize("complete");
    },
    onAborted() {
      // Preserve already complete events. A final parse succeeds only if the
      // unterminated event happened to be complete before the abort.
      finish(true);
      collector.finalize("partial");
    },
    latestUsage: collector.latestUsage,
    latestRawUsage: collector.latestRawUsage,
  };
}

function createJsonTap(
  format: ProviderFormat,
  onPromptTokens?: (tokens: number) => void,
  onUsage?: (usage: ProviderUsage) => void
): UsageTap {
  const decoder = new StringDecoder("utf8");
  const collector = createCollector(format, onPromptTokens, onUsage);
  let body = "";
  let bytes = 0;
  let disabled = false;

  function finish(state: RawProviderUsageReceipt["state"]): void {
    if (disabled) return;
    body += decoder.end();
    try {
      collector.accept(JSON.parse(body) as unknown);
    } catch {
      // Missing or malformed usage is represented by no usage on the attempt.
    }
    collector.finalize(state);
    body = "";
  }

  return {
    onChunk(chunk) {
      if (disabled) return;
      bytes += chunk.length;
      if (bytes > MAX_USAGE_BYTES) {
        disabled = true;
        body = "";
        return;
      }
      body += decoder.write(chunk);
    },
    onEnd: () => finish("complete"),
    onAborted: () => finish("partial"),
    latestUsage: collector.latestUsage,
    latestRawUsage: collector.latestRawUsage,
  };
}

function decompress(bytes: Buffer, encoding: string): Buffer {
  if (encoding === "gzip") {
    return zlib.gunzipSync(bytes, { maxOutputLength: MAX_USAGE_BYTES });
  }
  if (encoding === "deflate") {
    return zlib.inflateSync(bytes, { maxOutputLength: MAX_USAGE_BYTES });
  }
  if (encoding === "br") {
    return zlib.brotliDecompressSync(bytes, { maxOutputLength: MAX_USAGE_BYTES });
  }
  return bytes;
}

function compressedTap(inner: UsageTap, encoding: string): UsageTap {
  const chunks: Buffer[] = [];
  let bytes = 0;
  let disabled = false;
  function finish(aborted: boolean): void {
    if (disabled) return;
    try {
      inner.onChunk(decompress(Buffer.concat(chunks), encoding));
      if (aborted) inner.onAborted();
      else inner.onEnd();
    } catch {
      // Truncated or oversized compressed streams have no trustworthy usage.
    }
  }
  return {
    onChunk(chunk) {
      if (disabled) return;
      bytes += chunk.length;
      if (bytes > MAX_USAGE_BYTES) {
        disabled = true;
        chunks.length = 0;
        return;
      }
      chunks.push(Buffer.from(chunk));
    },
    onEnd() {
      finish(false);
    },
    onAborted() {
      finish(true);
    },
    latestUsage: inner.latestUsage,
    latestRawUsage: inner.latestRawUsage,
  };
}

export function createUsageTap(
  format: ProviderFormat,
  headers: IncomingHttpHeaders,
  onPromptTokens?: (tokens: number) => void,
  onUsage?: (usage: ProviderUsage) => void
): UsageTap | null {
  if (!onPromptTokens && !onUsage) return null;
  const contentType = getHeader(headers, "content-type").toLowerCase();
  const inner = contentType.includes("text/event-stream")
    ? createSseTap(format, onPromptTokens, onUsage)
    : contentType.includes("application/json")
      ? createJsonTap(format, onPromptTokens, onUsage)
      : null;
  if (!inner) return null;

  const encoding = getHeader(headers, "content-encoding").trim().toLowerCase();
  if (encoding === "gzip" || encoding === "deflate" || encoding === "br") {
    return compressedTap(inner, encoding);
  }
  return inner;
}

function promptTokensFromOpenAiPayload(payload: unknown): number | null {
  const usage = usageRecord(payload, "openai-responses");
  return usage?.input_tokens ?? null;
}

export const testOnly = {
  promptTokensFromOpenAiPayload,
  usageRecord,
};
