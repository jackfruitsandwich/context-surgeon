import { join } from "node:path";
import { homedir } from "node:os";
import type { Directive } from "../context/types.js";

// V1 compatibility only. Memory-only instances remain for the legacy
// transformer test surface until truth-core integration deletes it.
// Persisted global fingerprints are never loaded or mutated by v2: migration
// reads them separately as disabled legacy-unbound evidence.

export type DirectiveEntry = {
  directive: Directive;
  /** Last known ordinal label (display only in the retired v1 UI). */
  humanId: string;
  /** Memory-only compatibility preview; v3 never persists it. */
  preview: string;
  tokenEstimate: number | null;
  createdAt: number;
  lastMatchedAt: number | null;
};

export function defaultDirectivesPath(): string {
  return join(homedir(), ".context-surgeon", "directives.json");
}

export class DirectiveStore {
  private entries = new Map<string, DirectiveEntry>();
  private readonly persistedV1Disabled: boolean;

  /** Null creates the memory-only compatibility fake used by v1 tests. */
  constructor(path: string | null = null) {
    this.persistedV1Disabled = path !== null;
  }

  set(fingerprint: string, entry: DirectiveEntry): void {
    if (this.persistedV1Disabled) {
      throw new Error("Persisted v1 directives are disabled; use a v3 session transaction");
    }
    this.entries.set(fingerprint, entry);
  }

  get(fingerprint: string): DirectiveEntry | undefined {
    return this.entries.get(fingerprint);
  }

  has(fingerprint: string): boolean {
    return this.entries.has(fingerprint);
  }

  delete(fingerprint: string): boolean {
    if (this.persistedV1Disabled) {
      throw new Error("Persisted v1 directives are disabled; use a v3 reversal transaction");
    }
    return this.entries.delete(fingerprint);
  }

  noteMatched(fingerprint: string, humanId: string, tokenEstimate: number | null): void {
    const entry = this.entries.get(fingerprint);
    if (!entry) return;
    entry.lastMatchedAt = Date.now();
    entry.humanId = humanId;
    if (tokenEstimate !== null) entry.tokenEstimate = tokenEstimate;
  }

  flushIfDirty(): void {}

  close(): void {}

  getAll(): Map<string, DirectiveEntry> {
    return new Map(this.entries);
  }

  size(): number {
    return this.entries.size;
  }
}
