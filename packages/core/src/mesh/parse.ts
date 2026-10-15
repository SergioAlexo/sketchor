/**
 * F-05 — readers for triangle-mesh formats (STL ascii/binary, OBJ, PLY ascii/
 * binary). Pure: bytes in, `MeshPart[]` out, no DOM and no three.js, so the
 * worker, the tests and the file-browser thumbnailer share one parser. Every
 * reader treats its input as hostile: truncated or malformed files return
 * what could be read (with a warning) or throw a plain `Error` that says what
 * is wrong; indices are range-checked and non-finite coordinates dropped.
 */

export interface MeshPart {
  name: string;
  /** xyz triplets (file units; mesh formats carry no unit, millimetres are assumed). */
  positions: Float32Array;
  /** Triangle vertex indices into `positions`. */
  indices: Uint32Array;
  /** Optional per-vertex RGB 0–255, parallel to `positions`. */
  colors?: Uint8Array;
}

export interface MeshParseResult {
  parts: MeshPart[];
  warnings: string[];
}

export type MeshFormat = "stl" | "obj" | "ply";

export function meshFormatOf(name: string): MeshFormat | null {
  const e = name.split(/[\\/]/).pop()!.split(".").slice(1).pop()?.toLowerCase();
  return e === "stl" || e === "obj" || e === "ply" ? e : null;
}

export function parseMesh(format: MeshFormat, bytes: Uint8Array, fallbackName = "Part"): MeshParseResult {
  const r = format === "stl" ? parseStl(bytes, fallbackName) : format === "obj" ? parseObj(bytes, fallbackName) : parsePly(bytes, fallbackName);
  r.parts = r.parts.filter((p) => p.indices.length >= 3);
  if (r.parts.length === 0) throw new Error("the file contains no triangles to show");
  return r;
}

const dec = (b: Uint8Array): string => new TextDecoder("utf-8").decode(b);

/* ----------------------------------- STL ---------------------------------- */

export function parseStl(bytes: Uint8Array, name = "Part"): MeshParseResult {
  const warnings: string[] = [];
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let binary = false;
  if (bytes.length >= 84) {
    const n = view.getUint32(80, true);
    if (84 + n * 50 === bytes.length) binary = true;
    else if (!/^\s*solid/i.test(dec(bytes.subarray(0, 5)))) binary = true; // "solid" header absent: can only be binary
    else if (!dec(bytes.subarray(0, Math.min(bytes.length, 4096))).includes("facet")) binary = true;
  }
  const pos: number[] = [];
  if (binary) {
    if (bytes.length < 84) throw new Error("not an STL file (too short)");
    let n = view.getUint32(80, true);
    const fit = Math.floor((bytes.length - 84) / 50);
    if (n > fit) {
      warnings.push(`STL is truncated: header says ${n} triangles, ${fit} present`);
      n = fit;
    }
    for (let t = 0; t < n; t++) {
      const o = 84 + t * 50 + 12; // skip the stored normal
      for (let k = 0; k < 9; k++) pos.push(view.getFloat32(o + k * 4, true));
    }
  } else {
    const re = /vertex\s+(\S+)\s+(\S+)\s+(\S+)/gi;
    const text = dec(bytes);
    for (let m = re.exec(text); m; m = re.exec(text)) pos.push(+m[1], +m[2], +m[3]);
    if (pos.length % 9 !== 0) {
      warnings.push("STL ends mid-facet; the last incomplete triangle was dropped");
      pos.length -= pos.length % 9;
    }
  }
  return { parts: [soupToPart(name, pos)], warnings };
}

/** Triangle soup (9 floats per triangle) -> a part; non-finite triangles are dropped. */
function soupToPart(name: string, pos: number[]): MeshPart {
  const keep: number[] = [];
  for (let t = 0; t + 9 <= pos.length; t += 9) {
    let ok = true;
    for (let k = 0; k < 9; k++) if (!Number.isFinite(pos[t + k])) ok = false;
    if (ok) for (let k = 0; k < 9; k++) keep.push(pos[t + k]);
  }
  const positions = Float32Array.from(keep);
  const indices = new Uint32Array(positions.length / 3);
  for (let i = 0; i < indices.length; i++) indices[i] = i;
  return { name, positions, indices };
}

/* ----------------------------------- OBJ ---------------------------------- */

export function parseObj(bytes: Uint8Array, fallbackName = "Part"): MeshParseResult {
  const warnings: string[] = [];
  const vx: number[] = []; // global vertex pool, xyz
  const vc: number[] = []; // optional colour per vertex (3 floats 0..1), NaN when absent
  let hasColor = false;
  interface Group { name: string; tris: number[] }
  const groups: Group[] = [];
  let cur: Group = { name: fallbackName, tris: [] };
  groups.push(cur);
  let skippedFaces = 0;
  const lines = dec(bytes).split(/\r?\n/);
  for (let line of lines) {
    const hash = line.indexOf("#");
    if (hash >= 0) line = line.slice(0, hash);
    line = line.trim();
    if (!line) continue;
    const parts = line.split(/\s+/);
    const key = parts[0];
    if (key === "v") {
      const x = +parts[1], y = +parts[2], z = +parts[3];
      vx.push(x, y, z);
      if (parts.length >= 7) {
        hasColor = true;
        vc.push(+parts[4], +parts[5], +parts[6]);
      } else vc.push(NaN, NaN, NaN);
    } else if (key === "f") {
      const n = vx.length / 3;
      const ids: number[] = [];
      for (let i = 1; i < parts.length; i++) {
        const raw = parseInt(parts[i].split("/")[0], 10);
        const id = raw < 0 ? n + raw : raw - 1;
        if (!Number.isInteger(id) || id < 0 || id >= n) {
          ids.length = 0;
          break;
        }
        ids.push(id);
      }
      if (ids.length < 3) {
        skippedFaces++;
        continue;
      }
      for (let i = 1; i + 1 < ids.length; i++) cur.tris.push(ids[0], ids[i], ids[i + 1]);
    } else if (key === "o" || key === "g") {
      const nm = parts.slice(1).join(" ").trim();
      if (cur.tris.length === 0) cur.name = nm || cur.name;
      else {
        cur = { name: nm || `${fallbackName} ${groups.length + 1}`, tris: [] };
        groups.push(cur);
      }
    }
    // vn / vt / usemtl / mtllib / s: not needed (a lone file has no .mtl to read)
  }
  if (skippedFaces) warnings.push(`${skippedFaces} face(s) with missing or out-of-range vertices were skipped`);
  const parts: MeshPart[] = groups.map((g) => {
    // Compact the global pool down to the vertices this group uses.
    const remap = new Map<number, number>();
    const positions: number[] = [];
    const colors: number[] = [];
    const indices = new Uint32Array(g.tris.length);
    g.tris.forEach((id, i) => {
      let k = remap.get(id);
      if (k === undefined) {
        k = remap.size;
        remap.set(id, k);
        positions.push(vx[id * 3], vx[id * 3 + 1], vx[id * 3 + 2]);
        for (let c = 0; c < 3; c++) {
          const f = vc[id * 3 + c];
          colors.push(Number.isFinite(f) ? Math.max(0, Math.min(255, Math.round(f * 255))) : 200);
        }
      }
      indices[i] = k;
    });
    const p: MeshPart = { name: g.name, positions: finite(Float32Array.from(positions)), indices };
    if (hasColor) p.colors = Uint8Array.from(colors);
    return p;
  });
  return { parts, warnings };
}

/** Non-finite coordinates become 0 so one bad vertex can't poison bounds. */
function finite(a: Float32Array): Float32Array {
  for (let i = 0; i < a.length; i++) if (!Number.isFinite(a[i])) a[i] = 0;
  return a;
}

/* ----------------------------------- PLY ---------------------------------- */

interface PlyProp { name: string; type: string; listCount?: string }
interface PlyElement { name: string; count: number; props: PlyProp[] }

const PLY_SIZE: Record<string, number> = { char: 1, int8: 1, uchar: 1, uint8: 1, short: 2, int16: 2, ushort: 2, uint16: 2, int: 4, int32: 4, uint: 4, uint32: 4, float: 4, float32: 4, double: 8, float64: 8 };

export function parsePly(bytes: Uint8Array, name = "Part"): MeshParseResult {
  const warnings: string[] = [];
  // Header is ASCII up to "end_header\n".
  const head = dec(bytes.subarray(0, Math.min(bytes.length, 65536)));
  const endM = /end_header\r?\n/.exec(head);
  if (!head.startsWith("ply") || !endM) throw new Error("not a PLY file (missing header)");
  const bodyStart = endM.index + endM[0].length;
  let format = "";
  const elements: PlyElement[] = [];
  for (const raw of head.slice(0, endM.index).split(/\r?\n/)) {
    const t = raw.trim().split(/\s+/);
    if (t[0] === "format") format = t[1];
    else if (t[0] === "element") elements.push({ name: t[1], count: Math.max(0, parseInt(t[2], 10) || 0), props: [] });
    else if (t[0] === "property" && elements.length) {
      if (t[1] === "list") elements[elements.length - 1].props.push({ name: t[4], type: t[3], listCount: t[2] });
      else elements[elements.length - 1].props.push({ name: t[2], type: t[1] });
    }
  }
  const ascii = format === "ascii";
  if (!ascii && format !== "binary_little_endian" && format !== "binary_big_endian") throw new Error(`unsupported PLY format "${format}"`);
  const little = format !== "binary_big_endian";
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let off = bodyStart;
  const tokens = ascii ? dec(bytes.subarray(bodyStart)).split(/\s+/).filter(Boolean) : [];
  let ti = 0;
  const readNum = (type: string): number => {
    if (ascii) return +tokens[ti++];
    const size = PLY_SIZE[type];
    if (!size) throw new Error(`unsupported PLY type "${type}"`);
    if (off + size > bytes.length) throw new Error("PLY data ends early");
    let v: number;
    switch (type) {
      case "char": case "int8": v = view.getInt8(off); break;
      case "uchar": case "uint8": v = view.getUint8(off); break;
      case "short": case "int16": v = view.getInt16(off, little); break;
      case "ushort": case "uint16": v = view.getUint16(off, little); break;
      case "int": case "int32": v = view.getInt32(off, little); break;
      case "uint": case "uint32": v = view.getUint32(off, little); break;
      case "float": case "float32": v = view.getFloat32(off, little); break;
      default: v = view.getFloat64(off, little);
    }
    off += size;
    return v;
  };

  const pos: number[] = [];
  const col: number[] = [];
  let hasColor = false;
  const tris: number[] = [];
  try {
    for (const el of elements) {
      const isVertex = el.name === "vertex";
      const isFace = el.name === "face";
      for (let i = 0; i < el.count; i++) {
        const v: Record<string, number> = {};
        let list: number[] | null = null;
        for (const p of el.props) {
          if (p.listCount) {
            const n = readNum(p.listCount);
            if (!(n >= 0 && n <= 1e6)) throw new Error("PLY list length is invalid");
            const l: number[] = [];
            for (let k = 0; k < n; k++) l.push(readNum(p.type));
            if (isFace && (p.name === "vertex_indices" || p.name === "vertex_index")) list = l;
          } else v[p.name] = readNum(p.type);
        }
        if (isVertex) {
          pos.push(v.x, v.y, v.z);
          if (v.red !== undefined && v.green !== undefined && v.blue !== undefined) {
            hasColor = true;
            col.push(v.red, v.green, v.blue);
          } else col.push(200, 200, 200);
        } else if (isFace && list) {
          for (let k = 1; k + 1 < list.length; k++) tris.push(list[0], list[k], list[k + 1]);
        }
      }
    }
  } catch (e) {
    warnings.push(`PLY is truncated or malformed (${(e as Error).message}); showing what was read`);
  }
  const nv = pos.length / 3;
  const good: number[] = [];
  let bad = 0;
  for (let i = 0; i + 2 < tris.length; i += 3) {
    const a = tris[i], b = tris[i + 1], c = tris[i + 2];
    if ([a, b, c].every((x) => Number.isInteger(x) && x >= 0 && x < nv)) good.push(a, b, c);
    else bad++;
  }
  if (bad) warnings.push(`${bad} triangle(s) referenced missing vertices and were skipped`);
  const part: MeshPart = { name, positions: finite(Float32Array.from(pos)), indices: Uint32Array.from(good) };
  if (hasColor) {
    // 8-bit colours are the norm; a file that stores 0..1 floats is detected by its range.
    const max = col.reduce((m, x) => Math.max(m, x), 0);
    const k = max <= 1 ? 255 : 1;
    part.colors = Uint8Array.from(col, (x) => Math.max(0, Math.min(255, Math.round(x * k))));
  }
  return { parts: [part], warnings };
}
