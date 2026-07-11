import zlib from "node:zlib";
import { describe, expect, it, vi } from "vitest";
import { createUsageTap, testOnly } from "../src/proxy/usage.js";

describe("promptTokensFromOpenAiPayload", () => {
  it("reads usage from response.completed payloads", () => {
    expect(
      testOnly.promptTokensFromOpenAiPayload({
        type: "response.completed",
        response: {
          usage: {
            input_tokens: 321,
          },
        },
      })
    ).toBe(321);
  });

  it("reads usage from response.done payloads", () => {
    expect(
      testOnly.promptTokensFromOpenAiPayload({
        type: "response.done",
        response: {
          usage: {
            input_tokens: 654,
          },
        },
      })
    ).toBe(654);
  });
});

describe("createUsageTap", () => {
  it("captures prompt tokens from openai SSE responses", () => {
    const onPromptTokens = vi.fn();
    const tap = createUsageTap(
      "openai-responses",
      { "content-type": "text/event-stream" },
      onPromptTokens
    );

    expect(tap).not.toBeNull();

    tap?.onChunk(
      Buffer.from(
        [
          "event: response.created",
          'data: {"type":"response.created","response":{"id":"resp_1"}}',
          "",
          "event: response.completed",
          'data: {"type":"response.completed","response":{"id":"resp_1","usage":{"input_tokens":777}}}',
          "",
        ].join("\n"),
        "utf-8"
      )
    );
    tap?.onEnd();

    expect(onPromptTokens).toHaveBeenCalledWith(777);
  });

  it("handles split UTF-8, CRLF framing, multi-line data, and a final unterminated event", () => {
    const usages: Array<Readonly<Record<string, number | null>>> = [];
    const tap = createUsageTap(
      "openai-responses",
      { "content-type": "text/event-stream" },
      undefined,
      (usage) => usages.push(usage)
    );
    const event = Buffer.from(
      [
        "event: response.completed",
        'data: {"note":"snowman ☃"',
        'data: ,"response":{"usage":{"input_tokens":88,"output_tokens":5,"total_tokens":93}}}',
      ].join("\r\n"),
      "utf8"
    );
    const snowman = event.indexOf(Buffer.from("☃", "utf8"));
    tap?.onChunk(event.subarray(0, snowman + 1));
    tap?.onChunk(event.subarray(snowman + 1, snowman + 2));
    tap?.onChunk(event.subarray(snowman + 2));
    tap?.onEnd();

    expect(usages).toHaveLength(1);
    expect(usages[0]).toEqual({
      input_tokens: 88,
      cached_input_tokens: null,
      output_tokens: 5,
      total_tokens: 93,
    });
  });

  it("combines incremental Anthropic cache and output usage without losing prior fields", () => {
    const usages: Array<Readonly<Record<string, number | null>>> = [];
    const tap = createUsageTap(
      "anthropic-messages",
      { "content-type": "text/event-stream" },
      undefined,
      (usage) => usages.push(usage)
    );
    tap?.onChunk(
      Buffer.from(
        'data: {"type":"message_start","message":{"usage":{"input_tokens":10,"cache_creation_input_tokens":20,"cache_read_input_tokens":30}}}\n\n' +
          'data: {"type":"message_delta","usage":{"output_tokens":7}}\n\n',
        "utf8"
      )
    );
    tap?.onEnd();
    expect(tap?.latestUsage()).toEqual({
      uncached_input_tokens: 10,
      cache_creation_input_tokens: 20,
      cache_read_input_tokens: 30,
      output_tokens: 7,
    });
    expect(usages).toHaveLength(2);
  });

  it("extracts usage from bounded gzip JSON bodies", () => {
    const onPromptTokens = vi.fn();
    const tap = createUsageTap(
      "openai-chat-completions",
      { "content-type": "application/json", "content-encoding": "gzip" },
      onPromptTokens
    );
    const compressed = zlib.gzipSync(
      Buffer.from(
        JSON.stringify({
          usage: { prompt_tokens: 44, completion_tokens: 6, total_tokens: 50 },
        }),
        "utf8"
      )
    );
    tap?.onChunk(compressed.subarray(0, 3));
    tap?.onChunk(compressed.subarray(3));
    tap?.onEnd();
    expect(onPromptTokens).toHaveBeenCalledWith(44);
    expect(tap?.latestUsage()).toEqual({
      prompt_tokens: 44,
      completion_tokens: 6,
      total_tokens: 50,
    });
  });

  it("preserves already complete usage when the upstream aborts", () => {
    const tap = createUsageTap(
      "openai-responses",
      { "content-type": "text/event-stream" },
      undefined,
      () => undefined
    );
    tap?.onChunk(
      Buffer.from(
        'data: {"type":"response.completed","response":{"usage":{"input_tokens":12}}}\n\npartial',
        "utf8"
      )
    );
    tap?.onAborted();
    expect(tap?.latestUsage()?.input_tokens).toBe(12);
  });
});
