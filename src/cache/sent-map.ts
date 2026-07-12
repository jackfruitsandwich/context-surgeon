import type { Occurrence } from "../contracts/state.js";
import {
  CACHE_CANONICALIZATION_VERSION,
  CACHE_TRUTH_SCHEMA_VERSION,
  type CompiledCacheBreakpoint,
  type CompiledSentMap,
  type CompiledSentSegment,
  type SentMapDivergencePreview,
  type SentSegmentKind,
} from "../contracts/cache.js";
import type { ProviderKind } from "../contracts/truth.js";
import { isRecord, type JsonPath, type JsonRecord } from "../providers/shared.js";
import { canonicalizeSentValue, hmacSentDigest } from "./canonical.js";

type RawSegment = Readonly<{
  path: JsonPath;
  kind: SentSegmentKind;
  role?: string;
  value: unknown;
}>;

function segmentKind(value: unknown, fallback: SentSegmentKind): SentSegmentKind {
  if (!isRecord(value)) return fallback;
  const type = String(value.type ?? "");
  if (type.includes("image")) return "image";
  if (type.includes("file") || type === "document") return "file";
  return fallback;
}

function pushArray(
  output: RawSegment[],
  root: JsonRecord,
  key: string,
  kind: SentSegmentKind
): void {
  const value = root[key];
  if (!Array.isArray(value)) return;
  value.forEach((item, index) => {
    output.push({ path: [key, index], kind: segmentKind(item, kind), value: item });
  });
}

function pushSystem(output: RawSegment[], value: unknown, path: JsonPath): void {
  if (value === undefined) return;
  if (Array.isArray(value)) {
    value.forEach((block, index) =>
      output.push({ path: [...path, index], kind: segmentKind(block, "system"), value: block })
    );
    return;
  }
  output.push({ path, kind: "system", value });
}

function pushMessages(
  output: RawSegment[],
  key: "messages" | "input",
  value: unknown
): void {
  if (!Array.isArray(value)) return;
  value.forEach((item, index) => {
    if (!isRecord(item)) {
      output.push({ path: [key, index], kind: "other", value: item });
      return;
    }
    const role = typeof item.role === "string" ? item.role : undefined;
    const content = item.content;
    if (Array.isArray(content)) {
      content.forEach((block, blockIndex) =>
        output.push({
          path: [key, index, "content", blockIndex],
          kind: segmentKind(block, "message"),
          ...(role ? { role } : {}),
          value: block,
        })
      );
      if (Array.isArray(item.tool_calls)) {
        item.tool_calls.forEach((call, callIndex) =>
          output.push({
            path: [key, index, "tool_calls", callIndex],
            kind: "message",
            ...(role ? { role } : {}),
            value: call,
          })
        );
      }
      return;
    }
    output.push({
      path: [key, index],
      kind: segmentKind(item, "message"),
      ...(role ? { role } : {}),
      value: item,
    });
  });
}

function rawSegments(provider: ProviderKind, body: JsonRecord): RawSegment[] {
  const output: RawSegment[] = [];
  pushArray(output, body, "tools", "tool");
  if (provider === "anthropic-messages") {
    pushSystem(output, body.system, ["system"]);
    pushMessages(output, "messages", body.messages);
    return output;
  }
  const schema = provider === "openai-responses" ? body.text : body.response_format;
  if (schema !== undefined) {
    output.push({
      path: provider === "openai-responses" ? ["text"] : ["response_format"],
      kind: "schema",
      value: schema,
    });
  }
  if (provider === "openai-responses") {
    pushSystem(output, body.instructions, ["instructions"]);
    pushMessages(output, "input", body.input);
  } else {
    pushMessages(output, "messages", body.messages);
  }
  return output;
}

function pathStartsWith(path: JsonPath, prefix: JsonPath): boolean {
  return prefix.length <= path.length && prefix.every((part, index) => path[index] === part);
}

function hasCacheControl(value: unknown): boolean {
  return isRecord(value) && "cache_control" in value;
}

function requestedTtl(value: unknown): string | undefined {
  if (!isRecord(value) || !isRecord(value.cache_control)) return undefined;
  return typeof value.cache_control.ttl === "string" ? value.cache_control.ttl : undefined;
}

function structuralSegments(
  provider: ProviderKind,
  body: JsonRecord,
  occurrences: readonly Occurrence[],
  secret: Uint8Array
): Readonly<{ segments: readonly CompiledSentSegment[]; raw: readonly RawSegment[] }> {
  const raw = rawSegments(provider, body);
  const segments = raw.map((segment, ordinal) => {
    const canonical = canonicalizeSentValue(segment.value);
    const mutableSourceIds = occurrences
      .filter((occurrence) => pathStartsWith(occurrence.providerPath, segment.path))
      .map((occurrence) => occurrence.occurrenceId);
    return Object.freeze({
      ordinal,
      providerPath: Object.freeze([...segment.path]),
      kind: segment.kind,
      ...(segment.role ? { role: segment.role } : {}),
      contentDigest: hmacSentDigest(
        secret,
        segment.value,
        "context-surgeon:cache-segment:v1"
      ),
      canonicalization: CACHE_CANONICALIZATION_VERSION,
      canonicalBytes: canonical.bytes,
      mutableSourceIds: Object.freeze(mutableSourceIds),
    });
  });
  return Object.freeze({ segments: Object.freeze(segments), raw: Object.freeze(raw) });
}

function breakpoints(
  body: JsonRecord,
  raw: readonly RawSegment[],
  segments: readonly CompiledSentSegment[],
  secret: Uint8Array
): readonly CompiledCacheBreakpoint[] {
  const output: CompiledCacheBreakpoint[] = [];
  raw.forEach((segment, afterSegment) => {
    if (!hasCacheControl(segment.value)) return;
    const prefix = segments.slice(0, afterSegment + 1).map((item) => ({
      ordinal: item.ordinal,
      providerPath: item.providerPath,
      kind: item.kind,
      role: item.role ?? null,
      contentDigest: item.contentDigest,
    }));
    const ttl = requestedTtl(segment.value);
    output.push(Object.freeze({
      source: "context-surgeon" as const,
      mode: "explicit" as const,
      afterSegment,
      sentPrefixDigest: hmacSentDigest(
        secret,
        prefix,
        "context-surgeon:cache-prefix:v1"
      ),
      canonicalPrefixBytes: segments
        .slice(0, afterSegment + 1)
        .reduce((sum, item) => sum + item.canonicalBytes, 0),
      ...(ttl ? { requestedTtl: ttl } : {}),
      effectiveTtl: ttl ?? "unknown",
    }));
  });
  if (body.cache_control !== undefined && segments.length > 0) {
    const afterSegment = segments.length - 1;
    output.push(Object.freeze({
      source: "provider-automatic" as const,
      mode: "implicit" as const,
      afterSegment,
      sentPrefixDigest: hmacSentDigest(
        secret,
        segments.map((item) => item.contentDigest),
        "context-surgeon:cache-prefix:v1"
      ),
      canonicalPrefixBytes: segments.reduce((sum, item) => sum + item.canonicalBytes, 0),
      requestedTtl: requestedTtl({ cache_control: body.cache_control }),
      effectiveTtl: requestedTtl({ cache_control: body.cache_control }) ?? "unknown",
    }));
  }
  return Object.freeze(output);
}

export function previewSentMapDivergence(
  before: Pick<CompiledSentMap, "segments" | "breakpoints">,
  after: Pick<CompiledSentMap, "segments" | "breakpoints">
): SentMapDivergencePreview {
  const length = Math.max(before.segments.length, after.segments.length);
  let first: number | null = null;
  for (let index = 0; index < length; index += 1) {
    const left = before.segments[index];
    const right = after.segments[index];
    if (
      !left ||
      !right ||
      left.contentDigest !== right.contentDigest ||
      JSON.stringify(left.providerPath) !== JSON.stringify(right.providerPath)
    ) {
      first = index;
      break;
    }
  }
  const surviving: number[] = [];
  const changed: number[] = [];
  for (const breakpoint of before.breakpoints) {
    const match = after.breakpoints.find(
      (candidate) => candidate.afterSegment === breakpoint.afterSegment
    );
    if (match?.sentPrefixDigest === breakpoint.sentPrefixDigest) {
      surviving.push(breakpoint.afterSegment);
    } else {
      changed.push(breakpoint.afterSegment);
    }
  }
  return Object.freeze({
    firstDivergenceSegment: first,
    survivingBreakpoints: Object.freeze(surviving),
    changedBreakpoints: Object.freeze(changed),
  });
}

function mapWithoutPreview(input: {
  provider: ProviderKind;
  body: JsonRecord;
  exactBodySha256: string;
  occurrences: readonly Occurrence[];
  secret: Uint8Array;
}): CompiledSentMap {
  const extracted = structuralSegments(
    input.provider,
    input.body,
    input.occurrences,
    input.secret
  );
  const points = breakpoints(input.body, extracted.raw, extracted.segments, input.secret);
  const sentMapDigest = hmacSentDigest(
    input.secret,
    extracted.segments.map((segment) => ({
      ordinal: segment.ordinal,
      providerPath: segment.providerPath,
      kind: segment.kind,
      role: segment.role ?? null,
      contentDigest: segment.contentDigest,
    })),
    "context-surgeon:cache-map:v1"
  );
  return Object.freeze({
    schemaVersion: CACHE_TRUTH_SCHEMA_VERSION,
    canonicalization: CACHE_CANONICALIZATION_VERSION,
    provider: input.provider,
    exactBodySha256: input.exactBodySha256,
    sentMapDigest,
    segments: extracted.segments,
    breakpoints: points,
    preview: Object.freeze({
      firstDivergenceSegment: null,
      survivingBreakpoints: Object.freeze([]),
      changedBreakpoints: Object.freeze([]),
    }),
    explanationCodes: Object.freeze([
      "compiled-sent-map-exact-final-body",
      "provider-private-rendering-not-claimed",
      "provider-cache-residency-not-claimed",
    ]),
  });
}

export function compileSentMap(input: {
  provider: ProviderKind;
  receivedBody: JsonRecord;
  finalBody: JsonRecord;
  exactBodySha256: string;
  occurrences: readonly Occurrence[];
  secret: Uint8Array;
}): CompiledSentMap {
  const before = mapWithoutPreview({
    provider: input.provider,
    body: input.receivedBody,
    exactBodySha256: "received-body",
    occurrences: input.occurrences,
    secret: input.secret,
  });
  const after = mapWithoutPreview({
    provider: input.provider,
    body: input.finalBody,
    exactBodySha256: input.exactBodySha256,
    occurrences: input.occurrences,
    secret: input.secret,
  });
  return Object.freeze({
    ...after,
    preview: previewSentMapDivergence(before, after),
  });
}
