import http from "node:http";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { startProxy, type ProxyServer } from "../src/proxy/server.js";
import { startUnixControlListener } from "../src/runtime/control-listener.js";
import { policyForMode } from "../src/runtime/traffic-policy.js";
import { registerRuntimeRecord } from "../src/runtime/bootstrap.js";

const running: ProxyServer[] = [];

afterEach(async () => {
  delete process.env.CONTEXT_SURGEON_DEBUG;
  await Promise.all(running.splice(0).map((proxy) => proxy.close({ drainTimeoutMs: 50 })));
  vi.restoreAllMocks();
});

async function proxyFor(
  mode: "codex-subscription" | "codex-api-key" = "codex-subscription",
  handler?: NonNullable<Parameters<typeof startProxy>[0]["supportedRouteHandler"]>
): Promise<ProxyServer> {
  const proxy = await startProxy({
    skillMarkdown: "",
    maxTokens: 128_000,
    upstreamOpenAI: "http://127.0.0.1:9/v1",
    upstreamAnthropic: "http://127.0.0.1:9",
    upstreamChatGPT: "http://127.0.0.1:9/backend-api",
    directivesPath: null,
    trafficPolicy: policyForMode(mode),
    supportedRouteHandler: handler,
  });
  running.push(proxy);
  return proxy;
}

async function request(input: {
  port: number;
  path: string;
  method?: "GET" | "POST";
  authorization?: string;
  body?: string;
}): Promise<{ status: number; body: string }> {
  return await new Promise((resolve, reject) => {
    const method = input.method ?? "POST";
    const body = method === "POST" ? input.body ?? "{}" : "";
    const req = http.request(
      {
        host: "127.0.0.1",
        port: input.port,
        path: input.path,
        method,
        headers: {
          "content-type": "application/json",
          ...(method === "POST" ? { "content-length": Buffer.byteLength(body) } : {}),
          ...(input.authorization ? { authorization: input.authorization } : {}),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () =>
          resolve({
            status: res.statusCode ?? 0,
            body: Buffer.concat(chunks).toString("utf8"),
          })
        );
      }
    );
    req.on("error", reject);
    req.end(body);
  });
}

describe("model listener truth and isolation", () => {
  it("writes restrictive runtime records", () => {
    const directory = join(mkdtempSync(join(tmpdir(), "context-surgeon-record-parent-")), "runtime");
    const cleanup = registerRuntimeRecord(
      {
        pid: process.pid,
        sessionId: "session-test",
        target: "codex",
        mode: "subscription",
        modelPort: 1234,
        controlAddress: null,
        startedAt: new Date(0).toISOString(),
        guaranteeAtWrite: { kind: "unverified", reason: "no-proxied-request-observed" },
      },
      directory
    );
    try {
      expect(statSync(directory).mode & 0o777).toBe(0o700);
      expect(statSync(join(directory, "session-test.json")).mode & 0o777).toBe(0o600);
    } finally {
      cleanup();
      rmSync(dirname(directory), { recursive: true, force: true });
    }
  });

  it("starts unverified and no traffic never promotes it", async () => {
    const proxy = await proxyFor();
    expect(proxy.guarantee()).toEqual({
      kind: "unverified",
      reason: "no-proxied-request-observed",
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(proxy.guarantee().kind).toBe("unverified");
  });

  it("forwards Codex subscription model discovery to the ChatGPT upstream", async () => {
    let observedUrl = "";
    const upstream = http.createServer((req, res) => {
      observedUrl = req.url ?? "";
      req.resume();
      res.writeHead(200, { "content-type": "application/json" });
      res.end('{"models":[]}');
    });
    await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
    const address = upstream.address();
    if (!address || typeof address === "string") throw new Error("missing upstream port");

    const proxy = await startProxy({
      skillMarkdown: "",
      maxTokens: 128_000,
      upstreamOpenAI: "http://127.0.0.1:9/v1",
      upstreamAnthropic: "http://127.0.0.1:9",
      upstreamChatGPT: `http://127.0.0.1:${address.port}/backend-api`,
      directivesPath: null,
      trafficPolicy: policyForMode("codex-subscription"),
      supportedRouteHandler: async () => true,
    });
    running.push(proxy);
    try {
      const response = await request({
        port: proxy.modelPort,
        path: "/backend-api/codex/models?client_version=0.144.0",
        method: "GET",
        authorization: "Bearer secret",
      });
      expect(response.status).toBe(200);
      expect(observedUrl).toBe("/backend-api/codex/models?client_version=0.144.0");
      expect(proxy.guarantee().kind).toBe("unverified");
    } finally {
      await new Promise<void>((resolve) => upstream.close(() => resolve()));
    }
  });

  it("rejects a supported but wrong observed route without calling the handler", async () => {
    const handler = vi.fn(async () => ({ handled: true, attemptId: "impossible" }));
    const proxy = await proxyFor("codex-subscription", handler);
    const response = await request({
      port: proxy.modelPort,
      path: "/v1/responses",
      authorization: "Bearer secret",
    });
    expect(response.status).toBe(421);
    expect(handler).not.toHaveBeenCalled();
    expect(proxy.guarantee()).toMatchObject({ kind: "rejected" });
  });

  it("rejects the right route with the wrong authentication class", async () => {
    const handler = vi.fn(async () => ({ handled: true, attemptId: "impossible" }));
    const proxy = await proxyFor("codex-api-key", handler);
    const response = await request({ port: proxy.modelPort, path: "/v1/responses" });
    expect(response.status).toBe(401);
    expect(handler).not.toHaveBeenCalled();
    expect(proxy.guarantee()).toMatchObject({ kind: "rejected" });
  });

  it("becomes active only through the real-attempt integration seam", async () => {
    const proxy = await proxyFor("codex-api-key", async (_req, res) => {
      res.writeHead(204);
      res.end();
      return { handled: true, attemptId: "attempt-from-b1" };
    });
    const response = await request({
      port: proxy.modelPort,
      path: "/v1/responses",
      authorization: "Bearer secret",
    });
    expect(response.status).toBe(204);
    expect(proxy.guarantee()).toEqual({
      kind: "active",
      lastAttemptId: "attempt-from-b1",
    });
  });

  it("never exposes control on the model port while a Unix control listener works separately", async () => {
    if (process.platform === "win32") return;
    const directory = mkdtempSync(join(tmpdir(), "context-surgeon-control-"));
    const socketPath = join(directory, "control.sock");
    const proxy = await startProxy({
      skillMarkdown: "",
      maxTokens: 128_000,
      upstreamOpenAI: "http://127.0.0.1:9/v1",
      upstreamAnthropic: "http://127.0.0.1:9",
      upstreamChatGPT: "http://127.0.0.1:9/backend-api",
      directivesPath: null,
      sessionId: "session-control-test",
      trafficPolicy: policyForMode("codex-subscription"),
      supportedRouteHandler: async () => true,
      controlPlaneBootstrap: async () => {
        const control = await startUnixControlListener({
          socketPath,
          authenticatedHandler: (_req, res) => res.end("authenticated-control"),
        });
        return {
          address: control.address,
          childEnvironment: {
            CONTEXT_SURGEON_CONTROL_SOCKET: control.address,
          },
          close: control.close,
        };
      },
    });
    running.push(proxy);
    try {
      const publicResponse = await request({
        port: proxy.modelPort,
        path: "/_control/status",
      });
      expect(publicResponse.status).toBe(404);
      expect(proxy.controlAddress).toBe(socketPath);
      expect(proxy.controlEnvironment.CONTEXT_SURGEON_CONTROL_SOCKET).toBe(socketPath);
      expect(statSync(socketPath).mode & 0o777).toBe(0o600);

      const localBody = await new Promise<string>((resolve, reject) => {
        const req = http.request({ socketPath, path: "/_control/status" }, (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (chunk: Buffer) => chunks.push(chunk));
          res.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
        });
        req.on("error", reject);
        req.end();
      });
      expect(localBody).toBe("authenticated-control");
    } finally {
      await proxy.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("does not unlink or steal an existing Unix control socket", async () => {
    if (process.platform === "win32") return;
    const directory = mkdtempSync(join(tmpdir(), "context-surgeon-owner-"));
    const socketPath = join(directory, "control.sock");
    const owner = await startUnixControlListener({
      socketPath,
      authenticatedHandler: (_req, res) => res.end("owner-alive"),
    });
    try {
      await expect(
        startUnixControlListener({
          socketPath,
          authenticatedHandler: (_req, res) => res.end("contender"),
        })
      ).rejects.toMatchObject({ code: "EADDRINUSE" });
      expect(statSync(socketPath).mode & 0o777).toBe(0o600);
      const body = await new Promise<string>((resolve, reject) => {
        const req = http.request({ socketPath, path: "/_control/ping" }, (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (chunk: Buffer) => chunks.push(chunk));
          res.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
        });
        req.on("error", reject);
        req.end();
      });
      expect(body).toBe("owner-alive");
    } finally {
      await owner.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("bounds request drain and reports forced closure", async () => {
    const proxy = await proxyFor("codex-api-key", async () => await new Promise(() => {}));
    const pending = request({
      port: proxy.modelPort,
      path: "/v1/responses",
      authorization: "Bearer secret",
    }).catch(() => null);
    await new Promise((resolve) => setTimeout(resolve, 20));
    const report = await proxy.close({ drainTimeoutMs: 20, reason: "test drain" });
    expect(report).toMatchObject({
      reason: "test drain",
      drained: false,
      activeRequestsAtForce: 1,
    });
    await pending;
  });

  it("safe debug output never includes bodies or secret header values", async () => {
    process.env.CONTEXT_SURGEON_DEBUG = "1";
    const lines: string[] = [];
    vi.spyOn(console, "error").mockImplementation((...values) => lines.push(values.join(" ")));
    const proxy = await proxyFor("codex-api-key", async (req, res) => {
      req.resume();
      res.end("response-body-secret");
      return { handled: true, attemptId: "safe-attempt" };
    });
    await request({
      port: proxy.modelPort,
      path: "/v1/responses?token=query-secret",
      authorization: "Bearer authorization-secret",
      body: '{"input":"prompt-body-secret"}',
    });
    const output = lines.join("\n");
    expect(output).toContain("routeClass=\"surgery-capable\"");
    expect(output).not.toContain("prompt-body-secret");
    expect(output).not.toContain("response-body-secret");
    expect(output).not.toContain("authorization-secret");
    expect(output).not.toContain("query-secret");
  });
});
