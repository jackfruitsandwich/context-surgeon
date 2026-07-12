import { createHash, randomBytes, randomUUID } from "node:crypto";
import type {
  BootstrapBranchState,
  IdentityConfidence,
  IdentityResolver,
  Occurrence,
  OccurrenceKind,
  ResolvedIdentity,
} from "../contracts/state.js";

const SHA256_RE = /^[a-f0-9]{64}$/;

function sha256(value: Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

export function lengthDelimited(parts: readonly (string | Buffer)[]): Buffer {
  const encoded: Buffer[] = [];
  for (const part of parts) {
    const bytes = typeof part === "string" ? Buffer.from(part, "utf8") : part;
    const length = Buffer.allocUnsafe(8);
    length.writeBigUInt64BE(BigInt(bytes.length));
    encoded.push(length, bytes);
  }
  return Buffer.concat(encoded);
}

export type SessionAuthority = Readonly<{
  sessionId: string;
  confidence: "native" | "explicit" | "launch-random";
  source: "native" | "explicit" | "launch-random";
}>;

function authorityId(kind: string, value: string): string {
  return sha256(lengthDelimited(["context-surgeon/session/v2", kind, value]));
}

/**
 * Resolves session authority without consulting transcript content. Native
 * identity wins only when the caller has already proven it stable. An
 * explicit binding is next; otherwise every launch receives fresh entropy.
 */
export function resolveSessionAuthority(input: {
  provenNativeSessionId?: string;
  explicitSessionId?: string;
  launchId?: string;
}): SessionAuthority {
  if (input.provenNativeSessionId) {
    return {
      sessionId: authorityId("native", input.provenNativeSessionId),
      confidence: "native",
      source: "native",
    };
  }
  if (input.explicitSessionId) {
    return {
      sessionId: authorityId("explicit", input.explicitSessionId),
      confidence: "explicit",
      source: "explicit",
    };
  }
  const launchId = input.launchId ?? randomBytes(16).toString("hex");
  return {
    sessionId: authorityId("launch-random", launchId),
    confidence: "launch-random",
    source: "launch-random",
  };
}

export function sourceHash(value: string | Buffer): string {
  return sha256(typeof value === "string" ? Buffer.from(value, "utf8") : value);
}

export function occurrenceIdentity(input: {
  sessionId: string;
  branchId: string;
  predecessorOccurrenceId?: string;
  kind: OccurrenceKind;
  sourceHash: string;
  structuralRelation: string;
  providerPath: readonly (string | number)[];
}): string {
  if (!SHA256_RE.test(input.sourceHash)) {
    throw new Error("Occurrence sourceHash must be a full lowercase SHA-256");
  }
  const path = input.providerPath.map((part) =>
    lengthDelimited([typeof part === "number" ? "index" : "key", String(part)])
  );
  return sha256(
    lengthDelimited([
      "context-surgeon/occurrence/v2",
      input.sessionId,
      input.branchId,
      input.predecessorOccurrenceId ?? "",
      input.kind,
      input.sourceHash,
      input.structuralRelation,
      Buffer.concat(path),
    ])
  );
}

export function createOccurrence(input: {
  sessionId: string;
  branchId: string;
  revision: number;
  predecessorOccurrenceId?: string;
  kind: OccurrenceKind;
  sourceHash: string;
  displayLabel: string;
  structuralRelation: string;
  providerPath: readonly (string | number)[];
  mutable: boolean;
  protectedReason?: string;
}): Occurrence {
  return Object.freeze({
    occurrenceId: occurrenceIdentity(input),
    sessionId: input.sessionId,
    branchId: input.branchId,
    revision: input.revision,
    kind: input.kind,
    sourceHash: input.sourceHash,
    displayLabel: input.displayLabel,
    providerPath: Object.freeze([...input.providerPath]),
    mutable: input.mutable,
    ...(input.protectedReason ? { protectedReason: input.protectedReason } : {}),
  });
}

export class AmbiguousAliasError extends Error {
  constructor(readonly alias: string, readonly matches: readonly string[]) {
    super(`Alias ${JSON.stringify(alias)} is ambiguous (${matches.length} occurrences)`);
    this.name = "AmbiguousAliasError";
  }
}

export function resolveOccurrenceAliases(
  occurrences: readonly Occurrence[],
  aliasesOrIds: readonly string[]
): readonly string[] {
  const byId = new Map(occurrences.map((occurrence) => [occurrence.occurrenceId, occurrence]));
  const byAlias = new Map<string, string[]>();
  for (const occurrence of occurrences) {
    const ids = byAlias.get(occurrence.displayLabel) ?? [];
    ids.push(occurrence.occurrenceId);
    byAlias.set(occurrence.displayLabel, ids);
  }

  const resolved: string[] = [];
  for (const selector of aliasesOrIds) {
    if (byId.has(selector)) {
      resolved.push(selector);
      continue;
    }
    const matches = byAlias.get(selector) ?? [];
    if (matches.length !== 1) {
      throw new AmbiguousAliasError(selector, matches);
    }
    resolved.push(matches[0]);
  }
  return Object.freeze([...new Set(resolved)]);
}

type BranchHistory = {
  conversationId: string;
  branchId: string;
  history: readonly string[];
  observations: readonly (readonly string[])[];
  parentBranchId?: string;
  forkPoint?: number;
};

export type HistoryObservation = Readonly<{
  identity: ResolvedIdentity;
  pristineItemHashes: readonly string[];
}>;

function isPrefix(prefix: readonly string[], value: readonly string[]): boolean {
  return prefix.length <= value.length && prefix.every((part, index) => part === value[index]);
}

function commonPrefixLength(a: readonly string[], b: readonly string[]): number {
  let length = 0;
  while (length < a.length && length < b.length && a[length] === b[length]) length += 1;
  return length;
}

function suffixPrefixLength(previous: readonly string[], next: readonly string[]): number {
  const maximum = Math.min(previous.length, next.length);
  for (let length = maximum; length > 0; length -= 1) {
    const offset = previous.length - length;
    if (next.slice(0, length).every((part, index) => part === previous[offset + index])) {
      return length;
    }
  }
  return 0;
}

/**
 * Tracks only pristine evidence. It never chooses by recency, size, or a
 * previously selected branch. Earlier edits and non-unique extensions are
 * explicitly ambiguous.
 */
export class PristineHistoryTracker {
  private branches = new Map<string, BranchHistory>();

  constructor(
    readonly sessionId: string,
    restored: readonly BootstrapBranchState[] = []
  ) {
    this.restore(restored);
  }

  restore(restored: readonly BootstrapBranchState[]): void {
    for (const record of restored) {
      if (this.branches.has(record.branchId)) continue;
      this.branches.set(record.branchId, {
        conversationId: record.conversationId,
        branchId: record.branchId,
        history: Object.freeze([...record.history]),
        observations: Object.freeze(
          record.observations.map((entry) => Object.freeze([...entry]))
        ),
        ...(record.parentBranchId ? { parentBranchId: record.parentBranchId } : {}),
        ...(record.forkPoint !== undefined ? { forkPoint: record.forkPoint } : {}),
      });
    }
  }

  observe(
    pristineItemHashes: readonly string[],
    confidence: Exclude<IdentityConfidence, "ambiguous"> = "unique-extension"
  ): HistoryObservation {
    if (pristineItemHashes.some((hash) => !SHA256_RE.test(hash))) {
      throw new Error("Pristine history evidence must use full lowercase SHA-256 hashes");
    }
    const history = Object.freeze([...pristineItemHashes]);
    const branches = [...this.branches.values()];
    if (branches.length === 0) return this.createConversation(history, confidence);

    const exact = branches.filter((branch) =>
      branch.observations.some(
        (observation) =>
          observation.length === history.length && isPrefix(observation, history)
      )
    );
    if (exact.length === 1) return this.result(exact[0], confidence, "stable");
    if (exact.length > 1) {
      return this.ambiguous("historical request is owned by multiple branches");
    }

    const extensions = branches.filter((branch) =>
      branch.history.length < history.length && isPrefix(branch.history, history)
    );
    if (extensions.length === 1) {
      const branch = extensions[0];
      branch.history = history;
      branch.observations = Object.freeze([...branch.observations, history]);
      return this.result(branch, confidence, "extended");
    }
    if (extensions.length > 1) {
      return this.ambiguous("history is an equal extension of multiple branches");
    }

    const containedBy = branches.filter((branch) =>
      history.length < branch.history.length && isPrefix(history, branch.history)
    );
    if (containedBy.length > 0) {
      return this.ambiguous("request is an earlier history, not a unique extension");
    }

    const trimmed = branches
      .map((branch) => ({ branch, overlap: suffixPrefixLength(branch.history, history) }))
      .filter(({ overlap }) => overlap > 0);
    if (trimmed.length > 0) {
      const maximum = Math.max(...trimmed.map(({ overlap }) => overlap));
      const closest = trimmed.filter(({ overlap }) => overlap === maximum);
      if (closest.length === 1) {
        const branch = closest[0].branch;
        branch.history = history;
        branch.observations = Object.freeze([...branch.observations, history]);
        return this.result(branch, confidence, "trimmed");
      }
      return this.ambiguous("trimmed history has non-unique lineage");
    }

    const related = branches
      .map((branch) => ({ branch, common: commonPrefixLength(branch.history, history) }))
      .filter(({ common }) => common > 0);
    if (related.length === 0) return this.createConversation(history, confidence);

    const maxCommon = Math.max(...related.map(({ common }) => common));
    const closest = related.filter(({ common }) => common === maxCommon);
    if (closest.length === 1) {
      const ancestor = closest[0].branch;
      const fork: BranchHistory = {
        conversationId: ancestor.conversationId,
        branchId: randomUUID(),
        history,
        observations: Object.freeze([history]),
        parentBranchId: ancestor.branchId,
        forkPoint: maxCommon,
      };
      this.branches.set(fork.branchId, fork);
      return this.result(fork, confidence, "forked");
    }
    return this.ambiguous("request has non-unique lineage across equally close branches");
  }

  all(): readonly HistoryObservation[] {
    return [...this.branches.values()].map((branch) => ({
      identity: this.identity(branch, "unique-extension"),
      pristineItemHashes: branch.history,
    }));
  }

  private createConversation(
    history: readonly string[],
    confidence: Exclude<IdentityConfidence, "ambiguous">
  ): HistoryObservation {
    const branch: BranchHistory = {
      conversationId: randomUUID(),
      branchId: randomUUID(),
      history,
      observations: Object.freeze([history]),
    };
    this.branches.set(branch.branchId, branch);
    return this.result(branch, confidence, "created");
  }

  private identity(
    branch: BranchHistory,
    confidence: IdentityConfidence,
    reason?: string,
    historyTransition?: ResolvedIdentity["historyTransition"]
  ): ResolvedIdentity {
    return Object.freeze({
      sessionId: this.sessionId,
      conversationId: branch.conversationId,
      branchId: branch.branchId,
      revision: 0,
      confidence,
      ...(reason ? { reason } : {}),
      ...(branch.parentBranchId ? { parentBranchId: branch.parentBranchId } : {}),
      ...(branch.forkPoint !== undefined ? { forkPoint: branch.forkPoint } : {}),
      ...(historyTransition ? { historyTransition } : {}),
    });
  }

  private result(
    branch: BranchHistory,
    confidence: Exclude<IdentityConfidence, "ambiguous">,
    historyTransition: NonNullable<ResolvedIdentity["historyTransition"]>
  ): HistoryObservation {
    return Object.freeze({
      identity: this.identity(branch, confidence, undefined, historyTransition),
      pristineItemHashes: branch.history,
    });
  }

  private ambiguous(reason: string): HistoryObservation {
    return Object.freeze({
      identity: Object.freeze({
        sessionId: this.sessionId,
        conversationId: "",
        branchId: "",
        revision: 0,
        confidence: "ambiguous" as const,
        reason,
      }),
      pristineItemHashes: Object.freeze([]),
    });
  }
}

export class SessionIdentityResolver implements IdentityResolver {
  readonly authority: SessionAuthority;
  readonly histories: PristineHistoryTracker;

  constructor(input: {
    provenNativeSessionId?: string;
    explicitSessionId?: string;
    launchId?: string;
  }) {
    this.authority = resolveSessionAuthority(input);
    this.histories = new PristineHistoryTracker(this.authority.sessionId);
  }

  resolve(input: {
    nativeSessionId?: string;
    explicitSessionId?: string;
    pristineItemHashes: readonly string[];
  }): ResolvedIdentity {
    const requested = resolveSessionAuthority({
      provenNativeSessionId: input.nativeSessionId,
      explicitSessionId: input.explicitSessionId,
      launchId: this.authority.source === "launch-random" ? this.authority.sessionId : undefined,
    });
    if (
      (input.nativeSessionId || input.explicitSessionId) &&
      requested.sessionId !== this.authority.sessionId
    ) {
      return Object.freeze({
        sessionId: this.authority.sessionId,
        conversationId: "",
        branchId: "",
        revision: 0,
        confidence: "ambiguous",
        reason: "request session authority does not match the owning session",
      });
    }
    const identityConfidence: Exclude<IdentityConfidence, "ambiguous"> =
      this.authority.confidence === "launch-random"
        ? "unique-extension"
        : this.authority.confidence;
    return this.histories.observe(input.pristineItemHashes, identityConfidence).identity;
  }
}
