import type { Constraint, PointRef } from "./constraints";
import { ellipsePointAt } from "./ellipse";
import type { Entity, EntityId } from "./entities";
import { arcPointAt, mid, type Point } from "./geometry";

/**
 * Where a constraint's glyph goes (roadmap T-41).
 *
 * Constraints are invisible by nature: nothing on screen says why a line
 * refuses to tilt. Every CAD app answers that by drawing a little mark
 * next to the geometry each constraint holds, and this decides where
 * those marks sit — pure, so the placement is testable and the renderer
 * only has to draw a character.
 *
 * A constraint between two entities gets a mark on *each* of them, which
 * is what makes "these two are the parallel pair" readable at a glance.
 */

export type EntityLookup = (id: EntityId) => Entity | undefined;

/** The point a glyph for the whole entity attaches to: its middle, or a circle's rim. */
export function entityAnchor(entity: Entity): Point | null {
  switch (entity.type) {
    case "line":
      return mid(entity.a, entity.b);
    case "circle":
      // On the rim at 45°, clear of the centre marks concentric uses.
      return { x: entity.center.x + entity.radius * Math.SQRT1_2, y: entity.center.y + entity.radius * Math.SQRT1_2 };
    case "arc": {
      const sweep = entity.ccw ? entity.endAngle - entity.startAngle : entity.startAngle - entity.endAngle;
      const half = entity.startAngle + (entity.ccw ? sweep / 2 : -sweep / 2);
      return arcPointAt(entity.center, entity.radius, half);
    }
    case "point":
      return entity.p;
    case "text":
      return entity.at;
    case "insert":
      return entity.insert;
    case "ellipse":
      // The minor-axis end, clear of the centre and major-axis marks.
      return ellipsePointAt(entity, Math.PI / 2);
    case "spline":
      return entity.controlPoints.length === 0 ? null : entity.controlPoints[Math.floor((entity.controlPoints.length - 1) / 2)];
    case "polyline": {
      if (entity.points.length === 0) return null;
      const i = Math.floor((entity.points.length - 1) / 2);
      return entity.points.length === 1 ? entity.points[0] : mid(entity.points[i], entity.points[i + 1]);
    }
    case "text":
    case "image":
    default:
      return null;
  }
}

/** Resolves a {@link PointRef} to a position, for glyphs that mark a point rather than an entity. */
export function pointRefAt(lookup: EntityLookup, ref: PointRef): Point | null {
  const e = lookup(ref.entityId);
  if (!e) return null;
  switch (e.type) {
    case "line":
      return ref.point === "a" ? e.a : ref.point === "b" ? e.b : mid(e.a, e.b);
    case "circle":
      return e.center;
    case "arc":
      if (ref.point === "center") return e.center;
      return arcPointAt(e.center, e.radius, ref.point === "a" ? e.startAngle : e.endAngle);
    case "point":
      return e.p;
    case "text":
      return e.at;
    case "insert":
      return e.insert;
    case "ellipse": {
      if (ref.point === "center") return e.center;
      return ellipsePointAt(e, ref.point === "b" ? e.end : e.start);
    }
    case "spline": {
      const n = e.controlPoints.length;
      return n === 0 ? null : e.controlPoints[ref.point === "b" ? n - 1 : ref.point === "vertex" ? (ref.index ?? 0) : 0] ?? null;
    }
    case "polyline": {
      if (e.points.length === 0) return null;
      if (ref.point === "vertex") return e.points[ref.index ?? 0] ?? null;
      if (ref.point === "center") return mid(e.points[0], e.points[e.points.length - 1]);
      return ref.point === "b" ? e.points[e.points.length - 1] : e.points[0];
    }
    case "image":
    default:
      return null;
  }
}

/**
 * Every place this constraint should be marked. Pairwise constraints
 * return two points (one per entity); constraints about a point return
 * the point itself.
 */
export function constraintAnchors(lookup: EntityLookup, c: Constraint): Point[] {
  const ofEntity = (id: EntityId): Point[] => {
    const e = lookup(id);
    const at = e ? entityAnchor(e) : null;
    return at ? [at] : [];
  };
  const ofPoint = (ref: PointRef): Point[] => {
    const at = pointRefAt(lookup, ref);
    return at ? [at] : [];
  };
  switch (c.type) {
    case "horizontal":
    case "vertical":
    case "radius":
    case "fix":
    case "rotation":
      return ofEntity(c.entityId);
    case "parallel":
    case "perpendicular":
    case "tangent":
    case "equal":
    case "angle":
    case "concentric":
    case "collinear":
      return [...ofEntity(c.a), ...ofEntity(c.b)];
    case "coincident":
      // The two points are meant to be in the same place; one mark is enough.
      return ofPoint(c.a).length > 0 ? ofPoint(c.a) : ofPoint(c.b);
    case "distance": {
      const a = pointRefAt(lookup, c.a);
      const b = pointRefAt(lookup, c.b);
      return a && b ? [mid(a, b)] : [];
    }
    case "midpoint":
    case "point-on-curve":
      return ofPoint(c.point);
    case "symmetric": {
      const a = pointRefAt(lookup, c.a);
      const b = pointRefAt(lookup, c.b);
      return a && b ? [a, b] : [];
    }
  }
}
