import { assignIds } from "../src/context/id-assigner.js";
import { computeFingerprints } from "../src/context/fingerprint.js";
import { DirectiveStore } from "../src/store/directive-store.js";
import {
  ConversationTracker,
  resolveSelectors,
} from "../src/proxy/conversations.js";
import type { ContextObject, Directive } from "../src/context/types.js";

/** Fingerprint + assign display ids, exactly like the handler pipeline. */
export function prepare(ctx: ContextObject): void {
  computeFingerprints(ctx.items);
  assignIds(ctx.items);
}

/**
 * Mimic the control API: resolve an ordinal selector against a conversation
 * and store the directive under the matching fingerprints.
 */
export function setDirective(
  store: DirectiveStore,
  source: ContextObject | ConversationTracker,
  selector: string,
  directive: Directive
): string[] {
  let tracker: ConversationTracker;
  if (source instanceof ConversationTracker) {
    tracker = source;
  } else {
    tracker = new ConversationTracker();
    tracker.record(source.items);
  }

  const resolution = resolveSelectors(tracker, [selector]);
  if (!resolution || resolution.missing.length > 0) {
    throw new Error(`Test selector did not resolve: ${selector}`);
  }

  const fingerprints: string[] = [];
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
      fingerprints.push(item.fingerprint);
    }
  }
  return fingerprints;
}
