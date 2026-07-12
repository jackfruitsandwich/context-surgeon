import { randomBytes } from "node:crypto";
import { compileSentMap } from "../cache/sent-map.js";
import type { ProviderCodec, RequestCompiler } from "../contracts/provider.js";
import type { Occurrence, StateSnapshot, SurgeryRecord } from "../contracts/state.js";
import {
  ExactBody,
  type CompiledRequest,
  type OperationResult,
  type ProviderKind,
  type ReceivedRequest,
} from "../contracts/truth.js";
import type { ResolvedIdentity } from "../contracts/state.js";
import {
  deepFreeze,
  getAtPath,
  isRecord,
  pathKey,
  setAtPath,
  sha256Value,
  type JsonPath,
  type JsonRecord,
} from "../providers/shared.js";
import { TruthCoreError } from "./errors.js";

const EVICTION_MARKERS: Readonly<Record<ProviderKind, string>> = Object.freeze({
  "openai-responses": "[context-surgeon: evicted]",
  "openai-chat-completions": "[context-surgeon: evicted]",
  "anthropic-messages": "[Context Surgeon: evicted]",
});

type MutableOperationResult = {
  surgeryId: string;
  occurrenceId: string;
  expectedSourceHash: string;
  outcome: OperationResult["outcome"];
  outputHash?: string;
  reason?: string;
  attribution?: OperationResult["attribution"];
  sharedProviderPath?: boolean;
};

type AppliedPath = {
  path: JsonPath;
  value: unknown;
  resultIndices: number[];
};

function normalizeCursorResponses(
  received: ReceivedRequest,
  candidate: JsonRecord
): void {
  if (
    received.route.provider !== "openai-responses" ||
    !received.route.incomingPath.startsWith("/v1/chat/completions")
  ) {
    return;
  }
  delete candidate.stream_options;
  delete candidate.logit_bias;
  delete candidate.presence_penalty;
  delete candidate.frequency_penalty;
  delete candidate.n;
  if (candidate.max_tokens !== undefined && candidate.max_output_tokens === undefined) {
    candidate.max_output_tokens = candidate.max_tokens;
  }
  delete candidate.max_tokens;
}

function markerBlock(
  provider: ProviderKind,
  occurrence: Occurrence,
  candidate: JsonRecord,
  text: string
): unknown {
  const original = getAtPath(candidate, occurrence.providerPath);
  const cacheControl =
    isRecord(original) && "cache_control" in original
      ? { cache_control: original.cache_control }
      : {};

  if (provider === "anthropic-messages") {
    return { type: "text", text, ...cacheControl };
  }
  if (provider === "openai-chat-completions") {
    return { type: "text", text };
  }

  const inputIndex = occurrence.providerPath[1];
  const role =
    typeof inputIndex === "number"
      ? getAtPath(candidate, ["input", inputIndex, "role"])
      : undefined;
  return {
    type: role === "assistant" ? "output_text" : "input_text",
    text,
    ...cacheControl,
  };
}

function replacementFor(
  provider: ProviderKind,
  occurrence: Occurrence,
  surgery: SurgeryRecord,
  candidate: JsonRecord
): unknown {
  const action = surgery.action;
  const replacementText =
    action.kind === "replace" ? action.content : EVICTION_MARKERS[provider];

  if (occurrence.kind === "image" || occurrence.kind === "document") {
    if (
      action.kind === "evict-media" &&
      action.mediaType !== occurrence.kind
    ) {
      throw new Error(
        `Media action targets ${action.mediaType}, not ${occurrence.kind}`
      );
    }
    return markerBlock(provider, occurrence, candidate, replacementText);
  }

  if (action.kind === "evict-media") {
    throw new Error("Media eviction targeted a non-media occurrence");
  }
  return replacementText;
}

function freezeResults(results: readonly MutableOperationResult[]): readonly OperationResult[] {
  return Object.freeze(
    results.map((result) =>
      Object.freeze({
        surgeryId: result.surgeryId,
        occurrenceId: result.occurrenceId,
        expectedSourceHash: result.expectedSourceHash,
        outcome: result.outcome,
        ...(result.outputHash ? { outputHash: result.outputHash } : {}),
        ...(result.reason ? { reason: result.reason } : {}),
        ...(result.attribution ? { attribution: result.attribution } : {}),
        ...(result.sharedProviderPath ? { sharedProviderPath: true } : {}),
      })
    )
  );
}

export type ImmutableRequestCompilerOptions = Readonly<{
  skillBootstrap?: string;
  skillSignature?: string;
  cacheHmacSecret?: Uint8Array;
  cacheTelemetryDurability?: "durable" | "ephemeral";
  cacheExplanationCodes?: readonly string[];
}>;

export class ImmutableRequestCompiler implements RequestCompiler {
  private readonly skillBootstrap: string;
  private readonly cacheHmacSecret: Uint8Array;
  private readonly cacheTelemetryDurability: "durable" | "ephemeral";
  private readonly cacheExplanationCodes: readonly string[];

  constructor(options: ImmutableRequestCompilerOptions = {}) {
    this.skillBootstrap = options.skillBootstrap?.trim() ?? "";
    this.cacheHmacSecret = new Uint8Array(
      options.cacheHmacSecret ?? randomBytes(32)
    );
    this.cacheTelemetryDurability =
      options.cacheTelemetryDurability ??
      (options.cacheHmacSecret ? "durable" : "ephemeral");
    this.cacheExplanationCodes = Object.freeze([...(options.cacheExplanationCodes ?? [])]);
  }

  compile(input: {
    received: ReceivedRequest;
    identity: ResolvedIdentity;
    state: StateSnapshot;
    codec: ProviderCodec;
  }): Readonly<{ compiled: CompiledRequest; exactBody: ExactBody }> {
    if (input.received.route.provider !== input.codec.provider) {
      throw new TruthCoreError(
        "Route and provider codec disagree",
        422,
        "provider-codec-mismatch"
      );
    }
    if (input.state.sessionId !== input.identity.sessionId) {
      throw new TruthCoreError(
        "State snapshot and resolved session disagree",
        409,
        "state-session-mismatch"
      );
    }

    let before;
    let candidate: JsonRecord;
    try {
      before = input.codec.parse(input.received, input.identity);
      candidate = structuredClone(input.codec.serialize(before.context)) as JsonRecord;
      normalizeCursorResponses(input.received, candidate);
    } catch (error) {
      throw new TruthCoreError(
        `Provider codec rejected the request: ${
          error instanceof Error ? error.message : "unknown codec error"
        }`,
        422,
        "provider-codec-failed"
      );
    }

    const occurrences = new Map(
      before.occurrences.map((occurrence) => [occurrence.occurrenceId, occurrence])
    );
    const results: MutableOperationResult[] = [];
    const appliedPaths = new Map<string, AppliedPath>();
    let fatalOperation = false;

    const surgeries = input.state.surgeries.filter(
      (surgery) =>
        surgery.state === "committed" && surgery.branchId === input.identity.branchId
    );
    for (const surgery of surgeries) {
      const occurrence = occurrences.get(surgery.occurrenceId);
      const base: MutableOperationResult = {
        surgeryId: surgery.surgeryId,
        occurrenceId: surgery.occurrenceId,
        expectedSourceHash: surgery.expectedSourceHash,
        outcome: "rejected",
        attribution: "user-surgery",
      };
      if (!occurrence) {
        results.push({ ...base, outcome: "stale", reason: "Occurrence is absent" });
        fatalOperation = true;
        continue;
      }
      if (occurrence.sourceHash !== surgery.expectedSourceHash) {
        results.push({
          ...base,
          outcome: "stale",
          reason: "Occurrence source hash changed",
        });
        fatalOperation = true;
        continue;
      }
      if (!occurrence.mutable) {
        results.push({
          ...base,
          outcome: "protected-residue",
          reason: occurrence.protectedReason ?? "Provider structure is protected",
        });
        continue;
      }

      const key = pathKey(occurrence.providerPath);
      if (appliedPaths.has(key)) {
        results.push({
          ...base,
          outcome: "rejected",
          reason: "Multiple committed operations target the same provider path",
        });
        fatalOperation = true;
        continue;
      }

      try {
        const replacement = replacementFor(
          input.codec.provider,
          occurrence,
          surgery,
          candidate
        );
        if (!setAtPath(candidate, occurrence.providerPath, replacement)) {
          throw new Error("Final provider path is absent");
        }
        const resultIndex = results.length;
        results.push({
          ...base,
          outcome: "applied",
          outputHash: sha256Value(replacement),
        });
        appliedPaths.set(key, {
          path: occurrence.providerPath,
          value: replacement,
          resultIndices: [resultIndex],
        });
      } catch (error) {
        results.push({
          ...base,
          outcome: "unsupported",
          reason: error instanceof Error ? error.message : "Unsupported operation",
        });
        fatalOperation = true;
      }
    }

    if (this.skillBootstrap) {
      const branch = input.state.bootstrapBranches.find(
        (candidateBranch) => candidateBranch.branchId === input.identity.branchId
      );
      if (!branch) {
        throw new TruthCoreError(
          "Committed bootstrap state is absent for the resolved branch",
          409,
          "bootstrap-state-missing",
          freezeResults(results)
        );
      }
      if (branch.status === "anchored" && branch.anchor) {
        const exactAnchor = before.occurrences.find(
          (occurrence) =>
            occurrence.occurrenceId === branch.anchor?.occurrenceId &&
            occurrence.sourceHash === branch.anchor.sourceHash &&
            pathKey(occurrence.providerPath) === pathKey(branch.anchor.providerPath)
        );
        const bootstrapPrefix = `${this.skillBootstrap}\n\n`;
        const anchored =
          exactAnchor ??
          before.occurrences.find((occurrence) => {
            if (
              pathKey(occurrence.providerPath) !== pathKey(branch.anchor!.providerPath)
            ) return false;
            const value = getAtPath(candidate, occurrence.providerPath);
            return (
              typeof value === "string" &&
              value.startsWith(bootstrapPrefix) &&
              sha256Value(value.slice(bootstrapPrefix.length)) ===
                branch.anchor!.sourceHash
            );
          });
        if (!anchored) {
          throw new TruthCoreError(
            "Committed bootstrap anchor was not reconciled before compilation",
            409,
            "bootstrap-anchor-unreconciled",
            freezeResults(results)
          );
        }
        const existing = getAtPath(candidate, anchored.providerPath);
        if (typeof existing !== "string") {
          throw new TruthCoreError(
            "Bootstrap anchor no longer addresses provider text",
            409,
            "bootstrap-anchor-not-text",
            freezeResults(results)
          );
        }
        const key = pathKey(anchored.providerPath);
        const prior = appliedPaths.get(key);
        if (branch.decision === "inject") {
          if (
            !prior &&
            existing.startsWith(bootstrapPrefix) &&
            sha256Value(existing.slice(bootstrapPrefix.length)) ===
              branch.anchor.sourceHash
          ) {
            results.push({
              surgeryId: "compiler-bootstrap",
              occurrenceId: branch.anchor.occurrenceId,
              expectedSourceHash: branch.anchor.sourceHash,
              outcome: "applied",
              outputHash: sha256Value(existing),
              reason: "bootstrap-exact-prefix-already-at-committed-anchor",
              attribution: "bootstrap-prefix",
            });
          } else {
            const injected = `${bootstrapPrefix}${existing}`;
            if (!setAtPath(candidate, anchored.providerPath, injected)) {
              throw new TruthCoreError(
                "Bootstrap anchor provider path is absent",
                409,
                "bootstrap-anchor-path-absent",
                freezeResults(results)
              );
            }
            const resultIndex = results.length;
            results.push({
              surgeryId: "compiler-bootstrap",
              occurrenceId: anchored.occurrenceId,
              expectedSourceHash: anchored.sourceHash,
              outcome: "applied",
              outputHash: sha256Value(injected),
              reason: prior
                ? "bootstrap-applied-after-user-surgery-same-path"
                : "bootstrap-applied-at-committed-anchor",
              attribution: "bootstrap-prefix",
              sharedProviderPath: !!prior,
            });
            if (prior) {
              prior.value = injected;
              prior.resultIndices.push(resultIndex);
              for (const priorIndex of prior.resultIndices) {
                results[priorIndex].outputHash = sha256Value(injected);
                results[priorIndex].sharedProviderPath = true;
                if (results[priorIndex].attribution === "user-surgery") {
                  results[priorIndex].reason =
                    "user-surgery-composed-before-bootstrap-same-path";
                }
              }
            } else {
              appliedPaths.set(key, {
                path: anchored.providerPath,
                value: injected,
                resultIndices: [resultIndex],
              });
            }
          }
        } else if (branch.decision === "preserve") {
          if (prior) {
            for (const priorIndex of prior.resultIndices) {
              results[priorIndex].sharedProviderPath = true;
              if (results[priorIndex].attribution === "user-surgery") {
                results[priorIndex].reason =
                  "user-surgery-shares-bootstrap-preserve-path";
              }
            }
          }
          results.push({
            surgeryId: "compiler-bootstrap",
            occurrenceId: anchored.occurrenceId,
            expectedSourceHash: anchored.sourceHash,
            outcome: "applied",
            outputHash: sha256Value(existing),
            reason: prior
              ? "bootstrap-preserve-decision-shares-user-surgery-path"
              : "bootstrap-preserved-at-committed-anchor",
            attribution: "bootstrap-prefix",
            sharedProviderPath: !!prior,
          });
        } else {
          throw new TruthCoreError(
            "Anchored bootstrap state has no committed decision",
            409,
            "bootstrap-decision-pending",
            freezeResults(results)
          );
        }
      } else if (branch.status === "stopped") {
        results.push({
          surgeryId: "compiler-bootstrap",
          occurrenceId: "bootstrap-anchor-lost",
          expectedSourceHash: "0".repeat(64),
          outcome: "protected-residue",
          reason: "bootstrap-anchor-loss-stopped-visible",
          attribution: "bootstrap-prefix",
        });
      }
    }

    if (fatalOperation) {
      throw new TruthCoreError(
        "Committed surgery could not be reconciled with this request",
        409,
        "operation-reconciliation-failed",
        freezeResults(results)
      );
    }

    let serialized: string;
    let reparsed: JsonRecord;
    try {
      serialized = JSON.stringify(candidate);
      const value = JSON.parse(serialized) as unknown;
      if (!isRecord(value)) throw new Error("Final body is not a JSON object");
      reparsed = value;
    } catch (error) {
      throw new TruthCoreError(
        `Final provider serialization failed: ${
          error instanceof Error ? error.message : "invalid final JSON"
        }`,
        422,
        "final-serialization-failed",
        freezeResults(results)
      );
    }

    const reconcileErrors: string[] = [];
    for (const occurrence of before.occurrences) {
      const key = pathKey(occurrence.providerPath);
      const expected = appliedPaths.get(key);
      const finalValue = getAtPath(reparsed, occurrence.providerPath);
      if (expected) {
        if (sha256Value(finalValue) !== sha256Value(expected.value)) {
          reconcileErrors.push(`Applied operation missing at ${key}`);
        }
      } else if (sha256Value(finalValue) !== occurrence.sourceHash) {
        reconcileErrors.push(`Untargeted occurrence changed at ${key}`);
      }
    }

    const validation = input.codec.validate({ before, afterValue: reparsed });
    if (!validation.valid) reconcileErrors.push(...validation.errors);
    if (reconcileErrors.length > 0) {
      throw new TruthCoreError(
        `Final provider reconciliation failed: ${reconcileErrors.join("; ")}`,
        422,
        "final-reconciliation-failed",
        freezeResults(results)
      );
    }

    const exactBody = ExactBody.fromUtf8(serialized);
    const sentMap = compileSentMap({
      provider: input.codec.provider,
      receivedBody: input.received.providerValue as JsonRecord,
      finalBody: reparsed,
      exactBodySha256: exactBody.sha256,
      occurrences: before.occurrences,
      secret: this.cacheHmacSecret,
      telemetryDurability: this.cacheTelemetryDurability,
      additionalExplanationCodes: this.cacheExplanationCodes,
    });
    const operationResults = freezeResults(results);
    const compiled: CompiledRequest = Object.freeze({
      requestId: input.received.requestId,
      sessionId: input.identity.sessionId,
      branchId: input.identity.branchId,
      stateRevision: input.state.revision,
      receivedSha256: input.received.receivedSha256,
      decodedSha256: input.received.decodedSha256,
      provider: input.codec.provider,
      fullUrl: input.received.route.upstreamUrl,
      normalizedValue: deepFreeze(reparsed),
      operationResults,
      validation,
      sentMap,
      bodyLength: exactBody.length,
      bodySha256: exactBody.sha256,
    });

    return Object.freeze({ compiled, exactBody });
  }
}
