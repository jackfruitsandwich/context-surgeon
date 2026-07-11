import http from "node:http";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
} from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { RuntimeGuarantee } from "../src/runtime/guarantee.js";
import {
  createProductionRuntimeIntegrations,
  reportedInputTokens,
  type ProductionRuntimeIntegrations,
} from "../src/runtime/production-integrations.js";

const temporary: string[] = [];
const integrations: ProductionRuntimeIntegrations[] = [];

afterEach(async () => {
  await Promise.all(integrations.splice(0).map((value) => value.close()));
  for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true });
});

function temp(): string {
  const path = mkdtempSync("/tmp/cs-prod-");
  temporary.push(path);
  return path;
}

function create(input: { sessionsDirectory: string; sessionId?: string }) {
  const value = createProductionRuntimeIntegrations({
    target: "test",
    version: "2.0.0-test",
    ...input,
  });
  integrations.push(value);
  return value;
}

async function bootstrap(value: ProductionRuntimeIntegrations) {
  return await value.controlPlaneBootstrap({
    sessionId: value.sessionId,
    guarantee: new RuntimeGuarantee(),
  });
}

function ping(input: {
  socketPath: string;
  capability?: string;
}): Promise<{ status: number; body: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const request = http.request({
      socketPath: input.socketPath,
      path: "/_control/ping",
      headers: input.capability
        ? { authorization: `Bearer ${input.capability}` }
        : undefined,
    }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.on("end", () => resolve({
        status: response.statusCode ?? 0,
        body: JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>,
      }));
    });
    request.on("error", reject);
    request.end();
  });
}

describe("production v2 session integrations", () => {
  it("labels all-null input usage unknown instead of provider-reported zero", () => {
    expect(reportedInputTokens({
      uncached_input_tokens: null,
      cache_creation_input_tokens: null,
      cache_read_input_tokens: null,
      output_tokens: 7,
    })).toBeNull();
    expect(reportedInputTokens({
      uncached_input_tokens: 0,
      cache_creation_input_tokens: 12,
      cache_read_input_tokens: 30,
    })).toBe(42);
  });

  it("provides the control and supported-route integrations as one default-capable unit", () => {
    const value = create({ sessionsDirectory: temp() });
    expect(value.sessionId).toMatch(/^[0-9a-f]{32}$/);
    expect(value.controlPlaneBootstrap).toBeTypeOf("function");
    expect(value.supportedRouteHandler).toBeTypeOf("function");
  });

  it("creates one restrictive session and rejects the wrong capability", async () => {
    const sessionsDirectory = temp();
    const value = create({ sessionsDirectory });
    const handle = await bootstrap(value);
    const recordPath = join(value.sessionDirectory, "control.json");
    const record = JSON.parse(readFileSync(recordPath, "utf8")) as { capability: string };

    expect(readdirSync(sessionsDirectory)).toEqual([value.sessionId]);
    expect(statSync(value.sessionDirectory).mode & 0o777).toBe(0o700);
    expect(statSync(handle.address).mode & 0o777).toBe(0o600);
    expect(statSync(recordPath).mode & 0o777).toBe(0o600);
    expect((await ping({ socketPath: handle.address, capability: "wrong" })).status).toBe(401);
    expect((await ping({ socketPath: handle.address, capability: record.capability }))).toMatchObject({
      status: 200,
      body: { identity: { sessionId: value.sessionId } },
    });
  });

  it("refuses a concurrent owner without disturbing the authenticated live owner", async () => {
    const sessionsDirectory = temp();
    const sessionId = "11111111-1111-4111-8111-111111111111";
    const owner = create({ sessionsDirectory, sessionId });
    const ownerHandle = await bootstrap(owner);
    const ownerRecord = JSON.parse(
      readFileSync(join(owner.sessionDirectory, "control.json"), "utf8")
    ) as { capability: string };
    const contender = create({ sessionsDirectory, sessionId });

    await expect(bootstrap(contender)).rejects.toThrow(/live-owner/);
    expect(existsSync(ownerHandle.address)).toBe(true);
    expect((await ping({
      socketPath: ownerHandle.address,
      capability: ownerRecord.capability,
    })).status).toBe(200);
  });

  it("never removes an existing socket when a live listener is still observable", async () => {
    const sessionsDirectory = temp();
    const sessionId = "22222222-2222-4222-8222-222222222222";
    const sessionDirectory = join(sessionsDirectory, sessionId);
    const socketPath = join(sessionDirectory, "c.sock");
    mkdirSync(sessionDirectory, { recursive: true, mode: 0o700 });
    const live = http.createServer((_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end('{"listener":"live"}');
    });
    await new Promise<void>((resolve, reject) => {
      live.once("error", reject);
      live.listen(socketPath, resolve);
    });
    const contender = create({ sessionsDirectory, sessionId });
    try {
      await expect(bootstrap(contender)).rejects.toThrow(/listener responded with HTTP 200/);
      expect(existsSync(socketPath)).toBe(true);
    } finally {
      await new Promise<void>((resolve) => live.close(() => resolve()));
    }
  });

  it("cleans the socket, capability record, and writer lock idempotently", async () => {
    const value = create({ sessionsDirectory: temp() });
    const handle = await bootstrap(value);
    const recordPath = join(value.sessionDirectory, "control.json");
    const lockPath = join(value.sessionDirectory, "owner.lock");
    expect(existsSync(handle.address)).toBe(true);
    expect(existsSync(recordPath)).toBe(true);
    expect(existsSync(lockPath)).toBe(true);

    await value.close();
    await value.close();

    expect(existsSync(handle.address)).toBe(false);
    expect(existsSync(recordPath)).toBe(false);
    expect(existsSync(lockPath)).toBe(false);
    expect(existsSync(value.sessionDirectory)).toBe(true);
  });
});
