import { modelByteSize, type Model3D } from "./types";

/**
 * Persistent cache of tessellated models and their thumbnails, in IndexedDB.
 *
 * Reading a STEP file is the slow part of 3D viewing — OpenCascade in wasm
 * takes tens of seconds on a large assembly, and it isn't something we can
 * make incremental. What we *can* do is never pay it twice: models are
 * keyed by a SHA-256 of the file bytes, so reopening a file, browsing a
 * folder you've seen before, or the same file under a new name all hit the
 * cache. Thumbnails are cached separately (a few KB of PNG each) so a folder
 * of previews comes back instantly without even loading the meshes.
 *
 * Used from both the main thread and the import worker (IndexedDB is
 * available in workers), so nothing here touches the DOM.
 *
 * Budgeted: models past {@link MODEL_BUDGET_BYTES} are evicted oldest-first.
 * Every access refreshes `savedAt`, so it behaves as an LRU. Thumbnails are
 * small enough that they're never evicted.
 */

const DB_NAME = "sketchor-models";
const DB_VERSION = 2;
/**
 * Bump when `Model3D`'s shape or the tessellation/edge extraction changes:
 * it's part of every key, so stale entries simply stop matching and age out.
 */
const LAYOUT_VERSION = 7; // 7: mesh formats (F-05); 6: wasm fix for sub-assemblies that tessellated to nothing (cached parses lost parts)
const keyOf = (hash: string) => `${LAYOUT_VERSION}:${hash}`;
const MODELS = "models";
/** Per-model size + last-use time, kept apart from the (large) model rows so eviction never has to load them. */
const META = "meta";
const THUMBS = "thumbs";
const MODEL_BUDGET_BYTES = 768 * 1024 * 1024;

interface ModelRecord {
  /** `keyOf(model.hash)` — versioned, see LAYOUT_VERSION. */
  hash: string;
  model: Model3D;
}

interface MetaRecord {
  hash: string;
  savedAt: number;
  bytes: number;
}

interface ThumbRecord {
  hash: string;
  dataUrl: string;
}

let dbPromise: Promise<IDBDatabase | null> | null = null;

function openDb(): Promise<IDBDatabase | null> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve) => {
    let req: IDBOpenDBRequest;
    try {
      req = indexedDB.open(DB_NAME, DB_VERSION);
    } catch {
      resolve(null);
      return;
    }
    req.onupgradeneeded = () => {
      const db = req.result;
      // Layout changes are handled by LAYOUT_VERSION in the keys; a schema
      // change here just starts the stores over.
      for (const name of Array.from(db.objectStoreNames)) db.deleteObjectStore(name);
      db.createObjectStore(MODELS, { keyPath: "hash" });
      db.createObjectStore(META, { keyPath: "hash" }).createIndex("savedAt", "savedAt");
      db.createObjectStore(THUMBS, { keyPath: "hash" });
    };
    req.onsuccess = () => resolve(req.result);
    // Private mode, quota, or a browser without IndexedDB: the cache is
    // simply absent and everything parses on demand.
    req.onerror = () => resolve(null);
    req.onblocked = () => resolve(null);
  });
  return dbPromise;
}

function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function done(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

export async function getCachedModel(hash: string): Promise<Model3D | null> {
  const db = await openDb();
  if (!db) return null;
  try {
    const tx = db.transaction([MODELS, META], "readwrite");
    const key = keyOf(hash);
    const rec = (await request(tx.objectStore(MODELS).get(key))) as ModelRecord | undefined;
    if (rec) {
      const meta = tx.objectStore(META);
      const m = (await request(meta.get(key))) as MetaRecord | undefined;
      meta.put({ hash: key, bytes: m?.bytes ?? modelByteSize(rec.model), savedAt: Date.now() } satisfies MetaRecord);
    }
    await done(tx);
    return rec?.model ?? null;
  } catch {
    return null;
  }
}

export async function putCachedModel(model: Model3D): Promise<void> {
  const db = await openDb();
  if (!db) return;
  const bytes = modelByteSize(model);
  // A model bigger than the whole budget would evict everything else for
  // nothing — it stays uncached.
  if (bytes > MODEL_BUDGET_BYTES / 2) return;
  try {
    const tx = db.transaction([MODELS, META], "readwrite");
    const key = keyOf(model.hash);
    tx.objectStore(MODELS).put({ hash: key, model } satisfies ModelRecord);
    tx.objectStore(META).put({ hash: key, savedAt: Date.now(), bytes } satisfies MetaRecord);
    await done(tx);
    await evictModels();
  } catch {
    // Quota exceeded or a broken store: not fatal, the model is still in memory.
  }
}

async function evictModels(): Promise<void> {
  const db = await openDb();
  if (!db) return;
  const tx = db.transaction([MODELS, META], "readwrite");
  const meta = tx.objectStore(META);
  // Newest first through the meta index; once the running total passes the
  // budget, everything older goes.
  const entries: MetaRecord[] = [];
  await new Promise<void>((resolve, reject) => {
    const cursor = meta.index("savedAt").openCursor(null, "prev");
    cursor.onsuccess = () => {
      const c = cursor.result;
      if (!c) {
        resolve();
        return;
      }
      entries.push(c.value as MetaRecord);
      c.continue();
    };
    cursor.onerror = () => reject(cursor.error);
  });
  let total = 0;
  for (const e of entries) {
    total += e.bytes;
    if (total > MODEL_BUDGET_BYTES) {
      tx.objectStore(MODELS).delete(e.hash);
      meta.delete(e.hash);
    }
  }
  await done(tx);
}

export async function getCachedThumb(hash: string): Promise<string | null> {
  const db = await openDb();
  if (!db) return null;
  try {
    const tx = db.transaction(THUMBS, "readonly");
    const rec = (await request(tx.objectStore(THUMBS).get(keyOf(hash)))) as ThumbRecord | undefined;
    return rec?.dataUrl ?? null;
  } catch {
    return null;
  }
}

export async function putCachedThumb(hash: string, dataUrl: string): Promise<void> {
  const db = await openDb();
  if (!db) return;
  try {
    const tx = db.transaction(THUMBS, "readwrite");
    tx.objectStore(THUMBS).put({ hash: keyOf(hash), dataUrl } satisfies ThumbRecord);
    await done(tx);
  } catch {
    // best-effort
  }
}

/** Drops every cached model and thumbnail (a "clear cache" affordance, and test cleanup). */
export async function clearModelCache(): Promise<void> {
  const db = await openDb();
  if (!db) return;
  try {
    const tx = db.transaction([MODELS, META, THUMBS], "readwrite");
    tx.objectStore(MODELS).clear();
    tx.objectStore(META).clear();
    tx.objectStore(THUMBS).clear();
    await done(tx);
  } catch {
    // best-effort
  }
}
