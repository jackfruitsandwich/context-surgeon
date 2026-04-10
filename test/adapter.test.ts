import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { OpenAIResponsesAdapter } from "../src/adapters/openai-responses.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

function loadFixture(): Record<string, unknown> {
  const raw = readFileSync(
    join(__dirname, "fixtures", "codex-request.json"),
    "utf-8"
  );
  return JSON.parse(raw);
}

describe("OpenAIResponsesAdapter", () => {
  const adapter = new OpenAIResponsesAdapter();

  it("parses a Codex request into ContextObject", () => {
    const json = loadFixture();
    const ctx = adapter.parse(json);

    expect(ctx.format).toBe("openai-responses");
    expect(ctx.systemPrompt).toBe("You are a helpful coding assistant.");

    // developer message → other
    expect(ctx.items[0].kind).toBe("other");

    // user message
    expect(ctx.items[1].kind).toBe("user-message");
    if (ctx.items[1].kind === "user-message") {
      expect(ctx.items[1].content[0]).toEqual({
        type: "text",
        text: "Read the file src/app.ts",
      });
    }

    // assistant message
    expect(ctx.items[2].kind).toBe("assistant-message");

    // function call
    expect(ctx.items[3].kind).toBe("tool-call");
    if (ctx.items[3].kind === "tool-call") {
      expect(ctx.items[3].callId).toBe("call_abc123");
      expect(ctx.items[3].name).toBe("read_file");
    }

    // function call output
    expect(ctx.items[4].kind).toBe("tool-result");
    if (ctx.items[4].kind === "tool-result") {
      expect(ctx.items[4].callId).toBe("call_abc123");
      expect(ctx.items[4].output).toContain("express");
    }

    // second assistant message
    expect(ctx.items[5].kind).toBe("assistant-message");

    // second user message
    expect(ctx.items[6].kind).toBe("user-message");

    // rawRequest should have model, tools, stream, etc.
    expect(ctx.rawRequest.model).toBe("gpt-4.1");
    expect(ctx.rawRequest.stream).toBe(true);
  });

  it("round-trips without losing fields", () => {
    const json = loadFixture();
    const ctx = adapter.parse(json);
    const output = adapter.serialize(ctx);

    // model, tools, stream should survive round-trip
    expect(output.model).toBe("gpt-4.1");
    expect(output.stream).toBe(true);
    expect(output.tool_choice).toBe("auto");
    expect(output.instructions).toBe("You are a helpful coding assistant.");

    // input array should have same length
    const inputArr = output.input as unknown[];
    expect(inputArr.length).toBe(7);

    // function_call_output should preserve content
    const fco = inputArr[4] as { type: string; output: string };
    expect(fco.type).toBe("function_call_output");
    expect(fco.output).toContain("express");
  });
});
