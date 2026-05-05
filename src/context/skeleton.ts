import type { ContextItem, Directive } from "./types.js";
import type { DirectiveStore } from "../store/directive-store.js";
import type { ShadowStore } from "../store/shadow-store.js";
import { directiveKeyMatchesItemId } from "./directive-targets.js";

export type SkeletonItemKind =
  | "user"
  | "assistant"
  | "tool-call"
  | "tool-result"
  | "other";

export type SkeletonSurgeryState = "active" | "applied" | "pending";

export type SkeletonItem = {
  id: string;
  kind: SkeletonItemKind;
  turn: number | null;
  index: number | null;
  toolName?: string;
};

export type SkeletonRow = SkeletonItem & {
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

function toSkeletonKind(item: ContextItem): SkeletonItemKind {
  switch (item.kind) {
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

export function buildSkeletonItems(items: ContextItem[]): SkeletonItem[] {
  return items.map((item) => {
    const parsed = parseItemId(item.id);
    return {
      id: item.id,
      kind: toSkeletonKind(item),
      turn: parsed.turn,
      index: parsed.index,
      toolName: item.kind === "tool-call" ? item.name : undefined,
    };
  });
}

function findMatchingDirective(
  itemId: string,
  directiveStore: DirectiveStore
): Directive | null {
  const exact = directiveStore.get(itemId);
  if (exact) {
    return exact;
  }

  for (const [directiveKey, directive] of directiveStore.getAll()) {
    if (directiveKeyMatchesItemId(directiveKey, itemId)) {
      return directive;
    }
  }

  return null;
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

export function annotateSkeletonItems(
  items: SkeletonItem[],
  directiveStore: DirectiveStore,
  shadowStore: ShadowStore
): SkeletonRow[] {
  return items.map((item) => {
    const directive = findMatchingDirective(item.id, directiveStore);
    const shadow = shadowStore.get(item.id);

    if (shadow) {
      return {
        ...item,
        surgery: {
          state: "applied",
          action: directive ? describeDirectiveAction(directive) : "evict",
          tokens: shadow.tokenEstimate,
        },
      };
    }

    if (directive) {
      return {
        ...item,
        surgery: {
          state: "pending",
          action: describeDirectiveAction(directive),
          tokens: null,
        },
      };
    }

    return {
      ...item,
      surgery: {
        state: "active",
        action: null,
        tokens: null,
      },
    };
  });
}
