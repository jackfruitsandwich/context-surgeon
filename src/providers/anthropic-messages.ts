import type { ContextItem, ContextObject } from "../context/types.js";
import type { ProviderProjection } from "../contracts/provider.js";
import type { Occurrence, ResolvedIdentity } from "../contracts/state.js";
import { AnthropicMessagesAdapter } from "../adapters/anthropic-messages.js";
import { BaseProviderCodec } from "./base.js";
import {
  isRecord,
  makeOccurrence,
  prepareContext,
  pushProtectedHash,
  structuralOrderHash,
  type JsonRecord,
} from "./shared.js";

const THINKING_TYPES = new Set(["thinking", "redacted_thinking"]);

function assistantEndsInServerToolUse(value: unknown): boolean {
  if (!isRecord(value) || value.role !== "assistant" || !Array.isArray(value.content)) {
    return false;
  }
  const finalBlock = value.content[value.content.length - 1];
  return isRecord(finalBlock) && finalBlock.type === "server_tool_use";
}

function messages(value: Readonly<JsonRecord>): unknown[] {
  if (!Array.isArray(value.messages)) {
    throw new Error("Anthropic Messages request.messages must be an array");
  }
  return value.messages;
}

function messageItem(context: ContextObject, messageIndex: number): ContextItem | undefined {
  return context.items.find(
    (item) =>
      (item.kind === "user-message" || item.kind === "assistant-message") &&
      item.messageIndex === messageIndex
  );
}

function locatedItem(
  context: ContextObject,
  messageIndex: number,
  blockIndex: number,
  kind: "tool-call" | "tool-result"
): ContextItem | undefined {
  return context.items.find(
    (item) =>
      item.kind === kind &&
      item.location?.messageIndex === messageIndex &&
      item.location.blockIndex === blockIndex
  );
}

function inspectAnthropic(value: Readonly<JsonRecord>, errors: string[]) {
  const messageList = messages(value);
  const protectedHashes: Record<string, string> = {};
  const orderEntries: unknown[] = [];
  const calls = new Map<string, number>();
  const results = new Set<string>();

  if ("system" in value) {
    pushProtectedHash(protectedHashes, ["system"], value.system);
  }

  messageList.forEach((rawMessage, messageIndex) => {
    if (!isRecord(rawMessage)) {
      errors.push(`messages[${messageIndex}] must be an object`);
      orderEntries.push({ invalid: true });
      return;
    }
    const role = rawMessage.role;
    if (role !== "user" && role !== "assistant" && role !== "system") {
      errors.push(
        `messages[${messageIndex}].role must be user, assistant, or system; observed ${JSON.stringify(role)}`
      );
    }
    pushProtectedHash(
      protectedHashes,
      ["messages", messageIndex],
      { ...rawMessage, content: undefined },
      ":envelope"
    );

    if (role === "system") {
      const previous = messageList[messageIndex - 1];
      const next = messageList[messageIndex + 1];
      if (
        messageIndex === 0 ||
        (!isRecord(previous) ||
          (previous.role !== "user" && !assistantEndsInServerToolUse(previous)))
      ) {
        errors.push(
          `messages[${messageIndex}] system role must immediately follow a user turn or assistant server tool use`
        );
      }
      if (next !== undefined && (!isRecord(next) || next.role !== "assistant")) {
        errors.push(
          `messages[${messageIndex}] system role must be last or immediately precede an assistant turn`
        );
      }
      if (
        typeof rawMessage.content !== "string" &&
        !Array.isArray(rawMessage.content)
      ) {
        errors.push(
          `messages[${messageIndex}].content must be a string or array for system role`
        );
      } else if (
        (typeof rawMessage.content === "string" && rawMessage.content.length === 0) ||
        (Array.isArray(rawMessage.content) && rawMessage.content.length === 0)
      ) {
        errors.push(`messages[${messageIndex}].content must not be empty`);
      }
      pushProtectedHash(
        protectedHashes,
        ["messages", messageIndex],
        rawMessage,
        ":mid-conversation-system"
      );
      orderEntries.push({ role: "system", protected: true });
      return;
    }

    const content = rawMessage.content;
    if (typeof content === "string") {
      if (content.length === 0) {
        errors.push(`messages[${messageIndex}].content must not be empty`);
      }
      orderEntries.push({ role, slots: ["mutable-payload"] });
      return;
    }
    if (!Array.isArray(content) || content.length === 0) {
      errors.push(`messages[${messageIndex}].content must be a non-empty string or array`);
      orderEntries.push({ role, slots: [] });
      return;
    }

    let sawNonThinking = false;
    const blockOrder: unknown[] = [];
    content.forEach((rawBlock, blockIndex) => {
      if (!isRecord(rawBlock) || typeof rawBlock.type !== "string") {
        errors.push(`messages[${messageIndex}].content[${blockIndex}] is invalid`);
        blockOrder.push({ invalid: true });
        return;
      }
      const type = rawBlock.type;
      if (THINKING_TYPES.has(type)) {
        if (role !== "assistant") {
          errors.push(`${type} block requires assistant role`);
        }
        if (sawNonThinking) {
          errors.push(`${type} block must precede non-thinking assistant content`);
        }
        pushProtectedHash(
          protectedHashes,
          ["messages", messageIndex, "content", blockIndex],
          rawBlock
        );
        blockOrder.push({ type, protected: true });
        return;
      }
      sawNonThinking = true;

      if (type === "tool_use") {
        const id = rawBlock.id;
        if (
          role !== "assistant" ||
          typeof id !== "string" ||
          !id ||
          typeof rawBlock.name !== "string" ||
          !rawBlock.name ||
          !isRecord(rawBlock.input)
        ) {
          errors.push(`messages[${messageIndex}].content[${blockIndex}] has invalid tool_use`);
        } else if (calls.has(id)) {
          errors.push(`Duplicate tool_use id ${id}`);
        } else {
          calls.set(id, messageIndex);
        }
        pushProtectedHash(
          protectedHashes,
          ["messages", messageIndex, "content", blockIndex],
          rawBlock
        );
        blockOrder.push({ type, id });
        return;
      }

      if (type === "tool_result") {
        const id = rawBlock.tool_use_id;
        if (role !== "user" || typeof id !== "string" || !id) {
          errors.push(`messages[${messageIndex}].content[${blockIndex}] has invalid tool_result`);
        } else {
          if (results.has(id)) errors.push(`Duplicate tool_result id ${id}`);
          results.add(id);
          const callIndex = calls.get(id);
          if (callIndex === undefined || callIndex >= messageIndex) {
            errors.push(`tool_result ${id} has no preceding tool_use`);
          }
        }
        const toolContent = rawBlock.content;
        if (
          typeof toolContent !== "string" &&
          !Array.isArray(toolContent)
        ) {
          errors.push(`tool_result ${String(id)} content has invalid shape`);
        }
        pushProtectedHash(
          protectedHashes,
          ["messages", messageIndex, "content", blockIndex],
          { ...rawBlock, content: undefined },
          ":envelope"
        );
        blockOrder.push({ type, id });
        return;
      }

      if (type === "text") {
        if (typeof rawBlock.text !== "string" || rawBlock.text.length === 0) {
          errors.push(`messages[${messageIndex}].content[${blockIndex}].text must be non-empty`);
        }
        if ("cache_control" in rawBlock) {
          pushProtectedHash(
            protectedHashes,
            ["messages", messageIndex, "content", blockIndex, "cache_control"],
            rawBlock.cache_control
          );
        }
        blockOrder.push("mutable-payload");
        return;
      }

      if (type === "image" || type === "document") {
        if (!isRecord(rawBlock.source)) {
          errors.push(`${type} block at messages[${messageIndex}].content[${blockIndex}] lacks source`);
        }
        if ("cache_control" in rawBlock) {
          pushProtectedHash(
            protectedHashes,
            ["messages", messageIndex, "content", blockIndex, "cache_control"],
            rawBlock.cache_control
          );
        }
        blockOrder.push("mutable-payload");
        return;
      }

      pushProtectedHash(
        protectedHashes,
        ["messages", messageIndex, "content", blockIndex],
        rawBlock
      );
      blockOrder.push({ type, protected: true });
    });
    orderEntries.push({ role, slots: blockOrder });
  });

  return {
    itemCount: messageList.length,
    itemOrderHash: structuralOrderHash(orderEntries),
    protectedHashes,
  };
}

export class AnthropicMessagesCodec extends BaseProviderCodec {
  readonly provider = "anthropic-messages" as const;

  constructor() {
    super(new AnthropicMessagesAdapter());
  }

  protected assertEnvelope(value: Readonly<JsonRecord>): void {
    messages(value);
    if ("model" in value && typeof value.model !== "string") {
      throw new Error("Anthropic Messages request.model must be a string");
    }
  }

  protected prepareContext(context: ContextObject): ContextObject {
    return prepareContext(context);
  }

  protected project(
    value: Readonly<JsonRecord>,
    context: ContextObject,
    identity: ResolvedIdentity
  ): Omit<ProviderProjection, "context"> & { itemCount: number } {
    const messageList = messages(value);
    const occurrences: Occurrence[] = [];
    let predecessorId = "";
    const add = (input: Parameters<typeof makeOccurrence>[1]) => {
      const occurrence = makeOccurrence(identity, { ...input, predecessorId });
      predecessorId = occurrence.occurrenceId;
      occurrences.push(occurrence);
    };

    messageList.forEach((rawMessage, messageIndex) => {
      if (!isRecord(rawMessage)) return;
      const role = rawMessage.role;
      const message = messageItem(context, messageIndex);
      const label = message?.id || `message ${messageIndex + 1}`;
      if (role === "system") {
        add({
          kind: "other",
          value: rawMessage,
          displayLabel: label,
          providerPath: ["messages", messageIndex],
          mutable: false,
          protectedReason: "Anthropic mid-conversation system instructions are protected",
        });
        return;
      }
      if (typeof rawMessage.content === "string") {
        add({
          kind: role === "assistant" ? "assistant-text" : "user-text",
          value: rawMessage.content,
          displayLabel: label,
          providerPath: ["messages", messageIndex, "content"],
          mutable: role === "user" || role === "assistant",
        });
        return;
      }
      if (!Array.isArray(rawMessage.content)) return;

      rawMessage.content.forEach((rawBlock, blockIndex) => {
        if (!isRecord(rawBlock)) return;
        const path = ["messages", messageIndex, "content", blockIndex] as const;
        if (rawBlock.type === "tool_use") {
          add({
            kind: "tool-call",
            value: rawBlock,
            displayLabel:
              locatedItem(context, messageIndex, blockIndex, "tool-call")?.id || label,
            providerPath: path,
            mutable: false,
            protectedReason: "Anthropic tool_use id, name, and input are protected",
          });
          return;
        }
        if (rawBlock.type === "tool_result") {
          const toolLabel =
            locatedItem(context, messageIndex, blockIndex, "tool-result")?.id || label;
          if (typeof rawBlock.content === "string") {
            add({
              kind: "tool-result-text",
              value: rawBlock.content,
              displayLabel: toolLabel,
              providerPath: [...path, "content"],
              mutable: true,
            });
          } else if (Array.isArray(rawBlock.content)) {
            rawBlock.content.forEach((rawResultBlock, resultIndex) => {
              if (!isRecord(rawResultBlock)) return;
              const resultPath = [...path, "content", resultIndex] as const;
              if (
                rawResultBlock.type === "text" &&
                typeof rawResultBlock.text === "string"
              ) {
                add({
                  kind: "tool-result-text",
                  value: rawResultBlock.text,
                  displayLabel: toolLabel,
                  providerPath: [...resultPath, "text"],
                  mutable: true,
                });
              } else if (rawResultBlock.type === "image") {
                add({
                  kind: "image",
                  value: rawResultBlock,
                  displayLabel: toolLabel,
                  providerPath: resultPath,
                  mutable: true,
                });
              } else if (rawResultBlock.type === "document") {
                add({
                  kind: "document",
                  value: rawResultBlock,
                  displayLabel: toolLabel,
                  providerPath: resultPath,
                  mutable: true,
                });
              } else {
                add({
                  kind: THINKING_TYPES.has(String(rawResultBlock.type))
                    ? "reasoning"
                    : "other",
                  value: rawResultBlock,
                  displayLabel: toolLabel,
                  providerPath: resultPath,
                  mutable: false,
                  protectedReason: "Unknown tool_result content is protected",
                });
              }
            });
          }
          return;
        }
        if (rawBlock.type === "text" && typeof rawBlock.text === "string") {
          add({
            kind: role === "assistant" ? "assistant-text" : "user-text",
            value: rawBlock.text,
            displayLabel: label,
            providerPath: [...path, "text"],
            mutable: true,
          });
        } else if (rawBlock.type === "image") {
          add({
            kind: "image",
            value: rawBlock,
            displayLabel: label,
            providerPath: path,
            mutable: true,
          });
        } else if (rawBlock.type === "document") {
          add({
            kind: "document",
            value: rawBlock,
            displayLabel: label,
            providerPath: path,
            mutable: true,
          });
        } else {
          add({
            kind: THINKING_TYPES.has(String(rawBlock.type)) ? "reasoning" : "other",
            value: rawBlock,
            displayLabel: label,
            providerPath: path,
            mutable: false,
            protectedReason: THINKING_TYPES.has(String(rawBlock.type))
              ? "Anthropic thinking/redacted_thinking is protected"
              : "Unknown Anthropic block is protected",
          });
        }
      });
    });

    const inspected = inspectAnthropic(value, []);
    return {
      provider: this.provider,
      occurrences,
      itemOrderHash: inspected.itemOrderHash,
      protectedHashes: inspected.protectedHashes,
      itemCount: inspected.itemCount,
    };
  }

  protected inspectStructure(value: Readonly<JsonRecord>, errors: string[]) {
    return inspectAnthropic(value, errors);
  }
}
