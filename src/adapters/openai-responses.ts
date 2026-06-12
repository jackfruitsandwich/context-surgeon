import type {
  ContextObject,
  ContextItem,
  ContentBlock,
  FormatAdapter,
} from "../context/types.js";

// --- Wire format types (OpenAI Responses API) ---

type ResponsesRequest = {
  model: string;
  instructions: string;
  input: ResponseInputItem[];
  [key: string]: unknown;
};

type ResponseInputItem =
  | MessageItem
  | FunctionCallItem
  | FunctionCallOutputItem
  | { type: string; [key: string]: unknown }; // catch-all

type MessageItem = {
  // Codex sends type: "message"; Cursor's BYOK dialect omits the type field
  // and may use a plain string for content.
  type?: "message";
  role: string;
  content: MessageContentItem[] | string;
  [key: string]: unknown;
};

type MessageContentItem =
  | { type: "input_text"; text: string; [key: string]: unknown }
  | { type: "output_text"; text: string; [key: string]: unknown }
  | { type: "input_image"; image_url: string; [key: string]: unknown }
  | { type: string; [key: string]: unknown }; // catch-all

type FunctionCallItem = {
  type: "function_call";
  name: string;
  arguments: string;
  call_id: string;
  [key: string]: unknown;
};

type FunctionCallOutputItem = {
  type: "function_call_output";
  call_id: string;
  output: string;
  [key: string]: unknown;
};

// --- Parsing helpers ---

function parseMessageContent(
  content: MessageContentItem[] | string
): ContentBlock[] {
  if (typeof content === "string") {
    return [{ type: "text", text: content }];
  }
  return content.map((item) => {
    if (
      (item.type === "input_text" || item.type === "output_text") &&
      typeof item.text === "string"
    ) {
      return { type: "text" as const, text: item.text };
    }
    if (item.type === "input_image") {
      return { type: "image" as const, data: item };
    }
    return { type: "other" as const, raw: item };
  });
}

function serializeContentBlock(
  block: ContentBlock,
  role: "user" | "assistant"
): MessageContentItem {
  if (block.type === "text") {
    return {
      type: role === "user" ? "input_text" : "output_text",
      text: block.text,
    };
  }
  if (block.type === "image") {
    return block.data as MessageContentItem;
  }
  // "other" — return raw
  return (block as { type: "other"; raw: unknown }).raw as MessageContentItem;
}

// --- Adapter ---

export class OpenAIResponsesAdapter implements FormatAdapter {
  parse(json: Record<string, unknown>): ContextObject {
    const req = json as unknown as ResponsesRequest;
    const items: ContextItem[] = [];
    let otherCounter = 0;

    for (const inputItem of req.input) {
      const isMessage =
        inputItem.type === "message" ||
        (inputItem.type === undefined &&
          typeof (inputItem as MessageItem).role === "string");
      if (isMessage) {
        const msg = inputItem as MessageItem;
        const content = parseMessageContent(msg.content || []);

        if (msg.role === "user") {
          items.push({
            kind: "user-message",
            id: "", // assigned later by id-assigner
            content,
            raw: msg,
          });
        } else if (msg.role === "assistant") {
          items.push({
            kind: "assistant-message",
            id: "",
            content,
            raw: msg,
          });
        } else {
          // developer, system, etc. — pass through
          items.push({
            kind: "other",
            id: `other_${++otherCounter}`,
            raw: msg,
          });
        }
      } else if (inputItem.type === "function_call") {
        const fc = inputItem as FunctionCallItem;
        items.push({
          kind: "tool-call",
          id: fc.call_id,
          callId: fc.call_id,
          name: fc.name,
          arguments: fc.arguments,
          raw: fc,
        });
      } else if (inputItem.type === "function_call_output") {
        const fco = inputItem as FunctionCallOutputItem;
        items.push({
          kind: "tool-result",
          id: fco.call_id,
          callId: fco.call_id,
          output: fco.output,
          raw: fco,
        });
      } else {
        // reasoning, compaction, web_search_call, etc. — pass through
        items.push({
          kind: "other",
          id: `other_${++otherCounter}`,
          raw: inputItem,
        });
      }
    }

    // Extract rawRequest (everything except instructions and input)
    const { instructions, input, ...rawRequest } = req;

    return {
      systemPrompt: instructions || "",
      items,
      rawRequest: rawRequest as Record<string, unknown>,
      format: "openai-responses",
    };
  }

  serialize(ctx: ContextObject): Record<string, unknown> {
    const input: ResponseInputItem[] = [];

    for (const item of ctx.items) {
      switch (item.kind) {
        case "user-message":
        case "assistant-message": {
          const role = item.kind === "user-message" ? "user" : "assistant";
          const rawMsg = item.raw as MessageItem;
          // Cursor's dialect uses plain string content — keep it a string as
          // long as the item is still a single text block.
          if (
            typeof rawMsg.content === "string" &&
            item.content.length === 1 &&
            item.content[0].type === "text"
          ) {
            input.push({
              ...rawMsg,
              content: item.content[0].text,
            });
            break;
          }
          const content = item.content.map((b) => serializeContentBlock(b, role));
          input.push({
            ...rawMsg,
            content,
          });
          break;
        }
        case "tool-call": {
          const rawFc = item.raw as FunctionCallItem;
          input.push({
            ...rawFc,
            arguments: item.arguments,
          });
          break;
        }
        case "tool-result": {
          const rawFco = item.raw as FunctionCallOutputItem;
          const output =
            typeof item.output === "string"
              ? item.output
              : item.output
                  .filter((b): b is { type: "text"; text: string } => b.type === "text")
                  .map((b) => b.text)
                  .join("\n");
          input.push({
            ...rawFco,
            output,
          });
          break;
        }
        case "other": {
          input.push(item.raw as ResponseInputItem);
          break;
        }
      }
    }

    return {
      ...ctx.rawRequest,
      instructions: ctx.systemPrompt,
      input,
    };
  }
}
