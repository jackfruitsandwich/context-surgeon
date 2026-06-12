import { describe, expect, it } from "vitest";
import { ResponsesToChatTranslator } from "../src/proxy/responses-to-chat.js";

function sse(type: string, data: Record<string, unknown>): string {
  return `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
}

function parseChunks(out: string): Array<Record<string, any>> {
  return out
    .split("\n\n")
    .filter((line) => line.startsWith("data: ") && !line.includes("[DONE]"))
    .map((line) => JSON.parse(line.slice(6)));
}

describe("ResponsesToChatTranslator", () => {
  it("translates text deltas, tool calls, and completion", () => {
    const t = new ResponsesToChatTranslator();
    let out = "";

    out += t.translate(
      Buffer.from(
        sse("response.created", { response: { model: "gpt-5.5" } })
      )
    );
    out += t.translate(
      Buffer.from(sse("response.output_text.delta", { delta: "Hello" }))
    );
    out += t.translate(
      Buffer.from(
        sse("response.output_item.added", {
          item: {
            type: "function_call",
            id: "fc_1",
            call_id: "call_9",
            name: "ApplyPatch",
          },
        })
      )
    );
    out += t.translate(
      Buffer.from(
        sse("response.function_call_arguments.delta", {
          item_id: "fc_1",
          delta: '{"patch":',
        })
      )
    );
    out += t.translate(
      Buffer.from(
        sse("response.completed", {
          response: {
            usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
          },
        })
      )
    );

    const chunks = parseChunks(out);
    expect(chunks[0].choices[0].delta.role).toBe("assistant");
    expect(chunks[0].model).toBe("gpt-5.5");

    const textChunk = chunks.find((c) => c.choices?.[0]?.delta?.content);
    expect(textChunk.choices[0].delta.content).toBe("Hello");

    const toolStart = chunks.find(
      (c) => c.choices?.[0]?.delta?.tool_calls?.[0]?.id
    );
    expect(toolStart.choices[0].delta.tool_calls[0]).toMatchObject({
      index: 0,
      id: "call_9",
      type: "function",
      function: { name: "ApplyPatch", arguments: "" },
    });

    const argDelta = chunks.find(
      (c) =>
        c.choices?.[0]?.delta?.tool_calls?.[0]?.function?.arguments ===
        '{"patch":'
    );
    expect(argDelta).toBeDefined();

    const finish = chunks.find((c) => c.choices?.[0]?.finish_reason);
    expect(finish.choices[0].finish_reason).toBe("tool_calls");

    const usageChunk = chunks.find((c) => c.usage);
    expect(usageChunk.usage).toEqual({
      prompt_tokens: 10,
      completion_tokens: 5,
      total_tokens: 15,
    });

    expect(out.trimEnd().endsWith("data: [DONE]")).toBe(true);
  });

  it("handles events split across chunk boundaries", () => {
    const t = new ResponsesToChatTranslator();
    const event = sse("response.output_text.delta", { delta: "split" });
    const mid = Math.floor(event.length / 2);

    const first = t.translate(Buffer.from(event.slice(0, mid)));
    expect(first.length).toBe(0);

    const second = t.translate(Buffer.from(event.slice(mid)));
    const chunks = parseChunks(second.toString("utf-8"));
    expect(
      chunks.find((c) => c.choices?.[0]?.delta?.content === "split")
    ).toBeDefined();
  });

  it("uses finish_reason stop for text-only responses", () => {
    const t = new ResponsesToChatTranslator();
    let out = "";
    out += t.translate(
      Buffer.from(sse("response.output_text.delta", { delta: "hi" }))
    );
    out += t.translate(Buffer.from(sse("response.completed", { response: {} })));
    const finish = parseChunks(out).find((c) => c.choices?.[0]?.finish_reason);
    expect(finish.choices[0].finish_reason).toBe("stop");
  });
});
