import type {
  ContextObject,
  ContentBlock,
  MediaType,
} from "./types.js";
import type { DirectiveStore } from "../store/directive-store.js";
import {
  estimateTokensByTextShare,
  type TextCharStats,
} from "./status.js";

function makeMediaPlaceholder(mediaType: MediaType): string {
  return mediaType === "image" ? "[image evicted]" : "[document evicted]";
}

function isMatchingMediaBlock(
  block: ContentBlock,
  mediaType: MediaType
): boolean {
  return block.type === mediaType;
}

function replaceMediaBlocks(
  blocks: ContentBlock[],
  mediaType: MediaType,
  occurrences?: number[]
): { content: ContentBlock[]; changed: boolean } {
  const selectedOccurrences =
    occurrences && occurrences.length > 0 ? new Set(occurrences) : null;
  const replacementText = makeMediaPlaceholder(mediaType);
  let mediaIndex = 0;
  let changed = false;

  const content = blocks.map((block) => {
    if (!isMatchingMediaBlock(block, mediaType)) {
      return block;
    }

    mediaIndex += 1;
    if (selectedOccurrences && !selectedOccurrences.has(mediaIndex)) {
      return block;
    }

    changed = true;
    return { type: "text" as const, text: replacementText };
  });

  return { content, changed };
}

export type AppliedDirective = {
  fingerprint: string;
  itemId: string;
  tokenEstimate: number | null;
};

/**
 * Apply stored directives to every item whose fingerprint matches. Purely
 * content-addressed: requests from unrelated conversations contain no
 * matching fingerprints and pass through untouched.
 */
export function applyDirectives(
  ctx: ContextObject,
  directiveStore: DirectiveStore,
  stats: {
    textCharStats: TextCharStats;
    latestExactPromptTokens: number | null;
  }
): AppliedDirective[] {
  const applied: AppliedDirective[] = [];

  for (const item of ctx.items) {
    const fingerprint = item.fingerprint;
    if (!fingerprint) continue;
    const entry = directiveStore.get(fingerprint);
    if (!entry) continue;

    const directive = entry.directive;
    const itemChars = stats.textCharStats.itemChars.get(item.id) ?? null;
    const tokenEstimate =
      directive.type === "evict" && directive.mediaType
        ? null
        : estimateTokensByTextShare(
            itemChars,
            stats.textCharStats.totalChars,
            stats.latestExactPromptTokens
          );

    if (directive.type === "evict") {
      if (directive.mediaType) {
        if (item.kind === "user-message" || item.kind === "assistant-message") {
          const replaced = replaceMediaBlocks(
            item.content,
            directive.mediaType,
            directive.occurrences
          );
          if (!replaced.changed) {
            continue;
          }
          item.content = replaced.content;
        } else if (item.kind === "tool-result" && Array.isArray(item.output)) {
          const replaced = replaceMediaBlocks(
            item.output,
            directive.mediaType,
            directive.occurrences
          );
          if (!replaced.changed) {
            continue;
          }
          item.output = replaced.content;
        } else {
          continue;
        }
        applied.push({ fingerprint, itemId: item.id, tokenEstimate });
        continue;
      }

      if (item.kind === "user-message" || item.kind === "assistant-message") {
        item.content = [{ type: "text", text: "[evicted]" }];
      } else if (item.kind === "tool-result") {
        item.output = "[evicted]";
      } else if (item.kind === "tool-call") {
        item.arguments = "{}";
      } else {
        continue;
      }
      applied.push({ fingerprint, itemId: item.id, tokenEstimate });
    } else if (directive.type === "replace") {
      if (item.kind === "user-message" || item.kind === "assistant-message") {
        item.content = [{ type: "text", text: directive.content }];
      } else if (item.kind === "tool-result") {
        item.output = directive.content;
      } else if (item.kind === "tool-call") {
        item.arguments = JSON.stringify({ _replaced: directive.content });
      } else {
        continue;
      }
      applied.push({ fingerprint, itemId: item.id, tokenEstimate });
    }
  }

  return applied;
}
