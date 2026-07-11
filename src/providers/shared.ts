import { createHash } from "node:crypto";
import type { ContextObject } from "../context/types.js";
import { computeFingerprints, stableStringify } from "../context/fingerprint.js";
import { assignIds } from "../context/id-assigner.js";
import type {
  Occurrence,
  OccurrenceKind,
  ResolvedIdentity,
} from "../contracts/state.js";

export type JsonRecord = Record<string, unknown>;
export type JsonPath = readonly (string | number)[];

export function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function sha256Value(value: unknown): string {
  const input =
    typeof value === "string" ? Buffer.from(value, "utf8") : stableStringify(value);
  return createHash("sha256").update(input).digest("hex");
}

export function pathKey(path: JsonPath): string {
  return path
    .map((part) =>
      typeof part === "number" ? `[${part}]` : `[${JSON.stringify(part)}]`
    )
    .join("");
}

export function occurrenceId(input: {
  identity: ResolvedIdentity;
  kind: OccurrenceKind;
  sourceHash: string;
  providerPath: JsonPath;
  predecessorId: string;
}): string {
  const encoded = stableStringify({
    version: 2,
    sessionId: input.identity.sessionId,
    branchId: input.identity.branchId,
    revision: input.identity.revision,
    predecessorId: input.predecessorId,
    kind: input.kind,
    sourceHash: input.sourceHash,
    providerPath: input.providerPath,
  });
  return `occ_${createHash("sha256").update(encoded).digest("hex")}`;
}

export function makeOccurrence(
  identity: ResolvedIdentity,
  input: {
    kind: OccurrenceKind;
    value: unknown;
    displayLabel: string;
    providerPath: JsonPath;
    mutable: boolean;
    protectedReason?: string;
    predecessorId?: string;
  }
): Occurrence {
  const sourceHash = sha256Value(input.value);
  return Object.freeze({
    occurrenceId: occurrenceId({
      identity,
      kind: input.kind,
      sourceHash,
      providerPath: input.providerPath,
      predecessorId: input.predecessorId ?? "",
    }),
    sessionId: identity.sessionId,
    branchId: identity.branchId,
    revision: identity.revision,
    kind: input.kind,
    sourceHash,
    displayLabel: input.displayLabel,
    providerPath: Object.freeze([...input.providerPath]),
    mutable: input.mutable,
    ...(input.protectedReason
      ? { protectedReason: input.protectedReason }
      : {}),
  });
}

export function prepareContext(context: ContextObject): ContextObject {
  computeFingerprints(context.items);
  assignIds(context.items);
  return context;
}

export function getAtPath(root: unknown, path: JsonPath): unknown {
  let current = root;
  for (const part of path) {
    if (typeof part === "number") {
      if (!Array.isArray(current) || part < 0 || part >= current.length) {
        return undefined;
      }
      current = current[part];
      continue;
    }
    if (!isRecord(current) || !(part in current)) {
      return undefined;
    }
    current = current[part];
  }
  return current;
}

export function setAtPath(root: unknown, path: JsonPath, value: unknown): boolean {
  if (path.length === 0) return false;
  let parent = root;
  for (let index = 0; index < path.length - 1; index += 1) {
    const part = path[index];
    if (typeof part === "number") {
      if (!Array.isArray(parent) || part < 0 || part >= parent.length) {
        return false;
      }
      parent = parent[part];
    } else {
      if (!isRecord(parent) || !(part in parent)) return false;
      parent = parent[part];
    }
  }

  const final = path[path.length - 1];
  if (typeof final === "number") {
    if (!Array.isArray(parent) || final < 0 || final >= parent.length) {
      return false;
    }
    parent[final] = value;
    return true;
  }
  if (!isRecord(parent) || !(final in parent)) return false;
  parent[final] = value;
  return true;
}

export function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) {
    return value;
  }
  for (const child of Object.values(value as Record<string, unknown>)) {
    deepFreeze(child);
  }
  return Object.freeze(value);
}

export function structuralOrderHash(entries: readonly unknown[]): string {
  return sha256Value(entries);
}

export function protectedHashesMatch(
  before: Readonly<Record<string, string>>,
  after: Readonly<Record<string, string>>
): boolean {
  const beforeKeys = Object.keys(before).sort();
  const afterKeys = Object.keys(after).sort();
  return (
    beforeKeys.length === afterKeys.length &&
    beforeKeys.every(
      (key, index) => key === afterKeys[index] && before[key] === after[key]
    )
  );
}

export function pushProtectedHash(
  hashes: Record<string, string>,
  path: JsonPath,
  value: unknown,
  suffix = ""
): void {
  hashes[`${pathKey(path)}${suffix}`] = sha256Value(value);
}
