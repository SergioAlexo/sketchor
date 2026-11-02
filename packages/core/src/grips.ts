import type { Entity } from "./entities";
import type { PointRef } from "./constraints";
import { imageCorners } from "./entities";
import { arcPointAt, arcSweep, dist, type Point } from "./geometry";
import { kindApplyGrip, kindGrips } from "./kinds/registry";

/**
 * Grips (roadmap T-27): the handles drawn on a selected entity and what
 * dragging each one does. AutoCAD's model — an endpoint grip stretches
 * that end, a midpoint/center grip moves the whole entity, a circle's
 * quadrant grip changes the radius, an arc's end grip changes that end's
 * angle, a polyline vertex grip moves that vertex — resolved here as pure
 * "the entity with this grip at that point" functions so the viewport only
 * has to draw squares and drag one.
 */

/** `tangent`: a fit spline's end-tangent handle (index 0 start, 1 end). `cv`: a control vertex shown on a fit spline ("Show CVs"). `rotate`: an insert's rotation handle. `param`: a dynamic block parameter handle (index = position in `paramGrips`, B-22). */
export type GripKind = "end" | "mid" | "center" | "quadrant" | "vertex" | "insert" | "tangent" | "cv" | "rotate" | "param";

export interface Grip {
  point: Point;
  kind: GripKind;
  /** Which end / vertex / quadrant this is, for `applyGrip`. */
  index: number;
}

export function gripsOf(e: Entity): Grip[] {
  switch (e.type) {
    case "line":
      return [
        { point: e.a, kind: "end", index: 0 },
        { point: e.b, kind: "end", index: 1 },
        { point: { x: (e.a.x + e.b.x) / 2, y: (e.a.y + e.b.y) / 2 }, kind: "mid", index: 0 },
      ];
    case "circle": {
      const { center: c, radius: r } = e;
      return [
        { point: c, kind: "center", index: 0 },
        { point: { x: c.x + r, y: c.y }, kind: "quadrant", index: 0 },
        { point: { x: c.x, y: c.y + r }, kind: "quadrant", index: 1 },
        { point: { x: c.x - r, y: c.y }, kind: "quadrant", index: 2 },
        { point: { x: c.x, y: c.y - r }, kind: "quadrant", index: 3 },
      ];
    }
    case "arc": {
      const sweep = arcSweep(e.startAngle, e.endAngle, e.ccw);
      const midAngle = e.ccw ? e.startAngle + sweep / 2 : e.startAngle - sweep / 2;
      return [
        { point: arcPointAt(e.center, e.radius, e.startAngle), kind: "end", index: 0 },
        { point: arcPointAt(e.center, e.radius, e.endAngle), kind: "end", index: 1 },
        { point: arcPointAt(e.center, e.radius, midAngle), kind: "mid", index: 0 },
        { point: e.center, kind: "center", index: 0 },
      ];
    }
    case "polyline":
      return e.points.map((p, i) => ({ point: p, kind: "vertex" as const, index: i }));
    case "point":
      return [{ point: e.p, kind: "insert", index: 0 }];
    case "text":
      return [{ point: e.at, kind: "insert", index: 0 }];
    case "image":
      return [{ point: e.insert, kind: "insert", index: 0 }, ...imageCorners(e).slice(1, 3).map((p, i) => ({ point: p, kind: "vertex" as const, index: i + 1 }))];
    default:
      return kindGrips(e as Entity);
  }
}

/**
 * The entity after dragging `grip` to `to`. Moves the whole entity for
 * mid/center/insert grips; stretches one end, one vertex, or the radius
 * otherwise. An image's far corners resize it about the insertion point.
 */
export function applyGrip(e: Entity, grip: Grip, to: Point): Entity {
  const dx = to.x - grip.point.x;
  const dy = to.y - grip.point.y;
  const shift = (p: Point): Point => ({ x: p.x + dx, y: p.y + dy });
  switch (e.type) {
    case "line":
      if (grip.kind === "mid") return { ...e, a: shift(e.a), b: shift(e.b) };
      return grip.index === 0 ? { ...e, a: to } : { ...e, b: to };
    case "circle":
      if (grip.kind === "center") return { ...e, center: to };
      return { ...e, radius: Math.max(1e-9, dist(e.center, to)) };
    case "arc": {
      if (grip.kind === "center" || grip.kind === "mid") return { ...e, center: shift(e.center) };
      const angle = Math.atan2(to.y - e.center.y, to.x - e.center.x);
      // Dragging an end changes its angle only; the radius stays (AutoCAD stretches the arc, it doesn't resize it).
      return grip.index === 0 ? { ...e, startAngle: angle } : { ...e, endAngle: angle };
    }
    case "polyline":
      return { ...e, points: e.points.map((p, i) => (i === grip.index ? to : p)) };
    case "point":
      return { ...e, p: to };
    case "text":
      return { ...e, at: to };
    case "image": {
      if (grip.kind === "insert") return { ...e, insert: to };
      // Corner grips: size along the image's own axes.
      const cos = Math.cos(e.rotation);
      const sin = Math.sin(e.rotation);
      const lx = (to.x - e.insert.x) * cos + (to.y - e.insert.y) * sin;
      const ly = -(to.x - e.insert.x) * sin + (to.y - e.insert.y) * cos;
      if (grip.index === 1) return { ...e, width: Math.max(1e-6, lx) };
      return { ...e, width: Math.max(1e-6, lx), height: Math.max(1e-6, ly) };
    }
    default:
      return kindApplyGrip(e as Entity, grip, to);
  }
}

/**
 * The constrainable point a grip stands for, or null when it doesn't
 * stand for one (a circle's quadrant is a radius, not a point; a
 * polyline's middle vertices have no name a `PointRef` can hold yet).
 *
 * This is what lets a grip drag become a *solve* rather than a move: the
 * solver is told "this point wants to be at the cursor" and everything
 * the constraints tie to it follows (roadmap T-40).
 */
export function gripPointRef(entity: Entity, grip: Grip): PointRef | null {
  const ref = (point: PointRef["point"]): PointRef => ({ entityId: entity.id, point });
  switch (entity.type) {
    case "line":
      if (grip.kind === "mid") return ref("center");
      return ref(grip.index === 0 ? "a" : "b");
    case "arc":
      if (grip.kind === "center" || grip.kind === "mid") return ref("center");
      return ref(grip.index === 0 ? "a" : "b");
    case "circle":
      return grip.kind === "center" ? ref("center") : null;
    case "point":
      return ref("a");
    case "polyline": {
      if (grip.kind !== "vertex") return null;
      if (grip.index === 0) return ref("a");
      return grip.index === entity.points.length - 1 ? ref("b") : null;
    }
    case "ellipse": {
      // The centre, and the major-axis end when it is the parameter-0 point (what `a` names).
      // Arc-end grips re-angle the arc, which the solver does not own, so they stay plain edits.
      if (grip.kind === "center") return ref("center");
      const atZero = Math.abs(Math.sin(entity.start / 2)) < 1e-9;
      return grip.kind === "quadrant" && grip.index === 0 && atZero ? ref("a") : null;
    }
    case "spline":
      // Control-point grips only: with fit points the grips re-interpolate, which is not a point the solver moves.
      if (entity.fitPoints || grip.kind !== "vertex") return null;
      return { entityId: entity.id, point: "vertex", index: grip.index };
    case "text":
    case "image":
      return null;
    default:
      return null; // a kind with no solver parameters
  }
}
