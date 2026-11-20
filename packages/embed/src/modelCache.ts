/**
 * E-03: parsed models cached in IndexedDB, so a visitor who comes back (or a
 * page with the same part twice) skips the parse — segmenting and recovering
 * the B-rep is most of the wait after the download, which the browser's HTTP
 * cache already handles.
 *
 * Keyed by the SHA-256 of the file bytes plus everything else that changes
 * the result (format, up axis, cache layout), not by URL: a re-uploaded file
 * at the same URL gets a fresh parse, and the same file at two URLs is parsed
 * once. Bump `CACHE_VERSION` whenever `Model3D` or the extraction changes —
 * it is part of every key, so stale entries stop matching and age out.
 *
 * Every call fails soft (private mode, blocked storage, quota): the preview
 * then just parses, as it would without a cache.
 */
import type { Model3D } from "./three/types";

export const CACHE_VERSION = 1;
const DB = "sketchor-embed";
const STORE = "models";
/** Oldest entries go first past either limit. */
export const MAX_ENTRIES = 40;
export const MAX_BYTES = 200 * 1048576;

export interface CacheEntry {
  key: string;
  model: Model3D;
  bytes: number;
  at: number;
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", bytes as Uint8Array<ArrayBuffer>);
  return Array.from(new Uint8Array(d), (b) => b.toString(16).padStart(2, "0")).join("");
}

export const cacheKey = (hash: string, format: string, up: string): string => `${CACHE_VERSION}:${format}:${up}:${hash}`;

/** Bytes held in typed arrays anywhere inside `v` — the model's real size in storage. */
export function modelBytes(v: unknown, seen = new Set<object>()): number {
  if (v === null || typeof v !== "object" || seen.has(v)) return 0;
  seen.add(v);
  if (ArrayBuffer.isView(v)) return v.byteLength;
  let n = 0;
  for (const x of Array.isArray(v) ? v : Object.values(v)) n += modelBytes(x, seen);
  return n;
}

/** Keys to delete so what's left fits both limits, oldest first. Pure. */
export function pickEvictions(entries: { key: string; bytes: number; at: number }[], maxEntries = MAX_ENTRIES, maxBytes = MAX_BYTES): string[] {
  const byAge = [...entries].sort((a, b) => a.at - b.at);
  let count = byAge.length;
  let total = byAge.reduce((s, e) => s + e.bytes, 0);
  const out: string[] = [];
  for (const e of byAge) {
    if (count <= maxEntries && total <= maxBytes) break;
    out.push(e.key);
    count--;
    total -= e.bytes;
  }
  return out;
}

let dbPromise: Promise<IDBDatabase | null> | null = null;

function openDb(): Promise<IDBDatabase | null> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve) => {
    try {
      if (typeof indexedDB === "undefined") return resolve(null);
      const req = indexedDB.open(DB, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: "key" });
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
      req.onblocked = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
  return dbPromise;
}

function request<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

export async function getCachedModel(key: string): Promise<Model3D | null> {
  try {
    const db = await openDb();
    if (!db) return null;
    const store = db.transaction(STORE, "readwrite").objectStore(STORE);
    const hit = (await request(store.get(key))) as CacheEntry | undefined;
    if (!hit) return null;
    // Touch it, so pruning drops what nobody has looked at for longest.
    store.put({ ...hit, at: Date.now() });
    return hit.model;
  } catch {
    return null;
  }
}

export async function putCachedModel(key: string, model: Model3D): Promise<void> {
  try {
    const db = await openDb();
    if (!db) return;
    const bytes = modelBytes(model);
    if (bytes > MAX_BYTES / 2) return; // one huge model shouldn't flush everything else
    const store = db.transaction(STORE, "readwrite").objectStore(STORE);
    await request(store.put({ key, model, bytes, at: Date.now() } satisfies CacheEntry));
    const all = (await request(db.transaction(STORE, "readonly").objectStore(STORE).getAll())) as CacheEntry[];
    const evict = pickEvictions(all.map(({ key, bytes, at }) => ({ key, bytes, at })));
    if (evict.length) {
      const del = db.transaction(STORE, "readwrite").objectStore(STORE);
      for (const k of evict) del.delete(k);
    }
  } catch {
    // Quota or blocked storage: the preview simply re-parses next time.
  }
}
