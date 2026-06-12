// Translates an OpenAI Responses API SSE stream into Chat Completions SSE
// chunks. Cursor's BYOK mode sends Responses-format requests but can only
// parse chat-completions responses, so rerouted requests need their response
// translated back.

type ChatDelta = {
  role?: string;
  content?: string;
  tool_calls?: Array<{
    index: number;
    id?: string;
    type?: "function";
    function: { name?: string; arguments: string };
  }>;
};

export class ResponsesToChatTranslator {
  private buffer = "";
  private chunkId = `chatcmpl-${Math.random().toString(36).slice(2)}`;
  private created = Math.floor(Date.now() / 1000);
  private model = "";
  private sentRole = false;
  private sawToolCall = false;
  private toolCallIndexByItemId = new Map<string, number>();
  private nextToolCallIndex = 0;

  /** Feed raw SSE bytes from the Responses stream; returns chat SSE bytes. */
  translate(chunk: Buffer): Buffer {
    this.buffer += chunk.toString("utf-8");
    const events: string[] = [];
    let separatorIndex: number;
    while ((separatorIndex = this.buffer.indexOf("\n\n")) !== -1) {
      const rawEvent = this.buffer.slice(0, separatorIndex);
      this.buffer = this.buffer.slice(separatorIndex + 2);
      const out = this.handleEvent(rawEvent);
      if (out) events.push(out);
    }
    return Buffer.from(events.join(""), "utf-8");
  }

  private emit(delta: ChatDelta, finishReason: string | null = null): string {
    if (!this.sentRole) {
      this.sentRole = true;
      delta = { role: "assistant", ...delta };
    }
    return `data: ${JSON.stringify({
      id: this.chunkId,
      object: "chat.completion.chunk",
      created: this.created,
      model: this.model,
      choices: [{ index: 0, delta, finish_reason: finishReason }],
    })}\n\n`;
  }

  private handleEvent(rawEvent: string): string | null {
    let dataJson = "";
    for (const line of rawEvent.split("\n")) {
      if (line.startsWith("data:")) {
        dataJson += line.slice(5).trim();
      }
    }
    if (!dataJson || dataJson === "[DONE]") return null;

    let data: Record<string, unknown>;
    try {
      data = JSON.parse(dataJson) as Record<string, unknown>;
    } catch {
      return null;
    }

    const type = data.type as string | undefined;

    switch (type) {
      case "response.created": {
        const response = data.response as Record<string, unknown> | undefined;
        if (typeof response?.model === "string") this.model = response.model;
        return this.emit({});
      }

      case "response.output_text.delta": {
        const delta = data.delta;
        if (typeof delta !== "string" || delta.length === 0) return null;
        return this.emit({ content: delta });
      }

      case "response.output_item.added": {
        const item = data.item as Record<string, unknown> | undefined;
        if (item?.type !== "function_call") return null;
        this.sawToolCall = true;
        const index = this.nextToolCallIndex++;
        const itemId =
          typeof item.id === "string" ? item.id : `item_${index}`;
        this.toolCallIndexByItemId.set(itemId, index);
        return this.emit({
          tool_calls: [
            {
              index,
              id: typeof item.call_id === "string" ? item.call_id : itemId,
              type: "function",
              function: {
                name: typeof item.name === "string" ? item.name : "",
                arguments: "",
              },
            },
          ],
        });
      }

      case "response.function_call_arguments.delta": {
        const delta = data.delta;
        if (typeof delta !== "string") return null;
        const itemId = typeof data.item_id === "string" ? data.item_id : "";
        const index = this.toolCallIndexByItemId.get(itemId) ?? 0;
        return this.emit({
          tool_calls: [{ index, function: { arguments: delta } }],
        });
      }

      case "response.completed":
      case "response.incomplete":
      case "response.failed": {
        const response = data.response as Record<string, unknown> | undefined;
        const usage = response?.usage as Record<string, unknown> | undefined;
        let out = this.emit({}, this.sawToolCall ? "tool_calls" : "stop");
        if (usage) {
          out += `data: ${JSON.stringify({
            id: this.chunkId,
            object: "chat.completion.chunk",
            created: this.created,
            model: this.model,
            choices: [],
            usage: {
              prompt_tokens: usage.input_tokens ?? 0,
              completion_tokens: usage.output_tokens ?? 0,
              total_tokens: usage.total_tokens ?? 0,
            },
          })}\n\n`;
        }
        out += "data: [DONE]\n\n";
        return out;
      }

      case "response.error": {
        const message =
          (data.error as Record<string, unknown> | undefined)?.message ??
          "upstream error";
        return `data: ${JSON.stringify({
          error: { message, type: "upstream_error" },
        })}\n\n`;
      }

      default:
        return null;
    }
  }
}
