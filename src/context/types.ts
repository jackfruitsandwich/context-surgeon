// ---- Format-agnostic context abstraction ----

export type ContextObject = {
  systemPrompt: string;
  systemRaw?: unknown;
  items: ContextItem[];
  rawRequest: Record<string, unknown>;
  format: "openai-responses" | "anthropic-messages" | "openai-chat-completions";
};

export type BlockLocation = {
  messageIndex: number;
  blockIndex: number;
};

export type ContextItem =
  | UserMessage
  | AssistantMessage
  | ToolCall
  | ToolResult
  | OtherItem;

export type UserMessage = {
  kind: "user-message";
  id: string;
  fingerprint?: string;
  content: ContentBlock[];
  raw: unknown;
  messageIndex?: number;
  blockIndices?: number[];
};

export type AssistantMessage = {
  kind: "assistant-message";
  id: string;
  fingerprint?: string;
  content: ContentBlock[];
  raw: unknown;
  messageIndex?: number;
  blockIndices?: number[];
};

export type ToolCall = {
  kind: "tool-call";
  id: string;
  fingerprint?: string;
  callId: string;
  name: string;
  arguments: string;
  raw: unknown;
  location?: BlockLocation;
  labelText?: string;
};

export type ToolResult = {
  kind: "tool-result";
  id: string;
  fingerprint?: string;
  callId: string;
  output: string | ContentBlock[];
  raw: unknown;
  location?: BlockLocation;
  labelText?: string;
};

export type OtherItem = {
  kind: "other";
  id: string;
  fingerprint?: string;
  raw: unknown;
  messageIndex?: number;
};

export type ContentBlock =
  | { type: "text"; text: string }
  | { type: "image"; data: unknown }
  | { type: "document"; data: unknown }
  | { type: "other"; raw: unknown };

// ---- Directives ----

export type MediaType = "image" | "document";

export type Directive =
  | {
      type: "evict";
      mediaType?: MediaType;
      occurrences?: number[];
    }
  | { type: "replace"; content: string };

// Note: "restore" is not stored as a directive — it removes the directive
// and restores from shadow store in one step.

// ---- Adapter interface ----

export interface FormatAdapter {
  parse(json: Record<string, unknown>): ContextObject;
  serialize(ctx: ContextObject): Record<string, unknown>;
}
