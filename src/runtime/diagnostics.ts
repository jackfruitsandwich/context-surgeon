import { createHash } from "node:crypto";
import type http from "node:http";

const SECRET_HEADER = /^(authorization|cookie|proxy-authorization|x-api-key|api-key|set-cookie)$/i;

export type AuthClassification =
  | "bearer"
  | "basic"
  | "api-key"
  | "cookie"
  | "other"
  | "none";

export function classifyAuth(
  headers: http.IncomingHttpHeaders | Record<string, string | string[] | undefined>
): AuthClassification {
  const authorization = headers.authorization;
  const authorizationValue = Array.isArray(authorization)
    ? authorization[0]
    : authorization;
  if (authorizationValue) {
    const scheme = authorizationValue.trim().split(/\s+/, 1)[0]?.toLowerCase();
    if (scheme === "bearer") return "bearer";
    if (scheme === "basic") return "basic";
    return "other";
  }
  if (headers["x-api-key"] || headers["api-key"]) return "api-key";
  if (headers.cookie) return "cookie";
  return "none";
}

export function sha256ForDiagnostics(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function safePathname(value: string): string {
  try {
    return new URL(value, "http://context-surgeon.invalid").pathname;
  } catch {
    return "<invalid-path>";
  }
}

export function safeHeaderSummary(
  headers: http.IncomingHttpHeaders
): Readonly<Record<string, string | boolean>> {
  const summary: Record<string, string | boolean> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined) continue;
    if (SECRET_HEADER.test(name)) {
      summary[`${name.toLowerCase()}Present`] = true;
      continue;
    }
    if (name === "content-length" || name === "content-encoding" || name === "content-type") {
      summary[name] = Array.isArray(value) ? value.join(",") : value;
    }
  }
  return Object.freeze(summary);
}

function safeErrorClass(error: unknown): string {
  if (!error || typeof error !== "object") return typeof error;
  const candidate = error as { name?: unknown; code?: unknown };
  const name = typeof candidate.name === "string" ? candidate.name : "Error";
  const code = typeof candidate.code === "string" ? candidate.code : null;
  return code ? `${name}/${code}` : name;
}

export class SafeDiagnostics {
  readonly enabled: boolean;
  readonly #write: (line: string) => void;

  constructor(
    enabled: boolean,
    write: (line: string) => void = (line) => console.error(line)
  ) {
    this.enabled = enabled;
    this.#write = write;
  }

  event(
    name: string,
    fields: Readonly<Record<string, string | number | boolean | null | undefined>> = {}
  ): void {
    if (!this.enabled) return;
    const safeFields = Object.entries(fields)
      .filter((entry): entry is [string, string | number | boolean | null] => entry[1] !== undefined)
      .map(([key, value]) => `${key}=${JSON.stringify(value)}`)
      .join(" ");
    this.#write(`[context-surgeon:debug] ${name}${safeFields ? ` ${safeFields}` : ""}`);
  }

  error(name: string, error: unknown): void {
    this.event(name, { errorClass: safeErrorClass(error) });
  }
}

/**
 * Legacy debug mode used to make lower layers print request and response
 * fragments. Consume it once at bootstrap and remove it from the ambient
 * environment so those content-logging branches cannot activate.
 */
export function consumeSafeDebugFlag(env: NodeJS.ProcessEnv = process.env): boolean {
  const enabled = env.CONTEXT_SURGEON_DEBUG === "1" || env.CONTEXT_SURGEON_DEBUG === "true";
  delete env.CONTEXT_SURGEON_DEBUG;
  return enabled;
}
