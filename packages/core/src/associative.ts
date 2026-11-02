import { attachPoints } from "./constraintBuilder";
import { newConstraintId, type Constraint } from "./constraints";
import type { ArcEntity, Entity, LineEntity } from "./entities";
import { arcPointAt, dist, type Point } from "./geometry";
import type { CurveFillet } from "./filletCurves";

/**
 * T-46 associative tools: pure builders for the constraints that Mirror,
 * Offset and Fillet leave behind in Sketch mode. They return plain
 * `Constraint` values; the tool appends them to the same batch as the
 * geometry, so one undo step removes both.
 */

/** The line entity lying on the mirror axis a→b (both points within `tol`), if any. */
export function axisLineFor(a: Point, b: Point, entities: readonly Entity[], tol = 1e-6): LineEntity | null {
  const onLine = (l: LineEntity, p: Point): boolean => {
    const dx = l.b.x - l.a.x;
    const dy = l.b.y - l.a.y;
    const len = Math.hypot(dx, dy);
    if (len < 1e-12) return false;
    return Math.abs((p.x - l.a.x) * dy - (p.y - l.a.y) * dx) / len <= tol;
  };
  for (const e of entities) if (e.type === "line" && onLine(e, a) && onLine(e, b)) return e;
  return null;
}

/**
 * Mirror: each source/copy pair gets `symmetric` on every attach point
 * (they correspond index for index because `mirrored` keeps vertex order and
 * an arc's start/end) plus `equal` for curves. The axis must be a real line.
 */
export function mirrorConstraints(pairs: readonly { source: Entity; copy: Entity }[], axis: LineEntity | null): Constraint[] {
  if (!axis) return [];
  const out: Constraint[] = [];
  for (const { source, copy } of pairs) {
    if (source.id === axis.id) continue; // mirroring the axis onto itself says nothing
    const sp = attachPoints(source);
    const cp = attachPoints(copy);
    if (sp.length !== cp.length) continue;
    sp.forEach((s, i) => out.push({ id: newConstraintId(), type: "symmetric", a: s.ref, b: cp[i].ref, axis: axis.id }));
    if (source.type === "circle" || source.type === "arc") out.push({ id: newConstraintId(), type: "equal", a: source.id, b: copy.id });
  }
  return out;
}

/** Offset: a copied line stays parallel to its source; a copied arc/circle stays concentric. */
export function offsetConstraints(source: Entity, copy: Entity): Constraint[] {
  if (source.type === "line" && copy.type === "line") return [{ id: newConstraintId(), type: "parallel", a: source.id, b: copy.id }];
  if ((source.type === "arc" || source.type === "circle") && (copy.type === "arc" || copy.type === "circle"))
    return [{ id: newConstraintId(), type: "concentric", a: source.id, b: copy.id }];
  return [];
}

/**
 * Fillet of two lines (output of `filletLines`: each trimmed line ends at its
 * tangent point on `b`, the arc runs from line1's to line2's). Radius 0 / no
 * arc → the two corners are coincident. With `drivingRadius` the arc also
 * carries a radius dimension.
 */
export function filletConstraints(line1: LineEntity, line2: LineEntity, arc: ArcEntity | null, drivingRadius = false): Constraint[] {
  const pt = (id: string, point: "a" | "b" | "center") => ({ entityId: id, point });
  if (!arc) return [{ id: newConstraintId(), type: "coincident", a: pt(line1.id, "b"), b: pt(line2.id, "b") }];
  const out: Constraint[] = [
    { id: newConstraintId(), type: "coincident", a: pt(line1.id, "b"), b: pt(arc.id, "a") },
    { id: newConstraintId(), type: "coincident", a: pt(line2.id, "b"), b: pt(arc.id, "b") },
    { id: newConstraintId(), type: "tangent", a: line1.id, b: arc.id },
    { id: newConstraintId(), type: "tangent", a: line2.id, b: arc.id },
  ];
  if (drivingRadius) out.push({ id: newConstraintId(), type: "radius", entityId: arc.id, value: arc.radius });
  return out;
}

type EndRef = { ref: { entityId: string; point: "a" | "b" }; at: Point };

/** Endpoint refs of a line or arc with their positions (circles and the rest have none). */
function endRefs(e: Entity): EndRef[] {
  if (e.type === "line")
    return [
      { ref: { entityId: e.id, point: "a" }, at: e.a },
      { ref: { entityId: e.id, point: "b" }, at: e.b },
    ];
  if (e.type === "arc")
    return [
      { ref: { entityId: e.id, point: "a" }, at: arcPointAt(e.center, e.radius, e.startAngle) },
      { ref: { entityId: e.id, point: "b" }, at: arcPointAt(e.center, e.radius, e.endAngle) },
    ];
  return [];
}

function nearestEnds(xs: EndRef[], ys: EndRef[]): { x: EndRef; y: EndRef; d: number } | null {
  let best: { x: EndRef; y: EndRef; d: number } | null = null;
  for (const x of xs)
    for (const y of ys) {
      const d = dist(x.at, y.at);
      if (!best || d < best.d) best = { x, y, d };
    }
  return best;
}

/**
 * Fillet / corner join of any line/arc/circle pair (a `filletCurves` result,
 * with the arc's id assigned): the arc's ends are coincident with the trimmed
 * entities' ends (point-on-curve on a circle, which has no end) and the arc
 * is tangent to both. Radius 0 / no arc: the two nearest ends coincide.
 * Ellipses and splines get nothing.
 */
export function filletCurveConstraints(r: CurveFillet, arc: ArcEntity | null, drivingRadius = false): Constraint[] {
  const ok = (e: Entity) => e.type === "line" || e.type === "arc" || e.type === "circle";
  if (!ok(r.first) || !ok(r.second)) return [];
  const out: Constraint[] = [];
  if (!arc) {
    const n = nearestEnds(endRefs(r.first), endRefs(r.second));
    if (n && n.d <= 1e-4) out.push({ id: newConstraintId(), type: "coincident", a: n.x.ref, b: n.y.ref });
    return out;
  }
  const arcEnds = endRefs(arc);
  for (const e of [r.first, r.second]) {
    if (e.type === "circle") {
      const on = arcEnds.find((x) => Math.abs(dist(x.at, e.center) - e.radius) <= 1e-4 * Math.max(1, e.radius));
      if (on) out.push({ id: newConstraintId(), type: "point-on-curve", point: on.ref, entityId: e.id });
    } else {
      const n = nearestEnds(endRefs(e), arcEnds);
      if (n && n.d <= 1e-4) out.push({ id: newConstraintId(), type: "coincident", a: n.x.ref, b: n.y.ref });
    }
    out.push({ id: newConstraintId(), type: "tangent", a: e.id, b: arc.id });
  }
  if (drivingRadius) out.push({ id: newConstraintId(), type: "radius", entityId: arc.id, value: arc.radius });
  return out;
}
