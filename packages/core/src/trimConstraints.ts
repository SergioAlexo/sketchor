import { attachPoints } from "./constraintBuilder";
import { newConstraintId, type Constraint, type ConstraintId, type PointRef } from "./constraints";
import type { Entity, EntityId } from "./entities";
import { dist, type Point } from "./geometry";
import { closestParam, exactPathOf } from "./intersect";

/**
 * T-46 leftover: Trim / Split keep the sketch's intent in Sketch mode.
 *
 * Trimming deletes an entity and adds 0–2 pieces with new ids, which would
 * orphan every constraint on the original (a rectangle's corners come apart
 * the moment a side is trimmed). `trimConstraints` works out, for a set of
 * such replacements at once (a fence trim replaces many), which constraints
 * to remove and what to add instead:
 *
 * 1. **Carried over** — each constraint touching a replaced entity is
 *    re-pointed at the pieces. A point reference follows the point: the
 *    piece that still has an attach point at the same position takes it
 *    (a line's kept end, a polyline's kept vertex); a centre goes to the
 *    first piece with a centre. Orientation-type constraints (horizontal,
 *    vertical, fix, parallel, perpendicular, collinear, angle, tangent,
 *    concentric, radius, equal radius) hold for every compatible piece, so
 *    each gets a copy. Anything whose meaning does not survive a cut —
 *    equal length, midpoint of the trimmed line, a point that was on the
 *    removed part — is dropped.
 * 2. **New ends** — every piece end that is not one of the original's
 *    points was made by a cutting edge: it becomes coincident with that
 *    edge's end when it is one, otherwise point-on-curve on the edge
 *    (lines, arcs, circles, ellipses, splines — the curves the solver can
 *    hold a point on).
 *
 * Pieces must carry their final ids. `cutters` is the drawing after the
 * trim (originals gone, pieces in); a piece is never tied to a sibling.
 */

export interface TrimReplacement {
  original: Entity;
  pieces: Entity[];
}

export interface TrimConstraintChanges {
  remove: ConstraintId[];
  add: Constraint[];
}

const ON_CURVE = new Set<Entity["type"]>(["line", "arc", "circle", "ellipse", "spline"]);

function tolFor(...es: Entity[]): number {
  let size = 1;
  for (const e of es) {
    const pts = attachPoints(e).map((p) => p.at);
    for (const p of pts) size = Math.max(size, Math.abs(p.x), Math.abs(p.y));
  }
  return 1e-7 * size;
}

function positionOf(e: Entity, ref: PointRef): Point | null {
  const hit = attachPoints(e).find(
    (p) => p.ref.point === ref.point && (ref.point !== "vertex" || p.ref.index === ref.index),
  );
  return hit ? hit.at : null;
}

function distanceTo(e: Entity, p: Point): number {
  const path = exactPathOf(e);
  if (!path) return Infinity;
  let d = Infinity;
  for (const c of path.curves) d = Math.min(d, closestParam(c, p).distance);
  return d;
}

const isLine = (e: Entity) => e.type === "line";
const isRound = (e: Entity) => e.type === "arc" || e.type === "circle";

export function trimConstraints(
  replacements: readonly TrimReplacement[],
  constraints: readonly Constraint[],
  cutters: readonly Entity[],
): TrimConstraintChanges {
  const byId = new Map<EntityId, TrimReplacement>();
  for (const r of replacements) byId.set(r.original.id, r);
  const pieceIds = new Map<EntityId, EntityId>(); // piece id -> original id
  for (const r of replacements) for (const p of r.pieces) pieceIds.set(p.id, r.original.id);

  /** A point reference on a replaced entity, moved to the piece that kept the point (null = gone). */
  const mapRef = (ref: PointRef): PointRef | null => {
    const r = byId.get(ref.entityId);
    if (!r) return ref;
    if (ref.point === "center") {
      const piece = r.pieces.find((p) => attachPoints(p).some((a) => a.ref.point === "center"));
      return piece ? { entityId: piece.id, point: "center" } : null;
    }
    const at = positionOf(r.original, ref);
    if (!at) return null;
    for (const piece of r.pieces) {
      const tol = tolFor(r.original, piece);
      const hit = attachPoints(piece).find((a) => a.ref.point !== "center" && dist(a.at, at) <= tol);
      if (hit) return hit.ref;
    }
    return null;
  };

  /** The ids an entity reference expands to: the pieces that `fits`, or the id itself when not replaced. */
  const expand = (id: EntityId, fits: (e: Entity) => boolean): EntityId[] => {
    const r = byId.get(id);
    if (!r) return [id];
    return r.pieces.filter(fits).map((p) => p.id);
  };

  const remove: ConstraintId[] = [];
  const add: Constraint[] = [];
  const fresh = <C extends Constraint>(c: C): C => ({ ...c, id: newConstraintId() });

  /** For a two-entity constraint: every piece of the replaced side × the other side (its first piece if replaced too). */
  const pairs = (a: EntityId, b: EntityId, fits: (e: Entity) => boolean): [EntityId, EntityId][] => {
    const as = expand(a, fits);
    const bs = expand(b, fits);
    if (byId.has(a)) return as.flatMap((x) => (bs.length ? [[x, bs[0]] as [EntityId, EntityId]] : []));
    return bs.map((y) => [a, y] as [EntityId, EntityId]);
  };

  for (const c of constraints) {
    let touches = false;
    const ids: EntityId[] = [];
    switch (c.type) {
      case "coincident":
      case "distance":
      case "symmetric":
        ids.push(c.a.entityId, c.b.entityId);
        if (c.type === "symmetric") ids.push(c.axis);
        break;
      case "midpoint":
      case "point-on-curve":
        ids.push(c.point.entityId, c.entityId);
        break;
      case "horizontal":
      case "vertical":
      case "fix":
      case "radius":
      case "rotation":
        ids.push(c.entityId);
        break;
      default:
        ids.push(c.a, c.b);
    }
    touches = ids.some((id) => byId.has(id));
    if (!touches) continue;
    remove.push(c.id);

    switch (c.type) {
      case "coincident":
      case "distance": {
        const a = mapRef(c.a);
        const b = mapRef(c.b);
        if (a && b) add.push(fresh({ ...c, a, b }));
        break;
      }
      case "symmetric": {
        const a = mapRef(c.a);
        const b = mapRef(c.b);
        const axis = expand(c.axis, isLine)[0];
        if (a && b && axis) add.push(fresh({ ...c, a, b, axis }));
        break;
      }
      case "midpoint": {
        if (byId.has(c.entityId)) break; // the line it halved is not the same length any more
        const point = mapRef(c.point);
        if (point) add.push(fresh({ ...c, point }));
        break;
      }
      case "point-on-curve": {
        const point = mapRef(c.point);
        if (!point) break;
        const r = byId.get(c.entityId);
        if (!r) {
          add.push(fresh({ ...c, point }));
          break;
        }
        // The point stays on whichever piece it actually sits on; on the removed part, the constraint goes.
        const owner = byId.get(c.point.entityId)?.original ?? cutters.find((e) => e.id === c.point.entityId);
        const at = owner ? positionOf(owner, c.point) : null;
        if (!at) break;
        let best: Entity | null = null;
        let bd = Infinity;
        for (const p of r.pieces) {
          if (!ON_CURVE.has(p.type)) continue;
          const d = distanceTo(p, at);
          if (d < bd) {
            bd = d;
            best = p;
          }
        }
        if (best && bd <= tolFor(r.original, best) * 10) add.push(fresh({ ...c, point, entityId: best.id }));
        break;
      }
      case "horizontal":
      case "vertical":
        for (const id of expand(c.entityId, isLine)) add.push(fresh({ ...c, entityId: id }));
        break;
      case "fix":
        for (const id of expand(c.entityId, () => true)) add.push(fresh({ ...c, entityId: id }));
        break;
      case "radius":
        for (const id of expand(c.entityId, isRound)) add.push(fresh({ ...c, entityId: id }));
        break;
      case "rotation":
        break; // texts and inserts are never trimmed
      case "parallel":
      case "perpendicular":
      case "collinear":
      case "angle":
        for (const [a, b] of pairs(c.a, c.b, isLine)) add.push(fresh({ ...c, a, b }));
        break;
      case "concentric":
        for (const [a, b] of pairs(c.a, c.b, isRound)) add.push(fresh({ ...c, a, b }));
        break;
      case "tangent":
        for (const [a, b] of pairs(c.a, c.b, (e) => isLine(e) || isRound(e))) add.push(fresh({ ...c, a, b }));
        break;
      case "equal": {
        // Equal radius survives a cut; equal length does not.
        const kind = [c.a, c.b].map((id) => byId.get(id)?.original).find(Boolean);
        if (kind && isRound(kind)) for (const [a, b] of pairs(c.a, c.b, isRound)) add.push(fresh({ ...c, a, b }));
        break;
      }
    }
  }

  // New ends: tie each to the edge that cut it.
  for (const r of replacements) {
    const originalPoints = attachPoints(r.original).map((p) => p.at);
    for (const piece of r.pieces) {
      const tol = tolFor(r.original, piece);
      const ends = attachPoints(piece).filter((p) => p.ref.point === "a" || p.ref.point === "b");
      for (const end of ends) {
        if (originalPoints.some((q) => dist(q, end.at) <= tol)) continue;
        const candidates = cutters.filter((e) => e.id !== piece.id && pieceIds.get(e.id) !== r.original.id);
        let tied: Constraint | null = null;
        for (const e of candidates) {
          const hit = attachPoints(e).find((a) => (a.ref.point === "a" || a.ref.point === "b") && dist(a.at, end.at) <= tolFor(e, piece));
          if (hit) {
            tied = { id: newConstraintId(), type: "coincident", a: end.ref, b: hit.ref };
            break;
          }
        }
        if (!tied)
          for (const e of candidates) {
            if (!ON_CURVE.has(e.type)) continue;
            if (distanceTo(e, end.at) <= tolFor(e, piece) * 10) {
              tied = { id: newConstraintId(), type: "point-on-curve", point: end.ref, entityId: e.id };
              break;
            }
          }
        if (tied) add.push(tied);
      }
    }
  }

  return { remove, add };
}
