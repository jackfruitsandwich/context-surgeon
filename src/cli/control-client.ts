import http from "node:http";
import type { ControlIdentity } from "../contracts/control.js";
import {
  candidateControlRecords,
  type DiscoveredControlRecord,
} from "./session-discovery.js";

const CONTROL_RETRY_DELAYS_MS = [0, 150, 500];

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function flattenErrorText(error: unknown): string {
  if (error instanceof Error) {
    const causeText = "cause" in error && error.cause !== undefined
      ? ` ${flattenErrorText(error.cause)}`
      : "";
    return `${error.name} ${error.message}${causeText}`;
  }
  return String(error);
}

export function isRetryableControlError(error: unknown): boolean {
  return /econnreset|econnrefused|enoent|epipe|etimedout|socket hang up|networkerror/i.test(
    flattenErrorText(error)
  );
}

class ControlHttpError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = "ControlHttpError";
  }
}

type RawResponse = Readonly<{ status: number; payload: unknown }>;

function requestOptions(
  target: DiscoveredControlRecord,
  path: string,
  init: RequestInit
): http.RequestOptions {
  const headers: Record<string, string> = {
    authorization: `Bearer ${target.record.capability}`,
    accept: "application/json",
  };
  new Headers(init.headers).forEach((value, name) => { headers[name] = value; });
  if (target.record.address.kind === "unix") {
    return {
      socketPath: target.record.address.path,
      path,
      method: init.method ?? "GET",
      headers,
    };
  }
  const url = new URL(path, target.record.address.url);
  return {
    protocol: url.protocol,
    hostname: url.hostname,
    port: url.port,
    path: `${url.pathname}${url.search}`,
    method: init.method ?? "GET",
    headers,
  };
}

async function rawRequest(
  target: DiscoveredControlRecord,
  path: string,
  init: RequestInit = {}
): Promise<RawResponse> {
  const body = typeof init.body === "string" ? init.body : undefined;
  const options = requestOptions(target, path, init);
  if (body !== undefined) {
    options.headers = {
      ...(options.headers as Record<string, string>),
      "content-length": String(Buffer.byteLength(body)),
    };
  }
  return new Promise((resolve, reject) => {
    const req = http.request(options, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        try {
          resolve({ status: res.statusCode ?? 0, payload: text ? JSON.parse(text) : null });
        } catch {
          reject(new Error("Control listener returned invalid JSON"));
        }
      });
    });
    req.setTimeout(1_500, () => req.destroy(Object.assign(new Error("Control request timed out"), { code: "ETIMEDOUT" })));
    req.on("error", reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

function pingIdentity(payload: unknown): ControlIdentity | null {
  if (!payload || typeof payload !== "object") return null;
  const identity = (payload as { identity?: unknown }).identity;
  if (!identity || typeof identity !== "object") return null;
  const value = identity as Partial<ControlIdentity>;
  return typeof value.sessionId === "string" && typeof value.nonce === "string"
    ? value as ControlIdentity
    : null;
}

let selectedTarget: DiscoveredControlRecord | null = null;

export function clearSelectedControlTarget(): void {
  selectedTarget = null;
}

export async function resolveControlTarget(
  candidates: readonly DiscoveredControlRecord[] = candidateControlRecords()
): Promise<DiscoveredControlRecord> {
  if (selectedTarget && candidates.some((candidate) =>
    candidate.path === selectedTarget?.path &&
    candidate.record.identity.sessionId === selectedTarget.record.identity.sessionId &&
    candidate.record.identity.nonce === selectedTarget.record.identity.nonce &&
    candidate.record.capability === selectedTarget.record.capability
  )) {
    return selectedTarget;
  }
  const live: DiscoveredControlRecord[] = [];
  const invalid: string[] = [];
  for (const candidate of candidates) {
    try {
      const response = await rawRequest(candidate, "/_control/ping");
      const identity = pingIdentity(response.payload);
      if (
        response.status === 200 &&
        identity?.sessionId === candidate.record.identity.sessionId &&
        identity.nonce === candidate.record.identity.nonce
      ) {
        live.push(candidate);
      } else {
        invalid.push(candidate.record.identity.sessionId);
      }
    } catch (error) {
      if (!isRetryableControlError(error)) invalid.push(candidate.record.identity.sessionId);
    }
  }
  if (live.length === 1) {
    selectedTarget = live[0];
    return live[0];
  }
  if (live.length > 1) {
    throw new Error(
      `${live.length} authenticated context-surgeon sessions are live; set CONTEXT_SURGEON_SESSION_ID explicitly`
    );
  }
  throw new Error(
    invalid.length > 0
      ? `Control identity/nonce validation failed for: ${invalid.join(", ")}`
      : "No authenticated context-surgeon control session is reachable"
  );
}

function retrySafe(init: RequestInit | undefined): boolean {
  const method = (init?.method ?? "GET").toUpperCase();
  if (method === "GET" || method === "HEAD") return true;
  if (method !== "POST" || typeof init?.body !== "string") return false;
  try {
    const body = JSON.parse(init.body) as { operationId?: unknown };
    return typeof body.operationId === "string";
  } catch { return false; }
}

export async function requestJson(path: string, init?: RequestInit): Promise<unknown> {
  const target = await resolveControlTarget();
  const delays = retrySafe(init) ? CONTROL_RETRY_DELAYS_MS : [0];
  let lastError: unknown;
  for (let attempt = 0; attempt < delays.length; attempt++) {
    if (delays[attempt] > 0) await sleep(delays[attempt]);
    try {
      const response = await rawRequest(target, path, init);
      if (response.status < 200 || response.status >= 300) {
        const error = response.payload && typeof response.payload === "object" &&
          typeof (response.payload as { error?: unknown }).error === "string"
          ? (response.payload as { error: string }).error
          : `HTTP ${response.status}`;
        throw new ControlHttpError(error, response.status);
      }
      return response.payload;
    } catch (error) {
      lastError = error;
      if (error instanceof ControlHttpError || attempt === delays.length - 1 || !isRetryableControlError(error)) break;
    }
  }
  if (lastError instanceof ControlHttpError) throw new Error(lastError.message);
  throw new Error(`Context-surgeon control is unavailable. ${flattenErrorText(lastError)}`);
}
