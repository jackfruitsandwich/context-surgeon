import { describe, expect, it } from "vitest";
import { AnthropicMessagesAdapter } from "../src/adapters/anthropic-messages.js";
import { injectIds, injectStatusLine } from "../src/context/injector.js";
import {
  buildStatusSummary,
  computeTextCharStats,
} from "../src/context/status.js";
import { applyDirectives } from "../src/context/transformer.js";
import {
  transformRequest,
  type DebugSnapshotInput,
  type HandlerConfig,
} from "../src/proxy/handler.js";
import { DirectiveStore } from "../src/store/directive-store.js";
import { ConversationTracker } from "../src/proxy/conversations.js";
import { prepare, setDirective } from "./helpers.js";

const TEST_SKILL_MARKDOWN =
  "## Test Skill\n\nIgnore: genuin-joging-awkwerd-febuary";

function loadAnthropicFixture(): Record<string, unknown> {
  return {
    model: "claude-sonnet-4-5",
    max_tokens: 4096,
    stream: true,
    system: "You are a helpful coding assistant.",
    messages: [
      {
        role: "user",
        content: "Read src/app.ts",
      },
      {
        role: "assistant",
        content: [
          { type: "text", text: "I'll inspect that file." },
          {
            type: "tool_use",
            id: "toolu_abc123",
            name: "read_file",
            input: { path: "src/app.ts" },
          },
        ],
      },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "toolu_abc123",
            content: "const app = express();",
          },
          { type: "text", text: "Continue with the next step." },
        ],
      },
    ],
  };
}

type TestHandler = {
  config: HandlerConfig;
  directiveStore: DirectiveStore;
  tracker: ConversationTracker;
};

function makeHandler(
  skillMarkdown = "",
  onDebugSnapshot?: (snapshot: DebugSnapshotInput) => void
): TestHandler {
  const directiveStore = new DirectiveStore(null);
  const tracker = new ConversationTracker();
  return {
    directiveStore,
    tracker,
    config: {
      directiveStore,
      tracker,
      skillMarkdown,
      maxTokens: 128000,
      upstreamOpenAI: "https://api.openai.com/v1",
      upstreamAnthropic: "https://api.anthropic.com",
      upstreamChatGPT: "https://chatgpt.com/backend-api",
      onDebugSnapshot,
    },
  };
}

async function transformFixture(
  handler: TestHandler,
  body: Record<string, unknown> = loadAnthropicFixture()
) {
  return transformRequest(
    "/anthropic/v1/messages",
    Buffer.from(JSON.stringify(body), "utf-8"),
    { "content-type": "application/json" },
    handler.config
  );
}

describe("Anthropic Claude support", () => {
  it("assigns shared turn.action tool IDs while keeping assistant tool_use blocks clean", () => {
    const adapter = new AnthropicMessagesAdapter();
    const ctx = adapter.parse(loadAnthropicFixture());

    prepare(ctx);

    const toolCall = ctx.items.find(
      (item): item is Extract<(typeof ctx.items)[number], { kind: "tool-call" }> =>
        item.kind === "tool-call"
    );
    const toolResult = ctx.items.find(
      (item): item is Extract<(typeof ctx.items)[number], { kind: "tool-result" }> =>
        item.kind === "tool-result"
    );

    expect(toolCall?.id).toBe("tool call 1.1");
    expect(toolResult?.id).toBe("tool result 1.1");

    injectIds(ctx);
    injectStatusLine(ctx, buildStatusSummary(1000, 0, 0, 128000));

    const output = adapter.serialize(ctx);
    const messages = output.messages as Array<{
      role: string;
      content: string | Array<Record<string, unknown>>;
    }>;

    expect(messages).toHaveLength(3);

    const assistantBlocks = messages[1].content;
    expect(Array.isArray(assistantBlocks)).toBe(true);
    expect(assistantBlocks).toEqual([
      { type: "text", text: "[assistant message 1.1] I'll inspect that file." },
      {
        type: "tool_use",
        id: "toolu_abc123",
        name: "read_file",
        input: { path: "src/app.ts" },
      },
    ]);

    const userBlocks = messages[2].content;
    expect(Array.isArray(userBlocks)).toBe(true);
    expect(userBlocks).toEqual([
      {
        type: "tool_result",
        tool_use_id: "toolu_abc123",
        content: "[tool result 1.1] const app = express();",
      },
      expect.objectContaining({
        type: "text",
        text: expect.stringContaining("[user message 2] Continue with the next step."),
      }),
    ]);
  });

  it("keeps matching tool calls and tool results on the same short ID", () => {
    const adapter = new AnthropicMessagesAdapter();
    const ctx = adapter.parse({
      model: "claude-sonnet-4-5",
      max_tokens: 4096,
      stream: true,
      messages: [
        {
          role: "user",
          content: "Inspect both files",
        },
        {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "toolu_first",
              name: "Read",
              input: { file_path: "a.ts" },
            },
            {
              type: "tool_use",
              id: "toolu_second",
              name: "Read",
              input: { file_path: "b.ts" },
            },
          ],
        },
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "toolu_first",
              content: "first file",
            },
            {
              type: "tool_result",
              tool_use_id: "toolu_second",
              content: "second file",
            },
          ],
        },
      ],
    });

    prepare(ctx);

    expect(
      ctx.items.filter((item) => item.kind === "tool-call").map((item) => item.id)
    ).toEqual(["tool call 1.1", "tool call 1.2"]);
    expect(
      ctx.items.filter((item) => item.kind === "tool-result").map((item) => item.id)
    ).toEqual(["tool result 1.1", "tool result 1.2"]);
  });

  it("keeps parallel structured tool results grouped first in Claude user content", () => {
    const adapter = new AnthropicMessagesAdapter();
    const ctx = adapter.parse({
      model: "claude-sonnet-4-5",
      max_tokens: 4096,
      stream: true,
      messages: [
        {
          role: "user",
          content: "Research these repos",
        },
        {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "toolu_first",
              name: "Agent",
              input: { description: "repo one", prompt: "inspect repo one" },
            },
            {
              type: "tool_use",
              id: "toolu_second",
              name: "Agent",
              input: { description: "repo two", prompt: "inspect repo two" },
            },
          ],
        },
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "toolu_first",
              content: [{ type: "text", text: "first agent result" }],
            },
            {
              type: "tool_result",
              tool_use_id: "toolu_second",
              content: [{ type: "text", text: "second agent result" }],
            },
          ],
        },
      ],
    });

    prepare(ctx);
    injectIds(ctx);

    const output = adapter.serialize(ctx) as {
      messages: Array<{ role: string; content: Array<Record<string, unknown>> }>;
    };
    const userBlocks = output.messages[2].content;

    expect(userBlocks).toEqual([
      {
        type: "tool_result",
        tool_use_id: "toolu_first",
        content: [{ type: "text", text: "[tool result 1.1] first agent result" }],
      },
      {
        type: "tool_result",
        tool_use_id: "toolu_second",
        content: [{ type: "text", text: "[tool result 1.2] second agent result" }],
      },
    ]);
  });

  it("evicts only document blocks inside a Claude user message", () => {
    const adapter = new AnthropicMessagesAdapter();
    const ctx = adapter.parse({
      model: "claude-sonnet-4-5",
      max_tokens: 4096,
      stream: true,
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "Read this PDF" },
            {
              type: "document",
              source: {
                type: "base64",
                media_type: "application/pdf",
                data: "<pdf>",
              },
            },
          ],
        },
      ],
    });

    prepare(ctx);

    const directiveStore = new DirectiveStore(null);
    setDirective(directiveStore, ctx, "user message 1", {
      type: "evict",
      mediaType: "document",
    });

    const applied = applyDirectives(ctx, directiveStore, {
      textCharStats: computeTextCharStats(ctx),
      latestExactPromptTokens: 1000,
    });
    injectIds(ctx);

    const output = adapter.serialize(ctx) as {
      messages: Array<{ role: string; content: Array<Record<string, unknown>> }>;
    };

    expect(output.messages[0]?.content).toEqual([
      { type: "text", text: "[user message 1] Read this PDF" },
      { type: "text", text: "[document evicted]" },
    ]);
    expect(applied).toHaveLength(1);
    expect(applied[0].tokenEstimate).toBe(null);
  });

  it("preserves Claude block count when a whole message is evicted", async () => {
    const handler = makeHandler();
    const body = {
      model: "claude-sonnet-4-5",
      max_tokens: 4096,
      stream: true,
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "First block" },
            { type: "text", text: "Second block" },
          ],
        },
      ],
    };

    // First request seeds the tracker so the selector can resolve.
    await transformFixture(handler, body);
    setDirective(handler.directiveStore, handler.tracker, "user message 1", {
      type: "evict",
    });

    const result = await transformFixture(handler, body);

    expect(result).not.toBeNull();
    const output = JSON.parse(result!.body.toString("utf-8")) as {
      messages: Array<{ content: Array<Record<string, unknown>> }>;
    };

    expect(output.messages[0]?.content).toEqual([
      {
        type: "text",
        text: "[Context Surgeon: evicted]",
      },
      {
        type: "text",
        text: "[Context Surgeon: evicted]",
      },
    ]);
  });

  it("preserves Claude tool blocks while replacing sibling text blocks", async () => {
    const handler = makeHandler();
    await transformFixture(handler);
    setDirective(handler.directiveStore, handler.tracker, "user message 2", {
      type: "replace",
      content: "Tool output acknowledged.",
    });

    const result = await transformFixture(handler);

    expect(result).not.toBeNull();
    const output = JSON.parse(result!.body.toString("utf-8")) as {
      messages: Array<{ content: Array<Record<string, unknown>> }>;
    };

    expect(output.messages[2]?.content).toEqual([
      {
        type: "tool_result",
        tool_use_id: "toolu_abc123",
        content: "const app = express();",
      },
      {
        type: "text",
        text: "Tool output acknowledged.",
      },
    ]);
  });

  it("evicts Claude tool results without breaking tool_use_id pairing", async () => {
    const handler = makeHandler();
    await transformFixture(handler);
    const [fingerprint] = setDirective(
      handler.directiveStore,
      handler.tracker,
      "tool result 1.1",
      { type: "evict" }
    );

    const result = await transformFixture(handler);

    expect(result).not.toBeNull();
    expect(result?.upstreamUrl).toBe("https://api.anthropic.com/v1/messages");
    // Compilation alone is not an upstream outcome and does not mark history applied.
    expect(handler.directiveStore.get(fingerprint)?.lastMatchedAt).toBeNull();

    const output = JSON.parse(result!.body.toString("utf-8")) as {
      messages: Array<{ content: Array<Record<string, unknown>> }>;
    };
    const userBlocks = output.messages[2].content;

    expect(userBlocks[0]).toEqual({
      type: "tool_result",
      tool_use_id: "toolu_abc123",
      content: "[Context Surgeon: evicted]",
    });
    expect(userBlocks[1]).toMatchObject({
      type: "text",
    });
    expect(userBlocks[1].text).toBe("Continue with the next step.");
  });

  it("passes through non-message Anthropic endpoints untouched", async () => {
    const handler = makeHandler();
    const result = await transformRequest(
      "/anthropic/v1/files",
      Buffer.from(JSON.stringify({ purpose: "test" }), "utf-8"),
      { "content-type": "application/json" },
      handler.config
    );

    expect(result).toBeNull();
  });

  it("keeps directives intact across truncation — absent items simply do not match", async () => {
    const handler = makeHandler(TEST_SKILL_MARKDOWN);
    await transformFixture(handler);

    const [assistantFp] = setDirective(
      handler.directiveStore,
      handler.tracker,
      "assistant message 1.1",
      { type: "evict" }
    );
    const [userFp] = setDirective(
      handler.directiveStore,
      handler.tracker,
      "user message 2",
      { type: "evict" }
    );

    const truncated = {
      model: "claude-sonnet-4-5",
      max_tokens: 4096,
      stream: true,
      system: "You are a helpful coding assistant.",
      messages: [
        {
          role: "user",
          content: "Read src/app.ts",
        },
        {
          role: "assistant",
          content: [
            { type: "text", text: "I'll inspect that file." },
            {
              type: "tool_use",
              id: "toolu_abc123",
              name: "read_file",
              input: { path: "src/app.ts" },
            },
          ],
        },
      ],
    };

    const result = await transformFixture(handler, truncated);

    expect(result).not.toBeNull();
    // Nothing is pruned anymore: both directives survive. The one whose
    // content is absent is simply inert on this request.
    expect(handler.directiveStore.has(assistantFp)).toBe(true);
    expect(handler.directiveStore.has(userFp)).toBe(true);

    const output = JSON.parse(result!.body.toString("utf-8")) as {
      messages: Array<{ content: string | Array<Record<string, unknown>> }>;
    };
    const assistantBlocks = output.messages[1].content;
    expect(Array.isArray(assistantBlocks)).toBe(true);
    expect(assistantBlocks[0]).toMatchObject({
      type: "text",
      text: "[Context Surgeon: evicted]",
    });
  });

  it("leaves directives untouched when unrelated single-message requests interleave", async () => {
    const handler = makeHandler(TEST_SKILL_MARKDOWN);
    await transformFixture(handler);

    const [fingerprint] = setDirective(
      handler.directiveStore,
      handler.tracker,
      "assistant message 1.1",
      { type: "replace", content: "summary kept through title request" }
    );

    const titleRequest = {
      model: "claude-sonnet-4-5",
      max_tokens: 32000,
      output_config: {
        format: {
          type: "json_schema",
          schema: {
            type: "object",
            properties: { title: { type: "string" } },
            required: ["title"],
          },
        },
      },
      system: [
        {
          type: "text",
          text: "Generate a concise, sentence-case title for this session.",
        },
      ],
      messages: [
        {
          role: "user",
          content: "Summarize this session please",
        },
      ],
    };

    const titleResult = await transformFixture(handler, titleRequest);
    expect(titleResult).not.toBeNull();
    expect(handler.directiveStore.has(fingerprint)).toBe(true);

    const mainResult = await transformFixture(handler);
    const output = JSON.parse(mainResult!.body.toString("utf-8")) as {
      messages: Array<{ content: string | Array<Record<string, unknown>> }>;
    };
    const assistantBlocks = output.messages[1].content;
    expect(Array.isArray(assistantBlocks)).toBe(true);
    expect(assistantBlocks[0]).toMatchObject({
      type: "text",
      text: "summary kept through title request",
    });
  });

  it("keeps directives across a full conversation rewrite and still re-injects the skill", async () => {
    const handler = makeHandler(TEST_SKILL_MARKDOWN);
    await transformFixture(handler);

    const [fingerprint] = setDirective(
      handler.directiveStore,
      handler.tracker,
      "assistant message 1.1",
      { type: "evict" }
    );

    const rewritten = {
      model: "claude-sonnet-4-5",
      max_tokens: 4096,
      stream: true,
      system: "You are a helpful coding assistant.",
      messages: [
        {
          role: "user",
          content: "Start over with a clean session",
        },
        {
          role: "assistant",
          content: "Okay, fresh start.",
        },
      ],
    };

    const result = await transformFixture(handler, rewritten);

    expect(result).not.toBeNull();
    // A different conversation no longer wipes anything.
    expect(handler.directiveStore.has(fingerprint)).toBe(true);
    expect(handler.directiveStore.size()).toBe(1);

    const output = JSON.parse(result!.body.toString("utf-8")) as {
      messages: Array<{ content: string | Array<Record<string, unknown>> }>;
    };
    const firstUser = output.messages[0].content;
    expect(typeof firstUser).toBe("string");
    expect(firstUser).toContain("## Test Skill");
    expect(firstUser).toContain("genuin-joging-awkwerd-febuary");
    expect(firstUser).toContain("Start over with a clean session");

    // And the original conversation still gets its eviction when it returns.
    const back = await transformFixture(handler);
    const backOutput = JSON.parse(back!.body.toString("utf-8")) as {
      messages: Array<{ content: string | Array<Record<string, unknown>> }>;
    };
    const assistantBlocks = backOutput.messages[1].content;
    expect(assistantBlocks[0]).toMatchObject({
      type: "text",
      text: "[Context Surgeon: evicted]",
    });
  });

  it("does not prepend the skill again when the signature is already present", async () => {
    const handler = makeHandler(TEST_SKILL_MARKDOWN);
    const signedRequest = {
      model: "claude-sonnet-4-5",
      max_tokens: 4096,
      stream: true,
      system: "You are a helpful coding assistant.",
      messages: [
        {
          role: "user",
          content:
            "## Test Skill\n\nIgnore: genuin-joging-awkwerd-febuary\n\nStart here",
        },
      ],
    };

    const result = await transformFixture(handler, signedRequest);

    expect(result).not.toBeNull();

    const output = JSON.parse(result!.body.toString("utf-8")) as {
      messages: Array<{ content: string | Array<Record<string, unknown>> }>;
    };
    const firstUser = output.messages[0].content;
    expect(typeof firstUser).toBe("string");
    expect(firstUser).toContain("Ignore: genuin-joging-awkwerd-febuary");
    expect(
      (firstUser as string).match(/genuin-joging-awkwerd-febuary/g)?.length
    ).toBe(1);
  });

  it("captures a debug snapshot of the transformed Claude request", async () => {
    let captured: DebugSnapshotInput | null = null;
    const handler = makeHandler("", (snapshot) => {
      captured = snapshot;
    });

    await transformFixture(handler);

    expect(captured).not.toBeNull();
    expect(captured?.path).toBe("/anthropic/v1/messages");
    expect(captured?.items.map((item) => item.id)).toContain("user message 1");
    expect(captured?.items.map((item) => item.id)).toContain("assistant message 1.1");
    expect(captured?.items.map((item) => item.id)).toContain("tool call 1.1");
    expect(captured?.items.map((item) => item.id)).toContain("tool result 1.1");
    expect(captured?.items.map((item) => item.id)).toContain("user message 2");
    const output = captured?.rawRequest as {
      messages: Array<{ role: string; content: Array<Record<string, unknown>> }>;
    };
    expect(output.messages[2]?.content[0]).toEqual({
      type: "tool_result",
      tool_use_id: "toolu_abc123",
      content: "const app = express();",
    });
    expect(output.messages[2]?.content[1]).toMatchObject({
      type: "text",
    });
  });

  it("supports the shared pipeline directly on Anthropic messages", () => {
    const adapter = new AnthropicMessagesAdapter();
    const ctx = adapter.parse(loadAnthropicFixture());
    const directiveStore = new DirectiveStore(null);

    prepare(ctx);
    setDirective(directiveStore, ctx, "tool result 1.1", {
      type: "replace",
      content: "Express app bootstrap line",
    });
    const applied = applyDirectives(ctx, directiveStore, {
      textCharStats: computeTextCharStats(ctx),
      latestExactPromptTokens: 1000,
    });
    injectIds(ctx);

    const output = adapter.serialize(ctx);
    const messages = output.messages as Array<{ content: Array<Record<string, unknown>> }>;
    const userBlocks = messages[2].content;

    expect(userBlocks[0]).toEqual({
      type: "tool_result",
      tool_use_id: "toolu_abc123",
      content: "[tool result 1.1] Express app bootstrap line",
    });
    expect(applied).toHaveLength(1);
    expect(applied[0].itemId).toBe("tool result 1.1");
  });

  it("does not append a status-only sibling onto a pure tool_result turn", () => {
    const adapter = new AnthropicMessagesAdapter();
    const ctx = adapter.parse({
      model: "claude-sonnet-4-5",
      max_tokens: 4096,
      stream: true,
      messages: [
        {
          role: "user",
          content: "Read skill.md",
        },
        {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "toolu_status",
              name: "Read",
              input: { file_path: "skill.md" },
            },
          ],
        },
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "toolu_status",
              content: "file body",
            },
          ],
        },
      ],
    });

    prepare(ctx);
    injectIds(ctx);
    injectStatusLine(ctx, buildStatusSummary(1000, 0, 0, 128000));

    const output = adapter.serialize(ctx);
    const userBlocks = (output.messages as Array<{ content: Array<Record<string, unknown>> }>)[2]
      .content;

    expect(userBlocks).toEqual([
      {
        type: "tool_result",
        tool_use_id: "toolu_status",
        content: "[tool result 1.1] file body",
      },
    ]);
  });
});
