import http from "node:http";
import type { DirectiveStore } from "../store/directive-store.js";
import type { ShadowStore } from "../store/shadow-store.js";
import type { Directive, MediaType } from "../context/types.js";
import {
  annotateSkeletonItems,
  type SkeletonItem,
  type SkeletonRow,
} from "../context/skeleton.js";
import {
  buildStatusSummary,
  makeStatusLine,
} from "../context/status.js";
import { directiveKeyMatchesItemId } from "../context/directive-targets.js";

type StatusDirectiveRow = {
  id: string;
  action: string;
  tokens: number | null;
  tokenState: "known" | "pending" | "unknown";
};

type SkeletonResponse = {
  summary: {
    statusLine: string;
  };
  items: SkeletonRow[];
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

function getMatchingShadowIds(
  id: string,
  shadowStore: ShadowStore
): string[] {
  return [...shadowStore.getAll().keys()].filter((shadowId) =>
    directiveKeyMatchesItemId(id, shadowId)
  );
}

function getDirectiveTokenState(
  id: string,
  shadowStore: ShadowStore
): Pick<StatusDirectiveRow, "tokens" | "tokenState"> {
  const matchingShadows = [...shadowStore.getAll()].filter(([shadowId]) =>
    directiveKeyMatchesItemId(id, shadowId)
  );

  if (matchingShadows.length === 0) {
    return { tokens: null, tokenState: "pending" };
  }

  let totalTokens = 0;
  for (const [, shadow] of matchingShadows) {
    if (shadow.tokenEstimate === null) {
      return { tokens: null, tokenState: "unknown" };
    }
    totalTokens += shadow.tokenEstimate;
  }

  return { tokens: totalTokens, tokenState: "known" };
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
  maxTokens: number,
  currentSkeletonItems: SkeletonItem[] | null = null
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
    const matchingShadowIds = getMatchingShadowIds(body.id, shadowStore);
    if (!directiveStore.has(body.id) && matchingShadowIds.length === 0) {
      jsonResponse(res, 400, {
        ok: false,
        error: `No shadow entry for ${body.id}. Cannot restore.`,
      });
      return;
    }
    // Restore is pure bookkeeping. The next request carries the original
    // transcript content again once the directive is gone.
    directiveStore.delete(body.id);
    for (const shadowId of matchingShadowIds) {
      shadowStore.delete(shadowId);
    }
    jsonResponse(res, 200, {
      ok: true,
      message: `Restored: ${body.id}. Content will reappear on next API call.`,
    });
    return;
  }

  if (method === "GET" && url === "/_control/status") {
    const activeDirectives: StatusDirectiveRow[] = [];
    for (const [id, directive] of directiveStore.getAll()) {
      const tokenState = getDirectiveTokenState(id, shadowStore);
      activeDirectives.push({
        id,
        action: describeDirectiveAction(directive),
        ...tokenState,
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

  if (method === "GET" && url === "/_control/skeleton") {
    const summary = buildStatusSummary(
      latestPromptTokens,
      shadowStore,
      maxTokens
    );
    const body: SkeletonResponse = {
      summary: {
        statusLine: makeStatusLine(summary),
      },
      items: annotateSkeletonItems(
        currentSkeletonItems ?? [],
        directiveStore,
        shadowStore
      ),
    };

    jsonResponse(res, 200, body);
    return;
  }

  jsonResponse(res, 404, { ok: false, error: "Unknown control endpoint" });
}
