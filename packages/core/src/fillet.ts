import type { ArcEntity, LineEntity, PolylineEntity } from "./entities";
import { dist, type Point } from "./geometry";
import { intersectCurves } from "./intersect";

/**
 * Fillet and chamfer (roadmap T-17): rounding or bevelling the corner
 * where two lines meet — or would meet, once extended. Radius 0 is the
 * corner join every DXF clean-up needs: both lines trimmed/extended to
 * their intersection.
 *
 * Which side of the corner survives is decided by where each line was
 * clicked: the end of the line on the far side of the intersection from
 * the click is the one that gets replaced by the tangent point. That is
 * AutoCAD's rule, and it is what lets one fillet turn an over-long "+" of
 * two lines into a clean "L".
 */

export interface LineFillet {
  line1: LineEntity;
  line2: LineEntity;
  /** The fillet arc, or null for radius 0 (a sharp corner) — or a chamfer's bevel line. */
  arc: ArcEntity | null;
  chamfer: LineEntity | null;
}

interface Corner {
  p: Point;
  /** Unit direction from the intersection toward each line's kept end, and that end. */
  d1: Point;
  d2: Point;
  keep1: Point;
  keep2: Point;
  /** Included angle between the kept directions, (0, π). */
  theta: number;
}

/**
 * The corner two lines make, from the picks. Null when the lines are
 * parallel or a click sits exactly on the intersection (no side to keep).
 */
function cornerOf(l1: LineEntity, l2: LineEntity, near1: Point, near2: Point): Corner | null {
  const hits = intersectCurves({ kind: "segment", a: l1.a, b: l1.b }, { kind: "segment", a: l2.a, b: l2.b }, true, true);
  if (hits.length === 0) return null;
  const p = hits[0].point;
  const side = (l: LineEntity, near: Point): { d: Point; keep: Point } | null => {
    const len = dist(l.a, l.b);
    if (len < 1e-12) return null;
    const ux = (l.b.x - l.a.x) / len;
    const uy = (l.b.y - l.a.y) / len;
    // Which way along the line is the click from the intersection?
    const s = (near.x - p.x) * ux + (near.y - p.y) * uy;
    if (Math.abs(s) < 1e-12) return null;
    const sign = s > 0 ? 1 : -1;
    const d = { x: ux * sign, y: uy * sign };
    // Keep the endpoint that lies in that direction (the farther one along d).
    const sa = (l.a.x - p.x) * d.x + (l.a.y - p.y) * d.y;
    const sb = (l.b.x - p.x) * d.x + (l.b.y - p.y) * d.y;
    return { d, keep: sa >= sb ? l.a : l.b };
  };
  const s1 = side(l1, near1);
  const s2 = side(l2, near2);
  if (!s1 || !s2) return null;
  const dot = s1.d.x * s2.d.x + s1.d.y * s2.d.y;
  const theta = Math.acos(Math.max(-1, Math.min(1, dot)));
  if (theta < 1e-9 || theta > Math.PI - 1e-9) return null;
  return { p, d1: s1.d, d2: s2.d, keep1: s1.keep, keep2: s2.keep, theta };
}

/**
 * Fillets two lines with `radius` (0 = sharp corner join). Null when the
 * lines are parallel, or the radius is too large for the kept parts of
 * the lines (the tangent point would fall beyond the kept end).
 */
export function filletLines(l1: LineEntity, l2: LineEntity, radius: number, near1: Point, near2: Point): LineFillet | null {
  const c = cornerOf(l1, l2, near1, near2);
  if (!c) return null;
  if (radius <= 0) {
    return {
      line1: { ...l1, a: c.keep1, b: c.p },
      line2: { ...l2, a: c.keep2, b: c.p },
      arc: null,
      chamfer: null,
    };
  }
  const dt = radius / Math.tan(c.theta / 2);
  if (dt > dist(c.p, c.keep1) + 1e-9 || dt > dist(c.p, c.keep2) + 1e-9) return null;
  const t1 = { x: c.p.x + c.d1.x * dt, y: c.p.y + c.d1.y * dt };
  const t2 = { x: c.p.x + c.d2.x * dt, y: c.p.y + c.d2.y * dt };
  const bx = c.d1.x + c.d2.x;
  const by = c.d1.y + c.d2.y;
  const bl = Math.hypot(bx, by);
  const dc = radius / Math.sin(c.theta / 2);
  const center = { x: c.p.x + (bx / bl) * dc, y: c.p.y + (by / bl) * dc };
  const a1 = Math.atan2(t1.y - center.y, t1.x - center.x);
  const a2 = Math.atan2(t2.y - center.y, t2.x - center.x);
  // The fillet is always the minor arc between the tangent points.
  const ccwSweep = ((a2 - a1) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI);
  const ccw = ccwSweep <= Math.PI;
  return {
    line1: { ...l1, a: c.keep1, b: t1 },
    line2: { ...l2, a: c.keep2, b: t2 },
    arc: { id: "", type: "arc", ...inherit(l1), center, radius, startAngle: a1, endAngle: a2, ccw },
    chamfer: null,
  };
}

/** Chamfers two lines: a bevel `d1` back along the first line and `d2` along the second from the corner. */
export function chamferLines(l1: LineEntity, l2: LineEntity, d1: number, d2: number, near1: Point, near2: Point): LineFillet | null {
  const c = cornerOf(l1, l2, near1, near2);
  if (!c || d1 <= 0 || d2 <= 0) return null;
  if (d1 > dist(c.p, c.keep1) + 1e-9 || d2 > dist(c.p, c.keep2) + 1e-9) return null;
  const t1 = { x: c.p.x + c.d1.x * d1, y: c.p.y + c.d1.y * d1 };
  const t2 = { x: c.p.x + c.d2.x * d2, y: c.p.y + c.d2.y * d2 };
  return {
    line1: { ...l1, a: c.keep1, b: t1 },
    line2: { ...l2, a: c.keep2, b: t2 },
    arc: null,
    chamfer: { id: "", type: "line", ...inherit(l1), a: t1, b: t2 },
  };
}

function inherit(e: LineEntity): { layer?: string; color?: string; linetype?: string; lineweight?: number; linetypeScale?: number; construction?: boolean } {
  const out: { layer?: string; color?: string; linetype?: string; lineweight?: number; linetypeScale?: number; construction?: boolean } = {};
  if (e.layer !== undefined) out.layer = e.layer;
  if (e.color !== undefined) out.color = e.color;
  if (e.linetype !== undefined) out.linetype = e.linetype;
  if (e.lineweight !== undefined) out.lineweight = e.lineweight;
  if (e.linetypeScale !== undefined) out.linetypeScale = e.linetypeScale;
  if (e.construction !== undefined) out.construction = e.construction;
  return out;
}

/**
 * Rounds one corner of a polyline in place: the vertex between two
 * straight legs becomes two tangent points joined by an arc leg (a bulge).
 * Null when either leg is already an arc, too short for the radius, or
 * the vertex is an open end.
 */
export function filletPolylineCorner(pl: PolylineEntity, vertex: number, radius: number): PolylineEntity | null {
  const n = pl.points.length;
  if (n < 3 || radius <= 0) return null;
  const prev = (vertex - 1 + n) % n;
  const next = (vertex + 1) % n;
  if (!pl.closed && (vertex === 0 || vertex === n - 1)) return null;
  const bulges = pl.bulges ?? [];
  const legIn = pl.closed ? prev : prev; // leg prev→vertex has index prev
  const legOut = vertex; // leg vertex→next
  if ((bulges[legIn] ?? 0) !== 0 || (bulges[legOut] ?? 0) !== 0) return null;
  const p = pl.points[vertex];
  const a = pl.points[prev];
  const b = pl.points[next];
  const la = dist(p, a);
  const lb = dist(p, b);
  if (la < 1e-12 || lb < 1e-12) return null;
  const d1 = { x: (a.x - p.x) / la, y: (a.y - p.y) / la };
  const d2 = { x: (b.x - p.x) / lb, y: (b.y - p.y) / lb };
  const theta = Math.acos(Math.max(-1, Math.min(1, d1.x * d2.x + d1.y * d2.y)));
  if (theta < 1e-9 || theta > Math.PI - 1e-9) return null;
  const dt = radius / Math.tan(theta / 2);
  if (dt > la + 1e-9 || dt > lb + 1e-9) return null;
  const t1 = { x: p.x + d1.x * dt, y: p.y + d1.y * dt };
  const t2 = { x: p.x + d2.x * dt, y: p.y + d2.y * dt };
  // The arc turns through (π − θ); its bulge sign follows the corner's turn direction.
  const cross = d1.x * d2.y - d1.y * d2.x;
  const included = Math.PI - theta;
  const bulge = Math.tan(included / 4) * (cross < 0 ? 1 : -1);
  const points = [...pl.points];
  const newBulges = Array.from({ length: pl.closed ? n : n - 1 }, (_, i) => bulges[i] ?? 0);
  points.splice(vertex, 1, t1, t2);
  // Legs: ...prev→t1 (straight), t1→t2 (arc), t2→next (straight)...
  newBulges.splice(vertex, 0, bulge);
  return { ...pl, points, bulges: newBulges };
}

/** Rounds every corner of a polyline that can take the radius; corners that can't are left sharp. */
export function filletAllCorners(pl: PolylineEntity, radius: number): PolylineEntity {
  let out = pl;
  // Each success inserts a vertex; walk by original corner, adjusting the index.
  let i = 0;
  let remaining = pl.points.length;
  while (remaining > 0) {
    const r = filletPolylineCorner(out, i, radius);
    if (r) {
      out = r;
      i += 2;
    } else {
      i += 1;
    }
    remaining -= 1;
  }
  return out;
}
