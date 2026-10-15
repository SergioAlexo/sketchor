import { newConstraintId, type Constraint, type PointRef } from "./constraints";
import { pointRefAt } from "./constraintDisplay";
import type { Entity } from "./entities";
import { arcPointAt, closestPointOnSegment, dist, mid, type Point } from "./geometry";

/**
 * Auto-constraints while drawing (roadmap T-43).
 *
 * When a point is placed with a snap that fired — an endpoint, a midpoint,
 * a point on a curve, an ortho/polar ray at 0/90°, a perpendicular or
 * tangent foot — the geometry that results *is* in that relationship, to
 * floating-point exactness. So instead of threading snap provenance
 * through every tool, this looks at the finished entities and names the
 * relationships they were drawn in. A cursor that merely landed close
 * doesn't qualify (the tolerance is far below a pixel at any zoom), which
 * keeps accidental near-misses from becoming constraints.
 *
 * Pure: hand it the entities just added and everything already in the
 * drawing; get constraints to add in the same undo step as the geometry.
 */

export interface InferOptions {
  /** How exact "exactly" is, in mm. */
  tolerance?: number;
}

const TOL = 1e-6;
const ANGLE_TOL = 1e-7;

type Supported = Extract<Entity, { type: "line" | "circle" | "arc" | "point" }>;
const supported = (e: Entity): e is Supported => e.type === "line" || e.type === "circle" || e.type === "arc" || e.type === "point";

/** The points of an entity a new point can be coincident with. */
function featureRefs(e: Entity): PointRef[] {
  switch (e.type) {
    case "line":
      return [
        { entityId: e.id, point: "a" },
        { entityId: e.id, point: "b" },
      ];
    case "arc":
      return [
        { entityId: e.id, point: "a" },
        { entityId: e.id, point: "b" },
        { entityId: e.id, point: "center" },
      ];
    case "circle":
      return [{ entityId: e.id, point: "center" }];
    case "point":
      return [{ entityId: e.id, point: "a" }];
    case "polyline":
      return e.points.map((_, index) => ({ entityId: e.id, point: "vertex" as const, index }));
    default:
      return [];
  }
}

/** The points of a *new* entity worth relating to the rest. */
function ownRefs(e: Supported): PointRef[] {
  switch (e.type) {
    case "line":
    case "arc":
      return [
        { entityId: e.id, point: "a" },
        { entityId: e.id, point: "b" },
      ];
    case "circle":
      return [{ entityId: e.id, point: "center" }];
    case "point":
      return [{ entityId: e.id, point: "a" }];
  }
}

/** Distance from `p` to the curve of `e` (a line segment, circle or arc); null for kinds without one here. */
function offCurve(e: Entity, p: Point): number | null {
  switch (e.type) {
    case "line":
      return dist(p, closestPointOnSegment(p, e.a, e.b));
    case "circle":
      return Math.abs(dist(p, e.center) - e.radius);
    case "arc": {
      const r = Math.abs(dist(p, e.center) - e.radius);
      const full = Math.PI * 2;
      const from = e.ccw ? e.startAngle : e.endAngle;
      let span = (e.ccw ? e.endAngle - e.startAngle : e.startAngle - e.endAngle) % full;
      if (span <= 0) span += full;
      const rel = (((Math.atan2(p.y - e.center.y, p.x - e.center.x) - from) % full) + full) % full;
      if (rel <= span + 1e-9) return r;
      const s = arcPointAt(e.center, e.radius, e.startAngle);
      const t = arcPointAt(e.center, e.radius, e.endAngle);
      return Math.min(dist(p, s), dist(p, t));
    }
    default:
      return null;
  }
}

function sameRef(x: PointRef, y: PointRef): boolean {
  return x.entityId === y.entityId && x.point === y.point && (x.index ?? 0) === (y.index ?? 0);
}

/**
 * Constraints implied by how `added` was drawn relative to `existing`
 * (which may include `added`; an entity is never related to itself).
 * At most one point constraint per placed point, one direction constraint
 * per line.
 */
export function inferConstraints(added: readonly Entity[], existing: readonly Entity[], options: InferOptions = {}): Constraint[] {
  const tol = options.tolerance ?? TOL;
  const out: Constraint[] = [];
  const all = new Map<string, Entity>();
  for (const e of existing) all.set(e.id, e);
  for (const e of added) all.set(e.id, e);
  const lookup = (id: string) => all.get(id);

  for (const e of added) {
    if (!supported(e)) continue;
    if ((e.type === "line" && dist(e.a, e.b) < tol) || (e.type === "circle" && e.radius < tol)) continue;

    let axisAligned = false;
    if (e.type === "line") {
      if (Math.abs(e.a.y - e.b.y) < tol) {
        out.push({ id: newConstraintId(), type: "horizontal", entityId: e.id });
        axisAligned = true;
      } else if (Math.abs(e.a.x - e.b.x) < tol) {
        out.push({ id: newConstraintId(), type: "vertical", entityId: e.id });
        axisAligned = true;
      }
    }

    /** What this entity's placed points touch, for the perpendicular / tangent check below. */
    const touched: Entity[] = [];

    for (const ref of ownRefs(e)) {
      const p = pointRefAt(lookup, ref);
      if (!p) continue;
      // 1. Coincident with another entity's feature point.
      let done = false;
      for (const o of all.values()) {
        if (o.id === e.id) continue;
        for (const r of featureRefs(o)) {
          const q = pointRefAt(lookup, r);
          if (!q || dist(p, q) > tol) continue;
          // A joint between two new entities is found from both sides; keep one.
          if (!out.some((c) => c.type === "coincident" && ((sameRef(c.a, ref) && sameRef(c.b, r)) || (sameRef(c.a, r) && sameRef(c.b, ref))))) {
            out.push({ id: newConstraintId(), type: "coincident", a: ref, b: r });
          }
          touched.push(o);
          done = true;
          break;
        }
        if (done) break;
      }
      if (done) continue;
      // 2. Midpoint of a line.
      for (const o of all.values()) {
        if (o.id === e.id || o.type !== "line") continue;
        if (dist(p, mid(o.a, o.b)) <= tol) {
          out.push({ id: newConstraintId(), type: "midpoint", point: ref, entityId: o.id });
          touched.push(o);
          done = true;
          break;
        }
      }
      if (done || e.type === "circle") continue;
      // 3. On a line / circle / arc.
      for (const o of all.values()) {
        if (o.id === e.id) continue;
        const d = offCurve(o, p);
        if (d !== null && d <= tol) {
          out.push({ id: newConstraintId(), type: "point-on-curve", point: ref, entityId: o.id });
          touched.push(o);
          break;
        }
      }
    }

    if (e.type !== "line") continue;
    const dx = e.b.x - e.a.x;
    const dy = e.b.y - e.a.y;
    const len = Math.hypot(dx, dy);
    let related = false;

    // Square to the line it ends on (perpendicular), or to the radius where it meets a circle (tangent).
    for (const o of touched) {
      if (o.type === "line") {
        const ox = o.b.x - o.a.x;
        const oy = o.b.y - o.a.y;
        const olen = Math.hypot(ox, oy);
        // Square to an axis-aligned line while axis-aligned yourself is already said twice over.
        if (axisAligned && (Math.abs(ox) < tol || Math.abs(oy) < tol)) continue;
        if (olen > tol && Math.abs(dx * ox + dy * oy) / (len * olen) < ANGLE_TOL) {
          out.push({ id: newConstraintId(), type: "perpendicular", a: e.id, b: o.id });
          related = true;
          break;
        }
      } else if (o.type === "circle" || o.type === "arc") {
        const hit = [e.a, e.b].find((p) => {
          const d = offCurve(o, p);
          return d !== null && d <= tol;
        });
        if (!hit) continue;
        const rx = hit.x - o.center.x;
        const ry = hit.y - o.center.y;
        const rlen = Math.hypot(rx, ry);
        if (rlen > tol && Math.abs(dx * rx + dy * ry) / (len * rlen) < ANGLE_TOL) {
          out.push({ id: newConstraintId(), type: "tangent", a: e.id, b: o.id });
          related = true;
          break;
        }
      }
    }
    if (related || axisAligned) continue;

    // A slanted line drawn parallel to an existing slanted line (axis-aligned ones are already stated by horizontal/vertical).
    for (const o of all.values()) {
      if (o.id === e.id || o.type !== "line") continue;
      const ox = o.b.x - o.a.x;
      const oy = o.b.y - o.a.y;
      const olen = Math.hypot(ox, oy);
      if (olen < tol || Math.abs(ox) < tol || Math.abs(oy) < tol) continue;
      if (Math.abs(dx * oy - dy * ox) / (len * olen) < ANGLE_TOL) {
        out.push({ id: newConstraintId(), type: "parallel", a: e.id, b: o.id });
        break;
      }
    }
  }
  return out;
}
