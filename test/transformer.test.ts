import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { OpenAIResponsesAdapter } from "../src/adapters/openai-responses.js";
import { assignIds } from "../src/context/id-assigner.js";
import { injectIds, injectStatusLine } from "../src/context/injector.js";
import {
  buildStatusSummary,
  computeTextCharStats,
  estimateTokensFromChars,
} from "../src/context/status.js";
import { applyDirectives } from "../src/context/transformer.js";
import { DirectiveStore } from "../src/store/directive-store.js";
import { ShadowStore } from "../src/store/shadow-store.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

function loadFixture(): Record<string, unknown> {
  return JSON.parse(
    readFileSync(join(__dirname, "fixtures", "codex-request.json"), "utf-8")
  );
}

describe("Full pipeline", () => {
  const adapter = new OpenAIResponsesAdapter();

  it("assigns turn-based IDs consistently across messages and tool items", () => {
    const ctx = adapter.parse(loadFixture());
    assignIds(ctx.items);

    // developer = other
    expect(ctx.items[0].id).toMatch(/^other_/);
    // first user message = turn 1
    expect(ctx.items[1].id).toBe("user message 1");
    // first assistant message in turn 1
    expect(ctx.items[2].id).toBe("assistant message 1.1");
    // tool call and tool result share the same turn.action ID
    expect(ctx.items[3].id).toBe("tool call 1.1");
    expect(ctx.items[4].id).toBe("tool result 1.1");
    // second assistant message in turn 1
    expect(ctx.items[5].id).toBe("assistant message 1.2");
    // second user message = turn 2
    expect(ctx.items[6].id).toBe("user message 2");
  });

  it("injects IDs into message content", () => {
    const ctx = adapter.parse(loadFixture());
    assignIds(ctx.items);
    injectIds(ctx);

    const userMsg = ctx.items[1];
    if (userMsg.kind === "user-message") {
      expect(userMsg.content[0]).toEqual({
        type: "text",
        text: "[user message 1] Read the file src/app.ts",
      });
    }

    const asstMsg = ctx.items[2];
    if (asstMsg.kind === "assistant-message") {
      expect(asstMsg.content[0]).toEqual({
        type: "text",
        text: "[assistant message 1.1] I'll read that file for you.",
      });
    }
  });

  it("deduplicates repeated assistant labels at the start of assistant messages", () => {
    const ctx = adapter.parse(loadFixture());
    assignIds(ctx.items);

    const asstMsg = ctx.items[2];
    if (asstMsg.kind === "assistant-message") {
      asstMsg.content[0] = {
        type: "text",
        text:
          "[assistant message 9.9] [assistant message 9.10] I'll read that file for you. Mention [assistant message 7.2] later.",
      };
    }

    injectIds(ctx);

    if (asstMsg.kind === "assistant-message") {
      expect(asstMsg.content[0]).toEqual({
        type: "text",
        text:
          "[assistant message 1.1] I'll read that file for you. Mention [assistant message 7.2] later.",
      });
    }
  });

  it("evicts a tool result and stores shadow", () => {
    const ctx = adapter.parse(loadFixture());
    assignIds(ctx.items);

    const dirStore = new DirectiveStore();
    const shadowStore = new ShadowStore();

    dirStore.set("tool result 1.1", { type: "evict" });
    applyDirectives(ctx, dirStore, shadowStore, {
      textCharStats: computeTextCharStats(ctx),
      latestExactPromptTokens: 1000,
    });

    // Tool result should be evicted
    const toolResult = ctx.items[4];
    if (toolResult.kind === "tool-result") {
      expect(toolResult.output).toBe("[evicted]");
    }

    // Shadow store should have the original
    expect(shadowStore.has("tool result 1.1")).toBe(true);
    const shadow = shadowStore.get("tool result 1.1")!;
    expect(shadow.originalOutput).toContain("express");
    expect(shadow.tokenEstimate).toBeGreaterThan(0);
  });

  it("applies whole-turn selector directives to exact item ids", () => {
    const ctx = adapter.parse(loadFixture());
    assignIds(ctx.items);

    const dirStore = new DirectiveStore();
    const shadowStore = new ShadowStore();

    dirStore.set("turn 1", { type: "evict" });
    applyDirectives(ctx, dirStore, shadowStore, {
      textCharStats: computeTextCharStats(ctx),
      latestExactPromptTokens: 1000,
    });

    const firstUser = ctx.items[1];
    if (firstUser.kind === "user-message") {
      expect(firstUser.content).toEqual([{ type: "text", text: "[evicted]" }]);
    }

    const firstAssistant = ctx.items[2];
    if (firstAssistant.kind === "assistant-message") {
      expect(firstAssistant.content).toEqual([
        { type: "text", text: "[evicted]" },
      ]);
    }

    const toolCall = ctx.items[3];
    if (toolCall.kind === "tool-call") {
      expect(toolCall.arguments).toBe("{}");
    }

    const toolResult = ctx.items[4];
    if (toolResult.kind === "tool-result") {
      expect(toolResult.output).toBe("[evicted]");
    }

    const secondAssistant = ctx.items[5];
    if (secondAssistant.kind === "assistant-message") {
      expect(secondAssistant.content).toEqual([
        { type: "text", text: "[evicted]" },
      ]);
    }

    const secondUser = ctx.items[6];
    if (secondUser.kind === "user-message") {
      expect(secondUser.content).not.toEqual([
        { type: "text", text: "[evicted]" },
      ]);
    }

    expect(shadowStore.has("turn 1")).toBe(false);
    expect(shadowStore.has("user message 1")).toBe(true);
    expect(shadowStore.has("assistant message 1.1")).toBe(true);
    expect(shadowStore.has("tool call 1.1")).toBe(true);
    expect(shadowStore.has("tool result 1.1")).toBe(true);
    expect(shadowStore.has("assistant message 1.2")).toBe(true);
    expect(shadowStore.has("user message 2")).toBe(false);
  });

  it("replaces a tool result with a summary", () => {
    const ctx = adapter.parse(loadFixture());
    assignIds(ctx.items);

    const dirStore = new DirectiveStore();
    const shadowStore = new ShadowStore();

    dirStore.set("tool result 1.1", {
      type: "replace",
      content: "Express server on port 3000 with GET / route",
    });
    applyDirectives(ctx, dirStore, shadowStore, {
      textCharStats: computeTextCharStats(ctx),
      latestExactPromptTokens: 1000,
    });

    const toolResult = ctx.items[4];
    if (toolResult.kind === "tool-result") {
      expect(toolResult.output).toBe(
        "Express server on port 3000 with GET / route"
      );
    }

    // Shadow has original
    expect(shadowStore.get("tool result 1.1")!.originalOutput).toContain("express");
  });

  it("evicts and then serializes back to valid format", () => {
    const ctx = adapter.parse(loadFixture());
    assignIds(ctx.items);

    const dirStore = new DirectiveStore();
    const shadowStore = new ShadowStore();

    dirStore.set("tool result 1.1", { type: "evict" });
    applyDirectives(ctx, dirStore, shadowStore, {
      textCharStats: computeTextCharStats(ctx),
      latestExactPromptTokens: 1000,
    });
    injectIds(ctx);
    injectStatusLine(ctx, buildStatusSummary(1000, shadowStore, 128000));

    const output = adapter.serialize(ctx);

    // Should still be valid JSON with all fields
    expect(output.model).toBe("gpt-4.1");
    expect(output.stream).toBe(true);

    const input = output.input as Array<Record<string, unknown>>;
    expect(input.length).toBe(7);

    // The evicted tool result (ID is prepended even on evicted content)
    const fco = input[4] as { type: string; output: string };
    expect(fco.output).toBe("[tool result 1.1] [evicted]");

    // Last user message should have status line
    const lastUser = input[6] as {
      type: string;
      content: Array<{ text: string }>;
    };
    expect(lastUser.content[0].text).toContain("[context-surgeon:");
    expect(lastUser.content[0].text).toContain("1 evicted");
  });

  it("estimates prompt tokens from chars when no exact count exists", () => {
    const ctx = adapter.parse(loadFixture());
    assignIds(ctx.items);
    injectIds(ctx);

    const totalChars = computeTextCharStats(ctx).totalChars;
    const estimatedTokens = estimateTokensFromChars(totalChars);

    expect(estimatedTokens).toBeGreaterThan(0);
    expect(estimatedTokens).toBe(Math.round(totalChars / 3.1));
  });

  it("evicts only selected image blocks inside a user message", () => {
    const ctx = adapter.parse({
      model: "gpt-4.1",
      instructions: "",
      input: [
        {
          type: "message",
          role: "user",
          content: [
            { type: "input_text", text: "Inspect these images" },
            { type: "input_image", image_url: "data:image/png;base64,AAA" },
            { type: "input_image", image_url: "data:image/png;base64,BBB" },
            { type: "input_text", text: "Keep the second one" },
          ],
        },
      ],
    });
    assignIds(ctx.items);

    const dirStore = new DirectiveStore();
    const shadowStore = new ShadowStore();
    dirStore.set("user message 1", {
      type: "evict",
      mediaType: "image",
      occurrences: [1],
    });

    applyDirectives(ctx, dirStore, shadowStore, {
      textCharStats: computeTextCharStats(ctx),
      latestExactPromptTokens: 1000,
    });

    const userMessage = ctx.items[0];
    if (userMessage.kind === "user-message") {
      expect(userMessage.content).toEqual([
        { type: "text", text: "Inspect these images" },
        { type: "text", text: "[image evicted]" },
        { type: "image", data: { type: "input_image", image_url: "data:image/png;base64,BBB" } },
        { type: "text", text: "Keep the second one" },
      ]);
    }

    expect(shadowStore.has("user message 1")).toBe(true);
    expect(shadowStore.get("user message 1")?.tokenEstimate).toBe(null);

    const output = adapter.serialize(ctx) as {
      input: Array<{ type: string; content?: Array<{ type: string; text?: string; image_url?: string }> }>;
    };

    expect(output.input[0]?.content).toEqual([
      { type: "input_text", text: "Inspect these images" },
      { type: "input_text", text: "[image evicted]" },
      { type: "input_image", image_url: "data:image/png;base64,BBB" },
      { type: "input_text", text: "Keep the second one" },
    ]);
  });

  it("evicts an entire image-bearing user message without breaking serialization", () => {
    const ctx = adapter.parse({
      model: "gpt-4.1",
      instructions: "",
      input: [
        {
          type: "message",
          role: "user",
          content: [
            { type: "input_text", text: "Inspect this image" },
            { type: "input_image", image_url: "data:image/png;base64,AAA" },
          ],
        },
      ],
    });
    assignIds(ctx.items);

    const dirStore = new DirectiveStore();
    const shadowStore = new ShadowStore();
    dirStore.set("user message 1", { type: "evict" });

    applyDirectives(ctx, dirStore, shadowStore, {
      textCharStats: computeTextCharStats(ctx),
      latestExactPromptTokens: 1000,
    });

    const output = adapter.serialize(ctx) as {
      input: Array<{ type: string; content?: Array<{ type: string; text?: string }> }>;
    };

    expect(output.input[0]?.content).toEqual([
      { type: "input_text", text: "[evicted]" },
    ]);
  });
});
