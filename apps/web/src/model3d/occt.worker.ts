import occtimportjs from "../../vendor/occt-import-js/occt-import-js.mjs";
import wasmUrl from "../../vendor/occt-import-js/occt-import-js.wasm?url";
import { parseAnyMesh, segmentMesh } from "@sketchor/core";
import { buildModel } from "./buildModel";
import { describeImportError } from "./importError";
import { getCachedModel, putCachedModel } from "./modelCache";
import { tessellationFor } from "./tessellation";
import { detectUpAxisFromBytes } from "./upAxis";
import { modelArrays } from "./types";
import type { Model3D, ModelFormat, OcctResult } from "./types";

/**
 * Import worker: OpenCascade (occt-import-js, LGPL — see NOTICE.md) reads a
 * STEP/IGES file and tessellates it; `buildModel` flattens the result; the
 * model is cached and handed back with its buffers *transferred*, not
 * copied. The wasm is Sketchor's own build of occt-import-js
 * (apps/web/vendor, built by native/occt-import-js-build): the upstream
 * package resolves every face's colour with a linear scan of the whole
 * assembly, which made a 3,000-part file take 90 s to read; the patched
 * build indexes the labels once and reads the same file in 4 s.
 *
 * One worker holds one wasm instance; the pool in stepImport.ts
 * decides how many run at once.
 *
 * Everything slow lives here on purpose. A 10 MB assembly still takes
 * seconds to read, and the UI keeps drawing throughout.
 */

export interface ParseRequest {
  id: number;
  name: string;
  hash: string;
  format: ModelFormat;
  buffer: ArrayBuffer;
}

export type ParseResponse =
  | { id: number; phase: "reading" | "cached" }
  | { id: number; ok: true; model: Model3D; fromCache: boolean; ms: number }
  | { id: number; ok: false; error: string };

interface OcctModule {
  ReadStepFile(content: Uint8Array, params: Record<string, unknown> | null): OcctResult;
  ReadIgesFile(content: Uint8Array, params: Record<string, unknown> | null): OcctResult;
}

/** A file's bytes, once OCCT has copied them into the wasm heap, become dead weight for the rest of `handle()` — see the `finally` below. */
const EMPTY_BUFFER = new ArrayBuffer(0);

let occtPromise: Promise<OcctModule> | null = null;

function occt(): Promise<OcctModule> {
  if (!occtPromise) {
    const resolved = new URL(wasmUrl, self.location.href).href;
    occtPromise = occtimportjs({ locateFile: () => resolved }) as Promise<OcctModule>;
  }
  return occtPromise;
}

function post(msg: ParseResponse, transfer?: Transferable[]): void {
  (self as unknown as Worker).postMessage(msg, transfer ?? []);
}

function transferables(m: Model3D): Transferable[] {
  // Every buffer, geometry and topology alike — a big assembly's face and
  // edge tables are worth transferring rather than copying.
  return [...new Set(modelArrays(m).map((a) => a.buffer))] as Transferable[];
}

async function handle(req: ParseRequest): Promise<void> {
  const t0 = performance.now();
  const cached = await getCachedModel(req.hash);
  if (cached) {
    post({ id: req.id, phase: "cached" });
    // Cached models come from the file as it was; the name may differ if
    // it was renamed since — the tab should say what the user opened.
    cached.name = req.name;
    post({ id: req.id, ok: true, model: cached, fromCache: true, ms: performance.now() - t0 }, transferables(cached));
    return;
  }

  post({ id: req.id, phase: "reading" });
  if (req.format !== "step" && req.format !== "iges") {
    await handleMesh(req, t0);
    return;
  }
  const lib = await occt();
  const byteLength = req.buffer.byteLength;
  const params = tessellationFor(byteLength);
  // The header has to be read before the buffer is dropped below.
  const detectedUp = req.format === "step" ? detectUpAxisFromBytes(req.buffer) : "z";
  let bytes: Uint8Array | null = new Uint8Array(req.buffer);
  let result: OcctResult;
  try {
    result = req.format === "iges" ? lib.ReadIgesFile(bytes, params) : lib.ReadStepFile(bytes, params);
  } catch (err) {
    const raw = (err as Error)?.message ?? String(err);
    post({ id: req.id, ok: false, error: describeImportError(raw, req.name, byteLength) });
    return;
  } finally {
    // OCCT has copied the bytes into the wasm heap by now; buildModel below
    // allocates its own (often larger) merged arrays, so the JS-side input
    // copy is dead weight while that happens on a big file. Drop every
    // reference to it, including `req.buffer` itself (the same backing
    // store `bytes` is a view over) — `req` otherwise stays reachable for
    // the rest of this function.
    bytes = null;
    req.buffer = EMPTY_BUFFER;
  }
  if (!result?.success) {
    post({ id: req.id, ok: false, error: "not a readable STEP/IGES file (unsupported schema or corrupt data)" });
    return;
  }
  const model = buildModel(result, req.name, req.hash, req.format);
  if (model.parts.length === 0) {
    post({ id: req.id, ok: false, error: "the file contains no solid or surface geometry to show" });
    return;
  }
  model.detectedUp = detectedUp;
  // Cache before transferring: the put needs the buffers still attached. A
  // model that parsed fine is still worth showing if the cache refuses it
  // (quota, a structured-clone failure on a huge one) — it just isn't kept.
  try {
    await putCachedModel(model);
  } catch (err) {
    console.warn("model cache write failed; showing the model uncached", err);
  }
  post({ id: req.id, ok: true, model, fromCache: false, ms: performance.now() - t0 }, transferables(model));
}

/** F-05: STL/OBJ/PLY/3MF/glTF — parse in JS, split into faces by dihedral angle (core/mesh), then the same buildModel/topology path as STEP. */
async function handleMesh(req: ParseRequest, t0: number): Promise<void> {
  const byteLength = req.buffer.byteLength;
  let parsed;
  try {
    parsed = await parseAnyMesh(req.format as Exclude<ModelFormat, "step" | "iges">, new Uint8Array(req.buffer), req.name.replace(/\.[^.]*$/, "") || "Part");
  } catch (err) {
    post({ id: req.id, ok: false, error: describeImportError((err as Error)?.message ?? String(err), req.name, byteLength) });
    return;
  } finally {
    req.buffer = EMPTY_BUFFER;
  }
  const meshes = parsed.parts.map((p) => segmentMesh(p));
  const result: OcctResult = {
    success: true,
    meshes,
    root: parsed.parts.length > 1 ? { name: req.name, children: meshes.map((m, i) => ({ name: m.name, meshes: [i] })) } : { name: req.name, meshes: [0] },
  };
  const model = buildModel(result, req.name, req.hash, req.format);
  if (model.parts.length === 0) {
    post({ id: req.id, ok: false, error: "the file contains no triangles to show" });
    return;
  }
  model.detectedUp = req.format === "gltf" || req.format === "glb" ? "y" : "z"; // glTF is Y-up by spec
  try {
    await putCachedModel(model);
  } catch (err) {
    console.warn("model cache write failed; showing the model uncached", err);
  }
  post({ id: req.id, ok: true, model, fromCache: false, ms: performance.now() - t0 }, transferables(model));
}

self.onmessage = (ev: MessageEvent<ParseRequest>) => {
  // Captured before handle() runs: it clears req.buffer partway through to
  // free the input bytes early (see the finally block above), so reading
  // it again here after a later failure (e.g. inside buildModel) would see
  // an empty buffer instead of the file's real size.
  const byteLength = ev.data.buffer.byteLength;
  void handle(ev.data).catch((err) => {
    const raw = (err as Error)?.message ?? String(err);
    post({ id: ev.data.id, ok: false, error: describeImportError(raw, ev.data.name, byteLength) });
  });
};
