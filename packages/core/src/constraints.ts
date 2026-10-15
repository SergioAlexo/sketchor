import type { EntityId } from "./entities";

/**
 * The constraint model — what the parametric layer stores.
 *
 * Constraints are plain, serializable data; `solver/` turns them into
 * equations and moves geometry to satisfy them (roadmap T-40), and
 * `constraintBuilder.ts` turns a selection into them (T-41). Keeping the
 * three apart is what lets the solver be replaced, or run in a worker,
 * without touching what a document contains.
 */
export type ConstraintId = string;

/**
 * A reference to one of an entity's meaningful points: an end (`a`/`b` —
 * for an arc these are its endpoints, for a polyline its first and last
 * vertex), the centre or midpoint, or a numbered polyline vertex.
 */
export interface PointRef {
  entityId: EntityId;
  point: "a" | "b" | "center" | "vertex";
  /** Which vertex, for `point: "vertex"`. Ignored otherwise. */
  index?: number;
}

export type Constraint =
  | { id: ConstraintId; type: "coincident"; a: PointRef; b: PointRef }
  | { id: ConstraintId; type: "horizontal"; entityId: EntityId }
  | { id: ConstraintId; type: "vertical"; entityId: EntityId }
  | { id: ConstraintId; type: "parallel"; a: EntityId; b: EntityId }
  | { id: ConstraintId; type: "perpendicular"; a: EntityId; b: EntityId }
  | { id: ConstraintId; type: "tangent"; a: EntityId; b: EntityId }
  | { id: ConstraintId; type: "equal"; a: EntityId; b: EntityId }
  /** `axis` set = only the x (or y) component of b − a is held, by magnitude (a horizontal / vertical dimension). */
  | { id: ConstraintId; type: "distance"; a: PointRef; b: PointRef; value: number; axis?: "x" | "y" }
  | { id: ConstraintId; type: "radius"; entityId: EntityId; value: number }
  | { id: ConstraintId; type: "angle"; a: EntityId; b: EntityId; value: number }
  | { id: ConstraintId; type: "fix"; entityId: EntityId }
  /** Two circles/arcs share a centre. */
  | { id: ConstraintId; type: "concentric"; a: EntityId; b: EntityId }
  /** `point` sits at the midpoint of `entityId` (a line). */
  | { id: ConstraintId; type: "midpoint"; point: PointRef; entityId: EntityId }
  /** `a` and `b` mirror each other about the line `axis`. */
  | { id: ConstraintId; type: "symmetric"; a: PointRef; b: PointRef; axis: EntityId }
  /** Two lines lie on the same infinite line. */
  | { id: ConstraintId; type: "collinear"; a: EntityId; b: EntityId }
  /** `point` lies somewhere on `entityId` (a line, circle or arc). */
  | { id: ConstraintId; type: "point-on-curve"; point: PointRef; entityId: EntityId }
  /** K-01: a text or block insert is turned to `value` radians (CCW) — placement of a block as an angle. */
  | { id: ConstraintId; type: "rotation"; entityId: EntityId; value: number };

let counter = 0;
export function newConstraintId(): ConstraintId {
  counter += 1;
  return `k${Date.now().toString(36)}${counter.toString(36)}`;
}

/** Every entity id a constraint references — used to keep constraints in sync when entities are deleted. */
export function constraintEntityIds(c: Constraint): EntityId[] {
  switch (c.type) {
    case "coincident":
    case "distance":
      return [c.a.entityId, c.b.entityId];
    case "horizontal":
    case "vertical":
    case "radius":
    case "fix":
    case "rotation":
      return [c.entityId];
    case "parallel":
    case "perpendicular":
    case "tangent":
    case "equal":
    case "angle":
    case "concentric":
    case "collinear":
      return [c.a, c.b];
    case "midpoint":
    case "point-on-curve":
      return [c.point.entityId, c.entityId];
    case "symmetric":
      return [c.a.entityId, c.b.entityId, c.axis];
  }
}

/** Human-readable name, for the constraint list and the status bar. */
export const CONSTRAINT_LABELS: Record<Constraint["type"], string> = {
  coincident: "Coincident",
  horizontal: "Horizontal",
  vertical: "Vertical",
  parallel: "Parallel",
  perpendicular: "Perpendicular",
  tangent: "Tangent",
  equal: "Equal",
  distance: "Distance",
  radius: "Radius",
  angle: "Angle",
  fix: "Fix",
  concentric: "Concentric",
  midpoint: "Midpoint",
  symmetric: "Symmetric",
  collinear: "Collinear",
  "point-on-curve": "Point on curve",
  rotation: "Rotation",
};
