/**
 * F-11: one-click mesh repair — what a slicer's "fix model" does for the
 * common faults, deterministically and without moving any vertex:
 *
 *  1. weld coincident corners (an STL is a triangle soup);
 *  2. drop zero-area and duplicate triangles;
 *  3. make the winding consistent across each connected shell (flood fill
 *     over shared edges, flipping a neighbour that walks an edge the same way);
 *  4. close small holes: each boundary loop of up to `maxHoleEdges` edges is
 *     filled with a fan around its centroid;
 *  5. turn each closed shell outward (negative volume → flip it).
 *
 * Self-intersections and non-manifold edges are reported by `checkMesh` but
 * not changed: fixing them needs a geometric decision a one-click tool
 * shouldn't make.
 */
import type { MeshPart } from "./parse";
import { WELD_TOLERANCE, weldVertices } from "./write";

export interface RepairReport {
  welded: number;
  degenerateRemoved: number;
  duplicateRemoved: number;
  trianglesFlipped: number;
  holesFilled: number;
  /** Holes left open because they were bigger than `maxHoleEdges` (or not a simple loop). */
  holesLeft: number;
  shellsTurnedOutward: number;
}

export interface RepairOptions {
  /** Boundary loops with at most this many edges are filled. Default 64. */
  maxHoleEdges?: number;
  tolerance?: number;
}

/** True when the report says nothing changed. */
export const repairChangedNothing = (r: RepairReport): boolean =>
  r.degenerateRemoved + r.duplicateRemoved + r.trianglesFlipped + r.holesFilled + r.shellsTurnedOutward === 0;

export function describeRepair(r: RepairReport): string {
  const bits: string[] = [];
  const n = (v: number, one: string, many = `${one}s`) => `${v.toLocaleString("en-US")} ${v === 1 ? one : many}`;
  if (r.degenerateRemoved) bits.push(`removed ${n(r.degenerateRemoved, "zero-area triangle")}`);
  if (r.duplicateRemoved) bits.push(`removed ${n(r.duplicateRemoved, "duplicate triangle")}`);
  if (r.trianglesFlipped) bits.push(`flipped ${n(r.trianglesFlipped, "triangle")}`);
  if (r.holesFilled) bits.push(`filled ${n(r.holesFilled, "hole")}`);
  if (r.shellsTurnedOutward) bits.push(`turned ${n(r.shellsTurnedOutward, "shell")} outward`);
  if (r.holesLeft) bits.push(`${n(r.holesLeft, "hole")} too big to fill`);
  return bits.length ? bits.join(", ") : "nothing to repair";
}

export function repairMesh(part: MeshPart, opts: RepairOptions = {}): { part: MeshPart; report: RepairReport } {
  const maxHole = opts.maxHoleEdges ?? 64;
  const { map, positions: welded } = weldVertices(part.positions, opts.tolerance ?? WELD_TOLERANCE);
  const pos: number[] = Array.from(welded);
  const report: RepairReport = { welded: part.positions.length / 3 - welded.length / 3, degenerateRemoved: 0, duplicateRemoved: 0, trianglesFlipped: 0, holesFilled: 0, holesLeft: 0, shellsTurnedOutward: 0 };

  // 2. Kept triangles, as welded corner triples plus the source triangle (for colours).
  const tris: [number, number, number][] = [];
  const src: number[] = []; // source triangle index, or -1 for a fill triangle (its colour comes from `fillColorOf`)
  const seen = new Set<string>();
  const area2 = (a: number, b: number, c: number) => {
    const ux = pos[b * 3] - pos[a * 3], uy = pos[b * 3 + 1] - pos[a * 3 + 1], uz = pos[b * 3 + 2] - pos[a * 3 + 2];
    const vx = pos[c * 3] - pos[a * 3], vy = pos[c * 3 + 1] - pos[a * 3 + 1], vz = pos[c * 3 + 2] - pos[a * 3 + 2];
    const cx = uy * vz - uz * vy, cy = uz * vx - ux * vz, cz = ux * vy - uy * vx;
    return cx * cx + cy * cy + cz * cz;
  };
  for (let t = 0; t < part.indices.length / 3; t++) {
    const a = map[part.indices[t * 3]], b = map[part.indices[t * 3 + 1]], c = map[part.indices[t * 3 + 2]];
    if (a === b || b === c || a === c || area2(a, b, c) < 1e-18) {
      report.degenerateRemoved++;
      continue;
    }
    const key = [a, b, c].sort((x, y) => x - y).join(",");
    if (seen.has(key)) {
      report.duplicateRemoved++;
      continue;
    }
    seen.add(key);
    tris.push([a, b, c]);
    src.push(t);
  }

  const edgeKey = (u: number, v: number) => (u < v ? `${u},${v}` : `${v},${u}`);
  const buildEdges = () => {
    const m = new Map<string, number[]>();
    tris.forEach((t, i) => {
      for (let k = 0; k < 3; k++) {
        const key = edgeKey(t[k], t[(k + 1) % 3]);
        const list = m.get(key);
        if (list) list.push(i);
        else m.set(key, [i]);
      }
    });
    return m;
  };
  /** Does triangle t walk the edge u→v (rather than v→u)? */
  const walks = (t: [number, number, number], u: number, v: number) => (t[0] === u && t[1] === v) || (t[1] === u && t[2] === v) || (t[2] === u && t[0] === v);

  // 3. Consistent winding per shell: flood fill across manifold edges.
  let edges = buildEdges();
  const done = new Uint8Array(tris.length);
  for (let start = 0; start < tris.length; start++) {
    if (done[start]) continue;
    done[start] = 1;
    const queue = [start];
    while (queue.length) {
      const i = queue.pop()!;
      const t = tris[i];
      for (let k = 0; k < 3; k++) {
        const u = t[k], v = t[(k + 1) % 3];
        const around = edges.get(edgeKey(u, v))!;
        if (around.length !== 2) continue; // open or non-manifold: no neighbour to agree with
        const j = around[0] === i ? around[1] : around[0];
        if (done[j]) continue;
        done[j] = 1;
        if (walks(tris[j], u, v)) {
          // The neighbour walks the shared edge the same way: flip it.
          const n = tris[j];
          tris[j] = [n[0], n[2], n[1]];
          report.trianglesFlipped++;
        }
        queue.push(j);
      }
    }
  }

  // 4. Fill small holes. Boundary edges are walked u→v by their one triangle; the loop is followed v→… .
  edges = buildEdges();
  const next = new Map<number, number[]>(); // u → [v] for each boundary edge u→v
  for (const [key, around] of edges) {
    if (around.length !== 1) continue;
    const t = tris[around[0]];
    const [p, q] = key.split(",").map(Number);
    const [u, v] = walks(t, p, q) ? [p, q] : [q, p];
    const list = next.get(u);
    if (list) list.push(v);
    else next.set(u, [v]);
  }
  const fillColorOf = new Map<number, number>(); // fill triangle index → source triangle for its colour
  const boundaryTri = new Map<string, number>();
  for (const [key, around] of edges) if (around.length === 1) boundaryTri.set(key, around[0]);
  for (const [start] of next) {
    while ((next.get(start)?.length ?? 0) > 0) {
      const loop = [start];
      let cur = next.get(start)!.pop()!;
      let ok = true;
      while (cur !== start) {
        if (loop.length > maxHole * 4) { ok = false; break; }
        loop.push(cur);
        const outs = next.get(cur);
        if (!outs || outs.length === 0) { ok = false; break; }
        cur = outs.pop()!;
      }
      if (!ok || loop.length < 3) {
        report.holesLeft++;
        continue;
      }
      if (loop.length > maxHole) {
        report.holesLeft++;
        continue;
      }
      // Each boundary edge u→v gets the fill triangle (v, u, centre): the opposite direction, so the winding matches.
      let cx = 0, cy = 0, cz = 0;
      for (const v of loop) {
        cx += pos[v * 3];
        cy += pos[v * 3 + 1];
        cz += pos[v * 3 + 2];
      }
      const centre = pos.length / 3;
      pos.push(cx / loop.length, cy / loop.length, cz / loop.length);
      for (let k = 0; k < loop.length; k++) {
        const u = loop[k], v = loop[(k + 1) % loop.length];
        if (loop.length === 3) {
          // A triangular hole is one triangle, no centre needed.
          if (k > 0) break;
          tris.push([loop[2], loop[1], loop[0]]);
        } else tris.push([v, u, centre]);
        fillColorOf.set(tris.length - 1, src[boundaryTri.get(edgeKey(u, v)) ?? 0] ?? 0);
        src.push(-1);
      }
      report.holesFilled++;
    }
  }

  // 5. Each closed shell outward: shells by shared vertices, volume by the divergence theorem.
  edges = buildEdges();
  const parent = tris.map((_, i) => i);
  const find = (x: number): number => {
    while (parent[x] !== x) x = parent[x] = parent[parent[x]];
    return x;
  };
  for (const around of edges.values()) for (let k = 1; k < around.length; k++) parent[find(around[k])] = find(around[0]);
  const shells = new Map<number, number[]>();
  tris.forEach((_, i) => {
    const r = find(i);
    const l = shells.get(r);
    if (l) l.push(i);
    else shells.set(r, [i]);
  });
  for (const members of shells.values()) {
    const closed = members.every((i) => {
      const t = tris[i];
      for (let k = 0; k < 3; k++) if (edges.get(edgeKey(t[k], t[(k + 1) % 3]))!.length !== 2) return false;
      return true;
    });
    if (!closed) continue;
    let vol = 0;
    for (const i of members) {
      const [a, b, c] = tris[i];
      vol += pos[a * 3] * (pos[b * 3 + 1] * pos[c * 3 + 2] - pos[b * 3 + 2] * pos[c * 3 + 1]) - pos[a * 3 + 1] * (pos[b * 3] * pos[c * 3 + 2] - pos[b * 3 + 2] * pos[c * 3]) + pos[a * 3 + 2] * (pos[b * 3] * pos[c * 3 + 1] - pos[b * 3 + 1] * pos[c * 3]);
    }
    if (vol < 0) {
      for (const i of members) {
        const t = tris[i];
        tris[i] = [t[0], t[2], t[1]];
      }
      report.shellsTurnedOutward++;
    }
  }

  // Out: indexed (welded) when there are no colours; with colours, one vertex per corner so each triangle keeps its own.
  let out: MeshPart;
  if (!part.colors) {
    const indices = new Uint32Array(tris.length * 3);
    tris.forEach((t, i) => indices.set(t, i * 3));
    out = { name: part.name, positions: Float32Array.from(pos), indices };
  } else {
    const positions = new Float32Array(tris.length * 9);
    const colors = new Uint8Array(tris.length * 9);
    tris.forEach((t, i) => {
      const s = src[i] >= 0 ? src[i] : fillColorOf.get(i) ?? 0;
      for (let k = 0; k < 3; k++) {
        positions.set(pos.slice(t[k] * 3, t[k] * 3 + 3), i * 9 + k * 3);
        const v = part.indices[s * 3]; // the source triangle's first corner colour
        colors.set(part.colors!.subarray(v * 3, v * 3 + 3), i * 9 + k * 3);
      }
    });
    out = { name: part.name, positions, indices: Uint32Array.from({ length: tris.length * 3 }, (_, i) => i), colors };
  }
  return { part: out, report };
}
