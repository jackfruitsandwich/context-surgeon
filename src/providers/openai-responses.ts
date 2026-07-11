import type { ContextObject } from "../context/types.js";
import type { ProviderProjection } from "../contracts/provider.js";
import type { Occurrence, ResolvedIdentity } from "../contracts/state.js";
import { OpenAIResponsesAdapter } from "../adapters/openai-responses.js";
import { BaseProviderCodec } from "./base.js";
import {
  isRecord,
  makeOccurrence,
  prepareContext,
  pushProtectedHash,
  structuralOrderHash,
  type JsonRecord,
} from "./shared.js";

const MESSAGE_ROLES = new Set(["user", "assistant", "system", "developer"]);
const REASONING_TYPES = new Set([
  "reasoning",
  "computer_call",
  "computer_call_output",
  "item_reference",
]);

function inputItems(value: Readonly<JsonRecord>): unknown[] {
  if (!Array.isArray(value.input)) {
    throw new Error("OpenAI Responses request.input must be an array");
  }
  return value.input;
}

function isMessage(item: JsonRecord): boolean {
  return (
    item.type === "message" ||
    (item.type === undefined && typeof item.role === "string")
  );
}

function messageLabel(context: ContextObject, index: number): string {
  return context.items[index]?.id || `input item ${index + 1}`;
}

function inspectResponses(value: Readonly<JsonRecord>, errors: string[]) {
  const items = inputItems(value);
  const protectedHashes: Record<string, string> = {};
  const orderEntries: unknown[] = [];
  const calls = new Map<string, number>();
  const results = new Set<string>();

  items.forEach((rawItem, index) => {
    if (!isRecord(rawItem)) {
      errors.push(`input[${index}] must be an object`);
      orderEntries.push({ index, invalid: true });
      return;
    }

    const item = rawItem;
    if (isMessage(item)) {
      if (typeof item.role !== "string" || !MESSAGE_ROLES.has(item.role)) {
        errors.push(`input[${index}].role is unsupported`);
      }
      pushProtectedHash(protectedHashes, ["input", index, "role"], item.role);
      const content = item.content;
      if (typeof content !== "string" && !Array.isArray(content)) {
        errors.push(`input[${index}].content must be a string or array`);
      }
      if (Array.isArray(content)) {
        content.forEach((rawBlock, blockIndex) => {
          if (!isRecord(rawBlock) || typeof rawBlock.type !== "string") {
            errors.push(`input[${index}].content[${blockIndex}] is invalid`);
            return;
          }
          const textType =
            rawBlock.type === "input_text" || rawBlock.type === "output_text";
          const mediaType =
            rawBlock.type === "input_image" || rawBlock.type === "input_file";
          if (textType && typeof rawBlock.text !== "string") {
            errors.push(
              `input[${index}].content[${blockIndex}].text must be a string`
            );
          }
          if (!textType && !mediaType) {
            pushProtectedHash(
              protectedHashes,
              ["input", index, "content", blockIndex],
              rawBlock
            );
          }
        });
      }
      orderEntries.push({ type: item.type ?? "typeless-message", role: item.role });
      return;
    }

    if (item.type === "function_call") {
      const callId = item.call_id;
      if (
        typeof callId !== "string" ||
        !callId ||
        typeof item.name !== "string" ||
        !item.name ||
        typeof item.arguments !== "string"
      ) {
        errors.push(`input[${index}] has an invalid function_call`);
      } else if (calls.has(callId)) {
        errors.push(`Duplicate function_call id ${callId}`);
      } else {
        calls.set(callId, index);
      }
      pushProtectedHash(protectedHashes, ["input", index], item);
      orderEntries.push({ type: item.type, callId });
      return;
    }

    if (item.type === "function_call_output") {
      const callId = item.call_id;
      if (typeof callId !== "string" || !callId || typeof item.output !== "string") {
        errors.push(`input[${index}] has an invalid function_call_output`);
      } else {
        if (results.has(callId)) {
          errors.push(`Duplicate function_call_output id ${callId}`);
        }
        results.add(callId);
        const callIndex = calls.get(callId);
        if (callIndex === undefined || callIndex >= index) {
          errors.push(`function_call_output ${callId} has no preceding call`);
        }
      }
      pushProtectedHash(
        protectedHashes,
        ["input", index],
        { ...item, output: undefined },
        ":envelope"
      );
      orderEntries.push({ type: item.type, callId });
      return;
    }

    if (typeof item.type !== "string") {
      errors.push(`input[${index}].type must be a string`);
    }
    pushProtectedHash(protectedHashes, ["input", index], item);
    orderEntries.push({ type: item.type, opaque: true });
  });

  return {
    itemCount: items.length,
    itemOrderHash: structuralOrderHash(orderEntries),
    protectedHashes,
  };
}

export class OpenAIResponsesCodec extends BaseProviderCodec {
  readonly provider = "openai-responses" as const;

  constructor() {
    super(new OpenAIResponsesAdapter());
  }

  protected assertEnvelope(value: Readonly<JsonRecord>): void {
    inputItems(value);
    if ("model" in value && typeof value.model !== "string") {
      throw new Error("OpenAI Responses request.model must be a string");
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
    const items = inputItems(value);
    const occurrences: Occurrence[] = [];
    let predecessorId = "";

    const add = (input: Parameters<typeof makeOccurrence>[1]) => {
      const occurrence = makeOccurrence(identity, { ...input, predecessorId });
      predecessorId = occurrence.occurrenceId;
      occurrences.push(occurrence);
    };

    items.forEach((rawItem, index) => {
      if (!isRecord(rawItem)) return;
      const label = messageLabel(context, index);
      if (isMessage(rawItem)) {
        const role = rawItem.role;
        const mutableRole = role === "user" || role === "assistant";
        if (typeof rawItem.content === "string") {
          add({
            kind:
              role === "assistant"
                ? "assistant-text"
                : role === "user"
                  ? "user-text"
                  : "other",
            value: rawItem.content,
            displayLabel: label,
            providerPath: ["input", index, "content"],
            mutable: mutableRole,
            ...(!mutableRole ? { protectedReason: `protected ${String(role)} message` } : {}),
          });
          return;
        }
        if (!Array.isArray(rawItem.content)) return;
        rawItem.content.forEach((rawBlock, blockIndex) => {
          if (!isRecord(rawBlock)) return;
          const path = ["input", index, "content", blockIndex] as const;
          if (
            (rawBlock.type === "input_text" || rawBlock.type === "output_text") &&
            typeof rawBlock.text === "string"
          ) {
            add({
              kind: role === "assistant" ? "assistant-text" : "user-text",
              value: rawBlock.text,
              displayLabel: label,
              providerPath: [...path, "text"],
              mutable: mutableRole,
              ...(!mutableRole
                ? { protectedReason: `protected ${String(role)} message` }
                : {}),
            });
          } else if (rawBlock.type === "input_image") {
            add({
              kind: "image",
              value: rawBlock,
              displayLabel: label,
              providerPath: path,
              mutable: mutableRole,
              ...(!mutableRole ? { protectedReason: "image in protected role" } : {}),
            });
          } else if (rawBlock.type === "input_file") {
            add({
              kind: "document",
              value: rawBlock,
              displayLabel: label,
              providerPath: path,
              mutable: mutableRole,
              ...(!mutableRole ? { protectedReason: "document in protected role" } : {}),
            });
          } else {
            add({
              kind: REASONING_TYPES.has(String(rawBlock.type))
                ? "reasoning"
                : "other",
              value: rawBlock,
              displayLabel: label,
              providerPath: path,
              mutable: false,
              protectedReason: REASONING_TYPES.has(String(rawBlock.type))
                ? "OpenAI reasoning/opaque content is protected"
                : "Unknown OpenAI content block is protected",
            });
          }
        });
        return;
      }

      if (rawItem.type === "function_call") {
        add({
          kind: "tool-call",
          value: rawItem,
          displayLabel: label,
          providerPath: ["input", index],
          mutable: false,
          protectedReason: "Tool call name, id, and arguments are protected",
        });
      } else if (
        rawItem.type === "function_call_output" &&
        typeof rawItem.output === "string"
      ) {
        add({
          kind: "tool-result-text",
          value: rawItem.output,
          displayLabel: label,
          providerPath: ["input", index, "output"],
          mutable: true,
        });
      } else {
        add({
          kind: REASONING_TYPES.has(String(rawItem.type)) ? "reasoning" : "other",
          value: rawItem,
          displayLabel: label,
          providerPath: ["input", index],
          mutable: false,
          protectedReason: REASONING_TYPES.has(String(rawItem.type))
            ? "OpenAI reasoning/opaque item is protected"
            : "Unknown OpenAI item is protected",
        });
      }
    });

    const inspected = inspectResponses(value, []);
    return {
      provider: this.provider,
      occurrences,
      itemOrderHash: inspected.itemOrderHash,
      protectedHashes: inspected.protectedHashes,
      itemCount: inspected.itemCount,
    };
  }

  protected inspectStructure(value: Readonly<JsonRecord>, errors: string[]) {
    return inspectResponses(value, errors);
  }
}
