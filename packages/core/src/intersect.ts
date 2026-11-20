import type { ArcEntity, CircleEntity, EllipseEntity, Entity, LineEntity, PolylineEntity, SplineEntity } from "./entities";
import {
  closestEllipseParam,
  ellipseParamOfPoint,
  ellipsePointAt,
  ellipseSweep,
  ellipseTangentAt,
  isFullEllipse,
  tessellateEllipse,
  type EllipseGeom,
} from "./ellipse";
import { closestNurbsParam, isClamped, isValidNurbs, nurbsDomain, nurbsEval, nurbsPointAt, splitNurbs, tessellateNurbs, type NurbsData } from "./nurbs";
import { polylineSegments } from "./entities";
import { kindPath } from "./kinds/registry";
import { angleInSweep, arcPointAt, arcSweep, bulgeToArc, dist, type Point } from "./geometry";

/**
 * The intersection library (roadmap T-16): every drawable entity broken
 * into parametric curves, pairwise intersections with the parameter on
 * each curve, and splitting/re-assembly — the shared base of trim, extend,
 * split, fillet, offset, and the intersection snap.
 *
 * A curve is a straight segment or a circular arc (a circle is an arc of
 * one full turn). Its parameter `t` runs 0→1 from start to end. An entity
 * becomes a `Path`: an ordered list of curves plus whether it closes back
 * on itself, so a position on any entity is one number, `u = curve index
 * + t`, which is what trim sorts by.
 *
 * Tolerances are absolute world units (millimetres): coordinates of real
 * drawings are far larger than 1e-9, and relative epsilons on near-zero
 * denominators are what turn "touching" into "missed".
 */

export type Curve =
  | { kind: "segment"; a: Point; b: Point }
  | { kind: "arc"; center: Point; radius: number; startAngle: number; endAngle: number; ccw: boolean; full?: boolean };

export interface Path {
  curves: Curve[];
  closed: boolean;
}

/**
 * Curves with no closed-form intersection (C-08). An ellipse arc is its
 * `EllipseGeom` restricted to `start..end`; a NURBS curve is a clamped
 * `NurbsData` over its own domain. `t` still runs 0→1. Only
 * {@link exactPathOf} produces them, and only the trim/split/extend family
 * is taught about them; offset, join, snapping and G-code keep calling
 * {@link pathOf}, which still hands back segment/arc chains.
 */
export type EllipseCurve = { kind: "ellipse"; e: EllipseGeom };
export type NurbsCurve = { kind: "nurbs"; s: NurbsData };
export type XCurve = Curve | EllipseCurve | NurbsCurve;
export interface XPath {
  curves: XCurve[];
  closed: boolean;
}

const EPS = 1e-9;
/** Two intersection points closer than this are the same point (a tangency, or an endpoint both curves share). */
const MERGE_TOL = 1e-6;
const TAU = Math.PI * 2;

/* --------------------------------- paths --------------------------------- */

/** The entity as a path of curves, or null for entity types with no stroke (text, image, point). */
export function pathOf(entity: Entity): Path | null {
  switch (entity.type) {
    case "line": {
      if (!entity.infinite) return { curves: [{ kind: "segment", a: entity.a, b: entity.b }], closed: false };
      // A construction line: a segment long enough to stand in for the whole line.
      const dx = entity.b.x - entity.a.x;
      const dy = entity.b.y - entity.a.y;
      const l = Math.hypot(dx, dy) || 1;
      const reach = 1e7;
      const a = { x: entity.a.x - (dx / l) * reach, y: entity.a.y - (dy / l) * reach };
      const b = { x: entity.b.x + (dx / l) * reach, y: entity.b.y + (dy / l) * reach };
      return { curves: [{ kind: "segment", a, b }], closed: false };
    }
    case "circle":
      return {
        curves: [{ kind: "arc", center: entity.center, radius: entity.radius, startAngle: 0, endAngle: TAU, ccw: true, full: true }],
        closed: true,
      };
    case "arc":
      return {
        curves: [
          {
            kind: "arc",
            center: entity.center,
            radius: entity.radius,
            startAngle: entity.startAngle,
            endAngle: entity.endAngle,
            ccw: entity.ccw,
          },
        ],
        closed: false,
      };
    case "polyline": {
      const curves: Curve[] = [];
      for (const seg of polylineSegments(entity)) {
        if (dist(seg.a, seg.b) < EPS) continue;
        const arc = bulgeToArc(seg.a, seg.b, seg.bulge);
        curves.push(arc ? { kind: "arc", ...arc } : { kind: "segment", a: seg.a, b: seg.b });
      }
      return curves.length > 0 ? { curves, closed: entity.closed && curves.length > 1 } : null;
    }
    default:
      return kindPath(entity as Entity);
  }
}

/**
 * Like {@link pathOf}, but an ellipse and a clamped spline stay one exact
 * curve instead of becoming a chain of tiny segments. An unclamped
 * (periodic) spline falls back to the chain: it cannot be split exactly.
 */
export function exactPathOf(entity: Entity): XPath | null {
  if (entity.type === "ellipse") {
    const e = entity as EllipseEntity;
    const sweep = ellipseSweep(e);
    const geom: EllipseGeom = { center: e.center, majorAxis: e.majorAxis, ratio: e.ratio, start: e.start, end: e.start + sweep };
    return { curves: [{ kind: "ellipse", e: geom }], closed: isFullEllipse(geom) };
  }
  if (entity.type === "spline") {
    const sp = entity as SplineEntity;
    const s: NurbsData = { degree: sp.degree, controlPoints: sp.controlPoints, knots: sp.knots, ...(sp.weights ? { weights: sp.weights } : {}) };
    if (isValidNurbs(s) && isClamped(s)) {
      const [lo, hi] = nurbsDomain(s);
      return { curves: [{ kind: "nurbs", s }], closed: sp.closed && dist(nurbsPointAt(s, lo), nurbsPointAt(s, hi)) < MERGE_TOL };
    }
  }
  return pathOf(entity);
}

/** Signed sweep of an arc in radians (positive ccw), a full turn for a circle. */
function sweepOf(c: Extract<Curve, { kind: "arc" }>): number {
  if (c.full) return TAU;
  const s = arcSweep(c.startAngle, c.endAngle, c.ccw);
  return c.ccw ? s : -s;
}

const ellipseParam = (c: EllipseCurve, t: number): number => c.e.start + ellipseSweep(c.e) * t;
const nurbsParam = (c: NurbsCurve, t: number): number => {
  const [lo, hi] = nurbsDomain(c.s);
  return lo + (hi - lo) * Math.min(1, Math.max(0, t));
};

export function pointAt(c: XCurve, t: number): Point {
  if (c.kind === "segment") return { x: c.a.x + (c.b.x - c.a.x) * t, y: c.a.y + (c.b.y - c.a.y) * t };
  if (c.kind === "ellipse") return ellipsePointAt(c.e, ellipseParam(c, t));
  if (c.kind === "nurbs") return nurbsPointAt(c.s, nurbsParam(c, t));
  return arcPointAt(c.center, c.radius, c.startAngle + sweepOf(c) * t);
}

/** d(point)/dt — not unit length. */
function derivAt(c: XCurve, t: number): Point {
  if (c.kind === "segment") return { x: c.b.x - c.a.x, y: c.b.y - c.a.y };
  if (c.kind === "ellipse") {
    const d = ellipseTangentAt(c.e, ellipseParam(c, t));
    const w = ellipseSweep(c.e);
    return { x: d.x * w, y: d.y * w };
  }
  if (c.kind === "nurbs") {
    const [lo, hi] = nurbsDomain(c.s);
    const d = nurbsEval(c.s, nurbsParam(c, t)).tangent;
    return { x: d.x * (hi - lo), y: d.y * (hi - lo) };
  }
  const sw = sweepOf(c);
  const a = c.startAngle + sw * t;
  return { x: -Math.sin(a) * c.radius * sw, y: Math.cos(a) * c.radius * sw };
}

/** Unit tangent (direction of travel) at `t`. */
export function tangentAt(c: XCurve, t: number): Point {
  if (c.kind === "ellipse" || c.kind === "nurbs") {
    const d = derivAt(c, t);
    const l = Math.hypot(d.x, d.y) || 1;
    return { x: d.x / l, y: d.y / l };
  }
  if (c.kind === "segment") {
    const l = dist(c.a, c.b) || 1;
    return { x: (c.b.x - c.a.x) / l, y: (c.b.y - c.a.y) / l };
  }
  const a = c.startAngle + sweepOf(c) * t;
  const s = c.ccw || c.full ? 1 : -1;
  return { x: -Math.sin(a) * s, y: Math.cos(a) * s };
}

function chainLength(pts: Point[]): number {
  let l = 0;
  for (let i = 0; i + 1 < pts.length; i++) l += dist(pts[i], pts[i + 1]);
  return l;
}

export function curveLength(c: XCurve): number {
  if (c.kind === "ellipse") return chainLength(tessellateEllipse(c.e, 1e-4));
  if (c.kind === "nurbs") return chainLength(tessellateNurbs(c.s, 1e-4));
  return c.kind === "segment" ? dist(c.a, c.b) : c.radius * Math.abs(sweepOf(c));
}

export function curveStart(c: XCurve): Point {
  return pointAt(c, 0);
}

export function curveEnd(c: XCurve): Point {
  return pointAt(c, 1);
}

/** Parameter of the point on `c` nearest to `p` (clamped to the curve), and that point. */
export function closestParam(c: XCurve, p: Point): { t: number; point: Point; distance: number } {
  if (c.kind === "ellipse") {
    const sweep = ellipseSweep(c.e);
    let rel = (((closestEllipseParam(c.e, p) - c.e.start) % TAU) + TAU) % TAU;
    // A hair before the start wraps to ~2π; on a partial arc that is the start, not past the end.
    if (sweep < TAU - 1e-9 && rel > sweep + 1e-6) rel = rel > (TAU + sweep) / 2 ? 0 : sweep;
    const t = Math.min(1, rel / sweep);
    const point = pointAt(c, t);
    return { t, point, distance: dist(p, point) };
  }
  if (c.kind === "nurbs") {
    const [lo, hi] = nurbsDomain(c.s);
    const t = (closestNurbsParam(c.s, p) - lo) / (hi - lo);
    const point = pointAt(c, t);
    return { t, point, distance: dist(p, point) };
  }
  if (c.kind === "segment") {
    const dx = c.b.x - c.a.x;
    const dy = c.b.y - c.a.y;
    const len2 = dx * dx + dy * dy;
    let t = len2 > 0 ? ((p.x - c.a.x) * dx + (p.y - c.a.y) * dy) / len2 : 0;
    t = Math.max(0, Math.min(1, t));
    const point = pointAt(c, t);
    return { t, point, distance: dist(p, point) };
  }
  const angle = Math.atan2(p.y - c.center.y, p.x - c.center.x);
  const t = paramOfAngle(c, angle);
  if (t !== null) {
    const point = pointAt(c, t);
    return { t, point, distance: dist(p, point) };
  }
  // Off the arc's sweep: whichever end is nearer.
  const ds = dist(p, curveStart(c));
  const de = dist(p, curveEnd(c));
  return ds <= de ? { t: 0, point: curveStart(c), distance: ds } : { t: 1, point: curveEnd(c), distance: de };
}

/** The parameter at which an arc passes through `angle`, or null when the angle is outside its sweep. */
function paramOfAngle(c: Extract<Curve, { kind: "arc" }>, angle: number): number | null {
  const sweep = sweepOf(c);
  if (c.full) return (((angle - c.startAngle) % TAU) + TAU) % TAU / TAU;
  if (!angleInSweep(angle, c.startAngle, c.endAngle, c.ccw)) return null;
  const raw = c.ccw ? angle - c.startAngle : c.startAngle - angle;
  const rel = ((raw % TAU) + TAU) % TAU;
  return Math.min(1, rel / Math.abs(sweep));
}

/* ----------------------------- intersections ----------------------------- */

export interface Intersection {
  point: Point;
  /** Parameter on the first curve. */
  t1: number;
  /** Parameter on the second curve. */
  t2: number;
}

/**
 * Where two curves meet, with the parameter on each. `extend1` / `extend2`
 * treat the corresponding curve as unbounded (the infinite line, the full
 * circle), which is what extend and fillet need. Parallel/coincident
 * overlaps and identical circles yield nothing: there is no single point.
 */
export function intersectCurves(c1: XCurve, c2: XCurve, extend1 = false, extend2 = false): Intersection[] {
  let hits: Intersection[];
  if (c1.kind === "ellipse" || c1.kind === "nurbs" || c2.kind === "ellipse" || c2.kind === "nurbs") hits = numericHits(c1, c2);
  else if (c1.kind === "segment" && c2.kind === "segment") hits = segSeg(c1, c2);
  else if (c1.kind === "segment" && c2.kind === "arc") hits = segArc(c1, c2);
  else if (c1.kind === "arc" && c2.kind === "segment") hits = segArc(c2, c1).map((h) => ({ point: h.point, t1: h.t2, t2: h.t1 }));
  else hits = arcArc(c1 as Extract<Curve, { kind: "arc" }>, c2 as Extract<Curve, { kind: "arc" }>);
  const out: Intersection[] = [];
  for (const h of hits) {
    const t1 = extend1 ? h.t1 : inRange(h.t1, c1);
    const t2 = extend2 ? h.t2 : inRange(h.t2, c2);
    if (t1 === null || t2 === null) continue;
    const point = h.point;
    if (out.some((o) => dist(o.point, point) < MERGE_TOL)) continue;
    out.push({ point, t1, t2 });
  }
  return out;
}

/** Keeps a raw parameter only while it lies on the bounded curve (with a hair of slack at the ends), snapping it into [0, 1]. */
function inRange(t: number, c: XCurve): number | null {
  // A micron of slack, in the curve's own parameter: an endpoint both curves share must count.
  const slack = MERGE_TOL / Math.max(curveLength(c), MERGE_TOL);
  if (t < -slack || t > 1 + slack) return null;
  return Math.max(0, Math.min(1, t));
}

/** Infinite-line parameters; for arcs, the angle turned into the arc's own parameter (may fall outside [0,1] or be null off a partial sweep — see arcParamUnbounded). */
function segSeg(a: Extract<Curve, { kind: "segment" }>, b: Extract<Curve, { kind: "segment" }>): Intersection[] {
  const rX = a.b.x - a.a.x;
  const rY = a.b.y - a.a.y;
  const sX = b.b.x - b.a.x;
  const sY = b.b.y - b.a.y;
  const denom = rX * sY - rY * sX;
  if (Math.abs(denom) < EPS) return [];
  const t = ((b.a.x - a.a.x) * sY - (b.a.y - a.a.y) * sX) / denom;
  const u = ((b.a.x - a.a.x) * rY - (b.a.y - a.a.y) * rX) / denom;
  return [{ point: { x: a.a.x + t * rX, y: a.a.y + t * rY }, t1: t, t2: u }];
}

function segArc(s: Extract<Curve, { kind: "segment" }>, c: Extract<Curve, { kind: "arc" }>): Intersection[] {
  const dx = s.b.x - s.a.x;
  const dy = s.b.y - s.a.y;
  const fx = s.a.x - c.center.x;
  const fy = s.a.y - c.center.y;
  const A = dx * dx + dy * dy;
  if (A < EPS) return [];
  const B = 2 * (fx * dx + fy * dy);
  const C = fx * fx + fy * fy - c.radius * c.radius;
  let disc = B * B - 4 * A * C;
  // A tangency computes as a tiny negative discriminant; treat it as one touch.
  if (disc < 0 && disc > -1e-9 * (B * B + 1)) disc = 0;
  if (disc < 0) return [];
  const sq = Math.sqrt(disc);
  const ts = disc === 0 ? [-B / (2 * A)] : [(-B - sq) / (2 * A), (-B + sq) / (2 * A)];
  const out: Intersection[] = [];
  for (const t of ts) {
    const point = { x: s.a.x + dx * t, y: s.a.y + dy * t };
    const t2 = arcParamUnbounded(c, point);
    out.push({ point, t1: t, t2 });
  }
  return out;
}

function arcArc(a: Extract<Curve, { kind: "arc" }>, b: Extract<Curve, { kind: "arc" }>): Intersection[] {
  const d = dist(a.center, b.center);
  if (d < EPS) return []; // concentric: none, or infinitely many
  const r1 = a.radius;
  const r2 = b.radius;
  if (d > r1 + r2 + MERGE_TOL || d < Math.abs(r1 - r2) - MERGE_TOL) return [];
  const x = (d * d - r2 * r2 + r1 * r1) / (2 * d);
  const h2 = r1 * r1 - x * x;
  const h = h2 > 0 ? Math.sqrt(h2) : 0;
  const ux = (b.center.x - a.center.x) / d;
  const uy = (b.center.y - a.center.y) / d;
  const px = a.center.x + ux * x;
  const py = a.center.y + uy * x;
  const pts = h === 0 ? [{ x: px, y: py }] : [
    { x: px - uy * h, y: py + ux * h },
    { x: px + uy * h, y: py - ux * h },
  ];
  return pts.map((point) => ({ point, t1: arcParamUnbounded(a, point), t2: arcParamUnbounded(b, point) }));
}

/**
 * The arc's parameter for a point on its circle, allowing values outside
 * [0, 1] for points off the sweep (measured the short way past whichever
 * end is nearer), so callers can decide whether to accept them.
 */
function arcParamUnbounded(c: Extract<Curve, { kind: "arc" }>, p: Point): number {
  const angle = Math.atan2(p.y - c.center.y, p.x - c.center.x);
  const t = paramOfAngle(c, angle);
  if (t !== null) return t;
  const sweep = Math.abs(sweepOf(c));
  const raw = c.ccw ? angle - c.startAngle : c.startAngle - angle;
  const rel = ((raw % TAU) + TAU) % TAU; // in (sweep, 2π)
  // Past the end, or before the start (going the other way round)?
  const pastEnd = rel - sweep;
  const beforeStart = TAU - rel;
  return pastEnd <= beforeStart ? 1 + pastEnd / sweep : -beforeStart / sweep;
}

/* ----------------------- numeric (ellipse / NURBS) hits ----------------------- */

interface Proxy {
  pts: Point[];
  /** The curve parameter each point sits at (raw: outside [0, 1] for the extended line / full circle / full ellipse). */
  ts: number[];
}

const proxies = new WeakMap<object, Proxy>();

/**
 * A polyline stand-in used only to find where to start Newton. Lines are
 * their whole infinite extent, circles and ellipses the whole closed curve
 * (so extend works), and a NURBS curve its domain, 16 samples a span.
 */
function proxyOf(c: XCurve): Proxy {
  const hit = proxies.get(c);
  if (hit) return hit;
  const pts: Point[] = [];
  const ts: number[] = [];
  if (c.kind === "segment") {
    const k = 1e7 / Math.max(dist(c.a, c.b), 1e-9);
    for (const t of [-k, 1 + k]) {
      pts.push(pointAt(c, t));
      ts.push(t);
    }
  } else if (c.kind === "arc") {
    const sw = sweepOf(c);
    const n = 96;
    for (let i = 0; i <= n; i++) {
      pts.push(arcPointAt(c.center, c.radius, c.startAngle + (TAU / n) * i * Math.sign(sw || 1)));
      ts.push((TAU / n) * i / Math.abs(sw || TAU));
    }
  } else if (c.kind === "ellipse") {
    const sw = ellipseSweep(c.e);
    const n = 160;
    for (let i = 0; i <= n; i++) {
      pts.push(ellipsePointAt(c.e, c.e.start + (TAU / n) * i));
      ts.push((TAU / n) * i / sw);
    }
  } else {
    const [lo, hi] = nurbsDomain(c.s);
    const breaks = [...new Set(c.s.knots.filter((k) => k >= lo && k <= hi))];
    for (let b = 0; b + 1 < breaks.length; b++) {
      for (let i = 0; i < 16; i++) {
        const u = breaks[b] + ((breaks[b + 1] - breaks[b]) * i) / 16;
        pts.push(nurbsPointAt(c.s, u));
        ts.push((u - lo) / (hi - lo));
      }
    }
    pts.push(nurbsPointAt(c.s, hi));
    ts.push(1);
  }
  const out = { pts, ts };
  proxies.set(c, out);
  return out;
}

/** The parameter a point on the curve's (extended) carrier has, with values off the bounded curve allowed. */
function rawParamOf(c: XCurve, p: Point, refined: number): number {
  if (c.kind === "arc") return arcParamUnbounded(c, p);
  if (c.kind === "ellipse") {
    const sw = ellipseSweep(c.e);
    const rel = (((ellipseParamOfPoint(c.e, p) - c.e.start) % TAU) + TAU) % TAU;
    if (sw >= TAU - 1e-9 || rel <= sw) return rel / sw;
    const pastEnd = rel - sw;
    const beforeStart = TAU - rel;
    return pastEnd <= beforeStart ? 1 + pastEnd / sw : -beforeStart / sw;
  }
  return refined;
}

/**
 * Intersections where at least one curve is an ellipse or NURBS: find
 * candidate crossings between the two polyline stand-ins, then polish each
 * with Newton on `A(ta) − B(tb) = 0`. A candidate that does not polish to
 * a true common point (residual under a micron) is dropped — which is also
 * what discards the false crossings a coarse stand-in can invent.
 */
function numericHits(a: XCurve, b: XCurve): Intersection[] {
  const pa = proxyOf(a);
  const pb = proxyOf(b);
  const out: Intersection[] = [];
  const clampT = (c: XCurve, t: number): number => (c.kind === "nurbs" ? Math.min(1, Math.max(0, t)) : t);
  for (let i = 0; i + 1 < pa.pts.length; i++) {
    const a0 = pa.pts[i];
    const a1 = pa.pts[i + 1];
    const minAx = Math.min(a0.x, a1.x);
    const maxAx = Math.max(a0.x, a1.x);
    const minAy = Math.min(a0.y, a1.y);
    const maxAy = Math.max(a0.y, a1.y);
    for (let j = 0; j + 1 < pb.pts.length; j++) {
      const b0 = pb.pts[j];
      const b1 = pb.pts[j + 1];
      const slack = 1e-6;
      if (Math.max(b0.x, b1.x) < minAx - slack || Math.min(b0.x, b1.x) > maxAx + slack) continue;
      if (Math.max(b0.y, b1.y) < minAy - slack || Math.min(b0.y, b1.y) > maxAy + slack) continue;
      const rx = a1.x - a0.x;
      const ry = a1.y - a0.y;
      const sx = b1.x - b0.x;
      const sy = b1.y - b0.y;
      const denom = rx * sy - ry * sx;
      if (Math.abs(denom) < 1e-18) continue;
      const al = ((b0.x - a0.x) * sy - (b0.y - a0.y) * sx) / denom;
      const be = ((b0.x - a0.x) * ry - (b0.y - a0.y) * rx) / denom;
      if (al < -0.05 || al > 1.05 || be < -0.05 || be > 1.05) continue;
      let ta = pa.ts[i] + al * (pa.ts[i + 1] - pa.ts[i]);
      let tb = pb.ts[j] + be * (pb.ts[j + 1] - pb.ts[j]);
      let ok = false;
      for (let it = 0; it < 40; it++) {
        const pA = pointAt(a, clampT(a, ta));
        const pB = pointAt(b, clampT(b, tb));
        const fx = pA.x - pB.x;
        const fy = pA.y - pB.y;
        if (Math.hypot(fx, fy) < 1e-11) {
          ok = true;
          break;
        }
        const dA = derivAt(a, clampT(a, ta));
        const dB = derivAt(b, clampT(b, tb));
        const det = -dA.x * dB.y + dA.y * dB.x;
        if (Math.abs(det) < 1e-18) break;
        // Solve [dA  −dB] · [Δta Δtb]ᵀ = −F.
        const dta = (-fx * -dB.y - -dB.x * -fy) / det;
        const dtb = (dA.x * -fy - dA.y * -fx) / det;
        ta += dta;
        tb += dtb;
        if (!Number.isFinite(ta) || !Number.isFinite(tb)) break;
      }
      const pA = pointAt(a, clampT(a, ta));
      const pB = pointAt(b, clampT(b, tb));
      if (!ok && !(Math.hypot(pA.x - pB.x, pA.y - pB.y) < 1e-6)) continue;
      const point = { x: (pA.x + pB.x) / 2, y: (pA.y + pB.y) / 2 };
      if (out.some((o) => dist(o.point, point) < MERGE_TOL)) continue;
      out.push({ point, t1: rawParamOf(a, point, clampT(a, ta)), t2: rawParamOf(b, point, clampT(b, tb)) });
    }
  }
  return out;
}

/* ------------------------------- splitting ------------------------------- */

/** The sub-curve of `c` between parameters t0 < t1. */
export function subCurve(c: Curve, t0: number, t1: number): Curve;
export function subCurve(c: XCurve, t0: number, t1: number): XCurve;
export function subCurve(c: XCurve, t0: number, t1: number): XCurve {
  if (c.kind === "ellipse") {
    const sweep = ellipseSweep(c.e);
    const start = c.e.start + sweep * t0;
    const span = Math.min(TAU, sweep * (t1 - t0));
    return { kind: "ellipse", e: { ...c.e, start, end: start + span } };
  }
  if (c.kind === "nurbs") {
    const [lo, hi] = nurbsDomain(c.s);
    let s = c.s;
    const u0 = lo + (hi - lo) * Math.max(0, t0);
    const u1 = lo + (hi - lo) * Math.min(1, t1);
    if (u1 < hi) s = splitNurbs(s, u1)?.[0] ?? s;
    if (u0 > lo) s = splitNurbs(s, u0)?.[1] ?? s;
    return { kind: "nurbs", s };
  }
  if (c.kind === "segment") return { kind: "segment", a: pointAt(c, t0), b: pointAt(c, t1) };
  const sweep = sweepOf(c);
  const s = c.startAngle + sweep * t0;
  const e = c.startAngle + sweep * t1;
  return { kind: "arc", center: c.center, radius: c.radius, startAngle: s, endAngle: e, ccw: sweep >= 0 };
}

/**
 * A position along a path: `u = curve index + t`. Sorting positions sorts
 * along the path, which is all trim needs.
 */
export type PathParam = number;

export function pathParam(path: XPath, p: Point): { u: PathParam; point: Point; distance: number } {
  let best = { u: 0, point: curveStart(path.curves[0]), distance: Infinity };
  path.curves.forEach((c, i) => {
    const r = closestParam(c, p);
    if (r.distance < best.distance) best = { u: i + r.t, point: r.point, distance: r.distance };
  });
  return best;
}

export function pathPointAt(path: XPath, u: PathParam): Point {
  const i = Math.min(path.curves.length - 1, Math.max(0, Math.floor(u)));
  return pointAt(path.curves[i], Math.max(0, Math.min(1, u - i)));
}

/** The piece of `path` between two positions, going forward (wrapping for a closed path when u1 < u0). */
export function pathSlice(path: Path, u0: PathParam, u1: PathParam): Path;
export function pathSlice(path: XPath, u0: PathParam, u1: PathParam): XPath;
export function pathSlice(path: XPath, u0: PathParam, u1: PathParam): XPath {
  const n = path.curves.length;
  const curves: XCurve[] = [];
  if (u1 < u0) {
    if (!path.closed) return { curves: [], closed: false };
    return { curves: joinContiguous([...pathSlice(path, u0, n).curves, ...pathSlice(path, 0, u1).curves]), closed: false };
  }
  // On a closed path u1 may run past the end (a full lap from the cut round to itself): wrap the curve index.
  const limit = path.closed ? u1 : Math.min(u1, n);
  let i = Math.floor(u0);
  while (i < limit + 1e-12 && i < u0 + n + 1) {
    const t0 = Math.max(0, u0 - i);
    const t1 = Math.min(1, u1 - i);
    if (t1 - t0 > 1e-12) curves.push(subCurve(path.curves[i % n], t0, t1));
    i += 1;
  }
  // A lap round a closed ellipse / spline comes out as two pieces of one curve; rejoin them across the seam.
  if (path.closed && curves.length > 1 && curves.every((c) => c.kind === "ellipse" || c.kind === "nurbs")) {
    return { curves: joinContiguous(curves), closed: false };
  }
  return { curves, closed: false };
}

const sameEllipse = (a: EllipseGeom, b: EllipseGeom): boolean =>
  dist(a.center, b.center) < MERGE_TOL && dist(a.majorAxis, b.majorAxis) < MERGE_TOL && Math.abs(a.ratio - b.ratio) < 1e-9;

/**
 * Concatenates two clamped curves of the same degree end-to-start into one
 * (C0 at the joint: the joint knot has multiplicity `degree`). Exact — the
 * second curve's weights are rescaled so the joint weight matches, which
 * leaves its shape unchanged. Null when the parts do not meet or are not clamped.
 */
export function joinNurbs(a: NurbsData, b: NurbsData): NurbsData | null {
  const p = a.degree;
  if (b.degree !== p || !isClamped(a) || !isClamped(b)) return null;
  const [alo, ahi] = nurbsDomain(a);
  const [blo, bhi] = nurbsDomain(b);
  const na = a.controlPoints.length;
  if (dist(a.controlPoints[na - 1], b.controlPoints[0]) > MERGE_TOL) return null;
  const shift = ahi - blo;
  void alo;
  void bhi;
  const wa = a.weights ?? a.controlPoints.map(() => 1);
  const wb0 = b.weights ?? b.controlPoints.map(() => 1);
  const scale = wa[na - 1] / wb0[0];
  const knots = [...a.knots.slice(0, a.knots.length - (p + 1)), ...Array<number>(p).fill(ahi), ...b.knots.slice(p + 1).map((k) => k + shift)];
  const rational = a.weights !== undefined || b.weights !== undefined;
  const controlPoints = [...a.controlPoints, ...b.controlPoints.slice(1)];
  return {
    degree: p,
    controlPoints,
    knots,
    ...(rational ? { weights: [...wa, ...wb0.slice(1).map((w) => w * scale)] } : {}),
  };
}

/**
 * Merges neighbouring curves that are really one curve cut at a seam: two
 * arcs of the same circle in the same direction (a circle sliced across
 * its start angle), or two collinear segments meeting end to start.
 */
export function joinContiguous(curves: Curve[], closed?: boolean): Curve[];
export function joinContiguous(curves: XCurve[], closed?: boolean): XCurve[];
export function joinContiguous(curves: XCurve[], closed = false): XCurve[] {
  const out: XCurve[] = [];
  for (const c of curves) {
    const prev = out[out.length - 1];
    if (prev && dist(curveEnd(prev), curveStart(c)) < MERGE_TOL) {
      if (prev.kind === "ellipse" && c.kind === "ellipse" && sameEllipse(prev.e, c.e)) {
        // c continues prev's parameter range (modulo a lap).
        const gap = (((c.e.start - (prev.e.start + ellipseSweep(prev.e))) % TAU) + TAU) % TAU;
        if (gap < 1e-9 || TAU - gap < 1e-9) {
          const total = Math.min(TAU, ellipseSweep(prev.e) + ellipseSweep(c.e));
          out[out.length - 1] = { kind: "ellipse", e: { ...prev.e, end: prev.e.start + total } };
          continue;
        }
      }
      if (prev.kind === "nurbs" && c.kind === "nurbs" && prev.s.degree === c.s.degree) {
        const j = joinNurbs(prev.s, c.s);
        if (j) {
          out[out.length - 1] = { kind: "nurbs", s: j };
          continue;
        }
      }
      if (prev.kind === "arc" && c.kind === "arc" && dist(prev.center, c.center) < MERGE_TOL && Math.abs(prev.radius - c.radius) < MERGE_TOL && sweepOf(prev) * sweepOf(c) > 0) {
        const total = sweepOf(prev) + sweepOf(c);
        out[out.length - 1] = { kind: "arc", center: prev.center, radius: prev.radius, startAngle: prev.startAngle, endAngle: prev.startAngle + total, ccw: total >= 0, ...(Math.abs(total) >= TAU - 1e-9 ? { full: true } : {}) };
        continue;
      }
      if (prev.kind === "segment" && c.kind === "segment") {
        const t1 = tangentAt(prev, 0);
        const t2 = tangentAt(c, 0);
        if (Math.abs(t1.x * t2.y - t1.y * t2.x) < 1e-9 && t1.x * t2.x + t1.y * t2.y > 0) {
          out[out.length - 1] = { kind: "segment", a: prev.a, b: c.b };
          continue;
        }
      }
    }
    out.push(c);
  }
  // A closed path may also have its seam between the last and first curve.
  if (closed && out.length > 1) {
    const merged = joinContiguous([out[out.length - 1], out[0]] as XCurve[]);
    if (merged.length === 1) {
      out.pop();
      out[0] = merged[0];
    }
  }
  return out;
}

/* --------------------------- entities ↔ paths ---------------------------- */

/** Properties a piece inherits from the entity it was cut from. */
function inherit(e: Entity): { layer?: string; color?: string; linetype?: string; lineweight?: number; linetypeScale?: number; construction?: boolean } {
  const out: { layer?: string; color?: string; linetype?: string; lineweight?: number; linetypeScale?: number; construction?: boolean } = {};
  if (e.layer !== undefined) out.layer = e.layer;
  if (e.color !== undefined) out.color = e.color;
  if (e.linetype !== undefined) out.linetype = e.linetype;
  if (e.lineweight !== undefined) out.lineweight = e.lineweight;
  if (e.linetypeScale !== undefined) out.linetypeScale = e.linetypeScale;
  if (e.construction !== undefined) out.construction = e.construction;
  return out;
}

/** DXF bulge for an arc curve's chord. */
function bulgeOf(c: Extract<Curve, { kind: "arc" }>): number {
  const sweep = sweepOf(c);
  return Math.tan(sweep / 4);
}

/**
 * Turns a path back into an entity: a lone segment is a line, a lone arc an
 * arc, a full circle a circle, anything longer a polyline with bulges.
 * `source` supplies layer/colour/construction; ids and names are the
 * caller's business. Null for an empty path.
 */
export function entityFromPath(path: XPath, source: Entity, id: string): Entity | null {
  const cs = path.curves.filter((c) => curveLength(c) > EPS);
  if (cs.length === 0) return null;
  const props = inherit(source);
  if (cs.length === 1) {
    const c = cs[0];
    if (c.kind === "ellipse") {
      const sweep = ellipseSweep(c.e);
      const full = sweep >= TAU - 1e-9;
      return { id, type: "ellipse", ...props, center: c.e.center, majorAxis: c.e.majorAxis, ratio: c.e.ratio, start: c.e.start, end: full ? c.e.start + TAU : c.e.start + sweep } satisfies EllipseEntity;
    }
    if (c.kind === "nurbs") {
      return {
        id,
        type: "spline",
        ...props,
        degree: c.s.degree,
        controlPoints: c.s.controlPoints,
        knots: c.s.knots,
        ...(c.s.weights ? { weights: c.s.weights } : {}),
        closed: path.closed,
      } satisfies SplineEntity;
    }
    if (c.kind === "segment") return { id, type: "line", ...props, a: c.a, b: c.b } satisfies LineEntity;
    if (c.full || Math.abs(sweepOf(c)) >= TAU - 1e-9) {
      return { id, type: "circle", ...props, center: c.center, radius: c.radius } satisfies CircleEntity;
    }
    return {
      id,
      type: "arc",
      ...props,
      center: c.center,
      radius: c.radius,
      startAngle: c.startAngle,
      endAngle: c.endAngle,
      ccw: c.ccw,
    } satisfies ArcEntity;
  }
  // Several curves become a polyline; an ellipse or spline among them can only join as its chain of chords.
  const flat: Curve[] = [];
  for (const c of cs) {
    if (c.kind === "ellipse" || c.kind === "nurbs") {
      const pts = c.kind === "ellipse" ? tessellateEllipse(c.e, 0.01) : tessellateNurbs(c.s, 0.01);
      for (let i = 0; i + 1 < pts.length; i++) if (dist(pts[i], pts[i + 1]) > EPS) flat.push({ kind: "segment", a: pts[i], b: pts[i + 1] });
    } else flat.push(c);
  }
  const points: Point[] = [curveStart(flat[0])];
  const bulges: number[] = [];
  for (const c of flat) {
    points.push(curveEnd(c));
    bulges.push(c.kind === "arc" ? bulgeOf(c) : 0);
  }
  let closed = path.closed;
  if (!closed && dist(points[0], points[points.length - 1]) < MERGE_TOL && points.length > 3) closed = true;
  if (closed && dist(points[0], points[points.length - 1]) < MERGE_TOL) points.pop();
  const hasArc = bulges.some((b) => b !== 0);
  return {
    id,
    type: "polyline",
    ...props,
    points,
    closed,
    ...(hasArc ? { bulges } : {}),
  } satisfies PolylineEntity;
}

/* ------------------------------ operations ------------------------------- */

/**
 * All positions on `target`'s path where it meets any of `cutters` (the
 * target itself is skipped), sorted along the path and deduplicated.
 */
export function cutParams(target: Entity, cutters: Entity[], extendCutters = false): PathParam[] {
  const path = exactPathOf(target);
  if (!path) return [];
  const us: number[] = [];
  for (const other of cutters) {
    if (other.id === target.id) continue;
    const op = exactPathOf(other);
    if (!op) continue;
    path.curves.forEach((c, i) => {
      for (const oc of op.curves) {
        for (const hit of intersectCurves(c, oc, false, extendCutters)) us.push(i + hit.t1);
      }
    });
  }
  us.sort((a, b) => a - b);
  const out: number[] = [];
  for (const u of us) {
    if (out.length === 0 || Math.abs(u - out[out.length - 1]) > 1e-9) out.push(u);
  }
  // A cut exactly at an open path's end trims nothing; drop it.
  if (!path.closed) return out.filter((u) => u > 1e-9 && u < path.curves.length - 1e-9);
  return out;
}

export interface TrimResult {
  /** What replaces the target (0–2 entities for an open path, 1 for a closed one). Ids are placeholders "0", "1"; the caller re-ids. */
  pieces: Entity[];
}

/**
 * Removes the piece of `target` between the two cut positions around
 * `near` (the click). An open path with a cut on only one side loses the
 * end piece; with no cuts at all nothing happens (null). A closed path
 * needs two cuts, and what remains is one open piece from the second cut
 * round to the first.
 */
export function trimAt(target: Entity, cutters: Entity[], near: Point): TrimResult | null {
  const path = exactPathOf(target);
  if (!path) return null;
  const cuts = cutParams(target, cutters);
  if (cuts.length === 0) return null;
  const { u } = pathParam(path, near);
  const n = path.curves.length;
  const pieces: XPath[] = [];
  if (path.closed) {
    if (cuts.length < 2) return null;
    // Cuts are cyclic: the piece under the click runs from the last cut ≤ u to the next cut > u.
    let i = cuts.findIndex((c) => c > u);
    if (i === -1) i = 0;
    const end = cuts[i];
    const start = cuts[(i - 1 + cuts.length) % cuts.length];
    // Keep everything from `end` round to `start`.
    pieces.push(pathSlice(path, end, start === end ? end + n : start));
  } else {
    const after = cuts.find((c) => c > u);
    const before = [...cuts].reverse().find((c) => c <= u);
    if (before !== undefined) pieces.push(pathSlice(path, 0, before));
    if (after !== undefined) pieces.push(pathSlice(path, after, n));
  }
  const out: Entity[] = [];
  pieces.forEach((p, i) => {
    const e = entityFromPath(p, target, String(i));
    if (e) out.push(e);
  });
  return { pieces: out };
}

/** Splits `target` at the position nearest `at` into two entities (null if the point is at an end, or the entity has no stroke). */
export function splitAt(target: Entity, at: Point): Entity[] | null {
  const path = exactPathOf(target);
  if (!path) return null;
  const { u } = pathParam(path, at);
  const n = path.curves.length;
  if (path.closed) {
    // One cut opens a closed path into a single open one starting there.
    const e = entityFromPath(pathSlice(path, u, u + n), target, "0");
    return e ? [e] : null;
  }
  if (u < 1e-9 || u > n - 1e-9) return null;
  const a = entityFromPath(pathSlice(path, 0, u), target, "0");
  const b = entityFromPath(pathSlice(path, u, n), target, "1");
  return a && b ? [a, b] : null;
}

/**
 * Extends the end of `target` nearest to `near` along its own curve to the
 * first place it meets one of `boundaries` (their actual extent), or null
 * when nothing lies ahead. Lines extend along their line, arcs around
 * their circle; polylines extend their end leg the same way.
 */
export function extendTo(target: Entity, boundaries: Entity[], near: Point): Entity | null {
  const path = exactPathOf(target);
  if (!path || path.closed) return null;
  const first = path.curves[0];
  const last = path.curves[path.curves.length - 1];
  const atEnd = dist(near, curveEnd(last)) <= dist(near, curveStart(first));
  const c = atEnd ? last : first;
  let best: { t: number; point: Point } | null = null;
  for (const b of boundaries) {
    if (b.id === target.id) continue;
    const bp = exactPathOf(b);
    if (!bp) continue;
    for (const oc of bp.curves) {
      for (const hit of intersectCurves(c, oc, true, false)) {
        const ahead = atEnd ? hit.t1 > 1 + 1e-9 : hit.t1 < -1e-9;
        if (!ahead) continue;
        if (c.kind === "arc" && Math.abs(hit.t1 - (atEnd ? 1 : 0)) * Math.abs(sweepOf(c)) > TAU - 1e-9) continue;
        if (c.kind === "ellipse" && Math.abs(hit.t1 - (atEnd ? 1 : 0)) * ellipseSweep(c.e) > TAU - 1e-9) continue;
        if (c.kind === "nurbs") continue; // a spline has no extension beyond its ends
        const better = !best || (atEnd ? hit.t1 < best.t : hit.t1 > best.t);
        if (better) best = { t: hit.t1, point: hit.point };
      }
    }
  }
  if (!best) return null;
  const curves = [...path.curves];
  if (atEnd) curves[curves.length - 1] = subCurve(c, 0, best.t);
  else curves[0] = subCurve(c, best.t, 1);
  return entityFromPath({ curves, closed: false }, target, target.id);
}

/**
 * Points on an ellipse / NURBS curve where a line from `from` meets it at a
 * right angle (`perpendicular`: `(P−from)·T = 0`) or just touches it
 * (`tangent`: `(P−from)×T = 0`). Found as sign changes of those two functions
 * over a 256-step sample, then bisected — exact for any smooth curve, no
 * closed form needed. Ends of an open curve count only if they truly satisfy
 * the condition.
 */
export function perpendicularTangentPoints(
  c: EllipseCurve | NurbsCurve,
  from: Point,
): { perpendicular: Point[]; tangent: Point[] } {
  const N = 256;
  const f = (t: number, kind: 0 | 1): number => {
    const p = pointAt(c, t);
    const T = tangentAt(c, t);
    const vx = p.x - from.x;
    const vy = p.y - from.y;
    return kind === 0 ? vx * T.x + vy * T.y : vx * T.y - vy * T.x;
  };
  const solve = (kind: 0 | 1): Point[] => {
    const out: Point[] = [];
    let t0 = 0;
    let f0 = f(0, kind);
    for (let i = 1; i <= N; i++) {
      const t1 = i / N;
      const f1 = f(t1, kind);
      if (f0 === 0 || f0 * f1 < 0) {
        let lo = t0;
        let hi = t1;
        let flo = f0;
        for (let k = 0; k < 50; k++) {
          const mid = (lo + hi) / 2;
          const fm = f(mid, kind);
          if (flo * fm <= 0) hi = mid;
          else {
            lo = mid;
            flo = fm;
          }
        }
        const p = pointAt(c, (lo + hi) / 2);
        // The point under `from` makes both functions vanish trivially.
        if (dist(p, from) > 1e-9 && !out.some((q) => dist(p, q) < 1e-7)) out.push(p);
      }
      t0 = t1;
      f0 = f1;
    }
    return out;
  };
  return { perpendicular: solve(0), tangent: solve(1) };
}
