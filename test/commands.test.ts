import { describe, expect, it } from "vitest";
import {
  formatSkeletonOutput,
  formatStatusOutput,
  isRetryableControlError,
  normalizeCommandId,
  parseEvictTargetIds,
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

  it("expands mixed evict selector flags into canonical directive ids", () => {
    expect(
      parseEvictTargetIds([
        "evict",
        "--turn",
        "2..5",
        "--assistant",
        "7.1,7.3",
        "--tool-result",
        "8,9.2",
      ])
    ).toEqual([
      "turn 2",
      "turn 3",
      "turn 4",
      "turn 5",
      "assistant message 7.1",
      "assistant message 7.3",
      "tool result 8",
      "tool result 9.2",
    ]);
  });

  it("keeps legacy positional evict ids working", () => {
    expect(parseEvictTargetIds(["evict", "4.1"])).toEqual([
      "tool result 4.1",
    ]);
    expect(
      parseEvictTargetIds(["evict", "[assistant", "message", "4.2]"])
    ).toEqual(["assistant message 4.2"]);
  });

  it("rejects unclear mixed positional and selector evictions", () => {
    expect(() =>
      parseEvictTargetIds(["evict", "tool", "result", "4.1", "--turn", "2"])
    ).toThrow("Do not mix selector flags");
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

  it("formats a compact skeleton with evicted tool results", () => {
    expect(
      formatSkeletonOutput({
        summary: {
          statusLine: "[context-surgeon: 12,000/128,000 tokens (9.4%) | 3 evicted]",
        },
        items: [
          {
            id: "user message 1",
            kind: "user",
            turn: 1,
            index: null,
            surgery: { state: "active", action: null, tokens: null },
          },
          {
            id: "assistant message 1.1",
            kind: "assistant",
            turn: 1,
            index: 1,
            surgery: { state: "applied", action: "evict", tokens: 95 },
          },
          {
            id: "tool call 1.1",
            kind: "tool-call",
            turn: 1,
            index: 1,
            toolName: "exec_command",
            surgery: { state: "active", action: null, tokens: null },
          },
          {
            id: "tool result 1.1",
            kind: "tool-result",
            turn: 1,
            index: 1,
            surgery: { state: "applied", action: "evict", tokens: 123 },
          },
          {
            id: "tool call 1.2",
            kind: "tool-call",
            turn: 1,
            index: 2,
            toolName: "exec_command",
            surgery: { state: "active", action: null, tokens: null },
          },
          {
            id: "tool result 1.2",
            kind: "tool-result",
            turn: 1,
            index: 2,
            surgery: { state: "applied", action: "evict", tokens: 456 },
          },
          {
            id: "assistant message 1.2",
            kind: "assistant",
            turn: 1,
            index: 2,
            surgery: { state: "active", action: null, tokens: null },
          },
          {
            id: "user message 2",
            kind: "user",
            turn: 2,
            index: null,
            surgery: { state: "pending", action: "evict image", tokens: null },
          },
        ],
      })
    ).toBe(
      "[context-surgeon: 12,000/128,000 tokens (9.4%) | 3 evicted]\n\n" +
        "Legend: u=user, a=assistant, t=tool call/result pair\n\n" +
        "1: u1, a1.1[evicted], t1.1-2[result evicted], a1.2\n" +
        "2: u2[image evicted pending]"
    );
  });
});
