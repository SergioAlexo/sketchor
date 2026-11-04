import type { Entity } from "../entities";
import { translated } from "../entities";
import { boundsOf } from "../dxf";
import { planeBasis, projectEdge, type PlaneBasis, type ProjectableEdge, type V3 } from "./outline";

/**
 * 3D to 2D, step two (plan F-07): a view-plane projection with hidden lines
 * removed. Pure: the web layer hands in the tessellation and the B-rep edge
 * chains from `topology.ts` as plain arrays.
 *
 * Method: rasterise every triangle into a z-buffer on the view plane, then
 * walk each edge chain in small steps and keep only the stretches that sit at
 * (or in front of) the buffered depth. Edges that survive whole keep their
 * exact circle/arc; partly hidden circles become exact arcs; everything else
 * is a line or polyline. Smooth surfaces have no B-rep edge on their contour,
 * so mesh edges between a front- and a back-facing triangle of the same
 * curved face are added as silhouette lines.
 *
 * Failure modes this guards: a hidden hole drawn through a plate (depth
 * tolerance too loose), a visible edge dropped (too tight), a cylinder
 * seen from the side with no contour lines, duplicates from edges that land
 * on top of each other, and NaN from an empty model.
 */

export interface ProjectMesh {
  /** xyz triplets. */
  positions: ArrayLike<number>;
  /** Triangle vertex indices. */
  indices: ArrayLike<number>;
  /** Per-vertex normals, parallel to positions; without them the winding decides what faces the viewer. */
  normals?: ArrayLike<number>;
  /** Per triangle: its face id (needed for silhouettes). */
  faceOfTriangle?: ArrayLike<number>;
  /** Per face id: 1 when planar (planar faces get no silhouette lines). */
  facePlanar?: ArrayLike<number>;
}

export interface ViewOptions {
  /** In-plane direction that should point up on screen (default world Z, or Y when looking along Z). */
  up?: V3;
  layer?: string;
  /** Z-buffer cells along the longer side (default 1024). */
  resolution?: number;
  /** Add contour lines of curved faces (default true). */
  silhouettes?: boolean;
}

const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

/**
 * Project a model along `dir` (the direction from the model toward the
 * viewer). Returns null for a zero direction; an empty model gives no entities.
 */
export function projectView(
  mesh: ProjectMesh,
  edges: ProjectableEdge[],
  dir: V3,
  opts: ViewOptions = {},
): { entities: Entity[]; basis: PlaneBasis } | null {
  const up: V3 = opts.up ?? (Math.abs(dir[2]) > 0.999 * Math.hypot(...dir) ? [0, 1, 0] : [0, 0, 1]);
  // planeBasis takes the in-plane +X hint, and u = up x n puts `up` on screen's +Y.
  const nn = planeBasis(dir, [0, 0, 0]);
  if (!nn) return null;
  const hintU: V3 = [up[1] * nn.n[2] - up[2] * nn.n[1], up[2] * nn.n[0] - up[0] * nn.n[2], up[0] * nn.n[1] - up[1] * nn.n[0]];
  const basis = planeBasis(dir, [0, 0, 0], hintU);
  if (!basis) return null;
  const n = basis.n;
  const P = mesh.positions;
  const I = mesh.indices;
  const triCount = Math.floor(I.length / 3);
  if (triCount === 0 && edges.length === 0) return { entities: [], basis };

  // ---- view-space bounds: (u, v, depth) --------------------------------
  let minU = Infinity, minV = Infinity, maxU = -Infinity, maxV = -Infinity, minD = Infinity, maxD = -Infinity;
  const grow = (x: number, y: number, zz: number) => {
    const p: V3 = [x, y, zz];
    const a = dot(p, basis.u), b = dot(p, basis.v), d = dot(p, n);
    if (![a, b, d].every(Number.isFinite)) return;
    if (a < minU) minU = a;
    if (a > maxU) maxU = a;
    if (b < minV) minV = b;
    if (b > maxV) maxV = b;
    if (d < minD) minD = d;
    if (d > maxD) maxD = d;
  };
  for (let i = 0; i + 2 < P.length; i += 3) grow(P[i], P[i + 1], P[i + 2]);
  for (const e of edges) for (let i = 0; i + 2 < e.points.length; i += 3) grow(e.points[i], e.points[i + 1], e.points[i + 2]);
  if (!Number.isFinite(minU)) return { entities: [], basis };

  const extent = Math.max(maxU - minU, maxV - minV, 1e-9);
  const res = Math.max(16, Math.min(opts.resolution ?? 1024, 4096));
  const cell = extent / res;
  const W = Math.ceil((maxU - minU) / cell) + 3;
  const H = Math.ceil((maxV - minV) / cell) + 3;
  const z = new Float32Array(W * H).fill(-Infinity);
  const gx = (u: number) => (u - minU) / cell + 1;
  const gy = (v: number) => (v - minV) / cell + 1;

  // ---- rasterise triangles ---------------------------------------------
  const tu = new Float64Array(3), tv = new Float64Array(3), td = new Float64Array(3);
  for (let t = 0; t < triCount; t++) {
    let ok = true;
    for (let k = 0; k < 3; k++) {
      const o = I[t * 3 + k] * 3;
      const p: V3 = [P[o], P[o + 1], P[o + 2]];
      tu[k] = gx(dot(p, basis.u));
      tv[k] = gy(dot(p, basis.v));
      td[k] = dot(p, n);
      if (!Number.isFinite(tu[k] + tv[k] + td[k])) ok = false;
    }
    if (!ok) continue;
    const area = (tu[1] - tu[0]) * (tv[2] - tv[0]) - (tu[2] - tu[0]) * (tv[1] - tv[0]);
    if (Math.abs(area) < 1e-12) continue; // edge-on: covers no cells
    const x0 = Math.max(0, Math.floor(Math.min(tu[0], tu[1], tu[2]) - 0.5));
    const x1 = Math.min(W - 1, Math.ceil(Math.max(tu[0], tu[1], tu[2]) + 0.5));
    const y0 = Math.max(0, Math.floor(Math.min(tv[0], tv[1], tv[2]) - 0.5));
    const y1 = Math.min(H - 1, Math.ceil(Math.max(tv[0], tv[1], tv[2]) + 0.5));
    const eps = -1e-6;
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const px = x + 0.5, py = y + 0.5;
        const w0 = ((tu[1] - px) * (tv[2] - py) - (tu[2] - px) * (tv[1] - py)) / area;
        const w1 = ((tu[2] - px) * (tv[0] - py) - (tu[0] - px) * (tv[2] - py)) / area;
        const w2 = 1 - w0 - w1;
        if (w0 < eps || w1 < eps || w2 < eps) continue;
        const d = w0 * td[0] + w1 * td[1] + w2 * td[2];
        const idx = y * W + x;
        if (d > z[idx]) z[idx] = d;
      }
    }
  }

  // Depth slack: an edge sits on its face, so it needs room for the buffer's
  // cell-size sampling error but must stay well under real step heights.
  const tol = Math.max((maxD - minD) * 1e-3, cell * 2);
  const visibleAt = (p: V3): boolean => {
    const x = Math.floor(gx(dot(p, basis.u))), y = Math.floor(gy(dot(p, basis.v)));
    if (x < 0 || y < 0 || x >= W || y >= H) return true;
    // Least-covered neighbour: at a grazing contour the buffer jumps by far
    // more than any depth slack, and a silhouette must still count as seen.
    let zmin = Infinity;
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const xx = x + dx, yy = y + dy;
        if (xx < 0 || yy < 0 || xx >= W || yy >= H) continue;
        const v = z[yy * W + xx];
        if (v < zmin) zmin = v;
      }
    }
    return dot(p, n) >= zmin - tol;
  };

  // ---- silhouette edges of curved faces -------------------------------
  const all: ProjectableEdge[] = edges.slice();
  if (opts.silhouettes !== false && mesh.faceOfTriangle && mesh.facePlanar) {
    const facing = new Int8Array(triCount);
    for (let t = 0; t < triCount; t++) {
      let s = 0;
      if (mesh.normals) {
        for (let k = 0; k < 3; k++) {
          const o = I[t * 3 + k] * 3;
          s += mesh.normals[o] * n[0] + mesh.normals[o + 1] * n[1] + mesh.normals[o + 2] * n[2];
        }
      } else {
        const v = (k: number): V3 => [P[I[t * 3 + k] * 3], P[I[t * 3 + k] * 3 + 1], P[I[t * 3 + k] * 3 + 2]];
        const a = v(0), b = sub(v(1), a), c = sub(v(2), a);
        s = (b[1] * c[2] - b[2] * c[1]) * n[0] + (b[2] * c[0] - b[0] * c[2]) * n[1] + (b[0] * c[1] - b[1] * c[0]) * n[2];
      }
      facing[t] = s > 1e-9 ? 1 : s < -1e-9 ? -1 : 0;
    }
    const seen = new Map<number, number>();
    const vc = P.length / 3;
    for (let t = 0; t < triCount; t++) {
      const f = mesh.faceOfTriangle[t];
      if (mesh.facePlanar[f] === 1) continue;
      for (let k = 0; k < 3; k++) {
        const a = I[t * 3 + k], b = I[t * 3 + ((k + 1) % 3)];
        const key = a < b ? a * vc + b : b * vc + a;
        const other = seen.get(key);
        if (other === undefined) {
          seen.set(key, t);
          continue;
        }
        seen.delete(key);
        if (mesh.faceOfTriangle[other] !== f || facing[other] * facing[t] >= 0) continue;
        all.push({ kind: "line", points: [P[a * 3], P[a * 3 + 1], P[a * 3 + 2], P[b * 3], P[b * 3 + 1], P[b * 3 + 2]] });
      }
    }
  }

  // ---- visible stretches of every edge ----------------------------------
  const step = cell * 0.75;
  const planeLen = (a: V3, b: V3) => {
    const d = sub(a, b);
    return Math.hypot(dot(d, basis.u), dot(d, basis.v));
  };
  const out: Entity[] = [];
  for (const e of all) {
    const pts = e.points;
    const m = Math.floor(pts.length / 3);
    if (m < 2) continue;
    // Resample the chain at <= step spacing (in the view plane).
    const samples: V3[] = [];
    for (let i = 0; i < m; i++) {
      const a: V3 = [pts[i * 3], pts[i * 3 + 1], pts[i * 3 + 2]];
      if (!a.every(Number.isFinite)) continue;
      if (samples.length > 0) {
        const prev = samples[samples.length - 1];
        const k = Math.min(Math.ceil(planeLen(a, prev) / step), 4096);
        for (let s = 1; s < k; s++) {
          const f = s / k;
          samples.push([prev[0] + (a[0] - prev[0]) * f, prev[1] + (a[1] - prev[1]) * f, prev[2] + (a[2] - prev[2]) * f]);
        }
      }
      samples.push(a);
    }
    if (samples.length < 2) continue;
    const vis = samples.map(visibleAt);
    if (vis.every(Boolean)) {
      out.push(...projectEdge(basis, e, opts.layer));
      continue;
    }
    let s = 0;
    while (s < samples.length) {
      if (!vis[s]) {
        s++;
        continue;
      }
      let t = s;
      while (t + 1 < samples.length && vis[t + 1]) t++;
      if (t > s) {
        const run = samples.slice(s, t + 1);
        const flat: number[] = [];
        for (const p of run) flat.push(p[0], p[1], p[2]);
        if (planeLen(run[run.length - 1], run[0]) >= cell * 1.5 || run.length > 2) {
          if (e.kind === "line") out.push(...projectEdge(basis, { kind: "line", points: [...run[0], ...run[run.length - 1]] }, opts.layer));
          else out.push(...projectEdge(basis, { ...e, kind: e.kind === "circle" ? "arc" : e.kind, points: flat }, opts.layer));
        }
      }
      s = t + 1;
    }
  }

  // ---- tidy: edge-on curves, coincident duplicates, origin shift ---------
  const tidy = collapseDegenerate(dedupe(out), extent);
  const b = boundsOf(tidy);
  const entities = b ? tidy.map((e) => translated(e, -b.minX, -b.minY)) : tidy;
  return { entities, basis };
}

/** A polyline whose points all lie on one line (a circle seen edge-on) becomes that line. */
function collapseDegenerate(ents: Entity[], extent: number): Entity[] {
  const eps = extent * 1e-7;
  const res: Entity[] = [];
  for (const e of ents) {
    if (e.type === "polyline" && e.points.length >= 2) {
      const p0 = e.points[0];
      let best = 0;
      let far = p0;
      for (const p of e.points) {
        const d = Math.hypot(p.x - p0.x, p.y - p0.y);
        if (d > best) {
          best = d;
          far = p;
        }
      }
      if (best > 0) {
        const dx = (far.x - p0.x) / best, dy = (far.y - p0.y) / best;
        if (e.points.every((p) => Math.abs((p.x - p0.x) * dy - (p.y - p0.y) * dx) <= eps)) {
          let lo = p0, hi = p0, tl = 0, th = 0;
          for (const p of e.points) {
            const t = (p.x - p0.x) * dx + (p.y - p0.y) * dy;
            if (t < tl) {
              tl = t;
              lo = p;
            }
            if (t > th) {
              th = t;
              hi = p;
            }
          }
          res.push({ id: e.id, type: "line", ...(e.layer ? { layer: e.layer } : {}), a: lo, b: hi });
          continue;
        }
      }
    }
    res.push(e);
  }
  return res;
}

/** Drops lines/circles/arcs that coincide with an earlier one (a box's top and bottom edges in a top view). */
function dedupe(ents: Entity[]): Entity[] {
  const seen = new Set<string>();
  const r = (v: number) => Math.round(v * 1e4);
  const res: Entity[] = [];
  for (const e of ents) {
    let key: string | null = null;
    if (e.type === "line") {
      const a = `${r(e.a.x)},${r(e.a.y)}`, b = `${r(e.b.x)},${r(e.b.y)}`;
      key = `L${a < b ? a + "|" + b : b + "|" + a}`;
    } else if (e.type === "circle") key = `C${r(e.center.x)},${r(e.center.y)},${r(e.radius)}`;
    else if (e.type === "arc") key = `A${r(e.center.x)},${r(e.center.y)},${r(e.radius)},${r(e.startAngle)},${r(e.endAngle)},${e.ccw ? 1 : 0}`;
    if (key !== null) {
      if (seen.has(key)) continue;
      seen.add(key);
    }
    res.push(e);
  }
  return res;
}
