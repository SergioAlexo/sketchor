/**
 * "A file on disk just changed" bus plus the pure cache logic the in-app file
 * browser needs to react to it.
 *
 * Why this exists: the browser (FileExplorerPanel) caches each file's text
 * (for drag-out and thumbnails), renders thumbnails once per card, and lists
 * size/mtime from a one-off directory scan. Saving through drawingFile.ts
 * wrote the file but told none of those, so after Save + switching tabs the
 * browser kept showing — and re-opening from it loaded — the pre-save content
 * until the whole app was restarted. Every successful write now emits here,
 * and the panel invalidates the matching entry.
 */

/** What a successful save wrote: a native path (desktop) and/or a File System Access handle (web). */
export interface SavedFile {
  name: string;
  path?: string;
  handle?: unknown;
}

type Listener = (saved: SavedFile) => void;
const listeners = new Set<Listener>();

/** Subscribe to successful file writes; returns the unsubscribe function. */
export function onFileSaved(fn: Listener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Announce that `saved` was just written to disk. A throwing listener never breaks the save. */
export function emitFileSaved(saved: SavedFile): void {
  for (const fn of [...listeners]) {
    try {
      fn(saved);
    } catch {
      // a UI listener failing must not turn a successful save into an error
    }
  }
}

/** Normalises a native path for comparison: forward slashes, no trailing slash, case-folded (Windows paths are case-insensitive). */
export function normPath(p: string): string {
  return p.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}

export function samePath(a: string | undefined, b: string | undefined): boolean {
  return !!a && !!b && normPath(a) === normPath(b);
}

/** Directory part of a native path (no trailing slash), or "" when it has none. */
export function dirOf(p: string): string {
  const n = p.replace(/\\/g, "/");
  const i = n.lastIndexOf("/");
  return i < 0 ? "" : n.slice(0, i);
}

interface HandleLike {
  name?: string;
  isSameEntry?: (other: unknown) => Promise<boolean>;
}

/**
 * Does a browser entry refer to the file that was just saved? Paths compare
 * exactly (case/slash-insensitive). Handles use `isSameEntry` where
 * available; when it is missing or throws, a matching file name is the
 * fallback — a spurious match only costs one extra re-read.
 */
export async function entryMatchesSaved(entry: { name: string; path?: string; handle?: unknown }, saved: SavedFile): Promise<boolean> {
  if (entry.path && saved.path) return samePath(entry.path, saved.path);
  if (entry.handle && saved.handle) {
    const a = entry.handle as HandleLike;
    try {
      if (typeof a.isSameEntry === "function") return await a.isSameEntry(saved.handle);
    } catch {
      // fall through to the name comparison
    }
    return entry.name === saved.name;
  }
  return false;
}

/**
 * Text cache keyed by entry. Reads go through `get`; a save, or an open from
 * the browser, `invalidate`s so the next read hits the disk again.
 * `generation` lets an in-flight read that started before an invalidation
 * discard its (stale) result instead of re-poisoning the cache.
 */
export class TextCache {
  private map = new Map<string, string>();
  private gen = new Map<string, number>();

  get(key: string): string | undefined {
    return this.map.get(key);
  }

  generation(key: string): number {
    return this.gen.get(key) ?? 0;
  }

  /** Stores `text` unless the entry was invalidated since `generation` was sampled. Returns whether it was stored. */
  set(key: string, text: string, generation = this.generation(key)): boolean {
    if (generation !== this.generation(key)) return false;
    this.map.set(key, text);
    return true;
  }

  invalidate(key: string): void {
    this.map.delete(key);
    this.gen.set(key, this.generation(key) + 1);
  }
}
