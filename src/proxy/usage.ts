import type { IncomingHttpHeaders } from "node:http";

export type ProviderFormat =
  | "openai-responses"
  | "anthropic-messages"
  | "openai-chat-completions";

type UsageTap = {
  onChunk: (chunk: Buffer) => void;
  onEnd: () => void;
};

type AnthropicUsageState = {
  inputTokens: number | null;
  cacheCreationInputTokens: number | null;
  cacheReadInputTokens: number | null;
};

function getHeader(
  headers: IncomingHttpHeaders,
  name: string
): string {
  const value = headers[name];
  if (Array.isArray(value)) {
    return value.join(", ");
  }
  return value ?? "";
}

function updateAnthropicField(
  current: number | null,
  next: unknown
): number | null {
  if (typeof next !== "number") {
    return current;
  }
  if (current === null) {
    return next;
  }
  return next > 0 ? next : current;
}

function updateAnthropicUsageState(
  state: AnthropicUsageState,
  usage: unknown
): number | null {
  if (!usage || typeof usage !== "object") {
    return state.inputTokens === null
      ? null
      : state.inputTokens +
          (state.cacheCreationInputTokens ?? 0) +
          (state.cacheReadInputTokens ?? 0);
  }

  const record = usage as Record<string, unknown>;

  state.inputTokens = updateAnthropicField(
    state.inputTokens,
    record.input_tokens
  );
  state.cacheCreationInputTokens = updateAnthropicField(
    state.cacheCreationInputTokens,
    record.cache_creation_input_tokens
  );
  state.cacheReadInputTokens = updateAnthropicField(
    state.cacheReadInputTokens,
    record.cache_read_input_tokens
  );

  return state.inputTokens === null
    ? null
    : state.inputTokens +
        (state.cacheCreationInputTokens ?? 0) +
        (state.cacheReadInputTokens ?? 0);
}

function promptTokensFromAnthropicPayload(
  payload: unknown,
  state: AnthropicUsageState
): number | null {
  if (!payload || typeof payload !== "object") {
    return null;
  }

  const record = payload as Record<string, unknown>;
  if (
    record.type === "message_start" &&
    record.message &&
    typeof record.message === "object"
  ) {
    return updateAnthropicUsageState(
      state,
      (record.message as Record<string, unknown>).usage
    );
  }

  if ("usage" in record) {
    return updateAnthropicUsageState(state, record.usage);
  }

  return null;
}

function promptTokensFromOpenAiPayload(payload: unknown): number | null {
  if (!payload || typeof payload !== "object") {
    return null;
  }

  const record = payload as Record<string, unknown>;
  const response =
    record.response && typeof record.response === "object"
      ? record.response
      : record;

  if (!response || typeof response !== "object") {
    return null;
  }

  const usage = (response as Record<string, unknown>).usage;
  if (!usage || typeof usage !== "object") {
    return null;
  }

  const inputTokens = (usage as Record<string, unknown>).input_tokens;
  return typeof inputTokens === "number" ? inputTokens : null;
}

function promptTokensFromChatCompletionsPayload(payload: unknown): number | null {
  if (!payload || typeof payload !== "object") {
    return null;
  }

  const usage = (payload as Record<string, unknown>).usage;
  if (!usage || typeof usage !== "object") {
    return null;
  }

  const promptTokens = (usage as Record<string, unknown>).prompt_tokens;
  return typeof promptTokens === "number" ? promptTokens : null;
}

function extractPromptTokens(
  format: ProviderFormat,
  payload: unknown,
  anthropicState: AnthropicUsageState
): number | null {
  if (format === "openai-responses") {
    return promptTokensFromOpenAiPayload(payload);
  }
  if (format === "openai-chat-completions") {
    return promptTokensFromChatCompletionsPayload(payload);
  }
  return promptTokensFromAnthropicPayload(payload, anthropicState);
}

function createSseTap(
  format: ProviderFormat,
  onPromptTokens: (tokens: number) => void
): UsageTap {
  let buffer = "";
  const anthropicState: AnthropicUsageState = {
    inputTokens: null,
    cacheCreationInputTokens: null,
    cacheReadInputTokens: null,
  };

  function processEventBlock(block: string): void {
    const dataLines = block
      .split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart());

    if (dataLines.length === 0) {
      return;
    }

    const data = dataLines.join("\n");
    if (!data || data === "[DONE]") {
      return;
    }

    try {
      const payload = JSON.parse(data) as unknown;
      const tokens = extractPromptTokens(format, payload, anthropicState);
      if (tokens !== null) {
        onPromptTokens(tokens);
      }
    } catch {
      // Ignore malformed SSE payloads and continue streaming.
    }
  }

  return {
    onChunk(chunk) {
      buffer += chunk.toString("utf-8").replace(/\r\n/g, "\n");

      let boundary = buffer.indexOf("\n\n");
      while (boundary !== -1) {
        processEventBlock(buffer.slice(0, boundary));
        buffer = buffer.slice(boundary + 2);
        boundary = buffer.indexOf("\n\n");
      }
    },
    onEnd() {
      if (buffer.trim()) {
        processEventBlock(buffer);
      }
    },
  };
}

function createJsonTap(
  format: ProviderFormat,
  onPromptTokens: (tokens: number) => void
): UsageTap {
  let body = "";
  const anthropicState: AnthropicUsageState = {
    inputTokens: null,
    cacheCreationInputTokens: null,
    cacheReadInputTokens: null,
  };

  return {
    onChunk(chunk) {
      if (body.length <= 1_000_000) {
        body += chunk.toString("utf-8");
      }
    },
    onEnd() {
      try {
        const payload = JSON.parse(body) as unknown;
        const tokens = extractPromptTokens(format, payload, anthropicState);
        if (tokens !== null) {
          onPromptTokens(tokens);
        }
      } catch {
        // Ignore bodies that aren't parseable JSON.
      }
    },
  };
}

export function createUsageTap(
  format: ProviderFormat,
  headers: IncomingHttpHeaders,
  onPromptTokens?: (tokens: number) => void
): UsageTap | null {
  if (!onPromptTokens) {
    return null;
  }

  const contentType = getHeader(headers, "content-type").toLowerCase();

  if (contentType.includes("text/event-stream")) {
    return createSseTap(format, onPromptTokens);
  }

  if (contentType.includes("application/json")) {
    return createJsonTap(format, onPromptTokens);
  }

  return null;
}

export const testOnly = {
  promptTokensFromOpenAiPayload,
};
