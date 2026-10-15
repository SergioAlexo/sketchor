/**
 * F-05 — "mesh mode" topology. A mesh file has no B-rep, so faces are
 * recovered as connected regions of triangles whose neighbours meet at less
 * than a dihedral threshold (default 20 degrees): flat panels become one face,
 * a smooth fillet or sphere stays one face, a sharp crease starts a new one.
 * The output has the shape occt-import-js produces (per-face triangle ranges,
 * each face with its own vertices), so `buildModel` and `topology.ts` turn
 * the boundaries between regions into edges with no further special-casing.
 */
import type { MeshPart } from "./parse";

export interface SegmentedMesh {
  name: string;
  color?: [number, number, number];
  brep_faces: { first: number; last: number; color: [number, number, number] | null }[];
  attributes: { position: { array: Float32Array } };
  index: { array: Uint32Array };
}

export const DEFAULT_DIHEDRAL_DEG = 20;

export function segmentMesh(part: MeshPart, dihedralDeg = DEFAULT_DIHEDRAL_DEG): SegmentedMesh {
  const { positions, indices } = part;
  const nv = positions.length / 3;
  // Weld vertices that coincide (STL stores every triangle's corners separately).
  let min = Infinity, max = -Infinity;
  for (let i = 0; i < positions.length; i++) {
    const v = positions[i];
    if (v < min) min = v;
    if (v > max) max = v;
  }
  const cell = Math.max((max - min) * 1e-6, 1e-9);
  const weldOf = new Int32Array(nv);
  const weldPos: number[] = [];
  const seen = new Map<string, number>();
  for (let i = 0; i < nv; i++) {
    const k = `${Math.round(positions[i * 3] / cell)},${Math.round(positions[i * 3 + 1] / cell)},${Math.round(positions[i * 3 + 2] / cell)}`;
    let w = seen.get(k);
    if (w === undefined) {
      w = seen.size;
      seen.set(k, w);
      weldPos.push(positions[i * 3], positions[i * 3 + 1], positions[i * 3 + 2]);
    }
    weldOf[i] = w;
  }
  seen.clear();
  const nw = weldPos.length / 3;

  // Triangles, dropping degenerate ones (zero area or a collapsed corner).
  const tris: number[] = []; // welded ids, 3 per kept triangle
  const src: number[] = []; // original triangle number of each kept one
  const nrm: number[] = [];
  for (let t = 0; t + 2 < indices.length; t += 3) {
    const a = weldOf[indices[t]], b = weldOf[indices[t + 1]], c = weldOf[indices[t + 2]];
    if (a === b || b === c || a === c) continue;
    const ux = weldPos[b * 3] - weldPos[a * 3], uy = weldPos[b * 3 + 1] - weldPos[a * 3 + 1], uz = weldPos[b * 3 + 2] - weldPos[a * 3 + 2];
    const vx = weldPos[c * 3] - weldPos[a * 3], vy = weldPos[c * 3 + 1] - weldPos[a * 3 + 1], vz = weldPos[c * 3 + 2] - weldPos[a * 3 + 2];
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const len = Math.hypot(nx, ny, nz);
    if (!(len > 0)) continue;
    tris.push(a, b, c);
    src.push(t / 3);
    nrm.push(nx / len, ny / len, nz / len);
  }
  const nt = tris.length / 3;

  // Edge -> triangles (CSR adjacency built from pairs).
  const first = new Map<number, number>();
  const pa: number[] = [];
  const pb: number[] = [];
  for (let t = 0; t < nt; t++) {
    for (let e = 0; e < 3; e++) {
      const u = tris[t * 3 + e], w = tris[t * 3 + (e + 1) % 3];
      const key = Math.min(u, w) * nw + Math.max(u, w);
      const o = first.get(key);
      if (o === undefined) first.set(key, t);
      else {
        pa.push(o);
        pb.push(t);
      }
    }
  }
  first.clear();
  const deg = new Uint32Array(nt + 1);
  for (let i = 0; i < pa.length; i++) {
    deg[pa[i] + 1]++;
    deg[pb[i] + 1]++;
  }
  for (let i = 0; i < nt; i++) deg[i + 1] += deg[i];
  const fill = deg.slice(0, nt);
  const adj = new Uint32Array(pa.length * 2);
  for (let i = 0; i < pa.length; i++) {
    adj[fill[pa[i]]++] = pb[i];
    adj[fill[pb[i]]++] = pa[i];
  }

  // Flood fill across smooth edges.
  const cosT = Math.cos((dihedralDeg * Math.PI) / 180);
  const region = new Int32Array(nt).fill(-1);
  const order: number[] = []; // triangles grouped by region
  const ranges: [number, number][] = [];
  const stack: number[] = [];
  for (let s = 0; s < nt; s++) {
    if (region[s] >= 0) continue;
    const r = ranges.length;
    const startAt = order.length;
    region[s] = r;
    stack.push(s);
    while (stack.length) {
      const t = stack.pop()!;
      order.push(t);
      for (let k = deg[t]; k < deg[t + 1]; k++) {
        const n = adj[k];
        if (region[n] >= 0) continue;
        if (nrm[t * 3] * nrm[n * 3] + nrm[t * 3 + 1] * nrm[n * 3 + 1] + nrm[t * 3 + 2] * nrm[n * 3 + 2] >= cosT) {
          region[n] = r;
          stack.push(n);
        }
      }
    }
    ranges.push([startAt, order.length - 1]);
  }

  // Emit: every region gets its own vertices so normals and colours stay per face.
  const outPos: number[] = [];
  const outIdx = new Uint32Array(nt * 3);
  const brep: SegmentedMesh["brep_faces"] = [];
  const colors = part.colors;
  for (const [a, b] of ranges) {
    const local = new Map<number, number>();
    let sr = 0, sg = 0, sb = 0, sc = 0;
    for (let i = a; i <= b; i++) {
      const t = order[i];
      for (let e = 0; e < 3; e++) {
        const w = tris[t * 3 + e];
        let l = local.get(w);
        if (l === undefined) {
          l = outPos.length / 3;
          local.set(w, l);
          outPos.push(weldPos[w * 3], weldPos[w * 3 + 1], weldPos[w * 3 + 2]);
        }
        outIdx[i * 3 + e] = l;
        if (colors) {
          const o = indices[src[t] * 3 + e] * 3;
          sr += colors[o]; sg += colors[o + 1]; sb += colors[o + 2]; sc++;
        }
      }
    }
    let color: [number, number, number] | null = null;
    if (colors && sc) {
      color = [sr / sc / 255, sg / sc / 255, sb / sc / 255];
    }
    brep.push({ first: a, last: b, color });
  }
  return {
    name: part.name,
    brep_faces: brep,
    attributes: { position: { array: Float32Array.from(outPos) } },
    index: { array: outIdx },
  };
}
