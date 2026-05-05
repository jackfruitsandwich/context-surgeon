import type {
  ContextObject,
  ContextItem,
  ContentBlock,
  Directive,
  MediaType,
} from "./types.js";
import type { DirectiveStore } from "../store/directive-store.js";
import type { ShadowStore } from "../store/shadow-store.js";
import {
  estimateTokensByTextShare,
  type TextCharStats,
} from "./status.js";
import { lookupDirectiveForItem } from "./directive-targets.js";

function makeMediaPlaceholder(mediaType: MediaType): string {
  return mediaType === "image" ? "[image evicted]" : "[document evicted]";
}

function cloneOutput(
  output: string | ContentBlock[]
): string | ContentBlock[] {
  return typeof output === "string" ? output : [...output];
}

function saveShadowIfNeeded(
  item: ContextItem,
  lookupId: string,
  directive: Directive,
  shadowStore: ShadowStore,
  stats: {
    textCharStats: TextCharStats;
    latestExactPromptTokens: number | null;
  }
): void {
  if (shadowStore.has(lookupId)) {
    return;
  }

  const itemChars = stats.textCharStats.itemChars.get(lookupId) ?? null;
  shadowStore.save(lookupId, {
    originalOutput:
      item.kind === "tool-result"
        ? cloneOutput(item.output)
        : item.kind === "tool-call"
          ? item.arguments
          : "",
    originalContent:
      item.kind === "user-message" || item.kind === "assistant-message"
        ? [...item.content]
        : [],
    tokenEstimate:
      directive.type === "evict" && directive.mediaType
        ? null
        : estimateTokensByTextShare(
            itemChars,
            stats.textCharStats.totalChars,
            stats.latestExactPromptTokens
          ),
  });
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

export function applyDirectives(
  ctx: ContextObject,
  directiveStore: DirectiveStore,
  shadowStore: ShadowStore,
  stats: {
    textCharStats: TextCharStats;
    latestExactPromptTokens: number | null;
  }
): void {
  for (const item of ctx.items) {
    const match = lookupDirectiveForItem(item, directiveStore);
    if (!match) continue;

    const lookupId = item.id;
    const directive = match.directive;

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
          saveShadowIfNeeded(item, lookupId, directive, shadowStore, stats);
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
          saveShadowIfNeeded(item, lookupId, directive, shadowStore, stats);
          item.output = replaced.content;
        }
        continue;
      }

      saveShadowIfNeeded(item, lookupId, directive, shadowStore, stats);

      if (item.kind === "user-message" || item.kind === "assistant-message") {
        item.content = [{ type: "text", text: "[evicted]" }];
      } else if (item.kind === "tool-result") {
        item.output = "[evicted]";
      } else if (item.kind === "tool-call") {
        item.arguments = "{}";
      }
    } else if (directive.type === "replace") {
      saveShadowIfNeeded(item, lookupId, directive, shadowStore, stats);

      // Replace content with the provided summary
      if (item.kind === "user-message" || item.kind === "assistant-message") {
        item.content = [{ type: "text", text: directive.content }];
      } else if (item.kind === "tool-result") {
        item.output = directive.content;
      } else if (item.kind === "tool-call") {
        // Replace arguments with a note (unusual but supported)
        item.arguments = JSON.stringify({ _replaced: directive.content });
      }
    }
  }
}

export function applyRestore(
  id: string,
  ctx: ContextObject,
  directiveStore: DirectiveStore,
  shadowStore: ShadowStore
): boolean {
  const shadow = shadowStore.get(id);
  if (!shadow) return false;

  for (const item of ctx.items) {
    const lookupId = item.id;
    if (lookupId !== id) continue;

    // Restore original content
    if (item.kind === "user-message" || item.kind === "assistant-message") {
      item.content = [...shadow.originalContent];
    } else if (item.kind === "tool-result") {
      item.output = shadow.originalOutput;
    } else if (item.kind === "tool-call") {
      if (typeof shadow.originalOutput === "string") {
        item.arguments = shadow.originalOutput;
      }
    }

    break;
  }

  // Clean up
  directiveStore.delete(id);
  shadowStore.delete(id);
  return true;
}
