import { createHash } from "node:crypto";
import http from "node:http";
import https from "node:https";
import { URL } from "node:url";
import type {
  AttemptReceipt,
  AttemptState,
  DispatchArtifact,
} from "../contracts/truth.js";
import {
  materializeHeaders,
  type SecretHeaderValues,
} from "../compiler/headers.js";
import {
  createUsageTap,
  type ProviderFormat,
  type ProviderUsage,
} from "./usage.js";
import { ResponsesToChatTranslator } from "./responses-to-chat.js";

export type UpstreamRequestOptions = {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: Buffer;
  format?: ProviderFormat;
  onPromptTokens?: (tokens: number) => void;
  translateResponse?: "responses-to-chat";
};

export type DispatchOptions = Readonly<{
  secretHeaders: SecretHeaderValues;
  format: ProviderFormat;
  translateResponse?: "responses-to-chat";
  onAttemptReceipt?: (receipt: AttemptReceipt) => void;
  onAttemptObservation?: (observation: AttemptObservation) => void;
}>;

export type AttemptObservation = Readonly<{
  observedAt: string;
  receipt: AttemptReceipt;
}>;

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function exactScopeHash(method: string, fullUrl: string, body: Buffer): string {
  const parts = [Buffer.from(method, "utf8"), Buffer.from(fullUrl, "utf8"), body];
  const encoded: Buffer[] = [];
  for (const part of parts) {
    const length = Buffer.allocUnsafe(8);
    length.writeBigUInt64BE(BigInt(part.length));
    encoded.push(length, part);
  }
  return sha256(Buffer.concat(encoded));
}

function responseHeaders(
  headers: http.IncomingHttpHeaders
): Record<string, string | string[]> {
  const output: Record<string, string | string[]> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (value === undefined) continue;
    if (
      key === "transfer-encoding" ||
      key === "connection" ||
      key === "keep-alive"
    ) {
      continue;
    }
    output[key] = value;
  }
  return output;
}

export function dispatchArtifact(
  artifact: DispatchArtifact,
  clientRes: http.ServerResponse,
  options: DispatchOptions
): Promise<AttemptReceipt> {
  return new Promise((resolve) => {
    let state: AttemptState = "compiled";
    let connected = false;
    let responseStatus: number | undefined;
    let usage: ProviderUsage | undefined;
    let usagePartialStream = false;
    let abortSource: AttemptReceipt["abortSource"];
    let errorMessage: string | undefined;
    let settled = false;
    let responseStarted = false;
    let upstreamReq: http.ClientRequest | undefined;
    let upstreamRes: http.IncomingMessage | undefined;

    const snapshot = (): AttemptReceipt =>
      Object.freeze({
        attemptId: artifact.attemptId,
        requestId: artifact.compiled.requestId,
        state,
        method: artifact.method,
        fullUrl: artifact.fullUrl,
        exactScopeSha256: artifact.exactScopeSha256,
        bodySha256: artifact.bodySha256,
        bodyLength: artifact.exactBody.length,
        semanticEnvelope: artifact.semanticEnvelope,
        connected,
        ...(responseStatus !== undefined ? { responseStatus } : {}),
        ...(abortSource ? { abortSource } : {}),
        ...(usage ? { usage } : {}),
        ...(usagePartialStream ? { usagePartialStream: true } : {}),
        ...(errorMessage ? { error: errorMessage } : {}),
      });

    const emit = (next: AttemptState): AttemptReceipt => {
      state = next;
      const receipt = snapshot();
      options.onAttemptReceipt?.(receipt);
      options.onAttemptObservation?.(
        Object.freeze({ observedAt: new Date().toISOString(), receipt })
      );
      return receipt;
    };

    const finish = (next: AttemptState): void => {
      if (settled) return;
      settled = true;
      const receipt = emit(next);
      resolve(receipt);
    };

    emit("compiled");

    let bytes: Buffer;
    let headers: Record<string, string>;
    try {
      bytes = artifact.exactBody.copyForHandoff();
      const actualHash = sha256(bytes);
      if (
        artifact.method !== "POST" ||
        artifact.fullUrl !== artifact.compiled.fullUrl ||
        actualHash !== artifact.bodySha256 ||
        actualHash !== artifact.compiled.bodySha256 ||
        bytes.length !== artifact.compiled.bodyLength ||
        exactScopeHash(artifact.method, artifact.fullUrl, bytes) !==
          artifact.exactScopeSha256
      ) {
        throw new Error("Dispatch artifact body integrity mismatch");
      }
      headers = materializeHeaders(artifact.semanticEnvelope, options.secretHeaders);
      if (headers["content-length"] !== String(bytes.length)) {
        throw new Error("Constructive content-length does not match exact body");
      }
    } catch (error) {
      errorMessage = error instanceof Error ? error.message : "Pre-handoff rejection";
      if (!clientRes.headersSent) {
        clientRes.writeHead(500, { "content-type": "application/json" });
        clientRes.end(JSON.stringify({ error: "Dispatch artifact rejected before handoff" }));
      }
      finish("rejected-before-handoff");
      return;
    }

    const parsed = new URL(artifact.fullUrl);
    const transport = parsed.protocol === "https:" ? https : http;
    try {
      upstreamReq = transport.request(
        {
          hostname: parsed.hostname,
          port: parsed.port || (parsed.protocol === "https:" ? 443 : 80),
          path: parsed.pathname + parsed.search,
          method: artifact.method,
          agent: false,
          headers,
        },
        (response) => {
          upstreamRes = response;
          responseStarted = true;
          responseStatus = response.statusCode || 502;
          emit("response-started");
          const usageTap = createUsageTap(
            options.format,
            response.headers,
            undefined,
            (reported) => {
              usage = reported;
            }
          );
          response.on("data", (chunk: Buffer) => usageTap?.onChunk(chunk));

          clientRes.writeHead(responseStatus, responseHeaders(response.headers));
          const shouldTranslate =
            options.translateResponse === "responses-to-chat" &&
            (response.headers["content-type"] ?? "").includes("event-stream");
          if (shouldTranslate) {
            const translator = new ResponsesToChatTranslator();
            response.on("data", (chunk: Buffer) => {
              const translated = translator.translate(chunk);
              if (translated.length > 0 && !clientRes.writableEnded) {
                clientRes.write(translated);
              }
            });
          } else {
            response.on("data", (chunk: Buffer) => {
              if (!clientRes.writableEnded) clientRes.write(chunk);
            });
          }

          const abortResponse = (source: "client" | "upstream" | "unknown", error?: Error) => {
            if (settled) return;
            abortSource = source;
            errorMessage = error?.message;
            usageTap?.onAborted();
            usage = usageTap?.latestUsage() ?? usage;
            usagePartialStream = usage !== undefined;
            if (!clientRes.writableEnded) clientRes.end();
            finish("response-aborted");
          };

          response.once("aborted", () => abortResponse("upstream"));
          response.once("error", (error) => abortResponse("upstream", error));
          response.once("end", () => {
            if (settled) return;
            usageTap?.onEnd();
            usage = usageTap?.latestUsage() ?? usage;
            if (!clientRes.writableEnded) clientRes.end();
            finish("response-completed");
          });
          response.once("close", () => {
            if (!settled && !response.complete) abortResponse("upstream");
          });
        }
      );
    } catch (error) {
      errorMessage = error instanceof Error ? error.message : "HTTP handoff failed";
      if (!clientRes.headersSent) {
        clientRes.writeHead(502, { "content-type": "application/json" });
        clientRes.end(JSON.stringify({ error: "Upstream request could not be created" }));
      }
      finish("rejected-before-handoff");
      return;
    }

    upstreamReq.once("socket", (socket) => {
      if (parsed.protocol === "https:") {
        socket.once("secureConnect", () => {
          connected = true;
        });
      } else {
        socket.once("connect", () => {
          connected = true;
        });
      }
    });
    upstreamReq.once("finish", () => {
      if (!settled) emit("request-stream-finished-locally");
    });
    upstreamReq.once("error", (error) => {
      if (settled) return;
      errorMessage = error.message;
      if (responseStarted) {
        abortSource = "upstream";
        usagePartialStream = usage !== undefined;
        if (!clientRes.writableEnded) clientRes.end();
        finish("response-aborted");
        return;
      }
      if (!clientRes.headersSent) {
        clientRes.writeHead(502, { "content-type": "application/json" });
        clientRes.end(JSON.stringify({ error: `Upstream error: ${error.message}` }));
      } else if (!clientRes.writableEnded) {
        clientRes.end();
      }
      finish(
        connected
          ? "failed-after-connection-delivery-unknown"
          : "failed-no-connection"
      );
    });

    clientRes.once("close", () => {
      if (settled || clientRes.writableEnded) return;
      abortSource = "client";
      if (responseStarted) {
        usagePartialStream = usage !== undefined;
        upstreamRes?.destroy();
        finish("response-aborted");
      } else {
        upstreamReq?.destroy();
        finish(
          connected
            ? "failed-after-connection-delivery-unknown"
            : "failed-no-connection"
        );
      }
    });

    // This is the only supported-route handoff. The integrity check above is
    // repeated here at the last synchronous boundary before Node sees bytes.
    if (
      sha256(bytes) !== artifact.bodySha256 ||
      exactScopeHash(artifact.method, artifact.fullUrl, bytes) !==
        artifact.exactScopeSha256
    ) {
      errorMessage = "Dispatch artifact changed before HTTP handoff";
      upstreamReq.destroy();
      if (!clientRes.headersSent) {
        clientRes.writeHead(500, { "content-type": "application/json" });
        clientRes.end(JSON.stringify({ error: "Dispatch artifact rejected before handoff" }));
      }
      finish("rejected-before-handoff");
      return;
    }
    emit("handed-to-http");
    upstreamReq.end(bytes);
  });
}

/** Opaque forwarding for endpoints explicitly outside the surgery route set. */
export function forwardToUpstream(
  opts: UpstreamRequestOptions,
  clientRes: http.ServerResponse
): Promise<void> {
  return new Promise((resolve) => {
    const parsed = new URL(opts.url);
    const transport = parsed.protocol === "https:" ? https : http;
    const upstreamReq = transport.request(
      {
        hostname: parsed.hostname,
        port: parsed.port || (parsed.protocol === "https:" ? 443 : 80),
        path: parsed.pathname + parsed.search,
        method: opts.method,
        agent: false,
        headers: { ...opts.headers, host: parsed.host, connection: "close" },
      },
      (upstreamRes) => {
        const usageTap = opts.format
          ? createUsageTap(opts.format, upstreamRes.headers, opts.onPromptTokens)
          : null;
        upstreamRes.on("data", (chunk: Buffer) => usageTap?.onChunk(chunk));
        clientRes.writeHead(
          upstreamRes.statusCode || 502,
          responseHeaders(upstreamRes.headers)
        );
        const shouldTranslate =
          opts.translateResponse === "responses-to-chat" &&
          (upstreamRes.headers["content-type"] ?? "").includes("event-stream");
        if (shouldTranslate) {
          const translator = new ResponsesToChatTranslator();
          upstreamRes.on("data", (chunk: Buffer) => {
            const translated = translator.translate(chunk);
            if (translated.length > 0) clientRes.write(translated);
          });
        } else {
          upstreamRes.on("data", (chunk: Buffer) => clientRes.write(chunk));
        }
        upstreamRes.once("end", () => {
          usageTap?.onEnd();
          if (!clientRes.writableEnded) clientRes.end();
          resolve();
        });
        upstreamRes.once("aborted", () => {
          usageTap?.onAborted();
          if (!clientRes.writableEnded) clientRes.end();
          resolve();
        });
        upstreamRes.once("error", () => {
          usageTap?.onAborted();
          if (!clientRes.writableEnded) clientRes.end();
          resolve();
        });
      }
    );
    upstreamReq.once("error", (error) => {
      if (!clientRes.headersSent) {
        clientRes.writeHead(502, { "content-type": "application/json" });
        clientRes.end(JSON.stringify({ error: `Upstream error: ${error.message}` }));
      } else if (!clientRes.writableEnded) {
        clientRes.end();
      }
      resolve();
    });
    upstreamReq.end(opts.body);
  });
}
