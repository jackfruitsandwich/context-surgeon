import type { ContentBlock } from "../context/types.js";

export type ShadowEntry = {
  originalOutput: string | ContentBlock[];
  originalContent: ContentBlock[];
  tokenEstimate: number | null;
};

export class ShadowStore {
  private originals = new Map<string, ShadowEntry>();

  save(id: string, entry: ShadowEntry): void {
    this.originals.set(id, entry);
  }

  get(id: string): ShadowEntry | undefined {
    return this.originals.get(id);
  }

  has(id: string): boolean {
    return this.originals.has(id);
  }

  delete(id: string): boolean {
    return this.originals.delete(id);
  }

  getAll(): Map<string, ShadowEntry> {
    return new Map(this.originals);
  }

  totalEvictedTokens(): number {
    let total = 0;
    for (const entry of this.originals.values()) {
      total += entry.tokenEstimate ?? 0;
    }
    return total;
  }

  size(): number {
    return this.originals.size;
  }

  clear(): void {
    this.originals.clear();
  }
}
