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
});
