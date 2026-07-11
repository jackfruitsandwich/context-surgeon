import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { BranchSelection } from "../src/proxy/conversations.js";
import { startProxy, type ProxyServer } from "../src/proxy/server.js";
import {
  createProductionRuntimeIntegrations,
  type ProductionRuntimeIntegrations,
} from "../src/runtime/production-integrations.js";
import { policyForMode } from "../src/runtime/traffic-policy.js";
import { startFakeUpstream, type FakeUpstream } from "./fakes/upstream.js";

const temporary: string[] = [];
const proxies: ProxyServer[] = [];
const integrations: ProductionRuntimeIntegrations[] = [];
const upstreams: FakeUpstream[] = [];

afterEach(async () => {
  await Promise.all(proxies.splice(0).map((proxy) => proxy.close({ drainTimeoutMs: 100 })));
  await Promise.all(integrations.splice(0).map((value) => value.close()));
  await Promise.all(upstreams.splice(0).map((value) => value.close()));
  for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true });
});

function temp(): string {
  const path = mkdtempSync(join(tmpdir(), "cs-e2e-"));
  temporary.push(path);
  return path;
}

function modelRequest(port: number, body: Buffer): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const request = http.request(
      {
        host: "127.0.0.1",
        port,
        path: "/anthropic/v1/messages",
        method: "POST",
        headers: {
          authorization: "Bearer disposable-test-credential",
          "content-type": "application/json",
          "content-length": String(body.length),
        },
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () =>
          resolve({
            status: response.statusCode ?? 0,
            body: Buffer.concat(chunks).toString("utf8"),
          })
        );
      }
    );
    request.on("error", reject);
    request.end(body);
  });
}

function controlRequest(input: {
  socketPath: string;
  capability: string;
  path: string;
  body?: unknown;
}): Promise<{ status: number; body: any }> {
  const payload = input.body === undefined ? undefined : JSON.stringify(input.body);
  return new Promise((resolve, reject) => {
    const request = http.request(
      {
        socketPath: input.socketPath,
        path: input.path,
        method: payload === undefined ? "GET" : "POST",
        headers: {
          authorization: `Bearer ${input.capability}`,
          ...(payload === undefined
            ? {}
            : {
                "content-type": "application/json",
                "content-length": String(Buffer.byteLength(payload)),
              }),
        },
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          resolve({ status: response.statusCode ?? 0, body: text ? JSON.parse(text) : null });
        });
      }
    );
    request.on("error", reject);
    if (payload !== undefined) request.write(payload);
    request.end();
  });
}

function query(selection: BranchSelection): string {
  return new URLSearchParams(selection).toString();
}

describe("production surgery journey", () => {
  it("observes, commits, proves exact application, restores, fails closed, and cleans up", async () => {
    const upstream = await startFakeUpstream();
    upstreams.push(upstream);
    const production = createProductionRuntimeIntegrations({
      target: "claude-test",
      version: "2.0.0-test",
      sessionsDirectory: temp(),
    });
    integrations.push(production);
    const proxy = await startProxy({
      skillMarkdown: "",
      maxTokens: 128_000,
      upstreamOpenAI: `${upstream.baseUrl}/v1`,
      upstreamAnthropic: upstream.baseUrl,
      upstreamChatGPT: `${upstream.baseUrl}/backend-api`,
      target: "claude-test",
      version: "2.0.0-test",
      sessionId: production.sessionId,
      trafficPolicy: policyForMode("unrestricted-test"),
      controlPlaneBootstrap: production.controlPlaneBootstrap,
      supportedRouteHandler: production.supportedRouteHandler,
      directivesPath: null,
    });
    proxies.push(proxy);
    const record = JSON.parse(
      readFileSync(join(production.sessionDirectory, "control.json"), "utf8")
    ) as { capability: string; address: { path: string } };
    const originalText = "CONTEXT_SURGEON_E2E_ORIGINAL_PAYLOAD";
    const originalBody = Buffer.from(
      JSON.stringify({
        model: "claude-haiku-test",
        max_tokens: 8,
        messages: [
          { role: "user", content: [{ type: "text", text: originalText }] },
        ],
      }),
      "utf8"
    );

    expect((await modelRequest(proxy.modelPort, originalBody)).status).toBe(200);
    expect(proxy.guarantee()).toMatchObject({ kind: "active" });
    const selections = await controlRequest({
      socketPath: record.address.path,
      capability: record.capability,
      path: "/_control/selections",
    });
    expect(selections.status).toBe(200);
    expect(selections.body.selections).toHaveLength(1);
    const selection = selections.body.selections[0] as BranchSelection;
    const skeleton = await controlRequest({
      socketPath: record.address.path,
      capability: record.capability,
      path: `/_control/skeleton?${query(selection)}`,
    });
    const target = skeleton.body.occurrences.find(
      (occurrence: { kind: string; mutable: boolean }) =>
        occurrence.kind === "user-text" && occurrence.mutable
    );
    expect(target).toBeDefined();

    const committed = await controlRequest({
      socketPath: record.address.path,
      capability: record.capability,
      path: "/_control/mutate",
      body: {
        operationId: randomUUID(),
        ...selection,
        expectedRevision: skeleton.body.revision,
        occurrenceIds: [target.occurrenceId],
        requireComplete: true,
        action: { kind: "evict" },
      },
    });
    expect(committed.status).toBe(200);
    expect(committed.body.receipt.operationResults).toMatchObject([
      { occurrenceId: target.occurrenceId, outcome: "committed" },
    ]);

    expect((await modelRequest(proxy.modelPort, originalBody)).status).toBe(200);
    const appliedBytes = upstream.requests.at(-1)!.body;
    const appliedPayload = JSON.parse(appliedBytes.toString("utf8"));
    expect(appliedPayload.messages[0].content[0].text).toBe(
      "[Context Surgeon: evicted]"
    );
    expect(appliedBytes.toString("utf8")).not.toContain(originalText);
    const appliedStatus = await controlRequest({
      socketPath: record.address.path,
      capability: record.capability,
      path: `/_control/status?${query(selection)}`,
    });
    expect(appliedStatus.body.truth.lastAttempt.operationResults).toMatchObject([
      { occurrenceId: target.occurrenceId, outcome: "applied" },
    ]);
    expect(appliedStatus.body.truth.lastAttempt.bodyLength).toBe(appliedBytes.length);
    expect(appliedStatus.body.truth.lastAttempt.bodySha256).toBe(
      createHash("sha256").update(appliedBytes).digest("hex")
    );
    expect(appliedStatus.body.truth.ledger).toMatchObject({ persisted: true });

    const freshSkeleton = await controlRequest({
      socketPath: record.address.path,
      capability: record.capability,
      path: `/_control/skeleton?${query(selection)}`,
    });
    const surgeryId = freshSkeleton.body.occurrences.find(
      (occurrence: { occurrenceId: string }) => occurrence.occurrenceId === target.occurrenceId
    ).activeSurgeryIds[0];
    const restored = await controlRequest({
      socketPath: record.address.path,
      capability: record.capability,
      path: "/_control/mutate",
      body: {
        operationId: randomUUID(),
        ...selection,
        expectedRevision: freshSkeleton.body.revision,
        occurrenceIds: [target.occurrenceId],
        requireComplete: true,
        action: { kind: "reverse", surgeryIds: [surgeryId] },
      },
    });
    expect(restored.status).toBe(200);
    expect(restored.body.receipt.operationResults[0].outcome).toBe("committed");
    expect((await modelRequest(proxy.modelPort, originalBody)).status).toBe(200);
    expect(upstream.requests.at(-1)!.body.toString("utf8")).toContain(originalText);

    const upstreamCount = upstream.requests.length;
    expect((await modelRequest(proxy.modelPort, Buffer.from("{invalid", "utf8"))).status).toBe(400);
    expect(upstream.requests).toHaveLength(upstreamCount);

    const socketPath = record.address.path;
    await proxy.close({ reason: "production e2e complete" });
    expect(existsSync(socketPath)).toBe(false);
    expect(existsSync(join(production.sessionDirectory, "control.json"))).toBe(false);
    expect(existsSync(join(production.sessionDirectory, "attempts.jsonl"))).toBe(true);
  });
});
