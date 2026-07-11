import http from "node:http";
import net from "node:net";
import { URL } from "node:url";
import type { Directive } from "../context/types.js";
import { DirectiveStore, defaultDirectivesPath } from "../store/directive-store.js";
import { ConversationTracker } from "./conversations.js";
import type { HandlerConfig } from "./handler.js";
import { forwardToUpstream } from "./stream.js";
import {
  handleSupportedRoute,
  incomingHeaderRecord,
  readRequestBody,
} from "./supported-route.js";
import type { GuaranteeState } from "../contracts/control.js";
import {
  type ControlPlaneBootstrap,
  type ControlPlaneHandle,
} from "../runtime/control-listener.js";
import {
  consumeSafeDebugFlag,
  SafeDiagnostics,
  safePathname,
} from "../runtime/diagnostics.js";
import { RuntimeGuarantee } from "../runtime/guarantee.js";
import {
  evaluateTraffic,
  isSurgeryCapablePath,
  policyForMode,
  type ModelTrafficPolicy,
} from "../runtime/traffic-policy.js";

export type SupportedRouteHandlerResult =
  | boolean
  | Readonly<{ handled: boolean; attemptId?: string }>;

export type SupportedRouteHandler = (
  req: http.IncomingMessage,
  res: http.ServerResponse,
  config: HandlerConfig,
  debug: boolean
) => Promise<SupportedRouteHandlerResult>;

export type ProxyServerOptions = {
  skillMarkdown: string;
  maxTokens: number;
  upstreamOpenAI: string;
  upstreamAnthropic: string;
  upstreamChatGPT: string;
  target?: string;
  version?: string;
  sessionId?: string;
  trafficPolicy?: ModelTrafficPolicy;
  controlPlaneBootstrap?: ControlPlaneBootstrap;
  supportedRouteHandler?: SupportedRouteHandler;
  onGuaranteeChange?: (state: GuaranteeState) => void;
  /** Override the persistence path; null disables persistence (tests). */
  directivesPath?: string | null;
};

export type ShutdownReport = Readonly<{
  reason: string;
  drained: boolean;
  forcedConnections: number;
  activeRequestsAtForce: number;
}>;

export type ProxyServer = {
  /** Compatibility alias. This is always the model listener port. */
  port: number;
  modelPort: number;
  controlAddress: string | null;
  controlEnvironment: Readonly<NodeJS.ProcessEnv>;
  server: http.Server;
  guarantee: () => GuaranteeState;
  markAttemptActive: (attemptId: string) => void;
  close: (options?: { drainTimeoutMs?: number; reason?: string }) => Promise<ShutdownReport>;
  getShutdownDirectiveSummary: () => string | null;
};

function getUpstreamWsUrl(reqUrl: string, upstreamBase: string): string {
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
  if (directive.type === "replace") return "replace";
  if (!directive.mediaType) return "evict";
  const occurrences =
    directive.occurrences && directive.occurrences.length > 0
      ? ` (${directive.occurrences.join(",")})`
      : "";
  return `evict ${directive.mediaType}${occurrences}`;
}

function buildShutdownDirectiveSummary(directiveStore: DirectiveStore): string | null {
  const rows = [...directiveStore.getAll().values()]
    .map((entry) => `${entry.humanId} | ${describeDirectiveAction(entry.directive)}`)
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  return rows.length === 0
    ? null
    : ["Directives persisted by the legacy store:", ...rows].join("\n");
}

function jsonError(res: http.ServerResponse, status: number, error: string): void {
  res.writeHead(status, { "content-type": "application/json", connection: "close" });
  res.end(JSON.stringify({ error }));
}

function isExplicitOpaqueRoute(method: string, path: string): boolean {
  return (
    (method === "GET" && (path === "/models" || path === "/v1/models")) ||
    (method === "POST" &&
      (path === "/v1/messages/count_tokens" ||
        path === "/anthropic/v1/messages/count_tokens"))
  );
}

function opaqueUpstream(url: string, config: HandlerConfig): string {
  if (url.startsWith("/anthropic")) {
    return config.upstreamAnthropic + (url.replace(/^\/anthropic/, "") || "/");
  }
  if (url.startsWith("/v1/messages")) return config.upstreamAnthropic + url;
  if (url.startsWith("/v1")) return config.upstreamOpenAI + url.replace(/^\/v1/, "");
  return config.upstreamOpenAI + url;
}

export async function startProxy(opts: ProxyServerOptions): Promise<ProxyServer> {
  const directiveStore = new DirectiveStore(
    opts.directivesPath === undefined ? defaultDirectivesPath() : opts.directivesPath
  );
  const tracker = new ConversationTracker();
  const handlerConfig: HandlerConfig = {
    directiveStore,
    tracker,
    skillMarkdown: opts.skillMarkdown,
    maxTokens: opts.maxTokens,
    upstreamOpenAI: opts.upstreamOpenAI,
    upstreamAnthropic: opts.upstreamAnthropic,
    upstreamChatGPT: opts.upstreamChatGPT,
  };

  const diagnostics = new SafeDiagnostics(consumeSafeDebugFlag());
  const guarantee = new RuntimeGuarantee(undefined, opts.onGuaranteeChange);
  const trafficPolicy = opts.trafficPolicy ?? policyForMode("unrestricted-test");
  const supportedHandler = opts.supportedRouteHandler ?? handleSupportedRoute;
  const sockets = new Set<net.Socket>();
  let activeRequests = 0;
  let controlPlane: ControlPlaneHandle | null = null;
  let closePromise: Promise<ShutdownReport> | null = null;

  const server = http.createServer(async (req, res) => {
    activeRequests += 1;
    let completed = false;
    const complete = (): void => {
      if (completed) return;
      completed = true;
      activeRequests = Math.max(0, activeRequests - 1);
    };
    res.once("finish", complete);
    res.once("close", complete);

    const rawUrl = req.url || "";
    const path = safePathname(rawUrl);
    const method = req.method || "GET";
    diagnostics.event("model-request", {
      method,
      path,
      contentLength: req.headers["content-length"] ?? null,
      contentEncoding: req.headers["content-encoding"] ?? "identity",
      routeClass: isSurgeryCapablePath(path)
        ? "surgery-capable"
        : isExplicitOpaqueRoute(method, path)
          ? "opaque-allowlisted"
          : "unsupported",
    });

    try {
      // The model listener never serves or forwards control traffic. B2's
      // authenticated listener is a separate Unix socket/control handle.
      if (path === "/_control" || path.startsWith("/_control/")) {
        req.resume();
        jsonError(res, 404, "Control endpoints are not available on the model listener");
        return;
      }

      if (isExplicitOpaqueRoute(method, path)) {
        const body = method === "POST" ? await readRequestBody(req) : Buffer.alloc(0);
        await forwardToUpstream(
          {
            url: opaqueUpstream(rawUrl, handlerConfig),
            method,
            headers: incomingHeaderRecord(req),
            body,
          },
          res
        );
        return;
      }

      const traffic = evaluateTraffic(req, trafficPolicy);
      if (traffic.kind === "rejected-route" || traffic.kind === "rejected-auth") {
        guarantee.reject(traffic.reason);
        diagnostics.event("model-request-rejected", {
          reasonClass: traffic.kind,
          path: traffic.path,
          authClass: traffic.kind === "rejected-auth" ? traffic.authClass : undefined,
        });
        req.resume();
        jsonError(
          res,
          traffic.kind === "rejected-auth" ? 401 : 421,
          `Context surgery rejected mismatched ${traffic.kind === "rejected-auth" ? "authentication" : "route"}`
        );
        return;
      }

      if (traffic.kind === "accepted") {
        const result = await supportedHandler(req, res, handlerConfig, false);
        const handled = typeof result === "boolean" ? result : result.handled;
        const attemptId = typeof result === "boolean" ? undefined : result.attemptId;
        if (!handled) {
          guarantee.reject("expected surgery route was not handled");
          if (!res.headersSent) jsonError(res, 500, "Expected surgery route was not handled");
          return;
        }
        // B1 supplies a real dispatch-attempt id through this narrow seam.
        // The legacy facade returns no id, so the state truthfully stays unverified.
        if (attemptId) guarantee.markActive(attemptId);
        return;
      }

      req.resume();
      jsonError(res, 404, "Route is not an allowlisted model or opaque endpoint");
    } catch (error) {
      diagnostics.error("model-request-failed", error);
      if (!res.headersSent) jsonError(res, 500, "Local proxy request failed");
      else if (!res.writableEnded) res.end();
    }
  });

  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });

  server.on("upgrade", (req, socket, head) => {
    const reqUrl = req.url || "";
    const path = safePathname(reqUrl);
    if (isSurgeryCapablePath(path) || path.includes("/codex/responses")) {
      socket.write(
        "HTTP/1.1 426 Upgrade Required\r\n" +
          "Content-Type: text/plain\r\n" +
          "Connection: close\r\n\r\n" +
          "WebSocket transport is unsupported for surgery-capable routes\r\n"
      );
      socket.destroy();
      return;
    }

    const upstreamBase = reqUrl.includes("/codex/")
      ? opts.upstreamChatGPT.replace("/backend-api", "")
      : reqUrl.startsWith("/anthropic/") || reqUrl.startsWith("/v1/messages")
        ? opts.upstreamAnthropic
        : opts.upstreamOpenAI;
    const upstreamWsUrl = getUpstreamWsUrl(reqUrl, upstreamBase);
    const parsed = new URL(upstreamWsUrl.replace("wss:", "https:").replace("ws:", "http:"));
    const useTls = upstreamWsUrl.startsWith("wss:");
    const port = parsed.port ? parseInt(parsed.port, 10) : useTls ? 443 : 80;
    const headers: string[] = [];
    for (const [key, value] of Object.entries(req.headers)) {
      if (key.toLowerCase() === "host") {
        headers.push(`Host: ${parsed.host}`);
      } else if (value) {
        for (const item of Array.isArray(value) ? value : [value]) headers.push(`${key}: ${item}`);
      }
    }
    const connect = (upstream: net.Socket): void => {
      const reqLine = `GET ${parsed.pathname}${parsed.search || ""} HTTP/1.1\r\n`;
      upstream.write(reqLine + headers.join("\r\n") + "\r\n\r\n");
      if (head.length > 0) upstream.write(head);
      upstream.pipe(socket);
      socket.pipe(upstream);
      upstream.on("error", () => socket.destroy());
      socket.on("error", () => upstream.destroy());
    };
    if (useTls) {
      import("node:tls").then((tls) => {
        const upstream = tls.connect(
          { host: parsed.hostname, port, servername: parsed.hostname },
          () => connect(upstream)
        );
      }).catch(() => socket.destroy());
    } else {
      const upstream = net.connect({ host: parsed.hostname, port }, () => connect(upstream));
    }
  });

  const listenPort = parseInt(process.env.CONTEXT_SURGEON_LISTEN_PORT || "0", 10);
  let modelPort: number;
  try {
    modelPort = await new Promise<number>((resolve, reject) => {
      const onError = (error: Error): void => reject(error);
      server.once("error", onError);
      server.listen(listenPort, "127.0.0.1", () => {
        server.off("error", onError);
        const address = server.address();
        if (!address || typeof address === "string") {
          reject(new Error("Failed to get model listener address"));
          return;
        }
        resolve(address.port);
      });
    });
  } catch (error) {
    directiveStore.close();
    throw error;
  }
  server.on("error", (error) => diagnostics.error("model-listener-error", error));

  if (opts.controlPlaneBootstrap) {
    try {
      controlPlane = await opts.controlPlaneBootstrap({
        sessionId: opts.sessionId ?? "unbound",
        guarantee,
      });
    } catch (error) {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      directiveStore.close();
      throw error;
    }
  }

  diagnostics.event("listeners-ready", {
    modelPort,
    controlTransport: controlPlane ? "separate" : "not-integrated",
  });
  console.error(`[context-surgeon] Model proxy listening on 127.0.0.1:${modelPort}`);

  const close = (options: { drainTimeoutMs?: number; reason?: string } = {}): Promise<ShutdownReport> => {
    closePromise ??= (async () => {
      const drainTimeoutMs = options.drainTimeoutMs ?? 2_000;
      const reason = options.reason ?? "shutdown requested";
      const serverClosed = new Promise<void>((resolve) => server.close(() => resolve()));
      server.closeIdleConnections();
      await controlPlane?.close();

      const deadline = Date.now() + drainTimeoutMs;
      while (activeRequests > 0 && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      const activeRequestsAtForce = activeRequests;
      const forcedConnections = activeRequests > 0 ? sockets.size : 0;
      if (activeRequests > 0) {
        for (const socket of sockets) socket.destroy();
        server.closeAllConnections();
        console.error(
          `[context-surgeon] Forced model-listener close after ${drainTimeoutMs}ms: ` +
            `${activeRequestsAtForce} active request(s), ${forcedConnections} connection(s); ` +
            "delivery and billing state may be unknown"
        );
      }
      await serverClosed;
      directiveStore.close();
      diagnostics.event("listeners-closed", {
        drained: activeRequestsAtForce === 0,
        forcedConnections,
        activeRequestsAtForce,
      });
      return Object.freeze({
        reason,
        drained: activeRequestsAtForce === 0,
        forcedConnections,
        activeRequestsAtForce,
      });
    })();
    return closePromise;
  };

  return Object.freeze({
    port: modelPort,
    modelPort,
    controlAddress: controlPlane?.address ?? null,
    controlEnvironment: controlPlane?.childEnvironment ?? Object.freeze({}),
    server,
    guarantee: () => guarantee.current(),
    markAttemptActive: (attemptId: string) => guarantee.markActive(attemptId),
    close,
    getShutdownDirectiveSummary: () => buildShutdownDirectiveSummary(directiveStore),
  });
}
