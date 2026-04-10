import http from "node:http";
import https from "node:https";
import { URL } from "node:url";
import { createUsageTap, type ProviderFormat } from "./usage.js";

export type UpstreamRequestOptions = {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: Buffer;
  format?: ProviderFormat;
  onPromptTokens?: (tokens: number) => void;
};

export function forwardToUpstream(
  opts: UpstreamRequestOptions,
  clientRes: http.ServerResponse
): Promise<void> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(opts.url);
    const transport = parsed.protocol === "https:" ? https : http;

    const upstreamReq = transport.request(
      {
        hostname: parsed.hostname,
        port: parsed.port || (parsed.protocol === "https:" ? 443 : 80),
        path: parsed.pathname + parsed.search,
        method: opts.method,
        agent: false,
        headers: {
          ...opts.headers,
          host: parsed.host,
          connection: "close",
        },
      },
      (upstreamRes) => {
        const usageTap = opts.format
          ? createUsageTap(opts.format, upstreamRes.headers, opts.onPromptTokens)
          : null;

        // Copy status and headers, then pipe the response stream directly
        const responseHeaders: Record<string, string | string[]> = {};
        for (const [key, value] of Object.entries(upstreamRes.headers)) {
          if (value === undefined) continue;
          // Skip hop-by-hop headers
          if (
            key === "transfer-encoding" ||
            key === "connection" ||
            key === "keep-alive"
          ) {
            continue;
          }
          responseHeaders[key] = value;
        }

        clientRes.writeHead(upstreamRes.statusCode || 502, responseHeaders);
        if (usageTap) {
          upstreamRes.on("data", (chunk: Buffer) => usageTap.onChunk(chunk));
        }
        upstreamRes.pipe(clientRes);
        upstreamRes.on("end", () => {
          usageTap?.onEnd();
          resolve();
        });
        upstreamRes.on("error", () => {
          if (!clientRes.writableEnded) {
            clientRes.end();
          }
          resolve();
        });
      }
    );

    upstreamReq.on("error", (err) => {
      if (!clientRes.headersSent) {
        clientRes.writeHead(502, { "Content-Type": "application/json" });
        clientRes.end(JSON.stringify({ error: `Upstream error: ${err.message}` }));
        resolve();
        return;
      }
      if (!clientRes.writableEnded) {
        clientRes.end();
      }
      resolve();
    });

    if (opts.body.length > 0) {
      upstreamReq.write(opts.body);
    }
    upstreamReq.end();
  });
}
