import type { ContextItem } from "./types.js";

export function assignIds(items: ContextItem[]): void {
  let turnNumber = 0;
  let assistantIndex = 0;
  let toolIndex = 0;
  let otherCounter = 0;
  const toolRefsByCallId = new Map<string, string>();

  function getToolRef(callId: string): string {
    const existingRef = toolRefsByCallId.get(callId);
    if (existingRef) {
      return existingRef;
    }

    if (turnNumber === 0) {
      turnNumber = 1;
    }

    const ref = `${turnNumber}.${++toolIndex}`;
    toolRefsByCallId.set(callId, ref);
    return ref;
  }

  for (const item of items) {
    switch (item.kind) {
      case "user-message":
        turnNumber++;
        assistantIndex = 0;
        toolIndex = 0;
        item.id = `user message ${turnNumber}`;
        break;

      case "assistant-message":
        assistantIndex++;
        if (turnNumber === 0) turnNumber = 1;
        item.id = `assistant message ${turnNumber}.${assistantIndex}`;
        break;

      case "tool-call":
        item.id = `tool call ${getToolRef(item.callId)}`;
        break;

      case "tool-result":
        item.id = `tool result ${getToolRef(item.callId)}`;
        break;

      case "other":
        if (!item.id || item.id.startsWith("other_")) {
          item.id = `other_${++otherCounter}`;
        }
        break;
    }
  }
}
