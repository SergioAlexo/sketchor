/**
 * Draco (KHR_draco_mesh_compression) decoding for the shared 3D pipeline.
 *
 * The decoder is Google's Draco (Apache-2.0) as three.js already ships it —
 * no extra dependency. Core's `parseGltf` stays pure and takes the decode
 * function as an option; this module builds that function. Callers load it
 * only when `gltfUsesDraco(bytes)` says a file needs it, so nobody else pays
 * for the ~300 kB of wasm.
 *
 * The wrapper is an Emscripten "classic script" that declares a global
 * `DracoDecoderModule`; it is evaluated with `new Function` (three's own
 * DRACOLoader does the equivalent via a blob worker). Works on the main
 * thread and inside the app's parsing worker.
 */
import wrapperUrl from "three/examples/jsm/libs/draco/draco_wasm_wrapper.js?url";
import wasmUrl from "three/examples/jsm/libs/draco/draco_decoder.wasm?url";
import type { DracoDecode, DracoDecoded } from "../../../core/src/mesh/parse2";

/* Minimal typing of the Emscripten module surface we use (matches three's DRACOLoader). */
interface DracoAttribute { num_components(): number }
interface DracoMesh { ptr: number; num_faces(): number; num_points(): number }
interface DracoStatus { ok(): boolean; error_msg(): string }
interface DracoDecoderApi {
  GetEncodedGeometryType(array: Int8Array): number;
  DecodeArrayToMesh(array: Int8Array, byteLength: number, mesh: DracoMesh): DracoStatus;
  GetAttributeByUniqueId(mesh: DracoMesh, id: number): DracoAttribute & { ptr: number };
  GetTrianglesUInt32Array(mesh: DracoMesh, byteLength: number, ptr: number): boolean;
  GetAttributeDataArrayForAllPoints(mesh: DracoMesh, attr: DracoAttribute, dataType: number, byteLength: number, ptr: number): boolean;
}
interface DracoModule {
  Decoder: new () => DracoDecoderApi;
  Mesh: new () => DracoMesh;
  TRIANGULAR_MESH: number;
  DT_FLOAT32: number;
  HEAPF32: Float32Array;
  _malloc(bytes: number): number;
  _free(ptr: number): void;
  destroy(obj: unknown): void;
}
type ModuleFactory = (config: { wasmBinary: ArrayBuffer; onModuleLoaded: (m: DracoModule) => void }) => unknown;

/**
 * Builds a decoder from the wrapper's source text and the wasm bytes.
 * `process` and `require` are shadowed as undefined so the Emscripten wrapper
 * never takes its Node branch (bundlers sometimes polyfill `process`, and
 * tests run under Node); with `wasmBinary` supplied it needs no file access.
 */
export async function createDracoDecoder(wrapperSource: string, wasmBinary: ArrayBuffer): Promise<DracoDecode> {
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  const factory = new Function("process", "require", `${wrapperSource}\n;return DracoDecoderModule;`)(undefined, undefined) as ModuleFactory;
  // The module object is a thenable: wrap it so resolve() doesn't chase it.
  const { draco } = await new Promise<{ draco: DracoModule }>((resolve) => {
    factory({ wasmBinary, onModuleLoaded: (m) => resolve({ draco: m }) });
  });
  return (data, attributes) => decodeWith(draco, data, attributes);
}

function decodeWith(draco: DracoModule, data: Uint8Array, attributes: Record<string, number>): DracoDecoded {
  const array = new Int8Array(data.buffer, data.byteOffset, data.byteLength);
  const decoder = new draco.Decoder();
  const mesh = new draco.Mesh();
  try {
    if (decoder.GetEncodedGeometryType(array) !== draco.TRIANGULAR_MESH) throw new Error("not a Draco triangle mesh");
    const status = decoder.DecodeArrayToMesh(array, array.byteLength, mesh);
    if (!status.ok() || mesh.ptr === 0) throw new Error(status.error_msg() || "Draco decoding failed");

    const numIndices = mesh.num_faces() * 3;
    const ibytes = numIndices * 4;
    const iptr = draco._malloc(ibytes);
    let indices: Uint32Array;
    try {
      decoder.GetTrianglesUInt32Array(mesh, ibytes, iptr);
      indices = new Uint32Array(draco.HEAPF32.buffer, iptr, numIndices).slice();
    } finally {
      draco._free(iptr);
    }

    const out: DracoDecoded["attributes"] = {};
    const points = mesh.num_points();
    for (const [name, id] of Object.entries(attributes)) {
      const attr = decoder.GetAttributeByUniqueId(mesh, id);
      if (!attr || attr.ptr === 0) continue;
      const itemSize = attr.num_components();
      const n = points * itemSize;
      const bytes = n * 4;
      const ptr = draco._malloc(bytes);
      try {
        decoder.GetAttributeDataArrayForAllPoints(mesh, attr, draco.DT_FLOAT32, bytes, ptr);
        out[name] = { array: new Float32Array(draco.HEAPF32.buffer, ptr, n).slice(), itemSize };
      } finally {
        draco._free(ptr);
      }
    }
    return { indices, attributes: out };
  } finally {
    draco.destroy(mesh);
    draco.destroy(decoder);
  }
}

let shared: Promise<DracoDecode> | null = null;

/** The decoder, fetched and compiled once per page/worker. */
export function loadDracoDecoder(): Promise<DracoDecode> {
  if (!shared) {
    shared = (async () => {
      const [src, wasm] = await Promise.all([
        fetch(wrapperUrl).then((r) => {
          if (!r.ok) throw new Error(`Draco decoder script: HTTP ${r.status}`);
          return r.text();
        }),
        fetch(wasmUrl).then((r) => {
          if (!r.ok) throw new Error(`Draco decoder wasm: HTTP ${r.status}`);
          return r.arrayBuffer();
        }),
      ]);
      return createDracoDecoder(src, wasm);
    })();
    // A failed load (offline, blocked) may succeed on the next file.
    shared.catch(() => {
      shared = null;
    });
  }
  return shared;
}
