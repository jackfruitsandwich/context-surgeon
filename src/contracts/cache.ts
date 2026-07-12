export const CACHE_TRUTH_SCHEMA_VERSION = 1 as const;
export const CACHE_CANONICALIZATION_VERSION = "json-insertion-v1" as const;
export const CACHE_USAGE_MERGE_VERSION = "provider-usage-v1" as const;

export type FrozenJsonValue =
  | null
  | boolean
  | number
  | string
  | readonly FrozenJsonValue[]
  | { readonly [key: string]: FrozenJsonValue };

export type SentSegmentKind =
  | "tool"
  | "system"
  | "message"
  | "image"
  | "file"
  | "schema"
  | "other";

export type CompiledSentSegment = Readonly<{
  ordinal: number;
  providerPath: readonly (string | number)[];
  kind: SentSegmentKind;
  role?: string;
  contentDigest: string;
  canonicalization: typeof CACHE_CANONICALIZATION_VERSION;
  canonicalBytes: number;
  mutableSourceIds: readonly string[];
}>;

export type CompiledCacheBreakpoint = Readonly<{
  source: "context-surgeon" | "provider-automatic" | "provider-unknown";
  mode: "implicit" | "explicit";
  afterSegment: number;
  sentPrefixDigest: string;
  canonicalPrefixBytes: number;
  requestedTtl?: string;
  effectiveTtl: string | "unknown";
}>;

export type SentMapDivergencePreview = Readonly<{
  firstDivergenceSegment: number | null;
  survivingBreakpoints: readonly number[];
  changedBreakpoints: readonly number[];
}>;

export type CompiledSentMap = Readonly<{
  schemaVersion: typeof CACHE_TRUTH_SCHEMA_VERSION;
  canonicalization: typeof CACHE_CANONICALIZATION_VERSION;
  provider: "openai-responses" | "anthropic-messages" | "openai-chat-completions";
  exactBodySha256: string;
  sentMapDigest: string;
  segments: readonly CompiledSentSegment[];
  breakpoints: readonly CompiledCacheBreakpoint[];
  preview: SentMapDivergencePreview;
  explanationCodes: readonly string[];
}>;

export type RawUsageEvent = Readonly<{
  sequence: number;
  raw: FrozenJsonValue;
}>;

export type RawProviderUsageReceipt = Readonly<{
  mergeVersion: typeof CACHE_USAGE_MERGE_VERSION;
  state: "complete" | "partial";
  events: readonly RawUsageEvent[];
  merged: FrozenJsonValue;
}>;

export type ProviderCacheObservation =
  | "provider-reported-read"
  | "provider-reported-write"
  | "provider-reported-read-and-write"
  | "provider-reported-zero"
  | "usage-unavailable"
  | "request-failed";

export type CacheObservationReceipt = Readonly<{
  schemaVersion: typeof CACHE_TRUTH_SCHEMA_VERSION;
  attemptId: string;
  bodyTruth: Readonly<{
    receivedSha256: string;
    decodedSha256: string;
    compiledSha256: string;
    dispatchedSha256: string;
  }>;
  sentMap: CompiledSentMap;
  providerUsageRaw?: RawProviderUsageReceipt;
  observed: ProviderCacheObservation;
  explanationCodes: readonly string[];
}>;
