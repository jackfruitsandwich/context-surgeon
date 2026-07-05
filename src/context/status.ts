import type { ContextItem, ContextObject, ContentBlock } from "./types.js";

export type StatusSummary = {
  promptTokens: number | null;
  maxTokens: number;
  pct: string;
  evictedCount: number;
  evictedTokens: number;
};

export type TextCharStats = {
  totalChars: number;
  itemChars: Map<string, number | null>;
};

const CHARS_PER_TOKEN_ESTIMATE = 3.1;

function measureTextBlocks(content: ContentBlock[]): number | null {
  let total = 0;

  for (const block of content) {
    if (block.type !== "text") {
      return null;
    }
    total += block.text.length;
  }

  return total;
}

export function measureItemTextChars(item: ContextItem): number | null {
  if (item.kind === "user-message" || item.kind === "assistant-message") {
    return measureTextBlocks(item.content);
  }

  if (item.kind === "tool-call") {
    return item.name.length + item.arguments.length;
  }

  if (item.kind === "tool-result") {
    if (typeof item.output === "string") {
      return item.output.length;
    }
    return measureTextBlocks(item.output);
  }

  return null;
}

export function computeTextCharStats(ctx: ContextObject): TextCharStats {
  const itemChars = new Map<string, number | null>();
  let totalChars = ctx.systemPrompt.length;

  for (const item of ctx.items) {
    const chars = measureItemTextChars(item);
    itemChars.set(item.id, chars);
    if (chars !== null) {
      totalChars += chars;
    }
  }

  return { totalChars, itemChars };
}

export function estimateTokensByTextShare(
  itemChars: number | null,
  totalChars: number,
  totalTokens: number | null
): number | null {
  if (itemChars === null || totalTokens === null || totalChars <= 0) {
    return null;
  }

  return Math.round((itemChars / totalChars) * totalTokens);
}

export function estimateTokensFromChars(totalChars: number): number {
  if (totalChars <= 0) {
    return 0;
  }

  return Math.round(totalChars / CHARS_PER_TOKEN_ESTIMATE);
}

export function buildStatusSummary(
  promptTokens: number | null,
  evictedCount: number,
  evictedTokens: number,
  maxTokens: number
): StatusSummary {
  const pct =
    promptTokens !== null && maxTokens > 0
      ? ((promptTokens / maxTokens) * 100).toFixed(1)
      : "?";

  return {
    promptTokens,
    maxTokens,
    pct,
    evictedCount,
    evictedTokens,
  };
}

export function makeStatusLine(summary: StatusSummary): string {
  const promptText =
    summary.promptTokens === null ? "?" : summary.promptTokens.toLocaleString();

  const evictedText =
    summary.evictedCount > 0
      ? ` | ${summary.evictedCount} evicted` +
        (summary.evictedTokens > 0
          ? ` (~${summary.evictedTokens.toLocaleString()} tokens saved)`
          : "")
      : "";

  return (
    `[context-surgeon: ${promptText}/${summary.maxTokens.toLocaleString()} tokens (${summary.pct}%)` +
    evictedText +
    `]`
  );
}
