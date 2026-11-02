import type { Entity } from "./entities";
import { dist, type Point } from "./geometry";
import { interpolateNurbs } from "./nurbs";
import {
  closestParam,
  curveEnd,
  curveLength,
  curveStart,
  entityFromPath,
  exactPathOf,
  intersectCurves,
  joinContiguous,
  pathOf,
  pointAt,
  subCurve,
  tangentAt,
  type Curve,
  type Path,
} from "./intersect";

/**
 * Offset (roadmap T-15): a parallel copy of an entity at a distance, on
 * the side the user clicked. Lines shift sideways, circles and arcs
 * become concentric, and a polyline is offset leg by leg and re-joined:
 * neighbouring offset legs are extended or trimmed to their intersection
 * (AutoCAD's default `OFFSETGAPTYPE=0`), and where two offset legs no
 * longer reach each other (the outside of a convex corner between arcs)
 * a round join around the original vertex fills the gap. Legs that turn
 * inside out — a short edge on the inner offset of a closed outline — are
 * dropped and their neighbours re-joined, which is what makes the inner
 * offset of a real part outline come out clean instead of looped.
 *
 * Everything is expressed as a signed distance: positive offsets to the
 * left of the direction of travel. `sideSign` turns a click into that sign.
 */

const EPS = 1e-9;

/** AutoCAD OFFSETGAPTYPE: `extend` (0) meets outer corners at a point, `round` (1) rounds them about the original vertex. */
export type OffsetGap = "extend" | "round";

/** +1 when `click` lies to the left of the path's nearest point (in travel direction), −1 to the right. */
export function sideSign(path: Path, click: Point): number {
  let best = { d: Infinity, sign: 1 };
  for (const c of path.curves) {
    const r = closestParam(c, click);
    if (r.distance < best.d) {
      const t = tangentAt(c, r.t);
      const cross = t.x * (click.y - r.point.y) - t.y * (click.x - r.point.x);
      best = { d: r.distance, sign: cross >= 0 ? 1 : -1 };
    }
  }
  return best.sign;
}

/** One curve shifted by `s` to its left. Null when an arc would collapse (radius ≤ 0). */
export function offsetCurve(c: Curve, s: number): Curve | null {
  if (c.kind === "segment") {
    const t = tangentAt(c, 0);
    const nx = -t.y * s;
    const ny = t.x * s;
    return { kind: "segment", a: { x: c.a.x + nx, y: c.a.y + ny }, b: { x: c.b.x + nx, y: c.b.y + ny } };
  }
  // Travelling ccw, left is toward the center.
  const inward = c.ccw || c.full;
  const radius = inward ? c.radius - s : c.radius + s;
  if (radius <= EPS) return null;
  return { ...c, radius };
}

/**
 * The offset of a whole path. Null when nothing survives (every leg
 * collapsed) — the caller reports "offset too large".
 */
export function offsetPath(path: Path, s: number, gap: OffsetGap = "extend"): Path | null {
  const legs: Leg[] = [];
  for (const c of path.curves) {
    const o = offsetCurve(c, s);
    if (o) legs.push({ original: c, raw: o, curve: o });
  }
  if (legs.length === 0) return null;
  // Join neighbours, dropping legs that invert, until stable.
  for (let pass = 0; pass < legs.length + 2; pass++) {
    const joined = joinLegs(legs, path.closed, gap);
    const kept = joined.filter((l) => !l.kill && !inverted(l));
    if (kept.length === joined.length) {
      const curves = joined.map((l) => l.curve).filter((c) => curveLength(c) > EPS);
      if (curves.length === 0) return null;
      return { curves: joinContiguous(insertRoundJoins(joined, path.closed, s), path.closed), closed: path.closed };
    }
    legs.length = 0;
    legs.push(...kept);
    if (legs.length === 0) return null;
  }
  return null;
}

interface Leg {
  original: Curve;
  /** The plain offset, before any joining. */
  raw: Curve;
  /** The offset after joining to its neighbours. */
  curve: Curve;
  /** Set when the leg couldn't reach the next one: a round join about the vertex, or a straight bridge for collinear legs. */
  gapAfter?: { vertex: Point; straight: boolean };
  /** Set when the leg is swallowed by the offset (see joinLegs) and must go. */
  kill?: boolean;
}

/** True when an offset segment now runs against its original's direction (it turned inside out). */
function inverted(l: Leg): boolean {
  if (l.curve.kind !== "segment" || l.original.kind !== "segment") return curveLength(l.curve) < EPS;
  const t0 = tangentAt(l.original, 0);
  const dx = l.curve.b.x - l.curve.a.x;
  const dy = l.curve.b.y - l.curve.a.y;
  return dx * t0.x + dy * t0.y <= EPS;
}

/**
 * Extends or trims each pair of neighbouring legs to their intersection.
 * Works on fresh copies of the raw offsets so a dropped leg's neighbours
 * can be re-joined from scratch on the next pass.
 */
function joinLegs(legs: Leg[], closed: boolean, gap: OffsetGap): Leg[] {
  const out: Leg[] = legs.map((l) => ({ original: l.original, raw: l.raw, curve: l.raw }));
  const n = out.length;
  const pairs = closed ? n : n - 1;
  for (let i = 0; i < pairs; i++) {
    const a = out[i];
    const b = out[(i + 1) % n];
    if (n === 1) break;
    const vertex = curveEnd(a.original);
    const hits = intersectCurves(a.curve, b.curve, true, true);
    // The intersection nearest the original corner is the one that continues the outline.
    let best: { point: Point; t1: number; t2: number } | null = null;
    for (const h of hits) {
      if (!best || dist(h.point, vertex) < dist(best.point, vertex)) best = h;
    }
    // Round gap: an outer corner (both legs would have to grow to meet) keeps the raw legs and gets an arc about the vertex.
    const outer = gap === "round" && best && best.t1 > 1 + 1e-9 && best.t2 < -1e-9;
    if (outer) {
      a.gapAfter = { vertex, straight: false };
    } else if (best && usable(a.curve, best.t1, true) && usable(b.curve, best.t2, false)) {
      a.curve = cutCurve(a.curve, 0, best.t1);
      b.curve = cutCurve(b.curve, best.t2, 1);
    } else if (dist(curveEnd(a.curve), curveStart(b.curve)) > 1e-6) {
      const ta = tangentAt(a.curve, 1);
      const tb = tangentAt(b.curve, 0);
      const dot = ta.x * tb.x + ta.y * tb.y;
      if (dot < -0.5) {
        // Two legs heading back toward each other with nothing between them:
        // the walls of a slot narrower than the offset, both now inside the
        // offset region. Drop them and let their outer neighbours meet.
        a.kill = true;
        b.kill = true;
      } else {
        // Collinear legs (what's left after a slot vanished) bridge straight; anything else rounds the corner.
        a.gapAfter = { vertex, straight: dot > 1 - 1e-9 };
      }
    }
  }
  return out;
}

/** Whether a join parameter is acceptable for the curve: arcs only extend a half turn past either end. */
function usable(c: Curve, t: number, atEnd: boolean): boolean {
  // A segment may be cut anywhere along its line — a leg's start join can land
  // past its own end when the neighbour swings wide; the inversion check
  // afterwards drops legs that came out backwards.
  if (c.kind === "segment") return true;
  // An arc may extend up to a half turn past either end, in its own parameter.
  const reach = Math.PI / Math.max(curveLength(c) / c.radius, 1e-9);
  return atEnd ? t > EPS && t < 1 + reach : t < 1 - EPS && t > -reach;
}

/** A curve re-bounded to [t0, t1] in its own parameter (t may exceed [0, 1] to extend). */
function cutCurve(c: Curve, t0: number, t1: number): Curve {
  return subCurve(c, t0, t1);
}

/** Fills each recorded gap with an arc about the original vertex — the round join of a convex corner. */
function insertRoundJoins(legs: Leg[], closed: boolean, s: number): Curve[] {
  const curves: Curve[] = [];
  const n = legs.length;
  legs.forEach((l, i) => {
    curves.push(l.curve);
    if (!l.gapAfter) return;
    if (!closed && i === n - 1) return;
    const next = legs[(i + 1) % n];
    const from = curveEnd(l.curve);
    const to = curveStart(next.curve);
    const v = l.gapAfter.vertex;
    const r = Math.abs(s);
    if (dist(from, to) < 1e-6 || r < EPS) return;
    if (l.gapAfter.straight) {
      curves.push({ kind: "segment", a: from, b: to });
      return;
    }
    const a1 = Math.atan2(from.y - v.y, from.x - v.x);
    const a2 = Math.atan2(to.y - v.y, to.x - v.x);
    // Go the short way round the vertex.
    const ccwSweep = (((a2 - a1) % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2);
    curves.push({ kind: "arc", center: v, radius: r, startAngle: a1, endAngle: a2, ccw: ccwSweep <= Math.PI });
  });
  return curves;
}

/**
 * Offsets an entity by `distance` toward `side` (a click). The result has
 * no id/name; the caller assigns them. Null when the entity has no stroke,
 * or the offset collapses it (a circle offset inward past its center).
 */
export function offsetEntity(entity: Entity, distance: number, side: Point, gap: OffsetGap = "extend"): Entity | null {
  if (entity.type === "ellipse" || entity.type === "spline") {
    const exact = offsetExactCurve(entity, distance, side);
    if (exact !== undefined) return exact;
  }
  const path = pathOf(entity);
  if (!path || distance <= 0) return null;
  const s = distance * sideSign(path, side);
  const out = offsetPath(path, s, gap);
  if (!out) return null;
  return entityFromPath(out, entity, "");
}

/**
 * Offset "through point" (AutoCAD `OFFSET > Through`): the copy passes
 * through `point`, i.e. the distance is how far the point is from the
 * entity and the side is the point's side. Null when the point lies on it.
 */
export function offsetThroughPoint(entity: Entity, point: Point, gap: OffsetGap = "extend"): Entity | null {
  const path = pathOf(entity);
  if (!path) return null;
  let d = Infinity;
  for (const c of path.curves) d = Math.min(d, closestParam(c, point).distance);
  if (!(d > 1e-9) || !Number.isFinite(d)) return null;
  return offsetEntity(entity, d, point, gap);
}

const OFFSET_SAMPLES = 160;

/**
 * An ellipse's or spline's offset is neither an ellipse nor a spline of the
 * same kind, so it is sampled exactly (`P(t) + d·n(t)` on the true curve, not
 * on a chord chain) and refitted as one cubic spline — a clean entity with a
 * handful of points instead of hundreds of 0.05 mm segments. Offsetting
 * toward the centre of curvature further than the radius of curvature turns
 * the offset inside out; that is detected (an offset point nearer the source
 * than the distance asked) and refused, like a circle collapsing.
 * `undefined` = not handled here (an unclamped spline), use the chain.
 */
function offsetExactCurve(entity: Entity, distance: number, side: Point): Entity | null | undefined {
  const path = exactPathOf(entity);
  if (!path || path.curves.length !== 1 || distance <= 0) return undefined;
  const c = path.curves[0];
  if (c.kind !== "ellipse" && c.kind !== "nurbs") return undefined;
  const hit = closestParam(c, side);
  const n0 = tangentAt(c, hit.t);
  const sign = (side.x - hit.point.x) * -n0.y + (side.y - hit.point.y) * n0.x >= 0 ? 1 : -1;
  const pts: Point[] = [];
  const last = path.closed ? OFFSET_SAMPLES - 1 : OFFSET_SAMPLES;
  for (let i = 0; i <= last; i++) {
    const t = i / OFFSET_SAMPLES;
    const p = pointAt(c, t);
    const T = tangentAt(c, t);
    const q = { x: p.x - T.y * sign * distance, y: p.y + T.x * sign * distance };
    if (closestParam(c, q).distance < distance * 0.97) return null;
    pts.push(q);
  }
  if (path.closed) pts.push({ ...pts[0] });
  const s = interpolateNurbs(pts);
  if (!s) return null;
  return entityFromPath({ curves: [{ kind: "nurbs", s }], closed: path.closed }, entity, "");
}
