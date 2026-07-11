import http from "node:http";
import type { ControlIdentity, MutationCommand } from "../contracts/control.js";
import type { DirectiveStore } from "../store/directive-store.js";
import type { ConversationTracker, BranchSelection } from "../proxy/conversations.js";
import { bearerCapability, capabilityMatches } from "./control-auth.js";
import { StateControlService } from "./state-control.js";

/** Temporary compile seam for the runtime branch. It receives no control access. */
type LegacyRuntimeContext = {
  directiveStore: DirectiveStore;
  tracker: ConversationTracker;
  maxTokens: number;
  identity: {
    pid: number;
    port: number;
    target: string;
    startedAt: string;
    version: string;
  };
  v2?: undefined;
};

export type V2ControlContext = {
  v2: true;
  capability: string;
  identity: ControlIdentity;
  service: StateControlService;
  doctor?: () => unknown | Promise<unknown>;
};

export type ControlContext = LegacyRuntimeContext | V2ControlContext;

function jsonResponse(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
  });
  res.end(JSON.stringify(body));
}

async function readJson(req: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const raw of req) {
    const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
    length += chunk.length;
    if (length > 1024 * 1024) throw new Error("Control request exceeds 1 MiB");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function selectionFromUrl(url: URL): BranchSelection {
  const sessionId = url.searchParams.get("sessionId") ?? "";
  const conversationId = url.searchParams.get("conversationId") ?? "";
  const branchId = url.searchParams.get("branchId") ?? "";
  if (!sessionId || !conversationId || !branchId) {
    throw new Error("sessionId, conversationId, and branchId are required");
  }
  return { sessionId, conversationId, branchId };
}

function mutationStatus(response: ReturnType<StateControlService["mutate"]>): number {
  if (response.ok) return 200;
  switch (response.code) {
    case "ambiguous-identity":
    case "stale-revision":
      return 409;
    case "unsupported-target":
      return 422;
    case "recovery-required":
      return 503;
    case "persistence-failed":
      return 500;
  }
}

function isV2Context(ctx: ControlContext): ctx is V2ControlContext {
  return ctx.v2 === true;
}

/** Every control endpoint, including ping and read-only views, is capability authenticated. */
export async function handleControl(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  ctx: ControlContext
): Promise<void> {
  if (!isV2Context(ctx)) {
    jsonResponse(res, 503, {
      ok: false,
      error: "Authenticated v2 control is not configured on this listener",
    });
    return;
  }

  const supplied =
    bearerCapability(req.headers.authorization) ??
    (typeof req.headers["x-context-surgeon-capability"] === "string"
      ? req.headers["x-context-surgeon-capability"]
      : undefined);
  if (!capabilityMatches(ctx.capability, supplied)) {
    jsonResponse(res, 401, { ok: false, error: "Invalid control capability" });
    return;
  }

  const url = new URL(req.url || "/", "http://control.invalid");
  const method = req.method || "GET";
  try {
    if (method === "GET" && url.pathname === "/_control/ping") {
      jsonResponse(res, 200, { ok: true, identity: ctx.identity });
      return;
    }
    if (method === "GET" && url.pathname === "/_control/skeleton") {
      jsonResponse(res, 200, ctx.service.skeleton(selectionFromUrl(url)));
      return;
    }
    if (method === "GET" && url.pathname === "/_control/selections") {
      jsonResponse(res, 200, { selections: ctx.service.selections() });
      return;
    }
    if (method === "GET" && url.pathname === "/_control/status") {
      jsonResponse(res, 200, ctx.service.status(selectionFromUrl(url)));
      return;
    }
    if (method === "GET" && url.pathname === "/_control/doctor") {
      jsonResponse(res, 200, ctx.doctor ? await ctx.doctor() : { state: "not-configured" });
      return;
    }
    if (method === "POST" && url.pathname === "/_control/mutate") {
      const response = ctx.service.mutate(await readJson(req) as MutationCommand);
      jsonResponse(res, mutationStatus(response), response);
      return;
    }
    jsonResponse(res, 404, { ok: false, error: "Unknown control endpoint" });
  } catch (error) {
    jsonResponse(res, 400, {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
