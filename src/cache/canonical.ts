import { createHash, createHmac } from "node:crypto";
import {
  CACHE_CANONICALIZATION_VERSION,
  type FrozenJsonValue,
} from "../contracts/cache.js";

function assertFiniteJson(
  value: unknown,
  path: string,
  seen: Set<object>
): asserts value is FrozenJsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (Number.isFinite(value)) return;
    throw new Error(`${path} contains a non-finite number`);
  }
  if (typeof value !== "object") throw new Error(`${path} is not JSON`);
  if (seen.has(value)) throw new Error(`${path} contains a cycle`);
  seen.add(value);
  if (Array.isArray(value)) {
    value.forEach((child, index) => assertFiniteJson(child, `${path}[${index}]`, seen));
  } else {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new Error(`${path} is not a plain JSON object`);
    }
    if (Reflect.ownKeys(value).some((key) => typeof key !== "string")) {
      throw new Error(`${path} contains a symbol key`);
    }
    for (const [key, child] of Object.entries(value)) {
      assertFiniteJson(child, `${path}.${key}`, seen);
    }
  }
  seen.delete(value);
}

function deepFreezeJson(value: FrozenJsonValue): FrozenJsonValue {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) {
    value.forEach(deepFreezeJson);
    return Object.freeze(value);
  }
  Object.values(value).forEach(deepFreezeJson);
  return Object.freeze(value);
}

export function freezeJsonValue(value: unknown): FrozenJsonValue {
  assertFiniteJson(value, "$", new Set());
  return deepFreezeJson(structuredClone(value) as FrozenJsonValue);
}

export function canonicalizeSentValue(value: unknown): Readonly<{
  canonicalization: typeof CACHE_CANONICALIZATION_VERSION;
  json: string;
  bytes: number;
  sha256: string;
}> {
  const frozen = freezeJsonValue(value);
  const json = JSON.stringify(frozen);
  const bytes = Buffer.byteLength(json, "utf8");
  const sha256 = createHash("sha256")
    .update(CACHE_CANONICALIZATION_VERSION)
    .update("\0")
    .update(json)
    .digest("hex");
  return Object.freeze({
    canonicalization: CACHE_CANONICALIZATION_VERSION,
    json,
    bytes,
    sha256,
  });
}

export function hmacSentDigest(
  secret: Uint8Array,
  value: unknown,
  domain: string
): string {
  if (secret.byteLength < 32) {
    throw new Error("cache telemetry HMAC secret must contain at least 32 bytes");
  }
  const canonical = canonicalizeSentValue(value);
  return createHmac("sha256", secret)
    .update(CACHE_CANONICALIZATION_VERSION)
    .update("\0")
    .update(domain)
    .update("\0")
    .update(canonical.json)
    .digest("hex");
}
