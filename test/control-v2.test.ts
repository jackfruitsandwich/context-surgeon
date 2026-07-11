import http from "node:http";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import type { ControlIdentity, SessionOwner } from "../src/contracts/index.js";
import { createControlCapability, writeControlRecord } from "../src/api/control-auth.js";
import { startControlSocket } from "../src/api/control-socket.js";
import { StateControlService } from "../src/api/state-control.js";
import { ExplicitConversationCatalog } from "../src/proxy/conversations.js";
import { createOccurrence, sourceHash } from "../src/state/identity.js";
import { AtomicStateSnapshotStore } from "../src/store/state-snapshot-store.js";
import { SessionOwnershipLock, createSessionOwner } from "../src/store/session-ownership.js";
import { openOwnedSessionState } from "../src/store/session-state.js";
import {
  doctorSession,
  migrateLegacyDirectives,
  type LegacyProxyProbe,
} from "../src/store/migration.js";
import { clearSelectedControlTarget, resolveControlTarget } from "../src/cli/control-client.js";
import type { DiscoveredControlRecord } from "../src/cli/session-discovery.js";

const temporary: string[] = [];
const servers: http.Server[] = [];
afterEach(async () => {
  clearSelectedControlTarget();
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true });
});

function temp(): string {
  const path = mkdtempSync(join(tmpdir(), "cs-v2-control-"));
  temporary.push(path);
  return path;
}

function makeIdentity(sessionId: string, nonce: string): ControlIdentity {
  return {
    pid: process.pid,
    version: "2.0.0",
    sessionId,
    nonce,
    target: "test",
    startedAt: new Date().toISOString(),
    guarantee: { kind: "unverified", reason: "no-proxied-request-observed" },
  };
}

function httpJson(socketPath: string, path: string, capability?: string): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const req = http.request({
      socketPath,
      path,
      headers: capability ? { authorization: `Bearer ${capability}` } : {},
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () => resolve({
        status: res.statusCode ?? 0,
        body: JSON.parse(Buffer.concat(chunks).toString("utf8")),
      }));
    });
    req.on("error", reject);
    req.end();
  });
}

describe("authenticated control and ownership", () => {
  it("authenticates ping/status/skeleton as well as mutation on a 0600 Unix socket", async () => {
    const directory = temp();
    const sessionId = sourceHash("session");
    const conversationId = randomUUID();
    const branchId = randomUUID();
    const occurrence = createOccurrence({
      sessionId, branchId, revision: 0, kind: "user-text", sourceHash: sourceHash("hello"),
      displayLabel: "user message 1", structuralRelation: "content", providerPath: ["input", 0], mutable: true,
    });
    const catalog = new ExplicitConversationCatalog();
    catalog.publish({
      identity: { sessionId, conversationId, branchId, revision: 0, confidence: "unique-extension" },
      pristineItemHashes: [sourceHash("history")], occurrences: [occurrence], observedAt: new Date().toISOString(),
    });
    const service = new StateControlService(
      sessionId,
      AtomicStateSnapshotStore.inSessionDirectory(directory, sessionId),
      catalog
    );
    const capability = createControlCapability();
    const identity = makeIdentity(sessionId, randomUUID());
    const socketPath = join(directory, "control.sock");
    const listener = await startControlSocket(socketPath, { v2: true, capability, identity, service });
    servers.push(listener.server);
    expect(statSync(socketPath).mode & 0o777).toBe(0o600);
    expect((await httpJson(socketPath, "/_control/ping")).status).toBe(401);
    expect((await httpJson(socketPath, "/_control/ping", capability))).toMatchObject({
      status: 200, body: { identity: { sessionId, nonce: identity.nonce } },
    });
    const query = new URLSearchParams({ sessionId, conversationId, branchId });
    expect((await httpJson(socketPath, `/_control/skeleton?${query}`, capability))).toMatchObject({
      status: 200, body: { revision: 0, selection: { branchId } },
    });
  });

  it("validates session identity and nonce instead of PID liveness", async () => {
    const directory = temp();
    const sessionId = sourceHash("session");
    const capability = createControlCapability();
    const expected = makeIdentity(sessionId, "expected-nonce");
    const server = http.createServer((req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ identity: { ...expected, nonce: "wrong-nonce", pid: expected.pid } }));
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("missing address");
    const candidate: DiscoveredControlRecord = {
      path: join(directory, "control.json"),
      record: { version: 2, identity: expected, capability, address: { kind: "http", url: `http://127.0.0.1:${address.port}` } },
    };
    await expect(resolveControlTarget([candidate])).rejects.toThrow(/identity\/nonce validation failed/);
  });

  it("refuses a live owner and treats timeout/wrong identity as wedged", async () => {
    const directory = temp();
    const lockPath = join(directory, "owner.lock");
    const incumbent = createSessionOwner(join(directory, "control.sock"));
    const first = new SessionOwnershipLock("session", lockPath, incumbent, async () => ({ kind: "no-listener" }));
    expect((await first.acquire()).state).toBe("owned");
    const contender = new SessionOwnershipLock("session", lockPath, createSessionOwner("other.sock"), async () => ({
      kind: "live", sessionId: "session", nonce: incumbent.nonce,
    }));
    expect((await contender.acquire()).state).toBe("live-owner");
    const timedOut = new SessionOwnershipLock("session", lockPath, createSessionOwner("third.sock"), async () => ({ kind: "timeout" }));
    expect((await timedOut.acquire()).state).toBe("wedged-recovery-required");
    first.release();
  });

  it("does not open a second writable state store without owning the session", async () => {
    const directory = temp();
    const sessionId = sourceHash("session");
    const lockPath = join(directory, "owner.lock");
    const firstOwner = createSessionOwner(join(directory, "control.sock"));
    const firstLock = new SessionOwnershipLock(sessionId, lockPath, firstOwner, async () => ({ kind: "no-listener" }));
    const owned = await openOwnedSessionState({ sessionId, sessionDirectory: directory, ownershipLock: firstLock });
    const secondLock = new SessionOwnershipLock(sessionId, lockPath, createSessionOwner("other.sock"), async () => ({
      kind: "live", sessionId, nonce: firstOwner.nonce,
    }));
    await expect(openOwnedSessionState({ sessionId, sessionDirectory: directory, ownershipLock: secondLock }))
      .rejects.toThrow(/live-owner/);
    owned.close();
  });

  it("uses rename-CAS so concurrent stale reclaimers cannot both own", async () => {
    const directory = temp();
    const lockPath = join(directory, "owner.lock");
    mkdirSync(lockPath, { mode: 0o700 });
    const stale: SessionOwner = {
      pid: 999999, nonce: "stale", controlAddress: "missing.sock", acquiredAt: "2000-01-01T00:00:00.000Z",
    };
    writeFileSync(join(lockPath, "owner.json"), JSON.stringify(stale), { mode: 0o600 });
    const a = new SessionOwnershipLock("session", lockPath, createSessionOwner("a.sock"), async (owner) =>
      owner.nonce === "stale" ? { kind: "no-listener" } : { kind: "live", sessionId: "session", nonce: owner.nonce }
    );
    const b = new SessionOwnershipLock("session", lockPath, createSessionOwner("b.sock"), async (owner) =>
      owner.nonce === "stale" ? { kind: "no-listener" } : { kind: "live", sessionId: "session", nonce: owner.nonce }
    );
    const results = await Promise.all([a.acquire(), b.acquire()]);
    expect(results.filter((result) => result.state === "owned")).toHaveLength(1);
    expect(results.filter((result) => result.state !== "owned")).toHaveLength(1);
    a.release();
    b.release();
  });

  it("writes capability records with restrictive permissions", () => {
    const directory = temp();
    const path = join(directory, "control.json");
    writeControlRecord(path, {
      version: 2,
      identity: makeIdentity(sourceHash("session"), randomUUID()),
      capability: createControlCapability(),
      address: { kind: "unix", path: join(directory, "control.sock") },
    });
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });
});

describe("legacy migration and doctor", () => {
  function legacyFixture() {
    const root = temp();
    const legacyPath = join(root, "directives.json");
    const portsDirectory = join(root, "ports");
    const sessionDirectory = join(root, "sessions", sourceHash("session"));
    mkdirSync(portsDirectory, { recursive: true });
    writeFileSync(join(portsDirectory, "1234.json"), JSON.stringify({ pid: 1, port: 1234 }));
    writeFileSync(legacyPath, JSON.stringify({
      version: 2,
      entries: {
        abc: { directive: { type: "replace", content: "summary" }, humanId: "user message 1", preview: "secret", createdAt: 1 },
        def: { directive: { type: "evict" }, humanId: "tool call 1.1", preview: "arguments", createdAt: 2 },
      },
    }), { mode: 0o600 });
    return { root, legacyPath, portsDirectory, sessionDirectory };
  }

  it("detects live/wedged v1 before touching legacy state", async () => {
    const value = legacyFixture();
    const before = readFileSync(value.legacyPath, "utf8");
    await expect(migrateLegacyDirectives({
      ...value,
      probe: async (port): Promise<LegacyProxyProbe> => ({ port, state: "live-v1" }),
    })).rejects.toThrow(/blocked/);
    expect(readFileSync(value.legacyPath, "utf8")).toBe(before);
  });

  it("backs up v1 and imports disabled legacy-unbound evidence without previews or binding", async () => {
    const value = legacyFixture();
    const before = readFileSync(value.legacyPath, "utf8");
    const result = await migrateLegacyDirectives({
      ...value,
      probe: async (port) => ({ port, state: "no-listener" }),
      now: new Date("2026-01-02T03:04:05.000Z"),
    });
    expect(result.migrated).toBe(true);
    expect(readFileSync(value.legacyPath, "utf8")).toBe(before);
    expect(result.candidates).toMatchObject([
      { state: "legacy-unbound", bindable: false, unsafeToolCall: false },
      { state: "legacy-unbound", bindable: false, unsafeToolCall: true },
    ]);
    const imported = readFileSync(result.candidatesPath!, "utf8");
    expect(imported).not.toContain("secret");
    expect(imported).not.toContain("arguments");
    expect(statSync(result.candidatesPath!).mode & 0o777).toBe(0o600);
  });

  it("doctor is read-only and reports version, permissions, quarantine, legacy, ownership, and guarantee inputs", () => {
    const value = legacyFixture();
    mkdirSync(value.sessionDirectory, { recursive: true });
    writeFileSync(join(value.sessionDirectory, "state.json"), JSON.stringify({ version: 3, revision: 0 }), { mode: 0o600 });
    writeFileSync(join(value.sessionDirectory, "state.json.quarantine.evidence"), "bad");
    writeFileSync(join(value.sessionDirectory, "control.json"), JSON.stringify({ version: 2 }), { mode: 0o644 });
    mkdirSync(join(value.sessionDirectory, "owner.lock"));
    writeFileSync(join(value.sessionDirectory, "owner.lock", "owner.json"), JSON.stringify({ nonce: "n", controlAddress: "s" }));
    const before = readdirNames(value.sessionDirectory);
    const report = doctorSession({
      sessionId: sourceHash("session"),
      sessionDirectory: value.sessionDirectory,
      legacyPath: value.legacyPath,
    });
    expect(report).toMatchObject({
      state: { version: 3, mode: "600" },
      control: { version: 2, mode: "644" },
      legacyFileExists: true,
      ownership: "present",
      guaranteeInputs: { restrictivePermissions: false },
    });
    expect(report.quarantineFiles).toHaveLength(1);
    expect(readdirNames(value.sessionDirectory)).toEqual(before);
  });
});

function readdirNames(path: string): string[] {
  return readdirSync(path).sort();
}
