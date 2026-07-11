import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { OpenAIResponsesAdapter } from "../src/adapters/openai-responses.js";
import { assignIds } from "../src/context/id-assigner.js";
import { computeFingerprints } from "../src/context/fingerprint.js";
import { injectIds, injectStatusLine } from "../src/context/injector.js";
import {
  buildStatusSummary,
  computeTextCharStats,
  estimateTokensFromChars,
} from "../src/context/status.js";
import { applyDirectives } from "../src/context/transformer.js";
import { DirectiveStore } from "../src/store/directive-store.js";
import {
  ConversationTracker,
  resolveSelectors,
} from "../src/proxy/conversations.js";
import type { ContextObject, Directive } from "../src/context/types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

function loadFixture(): Record<string, unknown> {
  return JSON.parse(
    readFileSync(join(__dirname, "fixtures", "codex-request.json"), "utf-8")
  );
}

function prepare(ctx: ContextObject): void {
  computeFingerprints(ctx.items);
  assignIds(ctx.items);
}

/** Mimic what the control API does: resolve an ordinal selector to fingerprints. */
function setDirective(
  store: DirectiveStore,
  ctx: ContextObject,
  selector: string,
  directive: Directive
): void {
  const tracker = new ConversationTracker();
  tracker.record(ctx.items);
  const resolution = resolveSelectors(tracker, [selector]);
  if (!resolution || resolution.missing.length > 0) {
    throw new Error(`Test selector did not resolve: ${selector}`);
  }
  for (const target of resolution.resolved) {
    for (const item of target.items) {
      store.set(item.fingerprint, {
        directive,
        humanId: item.id,
        preview: item.preview,
        tokenEstimate: null,
        createdAt: Date.now(),
        lastMatchedAt: null,
      });
    }
  }
}

describe("Full pipeline", () => {
  const adapter = new OpenAIResponsesAdapter();

  it("assigns turn-based IDs consistently across messages and tool items", () => {
    const ctx = adapter.parse(loadFixture());
    prepare(ctx);

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
    prepare(ctx);
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
    prepare(ctx);

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

  it("evicts a tool result by fingerprint", () => {
    const ctx = adapter.parse(loadFixture());
    prepare(ctx);

    const store = new DirectiveStore(null);
    setDirective(store, ctx, "tool result 1.1", { type: "evict" });

    const applied = applyDirectives(ctx, store, {
      textCharStats: computeTextCharStats(ctx),
      latestExactPromptTokens: 1000,
    });

    const toolResult = ctx.items[4];
    if (toolResult.kind === "tool-result") {
      expect(toolResult.output).toBe("[evicted]");
    }

    expect(applied).toHaveLength(1);
    expect(applied[0].itemId).toBe("tool result 1.1");
    expect(applied[0].tokenEstimate).toBeGreaterThan(0);
  });

  it("expands whole-turn selectors to every item in the turn", () => {
    const ctx = adapter.parse(loadFixture());
    prepare(ctx);

    const store = new DirectiveStore(null);
    setDirective(store, ctx, "turn 1", { type: "evict" });

    const applied = applyDirectives(ctx, store, {
      textCharStats: computeTextCharStats(ctx),
      latestExactPromptTokens: 1000,
    });

    const firstUser = ctx.items[1];
    if (firstUser.kind === "user-message") {
      expect(firstUser.content).toEqual([{ type: "text", text: "[evicted]" }]);
    }

    const toolCall = ctx.items[3];
    if (toolCall.kind === "tool-call") {
      expect(toolCall.arguments).toBe('{"path": "src/app.ts"}');
    }

    const toolResult = ctx.items[4];
    if (toolResult.kind === "tool-result") {
      expect(toolResult.output).toBe("[evicted]");
    }

    const secondUser = ctx.items[6];
    if (secondUser.kind === "user-message") {
      expect(secondUser.content).not.toEqual([
        { type: "text", text: "[evicted]" },
      ]);
    }

    // Tool arguments are protected; the four mutable payload-bearing items apply.
    expect(applied).toHaveLength(4);
  });

  it("replaces a tool result with a summary", () => {
    const ctx = adapter.parse(loadFixture());
    prepare(ctx);

    const store = new DirectiveStore(null);
    setDirective(store, ctx, "tool result 1.1", {
      type: "replace",
      content: "Express server on port 3000 with GET / route",
    });

    applyDirectives(ctx, store, {
      textCharStats: computeTextCharStats(ctx),
      latestExactPromptTokens: 1000,
    });

    const toolResult = ctx.items[4];
    if (toolResult.kind === "tool-result") {
      expect(toolResult.output).toBe(
        "Express server on port 3000 with GET / route"
      );
    }
  });

  it("evicts and then serializes back to valid format", () => {
    const ctx = adapter.parse(loadFixture());
    prepare(ctx);

    const store = new DirectiveStore(null);
    setDirective(store, ctx, "tool result 1.1", { type: "evict" });

    const applied = applyDirectives(ctx, store, {
      textCharStats: computeTextCharStats(ctx),
      latestExactPromptTokens: 1000,
    });
    injectIds(ctx);
    injectStatusLine(
      ctx,
      buildStatusSummary(
        1000,
        applied.length,
        applied.reduce((sum, entry) => sum + (entry.tokenEstimate ?? 0), 0),
        128000
      )
    );

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
    prepare(ctx);
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
    prepare(ctx);

    const store = new DirectiveStore(null);
    setDirective(store, ctx, "user message 1", {
      type: "evict",
      mediaType: "image",
      occurrences: [1],
    });

    const applied = applyDirectives(ctx, store, {
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

    expect(applied).toHaveLength(1);
    expect(applied[0].tokenEstimate).toBe(null);

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
    prepare(ctx);

    const store = new DirectiveStore(null);
    setDirective(store, ctx, "user message 1", { type: "evict" });

    applyDirectives(ctx, store, {
      textCharStats: computeTextCharStats(ctx),
      latestExactPromptTokens: 1000,
    });

    const output = adapter.serialize(ctx) as {
      input: Array<{ type: string; content?: Array<{ type: string; text?: string }> }>;
    };

    expect(output.input[0]?.content).toEqual([
      { type: "input_text", text: "[evicted]" },
      { type: "input_text", text: "[image evicted]" },
    ]);
  });
});

describe("Fingerprint chaining", () => {
  const adapter = new OpenAIResponsesAdapter();

  it("is stable across identical requests", () => {
    const a = adapter.parse(loadFixture());
    const b = adapter.parse(loadFixture());
    computeFingerprints(a.items);
    computeFingerprints(b.items);
    expect(a.items.map((i) => i.fingerprint)).toEqual(
      b.items.map((i) => i.fingerprint)
    );
  });

  it("keeps shared-prefix fingerprints identical after a fork diverges", () => {
    const a = adapter.parse(loadFixture());
    const b = adapter.parse(loadFixture());
    // Diverge b's LAST item (the second user message)
    const lastB = b.items[b.items.length - 1];
    if (lastB.kind === "user-message") {
      lastB.content = [{ type: "text", text: "a different branch" }];
    }
    computeFingerprints(a.items);
    computeFingerprints(b.items);

    for (let i = 0; i < a.items.length - 1; i++) {
      expect(a.items[i].fingerprint).toBe(b.items[i].fingerprint);
    }
    expect(a.items[a.items.length - 1].fingerprint).not.toBe(
      b.items[b.items.length - 1].fingerprint
    );
  });

  it("gives identical duplicate messages different fingerprints by position", () => {
    const ctx = adapter.parse({
      model: "gpt-4.1",
      instructions: "",
      input: [
        { type: "message", role: "user", content: [{ type: "input_text", text: "ok" }] },
        { type: "message", role: "assistant", content: [{ type: "output_text", text: "done" }] },
        { type: "message", role: "user", content: [{ type: "input_text", text: "ok" }] },
      ],
    });
    computeFingerprints(ctx.items);
    expect(ctx.items[0].fingerprint).not.toBe(ctx.items[2].fingerprint);
  });

  it("a directive from one conversation cannot match another conversation's identical text", () => {
    const a = adapter.parse({
      model: "gpt-4.1",
      instructions: "",
      input: [
        { type: "message", role: "user", content: [{ type: "input_text", text: "hello" }] },
        { type: "message", role: "user", content: [{ type: "input_text", text: "ok" }] },
      ],
    });
    const b = adapter.parse({
      model: "gpt-4.1",
      instructions: "",
      input: [
        { type: "message", role: "user", content: [{ type: "input_text", text: "different opener" }] },
        { type: "message", role: "user", content: [{ type: "input_text", text: "ok" }] },
      ],
    });
    computeFingerprints(a.items);
    computeFingerprints(b.items);
    assignIds(a.items);
    assignIds(b.items);

    const store = new DirectiveStore(null);
    setDirective(store, a, "user message 2", { type: "evict" });

    const applied = applyDirectives(b, store, {
      textCharStats: computeTextCharStats(b),
      latestExactPromptTokens: 1000,
    });
    expect(applied).toHaveLength(0);

    const bSecond = b.items[1];
    if (bSecond.kind === "user-message") {
      expect(bSecond.content).toEqual([{ type: "text", text: "ok" }]);
    }
  });

  it("ignores cache_control when fingerprinting", () => {
    const a = adapter.parse({
      model: "gpt-4.1",
      instructions: "",
      input: [
        {
          type: "message",
          role: "user",
          content: [
            { type: "input_image", image_url: "data:image/png;base64,AAA" },
          ],
        },
      ],
    });
    const b = adapter.parse({
      model: "gpt-4.1",
      instructions: "",
      input: [
        {
          type: "message",
          role: "user",
          content: [
            {
              type: "input_image",
              image_url: "data:image/png;base64,AAA",
              cache_control: { type: "ephemeral" },
            },
          ],
        },
      ],
    });
    computeFingerprints(a.items);
    computeFingerprints(b.items);
    expect(a.items[0].fingerprint).toBe(b.items[0].fingerprint);
  });
});
