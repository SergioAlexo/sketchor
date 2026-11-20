/**
 * Bytes → `Model3D`, the app's own mesh path (F-05): core `parseAnyMesh` →
 * `segmentMesh` → `buildModel`, so faces, B-rep-style edges and colours come
 * out exactly as in a Sketchor model tab. No three.js here, so it runs in the
 * parse worker (parseWorker.ts) as well as on the main thread.
 */
import { gltfUsesDraco, parseAnyMesh } from "../../core/src/mesh/parse2";
import { segmentMesh } from "../../core/src/mesh/segment";
import { buildModel } from "./three/buildModel";
import type { Model3D, OcctResult } from "./three/types";
import { reorientModel, type UpAxis } from "./three/upAxis";
import type { PreviewFormat } from "./load";

export async function parseModel(bytes: Uint8Array, name: string, format: PreviewFormat, up: UpAxis | "auto"): Promise<Model3D> {
  // Draco-compressed glTF: fetch the decoder (its own lazy chunk) only for files that need it.
  const draco = (format === "glb" || format === "gltf") && gltfUsesDraco(bytes) ? await (await import("./three/draco")).loadDracoDecoder() : undefined;
  const parsed = await parseAnyMesh(format, bytes, name.replace(/\.[^.]*$/, "") || "Part", { draco });
  const meshes = parsed.parts.map((p) => segmentMesh(p));
  const result: OcctResult = {
    success: true,
    meshes,
    root: meshes.length > 1 ? { name, children: meshes.map((m, i) => ({ name: m.name, meshes: [i] })) } : { name, meshes: [0] },
  };
  const model = buildModel(result, name, "embed", format);
  if (model.parts.length === 0) throw new Error("the file contains no triangles to show");
  const detected: UpAxis = format === "gltf" || format === "glb" ? "y" : "z";
  return reorientModel(model, up === "auto" ? detected : up);
}

/** Every distinct ArrayBuffer behind the typed arrays in `v`, for a zero-copy postMessage. */
export function transferablesOf(v: unknown, out = new Set<ArrayBuffer>(), seen = new Set<object>()): ArrayBuffer[] {
  if (v !== null && typeof v === "object" && !seen.has(v)) {
    seen.add(v);
    if (ArrayBuffer.isView(v)) {
      if (v.buffer instanceof ArrayBuffer) out.add(v.buffer);
    } else for (const x of Array.isArray(v) ? v : Object.values(v)) transferablesOf(x, out, seen);
  }
  return [...out];
}
