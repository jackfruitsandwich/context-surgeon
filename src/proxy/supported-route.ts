import http from "node:http";
import type { HandlerConfig } from "./handler.js";
import { transformRequest } from "./handler.js";
import { forwardToUpstream } from "./stream.js";

export function readRequestBody(req: http.IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

export function incomingHeaderRecord(
  req: http.IncomingMessage
): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const [key, value] of Object.entries(req.headers)) {
    if (typeof value === "string") {
      headers[key] = value;
    } else if (Array.isArray(value)) {
      headers[key] = value.join(", ");
    }
  }
  return headers;
}

export function isSupportedRouteRequest(method: string, url: string): boolean {
  return (
    method === "POST" &&
    (url.startsWith("/v1/responses") ||
      url.startsWith("/anthropic/v1/messages") ||
      url.startsWith("/v1/messages") ||
      url.startsWith("/v1/chat/completions") ||
      url.startsWith("/chat/completions") ||
      url.includes("/codex/responses"))
  );
}

function rawFallbackUpstream(url: string, config: HandlerConfig): string {
  if (url.includes("/codex/responses")) {
    return config.upstreamChatGPT + url.replace(/^\/backend-api/, "");
  }
  if (url.startsWith("/anthropic/")) {
    return config.upstreamAnthropic + (url.replace(/^\/anthropic/, "") || "/");
  }
  if (url.startsWith("/v1/messages")) {
    return config.upstreamAnthropic + url;
  }
  if (url.startsWith("/chat/completions")) {
    return config.upstreamOpenAI + url;
  }
  return config.upstreamOpenAI + url.replace(/^\/v1/, "");
}

/**
 * Behavior-preserving facade around the current supported request path. V2's
 * truth-core branch owns this seam; server bootstrap only routes into it.
 */
export async function handleSupportedRoute(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  config: HandlerConfig,
  debug: boolean
): Promise<boolean> {
  const url = req.url || "";
  const method = req.method || "GET";
  if (!isSupportedRouteRequest(method, url)) return false;

  const rawBody = await readRequestBody(req);
  if (debug) {
    console.error(
      `[debug] body[0..400]: ${rawBody.subarray(0, 400).toString("utf-8")}`
    );
  }
  const incomingHeaders = incomingHeaderRecord(req);
  const result = await transformRequest(
    url,
    rawBody,
    incomingHeaders,
    config
  );

  if (!result) {
    console.error(
      `[context-surgeon] WARNING: could not transform ${method} ${url} ` +
        `(encoding=${incomingHeaders["content-encoding"] ?? "none"}, ` +
        `${rawBody.length} bytes) — forwarded unmodified, directives NOT applied`
    );
    await forwardToUpstream(
      {
        url: rawFallbackUpstream(url, config),
        method,
        headers: incomingHeaders,
        body: rawBody,
      },
      res
    );
    return true;
  }

  await forwardToUpstream(
    {
      url: result.upstreamUrl,
      method,
      headers: result.headers,
      body: result.body,
      format: result.format,
      translateResponse: result.translateResponse,
      onPromptTokens: (tokens) => {
        if (result.rootFingerprint) {
          config.tracker.notePromptTokens(result.rootFingerprint, tokens);
        }
      },
    },
    res
  );
  return true;
}

