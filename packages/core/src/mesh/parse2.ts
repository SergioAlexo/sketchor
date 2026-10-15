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

export async function parseAnyMesh(format: NonNullable<AnyMeshFormat>, bytes: Uint8Array, name = "Part"): Promise<MeshParseResult> {
  if (format === "3mf") return nonEmpty(await parse3mf(bytes, name));
  if (format === "gltf" || format === "glb") return nonEmpty(parseGltf(bytes, name));
  return parseMesh(format, bytes, name);
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
  buffers?: { uri?: string; byteLength: number }[];
  bufferViews?: GView[];
  accessors?: GAccessor[];
  meshes?: { name?: string; primitives: { attributes: Record<string, number>; indices?: number; mode?: number; material?: number }[] }[];
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

export function parseGltf(bytes: Uint8Array, name = "Part"): MeshParseResult {
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
  const parts: MeshPart[] = [];
  const meshParts = (mi: number, m: M, nodeName: string): void => {
    const mesh = json.meshes?.[mi];
    if (!mesh) return;
    mesh.primitives?.forEach((prim, pi) => {
      if ((prim.mode ?? 4) !== 4) {
        warnings.push("only triangle-list primitives are supported; others were skipped");
        return;
      }
      const pos = readAccessor(prim.attributes?.POSITION);
      if (!pos || pos.n !== 3) return;
      const idxAcc = readAccessor(prim.indices);
      const indices = idxAcc ? Uint32Array.from(idxAcc.data) : Uint32Array.from({ length: pos.count }, (_, i) => i);
      const tri = indices.length - (indices.length % 3);
      const clean = new Uint32Array(tri);
      for (let i = 0; i < tri; i++) clean[i] = indices[i] < pos.count ? indices[i] : 0;
      const part: MeshPart = { name: mesh.name || nodeName || `${name} ${parts.length + 1}`, positions: applyM(m, Float32Array.from(pos.data)), indices: clean.subarray(0, tri) };
      const col = readAccessor(prim.attributes?.COLOR_0);
      const base = prim.material !== undefined ? json.materials?.[prim.material]?.pbrMetallicRoughness?.baseColorFactor : undefined;
      if (col && col.n >= 3) {
        const c = new Uint8Array(pos.count * 3);
        for (let i = 0; i < pos.count; i++) for (let k = 0; k < 3; k++) c[i * 3 + k] = Math.max(0, Math.min(255, Math.round((col.data[i * col.n + k] ?? 0.8) * 255)));
        part.colors = c;
      } else if (base && base.length >= 3) {
        const c = new Uint8Array(pos.count * 3);
        for (let i = 0; i < pos.count; i++) for (let k = 0; k < 3; k++) c[i * 3 + k] = Math.max(0, Math.min(255, Math.round(base[k] * 255)));
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

export async function unzip(bytes: Uint8Array): Promise<Map<string, Uint8Array>> {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let eocd = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 22 - 65535); i--) {
    if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error("not a ZIP archive");
  const count = dv.getUint16(eocd + 10, true);
  let o = dv.getUint32(eocd + 16, true);
  const out = new Map<string, Uint8Array>();
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
    const raw = bytes.subarray(start, start + csize);
    if (method === 0) out.set(fname, raw);
    else if (method === 8) out.set(fname, await inflateRaw(raw));
  }
  return out;
}

async function inflateRaw(data: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([data as BlobPart]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/* ----------------------------------- 3MF ---------------------------------- */

const UNIT_MM: Record<string, number> = { micron: 0.001, millimeter: 1, centimeter: 10, meter: 1000, inch: 25.4, foot: 304.8 };

interface ObjDef { id: string; name: string; pid?: string; pindex?: number; positions: number[]; tris: number[]; triColors: (string | undefined)[]; comps: { id: string; m: M }[] }

/** 3MF affine "m00 m01 m02 m10 … m32" (row-vector convention) -> column-major 4x4. */
function affine3mf(s: string | undefined): M {
  const v = (s ?? "").trim().split(/\s+/).map(Number);
  if (v.length !== 12 || v.some((x) => !Number.isFinite(x))) return I4();
  return [v[0], v[1], v[2], 0, v[3], v[4], v[5], 0, v[6], v[7], v[8], 0, v[9], v[10], v[11], 1];
}

const attrs = (s: string): Record<string, string> => {
  const o: Record<string, string> = {};
  for (const m of s.matchAll(/([\w:.-]+)\s*=\s*"([^"]*)"/g)) o[m[1].replace(/^.*:/, "")] = m[2];
  return o;
};

export async function parse3mf(bytes: Uint8Array, name = "Part"): Promise<MeshParseResult> {
  const warnings: string[] = [];
  const files = await unzip(bytes);
  let modelPath = "3D/3dmodel.model";
  const rels = files.get("_rels/.rels");
  if (rels) {
    const m = /Target="([^"]*3dmodel[^"]*)"/i.exec(new TextDecoder().decode(rels));
    if (m) modelPath = m[1].replace(/^\//, "");
  }
  const raw = files.get(modelPath) ?? [...files.entries()].find(([k]) => /\.model$/i.test(k))?.[1];
  if (!raw) throw new Error("3MF archive has no 3D model part");
  const xml = new TextDecoder().decode(raw);

  const unit = UNIT_MM[/<model[^>]*\bunit="(\w+)"/i.exec(xml)?.[1]?.toLowerCase() ?? "millimeter"] ?? 1;
  const materials = new Map<string, string[]>(); // basematerials id -> colour hex per index
  const objs = new Map<string, ObjDef>();
  const buildItems: { id: string; m: M }[] = [];
  let cur: ObjDef | null = null;
  let curMat: string | null = null;
  let inBuild = false;
  for (const t of xml.matchAll(/<(\/?)([\w:.-]+)([^>]*?)(\/?)>/g)) {
    const closing = t[1] === "/";
    const tag = t[2].replace(/^.*:/, "");
    const a = attrs(t[3]);
    if (tag === "basematerials") {
      curMat = closing ? null : a.id ?? null;
      if (curMat) materials.set(curMat, []);
    } else if (tag === "base" && curMat) materials.get(curMat)!.push(a.displaycolor ?? "");
    else if (tag === "object" && !closing) {
      cur = { id: a.id, name: a.name || "", pid: a.pid, pindex: a.pindex !== undefined ? +a.pindex : undefined, positions: [], tris: [], triColors: [], comps: [] };
      objs.set(a.id, cur);
      if (t[4] === "/") cur = null;
    } else if (tag === "object" && closing) cur = null;
    else if (tag === "vertex" && cur) cur.positions.push(+a.x, +a.y, +a.z);
    else if (tag === "triangle" && cur) {
      cur.tris.push(+a.v1, +a.v2, +a.v3);
      cur.triColors.push(a.p1 !== undefined && a.pid ? `${a.pid}:${a.p1}` : undefined);
    } else if (tag === "component" && cur) cur.comps.push({ id: a.objectid, m: affine3mf(a.transform) });
    else if (tag === "build") inBuild = !closing;
    else if (tag === "item" && inBuild) buildItems.push({ id: a.objectid, m: affine3mf(a.transform) });
  }

  const parts: MeshPart[] = [];
  const hex = (s: string | undefined): [number, number, number] | null => {
    const m = s && /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})/i.exec(s);
    return m ? [parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16)] : null;
  };
  const emit = (o: ObjDef, m: M, label: string, depth: number): void => {
    if (depth > 16 || parts.length > 5000) return;
    if (o.tris.length) {
      const nv = o.positions.length / 3;
      const idx: number[] = [];
      for (let i = 0; i + 2 < o.tris.length; i += 3) {
        const a = o.tris[i], b = o.tris[i + 1], c = o.tris[i + 2];
        if ([a, b, c].every((x) => Number.isInteger(x) && x >= 0 && x < nv)) idx.push(a, b, c);
      }
      const part: MeshPart = { name: label || o.name || `${name} ${parts.length + 1}`, positions: applyM(m, Float32Array.from(o.positions)), indices: Uint32Array.from(idx) };
      // Per-object colour (pid/pindex) -> uniform vertex colour; per-triangle colours are not tracked.
      const mat = o.pid !== undefined && o.pindex !== undefined ? hex(materials.get(o.pid)?.[o.pindex]) : null;
      if (mat) {
        const c = new Uint8Array(nv * 3);
        for (let i = 0; i < nv; i++) c.set(mat, i * 3);
        part.colors = c;
      }
      parts.push(part);
    }
    for (const c of o.comps) {
      const child = objs.get(c.id);
      if (child) emit(child, mul(m, c.m), child.name, depth + 1);
    }
  };
  const base = scaleM(unit);
  if (buildItems.length) for (const it of buildItems) { const o = objs.get(it.id); if (o) emit(o, mul(base, it.m), o.name, 0); }
  else for (const o of objs.values()) emit(o, base, o.name, 0);
  return { parts, warnings };
}
