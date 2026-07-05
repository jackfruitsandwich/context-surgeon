import http from "node:http";
import type { DirectiveStore, DirectiveEntry } from "../store/directive-store.js";
import type { Directive, MediaType } from "../context/types.js";
import {
  ConversationTracker,
  resolveSelectors,
  isKnownSelectorShape,
  type ConversationSnapshot,
} from "../proxy/conversations.js";
import { annotateSkeleton, type SkeletonRow } from "../context/skeleton.js";
import { buildStatusSummary, makeStatusLine } from "../context/status.js";

export type ControlContext = {
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
};

type DirectiveState = "applied" | "pending" | "inactive";

type StatusDirectiveRow = {
  id: string;
  fingerprint: string;
  action: string;
  tokens: number | null;
  state: DirectiveState;
  preview: string;
};

function describeDirectiveAction(directive: Directive): string {
  if (directive.type === "replace") {
    return "replace";
  }

  if (!directive.mediaType) {
    return "evict";
  }

  const suffix =
    directive.occurrences && directive.occurrences.length > 0
      ? ` (${directive.occurrences.join(",")})`
      : "";

  return `evict ${directive.mediaType}${suffix}`;
}

function isValidMediaType(value: unknown): value is MediaType {
  return value === "image" || value === "document";
}

function normalizeOccurrences(value: unknown): number[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }

  const occurrences = value
    .map((entry) => (typeof entry === "number" ? entry : Number(entry)))
    .filter((entry) => Number.isInteger(entry) && entry > 0);

  if (occurrences.length === 0) {
    return undefined;
  }

  return [...new Set(occurrences)].sort((a, b) => a - b);
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    req.on("error", reject);
  });
}

function jsonResponse(
  res: http.ServerResponse,
  status: number,
  body: unknown
): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

function extractSelectors(body: { id?: unknown; ids?: unknown }): string[] {
  if (Array.isArray(body.ids)) {
    return body.ids.filter((id): id is string => typeof id === "string" && id.length > 0);
  }
  if (typeof body.id === "string" && body.id.length > 0) {
    return [body.id];
  }
  return [];
}

function conversationLabel(conversation: ConversationSnapshot): string {
  return `"${conversation.firstUserPreview || "(no user message)"}" (${conversation.itemCount} items)`;
}

function directiveState(
  fingerprint: string,
  entry: DirectiveEntry,
  primary: ConversationSnapshot | null
): DirectiveState {
  if (primary?.lastApplied.has(fingerprint)) {
    return "applied";
  }
  return entry.lastMatchedAt === null ? "pending" : "inactive";
}

function buildPrimaryStatusLine(ctx: ControlContext): {
  statusLine: string;
  primary: ConversationSnapshot | null;
} {
  const primary = ctx.tracker.primary();
  let appliedTokens = 0;
  let appliedCount = 0;
  if (primary) {
    for (const fp of primary.lastApplied) {
      const entry = ctx.directiveStore.get(fp);
      appliedCount += 1;
      appliedTokens += entry?.tokenEstimate ?? 0;
    }
  }
  const summary = buildStatusSummary(
    primary?.promptTokens ?? null,
    appliedCount,
    appliedTokens,
    ctx.maxTokens
  );
  return { statusLine: makeStatusLine(summary), primary };
}

export async function handleControl(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  ctx: ControlContext
): Promise<void> {
  const url = req.url || "";
  const method = req.method || "GET";
  const { directiveStore, tracker } = ctx;

  if (method === "POST" && (url === "/_control/evict" || url === "/_control/replace")) {
    const isReplace = url === "/_control/replace";
    const body = JSON.parse(await readBody(req)) as {
      id?: unknown;
      ids?: unknown;
      content?: unknown;
      mediaType?: unknown;
      occurrences?: unknown;
    };

    const selectors = extractSelectors(body);
    if (selectors.length === 0) {
      jsonResponse(res, 400, { ok: false, error: "Missing id(s)" });
      return;
    }
    const malformed = selectors.filter((selector) => !isKnownSelectorShape(selector));
    if (malformed.length > 0) {
      jsonResponse(res, 400, {
        ok: false,
        error:
          `Unrecognized id(s): ${malformed.join(", ")}. ` +
          `Expected forms like "tool result 12.3", "user message 5", "turn 7".`,
      });
      return;
    }
    if (isReplace && typeof body.content !== "string") {
      jsonResponse(res, 400, { ok: false, error: "Missing content" });
      return;
    }
    if (!isReplace && body.mediaType !== undefined && !isValidMediaType(body.mediaType)) {
      jsonResponse(res, 400, { ok: false, error: "Invalid mediaType" });
      return;
    }

    const resolution = resolveSelectors(tracker, selectors);
    if (!resolution) {
      jsonResponse(res, 409, {
        ok: false,
        error:
          "No conversation observed yet — the proxy has not seen a model request. " +
          "Send one message first, then retry.",
      });
      return;
    }
    if (resolution.missing.length > 0) {
      jsonResponse(res, 404, {
        ok: false,
        error:
          `No such item(s) in the current context: ${resolution.missing.join(", ")}. ` +
          `Resolved against conversation ${conversationLabel(resolution.conversation)}. ` +
          `Run 'context-surgeon skeleton' to see valid ids.`,
      });
      return;
    }

    const targets = resolution.resolved.flatMap((target) => target.items);
    if (isReplace && targets.length !== 1) {
      jsonResponse(res, 400, {
        ok: false,
        error: `replace needs exactly one item; ${selectors.join(", ")} matched ${targets.length}.`,
      });
      return;
    }

    const occurrences = normalizeOccurrences(body.occurrences);
    const directive: Directive = isReplace
      ? { type: "replace", content: body.content as string }
      : {
          type: "evict",
          mediaType: isValidMediaType(body.mediaType) ? body.mediaType : undefined,
          occurrences,
        };

    const now = Date.now();
    for (const item of targets) {
      directiveStore.set(item.fingerprint, {
        directive,
        humanId: item.id,
        preview: item.preview,
        tokenEstimate: null,
        createdAt: now,
        lastMatchedAt: null,
      });
    }

    jsonResponse(res, 200, {
      ok: true,
      message:
        `${isReplace ? "Replaced" : "Evicted"}: ${targets.length} item(s) in conversation ` +
        `${conversationLabel(resolution.conversation)}. Takes effect on the next API call.`,
      resolvedCount: targets.length,
    });
    return;
  }

  if (method === "POST" && url === "/_control/restore") {
    const body = JSON.parse(await readBody(req)) as { id?: unknown; ids?: unknown };
    const selectors = extractSelectors(body);
    if (selectors.length === 0) {
      jsonResponse(res, 400, { ok: false, error: "Missing id(s)" });
      return;
    }

    const resolution = resolveSelectors(tracker, selectors);
    if (!resolution) {
      jsonResponse(res, 409, {
        ok: false,
        error: "No conversation observed yet — nothing to restore.",
      });
      return;
    }

    let removed = 0;
    for (const target of resolution.resolved) {
      for (const item of target.items) {
        if (directiveStore.delete(item.fingerprint)) {
          removed += 1;
        }
      }
    }

    if (removed === 0) {
      jsonResponse(res, 404, {
        ok: false,
        error:
          `No directive found for: ${selectors.join(", ")}` +
          (resolution.missing.length > 0
            ? ` (unknown ids: ${resolution.missing.join(", ")})`
            : "") +
          ". Run 'context-surgeon status' to see active directives.",
      });
      return;
    }

    jsonResponse(res, 200, {
      ok: true,
      message: `Restored ${removed} item(s). Content reappears on the next API call.`,
      restoredCount: removed,
    });
    return;
  }

  if (method === "GET" && url === "/_control/status") {
    const { statusLine, primary } = buildPrimaryStatusLine(ctx);

    const activeDirectives: StatusDirectiveRow[] = [];
    for (const [fingerprint, entry] of directiveStore.getAll()) {
      activeDirectives.push({
        id: entry.humanId,
        fingerprint,
        action: describeDirectiveAction(entry.directive),
        tokens: entry.tokenEstimate,
        state: directiveState(fingerprint, entry, primary),
        preview: entry.preview,
      });
    }
    activeDirectives.sort((a, b) =>
      a.id.localeCompare(b.id, undefined, { numeric: true })
    );

    jsonResponse(res, 200, {
      summary: {
        statusLine,
        conversation: primary
          ? { preview: primary.firstUserPreview, itemCount: primary.itemCount }
          : null,
      },
      activeDirectives,
    });
    return;
  }

  if (method === "GET" && url === "/_control/skeleton") {
    const { statusLine, primary } = buildPrimaryStatusLine(ctx);
    const items: SkeletonRow[] = primary
      ? annotateSkeleton(primary, directiveStore)
      : [];

    jsonResponse(res, 200, {
      summary: { statusLine },
      items,
    });
    return;
  }

  if (method === "GET" && url === "/_control/ping") {
    jsonResponse(res, 200, {
      ok: true,
      ...ctx.identity,
      directiveCount: directiveStore.size(),
      conversations: tracker.all().map((conversation) => ({
        preview: conversation.firstUserPreview,
        itemCount: conversation.itemCount,
        lastSeenAt: conversation.lastSeenAt,
        promptTokens: conversation.promptTokens,
      })),
    });
    return;
  }

  jsonResponse(res, 404, { ok: false, error: "Unknown control endpoint" });
}
