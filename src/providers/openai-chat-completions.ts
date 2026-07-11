import type { ContextObject, ContextItem } from "../context/types.js";
import type { ProviderProjection } from "../contracts/provider.js";
import type { Occurrence, ResolvedIdentity } from "../contracts/state.js";
import { OpenAIChatCompletionsAdapter } from "../adapters/openai-chat-completions.js";
import { BaseProviderCodec } from "./base.js";
import {
  isRecord,
  makeOccurrence,
  prepareContext,
  pushProtectedHash,
  structuralOrderHash,
  type JsonRecord,
} from "./shared.js";

const ROLES = new Set(["system", "developer", "user", "assistant", "tool"]);

function messages(value: Readonly<JsonRecord>): unknown[] {
  if (!Array.isArray(value.messages)) {
    throw new Error("OpenAI Chat Completions request.messages must be an array");
  }
  return value.messages;
}

function itemForMessage(context: ContextObject, messageIndex: number): ContextItem | undefined {
  return context.items.find(
    (item) =>
      (item.kind === "user-message" ||
        item.kind === "assistant-message" ||
        item.kind === "other") &&
      item.messageIndex === messageIndex
  );
}

function toolItemForMessage(
  context: ContextObject,
  messageIndex: number,
  kind: "tool-call" | "tool-result",
  blockIndex = 0
): ContextItem | undefined {
  return context.items.find(
    (item) =>
      item.kind === kind &&
      item.location?.messageIndex === messageIndex &&
      item.location.blockIndex === blockIndex
  );
}

function inspectChat(value: Readonly<JsonRecord>, errors: string[]) {
  const messageList = messages(value);
  const protectedHashes: Record<string, string> = {};
  const orderEntries: unknown[] = [];
  const calls = new Map<string, number>();
  const results = new Set<string>();

  messageList.forEach((rawMessage, messageIndex) => {
    if (!isRecord(rawMessage)) {
      errors.push(`messages[${messageIndex}] must be an object`);
      orderEntries.push({ invalid: true });
      return;
    }
    const role = rawMessage.role;
    if (typeof role !== "string" || !ROLES.has(role)) {
      errors.push(`messages[${messageIndex}].role is unsupported`);
    }
    pushProtectedHash(
      protectedHashes,
      ["messages", messageIndex],
      { ...rawMessage, content: undefined, tool_calls: undefined },
      ":envelope"
    );

    const content = rawMessage.content;
    if (
      content !== undefined &&
      content !== null &&
      typeof content !== "string" &&
      !Array.isArray(content)
    ) {
      errors.push(`messages[${messageIndex}].content has an invalid shape`);
    }
    if (Array.isArray(content)) {
      content.forEach((rawPart, partIndex) => {
        if (!isRecord(rawPart) || typeof rawPart.type !== "string") {
          errors.push(`messages[${messageIndex}].content[${partIndex}] is invalid`);
          return;
        }
        if (rawPart.type === "text") {
          if (typeof rawPart.text !== "string") {
            errors.push(
              `messages[${messageIndex}].content[${partIndex}].text must be a string`
            );
          }
        } else if (
          rawPart.type !== "image_url" &&
          rawPart.type !== "input_image" &&
          rawPart.type !== "file" &&
          rawPart.type !== "input_file"
        ) {
          pushProtectedHash(
            protectedHashes,
            ["messages", messageIndex, "content", partIndex],
            rawPart
          );
        }
      });
    }

    if (Array.isArray(rawMessage.tool_calls)) {
      if (role !== "assistant") {
        errors.push(`messages[${messageIndex}].tool_calls requires assistant role`);
      }
      rawMessage.tool_calls.forEach((rawCall, callIndex) => {
        if (!isRecord(rawCall) || !isRecord(rawCall.function)) {
          errors.push(`messages[${messageIndex}].tool_calls[${callIndex}] is invalid`);
          return;
        }
        const id = rawCall.id;
        if (
          typeof id !== "string" ||
          !id ||
          typeof rawCall.function.name !== "string" ||
          !rawCall.function.name ||
          typeof rawCall.function.arguments !== "string"
        ) {
          errors.push(`messages[${messageIndex}].tool_calls[${callIndex}] is invalid`);
        } else if (calls.has(id)) {
          errors.push(`Duplicate tool call id ${id}`);
        } else {
          calls.set(id, messageIndex);
        }
        pushProtectedHash(
          protectedHashes,
          ["messages", messageIndex, "tool_calls", callIndex],
          rawCall
        );
      });
    }

    if (role === "tool") {
      const id = rawMessage.tool_call_id;
      if (typeof id !== "string" || !id) {
        errors.push(`messages[${messageIndex}] tool result lacks tool_call_id`);
      } else {
        if (results.has(id)) errors.push(`Duplicate tool result id ${id}`);
        results.add(id);
        const callIndex = calls.get(id);
        if (callIndex === undefined || callIndex >= messageIndex) {
          errors.push(`Tool result ${id} has no preceding call`);
        }
      }
    }

    orderEntries.push({
      role,
      toolCallIds: Array.isArray(rawMessage.tool_calls)
        ? rawMessage.tool_calls.map((call) => (isRecord(call) ? call.id : null))
        : [],
      toolCallId: rawMessage.tool_call_id,
    });
  });

  return {
    itemCount: messageList.length,
    itemOrderHash: structuralOrderHash(orderEntries),
    protectedHashes,
  };
}

export class OpenAIChatCompletionsCodec extends BaseProviderCodec {
  readonly provider = "openai-chat-completions" as const;

  constructor() {
    super(new OpenAIChatCompletionsAdapter());
  }

  protected assertEnvelope(value: Readonly<JsonRecord>): void {
    messages(value);
    if ("model" in value && typeof value.model !== "string") {
      throw new Error("OpenAI Chat Completions request.model must be a string");
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
      const messageItem = itemForMessage(context, messageIndex);
      const label = messageItem?.id || `message ${messageIndex + 1}`;
      const mutableRole = role === "user" || role === "assistant" || role === "tool";

      if (typeof rawMessage.content === "string") {
        add({
          kind:
            role === "assistant"
              ? "assistant-text"
              : role === "tool"
                ? "tool-result-text"
                : role === "user"
                  ? "user-text"
                  : "other",
          value: rawMessage.content,
          displayLabel:
            role === "tool"
              ? toolItemForMessage(context, messageIndex, "tool-result")?.id || label
              : label,
          providerPath: ["messages", messageIndex, "content"],
          mutable: mutableRole,
          ...(!mutableRole ? { protectedReason: `protected ${String(role)} message` } : {}),
        });
      } else if (Array.isArray(rawMessage.content)) {
        rawMessage.content.forEach((rawPart, partIndex) => {
          if (!isRecord(rawPart)) return;
          const path = ["messages", messageIndex, "content", partIndex] as const;
          if (rawPart.type === "text" && typeof rawPart.text === "string") {
            add({
              kind:
                role === "assistant"
                  ? "assistant-text"
                  : role === "tool"
                    ? "tool-result-text"
                    : "user-text",
              value: rawPart.text,
              displayLabel:
                role === "tool"
                  ? toolItemForMessage(context, messageIndex, "tool-result")?.id || label
                  : label,
              providerPath: [...path, "text"],
              mutable: mutableRole,
              ...(!mutableRole ? { protectedReason: `protected ${String(role)} message` } : {}),
            });
          } else if (rawPart.type === "image_url" || rawPart.type === "input_image") {
            add({
              kind: "image",
              value: rawPart,
              displayLabel: label,
              providerPath: path,
              mutable: role === "user",
              ...(role !== "user" ? { protectedReason: "Image outside a user message" } : {}),
            });
          } else if (rawPart.type === "file" || rawPart.type === "input_file") {
            add({
              kind: "document",
              value: rawPart,
              displayLabel: label,
              providerPath: path,
              mutable: role === "user",
              ...(role !== "user"
                ? { protectedReason: "Document outside a user message" }
                : {}),
            });
          } else {
            add({
              kind: "other",
              value: rawPart,
              displayLabel: label,
              providerPath: path,
              mutable: false,
              protectedReason: "Unknown Chat Completions content is protected",
            });
          }
        });
      }

      if (Array.isArray(rawMessage.tool_calls)) {
        rawMessage.tool_calls.forEach((rawCall, callIndex) => {
          const toolItem = toolItemForMessage(
            context,
            messageIndex,
            "tool-call",
            callIndex
          );
          add({
            kind: "tool-call",
            value: rawCall,
            displayLabel: toolItem?.id || label,
            providerPath: ["messages", messageIndex, "tool_calls", callIndex],
            mutable: false,
            protectedReason: "Tool call name, id, and arguments are protected",
          });
        });
      }

      if (!mutableRole) {
        add({
          kind: "other",
          value: rawMessage,
          displayLabel: label,
          providerPath: ["messages", messageIndex],
          mutable: false,
          protectedReason: `The ${String(role)} message envelope is protected`,
        });
      }
    });

    const inspected = inspectChat(value, []);
    return {
      provider: this.provider,
      occurrences,
      itemOrderHash: inspected.itemOrderHash,
      protectedHashes: inspected.protectedHashes,
      itemCount: inspected.itemCount,
    };
  }

  protected inspectStructure(value: Readonly<JsonRecord>, errors: string[]) {
    return inspectChat(value, errors);
  }
}
