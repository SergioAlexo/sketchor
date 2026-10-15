import type { Constraint, ConstraintId } from "../constraints";
import { curveEval, footOf } from "./footCurves";
import { centerOf, directionOf, pointOf, radiusOf, rotationOf, type SketchModel } from "./model";
import {
  add,
  atan2Num,
  cross,
  distanceNum,
  div,
  dot,
  konst,
  length,
  mul,
  scale,
  sinNum,
  sub,
  variable,
  vsub,
  type Num,
  type Vec,
} from "./num";

/**
 * Constraints as equations the solver drives to zero.
 *
 * Every row is written so that **zero means satisfied and the units are
 * length or radians** — a distance residual is "how far off in mm", an
 * angular one "how far off in radians". Mixing scales (an unnormalised
 * cross product is mm², and grows with the size of the drawing) is what
 * makes a least-squares solver favour whichever constraint happens to be
 * on the biggest geometry, so parallel/perpendicular divide through by the
 * lengths and become a sine or a cosine of the misalignment.
 */

export interface Row {
  /** Which constraint produced this equation — for reporting conflicts. */
  constraint: ConstraintId;
  residual: Num;
}

/** sin of the angle between two vectors: zero when parallel, scale-free. */
function sinBetween(u: Vec, v: Vec): Num {
  const denom = mul(length(u), length(v));
  return div(cross(u, v), denom.v < 1e-12 ? konst(1e-12) : denom);
}

/** cos of the angle between two vectors: zero when perpendicular, scale-free. */
function cosBetween(u: Vec, v: Vec): Num {
  const denom = mul(length(u), length(v));
  return div(dot(u, v), denom.v < 1e-12 ? konst(1e-12) : denom);
}

/** The signed distance from a point to the infinite line through `a` with direction `d`. */
function pointToLine(p: Vec, a: Vec, d: Vec): Num {
  const len = length(d);
  return div(cross(d, vsub(p, a)), len.v < 1e-12 ? konst(1e-12) : len);
}

/**
 * `(q − 1)·L/2` with `q = (x'/L)² + (y'/(rL))²` in the ellipse's own frame
 * (L = semi-major length, r = ratio): zero on the curve, ≈ the distance in mm
 * near it, and smooth through the centre where `sqrt(q)` would not be.
 */
function ellipseResidual(model: SketchModel, p: Vec, id: string): Num | null {
  const center = centerOf(model, id);
  const u = directionOf(model, id);
  const mp = model.byEntity.get(id);
  if (!center || !u || !mp) return null;
  const ratio = model.frozen.has(mp.start + 4) ? konst(model.values[mp.start + 4]) : variable(mp.start + 4, model.values[mp.start + 4]);
  const L = length(u);
  const Ls = L.v < 1e-12 ? konst(1e-12) : L;
  const d = vsub(p, center);
  const xl = div(dot(d, u), Ls);
  const yl = div(cross(u, d), Ls);
  const a = div(xl, Ls);
  const b = div(yl, mul(ratio, Ls));
  return scale(mul(sub(add(mul(a, a), mul(b, b)), konst(1)), Ls), 0.5);
}

/**
 * Tangency of an ellipse or spline to a line, circle or arc through the
 * constraint's foot parameter `t` (the point of contact): the curve's
 * point P(t) is on the other shape, and the curve's direction there is
 * along the line / perpendicular to the radius. Null when this pair has no foot.
 */
function footTangent(model: SketchModel, c: Extract<Constraint, { type: "tangent" }>, row: (r: Num) => Row): Row[] | null {
  const t = footOf(model, c);
  if (!t) return null;
  const aIsCurve = model.entities.get(c.a)?.type === "ellipse" || model.entities.get(c.a)?.type === "spline";
  const curveId = aIsCurve ? c.a : c.b;
  const otherId = aIsCurve ? c.b : c.a;
  const ev = curveEval(model, curveId, t);
  if (!ev) return [];
  const center = centerOf(model, otherId);
  const radius = radiusOf(model, otherId);
  if (center && radius) {
    const rv = vsub(ev.p, center);
    return [row(sub(distanceNum(ev.p, center), radius)), row(cosBetween(ev.d, rv))];
  }
  const d = directionOf(model, otherId);
  const at = pointOf(model, { entityId: otherId, point: "a" });
  if (!d || !at) return [];
  return [row(pointToLine(ev.p, at, d)), row(sinBetween(ev.d, d))];
}

/**
 * The equations one constraint contributes, or `[]` when it references
 * geometry the solver can't move (a constraint on a text label, or on an
 * entity that has since been deleted). A constraint that produces no rows
 * also counts for nothing in the degrees-of-freedom tally, which is the
 * honest answer — it isn't constraining anything.
 */
export function rowsFor(model: SketchModel, c: Constraint): Row[] {
  const row = (residual: Num): Row => ({ constraint: c.id, residual });
  switch (c.type) {
    case "coincident": {
      const a = pointOf(model, c.a);
      const b = pointOf(model, c.b);
      if (!a || !b) return [];
      return [row(sub(a.x, b.x)), row(sub(a.y, b.y))];
    }
    case "horizontal": {
      const d = directionOf(model, c.entityId);
      return d ? [row(d.y)] : [];
    }
    case "vertical": {
      const d = directionOf(model, c.entityId);
      return d ? [row(d.x)] : [];
    }
    case "parallel": {
      const u = directionOf(model, c.a);
      const v = directionOf(model, c.b);
      return u && v ? [row(sinBetween(u, v))] : [];
    }
    case "perpendicular": {
      const u = directionOf(model, c.a);
      const v = directionOf(model, c.b);
      return u && v ? [row(cosBetween(u, v))] : [];
    }
    case "angle": {
      const u = directionOf(model, c.a);
      const v = directionOf(model, c.b);
      if (!u || !v) return [];
      // atan2 of the cross over the dot is the signed angle between them.
      // The difference is then shifted by whole turns to the nearest
      // equivalent angle: the shift is a constant, so it costs no
      // derivative, and it stops a residual of 2π−ε driving the solver the
      // long way round.
      const between = atan2Num(cross(u, v), dot(u, v));
      const diff = sub(between, konst(c.value));
      return [row(sub(diff, konst(Math.round(diff.v / (Math.PI * 2)) * Math.PI * 2)))];
    }
    case "distance": {
      const a = pointOf(model, c.a);
      const b = pointOf(model, c.b);
      if (!a || !b) return [];
      if (c.axis) {
        // |component| = value: the sign of today's offset is kept (a constant, so no derivative).
        const d = c.axis === "x" ? sub(b.x, a.x) : sub(b.y, a.y);
        return [row(sub(scale(d, d.v < 0 ? -1 : 1), konst(c.value)))];
      }
      return [row(sub(distanceNum(a, b), konst(c.value)))];
    }
    case "radius": {
      const r = radiusOf(model, c.entityId);
      return r ? [row(sub(r, konst(c.value)))] : [];
    }
    case "equal": {
      const ra = radiusOf(model, c.a);
      const rb = radiusOf(model, c.b);
      if (ra && rb) return [row(sub(ra, rb))];
      const da = directionOf(model, c.a);
      const db = directionOf(model, c.b);
      if (da && db) return [row(sub(length(da), length(db)))];
      return [];
    }
    case "tangent": {
      const foot = footTangent(model, c, row);
      if (foot) return foot;
      const ca = centerOf(model, c.a);
      const ra = radiusOf(model, c.a);
      const cb = centerOf(model, c.b);
      const rb = radiusOf(model, c.b);
      if (ca && ra && cb && rb) {
        // Two circles: keep whichever tangency they are nearer to now —
        // outside (centres apart by r₁+r₂) or inside (by |r₁−r₂|).
        const between = distanceNum(ca, cb);
        const outside = Math.abs(between.v - (ra.v + rb.v));
        const inside = Math.abs(between.v - Math.abs(ra.v - rb.v));
        if (outside <= inside) return [row(sub(between, add(ra, rb)))];
        return [row(sub(between, ra.v >= rb.v ? sub(ra, rb) : sub(rb, ra)))];
      }
      // A line and a circle: the centre sits exactly a radius off the line.
      const circleId = ca && ra ? c.a : cb && rb ? c.b : null;
      const lineId = circleId === c.a ? c.b : c.a;
      const center = circleId === c.a ? ca : cb;
      const radius = circleId === c.a ? ra : rb;
      const d = directionOf(model, lineId);
      const at = pointOf(model, { entityId: lineId, point: "a" });
      if (!center || !radius || !d || !at) return [];
      const signed = pointToLine(center, at, d);
      // Signed, so the circle stays on the side it is on rather than
      // flipping through the line to reach the nearest solution.
      return [row(signed.v >= 0 ? sub(signed, radius) : add(signed, radius))];
    }
    case "concentric": {
      const ca = centerOf(model, c.a);
      const cb = centerOf(model, c.b);
      if (!ca || !cb) return [];
      return [row(sub(ca.x, cb.x)), row(sub(ca.y, cb.y))];
    }
    case "midpoint": {
      const p = pointOf(model, c.point);
      const mid = pointOf(model, { entityId: c.entityId, point: "center" });
      if (!p || !mid) return [];
      return [row(sub(p.x, mid.x)), row(sub(p.y, mid.y))];
    }
    case "symmetric": {
      const a = pointOf(model, c.a);
      const b = pointOf(model, c.b);
      const axis = directionOf(model, c.axis);
      const on = pointOf(model, { entityId: c.axis, point: "a" });
      if (!a || !b || !axis || !on) return [];
      // Symmetry is two statements: the pair's midpoint is on the axis,
      // and the line joining them crosses it at a right angle.
      const mid = { x: scale(add(a.x, b.x), 0.5), y: scale(add(a.y, b.y), 0.5) };
      return [row(pointToLine(mid, on, axis)), row(cosBetween(vsub(b, a), axis))];
    }
    case "collinear": {
      const u = directionOf(model, c.a);
      const v = directionOf(model, c.b);
      const at = pointOf(model, { entityId: c.a, point: "a" });
      const other = pointOf(model, { entityId: c.b, point: "a" });
      if (!u || !v || !at || !other) return [];
      // Parallel, and one of the second line's points on the first line.
      return [row(sinBetween(u, v)), row(pointToLine(other, at, u))];
    }
    case "point-on-curve": {
      const p = pointOf(model, c.point);
      if (!p) return [];
      if (model.entities.get(c.entityId)?.type === "spline") {
        // A spline has no closed form: the foot parameter t makes P(t) = p.
        const t = footOf(model, c);
        const ev = t ? curveEval(model, c.entityId, t) : null;
        return ev ? [row(sub(ev.p.x, p.x)), row(sub(ev.p.y, p.y))] : [];
      }
      if (model.entities.get(c.entityId)?.type === "ellipse") {
        const ellipse = ellipseResidual(model, p, c.entityId);
        return ellipse ? [row(ellipse)] : [];
      }
      const center = centerOf(model, c.entityId);
      const radius = radiusOf(model, c.entityId);
      if (center && radius) return [row(sub(distanceNum(p, center), radius))];
      const d = directionOf(model, c.entityId);
      const at = pointOf(model, { entityId: c.entityId, point: "a" });
      if (!d || !at) return [];
      // On the *infinite* line: sliding along it is what makes the
      // constraint useful, and a point that leaves the drawn segment is
      // the user's business, not the solver's.
      return [row(pointToLine(p, at, d))];
    }
    case "rotation": {
      const r = rotationOf(model, c.entityId);
      // sin of the misalignment: zero at the target (and its half-turn twin, so the branch nearest the current angle wins), in radians near it.
      return r ? [row(sinNum(sub(r, konst(c.value))))] : [];
    }
    case "fix":
      // Handled by freezing the entity's parameters (see model.ts), which
      // removes degrees of freedom instead of adding equations.
      return [];
  }
}

/** Every equation for a whole sketch, in constraint order. */
export function allRows(model: SketchModel, constraints: readonly Constraint[]): Row[] {
  const rows: Row[] = [];
  for (const c of constraints) rows.push(...rowsFor(model, c));
  return rows;
}
