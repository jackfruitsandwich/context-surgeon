import { randomBytes } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  rmSync,
  unlinkSync,
} from "node:fs";
import http from "node:http";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import {
  createControlCapability,
  type ControlRecord,
  writeControlRecord,
} from "../api/control-auth.js";
import { startControlSocket, type ControlSocketServer } from "../api/control-socket.js";
import { StateControlService } from "../api/state-control.js";
import type { ControlIdentity } from "../contracts/control.js";
import type { AttemptReceipt } from "../contracts/truth.js";
import type { IdentityResolver, ResolvedIdentity } from "../contracts/state.js";
import { ExplicitConversationCatalog } from "../proxy/conversations.js";
import type { HandlerConfig } from "../proxy/handler.js";
import { handleSupportedRoute } from "../proxy/supported-route.js";
import type { SupportedRouteHandler } from "../proxy/server.js";
import { PristineHistoryTracker } from "../state/identity.js";
import {
  createSessionOwner,
  SessionOwnershipLock,
  type OwnerProbeResult,
} from "../store/session-ownership.js";
import {
  openOwnedSessionState,
  type OwnedSessionState,
} from "../store/session-state.js";
import { doctorSession } from "../store/migration.js";
import type {
  ControlPlaneBootstrap,
  ControlPlaneHandle,
} from "./control-listener.js";
import { AttemptLedger } from "./attempt-ledger.js";
import { loadOrCreateCacheHmacSecret } from "../cache/key-store.js";

const DEFAULT_PROBE_TIMEOUT_MS = 750;

export function reportedInputTokens(
  usage: Readonly<Record<string, number | null>> | undefined
): number | null {
  if (!usage) return null;
  if (typeof usage.input_tokens === "number") return usage.input_tokens;
  if (typeof usage.prompt_tokens === "number") return usage.prompt_tokens;
  const anthropic = [
    usage.uncached_input_tokens,
    usage.cache_creation_input_tokens,
    usage.cache_read_input_tokens,
  ];
  return anthropic.some((value) => typeof value === "number")
    ? anthropic.reduce<number>(
        (sum, value) => sum + (typeof value === "number" ? value : 0),
        0
      )
    : null;
}

export type ProductionV2Session = Readonly<{
  sessionId: string;
  identityResolver: IdentityResolver;
  store: OwnedSessionState["store"];
  catalog: ExplicitConversationCatalog;
  cacheHmacSecret: Uint8Array;
}>;

type ProductionHandlerConfig = HandlerConfig & Readonly<{
  v2Session: ProductionV2Session;
}>;

export type ProductionRuntimeIntegrations = Readonly<{
  sessionId: string;
  sessionDirectory: string;
  controlPlaneBootstrap: ControlPlaneBootstrap;
  supportedRouteHandler: SupportedRouteHandler;
  close(): Promise<void>;
}>;

export type ProductionIntegrationOptions = Readonly<{
  target: string;
  version: string;
  sessionId?: string;
  sessionsDirectory?: string;
  probeTimeoutMs?: number;
}>;

class LaunchIdentityResolver implements IdentityResolver {
  private readonly histories: PristineHistoryTracker;

  constructor(readonly sessionId: string) {
    this.histories = new PristineHistoryTracker(sessionId);
  }

  restore(branches: Parameters<PristineHistoryTracker["restore"]>[0]): void {
    this.histories.restore(branches);
  }

  resolve(input: {
    nativeSessionId?: string;
    explicitSessionId?: string;
    pristineItemHashes: readonly string[];
  }): ResolvedIdentity {
    if (input.nativeSessionId || input.explicitSessionId) {
      return Object.freeze({
        sessionId: this.sessionId,
        conversationId: "",
        branchId: "",
        revision: 0,
        confidence: "ambiguous" as const,
        reason: "request authority was not proven when this launch session was created",
      });
    }
    return this.histories.observe(input.pristineItemHashes).identity;
  }
}

function isControlRecord(value: unknown): value is ControlRecord {
  if (!value || typeof value !== "object") return false;
  const record = value as Partial<ControlRecord>;
  return (
    record.version === 2 &&
    typeof record.capability === "string" &&
    !!record.identity &&
    typeof record.identity.sessionId === "string" &&
    typeof record.identity.nonce === "string" &&
    record.address?.kind === "unix" &&
    typeof record.address.path === "string"
  );
}

function readProbeRecord(path: string, controlAddress: string): ControlRecord | null {
  try {
    const value = JSON.parse(readFileSync(path, "utf8")) as unknown;
    if (!isControlRecord(value) || value.address.kind !== "unix") return null;
    return value.address.path === controlAddress ? value : null;
  } catch {
    return null;
  }
}

function probeUnixControl(input: {
  controlAddress: string;
  recordPath: string;
  timeoutMs: number;
}): Promise<OwnerProbeResult> {
  const record = readProbeRecord(input.recordPath, input.controlAddress);
  return new Promise((resolve) => {
    let settled = false;
    let timedOut = false;
    let request: http.ClientRequest;
    const deadline = setTimeout(() => {
      timedOut = true;
      request?.destroy(Object.assign(new Error("Owner ping timed out"), { code: "ETIMEDOUT" }));
    }, input.timeoutMs);
    const finish = (result: OwnerProbeResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      resolve(result);
    };
    request = http.request(
      {
        socketPath: input.controlAddress,
        path: "/_control/ping",
        method: "GET",
        headers: record
          ? { authorization: `Bearer ${record.capability}` }
          : undefined,
      },
      (response) => {
        const chunks: Buffer[] = [];
        let length = 0;
        response.on("data", (chunk: Buffer) => {
          length += chunk.length;
          if (length <= 64 * 1024) chunks.push(Buffer.from(chunk));
        });
        response.on("end", () => {
          if (length > 64 * 1024) {
            finish({ kind: "wrong-response", reason: "Owner ping response exceeded 64 KiB" });
            return;
          }
          try {
            const payload = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
              identity?: { sessionId?: unknown; nonce?: unknown };
            };
            if (
              response.statusCode === 200 &&
              typeof payload.identity?.sessionId === "string" &&
              typeof payload.identity.nonce === "string"
            ) {
              finish({
                kind: "live",
                sessionId: payload.identity.sessionId,
                nonce: payload.identity.nonce,
              });
              return;
            }
            finish({
              kind: "wrong-response",
              reason: `A control listener responded with HTTP ${response.statusCode ?? "unknown"}`,
            });
          } catch {
            finish({ kind: "wrong-response", reason: "A control listener returned invalid JSON" });
          }
        });
        response.on("aborted", () => {
          finish({ kind: "wrong-response", reason: "A control listener aborted its ping response" });
        });
      }
    );
    request.setTimeout(input.timeoutMs, () => {
      timedOut = true;
      request.destroy(Object.assign(new Error("Owner ping timed out"), { code: "ETIMEDOUT" }));
    });
    request.on("error", (error: NodeJS.ErrnoException) => {
      if (timedOut || error.code === "ETIMEDOUT") {
        finish({ kind: "timeout" });
        return;
      }
      if (["ENOENT", "ECONNREFUSED", "ENOTSOCK"].includes(error.code ?? "")) {
        finish({ kind: "no-listener" });
        return;
      }
      finish({
        kind: "wrong-response",
        reason: `Owner liveness could not be proven absent: ${error.code ?? error.message}`,
      });
    });
    request.end();
  });
}

function removeOwnedRecord(path: string, nonce: string): void {
  try {
    const record = JSON.parse(readFileSync(path, "utf8")) as Partial<ControlRecord>;
    if (record.identity?.nonce === nonce) unlinkSync(path);
  } catch {}
}

function ensureSessionDirectory(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  chmodSync(path, 0o700);
}

/**
 * Composes the v2 state, control, identity, and truth-route seams for one
 * production launch. No writable store or stale socket is touched until the
 * OS-visible writer lock has been acquired.
 */
export function createProductionRuntimeIntegrations(
  options: ProductionIntegrationOptions
): ProductionRuntimeIntegrations {
  if (process.platform === "win32") {
    throw new Error("Production v2 sessions require a mode-0600 Unix control socket");
  }

  const sessionId = options.sessionId ?? randomBytes(16).toString("hex");
  const sessionsDirectory =
    options.sessionsDirectory ??
    process.env.CONTEXT_SURGEON_SESSIONS_DIRECTORY ??
    join(homedir(), ".context-surgeon", "sessions");
  const sessionDirectory = join(sessionsDirectory, sessionId);
  const socketPath = join(sessionDirectory, "c.sock");
  const recordPath = join(sessionDirectory, "control.json");
  const lockPath = join(sessionDirectory, "owner.lock");
  const legacyPath = join(dirname(sessionsDirectory), "directives.json");
  const probeTimeoutMs = options.probeTimeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
  const capability = createControlCapability();
  const owner = createSessionOwner(socketPath);
  const identityResolver = new LaunchIdentityResolver(sessionId);
  const catalog = new ExplicitConversationCatalog();
  const ownershipLock = new SessionOwnershipLock(
    sessionId,
    lockPath,
    owner,
    (candidate) => probeUnixControl({
      controlAddress: candidate.controlAddress,
      recordPath,
      timeoutMs: probeTimeoutMs,
    })
  );

  let ownedState: OwnedSessionState | null = null;
  let controlSocket: ControlSocketServer | null = null;
  let v2Session: ProductionV2Session | null = null;
  let recordWritten = false;
  let recordWriteAttempted = false;
  let attemptLedger: AttemptLedger | null = null;
  let attemptLedgerError: string | null = null;
  let socketRemovalAuthorized = false;
  let bootstrapping = false;
  let bootstrapped = false;
  let closed = false;
  let closePromise: Promise<void> | null = null;

  const close = (): Promise<void> => {
    closePromise ??= (async () => {
      closed = true;
      const socket = controlSocket;
      controlSocket = null;
      if (socket) {
        socket.server.closeAllConnections();
        try { await socket.close(); } catch {}
      }
      if (recordWriteAttempted || recordWritten) {
        removeOwnedRecord(recordPath, owner.nonce);
        recordWritten = false;
        recordWriteAttempted = false;
      }
      if (socketRemovalAuthorized || socket) {
        try {
          if (existsSync(socketPath) && lstatSync(socketPath).isSocket()) unlinkSync(socketPath);
        } catch {}
      }
      ownedState?.close();
      ownedState = null;
      v2Session = null;
    })();
    return closePromise;
  };

  const controlPlaneBootstrap: ControlPlaneBootstrap = async (input): Promise<ControlPlaneHandle> => {
    if (closed) throw new Error("Production v2 session integrations are already closed");
    if (bootstrapping || bootstrapped) {
      throw new Error("Production v2 control bootstrap may run only once");
    }
    if (input.sessionId !== sessionId) {
      throw new Error("Proxy session identity does not match production v2 integrations");
    }
    bootstrapping = true;
    try {
      ensureSessionDirectory(sessionsDirectory);
      ensureSessionDirectory(sessionDirectory);
      ownedState = await openOwnedSessionState({
        sessionId,
        sessionDirectory,
        ownershipLock,
      });
      identityResolver.restore(
        ownedState.store.current(sessionId).bootstrapBranches
      );
      const cacheHmacSecret = loadOrCreateCacheHmacSecret(sessionDirectory, {
        allowCreate:
          ownedState.store.current(sessionId).bootstrapBranches.length === 0,
      });

      const socketProbe = await probeUnixControl({
        controlAddress: socketPath,
        recordPath,
        timeoutMs: probeTimeoutMs,
      });
      if (socketProbe.kind !== "no-listener") {
        throw new Error(
          socketProbe.kind === "timeout"
            ? "Existing control socket liveness timed out; recovery is required"
            : socketProbe.kind === "live"
              ? "A live control listener still owns the session socket"
              : socketProbe.reason
        );
      }
      socketRemovalAuthorized = true;
      try {
        if (existsSync(socketPath)) unlinkSync(socketPath);
      } catch (error) {
        throw new Error(
          `Provably stale control socket could not be removed: ${error instanceof Error ? error.message : String(error)}`
        );
      }
      if (ownedState.ownership.stalePath) {
        rmSync(ownedState.ownership.stalePath, { recursive: true, force: true });
      }

      v2Session = Object.freeze({
        sessionId,
        identityResolver,
        store: ownedState.store,
        catalog,
        cacheHmacSecret,
      });
      attemptLedger = new AttemptLedger(sessionDirectory);
      const identity: ControlIdentity = Object.freeze({
        pid: process.pid,
        version: options.version,
        sessionId,
        nonce: owner.nonce,
        target: options.target,
        startedAt: owner.acquiredAt,
        get guarantee() { return input.guarantee.current(); },
      });
      const service = new StateControlService(
        sessionId,
        ownedState.store,
        catalog,
        undefined,
        (selection) => {
          const observation = attemptLedger?.latest(selection.branchId) ?? null;
          const receipt = observation?.receipt ?? null;
          const usage = receipt?.usage;
          const inputTokens = reportedInputTokens(usage);
          const persisted = attemptLedger?.inspection().exists === true && !attemptLedgerError;
          return Object.freeze({
            guarantee: input.guarantee.current(),
            lastAttempt: receipt,
            usage: Object.freeze({
              value: typeof inputTokens === "number" ? inputTokens : null,
              provenance:
                receipt && usage && observation
                  ? Object.freeze({
                      kind: "provider-reported" as const,
                      attemptId: receipt.attemptId,
                      observedAt: observation.observedAt,
                      requestsAgo: 0,
                    })
                  : Object.freeze({
                      kind: "unknown" as const,
                      reason: receipt
                        ? "Provider did not report usage for the latest attempt"
                        : "No compiled attempt has been observed",
                    }),
            }),
            ledger: Object.freeze({
              path: attemptLedger?.path ?? join(sessionDirectory, "attempts.jsonl"),
              persisted,
              ...(attemptLedgerError ? { error: attemptLedgerError } : {}),
            }),
          });
        }
      );
      controlSocket = await startControlSocket(socketPath, {
        v2: true,
        capability,
        identity,
        service,
        doctor: () => doctorSession({ sessionId, sessionDirectory, legacyPath }),
      });
      const record: ControlRecord = Object.freeze({
        version: 2,
        identity,
        capability,
        address: Object.freeze({ kind: "unix" as const, path: socketPath }),
      });
      recordWriteAttempted = true;
      writeControlRecord(recordPath, record);
      recordWritten = true;
      bootstrapped = true;
      return Object.freeze({
        address: socketPath,
        childEnvironment: Object.freeze({
          CONTEXT_SURGEON_CONTROL_SOCKET: socketPath,
          CONTEXT_SURGEON_CONTROL_RECORD: JSON.stringify(record),
          CONTEXT_SURGEON_SESSION_ID: sessionId,
        }),
        close,
      });
    } catch (error) {
      await close();
      throw error;
    } finally {
      bootstrapping = false;
    }
  };

  const supportedRouteHandler: SupportedRouteHandler = async (req, res, config, debug) => {
    if (!bootstrapped || !v2Session || closed) {
      throw new Error("Production v2 session setup is unavailable; refusing supported request");
    }
    const productionConfig: ProductionHandlerConfig = {
      ...config,
      v2Session,
      onAttemptReceipt: (receipt: AttemptReceipt) => {
        try {
          attemptLedger?.record(receipt);
          attemptLedgerError = null;
        } catch (error) {
          attemptLedgerError = error instanceof Error ? error.message : String(error);
          // Before handoff, missing durable evidence is a local fail-closed
          // condition. After handoff, surfacing the error in authenticated
          // status is the only honest action; the request cannot be unsent.
          if (receipt.state === "compiled") throw error;
        }
        config.onAttemptReceipt?.(receipt);
      },
    };
    return await handleSupportedRoute(req, res, productionConfig, debug);
  };

  return Object.freeze({
    sessionId,
    sessionDirectory,
    controlPlaneBootstrap,
    supportedRouteHandler,
    close,
  });
}
