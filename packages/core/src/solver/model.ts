import type { Entity, EntityId } from "../entities";
import type { PointRef } from "../constraints";
import { konst, variable, add, cosNum, mul, scale, sinNum, sub, type Num, type Vec } from "./num";

/**
 * The document ↔ solver mapping: which numbers in a sketch are free to
 * move, in a stable order, so a constraint can talk about "parameter 7"
 * and the solution can be written back to the right field.
 *
 * Only geometry that can be constrained gets parameters. Text and images
 * have a position but no shape a constraint could bite on, so they are
 * left out entirely rather than given parameters nothing will ever move —
 * an unreferenced parameter is a phantom degree of freedom, and the DoF
 * readout is only useful if it counts real ones.
 */

export interface EntityParams {
  id: EntityId;
  /** Index of this entity's first parameter in the global vector. */
  start: number;
  count: number;
  kind: Entity["type"];
  /** Vertex count, for a polyline. */
  vertices: number;
}

export interface SketchModel {
  /** Current values of every free parameter, in solver order. */
  values: number[];
  byEntity: Map<EntityId, EntityParams>;
  /** Parameters held still: a fixed entity's, and a drag's anchor. */
  frozen: Set<number>;
  entities: Map<EntityId, Entity>;
  /** Auxiliary unknowns past the entity parameters: constraint id -> index in `values` (a foot parameter, see footCurves.ts). */
  aux?: Map<string, number>;
}

/** How many parameters each entity kind contributes. */
export function paramCount(entity: Entity): number {
  switch (entity.type) {
    case "line":
      return 4; // ax ay bx by
    case "circle":
      return 3; // cx cy r
    case "arc":
      return 5; // cx cy r start end
    case "point":
      return 2; // x y
    case "polyline":
      return entity.points.length * 2;
    case "ellipse":
      return 5; // cx cy majorX majorY ratio — start/end stay as drawn
    case "spline":
      return entity.controlPoints.length * 2; // knots and weights stay as drawn
    case "text":
    case "insert":
      return 3; // x y rotation — only modelled when a constraint names it (see buildModel)
    case "image":
    default:
      return 0; // no solver parameters — a new kind opts in by adding its own case
  }
}

function pushValues(entity: Entity, out: number[]): void {
  switch (entity.type) {
    case "line":
      out.push(entity.a.x, entity.a.y, entity.b.x, entity.b.y);
      return;
    case "circle":
      out.push(entity.center.x, entity.center.y, entity.radius);
      return;
    case "arc":
      out.push(entity.center.x, entity.center.y, entity.radius, entity.startAngle, entity.endAngle);
      return;
    case "point":
      out.push(entity.p.x, entity.p.y);
      return;
    case "polyline":
      for (const p of entity.points) out.push(p.x, p.y);
      return;
    case "ellipse":
      out.push(entity.center.x, entity.center.y, entity.majorAxis.x, entity.majorAxis.y, entity.ratio);
      return;
    case "spline":
      for (const p of entity.controlPoints) out.push(p.x, p.y);
      return;
    case "text":
      out.push(entity.at.x, entity.at.y, entity.rotation);
      return;
    case "insert":
      out.push(entity.insert.x, entity.insert.y, entity.rotation);
      return;
    case "image":
    default:
      return;
  }
}

/** Builds the parameter vector for `entities`, in document order. */
export function buildModel(entities: readonly Entity[], referenced?: ReadonlySet<EntityId>): SketchModel {
  const values: number[] = [];
  const byEntity = new Map<EntityId, EntityParams>();
  const map = new Map<EntityId, Entity>();
  for (const entity of entities) {
    map.set(entity.id, entity);
    const count = paramCount(entity);
    if (count === 0) continue;
    // Text and inserts are everywhere in a drawing and mostly unconstrained; giving every one three free
    // parameters would swamp the DoF readout with freedom nothing refers to (K-01).
    if ((entity.type === "text" || entity.type === "insert") && referenced && !referenced.has(entity.id)) continue;
    byEntity.set(entity.id, {
      id: entity.id,
      start: values.length,
      count,
      kind: entity.type,
      vertices: entity.type === "polyline" ? entity.points.length : entity.type === "spline" ? entity.controlPoints.length : 0,
    });
    pushValues(entity, values);
  }
  return { values, byEntity, frozen: new Set(), entities: map };
}

/** Marks every parameter of `id` as immovable (a `fix` constraint, or the untouched side of a drag). */
export function freezeEntity(model: SketchModel, id: EntityId): void {
  const p = model.byEntity.get(id);
  if (!p) return;
  for (let i = 0; i < p.count; i++) model.frozen.add(p.start + i);
}

/** The free (non-frozen) parameter indices, in order — the columns the solver actually works on. */
export function freeIndices(model: SketchModel): number[] {
  const free: number[] = [];
  for (let i = 0; i < model.values.length; i++) if (!model.frozen.has(i)) free.push(i);
  return free;
}

/**
 * A parameter as the solver sees it: a variable when it is free to move,
 * a constant when it is frozen — so a fixed entity contributes no columns
 * and no degrees of freedom rather than being pinned by extra rows.
 */
function param(model: SketchModel, index: number): Num {
  return model.frozen.has(index) ? konst(model.values[index]) : variable(index, model.values[index]);
}

function paramsOf(model: SketchModel, id: EntityId): { p: EntityParams; at: (offset: number) => Num } | null {
  const p = model.byEntity.get(id);
  if (!p) return null;
  return { p, at: (offset: number) => param(model, p.start + offset) };
}

/** A line's direction vector (b − a), or null when `id` isn't a line-like entity. */
export function directionOf(model: SketchModel, id: EntityId): Vec | null {
  const e = model.entities.get(id);
  const got = paramsOf(model, id);
  if (!e || !got) return null;
  if (e.type === "line") {
    return { x: sub(got.at(2), got.at(0)), y: sub(got.at(3), got.at(1)) };
  }
  // An ellipse's direction is its major axis, so horizontal/vertical/parallel/perpendicular turn it.
  if (e.type === "ellipse") return { x: got.at(2), y: got.at(3) };
  if (e.type === "polyline" && e.points.length >= 2) {
    // A polyline's direction is its first leg — enough for parallel and
    // perpendicular against a single-segment polyline, which is what DXF
    // imports full of two-point polylines produce.
    return { x: sub(got.at(2), got.at(0)), y: sub(got.at(3), got.at(1)) };
  }
  return null;
}

/** The centre of a circle or arc, as solver values. */
export function centerOf(model: SketchModel, id: EntityId): Vec | null {
  const e = model.entities.get(id);
  const got = paramsOf(model, id);
  if (!e || !got) return null;
  if (e.type === "circle" || e.type === "arc" || e.type === "ellipse") return { x: got.at(0), y: got.at(1) };
  return null;
}

/** The radius parameter of a circle or arc. */
export function radiusOf(model: SketchModel, id: EntityId): Num | null {
  const e = model.entities.get(id);
  const got = paramsOf(model, id);
  if (!e || !got) return null;
  if (e.type === "circle" || e.type === "arc") return got.at(2);
  return null;
}

/**
 * Resolves a {@link PointRef} to solver values. A line's `center` is its
 * midpoint and an arc's `a`/`b` are its endpoints — derived quantities,
 * which is exactly why the numbers carry their own derivatives: a
 * constraint on an arc's endpoint has to move the centre, the radius and
 * the angle, and none of that has to be spelled out here.
 */
export function pointOf(model: SketchModel, ref: PointRef): Vec | null {
  const e = model.entities.get(ref.entityId);
  const got = paramsOf(model, ref.entityId);
  if (!e || !got) return null;
  const { at } = got;
  switch (e.type) {
    case "line":
      if (ref.point === "a") return { x: at(0), y: at(1) };
      if (ref.point === "b") return { x: at(2), y: at(3) };
      return { x: scale(add(at(0), at(2)), 0.5), y: scale(add(at(1), at(3)), 0.5) };
    case "circle":
      return { x: at(0), y: at(1) };
    case "arc": {
      if (ref.point === "center") return { x: at(0), y: at(1) };
      const angle = ref.point === "a" ? at(3) : at(4);
      const r = at(2);
      return { x: add(at(0), mul(r, cosNum(angle))), y: add(at(1), mul(r, sinNum(angle))) };
    }
    case "point":
      return { x: at(0), y: at(1) };
    case "polyline": {
      // `a` is the first vertex and `b` the last — the ends a coincident
      // constraint means when it names a polyline — while `vertex` names
      // one by index, which is what a vertex grip refers to.
      if (ref.point === "vertex") {
        const i = ref.index ?? 0;
        if (i < 0 || i >= e.points.length) return null;
        return { x: at(i * 2), y: at(i * 2 + 1) };
      }
      if (ref.point === "center") {
        // The midpoint of a polyline isn't a defined thing; treat it as
        // the midpoint of its ends rather than inventing a centroid.
        const last = (e.points.length - 1) * 2;
        return { x: scale(add(at(0), at(last)), 0.5), y: scale(add(at(1), at(last + 1)), 0.5) };
      }
      const base = ref.point === "b" ? (e.points.length - 1) * 2 : 0;
      return { x: at(base), y: at(base + 1) };
    }
    case "ellipse": {
      if (ref.point === "center") return { x: at(0), y: at(1) };
      // `a`/`b`: the arc's start/end points (the major-axis end for a full ellipse).
      const t = ref.point === "b" ? e.end : e.start;
      const mx = at(2);
      const my = at(3);
      const r = at(4);
      const c = konst(Math.cos(t));
      const sn = konst(Math.sin(t));
      return {
        x: add(at(0), sub(mul(mx, c), mul(mul(my, r), sn))),
        y: add(at(1), add(mul(my, c), mul(mul(mx, r), sn))),
      };
    }
    case "spline": {
      const n = e.controlPoints.length;
      const i = ref.point === "vertex" ? (ref.index ?? 0) : ref.point === "b" ? n - 1 : 0;
      if (i < 0 || i >= n) return null;
      return { x: at(i * 2), y: at(i * 2 + 1) };
    }
    case "text":
    case "insert":
      return { x: at(0), y: at(1) }; // the anchor / insertion point, whichever ref names it
    case "image":
    default:
      return null;
  }
}

/** The rotation parameter of a text or block insert. */
export function rotationOf(model: SketchModel, id: EntityId): Num | null {
  const e = model.entities.get(id);
  const got = paramsOf(model, id);
  if (!e || !got || (e.type !== "text" && e.type !== "insert")) return null;
  return got.at(2);
}

/** Writes solved values back, returning only the entities that actually moved. */
export function applyModel(model: SketchModel, values: readonly number[], epsilon = 1e-9): Entity[] {
  const moved: Entity[] = [];
  for (const [id, p] of model.byEntity) {
    const entity = model.entities.get(id);
    if (!entity) continue;
    let changed = false;
    for (let i = 0; i < p.count; i++) {
      if (Math.abs(values[p.start + i] - model.values[p.start + i]) > epsilon) {
        changed = true;
        break;
      }
    }
    if (!changed) continue;
    moved.push(withValues(entity, values, p.start));
  }
  return moved;
}

function withValues(entity: Entity, v: readonly number[], at: number): Entity {
  switch (entity.type) {
    case "line":
      return { ...entity, a: { x: v[at], y: v[at + 1] }, b: { x: v[at + 2], y: v[at + 3] } };
    case "circle":
      return { ...entity, center: { x: v[at], y: v[at + 1] }, radius: Math.abs(v[at + 2]) };
    case "arc":
      return {
        ...entity,
        center: { x: v[at], y: v[at + 1] },
        radius: Math.abs(v[at + 2]),
        startAngle: v[at + 3],
        endAngle: v[at + 4],
      };
    case "point":
      return { ...entity, p: { x: v[at], y: v[at + 1] } };
    case "polyline":
      return { ...entity, points: entity.points.map((_, i) => ({ x: v[at + i * 2], y: v[at + i * 2 + 1] })) };
    case "ellipse":
      return { ...entity, center: { x: v[at], y: v[at + 1] }, majorAxis: { x: v[at + 2], y: v[at + 3] }, ratio: Math.abs(v[at + 4]) };
    case "spline": {
      // Fit points describe where the curve was meant to pass; once a solve moves the control points they would lie.
      const { fitPoints: _dropped, startTangent: _s, endTangent: _t, ...rest } = entity;
      return { ...rest, controlPoints: entity.controlPoints.map((_, i) => ({ x: v[at + i * 2], y: v[at + i * 2 + 1] })) };
    }
    case "text":
      return { ...entity, at: { x: v[at], y: v[at + 1] }, rotation: v[at + 2] };
    case "insert":
      return { ...entity, insert: { x: v[at], y: v[at + 1] }, rotation: v[at + 2] };
    case "image":
    default:
      return entity;
  }
}
