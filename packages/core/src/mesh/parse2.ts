/**
 * F-05 — glTF/GLB and 3MF readers (the container formats). Same contract as
 * parse.ts: bytes in, `MeshPart[]` out (millimetres), hostile input degrades
 * to a warning or a plain `Error`. 3MF needs a ZIP reader (stored + deflate via
 * the platform's `DecompressionStream`), so these readers are async.
 */
import type { MeshParseResult, MeshPart } from "./parse";
import { meshFormatOf, parseMesh } from "./parse";

export type ContainerFormat = "3mf" | "gltf" | "glb";
export type AnyMeshFormat = ReturnType<typeof meshFormatOf> | ContainerFormat;

/** Extension -> mesh format, including the container formats. */
export function anyMeshFormatOf(name: string): AnyMeshFormat {
  const e = name.split(/[\\/]/).pop()!.split(".").slice(1).pop()?.toLowerCase();
  return e === "3mf" || e === "gltf" || e === "glb" ? e : meshFormatOf(name);
}

/**
 * One decoded KHR_draco_mesh_compression primitive: triangle indices plus the
 * attributes it was asked for, as float arrays (the decoder dequantizes).
 */
export interface DracoDecoded {
  indices: Uint32Array;
  attributes: Record<string, { array: Float32Array; itemSize: number }>;
}

/**
 * Decodes one Draco buffer. `attributes` maps glTF attribute names
 * (`POSITION`, `COLOR_0`, …) to Draco unique ids, as the extension lists them.
 * Injected so this module stays pure: the wasm decoder lives with the
 * renderer (`@sketchor/embed/three/draco`) and is only loaded for files that
 * need it. May throw; the reader turns that into a warning.
 */
export type DracoDecode = (data: Uint8Array, attributes: Record<string, number>) => DracoDecoded;

export interface MeshParseOptions {
  draco?: DracoDecode;
}

export async function parseAnyMesh(format: NonNullable<AnyMeshFormat>, bytes: Uint8Array, name = "Part", opts: MeshParseOptions = {}): Promise<MeshParseResult> {
  if (format === "3mf") return nonEmpty(await parse3mf(bytes, name));
  if (format === "gltf" || format === "glb") return nonEmpty(parseGltf(bytes, name, opts));
  return parseMesh(format, bytes, name);
}

/**
 * Whether a glTF/GLB uses Draco compression — cheap (reads only the JSON
 * chunk), so callers can fetch the decoder only for files that need it.
 */
export function gltfUsesDraco(bytes: Uint8Array): boolean {
  const text = gltfJsonText(bytes);
  if (text === null) return false;
  try {
    const j = JSON.parse(text) as { extensionsUsed?: string[]; extensionsRequired?: string[] };
    return [...(j.extensionsUsed ?? []), ...(j.extensionsRequired ?? [])].includes("KHR_draco_mesh_compression");
  } catch {
    return false;
  }
}

/** The JSON document of a .gltf, or a GLB's JSON chunk; null if neither. */
function gltfJsonText(bytes: Uint8Array): string | null {
  if (bytes.length >= 20) {
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (dv.getUint32(0, true) === 0x46546c67) {
      const len = dv.getUint32(12, true);
      if (dv.getUint32(16, true) !== 0x4e4f534a || 20 + len > bytes.length) return null;
      return new TextDecoder().decode(bytes.subarray(20, 20 + len));
    }
  }
  const head = new TextDecoder().decode(bytes.subarray(0, Math.min(bytes.length, 64))).trimStart();
  return head.startsWith("{") ? new TextDecoder().decode(bytes) : null;
}

function nonEmpty(r: MeshParseResult): MeshParseResult {
  r.parts = r.parts.filter((p) => p.indices.length >= 3);
  if (!r.parts.length) throw new Error("the file contains no triangles to show");
  return r;
}

type M = number[]; // 4x4 column-major (glTF) or the 3MF affine, normalised to this

const I4 = (): M => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
function mul(a: M, b: M): M {
  const o = new Array<number>(16).fill(0);
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) for (let k = 0; k < 4; k++) o[c * 4 + r] += a[k * 4 + r] * b[c * 4 + k];
  return o;
}
function applyM(m: M, p: Float32Array): Float32Array {
  const o = new Float32Array(p.length);
  for (let i = 0; i + 2 < p.length; i += 3) {
    const x = p[i], y = p[i + 1], z = p[i + 2];
    o[i] = m[0] * x + m[4] * y + m[8] * z + m[12];
    o[i + 1] = m[1] * x + m[5] * y + m[9] * z + m[13];
    o[i + 2] = m[2] * x + m[6] * y + m[10] * z + m[14];
  }
  return o;
}
function scaleM(s: number): M {
  const m = I4();
  m[0] = m[5] = m[10] = s;
  return m;
}

/* ------------------------------- glTF / GLB ------------------------------- */

interface GAccessor { bufferView?: number; byteOffset?: number; componentType: number; count: number; type: string; normalized?: boolean }
interface GView { buffer: number; byteOffset?: number; byteLength: number; byteStride?: number }
interface GNode { mesh?: number; children?: number[]; matrix?: number[]; translation?: number[]; rotation?: number[]; scale?: number[]; name?: string }
interface GLTF {
  extensionsRequired?: string[];
  buffers?: { uri?: string; byteLength: number }[];
  bufferViews?: GView[];
  accessors?: GAccessor[];
  meshes?: {
    name?: string;
    primitives: {
      attributes: Record<string, number>;
      indices?: number;
      mode?: number;
      material?: number;
      extensions?: { KHR_draco_mesh_compression?: { bufferView: number; attributes?: Record<string, number> } };
    }[];
  }[];
  materials?: { pbrMetallicRoughness?: { baseColorFactor?: number[] } }[];
  nodes?: GNode[];
  scenes?: { nodes?: number[] }[];
  scene?: number;
}

const COMP: Record<number, [size: number, get: (v: DataView, o: number) => number]> = {
  5120: [1, (v, o) => v.getInt8(o)],
  5121: [1, (v, o) => v.getUint8(o)],
  5122: [2, (v, o) => v.getInt16(o, true)],
  5123: [2, (v, o) => v.getUint16(o, true)],
  5125: [4, (v, o) => v.getUint32(o, true)],
  5126: [4, (v, o) => v.getFloat32(o, true)],
};
const NCOMP: Record<string, number> = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 };

function b64(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function nodeMatrix(n: GNode): M {
  if (n.matrix && n.matrix.length === 16) return n.matrix.slice();
  const [tx, ty, tz] = n.translation ?? [0, 0, 0];
  const [qx, qy, qz, qw] = n.rotation ?? [0, 0, 0, 1];
  const [sx, sy, sz] = n.scale ?? [1, 1, 1];
  const x2 = qx + qx, y2 = qy + qy, z2 = qz + qz;
  const xx = qx * x2, xy = qx * y2, xz = qx * z2, yy = qy * y2, yz = qy * z2, zz = qz * z2, wx = qw * x2, wy = qw * y2, wz = qw * z2;
  return [
    (1 - (yy + zz)) * sx, (xy + wz) * sx, (xz - wy) * sx, 0,
    (xy - wz) * sy, (1 - (xx + zz)) * sy, (yz + wx) * sy, 0,
    (xz + wy) * sz, (yz - wx) * sz, (1 - (xx + yy)) * sz, 0,
    tx, ty, tz, 1,
  ];
}

export function parseGltf(bytes: Uint8Array, name = "Part", opts: MeshParseOptions = {}): MeshParseResult {
  const warnings: string[] = [];
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let json: GLTF;
  let glbBin: Uint8Array | null = null;
  try {
    if (bytes.length >= 12 && dv.getUint32(0, true) === 0x46546c67) {
      let o = 12;
      let text = "";
      while (o + 8 <= bytes.length) {
        const len = dv.getUint32(o, true), type = dv.getUint32(o + 4, true);
        const body = bytes.subarray(o + 8, Math.min(bytes.length, o + 8 + len));
        if (type === 0x4e4f534a) text = new TextDecoder().decode(body);
        else if (type === 0x004e4942 && !glbBin) glbBin = body;
        o += 8 + len + ((4 - (len % 4)) % 4);
      }
      json = JSON.parse(text);
    } else json = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new Error("not a readable glTF/GLB file");
  }
  // Compressed geometry sits in an extension this reader doesn't decode; without
  // this check the file reads as "no triangles", which sends the user hunting
  // for a problem with the model instead of the export setting.
  const required = json.extensionsRequired ?? [];
  if (required.includes("KHR_draco_mesh_compression") && !opts.draco) throw new Error("this glTF uses Draco mesh compression, and no Draco decoder is available here");
  const meshopt = required.find((e) => /meshopt_compression$/.test(e));
  if (meshopt) throw new Error(`this glTF uses meshopt compression (${meshopt}), which isn't supported yet — export it without compression`);
  const buffers: (Uint8Array | null)[] = (json.buffers ?? []).map((b, i) => {
    if (b.uri === undefined) return i === 0 ? glbBin : null;
    const m = /^data:[^,]*;base64,(.*)$/s.exec(b.uri);
    if (m) {
      try { return b64(m[1]); } catch { return null; }
    }
    warnings.push(`external buffer "${b.uri}" cannot be read from a single file; geometry that uses it is missing`);
    return null;
  });

  const readAccessor = (idx: number | undefined): { data: number[]; n: number; count: number } | null => {
    const a = idx === undefined ? undefined : json.accessors?.[idx];
    if (!a || a.bufferView === undefined) return null;
    const view = json.bufferViews?.[a.bufferView];
    const buf = view ? buffers[view.buffer] : null;
    const comp = COMP[a.componentType];
    const n = NCOMP[a.type];
    if (!view || !buf || !comp || !n) return null;
    const stride = view.byteStride && view.byteStride >= comp[0] * n ? view.byteStride : comp[0] * n;
    const base = (view.byteOffset ?? 0) + (a.byteOffset ?? 0);
    if (base + (a.count - 1) * stride + comp[0] * n > buf.length || a.count > 5e7) return null;
    const v = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    const data: number[] = [];
    const norm = a.normalized ? ({ 5120: 127, 5121: 255, 5122: 32767, 5123: 65535 } as Record<number, number>)[a.componentType] ?? 1 : 1;
    for (let i = 0; i < a.count; i++) for (let c = 0; c < n; c++) data.push(comp[1](v, base + i * stride + c * comp[0]) / norm);
    return { data, n, count: a.count };
  };

  // glTF is metres, Y up; the viewer works in millimetres.
  const unit = scaleM(1000);
  type Prim = NonNullable<NonNullable<GLTF["meshes"]>[number]["primitives"]>[number];
  type Geo = { positions: Float32Array; count: number; indices: Uint32Array | null; color: { data: ArrayLike<number>; n: number } | null };

  const accessorGeometry = (prim: Prim): Geo | null => {
    const pos = readAccessor(prim.attributes?.POSITION);
    if (!pos || pos.n !== 3) return null;
    const idx = readAccessor(prim.indices);
    const col = readAccessor(prim.attributes?.COLOR_0);
    return { positions: Float32Array.from(pos.data), count: pos.count, indices: idx ? Uint32Array.from(idx.data) : null, color: col ? { data: col.data, n: col.n } : null };
  };

  // KHR_draco_mesh_compression: the primitive's geometry is one compressed
  // bufferView; its accessors carry only counts/types, no data.
  const dracoGeometry = (ext: { bufferView: number; attributes?: Record<string, number> }): Geo | null => {
    if (!opts.draco) {
      warnings.push("Draco-compressed geometry was skipped: no Draco decoder is available here");
      return null;
    }
    const view = json.bufferViews?.[ext.bufferView];
    const buf = view ? buffers[view.buffer] : null;
    const start = view?.byteOffset ?? 0;
    if (!view || !buf || start + view.byteLength > buf.length) {
      warnings.push("a Draco-compressed primitive points outside its buffer; it was skipped");
      return null;
    }
    let dec: DracoDecoded;
    try {
      dec = opts.draco(buf.subarray(start, start + view.byteLength), ext.attributes ?? {});
    } catch (err) {
      warnings.push(`a Draco-compressed primitive could not be decoded (${(err as Error)?.message ?? err}); it was skipped`);
      return null;
    }
    const pos = dec.attributes.POSITION;
    if (!pos || pos.itemSize !== 3 || pos.array.length % 3 !== 0) return null;
    const count = pos.array.length / 3;
    if (count > 5e7 || dec.indices.length > 15e7) {
      warnings.push("a Draco-compressed primitive is too large to show; it was skipped");
      return null;
    }
    const finite = pos.array.every(Number.isFinite) ? pos.array : pos.array.map((v) => (Number.isFinite(v) ? v : 0));
    const col = dec.attributes.COLOR_0;
    return { positions: finite, count, indices: dec.indices, color: col && col.itemSize >= 3 ? { data: col.array, n: col.itemSize } : null };
  };

  const parts: MeshPart[] = [];
  const meshParts = (mi: number, m: M, nodeName: string): void => {
    const mesh = json.meshes?.[mi];
    if (!mesh) return;
    mesh.primitives?.forEach((prim, pi) => {
      if ((prim.mode ?? 4) !== 4) {
        warnings.push("only triangle-list primitives are supported; others were skipped");
        return;
      }
      const draco = prim.extensions?.KHR_draco_mesh_compression;
      const geo = draco ? dracoGeometry(draco) : accessorGeometry(prim);
      if (!geo) return;
      const { count } = geo;
      const indices = geo.indices ?? Uint32Array.from({ length: count }, (_, i) => i);
      const tri = indices.length - (indices.length % 3);
      const clean = new Uint32Array(tri);
      for (let i = 0; i < tri; i++) clean[i] = indices[i] < count ? indices[i] : 0;
      const part: MeshPart = { name: mesh.name || nodeName || `${name} ${parts.length + 1}`, positions: applyM(m, geo.positions), indices: clean.subarray(0, tri) };
      const col = geo.color;
      const base = prim.material !== undefined ? json.materials?.[prim.material]?.pbrMetallicRoughness?.baseColorFactor : undefined;
      if (col && col.n >= 3) {
        const c = new Uint8Array(count * 3);
        for (let i = 0; i < count; i++) for (let k = 0; k < 3; k++) c[i * 3 + k] = Math.max(0, Math.min(255, Math.round((col.data[i * col.n + k] ?? 0.8) * 255)));
        part.colors = c;
      } else if (base && base.length >= 3) {
        const c = new Uint8Array(count * 3);
        for (let i = 0; i < count; i++) for (let k = 0; k < 3; k++) c[i * 3 + k] = Math.max(0, Math.min(255, Math.round(base[k] * 255)));
        part.colors = c;
      }
      void pi;
      parts.push(part);
    });
  };
  const seen = new Set<number>();
  const walk = (ni: number, parent: M, depth: number): void => {
    const n = json.nodes?.[ni];
    if (!n || depth > 64 || seen.has(ni) || parts.length > 5000) return;
    seen.add(ni);
    const m = mul(parent, nodeMatrix(n));
    if (n.mesh !== undefined) meshParts(n.mesh, m, n.name ?? "");
    for (const c of n.children ?? []) walk(c, m, depth + 1);
    seen.delete(ni);
  };
  const sceneNodes = json.scenes?.[json.scene ?? 0]?.nodes;
  if (json.nodes) {
    if (sceneNodes) for (const r of sceneNodes) walk(r, unit, 0);
    else {
      // No scene: roots are the nodes nobody lists as a child.
      const child = new Set<number>(json.nodes.flatMap((n) => n.children ?? []));
      json.nodes.forEach((_, i) => { if (!child.has(i)) walk(i, unit, 0); });
    }
  }
  if (!parts.length && !json.nodes) json.meshes?.forEach((_, i) => meshParts(i, unit, ""));
  return { parts, warnings: [...new Set(warnings)] };
}

/* ---------------------------------- ZIP ----------------------------------- */

/** F-11: hostile-archive limits. One entry may inflate to this much… */
export const MAX_ZIP_ENTRY_BYTES = 512 * 1024 * 1024;
/** …and the entries one file reads, together, to this. */
export const MAX_ZIP_TOTAL_BYTES = 1024 * 1024 * 1024;
const MAX_ZIP_ENTRIES = 10_000;

/** A ZIP's entries by name, each inflated only when read (a 3MF's textures and thumbnail are never touched). */
export interface ZipReader {
  names: string[];
  has(name: string): boolean;
  read(name: string): Promise<Uint8Array | undefined>;
}

export function openZip(bytes: Uint8Array, limits: { maxEntryBytes?: number; maxTotalBytes?: number } = {}): ZipReader {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let eocd = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 22 - 65535); i--) {
    if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error("not a ZIP archive");
  const count = dv.getUint16(eocd + 10, true);
  if (count > MAX_ZIP_ENTRIES) throw new Error(`the archive lists ${count} files — too many to be a model`);
  let o = dv.getUint32(eocd + 16, true);
  const entries = new Map<string, { method: number; raw: Uint8Array }>();
  for (let i = 0; i < count; i++) {
    if (o + 46 > bytes.length || dv.getUint32(o, true) !== 0x02014b50) break;
    const method = dv.getUint16(o + 10, true);
    const csize = dv.getUint32(o + 20, true);
    const nlen = dv.getUint16(o + 28, true), xlen = dv.getUint16(o + 30, true), clen = dv.getUint16(o + 32, true);
    const lho = dv.getUint32(o + 42, true);
    const fname = new TextDecoder().decode(bytes.subarray(o + 46, o + 46 + nlen));
    o += 46 + nlen + xlen + clen;
    if (lho + 30 > bytes.length || dv.getUint32(lho, true) !== 0x04034b50) continue;
    const start = lho + 30 + dv.getUint16(lho + 26, true) + dv.getUint16(lho + 28, true);
    if (method === 0 || method === 8) entries.set(fname, { method, raw: bytes.subarray(start, start + csize) });
  }
  let budget = limits.maxTotalBytes ?? MAX_ZIP_TOTAL_BYTES;
  const perEntry = limits.maxEntryBytes ?? MAX_ZIP_ENTRY_BYTES;
  const cache = new Map<string, Promise<Uint8Array>>();
  // Part names are case-insensitive in OPC (3MF's packaging), and may be written with a leading slash.
  const byLower = new Map([...entries.keys()].map((k) => [k.replace(/^\//, "").toLowerCase(), k]));
  const resolve = (name: string) => byLower.get(name.replace(/^\//, "").toLowerCase());
  return {
    names: [...entries.keys()],
    has: (name) => resolve(name) !== undefined,
    read(name) {
      const key = resolve(name);
      if (key === undefined) return Promise.resolve(undefined);
      let p = cache.get(key);
      if (!p) {
        const e = entries.get(key)!;
        p = (async () => {
          const out = e.method === 0 ? e.raw : await inflateRaw(e.raw, Math.min(perEntry, budget));
          budget -= out.length;
          return out;
        })();
        cache.set(key, p);
      }
      return p;
    },
  };
}

/** Every entry, inflated (small archives and tests; parsers use {@link openZip}). */
export async function unzip(bytes: Uint8Array): Promise<Map<string, Uint8Array>> {
  const z = openZip(bytes);
  const out = new Map<string, Uint8Array>();
  for (const n of z.names) out.set(n, (await z.read(n))!);
  return out;
}

/** Inflates, giving up as soon as the output passes `limit` — a zip bomb costs its first `limit` bytes, not all of memory. */
async function inflateRaw(data: Uint8Array, limit: number): Promise<Uint8Array> {
  const reader = new Blob([data as BlobPart]).stream().pipeThrough(new DecompressionStream("deflate-raw")).getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > limit) {
      await reader.cancel().catch(() => {});
      throw new Error("a file inside the archive inflates to more than a model can be (a zip bomb?)");
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}

/* ----------------------------------- 3MF ---------------------------------- */

const UNIT_MM: Record<string, number> = { micron: 0.001, millimeter: 1, centimeter: 10, meter: 1000, inch: 25.4, foot: 304.8 };

/** Total vertices + triangles one 3MF may declare; past it the file is refused rather than exhausting memory. */
export const MAX_3MF_ELEMENTS = 60_000_000;

const REL_3DMODEL = "http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel";

interface Tri { v: [number, number, number]; pid?: string; p?: [number | undefined, number | undefined, number | undefined] }
interface ObjDef {
  key: string;
  path: string;
  name: string;
  type: string;
  pid?: string;
  pindex?: number;
  positions: number[];
  tris: Tri[];
  comps: { key: string; m: M }[];
}
/** A property group: colours by index, or a texture group (drawn in the fallback colour). */
type PropGroup = { kind: "colors"; colors: ([number, number, number] | null)[] } | { kind: "texture" };

/** 3MF affine "m00 m01 m02 m10 … m32" (row-vector convention) -> column-major 4x4. */
function affine3mf(s: string | undefined): M {
  const v = (s ?? "").trim().split(/\s+/).map(Number);
  if (v.length !== 12 || v.some((x) => !Number.isFinite(x))) return I4();
  return [v[0], v[1], v[2], 0, v[3], v[4], v[5], 0, v[6], v[7], v[8], 0, v[9], v[10], v[11], 1];
}

const det3 = (m: M): number => m[0] * (m[5] * m[10] - m[9] * m[6]) - m[4] * (m[1] * m[10] - m[9] * m[2]) + m[8] * (m[1] * m[6] - m[5] * m[2]);

/** Attributes of a tag; namespace prefixes are kept as written (`p:path`) and also stored bare. */
const attrs = (s: string): Record<string, string> => {
  const o: Record<string, string> = {};
  for (const m of s.matchAll(/([\w:.-]+)\s*=\s*"([^"]*)"/g)) {
    const v = unxml(m[2]);
    o[m[1]] = v;
    const bare = m[1].replace(/^.*:/, "");
    if (!(bare in o)) o[bare] = v;
  }
  return o;
};
const unxml = (s: string): string =>
  s.replace(/&(lt|gt|amp|quot|apos|#\d+|#x[0-9a-f]+);/gi, (_, e: string) =>
    e === "lt" ? "<" : e === "gt" ? ">" : e === "amp" ? "&" : e === "quot" ? '"' : e === "apos" ? "'" : String.fromCodePoint(e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : +e.slice(1)),
  );

/** "#RRGGBB" or "#RRGGBBAA" → RGB. */
const hexRgb = (s: string | undefined): [number, number, number] | null => {
  const m = s && /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})/i.exec(s.trim());
  return m ? [parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16)] : null;
};

/** The root model part a 3MF's `_rels/.rels` names (falling back to the usual path, then any `.model`). */
function rootModelPath(z: ZipReader, rels: string | null): string | undefined {
  if (rels) {
    for (const m of rels.matchAll(/<Relationship\b([^>]*)>/gi)) {
      const a = attrs(m[1]);
      if ((a.Type ?? "").toLowerCase() === REL_3DMODEL && a.Target && z.has(a.Target)) return a.Target.replace(/^\//, "");
    }
  }
  if (z.has("3D/3dmodel.model")) return "3D/3dmodel.model";
  return z.names.find((k) => /\.model$/i.test(k));
}

/**
 * F-05/F-11: a 3MF package — the Core spec plus what slicers write:
 * `_rels` resolution, the production extension's `p:path` (objects in other
 * `.model` parts), components, build-item transforms (mirrors keep their
 * outward winding), units, object types (support and other non-model
 * objects are left out), `basematerials` and `colorgroup` colours per object,
 * triangle or corner, and the model's metadata. Textures draw in their
 * fallback colour; beam lattices and slices are named in a warning.
 */
export async function parse3mf(bytes: Uint8Array, name = "Part"): Promise<MeshParseResult> {
  const warnings = new Set<string>();
  const z = openZip(bytes);
  const relsBytes = await z.read("_rels/.rels");
  const root = rootModelPath(z, relsBytes ? new TextDecoder().decode(relsBytes) : null);
  if (!root) throw new Error("3MF archive has no 3D model part");

  const groups = new Map<string, PropGroup>(); // "<path>#<id>"
  const objs = new Map<string, ObjDef>(); // "<path>#<id>"
  const metadata: Record<string, string> = {};
  let elements = 0;
  let unit = 1;
  const loaded = new Set<string>();

  const loadModel = async (path: string, depth: number): Promise<void> => {
    const norm = path.replace(/^\//, "");
    if (loaded.has(norm.toLowerCase()) || depth > 8) return;
    loaded.add(norm.toLowerCase());
    const raw = await z.read(norm);
    if (!raw) {
      warnings.add(`the 3MF refers to a model part it doesn't contain (${norm})`);
      return;
    }
    const xml = new TextDecoder().decode(raw);
    if (/<!ENTITY/i.test(xml)) throw new Error("the 3MF declares XML entities, which a model never needs — refused");
    if (depth === 0) {
      unit = UNIT_MM[/<model\b[^>]*\bunit="(\w+)"/i.exec(xml)?.[1]?.toLowerCase() ?? "millimeter"] ?? 1;
      for (const m of xml.matchAll(/<metadata\b([^>]*)>([^<]*)<\/metadata>/gi)) {
        const a = attrs(m[1]);
        const v = unxml(m[2]).trim();
        if (a.name && v && Object.keys(metadata).length < 64) metadata[a.name.replace(/^.*:/, "")] = v.slice(0, 500);
      }
    }
    if (/<([\w-]+:)?beamlattice\b/i.test(xml)) warnings.add("beam lattices in this 3MF are not shown (only the triangle mesh is)");
    if (/<([\w-]+:)?slicestack\b/i.test(xml)) warnings.add("slice data in this 3MF is ignored; the triangle mesh is shown");
    if (/<([\w-]+:)?texture2dgroup\b/i.test(xml)) warnings.add("textures are not shown; textured faces use their fallback colour");

    const key = (id: string | undefined, p?: string) => `${(p ?? norm).replace(/^\//, "").toLowerCase()}#${id ?? ""}`;
    const refs: string[] = [];
    let cur: ObjDef | null = null;
    let curGroup: PropGroup | null = null;
    for (const t of xml.matchAll(/<(\/?)([\w:.-]+)([^>]*?)(\/?)>/g)) {
      const closing = t[1] === "/";
      const tag = t[2].replace(/^.*:/, "");
      if (tag === "basematerials" || tag === "colorgroup" || tag === "texture2dgroup" || tag === "compositematerials" || tag === "multiproperties") {
        if (closing) curGroup = null;
        else {
          const a = attrs(t[3]);
          curGroup = tag === "basematerials" || tag === "colorgroup" ? { kind: "colors", colors: [] } : { kind: "texture" };
          if (a.id) groups.set(key(a.id), curGroup);
          if (t[4] === "/") curGroup = null;
        }
        continue;
      }
      if (closing) {
        if (tag === "object") cur = null;
        continue;
      }
      if ((tag === "base" || tag === "color") && curGroup?.kind === "colors") {
        const a = attrs(t[3]);
        curGroup.colors.push(hexRgb(tag === "base" ? a.displaycolor : a.color));
      } else if (tag === "object") {
        const a = attrs(t[3]);
        cur = { key: key(a.id), path: norm, name: a.name || "", type: (a.type || "model").toLowerCase(), pid: a.pid, pindex: a.pindex !== undefined ? +a.pindex : undefined, positions: [], tris: [], comps: [] };
        objs.set(cur.key, cur);
        if (t[4] === "/") cur = null;
      } else if (tag === "vertex" && cur) {
        if (++elements > MAX_3MF_ELEMENTS) throw new Error("the 3MF is too large to open (over 60 million vertices and triangles)");
        const a = attrs(t[3]);
        cur.positions.push(+a.x, +a.y, +a.z);
      } else if (tag === "triangle" && cur) {
        if (++elements > MAX_3MF_ELEMENTS) throw new Error("the 3MF is too large to open (over 60 million vertices and triangles)");
        const a = attrs(t[3]);
        const tri: Tri = { v: [+a.v1, +a.v2, +a.v3] };
        if (a.pid !== undefined || a.p1 !== undefined) {
          tri.pid = a.pid;
          const n = (v: string | undefined) => (v === undefined ? undefined : +v);
          tri.p = [n(a.p1), n(a.p2), n(a.p3)];
        }
        cur.tris.push(tri);
      } else if (tag === "component" && cur) {
        const a = attrs(t[3]);
        const p = a["p:path"];
        if (p) refs.push(p);
        cur.comps.push({ key: key(a.objectid, p), m: affine3mf(a.transform) });
      } else if (tag === "item") {
        const a = attrs(t[3]);
        if (depth === 0) {
          const p = a["p:path"];
          if (p) refs.push(p);
          buildItems.push({ key: key(a.objectid, p), m: affine3mf(a.transform) });
        }
      }
    }
    for (const r of refs) await loadModel(r, depth + 1);
  };
  const buildItems: { key: string; m: M }[] = [];
  await loadModel(root, 0);

  const parts: MeshPart[] = [];
  let leftOut = 0;
  const colorOf = (path: string, pid: string | undefined, index: number | undefined): [number, number, number] | null => {
    if (pid === undefined || index === undefined || !Number.isInteger(index)) return null;
    const g = groups.get(`${path.toLowerCase()}#${pid}`);
    return g?.kind === "colors" ? g.colors[index] ?? null : null;
  };
  const emit = (o: ObjDef, m: M, label: string, depth: number): void => {
    if (depth > 16 || parts.length > 5000) return;
    if (o.type !== "model") {
      leftOut++;
      return;
    }
    if (o.tris.length) {
      const nv = o.positions.length / 3;
      const objColor = colorOf(o.path, o.pid, o.pindex);
      const flip = det3(m) < 0; // a mirroring transform turns the winding inside out
      const good = o.tris.filter((t) => t.v.every((x) => Number.isInteger(x) && x >= 0 && x < nv));
      // Corner colours: a triangle's own pid/p1..p3, else the object's default.
      const corner = (t: Tri, k: number): [number, number, number] | null => {
        if (!t.p) return objColor;
        const idx = t.p[k] ?? t.p[0];
        return colorOf(o.path, t.pid ?? o.pid, idx) ?? objColor;
      };
      const perTriangle = good.some((t) => t.p);
      let part: MeshPart;
      const pname = label || o.name || `${name} ${parts.length + 1}`;
      if (!perTriangle) {
        const idx = new Uint32Array(good.length * 3);
        good.forEach((t, i) => idx.set(flip ? [t.v[0], t.v[2], t.v[1]] : t.v, i * 3));
        part = { name: pname, positions: applyM(m, Float32Array.from(o.positions)), indices: idx };
        if (objColor) {
          const c = new Uint8Array(nv * 3);
          for (let i = 0; i < nv; i++) c.set(objColor, i * 3);
          part.colors = c;
        }
      } else {
        // Colours that change from triangle to triangle: every corner gets its own vertex.
        const pos = new Float32Array(good.length * 9);
        const col = new Uint8Array(good.length * 9);
        good.forEach((t, i) => {
          const order = flip ? [0, 2, 1] : [0, 1, 2];
          order.forEach((k, j) => {
            const v = t.v[k];
            pos.set(o.positions.slice(v * 3, v * 3 + 3), i * 9 + j * 3);
            col.set(corner(t, k) ?? [180, 180, 180], i * 9 + j * 3);
          });
        });
        const idx = new Uint32Array(good.length * 3);
        for (let i = 0; i < idx.length; i++) idx[i] = i;
        part = { name: pname, positions: applyM(m, pos), indices: idx, colors: col };
      }
      parts.push(part);
    }
    for (const c of o.comps) {
      const child = objs.get(c.key);
      if (child) emit(child, mul(m, c.m), child.name, depth + 1);
    }
  };
  const base = scaleM(unit);
  if (buildItems.length) {
    for (const it of buildItems) {
      const o = objs.get(it.key);
      if (o) emit(o, mul(base, it.m), o.name, 0);
      else warnings.add("a build item names an object the 3MF doesn't define");
    }
  } else for (const o of objs.values()) if (o.path === root) emit(o, base, o.name, 0);
  if (leftOut) warnings.add(`${leftOut} support or non-model object${leftOut === 1 ? " was" : "s were"} left out`);
  const result: MeshParseResult = { parts, warnings: [...warnings] };
  if (Object.keys(metadata).length) result.metadata = metadata;
  return result;
}
