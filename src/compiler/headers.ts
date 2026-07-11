import type { ConstructiveHeaderEnvelope } from "../contracts/truth.js";
import { TruthCoreError } from "./errors.js";

export type SecretHeaderValues = Readonly<Record<string, string>>;

const SECRET_HEADERS = new Map<string, string>([
  ["authorization", "authorization"],
  ["cookie", "cookie"],
  ["proxy-authorization", "proxy-authorization"],
  ["x-api-key", "api-key"],
  ["chatgpt-account-id", "account-id"],
]);

const SAFE_EXACT = new Set([
  "accept",
  "accept-language",
  "anthropic-beta",
  "anthropic-version",
  "anthropic-dangerous-direct-browser-access",
  "openai-beta",
  "origin",
  "referer",
  "user-agent",
  "x-request-id",
]);

function isSafeForwardedHeader(name: string): boolean {
  return (
    SAFE_EXACT.has(name) ||
    name.startsWith("x-stainless-") ||
    name.startsWith("x-client-")
  );
}

function authClass(name: string, value: string): string {
  if (name === "authorization" || name === "proxy-authorization") {
    const scheme = /^\s*([^\s]+)/.exec(value)?.[1]?.toLowerCase();
    return scheme ? `${scheme}-credential` : "credential";
  }
  return SECRET_HEADERS.get(name) ?? "secret";
}

export function constructHeaderEnvelope(input: {
  incoming: Readonly<Record<string, string>>;
  fullUrl: string;
  bodyLength: number;
}): Readonly<{
  envelope: ConstructiveHeaderEnvelope;
  secretValues: SecretHeaderValues;
}> {
  const parsed = new URL(input.fullUrl);
  if (parsed.username || parsed.password) {
    throw new TruthCoreError(
      "Upstream URLs with embedded credentials are not supported",
      500,
      "credentialed-upstream-url"
    );
  }
  const safeEntries = [
    { name: "content-type", value: "application/json" },
    { name: "content-length", value: String(input.bodyLength) },
    { name: "host", value: parsed.host },
    { name: "connection", value: "close" },
  ];
  const secretSlotByName = new Map<string, {
    name: string;
    class: string;
    present: boolean;
  }>();
  for (const [name, classification] of SECRET_HEADERS) {
    secretSlotByName.set(name, {
      name,
      class:
        name === "authorization" || name === "proxy-authorization"
          ? "credential"
          : classification,
      present: false,
    });
  }
  const secretValues: Record<string, string> = {};
  const seenSafe = new Set(safeEntries.map((entry) => entry.name));

  for (const [rawName, value] of Object.entries(input.incoming)) {
    const name = rawName.toLowerCase();
    if (SECRET_HEADERS.has(name)) {
      secretSlotByName.set(name, {
        name,
        class: authClass(name, value),
        present: true,
      });
      secretValues[name] = value;
      continue;
    }
    if (!isSafeForwardedHeader(name) || seenSafe.has(name)) continue;
    safeEntries.push({ name, value });
    seenSafe.add(name);
  }

  safeEntries.sort((left, right) => left.name.localeCompare(right.name));
  const secretSlots = [...secretSlotByName.values()].sort((left, right) =>
    left.name.localeCompare(right.name)
  );
  return Object.freeze({
    envelope: Object.freeze({
      safeEntries: Object.freeze(safeEntries.map((entry) => Object.freeze(entry))),
      secretSlots: Object.freeze(secretSlots.map((slot) => Object.freeze(slot))),
    }),
    secretValues: Object.freeze({ ...secretValues }),
  });
}

export function materializeHeaders(
  envelope: ConstructiveHeaderEnvelope,
  secretValues: SecretHeaderValues
): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const entry of envelope.safeEntries) {
    const name = entry.name.toLowerCase();
    if (headers[name] !== undefined || SECRET_HEADERS.has(name)) {
      throw new TruthCoreError(
        `Unsafe or duplicate constructive header: ${name}`,
        500,
        "invalid-header-envelope"
      );
    }
    headers[name] = entry.value;
  }
  const allowedSecrets = new Set<string>();
  for (const slot of envelope.secretSlots) {
    const name = slot.name.toLowerCase();
    if (allowedSecrets.has(name) || headers[name] !== undefined) {
      throw new TruthCoreError(
        `Duplicate secret header slot: ${name}`,
        500,
        "invalid-header-envelope"
      );
    }
    allowedSecrets.add(name);
    const value = secretValues[name];
    if (slot.present && typeof value !== "string") {
      throw new TruthCoreError(
        `Missing value for secret header slot: ${name}`,
        500,
        "missing-secret-slot"
      );
    }
    if (!slot.present && typeof value === "string") {
      throw new TruthCoreError(
        `Secret value supplied for absent header slot: ${name}`,
        500,
        "unexpected-secret-slot"
      );
    }
    if (slot.present) headers[name] = value;
  }
  for (const name of Object.keys(secretValues)) {
    if (!allowedSecrets.has(name.toLowerCase())) {
      throw new TruthCoreError(
        `Unbound secret header value: ${name}`,
        500,
        "unbound-secret-slot"
      );
    }
  }
  return headers;
}
