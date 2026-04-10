export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export function estimateContentBlockTokens(
  blocks: Array<{ type: string; text?: string; data?: unknown; raw?: unknown }>
): number {
  let total = 0;
  for (const block of blocks) {
    if (block.type === "text" && typeof block.text === "string") {
      total += estimateTokens(block.text);
    } else if (block.type === "image") {
      total += 2000; // rough estimate for image tokens
    } else {
      total += 50; // unknown block type
    }
  }
  return total;
}
