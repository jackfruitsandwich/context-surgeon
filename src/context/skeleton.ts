import type { ContextItem, Directive } from "./types.js";
import type { DirectiveStore } from "../store/directive-store.js";
import type { ConversationSnapshot } from "../proxy/conversations.js";

export type SkeletonItemKind =
  | "user"
  | "assistant"
  | "tool-call"
  | "tool-result"
  | "other";

export type SkeletonSurgeryState = "active" | "applied" | "pending";

export type SkeletonRow = {
  id: string;
  kind: SkeletonItemKind;
  turn: number | null;
  index: number | null;
  toolName?: string;
  surgery: {
    state: SkeletonSurgeryState;
    action: string | null;
    tokens: number | null;
  };
};

function parseItemId(id: string): { turn: number | null; index: number | null } {
  const match =
    /^(?:user message|assistant message|tool call|tool result) (\d+)(?:\.(\d+))?$/.exec(
      id
    );
  if (!match) {
    return { turn: null, index: null };
  }

  return {
    turn: Number(match[1]),
    index: match[2] ? Number(match[2]) : null,
  };
}

function toSkeletonKind(kind: ContextItem["kind"]): SkeletonItemKind {
  switch (kind) {
    case "user-message":
      return "user";
    case "assistant-message":
      return "assistant";
    case "tool-call":
      return "tool-call";
    case "tool-result":
      return "tool-result";
    case "other":
      return "other";
  }
}

function describeDirectiveAction(directive: Directive): string {
  if (directive.type === "replace") {
    return "replace";
  }

  if (!directive.mediaType) {
    return "evict";
  }

  const occurrences =
    directive.occurrences && directive.occurrences.length > 0
      ? ` (${directive.occurrences.join(",")})`
      : "";

  return `evict ${directive.mediaType}${occurrences}`;
}

export function annotateSkeleton(
  conversation: ConversationSnapshot,
  directiveStore: DirectiveStore
): SkeletonRow[] {
  return conversation.items.map((item) => {
    const parsed = parseItemId(item.id);
    const base = {
      id: item.id,
      kind: toSkeletonKind(item.kind),
      turn: parsed.turn,
      index: parsed.index,
      toolName: item.toolName,
    };

    const entry = directiveStore.get(item.fingerprint);
    if (!entry) {
      return { ...base, surgery: { state: "active" as const, action: null, tokens: null } };
    }

    const applied = conversation.lastApplied.has(item.fingerprint);
    return {
      ...base,
      surgery: {
        state: applied ? ("applied" as const) : ("pending" as const),
        action: describeDirectiveAction(entry.directive),
        tokens: entry.tokenEstimate,
      },
    };
  });
}
