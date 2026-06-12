import type {
  AssistantMessage,
  ContentBlock,
  ContextItem,
  ContextObject,
  FormatAdapter,
  ToolCall,
  ToolResult,
  UserMessage,
} from "../context/types.js";

// OpenAI Chat Completions API (/v1/chat/completions). This is the format
// Cursor's "Override OpenAI Base URL" mode sends. Tool calls live inside
// assistant messages (`tool_calls`), tool results are standalone
// `role: "tool"` messages, and system prompts are `role: "system"` (or
// "developer") messages within the array.

type ChatRequest = {
  messages: ChatMessage[];
  [key: string]: unknown;
};

type ChatMessage = {
  role: string;
  content?: string | null | ChatContentPart[];
  tool_calls?: ChatToolCall[];
  tool_call_id?: string;
  [key: string]: unknown;
};

type ChatToolCall = {
  id: string;
  type?: string;
  function?: {
    name?: string;
    arguments?: string;
    [key: string]: unknown;
  };
  [key: string]: unknown;
};

type ChatTextPart = {
  type: "text";
  text: string;
  [key: string]: unknown;
};

type ChatContentPart = ChatTextPart | { type: string; [key: string]: unknown };

function normalizeContent(
  content: ChatMessage["content"]
): ChatContentPart[] {
  if (typeof content === "string") {
    return [{ type: "text", text: content }];
  }
  if (Array.isArray(content)) {
    return content;
  }
  return [];
}

function parseContentPart(part: ChatContentPart): ContentBlock {
  if (part.type === "text" && typeof (part as ChatTextPart).text === "string") {
    return { type: "text", text: (part as ChatTextPart).text };
  }
  if (part.type === "image_url" || part.type === "input_image") {
    return { type: "image", data: part };
  }
  if (part.type === "file" || part.type === "input_file") {
    return { type: "document", data: part };
  }
  return { type: "other", raw: part };
}

function serializeContentPart(
  block: ContentBlock,
  originalPart?: ChatContentPart
): ChatContentPart {
  if (block.type === "text") {
    if (originalPart?.type === "text") {
      return { ...originalPart, text: block.text };
    }
    return { type: "text", text: block.text };
  }
  if (block.type === "image") {
    return block.data as ChatContentPart;
  }
  if (block.type === "document") {
    return block.data as ChatContentPart;
  }
  return block.raw as ChatContentPart;
}

function systemText(messages: ChatMessage[]): string {
  return messages
    .filter((m) => m.role === "system" || m.role === "developer")
    .map((m) =>
      normalizeContent(m.content)
        .filter(
          (part): part is ChatTextPart =>
            part.type === "text" && typeof (part as ChatTextPart).text === "string"
        )
        .map((part) => part.text)
        .join("\n")
    )
    .join("\n");
}

function denormalizeContent(
  originalContent: ChatMessage["content"],
  parts: ChatContentPart[]
): ChatMessage["content"] {
  const isOriginalStringLike =
    typeof originalContent === "string" || originalContent == null;
  if (
    isOriginalStringLike &&
    parts.length === 1 &&
    parts[0]?.type === "text" &&
    typeof (parts[0] as ChatTextPart).text === "string"
  ) {
    return (parts[0] as ChatTextPart).text;
  }
  if (isOriginalStringLike && parts.length === 0) {
    return originalContent === undefined ? undefined : originalContent;
  }
  return parts;
}

function serializeToolResultContent(
  output: ToolResult["output"],
  rawContent: ChatMessage["content"]
): ChatMessage["content"] {
  if (typeof output === "string") {
    return output;
  }
  if (!Array.isArray(output)) {
    return typeof rawContent === "string" ? rawContent : "";
  }
  const originalParts = normalizeContent(rawContent);
  const parts = output.map((block, index) =>
    serializeContentPart(block, originalParts[index])
  );
  return denormalizeContent(rawContent, parts);
}

export class OpenAIChatCompletionsAdapter implements FormatAdapter {
  parse(json: Record<string, unknown>): ContextObject {
    const req = json as ChatRequest;
    const items: ContextItem[] = [];

    req.messages.forEach((message, messageIndex) => {
      if (message.role === "user" || message.role === "assistant") {
        if (message.role === "assistant" && Array.isArray(message.tool_calls)) {
          message.tool_calls.forEach((toolCall, blockIndex) => {
            items.push({
              kind: "tool-call",
              id: "",
              callId: typeof toolCall.id === "string" ? toolCall.id : "",
              name: toolCall.function?.name ?? "",
              arguments: toolCall.function?.arguments ?? "",
              raw: toolCall,
              location: { messageIndex, blockIndex },
            });
          });
        }

        const parts = normalizeContent(message.content);
        const content: ContentBlock[] = [];
        const blockIndices: number[] = [];
        parts.forEach((part, partIndex) => {
          content.push(parseContentPart(part));
          blockIndices.push(partIndex);
        });

        items.push({
          kind: message.role === "user" ? "user-message" : "assistant-message",
          id: "",
          content,
          raw: message,
          messageIndex,
          blockIndices,
        });
        return;
      }

      if (message.role === "tool") {
        const rawContent = message.content;
        items.push({
          kind: "tool-result",
          id: "",
          callId:
            typeof message.tool_call_id === "string" ? message.tool_call_id : "",
          output:
            typeof rawContent === "string"
              ? rawContent
              : normalizeContent(rawContent).map(parseContentPart),
          raw: message,
          location: { messageIndex, blockIndex: 0 },
        });
        return;
      }

      // system / developer / anything else passes through untouched
      items.push({
        kind: "other",
        id: "",
        raw: message,
        messageIndex,
      });
    });

    const { messages, ...rawRequest } = req;

    return {
      systemPrompt: systemText(req.messages),
      items,
      rawRequest,
      format: "openai-chat-completions",
    };
  }

  serialize(ctx: ContextObject): Record<string, unknown> {
    const toolCallsByMessage = new Map<number, ToolCall[]>();
    const messagesByIndex = new Map<number, ChatMessage>();

    for (const item of ctx.items) {
      if (item.kind === "tool-call" && item.location) {
        const list = toolCallsByMessage.get(item.location.messageIndex) ?? [];
        list.push(item);
        toolCallsByMessage.set(item.location.messageIndex, list);
      }
    }

    for (const item of ctx.items) {
      if (item.kind === "user-message" || item.kind === "assistant-message") {
        if (typeof item.messageIndex !== "number") continue;
        messagesByIndex.set(
          item.messageIndex,
          this.serializeMessage(item, toolCallsByMessage.get(item.messageIndex))
        );
      } else if (item.kind === "tool-result" && item.location) {
        const rawMessage = structuredClone(item.raw as ChatMessage);
        rawMessage.content = serializeToolResultContent(
          item.output,
          (item.raw as ChatMessage).content
        );
        messagesByIndex.set(item.location.messageIndex, rawMessage);
      } else if (item.kind === "other" && typeof item.messageIndex === "number") {
        messagesByIndex.set(
          item.messageIndex,
          structuredClone(item.raw as ChatMessage)
        );
      }
    }

    const messages = [...messagesByIndex.entries()]
      .sort(([left], [right]) => left - right)
      .map(([, message]) => message);

    return {
      ...ctx.rawRequest,
      messages,
    };
  }

  private serializeMessage(
    item: UserMessage | AssistantMessage,
    toolCalls: ToolCall[] | undefined
  ): ChatMessage {
    const rawMessage = structuredClone(item.raw as ChatMessage);
    const originalParts = normalizeContent(rawMessage.content);
    const usedContentIndices = new Set<number>();
    const partIndexToContentIndex = new Map<number, number>();

    (item.blockIndices || []).forEach((partIndex, contentIndex) => {
      partIndexToContentIndex.set(partIndex, contentIndex);
    });

    const rebuiltParts: ChatContentPart[] = [];
    originalParts.forEach((originalPart, partIndex) => {
      const contentIndex = partIndexToContentIndex.get(partIndex);
      if (contentIndex === undefined) {
        rebuiltParts.push(structuredClone(originalPart));
        return;
      }
      const contentBlock = item.content[contentIndex];
      if (!contentBlock) {
        return;
      }
      usedContentIndices.add(contentIndex);
      rebuiltParts.push(serializeContentPart(contentBlock, originalPart));
    });

    item.content.forEach((block, contentIndex) => {
      if (!usedContentIndices.has(contentIndex)) {
        rebuiltParts.push(serializeContentPart(block));
      }
    });

    rawMessage.content = denormalizeContent(rawMessage.content, rebuiltParts);

    if (toolCalls && toolCalls.length > 0) {
      rawMessage.tool_calls = toolCalls
        .slice()
        .sort(
          (left, right) =>
            (left.location?.blockIndex ?? 0) - (right.location?.blockIndex ?? 0)
        )
        .map((toolCall) => {
          const rawToolCall = structuredClone(toolCall.raw as ChatToolCall);
          return {
            ...rawToolCall,
            function: {
              ...(rawToolCall.function ?? {}),
              name: toolCall.name,
              arguments: toolCall.arguments,
            },
          };
        });
    }

    return rawMessage;
  }
}
