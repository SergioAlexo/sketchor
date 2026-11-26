/**
 * F-11: mesh writers — binary/ASCII STL and 3MF — plus the checks a printer
 * cares about before a file is written. Pure: `MeshPart[]` (millimetres) in,
 * bytes out, so the app, tests and any later exporter share one layer
 * (OBJ/PLY/glTF writers can follow here).
 */
import type { MeshPart } from "./parse";
import { writeZip } from "./zipWrite";

/* --------------------------------- checks --------------------------------- */

export interface MeshCheck {
  triangles: number;
  /** Zero-area triangles (repeated corners or collinear). */
  degenerate: number;
  /** Triangles that repeat another's three corners. */
  duplicate: number;
  /** Edges used by one triangle: holes in the surface. */
  openEdges: number;
  /** Edges used by three or more triangles. */
  nonManifoldEdges: number;
  /** Edges whose two triangles walk them the same way (a flipped neighbour). */
  flippedEdges: number;
  /** Connected pieces. */
  shells: number;
  /** Closed, manifold and consistently wound: what a slicer wants. */
  watertight: boolean;
}

/** Corners closer than this (mm) are the same corner when the mesh is welded. */
export const WELD_TOLERANCE = 1e-5;

/** Welds coincident corners: per input vertex, its welded index, and the welded positions. */
export function weldVertices(positions: Float32Array, tol = WELD_TOLERANCE): { map: Uint32Array; positions: Float32Array } {
  const n = positions.length / 3;
  const map = new Uint32Array(n);
  const keys = new Map<string, number>();
  const out: number[] = [];
  const q = (v: number) => Math.round(v / tol);
  for (let i = 0; i < n; i++) {
    const x = positions[i * 3], y = positions[i * 3 + 1], z = positions[i * 3 + 2];
    const k = `${q(x)},${q(y)},${q(z)}`;
    let w = keys.get(k);
    if (w === undefined) {
      w = out.length / 3;
      keys.set(k, w);
      out.push(x, y, z);
    }
    map[i] = w;
  }
  return { map, positions: Float32Array.from(out) };
}

/** Is the triangle (a, b, c) of welded indices zero-area? */
function degenerate(p: Float32Array, a: number, b: number, c: number): boolean {
  if (a === b || b === c || a === c) return true;
  const ux = p[b * 3] - p[a * 3], uy = p[b * 3 + 1] - p[a * 3 + 1], uz = p[b * 3 + 2] - p[a * 3 + 2];
  const vx = p[c * 3] - p[a * 3], vy = p[c * 3 + 1] - p[a * 3 + 1], vz = p[c * 3 + 2] - p[a * 3 + 2];
  const cx = uy * vz - uz * vy, cy = uz * vx - ux * vz, cz = ux * vy - uy * vx;
  return cx * cx + cy * cy + cz * cz < 1e-18;
}

/** F-11: what is wrong with a mesh for printing (report only; nothing is changed). */
export function checkMesh(part: MeshPart): MeshCheck {
  const { map, positions } = weldVertices(part.positions);
  const tris = part.indices.length / 3;
  let degen = 0, dup = 0;
  const seen = new Set<string>();
  // Directed edge counts: key "a,b" for a < b, value = [forward uses, backward uses].
  const edges = new Map<string, [number, number]>();
  const parent = new Int32Array(positions.length / 3).map((_, i) => i);
  const find = (x: number): number => {
    while (parent[x] !== x) x = parent[x] = parent[parent[x]];
    return x;
  };
  const used = new Set<number>();
  for (let t = 0; t < tris; t++) {
    const a = map[part.indices[t * 3]], b = map[part.indices[t * 3 + 1]], c = map[part.indices[t * 3 + 2]];
    if (degenerate(positions, a, b, c)) {
      degen++;
      continue;
    }
    const key = [a, b, c].sort((x, y) => x - y).join(",");
    if (seen.has(key)) {
      dup++;
      continue;
    }
    seen.add(key);
    for (const [u, v] of [[a, b], [b, c], [c, a]]) {
      const k = u < v ? `${u},${v}` : `${v},${u}`;
      const e = edges.get(k) ?? [0, 0];
      e[u < v ? 0 : 1]++;
      edges.set(k, e);
      parent[find(u)] = find(v);
    }
    used.add(a).add(b).add(c);
  }
  let open = 0, nonManifold = 0, flipped = 0;
  for (const [f, r] of edges.values()) {
    const uses = f + r;
    if (uses === 1) open++;
    else if (uses > 2) nonManifold++;
    else if (f !== 1) flipped++; // two uses the same direction
  }
  const roots = new Set<number>();
  for (const v of used) roots.add(find(v));
  return {
    triangles: tris,
    degenerate: degen,
    duplicate: dup,
    openEdges: open,
    nonManifoldEdges: nonManifold,
    flippedEdges: flipped,
    shells: roots.size,
    watertight: open === 0 && nonManifold === 0 && flipped === 0 && tris - degen - dup > 0,
  };
}

/** One line per problem, for an export warning; empty when the mesh is clean. */
export function describeMeshCheck(name: string, c: MeshCheck): string[] {
  const out: string[] = [];
  const n = (v: number, one: string, many = `${one}s`) => `${v.toLocaleString("en-US")} ${v === 1 ? one : many}`;
  if (c.openEdges) out.push(`${name}: not closed (${n(c.openEdges, "open edge")})`);
  if (c.nonManifoldEdges) out.push(`${name}: ${n(c.nonManifoldEdges, "edge")} shared by more than two triangles`);
  if (c.flippedEdges) out.push(`${name}: some triangles face the wrong way (${n(c.flippedEdges, "edge")})`);
  if (c.degenerate) out.push(`${name}: ${n(c.degenerate, "zero-area triangle")}`);
  if (c.duplicate) out.push(`${name}: ${n(c.duplicate, "duplicate triangle")}`);
  return out;
}

/* ----------------------------------- STL ---------------------------------- */

export interface StlWriteOptions {
  /** Default binary (smaller, and what every slicer reads fastest). */
  format?: "binary" | "ascii";
  /** File units per millimetre: 1 = mm (default), 1/25.4 = inches, 0.001 = metres. STL itself stores no unit. */
  scale?: number;
  /** Write each triangle's colour (its first corner's) in the attribute bytes, VisCAM/SolidView style. Binary only. */
  colors?: boolean;
  /** The ASCII `solid` name / text in the binary header. */
  name?: string;
}

function triNormal(p: ArrayLike<number>, o: number): [number, number, number] {
  const ux = p[o + 3] - p[o], uy = p[o + 4] - p[o + 1], uz = p[o + 5] - p[o + 2];
  const vx = p[o + 6] - p[o], vy = p[o + 7] - p[o + 1], vz = p[o + 8] - p[o + 2];
  const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
  const l = Math.hypot(nx, ny, nz);
  return l > 0 ? [nx / l, ny / l, nz / l] : [0, 0, 0];
}

/** Every triangle of every part as 9 numbers (scaled), and its first corner's colour when the part has colours. */
function soup(parts: readonly MeshPart[], scale: number): { pos: Float32Array; rgb: (Uint8Array | null)[] } {
  const count = parts.reduce((s, p) => s + p.indices.length / 3, 0);
  const pos = new Float32Array(count * 9);
  const rgb: (Uint8Array | null)[] = [];
  let t = 0;
  for (const p of parts) {
    for (let i = 0; i + 2 < p.indices.length; i += 3, t++) {
      for (let k = 0; k < 3; k++) {
        const v = p.indices[i + k];
        for (let j = 0; j < 3; j++) pos[t * 9 + k * 3 + j] = p.positions[v * 3 + j] * scale;
      }
      rgb.push(p.colors ? p.colors.subarray(p.indices[i] * 3, p.indices[i] * 3 + 3) : null);
    }
  }
  return { pos, rgb };
}

/** F-11: parts as one STL. Normals are recomputed from the winding (the stored ones are what readers ignore anyway). */
export function writeStl(parts: readonly MeshPart[], opts: StlWriteOptions = {}): Uint8Array {
  const scale = opts.scale ?? 1;
  const name = (opts.name ?? "Sketchor").replace(/[\r\n]/g, " ").slice(0, 70);
  const { pos, rgb } = soup(parts, scale);
  const n = pos.length / 9;
  if (opts.format === "ascii") {
    const f = (v: number) => (Number.isInteger(v) ? String(v) : v.toPrecision(9).replace(/\.?0+(e|$)/, "$1"));
    const lines: string[] = [];
    // One solid per part, so a multi-body model stays several bodies.
    let t = 0;
    for (const p of parts) {
      const label = (p.name || name).replace(/\s+/g, "_");
      lines.push(`solid ${label}`);
      for (let i = 0; i < p.indices.length / 3; i++, t++) {
        const o = t * 9;
        const nm = triNormal(pos, o);
        lines.push(`  facet normal ${f(nm[0])} ${f(nm[1])} ${f(nm[2])}`, "    outer loop");
        for (let k = 0; k < 3; k++) lines.push(`      vertex ${f(pos[o + k * 3])} ${f(pos[o + k * 3 + 1])} ${f(pos[o + k * 3 + 2])}`);
        lines.push("    endloop", "  endfacet");
      }
      lines.push(`endsolid ${label}`);
    }
    return new TextEncoder().encode(lines.join("\n") + "\n");
  }
  const out = new Uint8Array(84 + n * 50);
  const dv = new DataView(out.buffer);
  // The header must not start with "solid", or naive readers take the file for ASCII.
  out.set(new TextEncoder().encode(`Binary STL by Sketchor: ${name}`).subarray(0, 80));
  dv.setUint32(80, n, true);
  for (let t = 0; t < n; t++) {
    const o = 84 + t * 50;
    const nm = triNormal(pos, t * 9);
    for (let j = 0; j < 3; j++) dv.setFloat32(o + j * 4, nm[j], true);
    for (let k = 0; k < 9; k++) dv.setFloat32(o + 12 + k * 4, pos[t * 9 + k], true);
    const c = opts.colors ? rgb[t] : null;
    if (c) dv.setUint16(o + 48, 0x8000 | ((c[0] >> 3) << 10) | ((c[1] >> 3) << 5) | (c[2] >> 3), true);
  }
  return out;
}

/* ----------------------------------- 3MF ---------------------------------- */

export type ThreeMfUnit = "micron" | "millimeter" | "centimeter" | "inch" | "foot" | "meter";
const UNIT_PER_MM: Record<ThreeMfUnit, number> = { micron: 1000, millimeter: 1, centimeter: 0.1, inch: 1 / 25.4, foot: 1 / 304.8, meter: 0.001 };

export interface ThreeMfWriteOptions {
  /** The `unit` attribute; coordinates are converted from mm to it. Default millimeter. */
  unit?: ThreeMfUnit;
  /** `<metadata>` (Title, Designer, Description, Application…). Application defaults to Sketchor. */
  metadata?: Record<string, string>;
  /** A PNG for the package thumbnail (`Metadata/thumbnail.png`). */
  thumbnail?: Uint8Array;
}

const xmlEsc = (s: string): string => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[c]!);
const hex2 = (v: number) => v.toString(16).padStart(2, "0").toUpperCase();
const colorHex = (c: ArrayLike<number>) => `#${hex2(c[0])}${hex2(c[1])}${hex2(c[2])}FF`;
/** Shortest text that reads back as the same float32. */
const num = (v: number): string => {
  if (Object.is(v, -0)) return "0";
  for (let d = 6; d <= 9; d++) {
    const s = v.toPrecision(d);
    if (Math.fround(+s) === Math.fround(v)) return String(+s);
  }
  return String(v);
};

/**
 * F-11: parts as a 3MF package — one `object` per part with shared
 * (welded) vertices and a `build` item each, colours as `basematerials` (a
 * uniform part) or a `colorgroup` (colours that vary by triangle), names and
 * metadata kept, and an optional thumbnail.
 */
export async function write3mf(parts: readonly MeshPart[], opts: ThreeMfWriteOptions = {}): Promise<Uint8Array> {
  const unit = opts.unit ?? "millimeter";
  const k = UNIT_PER_MM[unit];
  const meta = { Application: "Sketchor", ...(opts.metadata ?? {}) };
  const res: string[] = [];
  const objects: string[] = [];
  const items: string[] = [];
  let nextId = 1;
  for (const p of parts) {
    const { map, positions } = weldVertices(p.positions);
    const verts: string[] = [];
    for (let i = 0; i < positions.length; i += 3) verts.push(`<vertex x="${num(positions[i] * k)}" y="${num(positions[i + 1] * k)}" z="${num(positions[i + 2] * k)}"/>`);
    // Triangle colours (first corner) decide between one material and a per-triangle colour group.
    const triColor: (string | null)[] = [];
    if (p.colors) for (let i = 0; i + 2 < p.indices.length; i += 3) triColor.push(colorHex(p.colors.subarray(p.indices[i] * 3, p.indices[i] * 3 + 3)));
    const distinct = [...new Set(triColor.filter((c): c is string => !!c))];
    let objAttr = "";
    let groupId = 0;
    const slot = new Map<string, number>();
    if (distinct.length === 1) {
      const id = nextId++;
      res.push(`<basematerials id="${id}"><base name="${xmlEsc(p.name || "Part")}" displaycolor="${distinct[0]}"/></basematerials>`);
      objAttr = ` pid="${id}" pindex="0"`;
    } else if (distinct.length > 1) {
      groupId = nextId++;
      distinct.forEach((c, i) => slot.set(c, i));
      res.push(`<m:colorgroup id="${groupId}">${distinct.map((c) => `<m:color color="${c}"/>`).join("")}</m:colorgroup>`);
      objAttr = ` pid="${groupId}" pindex="0"`;
    }
    const tris: string[] = [];
    for (let i = 0, t = 0; i + 2 < p.indices.length; i += 3, t++) {
      const a = map[p.indices[i]], b = map[p.indices[i + 1]], c = map[p.indices[i + 2]];
      if (a === b || b === c || a === c) continue; // collapsed by the weld: not a triangle any more
      const col = groupId && triColor[t] ? ` p1="${slot.get(triColor[t]!)}"` : "";
      tris.push(`<triangle v1="${a}" v2="${b}" v3="${c}"${col}/>`);
    }
    const id = nextId++;
    objects.push(`<object id="${id}" type="model" name="${xmlEsc(p.name || `Part ${id}`)}"${objAttr}><mesh><vertices>${verts.join("")}</vertices><triangles>${tris.join("")}</triangles></mesh></object>`);
    items.push(`<item objectid="${id}"/>`);
  }
  const metaXml = Object.entries(meta)
    .filter(([, v]) => v)
    .map(([name, v]) => `<metadata name="${xmlEsc(name)}">${xmlEsc(v)}</metadata>`)
    .join("");
  const model =
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<model unit="${unit}" xml:lang="en-US" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02" xmlns:m="http://schemas.microsoft.com/3dmanufacturing/material/2015/02">` +
    metaXml +
    `<resources>${res.join("")}${objects.join("")}</resources><build>${items.join("")}</build></model>\n`;
  const thumbRel = opts.thumbnail
    ? `<Relationship Target="/Metadata/thumbnail.png" Id="rel1" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/thumbnail"/>`
    : "";
  const files: Record<string, Uint8Array | string> = {
    "[Content_Types].xml":
      `<?xml version="1.0" encoding="UTF-8"?>\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
      `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
      `<Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/>` +
      (opts.thumbnail ? `<Default Extension="png" ContentType="image/png"/>` : "") +
      `</Types>`,
    "_rels/.rels":
      `<?xml version="1.0" encoding="UTF-8"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
      `<Relationship Target="/3D/3dmodel.model" Id="rel0" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/>${thumbRel}</Relationships>`,
    "3D/3dmodel.model": model,
  };
  if (opts.thumbnail) files["Metadata/thumbnail.png"] = opts.thumbnail;
  return writeZip(files);
}
