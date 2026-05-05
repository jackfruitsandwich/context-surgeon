import type { ContextItem, Directive } from "./types.js";
import type { DirectiveStore } from "../store/directive-store.js";

const TURN_SELECTOR_RE = /^turn (\d+)$/;
const ASSISTANT_TURN_SELECTOR_RE = /^assistant message (\d+)$/;
const TOOL_CALL_TURN_SELECTOR_RE = /^tool call (\d+)$/;
const TOOL_RESULT_TURN_SELECTOR_RE = /^tool result (\d+)$/;
const ITEM_TURN_RE =
  /^(?:user message|assistant message|tool call|tool result) (\d+)(?:\.\d+)?$/;

function parseTurnNumber(id: string): number | null {
  const match = ITEM_TURN_RE.exec(id);
  return match ? Number(match[1]) : null;
}

function matchesTurnScopedId(
  itemId: string,
  prefix: "assistant message" | "tool call" | "tool result",
  turnNumber: number
): boolean {
  return new RegExp(`^${prefix} ${turnNumber}\\.\\d+$`).test(itemId);
}

export function isSelectorDirectiveKey(key: string): boolean {
  return (
    TURN_SELECTOR_RE.test(key) ||
    ASSISTANT_TURN_SELECTOR_RE.test(key) ||
    TOOL_CALL_TURN_SELECTOR_RE.test(key) ||
    TOOL_RESULT_TURN_SELECTOR_RE.test(key)
  );
}

export function isToolCallDirectiveKey(key: string): boolean {
  return /^tool call \d+(?:\.\d+)?$/.test(key);
}

export function directiveKeyMatchesItemId(
  directiveKey: string,
  itemId: string
): boolean {
  if (directiveKey === itemId) {
    return true;
  }

  const turnMatch = TURN_SELECTOR_RE.exec(directiveKey);
  if (turnMatch) {
    return parseTurnNumber(itemId) === Number(turnMatch[1]);
  }

  const assistantTurnMatch = ASSISTANT_TURN_SELECTOR_RE.exec(directiveKey);
  if (assistantTurnMatch) {
    return matchesTurnScopedId(
      itemId,
      "assistant message",
      Number(assistantTurnMatch[1])
    );
  }

  const toolCallTurnMatch = TOOL_CALL_TURN_SELECTOR_RE.exec(directiveKey);
  if (toolCallTurnMatch) {
    return matchesTurnScopedId(
      itemId,
      "tool call",
      Number(toolCallTurnMatch[1])
    );
  }

  const toolResultTurnMatch = TOOL_RESULT_TURN_SELECTOR_RE.exec(directiveKey);
  if (toolResultTurnMatch) {
    return matchesTurnScopedId(
      itemId,
      "tool result",
      Number(toolResultTurnMatch[1])
    );
  }

  return false;
}

export function lookupDirectiveForItem(
  item: ContextItem,
  directiveStore: DirectiveStore
): { id: string; directive: Directive } | null {
  const exactDirective = directiveStore.get(item.id);
  if (exactDirective) {
    return { id: item.id, directive: exactDirective };
  }

  for (const [directiveKey, directive] of directiveStore.getAll()) {
    if (directiveKeyMatchesItemId(directiveKey, item.id)) {
      return { id: directiveKey, directive };
    }
  }

  return null;
}
