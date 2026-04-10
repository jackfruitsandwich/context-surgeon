import http from "node:http";
import type { DirectiveStore } from "../store/directive-store.js";
import type { ShadowStore } from "../store/shadow-store.js";
import type { Directive, MediaType } from "../context/types.js";
import {
  buildStatusSummary,
  makeStatusLine,
} from "../context/status.js";

type StatusDirectiveRow = {
  id: string;
  action: string;
  tokens: number | null;
  tokenState: "known" | "pending" | "unknown";
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

export async function handleControl(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  directiveStore: DirectiveStore,
  shadowStore: ShadowStore,
  latestPromptTokens: number | null,
  maxTokens: number
): Promise<void> {
  const url = req.url || "";
  const method = req.method || "GET";

  if (method === "POST" && url === "/_control/evict") {
    const body = JSON.parse(await readBody(req)) as {
      id?: string;
      mediaType?: unknown;
      occurrences?: unknown;
    };
    if (!body.id) {
      jsonResponse(res, 400, { ok: false, error: "Missing id" });
      return;
    }
    if (body.mediaType !== undefined && !isValidMediaType(body.mediaType)) {
      jsonResponse(res, 400, { ok: false, error: "Invalid mediaType" });
      return;
    }

    const occurrences = normalizeOccurrences(body.occurrences);
    const directive: Directive = {
      type: "evict",
      mediaType: body.mediaType,
      occurrences,
    };

    directiveStore.set(body.id, directive);
    jsonResponse(res, 200, {
      ok: true,
      message: `Evicted: ${body.id}. Will take effect on next API call.`,
    });
    return;
  }

  if (method === "POST" && url === "/_control/replace") {
    const body = JSON.parse(await readBody(req)) as {
      id?: string;
      content?: string;
    };
    if (!body.id || !body.content) {
      jsonResponse(res, 400, {
        ok: false,
        error: "Missing id or content",
      });
      return;
    }
    directiveStore.set(body.id, { type: "replace", content: body.content });
    jsonResponse(res, 200, {
      ok: true,
      message: `Replaced: ${body.id} with summary. Will take effect on next API call.`,
    });
    return;
  }

  if (method === "POST" && url === "/_control/restore") {
    const body = JSON.parse(await readBody(req)) as { id?: string };
    if (!body.id) {
      jsonResponse(res, 400, { ok: false, error: "Missing id" });
      return;
    }
    if (!shadowStore.has(body.id)) {
      jsonResponse(res, 400, {
        ok: false,
        error: `No shadow entry for ${body.id}. Cannot restore.`,
      });
      return;
    }
    // Restore is pure bookkeeping. The next request carries the original
    // transcript content again once the directive is gone.
    directiveStore.delete(body.id);
    shadowStore.delete(body.id);
    jsonResponse(res, 200, {
      ok: true,
      message: `Restored: ${body.id}. Content will reappear on next API call.`,
    });
    return;
  }

  if (method === "GET" && url === "/_control/status") {
    const activeDirectives: StatusDirectiveRow[] = [];
    for (const [id, directive] of directiveStore.getAll()) {
      const shadow = shadowStore.get(id);
      activeDirectives.push({
        id,
        action: describeDirectiveAction(directive),
        tokens: shadow?.tokenEstimate ?? null,
        tokenState: shadow
          ? shadow.tokenEstimate === null
            ? "unknown"
            : "known"
          : "pending",
      });
    }

    activeDirectives.sort((a, b) => a.id.localeCompare(b.id, undefined, { numeric: true }));

    const summary = buildStatusSummary(
      latestPromptTokens,
      shadowStore,
      maxTokens
    );

    jsonResponse(res, 200, {
      summary: {
        ...summary,
        statusLine: makeStatusLine(summary),
      },
      activeDirectives,
    });
    return;
  }

  jsonResponse(res, 404, { ok: false, error: "Unknown control endpoint" });
}
