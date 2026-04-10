import { describe, expect, it } from "vitest";
import {
  formatStatusOutput,
  isRetryableControlError,
  normalizeCommandId,
} from "../src/cli/commands.js";

describe("normalizeCommandId", () => {
  it("treats bare short tool IDs as tool-result shorthand", () => {
    expect(normalizeCommandId("evict", "4.1")).toBe(
      "tool result 4.1"
    );
  });

  it("preserves explicit full short IDs", () => {
    expect(normalizeCommandId("evict", "tool call 4.1")).toBe(
      "tool call 4.1"
    );
    expect(normalizeCommandId("restore", "tool result 4.1")).toBe(
      "tool result 4.1"
    );
  });

  it("leaves unknown non-short IDs alone", () => {
    expect(normalizeCommandId("evict", "toolu_abc123")).toBe("toolu_abc123");
    expect(normalizeCommandId("replace", "call_abc123")).toBe("call_abc123");
  });

  it("treats wake-from-sleep socket errors as retryable", () => {
    const error = new Error("fetch failed", {
      cause: Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" }),
    });
    expect(isRetryableControlError(error)).toBe(true);
  });

  it("does not retry unrelated command errors", () => {
    expect(isRetryableControlError(new Error("Missing id"))).toBe(false);
  });

  it("formats status output with no active directives", () => {
    expect(
      formatStatusOutput({
        summary: {
          statusLine: "[context-surgeon: 35,934/128,000 tokens (28.1%)]",
        },
        activeDirectives: [],
      })
    ).toBe(
      "[context-surgeon: 35,934/128,000 tokens (28.1%)]\n\nActive directives:\nnone"
    );
  });

  it("formats status output with directive rows", () => {
    expect(
      formatStatusOutput({
        summary: {
          statusLine:
            "[context-surgeon: 35,934/128,000 tokens (28.1%) | 2 evicted]",
        },
        activeDirectives: [
          {
            id: "tool result 3.2",
            action: "evict",
            tokens: 463,
            tokenState: "known",
          },
          {
            id: "assistant message 10.1",
            action: "replace",
            tokens: null,
            tokenState: "unknown",
          },
          {
            id: "user message 12",
            action: "evict",
            tokens: null,
            tokenState: "pending",
          },
        ],
      })
    ).toBe(
      "[context-surgeon: 35,934/128,000 tokens (28.1%) | 2 evicted]\n\nActive directives:\ntool result 3.2 | evict | 463 tokens\nassistant message 10.1 | replace | unknown\nuser message 12 | evict | pending"
    );
  });

  it("formats media-only evictions in the action column", () => {
    expect(
      formatStatusOutput({
        summary: {
          statusLine: "[context-surgeon: 12,000/128,000 tokens (9.4%) | 1 evicted]",
        },
        activeDirectives: [
          {
            id: "user message 6",
            action: "evict image (1,3)",
            tokens: null,
            tokenState: "unknown",
          },
        ],
      })
    ).toBe(
      "[context-surgeon: 12,000/128,000 tokens (9.4%) | 1 evicted]\n\nActive directives:\nuser message 6 | evict image (1,3) | unknown"
    );
  });
});
