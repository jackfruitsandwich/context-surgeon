import type { ContextItem } from "../context/types.js";
import { measureItemTextChars } from "../context/status.js";

// Snapshots exist ONLY so control commands can resolve ordinal labels
// ("tool result 12.3") to content fingerprints, and so the status line can
// attribute prompt-token counts to the right conversation. They are a
// read-only convenience: nothing here ever decides whether a directive
// applies — that is done purely by fingerprint match in the transformer.

export type ResolutionItem = {
  id: string;
  fingerprint: string;
  kind: ContextItem["kind"];
  toolName?: string;
  preview: string;
  chars: number | null;
};

export type ConversationSnapshot = {
  rootFingerprint: string;
  items: ResolutionItem[];
  itemCount: number;
  firstUserPreview: string;
  lastSeenAt: number;
  promptTokens: number | null;
  /** Fingerprints of directives applied to this conversation's latest request. */
  lastApplied: Set<string>;
};

const MAX_TRACKED_CONVERSATIONS = 16;
const PREVIEW_CHARS = 80;

function itemPreview(item: ContextItem): string {
  let text = "";
  if (item.kind === "user-message" || item.kind === "assistant-message") {
    const block = item.content.find((b) => b.type === "text");
    text = block && block.type === "text" ? block.text : `[${item.content.length} block(s)]`;
  } else if (item.kind === "tool-call") {
    text = `${item.name} ${item.arguments}`;
  } else if (item.kind === "tool-result") {
    if (typeof item.output === "string") {
      text = item.output;
    } else {
      const block = item.output.find((b) => b.type === "text");
      text = block && block.type === "text" ? block.text : `[${item.output.length} block(s)]`;
    }
  }
  const collapsed = text.replace(/\s+/g, " ").trim();
  return collapsed.length > PREVIEW_CHARS
    ? `${collapsed.slice(0, PREVIEW_CHARS)}…`
    : collapsed;
}

// After a control command resolves against a conversation, later commands
// prefer that same conversation (while it stays active) over the size/recency
// ranking. The agent issuing commands is almost always operating on the same
// thread it targeted last time, even when a large subagent is interleaving.
const STICKY_ROOT_MAX_IDLE_MS = 15 * 60 * 1000;

export class ConversationTracker {
  private conversations = new Map<string, ConversationSnapshot>();
  private lastDirectiveRoot: string | null = null;

  noteDirectiveRoot(root: string): void {
    this.lastDirectiveRoot = root;
  }

  stickyRoot(): string | null {
    if (!this.lastDirectiveRoot) return null;
    const snapshot = this.conversations.get(this.lastDirectiveRoot);
    if (!snapshot) return null;
    if (Date.now() - snapshot.lastSeenAt > STICKY_ROOT_MAX_IDLE_MS) return null;
    return this.lastDirectiveRoot;
  }

  /** Record the latest sight of a conversation. Returns its root fingerprint. */
  record(items: ContextItem[]): string | null {
    const first = items[0];
    if (!first?.fingerprint) return null;
    const root = first.fingerprint;

    const firstUser = items.find((item) => item.kind === "user-message");
    const snapshot: ConversationSnapshot = {
      rootFingerprint: root,
      items: items.map((item) => ({
        id: item.id,
        fingerprint: item.fingerprint ?? "",
        kind: item.kind,
        toolName: item.kind === "tool-call" ? item.name : undefined,
        preview: itemPreview(item),
        chars: measureItemTextChars(item),
      })),
      itemCount: items.length,
      firstUserPreview: firstUser ? itemPreview(firstUser) : "",
      lastSeenAt: Date.now(),
      promptTokens: this.conversations.get(root)?.promptTokens ?? null,
      lastApplied: this.conversations.get(root)?.lastApplied ?? new Set(),
    };
    this.conversations.set(root, snapshot);
    this.evictOldest();
    return root;
  }

  noteApplied(root: string, fingerprints: string[]): void {
    const snapshot = this.conversations.get(root);
    if (snapshot) {
      snapshot.lastApplied = new Set(fingerprints);
    }
  }

  notePromptTokens(root: string, tokens: number): void {
    const snapshot = this.conversations.get(root);
    if (snapshot) {
      snapshot.promptTokens = tokens;
    }
  }

  get(root: string): ConversationSnapshot | undefined {
    return this.conversations.get(root);
  }

  /**
   * The conversation a bare control command most plausibly refers to: the
   * largest recently-seen one (the wrapped session's main thread dwarfs
   * subagent sidechains and utility calls).
   */
  primary(): ConversationSnapshot | null {
    let best: ConversationSnapshot | null = null;
    for (const snapshot of this.conversations.values()) {
      if (
        !best ||
        snapshot.itemCount > best.itemCount ||
        (snapshot.itemCount === best.itemCount && snapshot.lastSeenAt > best.lastSeenAt)
      ) {
        best = snapshot;
      }
    }
    return best;
  }

  all(): ConversationSnapshot[] {
    return [...this.conversations.values()].sort(
      (a, b) => b.lastSeenAt - a.lastSeenAt
    );
  }

  // Displace the smallest conversation first (oldest among ties). Harness
  // utility calls are a stream of 1-item conversations; they must never be
  // able to churn the session's real (large) conversation out of the tracker.
  private evictOldest(): void {
    while (this.conversations.size > MAX_TRACKED_CONVERSATIONS) {
      let victimKey: string | null = null;
      let victim: ConversationSnapshot | null = null;
      for (const [key, snapshot] of this.conversations) {
        if (
          !victim ||
          snapshot.itemCount < victim.itemCount ||
          (snapshot.itemCount === victim.itemCount &&
            snapshot.lastSeenAt < victim.lastSeenAt)
        ) {
          victim = snapshot;
          victimKey = key;
        }
      }
      if (!victimKey) return;
      this.conversations.delete(victimKey);
    }
  }
}

// ---- Selector resolution ----

export type ResolvedTarget = {
  selector: string;
  items: ResolutionItem[];
};

export type ResolutionResult = {
  conversation: ConversationSnapshot;
  resolved: ResolvedTarget[];
  missing: string[];
};

const TURN_SELECTOR_RE = /^turn (\d+)$/;
const KIND_TURN_SELECTOR_RE =
  /^(assistant message|tool call|tool result) (\d+)$/;
const EXACT_ID_RE =
  /^(?:user message \d+|assistant message \d+\.\d+|tool call \d+\.\d+|tool result \d+\.\d+)$/;

function itemTurn(id: string): number | null {
  const match =
    /^(?:user message|assistant message|tool call|tool result) (\d+)(?:\.\d+)?$/.exec(id);
  return match ? Number(match[1]) : null;
}

function selectorMatches(selector: string, item: ResolutionItem): boolean {
  if (selector === item.id) return true;

  const turnMatch = TURN_SELECTOR_RE.exec(selector);
  if (turnMatch) {
    return itemTurn(item.id) === Number(turnMatch[1]);
  }

  const kindTurnMatch = KIND_TURN_SELECTOR_RE.exec(selector);
  if (kindTurnMatch) {
    return new RegExp(`^${kindTurnMatch[1]} ${kindTurnMatch[2]}\\.\\d+$`).test(item.id);
  }

  return false;
}

export function isKnownSelectorShape(selector: string): boolean {
  return (
    EXACT_ID_RE.test(selector) ||
    TURN_SELECTOR_RE.test(selector) ||
    KIND_TURN_SELECTOR_RE.test(selector)
  );
}

/**
 * Resolve selectors against tracked conversations. Prefers a conversation
 * that matches every selector; otherwise the one matching the most, so the
 * error names exactly which selectors found nothing.
 */
export function resolveSelectors(
  tracker: ConversationTracker,
  selectors: string[]
): ResolutionResult | null {
  const stickyRoot = tracker.stickyRoot();
  const candidates = tracker.all().sort((a, b) => {
    if (stickyRoot) {
      if (a.rootFingerprint === stickyRoot && b.rootFingerprint !== stickyRoot) return -1;
      if (b.rootFingerprint === stickyRoot && a.rootFingerprint !== stickyRoot) return 1;
    }
    if (b.itemCount !== a.itemCount) return b.itemCount - a.itemCount;
    return b.lastSeenAt - a.lastSeenAt;
  });
  if (candidates.length === 0) return null;

  let best: ResolutionResult | null = null;
  for (const conversation of candidates) {
    const resolved: ResolvedTarget[] = [];
    const missing: string[] = [];
    for (const selector of selectors) {
      const items = conversation.items.filter(
        (item) => item.fingerprint && selectorMatches(selector, item)
      );
      if (items.length === 0) {
        missing.push(selector);
      } else {
        resolved.push({ selector, items });
      }
    }
    if (missing.length === 0) {
      return { conversation, resolved, missing };
    }
    if (!best || resolved.length > best.resolved.length) {
      best = { conversation, resolved, missing };
    }
  }
  return best;
}
