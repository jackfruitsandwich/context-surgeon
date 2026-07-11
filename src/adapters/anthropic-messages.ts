import type {
  AssistantMessage,
  ContentBlock,
  ContextItem,
  ContextObject,
  FormatAdapter,
  OtherItem,
  ToolCall,
  ToolResult,
  UserMessage,
} from "../context/types.js";

type AnthropicRequest = {
  system?: string | AnthropicContentBlock[];
  messages: AnthropicMessage[];
  [key: string]: unknown;
};

type AnthropicMessage = {
  role: "user" | "assistant" | "system";
  content: string | AnthropicContentBlock[];
  [key: string]: unknown;
};

type AnthropicTextBlock = {
  type: "text";
  text: string;
  [key: string]: unknown;
};

type AnthropicToolUseBlock = {
  type: "tool_use";
  id: string;
  name: string;
  input: unknown;
  [key: string]: unknown;
};

type AnthropicToolResultBlock = {
  type: "tool_result";
  tool_use_id: string;
  content: string | AnthropicContentBlock[];
  [key: string]: unknown;
};

type AnthropicContentBlock =
  | AnthropicTextBlock
  | AnthropicToolUseBlock
  | AnthropicToolResultBlock
  | { type: string; [key: string]: unknown };

function isAnthropicToolUseBlock(
  block: AnthropicContentBlock
): block is AnthropicToolUseBlock {
  return (
    block.type === "tool_use" &&
    typeof (block as { id?: unknown }).id === "string" &&
    typeof (block as { name?: unknown }).name === "string"
  );
}

function isAnthropicToolResultBlock(
  block: AnthropicContentBlock
): block is AnthropicToolResultBlock {
  return (
    block.type === "tool_result" &&
    typeof (block as { tool_use_id?: unknown }).tool_use_id === "string"
  );
}

function normalizeMessageContent(
  content: AnthropicMessage["content"]
): AnthropicContentBlock[] {
  if (typeof content === "string") {
    return [{ type: "text", text: content }];
  }
  if (Array.isArray(content)) {
    return content as AnthropicContentBlock[];
  }
  return [];
}

function extractSystemPrompt(system: AnthropicRequest["system"]): string {
  if (typeof system === "string") {
    return system;
  }
  if (!Array.isArray(system)) {
    return "";
  }
  return system
    .filter(
      (block): block is AnthropicTextBlock =>
        block.type === "text" && typeof block.text === "string"
    )
    .map((block) => block.text)
    .join("\n");
}

function serializeSystem(
  systemRaw: ContextObject["systemRaw"],
  systemPrompt: string
): AnthropicRequest["system"] | undefined {
  if (typeof systemRaw === "string") {
    return systemPrompt;
  }
  if (systemRaw !== undefined) {
    return systemRaw as AnthropicRequest["system"];
  }
  return systemPrompt ? systemPrompt : undefined;
}

function parseContentBlock(block: AnthropicContentBlock): ContentBlock {
  if (block.type === "text" && typeof block.text === "string") {
    return { type: "text", text: block.text };
  }
  if (block.type === "image") {
    return { type: "image", data: block };
  }
  if (block.type === "document") {
    return { type: "document", data: block };
  }
  return { type: "other", raw: block };
}

function parseToolResultContent(
  content: AnthropicToolResultBlock["content"]
): string | ContentBlock[] {
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return "";
  }
  return content.map((block) => parseContentBlock(block));
}

function serializeContentBlock(
  block: ContentBlock,
  originalBlock?: AnthropicContentBlock
): AnthropicContentBlock {
  if (block.type === "text") {
    if (originalBlock?.type === "text") {
      return { ...originalBlock, text: block.text };
    }
    return { type: "text", text: block.text };
  }
  if (block.type === "image") {
    return block.data as AnthropicContentBlock;
  }
  if (block.type === "document") {
    return block.data as AnthropicContentBlock;
  }
  return block.raw as AnthropicContentBlock;
}

function serializeToolInput(argumentsText: string, rawInput: unknown): unknown {
  try {
    return JSON.parse(argumentsText);
  } catch {
    if (rawInput !== undefined) {
      return rawInput;
    }
    return { _context_surgeon_arguments: argumentsText };
  }
}

function serializeToolResultOutput(
  output: ToolResult["output"],
  rawContent: AnthropicToolResultBlock["content"]
): AnthropicToolResultBlock["content"] {
  if (typeof output === "string") {
    return output;
  }

  if (!Array.isArray(output)) {
    return typeof rawContent === "string" ? rawContent : [];
  }

  const originalBlocks = Array.isArray(rawContent) ? rawContent : [];

  return output.map((block, index) =>
    serializeContentBlock(block, originalBlocks[index])
  );
}

function denormalizeMessageContent(
  originalContent: AnthropicMessage["content"],
  content: AnthropicContentBlock[]
): AnthropicMessage["content"] {
  if (
    typeof originalContent === "string" &&
    content.length === 1 &&
    content[0]?.type === "text" &&
    typeof content[0].text === "string"
  ) {
    return content[0].text;
  }
  return content;
}

function getMessageItemByIndex(
  items: ContextItem[]
): Map<number, UserMessage | AssistantMessage | OtherItem> {
  const map = new Map<number, UserMessage | AssistantMessage | OtherItem>();
  for (const item of items) {
    if (
      (item.kind === "user-message" ||
        item.kind === "assistant-message" ||
        item.kind === "other") &&
      typeof item.messageIndex === "number"
    ) {
      map.set(item.messageIndex, item);
    }
  }
  return map;
}

export class AnthropicMessagesAdapter implements FormatAdapter {
  parse(json: Record<string, unknown>): ContextObject {
    const req = json as AnthropicRequest;
    const items: ContextItem[] = [];

    req.messages.forEach((message, messageIndex) => {
      if (message.role === "system") {
        items.push({
          kind: "other",
          id: "",
          raw: message,
          messageIndex,
        });
        return;
      }
      const blocks = normalizeMessageContent(message.content);
      const content: ContentBlock[] = [];
      const blockIndices: number[] = [];

      blocks.forEach((block, blockIndex) => {
        if (isAnthropicToolUseBlock(block)) {
          items.push({
            kind: "tool-call",
            id: "",
            callId: block.id,
            name: block.name,
            arguments: JSON.stringify(block.input ?? {}),
            raw: block,
            location: { messageIndex, blockIndex },
          });
          return;
        }

        if (isAnthropicToolResultBlock(block)) {
          items.push({
            kind: "tool-result",
            id: "",
            callId: block.tool_use_id,
            output: parseToolResultContent(block.content),
            raw: block,
            location: { messageIndex, blockIndex },
          });
          return;
        }

        content.push(parseContentBlock(block));
        blockIndices.push(blockIndex);
      });

      items.push({
        kind:
          message.role === "user" ? "user-message" : "assistant-message",
        id: "",
        content,
        raw: message,
        messageIndex,
        blockIndices,
      });
    });

    const { messages, system, ...rawRequest } = req;

    return {
      systemPrompt: extractSystemPrompt(system),
      systemRaw: system,
      items,
      rawRequest,
      format: "anthropic-messages",
    };
  }

  serialize(ctx: ContextObject): Record<string, unknown> {
    const messageItems = getMessageItemByIndex(ctx.items);
    const toolCalls = new Map<string, ToolCall>();
    const toolResults = new Map<string, ToolResult>();

    for (const item of ctx.items) {
      if (item.kind === "tool-call" && item.location) {
        toolCalls.set(
          `${item.location.messageIndex}:${item.location.blockIndex}`,
          item
        );
      } else if (item.kind === "tool-result" && item.location) {
        toolResults.set(
          `${item.location.messageIndex}:${item.location.blockIndex}`,
          item
        );
      }
    }

    const messages = [...messageItems.entries()]
      .sort(([left], [right]) => left - right)
      .map(([, messageItem]) => {
        if (messageItem.kind === "other") {
          return structuredClone(messageItem.raw as AnthropicMessage);
        }
        const rawMessage = structuredClone(
          messageItem.raw as AnthropicMessage
        );
        const originalBlocks = normalizeMessageContent(rawMessage.content);
        const nonToolBlockMap = new Map<number, number>();
        const usedContentIndices = new Set<number>();

        (messageItem.blockIndices || []).forEach((blockIndex, contentIndex) => {
          nonToolBlockMap.set(blockIndex, contentIndex);
        });

        const rebuiltBlocks: AnthropicContentBlock[] = [];
        originalBlocks.forEach((originalBlock, blockIndex) => {
          const locationKey = `${messageItem.messageIndex}:${blockIndex}`;
          const toolCall = toolCalls.get(locationKey);
          if (toolCall) {
            const rawBlock = toolCall.raw as AnthropicToolUseBlock;
            rebuiltBlocks.push({
              ...rawBlock,
              input: serializeToolInput(toolCall.arguments, rawBlock.input),
            });
            return;
          }

          const toolResult = toolResults.get(locationKey);
          if (toolResult) {
            const rawBlock = toolResult.raw as AnthropicToolResultBlock;
            rebuiltBlocks.push({
              ...rawBlock,
              content: serializeToolResultOutput(
                toolResult.output,
                rawBlock.content
              ),
            });
            return;
          }

          const contentIndex = nonToolBlockMap.get(blockIndex);
          if (contentIndex === undefined) {
            rebuiltBlocks.push(structuredClone(originalBlock));
            return;
          }

          const contentBlock = messageItem.content[contentIndex];
          if (!contentBlock) {
            return;
          }
          usedContentIndices.add(contentIndex);
          rebuiltBlocks.push(
            serializeContentBlock(contentBlock, originalBlock)
          );
        });

        messageItem.content.forEach((block, contentIndex) => {
          if (!usedContentIndices.has(contentIndex)) {
            rebuiltBlocks.push(serializeContentBlock(block));
          }
        });

        rawMessage.content = denormalizeMessageContent(
          rawMessage.content,
          rebuiltBlocks
        );

        return rawMessage;
      });

    const system = serializeSystem(ctx.systemRaw, ctx.systemPrompt);

    return {
      ...ctx.rawRequest,
      ...(system !== undefined ? { system } : {}),
      messages,
    };
  }
}
