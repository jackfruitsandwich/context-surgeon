import { createHash } from "node:crypto";
import http from "node:http";
import { MAX_RECEIVED_BODY_BYTES, TruthCoreError, truthError } from "../compiler/index.js";
import type { HandlerConfig } from "./handler.js";
import { compileSupportedRequest } from "./handler.js";
import { dispatchArtifact } from "./stream.js";

export function readRequestBody(req: http.IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let length = 0;
    let rejected = false;
    req.on("data", (chunk: Buffer) => {
      if (rejected) return;
      length += chunk.length;
      if (length > MAX_RECEIVED_BODY_BYTES) {
        rejected = true;
        reject(
          new TruthCoreError(
            "Supported request body exceeds the received-size limit",
            413,
            "request-too-large"
          )
        );
        return;
      }
      chunks.push(Buffer.from(chunk));
    });
    req.on("end", () => {
      if (!rejected) resolve(Buffer.concat(chunks));
    });
    req.on("error", reject);
    req.on("aborted", () => reject(new Error("Client aborted request body")));
  });
}

export function incomingHeaderRecord(
  req: http.IncomingMessage
): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const [key, value] of Object.entries(req.headers)) {
    if (typeof value === "string") headers[key.toLowerCase()] = value;
    else if (Array.isArray(value)) headers[key.toLowerCase()] = value.join(", ");
  }
  return headers;
}

function pathname(url: string): string {
  try {
    return new URL(url, "http://context-surgeon.invalid").pathname;
  } catch {
    return "";
  }
}

export function isSupportedRouteRequest(method: string, url: string): boolean {
  if (method !== "POST") return false;
  const path = pathname(url);
  return (
    path === "/v1/responses" ||
    path === "/anthropic/v1/messages" ||
    path === "/v1/messages" ||
    path === "/v1/chat/completions" ||
    path === "/chat/completions" ||
    path === "/backend-api/codex/responses" ||
    path === "/codex/responses"
  );
}

function failClosed(
  res: http.ServerResponse,
  error: unknown,
  method: string,
  url: string
): void {
  const failure = truthError(error);
  console.error(
    `[context-surgeon] rejected supported request ${method} ${url}: ${failure.code}`
  );
  if (res.headersSent) {
    if (!res.writableEnded) res.end();
    return;
  }
  res.writeHead(failure.statusCode, {
    "content-type": "application/json",
    connection: "close",
  });
  res.end(
    JSON.stringify({
      error: "Supported surgery request rejected before upstream handoff",
      code: failure.code,
      details: failure.message,
      operationResults: failure.operationResults,
    })
  );
}

/**
 * Supported surgery facade. Once classified here, every failure is local and
 * no branch can fall through to the server's opaque forwarding path.
 */
export async function handleSupportedRoute(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  config: HandlerConfig,
  debug: boolean
): Promise<Readonly<{ handled: boolean; attemptId?: string }>> {
  const url = req.url || "";
  const method = req.method || "GET";
  if (!isSupportedRouteRequest(method, url)) return Object.freeze({ handled: false });

  let attemptId: string | undefined;
  try {
    const rawBody = await readRequestBody(req);
    if (debug) {
      const hash = createHash("sha256").update(rawBody).digest("hex");
      console.error(
        `[debug] supported request bytes=${rawBody.length} sha256=${hash} route=${url}`
      );
    }
    const result = await compileSupportedRequest(
      url,
      rawBody,
      incomingHeaderRecord(req),
      config
    );
    const receipt = await dispatchArtifact(result.artifact, res, {
      secretHeaders: result.secretHeaders,
      format: result.format,
      translateResponse: result.translateResponse,
      onAttemptReceipt: config.onAttemptReceipt,
      onAttemptObservation: config.onAttemptObservation,
    });
    result.recordAttemptOutcome(receipt);
    if (receipt.state !== "rejected-before-handoff") {
      attemptId = result.artifact.attemptId;
    }
  } catch (error) {
    failClosed(res, error, method, url);
  }
  return Object.freeze({
    handled: true,
    ...(attemptId ? { attemptId } : {}),
  });
}
