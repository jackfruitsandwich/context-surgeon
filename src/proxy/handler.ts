import { randomUUID } from "node:crypto";
import type { ContextObject } from "../context/types.js";
import type { DirectiveStore } from "../store/directive-store.js";
import type { ConversationTracker } from "./conversations.js";
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
import type { ResolvedIdentity } from "../contracts/state.js";
import { providerCodec } from "../providers/index.js";

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
  onDebugSnapshot?: (snapshot: DebugSnapshotInput) => void;
  onAttemptReceipt?: (receipt: AttemptReceipt) => void;
  onAttemptObservation?: (observation: AttemptObservation) => void;
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

function sessionIdFor(config: HandlerConfig): string {
  const existing = sessionIds.get(config);
  if (existing) return existing;
  const created = `truth-core-${randomUUID()}`;
  sessionIds.set(config, created);
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
  const identity = identityFor(config);
  const codec = providerCodec(classified.route.provider);

  let projection;
  try {
    projection = codec.parse(received, identity);
  } catch (error) {
    throw new TruthCoreError(
      `Provider envelope rejected: ${error instanceof Error ? error.message : "invalid shape"}`,
      422,
      "provider-envelope-invalid"
    );
  }
  const rootFingerprint = config.tracker.record(projection.context.items);
  const bridge = legacyStateForProjection({
    projection,
    directiveStore: config.directiveStore,
    sessionId: identity.sessionId,
    branchId: identity.branchId,
  });
  const compiler = new ImmutableRequestCompiler({
    skillBootstrap: config.skillMarkdown,
    skillSignature: SKILL_SIGNATURE,
  });
  const { compiled, exactBody } = compiler.compile({
    received,
    identity,
    state: bridge.state,
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

  const applied: AppliedDirective[] = bridge.matchedFingerprints.map((fingerprint) => ({
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
    for (const fingerprint of bridge.matchedFingerprints) {
      const item = projection.context.items.find(
        (candidate) => candidate.fingerprint === fingerprint
      );
      config.directiveStore.noteMatched(fingerprint, item?.id ?? "?", null);
    }
    if (rootFingerprint) {
      config.tracker.noteApplied(rootFingerprint, [...bridge.matchedFingerprints]);
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
