import { describe, expect, it } from "vitest";
import { OpenAIChatCompletionsAdapter } from "../src/adapters/openai-chat-completions.js";
import { assignIds } from "../src/context/id-assigner.js";
import { injectIds, injectStatusLine } from "../src/context/injector.js";
import { buildStatusSummary } from "../src/context/status.js";
import {
  transformRequest,
  type HandlerConfig,
} from "../src/proxy/handler.js";
import { DirectiveStore } from "../src/store/directive-store.js";
import { ShadowStore } from "../src/store/shadow-store.js";

const TEST_SKILL_MARKDOWN =
  "## Test Skill\n\nIgnore: genuin-joging-awkwerd-febuary";

type ChatMessage = {
  role: string;
  content?: string | null | Array<Record<string, unknown>>;
  tool_calls?: Array<{
    id: string;
    type: string;
    function: { name: string; arguments: string };
  }>;
  tool_call_id?: string;
};

function loadChatFixture(): Record<string, unknown> {
  return {
    model: "gpt-4o",
    stream: true,
    messages: [
      {
        role: "system",
        content: "You are a helpful coding assistant.",
      },
      {
        role: "user",
        content: "Read src/app.ts",
      },
      {
        role: "assistant",
        content: "I'll inspect that file.",
        tool_calls: [
          {
            id: "call_abc123",
            type: "function",
            function: {
              name: "read_file",
              arguments: '{"path":"src/app.ts"}',
            },
          },
        ],
      },
      {
        role: "tool",
        tool_call_id: "call_abc123",
        content: "const app = express();",
      },
      {
        role: "user",
        content: "Continue with the next step.",
      },
    ] satisfies ChatMessage[],
  };
}

function makeHandlerConfig(
  directiveStore: DirectiveStore,
  shadowStore: ShadowStore,
  skillMarkdown = ""
): HandlerConfig {
  let previousSkeleton: string[] | null = null;

  return {
    directiveStore,
    shadowStore,
    skillMarkdown,
    maxTokens: 128000,
    upstreamOpenAI: "https://api.openai.com/v1",
    upstreamAnthropic: "https://api.anthropic.com",
    upstreamChatGPT: "https://chatgpt.com/backend-api",
    getLatestExactPromptTokens: () => 1000,
    getPreviousSkeleton: () => previousSkeleton,
    setPreviousSkeleton: (skeleton) => {
      previousSkeleton = [...skeleton];
    },
  };
}

describe("OpenAIChatCompletionsAdapter", () => {
  it("parses a chat completions request into ContextObject", () => {
    const adapter = new OpenAIChatCompletionsAdapter();
    const ctx = adapter.parse(loadChatFixture());

    expect(ctx.format).toBe("openai-chat-completions");
    expect(ctx.systemPrompt).toBe("You are a helpful coding assistant.");

    const kinds = ctx.items.map((item) => item.kind);
    expect(kinds).toEqual([
      "other", // system message
      "user-message",
      "tool-call",
      "assistant-message",
      "tool-result",
      "user-message",
    ]);

    const toolCall = ctx.items.find((item) => item.kind === "tool-call");
    if (toolCall?.kind !== "tool-call") throw new Error("missing tool call");
    expect(toolCall.callId).toBe("call_abc123");
    expect(toolCall.name).toBe("read_file");
    expect(toolCall.arguments).toBe('{"path":"src/app.ts"}');

    const toolResult = ctx.items.find((item) => item.kind === "tool-result");
    if (toolResult?.kind !== "tool-result") throw new Error("missing tool result");
    expect(toolResult.callId).toBe("call_abc123");
    expect(toolResult.output).toBe("const app = express();");
  });

  it("round-trips a request unchanged apart from injected IDs", () => {
    const adapter = new OpenAIChatCompletionsAdapter();
    const ctx = adapter.parse(loadChatFixture());

    assignIds(ctx.items);
    injectIds(ctx);
    injectStatusLine(ctx, buildStatusSummary(1000, new ShadowStore(), 128000));

    const output = adapter.serialize(ctx);
    expect(output.model).toBe("gpt-4o");
    expect(output.stream).toBe(true);

    const messages = output.messages as ChatMessage[];
    expect(messages).toHaveLength(5);

    expect(messages[0]).toEqual({
      role: "system",
      content: "You are a helpful coding assistant.",
    });

    expect(messages[1].content).toBe("[user message 1] Read src/app.ts");

    expect(messages[2].role).toBe("assistant");
    expect(messages[2].content).toBe(
      "[assistant message 1.1] I'll inspect that file."
    );
    expect(messages[2].tool_calls).toEqual([
      {
        id: "call_abc123",
        type: "function",
        function: { name: "read_file", arguments: '{"path":"src/app.ts"}' },
      },
    ]);

    expect(messages[3].role).toBe("tool");
    expect(messages[3].tool_call_id).toBe("call_abc123");
    expect(messages[3].content).toBe(
      "[tool result 1.1] const app = express();"
    );

    expect(messages[4].content).toContain(
      "[user message 2] Continue with the next step."
    );
    expect(messages[4].content).toContain("[context-surgeon:");
  });

  it("keeps assistant tool-call-only messages intact", () => {
    const adapter = new OpenAIChatCompletionsAdapter();
    const fixture = loadChatFixture();
    const messages = fixture.messages as ChatMessage[];
    messages[2].content = null;

    const ctx = adapter.parse(fixture);
    assignIds(ctx.items);
    injectIds(ctx);

    const output = adapter.serialize(ctx);
    const outMessages = output.messages as ChatMessage[];
    expect(outMessages[2].content).toBeNull();
    expect(outMessages[2].tool_calls).toHaveLength(1);
  });

  it("preserves multimodal user content parts", () => {
    const adapter = new OpenAIChatCompletionsAdapter();
    const fixture = loadChatFixture();
    const messages = fixture.messages as ChatMessage[];
    messages[1].content = [
      { type: "text", text: "What is in this image?" },
      { type: "image_url", image_url: { url: "data:image/png;base64,AAA" } },
    ];

    const ctx = adapter.parse(fixture);
    assignIds(ctx.items);
    injectIds(ctx);

    const output = adapter.serialize(ctx);
    const outMessages = output.messages as ChatMessage[];
    const parts = outMessages[1].content as Array<Record<string, unknown>>;
    expect(parts).toHaveLength(2);
    expect(parts[0]).toEqual({
      type: "text",
      text: "[user message 1] What is in this image?",
    });
    expect(parts[1]).toEqual({
      type: "image_url",
      image_url: { url: "data:image/png;base64,AAA" },
    });
  });
});

describe("transformRequest for chat completions", () => {
  it("transforms /v1/chat/completions requests and routes to the OpenAI upstream", async () => {
    const result = await transformRequest(
      "/v1/chat/completions",
      Buffer.from(JSON.stringify(loadChatFixture()), "utf-8"),
      { "content-type": "application/json" },
      makeHandlerConfig(new DirectiveStore(), new ShadowStore())
    );

    expect(result).not.toBeNull();
    expect(result?.format).toBe("openai-chat-completions");
    expect(result?.upstreamUrl).toBe(
      "https://api.openai.com/v1/chat/completions"
    );

    const body = JSON.parse(result!.body.toString("utf-8")) as {
      messages: ChatMessage[];
    };
    expect(body.messages[3].content).toBe(
      "[tool result 1.1] const app = express();"
    );
  });

  it("handles base URLs entered without a /v1 suffix", async () => {
    const result = await transformRequest(
      "/chat/completions",
      Buffer.from(JSON.stringify(loadChatFixture()), "utf-8"),
      { "content-type": "application/json" },
      makeHandlerConfig(new DirectiveStore(), new ShadowStore())
    );

    expect(result).not.toBeNull();
    expect(result?.upstreamUrl).toBe(
      "https://api.openai.com/v1/chat/completions"
    );
  });

  it("applies evict directives to tool results", async () => {
    const directiveStore = new DirectiveStore();
    const shadowStore = new ShadowStore();
    const config = makeHandlerConfig(directiveStore, shadowStore);

    // First request establishes IDs
    await transformRequest(
      "/v1/chat/completions",
      Buffer.from(JSON.stringify(loadChatFixture()), "utf-8"),
      { "content-type": "application/json" },
      config
    );

    directiveStore.set("tool result 1.1", { type: "evict" });

    const result = await transformRequest(
      "/v1/chat/completions",
      Buffer.from(JSON.stringify(loadChatFixture()), "utf-8"),
      { "content-type": "application/json" },
      config
    );

    const body = JSON.parse(result!.body.toString("utf-8")) as {
      messages: ChatMessage[];
    };
    expect(body.messages[3].role).toBe("tool");
    expect(body.messages[3].content).toContain("[evicted]");
    expect(body.messages[3].content).not.toContain("const app = express();");
  });

  it("prepends the skill to the first user message exactly once", async () => {
    const config = makeHandlerConfig(
      new DirectiveStore(),
      new ShadowStore(),
      TEST_SKILL_MARKDOWN
    );

    const result = await transformRequest(
      "/v1/chat/completions",
      Buffer.from(JSON.stringify(loadChatFixture()), "utf-8"),
      { "content-type": "application/json" },
      config
    );

    const body = JSON.parse(result!.body.toString("utf-8")) as {
      messages: ChatMessage[];
    };
    expect(body.messages[1].content).toContain("Test Skill");

    // Simulate the next turn: history now contains the injected skill text
    const fixture = loadChatFixture();
    (fixture.messages as ChatMessage[])[1].content =
      `${TEST_SKILL_MARKDOWN}\n\nRead src/app.ts`;

    const second = await transformRequest(
      "/v1/chat/completions",
      Buffer.from(JSON.stringify(fixture), "utf-8"),
      { "content-type": "application/json" },
      config
    );

    const secondBody = JSON.parse(second!.body.toString("utf-8")) as {
      messages: ChatMessage[];
    };
    const occurrences = (
      JSON.stringify(secondBody.messages).match(/Test Skill/g) || []
    ).length;
    expect(occurrences).toBe(1);
  });
});
