import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { ContextObject } from "../context/types.js";
import { canonicalizeItem } from "../context/fingerprint.js";
import type { DirectiveStore } from "../store/directive-store.js";
import type {
  ConversationTracker,
  ExplicitConversationCatalog,
} from "./conversations.js";
import type { AttemptReceipt, DispatchArtifact, ProviderKind } from "../contracts/truth.js";
import type { AttemptObservation } from "./stream.js";
import type { AppliedDirective } from "../context/transformer.js";
import { buildStatusSummary, type StatusSummary } from "../context/status.js";
import {
  ImmutableRequestCompiler,
  constructHeaderEnvelope,
  decodeBody,
  legacyStateForProjection,
  parseContentEncoding,
  parseJsonObject,
  receiveRequest,
  TruthCoreError,
  type SecretHeaderValues,
} from "../compiler/index.js";
import { createDispatchArtifact, type SupportedRoute } from "../contracts/truth.js";
import type {
  IdentityResolver,
  ResolvedIdentity,
  StateSnapshot,
  StateTransactionStore,
} from "../contracts/state.js";
import type { ProviderCodec, ProviderProjection } from "../contracts/provider.js";
import { providerCodec } from "../providers/index.js";
import { reconcileBootstrapState } from "../compiler/bootstrap-state.js";

/** Snapshot passed to optional hooks (e.g. tests). */
export type DebugSnapshotInput = {
  timestamp: string;
  path: string;
  format: ProviderKind;
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
  /** Atomic production seam. Its absence alone enables the legacy test bridge. */
  v2Session?: V2SessionSeam;
  onDebugSnapshot?: (snapshot: DebugSnapshotInput) => void;
  onAttemptReceipt?: (receipt: AttemptReceipt) => void;
  onAttemptObservation?: (observation: AttemptObservation) => void;
  cacheHmacSecret?: Uint8Array;
};

export type TransformResult = Readonly<{
  artifact: DispatchArtifact;
  secretHeaders: SecretHeaderValues;
  /** Defensive compatibility view. Dispatch never treats this as authoritative. */
  body: Buffer;
  upstreamUrl: string;
  format: ProviderKind;
  statusSummary: StatusSummary;
  rootFingerprint: string | null;
  recordAttemptOutcome: (receipt: AttemptReceipt) => void;
  translateResponse?: "responses-to-chat";
}>;

const SKILL_SIGNATURE = "genuin-joging-awkwerd-febuary";
const sessionIds = new WeakMap<HandlerConfig, string>();
const legacyBootstrapStates = new WeakMap<HandlerConfig, StateSnapshot>();
const legacyCacheHmacSecrets = new WeakMap<HandlerConfig, Uint8Array>();

export type V2SessionSeam = Readonly<{
  sessionId: string;
  identityResolver: IdentityResolver;
  store: StateTransactionStore;
  catalog: ExplicitConversationCatalog;
  cacheHmacSecret?: Uint8Array;
}>;

function v2SessionSeam(config: HandlerConfig): V2SessionSeam | null {
  const seam = config.v2Session;
  if (seam === undefined) return null;
  if (
    seam === null ||
    typeof seam !== "object" ||
    !seam.sessionId ||
    !seam.identityResolver ||
    !seam.store ||
    !seam.catalog
  ) {
    throw new TruthCoreError(
      "HandlerConfig.v2Session requires sessionId, identityResolver, store, and catalog",
      500,
      "v2-session-seam-incomplete"
    );
  }
  return seam;
}

function sessionIdFor(config: HandlerConfig): string {
  const existing = sessionIds.get(config);
  if (existing) return existing;
  const created = `truth-core-${randomUUID()}`;
  sessionIds.set(config, created);
  return created;
}

function legacyCacheHmacSecret(config: HandlerConfig): Uint8Array {
  const existing = legacyCacheHmacSecrets.get(config);
  if (existing) return existing;
  const created = new Uint8Array(randomBytes(32));
  legacyCacheHmacSecrets.set(config, created);
  return created;
}

function baseAndSuffix(base: string, suffix: string): string {
  return base.replace(/\/+$/, "") + (suffix.startsWith("/") ? suffix : `/${suffix}`);
}

function pathAndSearch(path: string): { pathname: string; search: string } {
  const parsed = new URL(path, "http://context-surgeon.invalid");
  return { pathname: parsed.pathname, search: parsed.search };
}

function getUpstreamUrl(
  format: ProviderKind,
  incomingPath: string,
  config: HandlerConfig,
  reroutedResponses: boolean
): string {
  const { pathname, search } = pathAndSearch(incomingPath);
  if (pathname.includes("/codex/responses")) {
    return baseAndSuffix(
      config.upstreamChatGPT,
      `${pathname.replace(/^\/backend-api/, "")}${search}`
    );
  }
  if (format === "anthropic-messages") {
    const suffix = pathname.startsWith("/anthropic")
      ? pathname.replace(/^\/anthropic/, "") || "/"
      : pathname;
    return baseAndSuffix(config.upstreamAnthropic, `${suffix}${search}`);
  }
  if (reroutedResponses) {
    return baseAndSuffix(config.upstreamOpenAI, `/responses${search}`);
  }
  const suffix = pathname.startsWith("/v1")
    ? pathname.replace(/^\/v1/, "") || "/"
    : pathname;
  return baseAndSuffix(config.upstreamOpenAI, `${suffix}${search}`);
}

function pathFormat(path: string): ProviderKind | null {
  const { pathname } = pathAndSearch(path);
  if (
    pathname === "/v1/responses" ||
    pathname === "/backend-api/codex/responses" ||
    pathname === "/codex/responses"
  ) {
    return "openai-responses";
  }
  if (pathname === "/anthropic/v1/messages" || pathname === "/v1/messages") {
    return "anthropic-messages";
  }
  if (
    pathname === "/v1/chat/completions" ||
    pathname === "/chat/completions"
  ) {
    return "openai-chat-completions";
  }
  return null;
}

function routeFor(
  path: string,
  providerValue: Readonly<Record<string, unknown>>,
  config: HandlerConfig
): Readonly<{
  route: SupportedRoute;
  translateResponse?: "responses-to-chat";
}> | null {
  let provider = pathFormat(path);
  if (!provider) return null;
  const reroutedResponses =
    provider === "openai-chat-completions" &&
    !Array.isArray(providerValue.messages) &&
    Array.isArray(providerValue.input);
  let translateResponse: "responses-to-chat" | undefined;
  if (reroutedResponses) {
    provider = "openai-responses";
    translateResponse = "responses-to-chat";
  }
  return {
    route: Object.freeze({
      provider,
      incomingPath: path,
      upstreamUrl: getUpstreamUrl(provider, path, config, reroutedResponses),
    }),
    ...(translateResponse ? { translateResponse } : {}),
  };
}

function identityFor(config: HandlerConfig): ResolvedIdentity {
  return Object.freeze({
    sessionId: sessionIdFor(config),
    conversationId: "legacy-v1-conversation",
    branchId: "legacy-v1-branch",
    revision: 0,
    confidence: "explicit" as const,
    reason: "Temporary truth-core bridge; v2 state branch owns durable identity",
  });
}

function parseProjection(
  codec: ProviderCodec,
  received: Parameters<ProviderCodec["parse"]>[0],
  identity: ResolvedIdentity
): ProviderProjection {
  try {
    return codec.parse(received, identity);
  } catch (error) {
    throw new TruthCoreError(
      `Provider envelope rejected: ${
        error instanceof Error ? error.message : "invalid shape"
      }`,
      422,
      "provider-envelope-invalid"
    );
  }
}

function assertPristineProjection(
  codec: ProviderCodec,
  received: Parameters<ProviderCodec["parse"]>[0],
  projection: ProviderProjection
): void {
  const validation = codec.validate({
    before: projection,
    afterValue: received.providerValue,
  });
  if (!validation.valid) {
    throw new TruthCoreError(
      `Provider envelope rejected: ${validation.errors.join("; ")}`,
      422,
      "provider-envelope-invalid"
    );
  }
}

function pristineItemHashes(projection: ProviderProjection): readonly string[] {
  return Object.freeze(
    projection.context.items.map((item) =>
      createHash("sha256").update(canonicalizeItem(item), "utf8").digest("hex")
    )
  );
}

function pendingIdentity(sessionId: string): ResolvedIdentity {
  return Object.freeze({
    sessionId,
    conversationId: "identity-resolution-pending",
    branchId: "identity-resolution-pending",
    revision: 0,
    confidence: "explicit" as const,
  });
}

function resolveV2Projection(input: {
  seam: V2SessionSeam;
  codec: ProviderCodec;
  received: Parameters<ProviderCodec["parse"]>[0];
}): Readonly<{
  identity: ResolvedIdentity;
  projection: ProviderProjection;
  pristineItemHashes: readonly string[];
}> {
  const pristineProjection = parseProjection(
    input.codec,
    input.received,
    pendingIdentity(input.seam.sessionId)
  );
  assertPristineProjection(input.codec, input.received, pristineProjection);
  const history = pristineItemHashes(pristineProjection);

  let identity: ResolvedIdentity;
  try {
    identity = input.seam.identityResolver.resolve({
      pristineItemHashes: history,
    });
  } catch (error) {
    throw new TruthCoreError(
      `Session identity resolution failed: ${
        error instanceof Error ? error.message : "invalid identity"
      }`,
      409,
      "identity-resolution-failed"
    );
  }
  if (identity.confidence === "ambiguous") {
    throw new TruthCoreError(
      identity.reason ?? "Conversation or branch identity is ambiguous",
      409,
      "ambiguous-identity"
    );
  }
  if (
    identity.sessionId !== input.seam.sessionId ||
    !identity.conversationId ||
    !identity.branchId
  ) {
    throw new TruthCoreError(
      "Resolved identity does not match the configured v2 session",
      409,
      "identity-session-mismatch"
    );
  }

  const projection = parseProjection(input.codec, input.received, identity);
  input.seam.catalog.publish({
    identity,
    pristineItemHashes: history,
    occurrences: projection.occurrences,
    observedAt: new Date().toISOString(),
  });
  return Object.freeze({ identity, projection, pristineItemHashes: history });
}

export async function compileSupportedRequest(
  path: string,
  rawBody: Buffer,
  incomingHeaders: Readonly<Record<string, string>>,
  config: HandlerConfig
): Promise<TransformResult> {
  if (!pathFormat(path)) {
    throw new Error(`Not a supported surgery route: ${path}`);
  }

  const encoding = parseContentEncoding(incomingHeaders["content-encoding"]);
  const decodedBytes = decodeBody(rawBody, encoding);
  const providerValue = parseJsonObject(decodedBytes);
  const classified = routeFor(path, providerValue, config);
  if (!classified) throw new Error(`Not a supported surgery route: ${path}`);

  const received = receiveRequest({
    requestId: randomUUID(),
    route: classified.route,
    contentEncoding: incomingHeaders["content-encoding"],
    receivedBytes: rawBody,
    decodedBytes,
    providerValue,
  });
  const codec = providerCodec(classified.route.provider);
  const seam = v2SessionSeam(config);
  let identity: ResolvedIdentity;
  let projection: ProviderProjection;
  let state;
  let matchedFingerprints: readonly string[] = Object.freeze([]);
  let rootFingerprint: string | null = null;

  if (seam) {
    const resolved = resolveV2Projection({ seam, codec, received });
    identity = resolved.identity;
    projection = resolved.projection;
    const history = resolved.pristineItemHashes;
    state = config.skillMarkdown
      ? reconcileBootstrapState({
          store: seam.store,
          identity,
          projection,
          receivedValue: received.providerValue,
          pristineItemHashes: history,
          skillSignature: SKILL_SIGNATURE,
          skillBootstrap: config.skillMarkdown,
        }).state
      : seam.store.current(identity.sessionId);
  } else {
    identity = identityFor(config);
    projection = parseProjection(codec, received, identity);
    rootFingerprint = config.tracker.record(projection.context.items);
    const bridge = legacyStateForProjection({
      projection,
      directiveStore: config.directiveStore,
      sessionId: identity.sessionId,
      branchId: identity.branchId,
    });
    state = bridge.state;
    if (config.skillMarkdown) {
      let memory = legacyBootstrapStates.get(config) ?? bridge.state;
      memory = Object.freeze({ ...memory, surgeries: bridge.state.surgeries });
      const memoryStore: StateTransactionStore = {
        current(sessionId) {
          if (sessionId !== identity.sessionId) throw new Error("Legacy state session mismatch");
          return memory;
        },
        commit(transaction) {
          memory = transaction.next;
          legacyBootstrapStates.set(config, memory);
          return transaction.receipt;
        },
      };
      state = reconcileBootstrapState({
        store: memoryStore,
        identity,
        projection,
        receivedValue: received.providerValue,
        pristineItemHashes: pristineItemHashes(projection),
        skillSignature: SKILL_SIGNATURE,
        skillBootstrap: config.skillMarkdown,
      }).state;
    }
    matchedFingerprints = bridge.matchedFingerprints;
  }
  const compiler = new ImmutableRequestCompiler({
    skillBootstrap: config.skillMarkdown,
    skillSignature: SKILL_SIGNATURE,
    cacheHmacSecret: seam?.cacheHmacSecret ?? config.cacheHmacSecret ?? legacyCacheHmacSecret(config),
    cacheTelemetryDurability:
      seam?.cacheHmacSecret || config.cacheHmacSecret ? "durable" : "ephemeral",
    cacheExplanationCodes: seam ? [] : ["bootstrap-decision-not-durable"],
  });
  const { compiled, exactBody } = compiler.compile({
    received,
    identity,
    state,
    codec,
  });
  const headerMaterial = constructHeaderEnvelope({
    incoming: incomingHeaders,
    fullUrl: compiled.fullUrl,
    bodyLength: exactBody.length,
  });
  const artifact = createDispatchArtifact({
    compiled,
    semanticEnvelope: headerMaterial.envelope,
    exactBody,
  });

  const applied: AppliedDirective[] = matchedFingerprints.map((fingerprint) => ({
    fingerprint,
    itemId:
      projection.context.items.find((item) => item.fingerprint === fingerprint)?.id ?? "?",
    tokenEstimate: null,
  }));
  const statusSummary = buildStatusSummary(null, applied.length, 0, config.maxTokens);
  config.onDebugSnapshot?.({
    timestamp: new Date().toISOString(),
    path,
    format: compiled.provider,
    upstreamUrl: compiled.fullUrl,
    systemPrompt: projection.context.systemPrompt,
    items: structuredClone(projection.context.items),
    applied,
    statusSummary,
    rawRequest: structuredClone(compiled.normalizedValue),
  });

  let outcomeRecorded = false;
  const recordAttemptOutcome = (receipt: AttemptReceipt): void => {
    if (outcomeRecorded || receipt.responseStatus === undefined) return;
    if (
      receipt.state !== "response-completed" &&
      receipt.state !== "response-aborted"
    ) {
      return;
    }
    outcomeRecorded = true;
    for (const fingerprint of matchedFingerprints) {
      const item = projection.context.items.find(
        (candidate) => candidate.fingerprint === fingerprint
      );
      config.directiveStore.noteMatched(fingerprint, item?.id ?? "?", null);
    }
    if (rootFingerprint) {
      config.tracker.noteApplied(rootFingerprint, [...matchedFingerprints]);
    }
  };

  return Object.freeze({
    artifact,
    secretHeaders: headerMaterial.secretValues,
    body: exactBody.inspectCopy(),
    upstreamUrl: compiled.fullUrl,
    format: compiled.provider,
    statusSummary,
    rootFingerprint,
    recordAttemptOutcome,
    ...(classified.translateResponse
      ? { translateResponse: classified.translateResponse }
      : {}),
  });
}

/** Compatibility wrapper for unit callers. Supported-route dispatch uses the throwing API. */
export async function transformRequest(
  path: string,
  rawBody: Buffer,
  incomingHeaders: Record<string, string>,
  config: HandlerConfig
): Promise<TransformResult | null> {
  if (!pathFormat(path)) return null;
  try {
    return await compileSupportedRequest(path, rawBody, incomingHeaders, config);
  } catch {
    return null;
  }
}
