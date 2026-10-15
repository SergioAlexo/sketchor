import { attachPoints } from "./constraintBuilder";
import { newConstraintId, type Constraint } from "./constraints";
import type { ArcEntity, Entity, LineEntity } from "./entities";
import type { Point } from "./geometry";

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
