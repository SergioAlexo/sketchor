import { create } from "zustand";
import { describeImportError } from "./importError";
import { COARSE_THRESHOLD_BYTES } from "./tessellation";
import type { ParseRequest, ParseResponse } from "./occt.worker";
import type { Model3D, ModelFormat } from "./types";

/**
 * Main-thread side of 3D model import: a small pool of OpenCascade workers
 * (occt.worker.ts), request de-duplication, and a priority queue so that
 * opening a file always jumps ahead of the file browser's thumbnails.
 *
 * Why a pool rather than one worker: reading a STEP file is single-threaded
 * inside wasm and can take a long time, so a folder of previews would
 * otherwise serialise behind one slow assembly — and an *open* would queue
 * behind the previews. With a few workers the previews fill in in parallel
 * and an open gets a worker as soon as one frees up. Idle workers are
 * retired after a while because each one keeps a wasm heap alive.
 *
 * Results are cached persistently (modelCache.ts, inside the worker), so
 * only the first look at a given file ever pays for the parse.
 */

const MAX_WORKERS = Math.max(1, Math.min(3, (navigator.hardwareConcurrency ?? 2) - 1));
const IDLE_RETIRE_MS = 90_000;

export type LoadPriority = "open" | "thumbnail";

/** File kinds the 3D pipeline reads. */
export function modelFormatOf(name: string): ModelFormat | null {
  if (/\.(step|stp)$/i.test(name)) return "step";
  if (/\.(iges|igs)$/i.test(name)) return "iges";
  if (/\.stl$/i.test(name)) return "stl";
  if (/\.obj$/i.test(name)) return "obj";
  if (/\.ply$/i.test(name)) return "ply";
  if (/\.3mf$/i.test(name)) return "3mf";
  if (/\.gltf$/i.test(name)) return "gltf";
  if (/\.glb$/i.test(name)) return "glb";
  return null;
}

export function isModelFile(name: string): boolean {
  return modelFormatOf(name) !== null;
}

/** SHA-256 of the file bytes, hex — the cache key. ~30 ms for 10 MB. */
export async function hashBytes(buffer: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", buffer);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

/* ---------------------------- progress state ---------------------------- */

export interface ModelLoad {
  id: number;
  name: string;
  priority: LoadPriority;
  phase: "queued" | "hashing" | "reading" | "cached";
  startedAt: number;
  bytes: number;
}

interface LoadState {
  /** Loads in flight, for the progress UI. Only "open" loads are shown; thumbnails stay quiet. */
  loads: ModelLoad[];
  set: (id: number, patch: Partial<ModelLoad>) => void;
  add: (load: ModelLoad) => void;
  remove: (id: number) => void;
}

export const useModelLoads = create<LoadState>((set) => ({
  loads: [],
  set: (id, patch) => set((s) => ({ loads: s.loads.map((l) => (l.id === id ? { ...l, ...patch } : l)) })),
  add: (load) => set((s) => ({ loads: [...s.loads, load] })),
  remove: (id) => set((s) => ({ loads: s.loads.filter((l) => l.id !== id) })),
}));

/* -------------------------------- the pool ------------------------------ */

interface Job {
  id: number;
  name: string;
  hash: string;
  format: ModelFormat;
  buffer: ArrayBuffer;
  /** Captured before `buffer` is transferred to a worker and its byteLength goes to 0. */
  bytes: number;
  priority: LoadPriority;
  resolve: (m: Model3D) => void;
  reject: (e: Error) => void;
  cancelled: boolean;
}

interface Slot {
  worker: Worker;
  job: Job | null;
  idleTimer: ReturnType<typeof setTimeout> | null;
}

const slots: Slot[] = [];
const queue: Job[] = [];
/** hash -> the promise every caller for that file shares. */
const inflight = new Map<string, Promise<Model3D>>();
let nextId = 1;

function spawn(): Slot {
  const worker = new Worker(new URL("./occt.worker.ts", import.meta.url), { type: "module" });
  const slot: Slot = { worker, job: null, idleTimer: null };
  worker.onmessage = (ev: MessageEvent<ParseResponse>) => onMessage(slot, ev.data);
  worker.onerror = (ev) => {
    const job = slot.job;
    slot.job = null;
    retire(slot);
    if (job) {
      const raw = ev.message || "import worker crashed";
      job.reject(new Error(describeImportError(raw, job.name, job.bytes)));
    }
    pump();
  };
  slots.push(slot);
  return slot;
}

function retire(slot: Slot): void {
  const i = slots.indexOf(slot);
  if (i >= 0) slots.splice(i, 1);
  if (slot.idleTimer) clearTimeout(slot.idleTimer);
  slot.worker.terminate();
}

function onMessage(slot: Slot, msg: ParseResponse): void {
  const job = slot.job;
  if (!job || job.id !== msg.id) return;
  if ("phase" in msg) {
    useModelLoads.getState().set(job.id, { phase: msg.phase });
    return;
  }
  slot.job = null;
  useModelLoads.getState().remove(job.id);
  inflight.delete(job.hash);
  if (msg.ok) job.resolve(msg.model);
  else job.reject(new Error(msg.error));
  // Keep the worker warm briefly — the next thumbnail in a folder is
  // seconds away — then let it go so its wasm heap is returned.
  slot.idleTimer = setTimeout(() => {
    if (!slot.job) retire(slot);
  }, IDLE_RETIRE_MS);
  pump();
}

/** Thumbnails of files this big aren't parsed at all: a wasm heap can reach 4 GB per file, and the card can live without a picture. */
export const THUMBNAIL_MAX_BYTES = COARSE_THRESHOLD_BYTES;

/** True while a big *open* is being read — the one job worth all the memory. */
function bigOpenRunning(): boolean {
  return slots.some((s) => s.job?.priority === "open" && s.job.bytes > THUMBNAIL_MAX_BYTES);
}

function pump(): void {
  while (queue.length > 0) {
    // While a huge file is opening, other workers' wasm heaps would compete
    // with it for memory: let only further opens through, thumbnails wait.
    if (bigOpenRunning() && queue[0].priority !== "open") return;
    const free = slots.find((s) => !s.job) ?? (slots.length < MAX_WORKERS ? spawn() : null);
    if (!free) return;
    const job = queue.shift()!;
    if (job.cancelled) {
      inflight.delete(job.hash);
      job.reject(new Error("cancelled"));
      continue;
    }
    if (free.idleTimer) {
      clearTimeout(free.idleTimer);
      free.idleTimer = null;
    }
    free.job = job;
    const req: ParseRequest = { id: job.id, name: job.name, hash: job.hash, format: job.format, buffer: job.buffer };
    free.worker.postMessage(req, [job.buffer]);
  }
}

/**
 * Loads a model from raw file bytes, from the cache when it has been seen
 * before and by parsing otherwise. Concurrent requests for the same content
 * share one parse. `buffer` is transferred to the worker and must not be
 * reused by the caller. Pass `knownHash` when the caller already hashed the
 * bytes (the thumbnail path does, for its own cache lookup).
 */
export function loadModel(
  name: string,
  buffer: ArrayBuffer,
  priority: LoadPriority = "open",
  knownHash?: string,
): Promise<Model3D> {
  const format = modelFormatOf(name);
  if (!format) return Promise.reject(new Error(`${name} is not a supported 3D model file`));
  const id = nextId++;
  const bytes = buffer.byteLength;
  const loads = useModelLoads.getState();
  loads.add({ id, name, priority, phase: "hashing", startedAt: Date.now(), bytes });

  return (knownHash ? Promise.resolve(knownHash) : hashBytes(buffer)).then((hash) => {
    const existing = inflight.get(hash);
    if (existing) {
      // Same file already being parsed (typically its thumbnail): ride along,
      // but keep this load visible so an open still shows progress.
      loads.set(id, { phase: "reading" });
      const clear = () => loads.remove(id);
      existing.then(clear, clear);
      return existing;
    }
    const promise = new Promise<Model3D>((resolve, reject) => {
      const job: Job = { id, name, hash, format, buffer, bytes, priority, resolve, reject, cancelled: false };
      loads.set(id, { phase: "queued" });
      // Opens go to the front of the line, behind any other open already waiting.
      if (priority === "open") {
        const idx = queue.findIndex((j) => j.priority !== "open");
        queue.splice(idx === -1 ? queue.length : idx, 0, job);
      } else {
        queue.push(job);
      }
      pump();
    });
    inflight.set(hash, promise);
    return promise;
  });
}

/** True while any "open" load is in progress (drives the stage overlay). */
export function useOpenLoads(): ModelLoad[] {
  return useModelLoads((s) => s.loads).filter((l) => l.priority === "open");
}
