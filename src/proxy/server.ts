import http from "node:http";
import net from "node:net";
import { URL } from "node:url";
import type { Directive } from "../context/types.js";
import type { SkeletonItem } from "../context/skeleton.js";
import { DirectiveStore } from "../store/directive-store.js";
import { ShadowStore } from "../store/shadow-store.js";
import { handleControl } from "../api/control.js";
import { transformRequest, type HandlerConfig } from "./handler.js";
import { forwardToUpstream } from "./stream.js";

export type ProxyServerOptions = {
  skillMarkdown: string;
  maxTokens: number;
  upstreamOpenAI: string;
  upstreamAnthropic: string;
  upstreamChatGPT: string;
};

export type ProxyServer = {
  port: number;
  server: http.Server;
  close: () => void;
  getShutdownDirectiveSummary: () => string | null;
};

function readRequestBody(req: http.IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function getUpstreamWsUrl(
  reqUrl: string,
  upstreamBase: string
): string {
  const base = new URL(upstreamBase);
  const wsProtocol = base.protocol === "https:" ? "wss:" : "ws:";
  let pathSuffix = reqUrl;

  if (reqUrl.startsWith("/backend-api")) {
    pathSuffix = reqUrl.replace(/^\/backend-api/, "");
  } else if (reqUrl.startsWith("/anthropic")) {
    pathSuffix = reqUrl.replace(/^\/anthropic/, "") || "/";
  } else if (base.pathname.endsWith("/v1") && reqUrl.startsWith("/v1")) {
    pathSuffix = reqUrl.replace(/^\/v1/, "");
  }

  return `${wsProtocol}//${base.host}${base.pathname.replace(/\/+$/, "")}${pathSuffix}`;
}

function describeDirectiveAction(directive: Directive): string {
  if (directive.type === "replace") {
    return "replace";
  }

  if (!directive.mediaType) {
    return "evict";
  }

  const occurrences =
    directive.occurrences && directive.occurrences.length > 0
      ? ` (${directive.occurrences.join(",")})`
      : "";

  return `evict ${directive.mediaType}${occurrences}`;
}

function buildShutdownDirectiveSummary(
  directiveStore: DirectiveStore
): string | null {
  const rows = [...directiveStore.getAll().entries()]
    .map(([id, directive]) => `${id} | ${describeDirectiveAction(directive)}`)
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));

  if (rows.length === 0) {
    return null;
  }

  return ["Active directives:", ...rows].join("\n");
}

export function startProxy(opts: ProxyServerOptions): Promise<ProxyServer> {
  const directiveStore = new DirectiveStore();
  const shadowStore = new ShadowStore();
  let latestExactPromptTokens: number | null = null;
  let latestPromptTokens: number | null = null;
  let previousSkeleton: string[] | null = null;
  let currentSkeletonItems: SkeletonItem[] | null = null;

  const handlerConfig: HandlerConfig = {
    directiveStore,
    shadowStore,
    skillMarkdown: opts.skillMarkdown,
    maxTokens: opts.maxTokens,
    upstreamOpenAI: opts.upstreamOpenAI,
    upstreamAnthropic: opts.upstreamAnthropic,
    upstreamChatGPT: opts.upstreamChatGPT,
    getLatestExactPromptTokens: () => latestExactPromptTokens,
    getPreviousSkeleton: () => previousSkeleton,
    setPreviousSkeleton: (skeleton) => {
      previousSkeleton = [...skeleton];
    },
    setCurrentSkeletonItems: (items) => {
      currentSkeletonItems = items.map((item) => ({ ...item }));
    },
  };

  const debug = !!process.env.CONTEXT_SURGEON_DEBUG;

  const server = http.createServer(async (req, res) => {
    const url = req.url || "";
    const method = req.method || "GET";

    if (debug) {
      console.error(
        `[debug] ${method} ${url} encoding=${req.headers["content-encoding"] ?? "none"} type=${req.headers["content-type"] ?? "?"}`
      );
    }

    try {
      // Control API
      if (url.startsWith("/_control")) {
        await handleControl(
          req,
          res,
          directiveStore,
          shadowStore,
          latestPromptTokens,
          opts.maxTokens,
          currentSkeletonItems
        );
        return;
      }

      // Proxy API requests (OpenAI /v1/responses, ChatGPT /backend-api/codex/responses, Anthropic /v1/messages)
      const isProxyable =
        method === "POST" &&
        (url.startsWith("/v1/responses") ||
          url.startsWith("/anthropic/v1/messages") ||
          url.startsWith("/v1/messages") ||
          url.startsWith("/v1/chat/completions") ||
          url.startsWith("/chat/completions") ||
          url.includes("/codex/responses"));

      if (isProxyable) {
        const rawBody = await readRequestBody(req);

        if (debug) {
          console.error(
            `[debug] body[0..400]: ${rawBody.subarray(0, 400).toString("utf-8")}`
          );
        }

        const incomingHeaders: Record<string, string> = {};
        for (const [key, value] of Object.entries(req.headers)) {
          if (typeof value === "string") {
            incomingHeaders[key] = value;
          } else if (Array.isArray(value)) {
            incomingHeaders[key] = value.join(", ");
          }
        }

        const result = await transformRequest(
          url,
          rawBody,
          incomingHeaders,
          handlerConfig
        );

        if (!result) {
          // Determine upstream for raw forward
          let rawUpstream: string;
          if (url.includes("/codex/responses")) {
            rawUpstream = handlerConfig.upstreamChatGPT + url.replace(/^\/backend-api/, "");
          } else if (url.startsWith("/anthropic/")) {
            rawUpstream =
              handlerConfig.upstreamAnthropic + (url.replace(/^\/anthropic/, "") || "/");
          } else if (url.startsWith("/v1/messages")) {
            rawUpstream = handlerConfig.upstreamAnthropic + url;
          } else if (url.startsWith("/chat/completions")) {
            rawUpstream = handlerConfig.upstreamOpenAI + url;
          } else {
            rawUpstream = handlerConfig.upstreamOpenAI + url.replace(/^\/v1/, "");
          }
          await forwardToUpstream(
            {
              url: rawUpstream,
              method,
              headers: incomingHeaders,
              body: rawBody,
            },
            res
          );
          return;
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
              if (!result.updatesConversationState) {
                return;
              }
              latestExactPromptTokens = tokens;
              latestPromptTokens = tokens;
            },
          },
          res
        );
        if (result.updatesConversationState) {
          latestPromptTokens = result.statusSummary.promptTokens;
        }
        return;
      }

      // Forward any other request to the appropriate upstream
      const rawBody = method === "POST" || method === "PUT" || method === "PATCH"
        ? await readRequestBody(req)
        : Buffer.alloc(0);

      const incomingHeaders: Record<string, string> = {};
      for (const [key, value] of Object.entries(req.headers)) {
        if (typeof value === "string") {
          incomingHeaders[key] = value;
        } else if (Array.isArray(value)) {
          incomingHeaders[key] = value.join(", ");
        }
      }

      // Route based on path prefix
      let upstream: string;
      if (url.startsWith("/backend-api")) {
        upstream = handlerConfig.upstreamChatGPT + url.replace(/^\/backend-api/, "");
      } else if (url.startsWith("/anthropic")) {
        upstream =
          handlerConfig.upstreamAnthropic + (url.replace(/^\/anthropic/, "") || "/");
      } else if (url.startsWith("/v1/messages")) {
        upstream = handlerConfig.upstreamAnthropic + url;
      } else if (url.startsWith("/v1")) {
        upstream = handlerConfig.upstreamOpenAI + url.replace(/^\/v1/, "");
      } else if (url.startsWith("/chat/completions") || url.startsWith("/models")) {
        // Cursor probes the BYOK base URL without a /v1 prefix when the
        // override URL already ends in /v1
        upstream = handlerConfig.upstreamOpenAI + url;
      } else {
        upstream = handlerConfig.upstreamChatGPT + url;
      }

      await forwardToUpstream(
        { url: upstream, method, headers: incomingHeaders, body: rawBody },
        res
      );
    } catch (err) {
      if (!res.headersSent) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            error: err instanceof Error ? err.message : "Internal error",
          })
        );
      }
    }
  });

  // Handle WebSocket upgrade requests
  server.on("upgrade", (req, socket, head) => {
    const reqUrl = req.url || "";

    // Reject WebSocket for /responses paths — force HTTP fallback
    // so our transform pipeline can intercept and modify the request.
    if (reqUrl.includes("/responses")) {
      socket.write(
        "HTTP/1.1 404 Not Found\r\n" +
          "Content-Type: text/plain\r\n" +
          "Connection: close\r\n\r\n" +
          "WebSocket not supported by context-surgeon proxy\r\n"
      );
      socket.destroy();
      return;
    }

    // For other WebSocket paths, pass through to upstream
    const upstreamBase = reqUrl.includes("/codex/")
      ? opts.upstreamChatGPT.replace("/backend-api", "")
      : reqUrl.startsWith("/anthropic/") || reqUrl.startsWith("/v1/messages")
        ? opts.upstreamAnthropic
      : opts.upstreamOpenAI;
    const upstreamWsUrl = getUpstreamWsUrl(reqUrl, upstreamBase);
    const parsed = new URL(upstreamWsUrl.replace("wss:", "https:").replace("ws:", "http:"));
    const useTls = upstreamWsUrl.startsWith("wss:");
    const port = parsed.port
      ? parseInt(parsed.port, 10)
      : useTls
        ? 443
        : 80;

    // Build the upgrade request headers
    const headers: string[] = [];
    for (const [key, value] of Object.entries(req.headers)) {
      if (key.toLowerCase() === "host") {
        headers.push(`Host: ${parsed.host}`);
        continue;
      }
      if (value) {
        const vals = Array.isArray(value) ? value : [value];
        for (const v of vals) {
          headers.push(`${key}: ${v}`);
        }
      }
    }

    const connectOpts = {
      host: parsed.hostname,
      port,
    };

    if (useTls) {
      // For TLS, use tls.connect
      import("node:tls").then((tls) => {
        const upstream = tls.connect(
          { host: parsed.hostname, port, servername: parsed.hostname },
          () => {
            // Send the HTTP upgrade request
            const reqLine = `GET ${parsed.pathname}${parsed.search || ""} HTTP/1.1\r\n`;
            upstream.write(reqLine + headers.join("\r\n") + "\r\n\r\n");
            if (head.length > 0) upstream.write(head);

            // Pipe both directions
            upstream.pipe(socket);
            socket.pipe(upstream);
          }
        );

        upstream.on("error", () => {
          socket.destroy();
        });

        socket.on("error", () => upstream.destroy());
      });
    } else {
      // Plain TCP
      const upstream = net.connect(connectOpts, () => {
        const reqLine = `GET ${parsed.pathname}${parsed.search || ""} HTTP/1.1\r\n`;
        upstream.write(reqLine + headers.join("\r\n") + "\r\n\r\n");
        if (head.length > 0) upstream.write(head);

        upstream.pipe(socket);
        socket.pipe(upstream);
      });

      upstream.on("error", () => {
        socket.destroy();
      });

      socket.on("error", () => upstream.destroy());
    }
  });

  return new Promise((resolve, reject) => {
    const listenPort = parseInt(process.env.CONTEXT_SURGEON_LISTEN_PORT || "0", 10);
    server.listen(listenPort, "127.0.0.1", () => {
      const addr = server.address();
      if (!addr || typeof addr === "string") {
        reject(new Error("Failed to get server address"));
        return;
      }
      const port = addr.port;
      console.error(`[context-surgeon] Proxy listening on 127.0.0.1:${port}`);
      resolve({
        port,
        server,
        close: () => server.close(),
        getShutdownDirectiveSummary: () =>
          buildShutdownDirectiveSummary(directiveStore),
      });
    });

    server.on("error", reject);
  });
}
