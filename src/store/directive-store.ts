import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import type { Directive } from "../context/types.js";

// Directives are keyed by content-chain fingerprint, never by ordinal
// position, so a directive can only ever affect the exact content (at the
// exact point in the exact history) it was created for. Stale entries are
// inert — they match nothing — which is why the store can be shared on disk
// across proxies and sessions without any conversation bookkeeping.

export type DirectiveEntry = {
  directive: Directive;
  /** Last known ordinal label ("tool result 12.3") — display only. */
  humanId: string;
  /** Short content preview for status output — display only. */
  preview: string;
  tokenEstimate: number | null;
  createdAt: number;
  lastMatchedAt: number | null;
};

type PersistedFile = {
  version: number;
  entries: Record<string, DirectiveEntry>;
};

const PERSIST_VERSION = 2;
const GC_MAX_IDLE_MS = 30 * 24 * 60 * 60 * 1000; // 30 days unmatched → drop
const FLUSH_INTERVAL_MS = 15_000;

export function defaultDirectivesPath(): string {
  return join(homedir(), ".context-surgeon", "directives.json");
}

function entryLastActive(entry: DirectiveEntry): number {
  return Math.max(entry.createdAt, entry.lastMatchedAt ?? 0);
}

function isDirective(value: unknown): value is Directive {
  if (!value || typeof value !== "object") return false;
  const type = (value as { type?: unknown }).type;
  return type === "evict" || type === "replace";
}

function sanitizeEntries(raw: unknown): Map<string, DirectiveEntry> {
  const entries = new Map<string, DirectiveEntry>();
  if (!raw || typeof raw !== "object") return entries;
  for (const [fp, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!value || typeof value !== "object") continue;
    const candidate = value as Partial<DirectiveEntry>;
    if (!isDirective(candidate.directive)) continue;
    entries.set(fp, {
      directive: candidate.directive,
      humanId: typeof candidate.humanId === "string" ? candidate.humanId : "?",
      preview: typeof candidate.preview === "string" ? candidate.preview : "",
      tokenEstimate:
        typeof candidate.tokenEstimate === "number" ? candidate.tokenEstimate : null,
      createdAt: typeof candidate.createdAt === "number" ? candidate.createdAt : Date.now(),
      lastMatchedAt:
        typeof candidate.lastMatchedAt === "number" ? candidate.lastMatchedAt : null,
    });
  }
  return entries;
}

export class DirectiveStore {
  private entries = new Map<string, DirectiveEntry>();
  private dirty = false;
  private flushTimer: NodeJS.Timeout | null = null;
  private readonly path: string | null;

  /** Pass a path to enable persistence; null keeps the store memory-only (tests). */
  constructor(path: string | null = null) {
    this.path = path;
    if (this.path) {
      this.loadAndGc();
      this.flushTimer = setInterval(() => this.flushIfDirty(), FLUSH_INTERVAL_MS);
      this.flushTimer.unref();
    }
  }

  private loadAndGc(): void {
    if (!this.path) return;
    let parsed: PersistedFile | null = null;
    try {
      parsed = JSON.parse(readFileSync(this.path, "utf-8")) as PersistedFile;
    } catch {
      return; // no file yet, or unreadable — start empty
    }
    const loaded = sanitizeEntries(parsed?.entries);
    const cutoff = Date.now() - GC_MAX_IDLE_MS;
    let dropped = 0;
    for (const [fp, entry] of loaded) {
      if (entryLastActive(entry) < cutoff) {
        dropped += 1;
        continue;
      }
      this.entries.set(fp, entry);
    }
    if (dropped > 0) {
      console.error(
        `[context-surgeon] Garbage-collected ${dropped} directive(s) unmatched for 30+ days`
      );
      this.dirty = true;
    }
  }

  /**
   * Merge-on-write: re-read the file and union it with in-memory state so a
   * concurrent proxy's new entries are not clobbered. Freshest activity wins.
   */
  private persist(): void {
    if (!this.path) return;
    let onDisk = new Map<string, DirectiveEntry>();
    try {
      const parsed = JSON.parse(readFileSync(this.path, "utf-8")) as PersistedFile;
      onDisk = sanitizeEntries(parsed?.entries);
    } catch {
      // fine — first write
    }

    const merged = new Map(onDisk);
    for (const [fp, entry] of this.entries) {
      const existing = merged.get(fp);
      if (!existing || entryLastActive(entry) >= entryLastActive(existing)) {
        merged.set(fp, entry);
      }
    }
    for (const fp of this.deletedFps) {
      merged.delete(fp);
    }

    const payload: PersistedFile = {
      version: PERSIST_VERSION,
      entries: Object.fromEntries(merged),
    };
    try {
      mkdirSync(dirname(this.path), { recursive: true });
      const tmpPath = `${this.path}.${process.pid}.tmp`;
      writeFileSync(tmpPath, JSON.stringify(payload));
      renameSync(tmpPath, this.path);
      this.deletedFps.clear();
      this.dirty = false;
    } catch (error) {
      console.error(
        `[context-surgeon] WARNING: could not persist directives to ${this.path}: ${
          error instanceof Error ? error.message : error
        }`
      );
    }
  }

  // Deletions must survive the merge (otherwise a restore would resurrect on
  // the next merge with the file). Tracked until successfully persisted.
  private deletedFps = new Set<string>();

  set(fingerprint: string, entry: DirectiveEntry): void {
    this.entries.set(fingerprint, entry);
    this.deletedFps.delete(fingerprint);
    this.persist();
  }

  get(fingerprint: string): DirectiveEntry | undefined {
    return this.entries.get(fingerprint);
  }

  has(fingerprint: string): boolean {
    return this.entries.has(fingerprint);
  }

  delete(fingerprint: string): boolean {
    const deleted = this.entries.delete(fingerprint);
    if (deleted) {
      this.deletedFps.add(fingerprint);
      this.persist();
    }
    return deleted;
  }

  /** Record that a directive applied to a live request. Flushed lazily. */
  noteMatched(fingerprint: string, humanId: string, tokenEstimate: number | null): void {
    const entry = this.entries.get(fingerprint);
    if (!entry) return;
    entry.lastMatchedAt = Date.now();
    entry.humanId = humanId;
    if (tokenEstimate !== null) {
      entry.tokenEstimate = tokenEstimate;
    }
    this.dirty = true;
  }

  flushIfDirty(): void {
    if (this.dirty) {
      this.persist();
    }
  }

  close(): void {
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
    this.flushIfDirty();
  }

  getAll(): Map<string, DirectiveEntry> {
    return new Map(this.entries);
  }

  size(): number {
    return this.entries.size;
  }
}
