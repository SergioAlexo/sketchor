import type { ArcEntity, CircleEntity, Entity, LineEntity, PolylineEntity } from "../entities";
import { newEntityId, translated } from "../entities";
import { boundsOf } from "../dxf";
import { joinEntities } from "../joinExplode";
import type { Point } from "../geometry";

/**
 * 3D to 2D, step one (plan F-07): turn the boundary edges of a flat face into
 * 2D lines, arcs, circles and polylines. Pure and structural - the web layer
 * reads its `Model3D` tables and hands plain arrays in, so this has no idea
 * where the edges came from.
 *
 * Why it matters: a laser shop wants the outline of a sheet-metal part's flat
 * face as a DXF. If the circle/arc recognition regresses, every hole comes
 * out as a 32-gon; if the basis flips handedness, the part comes out mirrored
 * and is cut backwards.
 */

export type V3 = [number, number, number];

/** An orthonormal frame on a plane. `u x v = n`, so the face reads correctly when seen from its outside. */
export interface PlaneBasis {
  origin: V3;
  u: V3;
  v: V3;
  n: V3;
}

/** One 3D edge as the topology extractor describes it. */
export interface ProjectableEdge {
  kind: "line" | "circle" | "arc" | "curve";
  /** The chain in order, xyz triplets (a closed chain repeats its first point). */
  points: ArrayLike<number>;
  center?: V3;
  radius?: number;
  normal?: V3;
}

const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const len = (a: V3) => Math.hypot(a[0], a[1], a[2]);
const unit = (a: V3): V3 => {
  const l = len(a);
  return l > 0 ? [a[0] / l, a[1] / l, a[2] / l] : [0, 0, 0];
};

/**
 * A frame for `normal` at `origin`. `hint` picks the in-plane direction of +X
 * (its projection onto the plane); without one, X is world-Z cross normal (or
 * world-X for a horizontal plane) so vertical planes read upright. A zero or
 * non-finite normal returns null.
 */
export function planeBasis(normal: V3, origin: V3, hint?: V3): PlaneBasis | null {
  if (!normal.every(Number.isFinite) || len(normal) === 0) return null;
  const n = unit(normal);
  let u: V3 | null = null;
  if (hint && hint.every(Number.isFinite)) {
    const d = dot(hint, n);
    const p: V3 = [hint[0] - d * n[0], hint[1] - d * n[1], hint[2] - d * n[2]];
    if (len(p) > 1e-9) u = unit(p);
  }
  if (!u) u = Math.abs(n[2]) > 0.999 ? [1, 0, 0] : unit(cross([0, 0, 1], n));
  const v = unit(cross(n, u));
  return { origin, u, v, n };
}

export function toPlane(b: PlaneBasis, p: ArrayLike<number>, o = 0): Point {
  const d: V3 = [p[o] - b.origin[0], p[o + 1] - b.origin[1], p[o + 2] - b.origin[2]];
  return { x: dot(d, b.u), y: dot(d, b.v) };
}

export interface OutlineOptions {
  layer?: string;
  /** Chain end-to-end pieces into polylines (default true). */
  join?: boolean;
  /** Look at the face from behind (mirrors X). */
  flip?: boolean;
  /** Direction that should run along +X; default = the face's longest straight edge. */
  alignTo?: V3;
}

/** One edge to 2D entities in the plane frame. Arcs/circles not parallel to the plane fall back to their tessellation. */
export function projectEdge(basis: PlaneBasis, e: ProjectableEdge, layer?: string): Entity[] {
  const pts: Point[] = [];
  for (let i = 0; i + 2 < e.points.length; i += 3) {
    const p = toPlane(basis, e.points, i);
    if (Number.isFinite(p.x) && Number.isFinite(p.y)) pts.push(p);
  }
  if (pts.length < 2) return [];
  const base = layer ? { layer } : {};
  const first = pts[0];
  const last = pts[pts.length - 1];
  const parallel = e.normal !== undefined && Math.abs(dot(unit(e.normal), basis.n)) > 1 - 1e-6;
  const isCurve = (e.kind === "circle" || e.kind === "arc") && parallel && e.center !== undefined && (e.radius ?? 0) > 0;

  if (isCurve) {
    const c = toPlane(basis, e.center!);
    const r = e.radius!;
    if (e.kind === "circle" || Math.hypot(first.x - last.x, first.y - last.y) < r * 1e-6) {
      const circle: CircleEntity = { id: newEntityId(), type: "circle", ...base, center: c, radius: r };
      return [circle];
    }
    // Direction: the sum of signed angle steps along the chain.
    let turn = 0;
    let prev = Math.atan2(first.y - c.y, first.x - c.x);
    for (let i = 1; i < pts.length; i++) {
      const a = Math.atan2(pts[i].y - c.y, pts[i].x - c.x);
      let d = a - prev;
      while (d > Math.PI) d -= 2 * Math.PI;
      while (d < -Math.PI) d += 2 * Math.PI;
      turn += d;
      prev = a;
    }
    const arc: ArcEntity = {
      id: newEntityId(),
      type: "arc",
      ...base,
      center: c,
      radius: r,
      startAngle: Math.atan2(first.y - c.y, first.x - c.x),
      endAngle: Math.atan2(last.y - c.y, last.x - c.x),
      ccw: turn >= 0,
    };
    return [arc];
  }

  if (e.kind === "line" || pts.length === 2) {
    if (Math.hypot(first.x - last.x, first.y - last.y) < 1e-9) return [];
    const line: LineEntity = { id: newEntityId(), type: "line", ...base, a: first, b: last };
    return [line];
  }
  // Consecutive duplicates (an edge seen edge-on collapses) go first.
  const cleaned = pts.filter((p, i) => i === 0 || Math.hypot(p.x - pts[i - 1].x, p.y - pts[i - 1].y) > 1e-9);
  if (cleaned.length < 2) return [];
  const closed =
    cleaned.length > 2 &&
    Math.hypot(cleaned[0].x - cleaned[cleaned.length - 1].x, cleaned[0].y - cleaned[cleaned.length - 1].y) < 1e-9;
  const poly: PolylineEntity = {
    id: newEntityId(),
    type: "polyline",
    ...base,
    points: closed ? cleaned.slice(0, -1) : cleaned,
    closed,
  };
  return [poly];
}

/**
 * The flat outline of a planar face: every boundary edge projected into the
 * plane, shifted so the bounding box starts at (0,0) (a laser shop wants the
 * part at the origin) and end-to-end pieces chained into polylines. Returns
 * null for a degenerate normal.
 */
export function flatFaceOutline(
  normal: V3,
  origin: V3,
  edges: ProjectableEdge[],
  opts: OutlineOptions = {},
): { entities: Entity[]; basis: PlaneBasis } | null {
  let hint = opts.alignTo;
  if (!hint) {
    let best = 0;
    for (const e of edges) {
      const n = e.points.length;
      if (e.kind !== "line" || n < 6) continue;
      const d: V3 = [e.points[n - 3] - e.points[0], e.points[n - 2] - e.points[1], e.points[n - 1] - e.points[2]];
      const l = len(d);
      if (l > best) {
        best = l;
        hint = d;
      }
    }
  }
  let basis = planeBasis(normal, origin, hint);
  if (!basis) return null;
  if (opts.flip) basis = { ...basis, u: [-basis.u[0], -basis.u[1], -basis.u[2]], n: [-basis.n[0], -basis.n[1], -basis.n[2]] };
  let ents: Entity[] = [];
  for (const e of edges) ents.push(...projectEdge(basis, e, opts.layer));
  if (ents.length === 0) return { entities: [], basis };
  if (opts.join !== false) {
    const chains = joinEntities(ents);
    if (chains.length) {
      const gone = new Set(chains.flatMap((c) => c.replaced));
      ents = ents.filter((e) => !gone.has(e.id));
      for (const c of chains) ents.push(opts.layer ? { ...c.polyline, layer: opts.layer } : c.polyline);
    }
  }
  const b = boundsOf(ents);
  if (b) ents = ents.map((e) => translated(e, -b.minX, -b.minY));
  return { entities: ents, basis };
}
