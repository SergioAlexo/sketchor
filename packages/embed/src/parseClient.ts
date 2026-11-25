/**
 * E-03: parse off the main thread, so a large STL doesn't freeze the host
 * page's scrolling while it is segmented. One worker per page, shared by
 * every `<sketchor-view>`. Anything that stops the worker from starting or
 * answering (no module workers, a CSP that forbids blob: workers, the chunk
 * failing to import) falls back to parsing on the main thread — slower to
 * look at, never a broken preview.
 */
import type { DrawingFormat, PreviewFormat } from "./load";
import type { Drawing2D } from "./parse2d";
import type { Model3D } from "./three/types";
import type { UpAxis } from "./three/upAxis";

type Pending = { resolve(v: Model3D | Drawing2D): void; reject(e: Error): void; fallback(): void };

let worker: Promise<Worker | null> | null = null;
let nextId = 1;
const pending = new Map<number, Pending>();

/** Test hook / opt-out: forces main-thread parsing. */
export let workerDisabled = typeof Worker === "undefined";
export function disableParseWorker(): void {
  workerDisabled = true;
}

function failAll(): void {
  for (const p of pending.values()) p.fallback();
  pending.clear();
  worker = Promise.resolve(null);
}

function startWorker(): Promise<Worker | null> {
  return (async () => {
    try {
      const { WORKER_MODULE_URL } = await import("./parseWorker");
      const src = `import { startParseWorker } from ${JSON.stringify(WORKER_MODULE_URL)};\nstartParseWorker();\n`;
      const url = URL.createObjectURL(new Blob([src], { type: "text/javascript" }));
      const w = new Worker(url, { type: "module", name: "sketchor-embed-parse" });
      // Wait for the module to import and say so; a failed import only ever shows up as an error event.
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("parse worker did not start")), 10_000);
        w.addEventListener("error", (e) => {
          clearTimeout(timer);
          reject(new Error(e.message || "parse worker failed"));
        }, { once: true });
        w.addEventListener("message", (e) => {
          if (e.data?.ready) {
            clearTimeout(timer);
            resolve();
          }
        }, { once: true });
      });
      URL.revokeObjectURL(url);
      w.addEventListener("message", (e: MessageEvent<{ id?: number; model?: Model3D; drawing?: Drawing2D; error?: string }>) => {
        const p = e.data.id !== undefined ? pending.get(e.data.id) : undefined;
        if (!p) return;
        pending.delete(e.data.id!);
        const v = e.data.model ?? e.data.drawing;
        if (v) p.resolve(v);
        else p.reject(new Error(e.data.error ?? "parse failed"));
      });
      w.addEventListener("error", failAll);
      return w;
    } catch {
      return null;
    }
  })();
}

async function parseHere(bytes: Uint8Array, name: string, format: PreviewFormat, up: UpAxis | "auto"): Promise<Model3D> {
  const { parseModel } = await import("./parse");
  return parseModel(bytes, name, format, up);
}

export async function parseOffThread(bytes: Uint8Array, name: string, format: PreviewFormat, up: UpAxis | "auto"): Promise<Model3D> {
  if (workerDisabled) return parseHere(bytes, name, format, up);
  worker ??= startWorker();
  const w = await worker;
  if (!w) return parseHere(bytes, name, format, up);
  // A copy is transferred, never the caller's buffer (load(Uint8Array) must not detach the page's data).
  const copy = bytes.slice();
  return new Promise<Model3D>((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve: (v) => resolve(v as Model3D), reject, fallback: () => parseHere(bytes, name, format, up).then(resolve, reject) });
    w.postMessage({ id, kind: "mesh", bytes: copy, name, format, up }, [copy.buffer]);
  });
}

async function parseDrawingHere(bytes: Uint8Array, name: string, format: DrawingFormat): Promise<Drawing2D> {
  const { parseDrawing } = await import("./parse2d");
  return parseDrawing(bytes, name, format);
}

/** E-01: a 2D drawing, parsed in the worker — except SVG, whose importer needs the main thread's DOMParser. */
export async function parseDrawingOffThread(bytes: Uint8Array, name: string, format: DrawingFormat): Promise<Drawing2D> {
  if (workerDisabled || format === "svg") return parseDrawingHere(bytes, name, format);
  worker ??= startWorker();
  const w = await worker;
  if (!w) return parseDrawingHere(bytes, name, format);
  const copy = bytes.slice();
  return new Promise<Drawing2D>((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve: (v) => resolve(v as Drawing2D), reject, fallback: () => parseDrawingHere(bytes, name, format).then(resolve, reject) });
    w.postMessage({ id, kind: "drawing", bytes: copy, name, format }, [copy.buffer]);
  });
}
