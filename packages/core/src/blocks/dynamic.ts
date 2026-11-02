import type { Constraint } from "../constraints";
import { drivingConstraints } from "../dimensions/driving";
import type { Entity, EntityId, InsertEntity } from "../entities";
import type { Point } from "../geometry";
import { kindBounds, kindTransform, type Affine } from "../kinds/registry";
import { solveSketch } from "../solver/solve";
import { applyAffine, insertMatrix, mapPoint } from "./evaluate";
import type { BlockDefinition } from "./types";

/**
 * Dynamic and parametric blocks (plan B-20). A definition's optional
 * `dynamic` field holds a {@link DynamicSpec}: named parameters, the actions
 * that turn parameter values into geometry changes, visibility states and
 * lookup tables. An instance stores only the values (`insert.params`);
 * {@link evaluateDynamic} is the pure function from (definition, values) to
 * the body that instance shows, in definition (local) coordinates. The result
 * feeds `evaluate.ts` exactly as a static body would, so placement, arrays,
 * nesting, bounds, hit tests and export need no special case.
 *
 * Two authoring routes share the pipeline: AutoCAD's action model
 * (`linear` + `stretch`, `flip`, `visibility`, …) and the constraint route
 * (`dimension` params — a named handle on a distance/radius/angle constraint
 * of the definition, solved before the actions run).
 */

/** The values a parameter may take: a fixed list, or min/max with an optional step (counted from `min`, else 0). */
export interface ValueSet {
  list?: number[];
  min?: number;
  max?: number;
  increment?: number;
}

interface ParamBase {
  /** Key in `insert.params`. */
  name: string;
  /** Shown in the Properties panel; falls back to `name`. */
  label?: string;
}

/** A distance along base→end; value = the distance (default = |end − base|). */
export interface LinearParam extends ParamBase {
  kind: "linear";
  base: Point;
  end: Point;
  values?: ValueSet;
}
/** A distance and an angle from `base`: values `name` (distance) and `name.angle` (radians). */
export interface PolarParam extends ParamBase {
  kind: "polar";
  base: Point;
  end: Point;
  values?: ValueSet;
  angleValues?: ValueSet;
}
/** A free offset from `base`: values `name.x`, `name.y` (default 0). */
export interface XYParam extends ParamBase {
  kind: "xy" | "point";
  base: Point;
}
/** An angle about `center`, radians (default `default` ?? 0). */
export interface RotationParam extends ParamBase {
  kind: "rotation";
  center: Point;
  /** Where the grip sits, as a distance from the centre. */
  radius?: number;
  default?: number;
  values?: ValueSet;
}
/** 0 = as drawn, 1 = mirrored about the line base→end. */
export interface FlipParam extends ParamBase {
  kind: "flip";
  base: Point;
  end: Point;
}
/** Value = a state name from `visibilityStates`. */
export interface VisibilityParam extends ParamBase {
  kind: "visibility";
  default?: string;
}
/** Value = a row label of the lookup table `table`; the lookup action copies that row onto the other params. */
export interface LookupParam extends ParamBase {
  kind: "lookup";
  table: string;
  default?: string;
}
/** Parametric route: a named handle on a distance/radius/angle constraint of the definition. */
export interface DimensionParam extends ParamBase {
  kind: "dimension";
  constraintId: string;
  values?: ValueSet;
}
/** Carried for AutoCAD compatibility (DXF import); has no value and no effect on the geometry. */
export interface MarkerParam extends ParamBase {
  kind: "alignment" | "basepoint";
  at?: Point;
}

export type BlockParam = LinearParam | PolarParam | XYParam | RotationParam | FlipParam | VisibilityParam | LookupParam | DimensionParam | MarkerParam;
export type ParamKind = BlockParam["kind"];

/** An axis-aligned stretch frame in definition coordinates. */
export interface Frame {
  min: Point;
  max: Point;
}

/** `entities` absent = every entity of the body. */
export type BlockAction =
  /** The selection travels by the param's displacement (× multiplier). */
  | { kind: "move"; param: string; entities?: EntityId[]; multiplier?: number }
  /** Points of the selection inside `frame` travel by the displacement; the rest stay. */
  | { kind: "stretch"; param: string; frame: Frame; entities?: EntityId[]; multiplier?: number }
  /** As stretch, for a polar param: the points follow the end of the param as it swings and extends. */
  | { kind: "polar-stretch"; param: string; frame: Frame; entities?: EntityId[] }
  /** Scale the selection by value/default about the param's base (linear/polar). */
  | { kind: "scale"; param: string; entities?: EntityId[] }
  /** Rotate the selection by value − default about the param's centre/base (rotation/polar). */
  | { kind: "rotate"; param: string; entities?: EntityId[] }
  /** Mirror the selection about the flip axis while the param is 1. */
  | { kind: "flip"; param: string; entities?: EntityId[] }
  /** Repeat the selection every `spacing` along a linear param: floor(value / spacing) copies in all, the original first. */
  | { kind: "array"; param: string; spacing: number; entities?: EntityId[] }
  /** Copy the chosen row of the lookup param's table onto the params it names. Always resolved before the other actions. */
  | { kind: "lookup"; param: string };

export interface LookupTable {
  name: string;
  /** Param names the rows set. */
  inputs: string[];
  rows: { label: string; values: Record<string, number | string> }[];
}

export interface VisibilityState {
  name: string;
  /** Entities shown in this state. An entity named by no state is always shown. */
  visible: EntityId[];
}

export interface DynamicSpec {
  params: BlockParam[];
  actions: BlockAction[];
  visibilityStates?: VisibilityState[];
  lookup?: LookupTable[];
}

export type ParamValues = Record<string, number | string>;

/** The definition's spec, or undefined for a static block / a malformed field. */
export function dynamicSpecOf(def: BlockDefinition | undefined): DynamicSpec | undefined {
  const d = def?.dynamic as Partial<DynamicSpec> | undefined;
  return d && Array.isArray(d.params) && d.params.length > 0 ? (d as DynamicSpec) : undefined;
}

const EPS = 1e-9;
const dist = (a: Point, b: Point): number => Math.hypot(b.x - a.x, b.y - a.y);

/** The definition's constraints: the stored ones plus those its driving dimensions stand for (D-02b). */
export function blockConstraints(def: BlockDefinition): Constraint[] {
  const byId = new Map(def.entities.map((e) => [e.id, e] as const));
  const derived = def.entities.some((e) => e.type === "dimension" && e.driving) ? drivingConstraints(def.entities, (id) => byId.get(id)) : [];
  return [...(def.constraints ?? []), ...derived];
}

function constraintValue(c: Constraint | undefined): number | undefined {
  return c && (c.type === "distance" || c.type === "radius" || c.type === "angle") ? c.value : undefined;
}

/** The names of the numeric values a param owns in `insert.params`. */
export function paramKeys(p: BlockParam): string[] {
  switch (p.kind) {
    case "polar":
      return [p.name, `${p.name}.angle`];
    case "xy":
    case "point":
      return [`${p.name}.x`, `${p.name}.y`];
    case "alignment":
    case "basepoint":
      return [];
    default:
      return [p.name];
  }
}

/** Snaps `v` into a value set: nearest list entry, else clamped to min/max and rounded to the increment. */
export function snapToValueSet(v: number, set: ValueSet | undefined): number {
  if (!set || !Number.isFinite(v)) return v;
  if (set.list && set.list.length > 0) {
    let best = set.list[0];
    for (const x of set.list) if (Math.abs(x - v) < Math.abs(best - v)) best = x;
    return best;
  }
  let out = v;
  const origin = set.min ?? 0;
  if (set.increment && set.increment > 0) out = origin + Math.round((out - origin) / set.increment) * set.increment;
  if (set.min !== undefined && out < set.min) out = set.min;
  if (set.max !== undefined && out > set.max) out = set.max;
  return out;
}

/** The value set of a numeric param's primary value (undefined when it has none). */
export function valueSetOf(p: BlockParam): ValueSet | undefined {
  return p.kind === "linear" || p.kind === "polar" || p.kind === "rotation" || p.kind === "dimension" ? p.values : undefined;
}

/** The values of an instance that has set none: every param at its authored position. */
export function defaultParamValues(def: BlockDefinition, spec: DynamicSpec): ParamValues {
  const out: ParamValues = {};
  for (const p of spec.params) {
    switch (p.kind) {
      case "linear":
        out[p.name] = snapToValueSet(dist(p.base, p.end), p.values);
        break;
      case "polar":
        out[p.name] = snapToValueSet(dist(p.base, p.end), p.values);
        out[`${p.name}.angle`] = snapToValueSet(Math.atan2(p.end.y - p.base.y, p.end.x - p.base.x), p.angleValues);
        break;
      case "xy":
      case "point":
        out[`${p.name}.x`] = 0;
        out[`${p.name}.y`] = 0;
        break;
      case "rotation":
        out[p.name] = snapToValueSet(p.default ?? 0, p.values);
        break;
      case "flip":
        out[p.name] = 0;
        break;
      case "visibility":
        out[p.name] = p.default && spec.visibilityStates?.some((s) => s.name === p.default) ? p.default : (spec.visibilityStates?.[0]?.name ?? "");
        break;
      case "lookup": {
        const t = spec.lookup?.find((x) => x.name === p.table);
        out[p.name] = p.default && t?.rows.some((r) => r.label === p.default) ? p.default : (t?.rows[0]?.label ?? "");
        break;
      }
      case "dimension": {
        const v = constraintValue(blockConstraints(def).find((c) => c.id === p.constraintId));
        if (v !== undefined) out[p.name] = snapToValueSet(v, p.values);
        break;
      }
      default:
        break;
    }
  }
  return out;
}

/**
 * Completes and validates an instance's values: missing → default, numbers
 * snapped to their value sets, flips to 0/1, unknown state / row names back to
 * the default, unknown keys dropped. Lookup rows are then applied (they win
 * over the individually stored values of the params they set).
 */
export function resolveParamValues(def: BlockDefinition, spec: DynamicSpec, given?: ParamValues): ParamValues {
  const defaults = defaultParamValues(def, spec);
  const out: ParamValues = { ...defaults };
  const num = (key: string): number | undefined => {
    const v = given?.[key];
    const n = typeof v === "string" ? Number(v) : v;
    return typeof n === "number" && Number.isFinite(n) ? n : undefined;
  };
  for (const p of spec.params) {
    switch (p.kind) {
      case "linear": {
        const v = num(p.name);
        if (v !== undefined) out[p.name] = snapToValueSet(v, p.values);
        break;
      }
      case "dimension": {
        const v = num(p.name);
        if (v !== undefined) out[p.name] = snapToValueSet(v, p.values);
        break;
      }
      case "rotation": {
        const v = num(p.name);
        if (v !== undefined) out[p.name] = snapToValueSet(v, p.values);
        break;
      }
      case "polar": {
        const d = num(p.name);
        const a = num(`${p.name}.angle`);
        if (d !== undefined) out[p.name] = snapToValueSet(d, p.values);
        if (a !== undefined) out[`${p.name}.angle`] = snapToValueSet(a, p.angleValues);
        break;
      }
      case "xy":
      case "point": {
        const x = num(`${p.name}.x`);
        const y = num(`${p.name}.y`);
        if (x !== undefined) out[`${p.name}.x`] = x;
        if (y !== undefined) out[`${p.name}.y`] = y;
        break;
      }
      case "flip": {
        const v = num(p.name);
        if (v !== undefined) out[p.name] = v >= 0.5 ? 1 : 0;
        break;
      }
      case "visibility": {
        const v = given?.[p.name];
        if (typeof v === "string" && spec.visibilityStates?.some((s) => s.name === v)) out[p.name] = v;
        break;
      }
      case "lookup": {
        const v = given?.[p.name];
        const t = spec.lookup?.find((x) => x.name === p.table);
        if (typeof v === "string" && t?.rows.some((r) => r.label === v)) out[p.name] = v;
        break;
      }
      default:
        break;
    }
  }
  // Lookup actions: the chosen row sets the params it names.
  for (const a of spec.actions) {
    if (a.kind !== "lookup") continue;
    const p = spec.params.find((x) => x.name === a.param);
    if (!p || p.kind !== "lookup") continue;
    const row = spec.lookup?.find((x) => x.name === p.table)?.rows.find((r) => r.label === out[p.name]);
    if (!row) continue;
    for (const [k, v] of Object.entries(row.values)) {
      const owner = spec.params.find((q) => paramKeys(q).includes(k));
      if (!owner) continue;
      if (typeof v === "number") out[k] = owner.kind === "flip" ? (v >= 0.5 ? 1 : 0) : snapToValueSet(v, k === `${owner.name}.angle` && owner.kind === "polar" ? owner.angleValues : valueSetOf(owner));
      else if (owner.kind === "visibility" && spec.visibilityStates?.some((s) => s.name === v)) out[k] = v;
    }
  }
  return out;
}

/** True when `values` equal the definition's defaults (an instance that shows the base geometry). */
export function isDefaultValues(def: BlockDefinition, spec: DynamicSpec, values: ParamValues): boolean {
  const d = defaultParamValues(def, spec);
  return Object.keys(d).every((k) => d[k] === values[k]);
}

/** Stable key of resolved values. */
export function paramValuesKey(values: ParamValues): string {
  return Object.keys(values)
    .sort()
    .map((k) => `${k}=${values[k]}`)
    .join(";");
}

// --- evaluation ---------------------------------------------------------

const translate = (dx: number, dy: number): Affine => [1, 0, 0, 1, dx, dy];
function rotateAbout(c: Point, a: number): Affine {
  const cos = Math.cos(a);
  const sin = Math.sin(a);
  return [cos, sin, -sin, cos, c.x - (cos * c.x - sin * c.y), c.y - (sin * c.x + cos * c.y)];
}
function scaleAbout(c: Point, k: number): Affine {
  return [k, 0, 0, k, c.x - k * c.x, c.y - k * c.y];
}
function reflectAbout(p: Point, q: Point): Affine {
  const len = dist(p, q) || 1;
  const ux = (q.x - p.x) / len;
  const uy = (q.y - p.y) / len;
  const a = 2 * ux * ux - 1;
  const b = 2 * ux * uy;
  const d = 2 * uy * uy - 1;
  return [a, b, b, d, p.x - (a * p.x + b * p.y), p.y - (b * p.x + d * p.y)];
}

const inFrame = (p: Point, f: Frame): boolean => p.x >= f.min.x - EPS && p.x <= f.max.x + EPS && p.y >= f.min.y - EPS && p.y <= f.max.y + EPS;

/** Representative point of an entity with no vertex list: its bounds centre. */
function anchorOf(e: Entity): Point | null {
  switch (e.type) {
    case "circle":
    case "arc":
    case "ellipse":
      return e.center;
    case "text":
      return e.at;
    case "point":
      return e.p;
    case "insert":
      return e.insert;
    default: {
      const b = kindBounds(e);
      return b ? { x: (b.minX + b.maxX) / 2, y: (b.minY + b.maxY) / 2 } : null;
    }
  }
}

/** `e` with the part of it inside `frame` moved by (dx, dy) — endpoints/vertices individually, anything else whole when its anchor is inside. */
function stretchEntity(e: Entity, frame: Frame, dx: number, dy: number): Entity {
  const mv = (p: Point): Point => (inFrame(p, frame) ? { x: p.x + dx, y: p.y + dy } : p);
  if (e.type === "line") return { ...e, a: mv(e.a), b: mv(e.b) };
  if (e.type === "polyline") return { ...e, points: e.points.map(mv) };
  const anchor = anchorOf(e);
  if (!anchor || !inFrame(anchor, frame)) return e;
  return applyAffine(e, translate(dx, dy));
}

/** The vector the moving end of `p` has travelled from its default. */
function displacement(p: BlockParam, values: ParamValues, defaults: ParamValues): Point | null {
  if (p.kind === "linear") {
    const len = dist(p.base, p.end) || 1;
    const d = (Number(values[p.name]) - Number(defaults[p.name]));
    return { x: ((p.end.x - p.base.x) / len) * d, y: ((p.end.y - p.base.y) / len) * d };
  }
  if (p.kind === "polar") {
    const at = (v: ParamValues): Point => ({ x: Number(v[p.name]) * Math.cos(Number(v[`${p.name}.angle`])), y: Number(v[p.name]) * Math.sin(Number(v[`${p.name}.angle`])) });
    const a = at(values);
    const b = at(defaults);
    return { x: a.x - b.x, y: a.y - b.y };
  }
  if (p.kind === "xy" || p.kind === "point") {
    return { x: Number(values[`${p.name}.x`]) - Number(defaults[`${p.name}.x`]), y: Number(values[`${p.name}.y`]) - Number(defaults[`${p.name}.y`]) };
  }
  return null;
}

function applyActions(body: Entity[], spec: DynamicSpec, values: ParamValues, defaults: ParamValues): Entity[] {
  let cur = body;
  for (const a of spec.actions) {
    if (a.kind === "lookup") continue;
    const p = spec.params.find((x) => x.name === a.param);
    if (!p) continue;
    const sel = a.kind === "move" || a.kind === "stretch" || a.kind === "polar-stretch" || a.kind === "scale" || a.kind === "rotate" || a.kind === "flip" || a.kind === "array" ? (a.entities ? new Set(a.entities) : null) : null;
    const chosen = (e: Entity): boolean => sel === null || sel.has(e.id);
    switch (a.kind) {
      case "move": {
        const d = displacement(p, values, defaults);
        if (!d) break;
        const k = a.multiplier ?? 1;
        if (Math.abs(d.x * k) < EPS && Math.abs(d.y * k) < EPS) break;
        const m = translate(d.x * k, d.y * k);
        cur = cur.map((e) => (chosen(e) ? applyAffine(e, m) : e));
        break;
      }
      case "stretch":
      case "polar-stretch": {
        if (a.kind === "polar-stretch" && p.kind !== "polar") break;
        const d = displacement(p, values, defaults);
        if (!d) break;
        const k = a.kind === "stretch" ? (a.multiplier ?? 1) : 1;
        if (Math.abs(d.x * k) < EPS && Math.abs(d.y * k) < EPS) break;
        cur = cur.map((e) => (chosen(e) ? stretchEntity(e, a.frame, d.x * k, d.y * k) : e));
        break;
      }
      case "scale": {
        if (p.kind !== "linear" && p.kind !== "polar") break;
        const d0 = Number(defaults[p.name]);
        const k = d0 > EPS ? Number(values[p.name]) / d0 : 1;
        if (!(k > EPS) || Math.abs(k - 1) < EPS) break;
        const m = scaleAbout(p.base, k);
        cur = cur.map((e) => (chosen(e) ? applyAffine(e, m) : e));
        break;
      }
      case "rotate": {
        let about: Point;
        let delta: number;
        if (p.kind === "rotation") {
          about = p.center;
          delta = Number(values[p.name]) - Number(defaults[p.name]);
        } else if (p.kind === "polar") {
          about = p.base;
          delta = Number(values[`${p.name}.angle`]) - Number(defaults[`${p.name}.angle`]);
        } else break;
        if (Math.abs(delta) < EPS) break;
        const m = rotateAbout(about, delta);
        cur = cur.map((e) => (chosen(e) ? applyAffine(e, m) : e));
        break;
      }
      case "flip": {
        if (p.kind !== "flip" || values[p.name] !== 1) break;
        const m = reflectAbout(p.base, p.end);
        cur = cur.map((e) => (chosen(e) ? applyAffine(e, m) : e));
        break;
      }
      case "array": {
        if (p.kind !== "linear" || !(a.spacing > EPS)) break;
        const n = Math.max(1, Math.floor(Number(values[p.name]) / a.spacing + 1e-9));
        if (n <= 1) break;
        const len = dist(p.base, p.end) || 1;
        const ux = (p.end.x - p.base.x) / len;
        const uy = (p.end.y - p.base.y) / len;
        const src = cur.filter(chosen);
        const out = [...cur];
        for (let i = 1; i < n; i++) {
          const m = translate(ux * a.spacing * i, uy * a.spacing * i);
          for (const e of src) out.push({ ...applyAffine(e, m), id: `${e.id}#${i}` });
        }
        cur = out;
        break;
      }
    }
  }
  return cur;
}

/** The constraints with each dimension param's value substituted (expressions dropped so the value wins). */
function constraintsWith(def: BlockDefinition, spec: DynamicSpec, values: ParamValues): Constraint[] {
  const byId = new Map<string, number>();
  for (const p of spec.params) if (p.kind === "dimension" && typeof values[p.name] === "number") byId.set(p.constraintId, values[p.name] as number);
  return blockConstraints(def).map((c) => {
    const v = byId.get(c.id);
    if (v === undefined || !(c.type === "distance" || c.type === "radius" || c.type === "angle")) return c;
    const { expression: _e, ...rest } = c as Constraint & { expression?: string };
    void _e;
    return { ...rest, value: v } as Constraint;
  });
}

const cache = new WeakMap<BlockDefinition, Map<string, Entity[]>>();

/**
 * The body of `def` for the given parameter values, in definition
 * coordinates: dimension params are solved into the geometry first, then the
 * actions run in the spec's order on a copy, then entities hidden by the
 * current visibility state are dropped. A static block returns its entities
 * unchanged. Memoised per (definition record, resolved values) — an
 * `update-block` makes a new record, so editing the spec invalidates for free.
 */
export function evaluateDynamic(def: BlockDefinition, values?: ParamValues): Entity[] {
  const spec = dynamicSpecOf(def);
  if (!spec) return def.entities;
  const resolved = resolveParamValues(def, spec, values);
  const key = paramValuesKey(resolved);
  let byKey = cache.get(def);
  const hit = byKey?.get(key);
  if (hit) return hit;
  const defaults = defaultParamValues(def, spec);
  let body = def.entities;
  if (spec.params.some((p) => p.kind === "dimension") && blockConstraints(def).length > 0) {
    const r = solveSketch(def.entities, constraintsWith(def, spec, resolved));
    if (r.updates.length > 0) {
      const upd = new Map(r.updates.map((e) => [e.id, e] as const));
      body = body.map((e) => upd.get(e.id) ?? e);
    }
  }
  body = applyActions(body, spec, resolved, defaults);
  const states = spec.visibilityStates;
  const vp = spec.params.find((p) => p.kind === "visibility");
  if (states && states.length > 0 && vp) {
    const cur = states.find((s) => s.name === resolved[vp.name]);
    const everInState = new Set(states.flatMap((s) => s.visible));
    const shown = new Set(cur?.visible ?? []);
    body = body.filter((e) => {
      const base = e.id.split("#")[0];
      return !everInState.has(base) || shown.has(base);
    });
  }
  if (!byKey) {
    byKey = new Map();
    cache.set(def, byKey);
  }
  if (byKey.size > 64) byKey.clear();
  byKey.set(key, body);
  return body;
}

/** Evaluated body for an insert's stored values — what `evaluate.ts` places. */
export function insertBody(def: BlockDefinition, insert: Pick<InsertEntity, "params">): Entity[] {
  return dynamicSpecOf(def) ? evaluateDynamic(def, insert.params) : def.entities;
}

// --- grips --------------------------------------------------------------

export interface ParamGrip {
  param: string;
  kind: ParamKind;
  /** World position under the insert's placement. */
  point: Point;
}

/** Local position of a param's grip for the given resolved values, or null for params without one. */
function localGrip(p: BlockParam, v: ParamValues): Point | null {
  switch (p.kind) {
    case "linear": {
      const len = dist(p.base, p.end) || 1;
      const d = Number(v[p.name]);
      return { x: p.base.x + ((p.end.x - p.base.x) / len) * d, y: p.base.y + ((p.end.y - p.base.y) / len) * d };
    }
    case "polar": {
      const a = Number(v[`${p.name}.angle`]);
      const d = Number(v[p.name]);
      return { x: p.base.x + d * Math.cos(a), y: p.base.y + d * Math.sin(a) };
    }
    case "xy":
    case "point":
      return { x: p.base.x + Number(v[`${p.name}.x`]), y: p.base.y + Number(v[`${p.name}.y`]) };
    case "rotation": {
      const a = Number(v[p.name]);
      const r = p.radius ?? 1;
      return { x: p.center.x + r * Math.cos(a), y: p.center.y + r * Math.sin(a) };
    }
    case "flip": {
      const len = dist(p.base, p.end) || 1;
      const ux = (p.end.x - p.base.x) / len;
      const uy = (p.end.y - p.base.y) / len;
      const side = v[p.name] === 1 ? -1 : 1;
      const off = len * 0.25 * side;
      return { x: (p.base.x + p.end.x) / 2 - uy * off, y: (p.base.y + p.end.y) / 2 + ux * off };
    }
    default:
      return null;
  }
}

/** The param handles of an instance, in spec order (their order is the `index` of {@link applyParamGrip}). */
export function paramGrips(def: BlockDefinition, insert: InsertEntity): ParamGrip[] {
  const spec = dynamicSpecOf(def);
  if (!spec) return [];
  const v = resolveParamValues(def, spec, insert.params);
  const m = insertMatrix(insert, def.basePoint);
  const out: ParamGrip[] = [];
  for (const p of spec.params) {
    const l = localGrip(p, v);
    if (l) out.push({ param: p.name, kind: p.kind, point: mapPoint(m, l) });
  }
  return out;
}

function invert(m: Affine): Affine | null {
  const det = m[0] * m[3] - m[1] * m[2];
  if (Math.abs(det) < 1e-18) return null;
  const a = m[3] / det;
  const b = -m[1] / det;
  const c = -m[2] / det;
  const d = m[0] / det;
  return [a, b, c, d, -(a * m[4] + c * m[5]), -(b * m[4] + d * m[5])];
}

/** The instance with param grip number `index` (an index into {@link paramGrips}) dragged to world point `to`; values snap to the value set. */
export function applyParamGrip(def: BlockDefinition, insert: InsertEntity, index: number, to: Point): InsertEntity {
  const spec = dynamicSpecOf(def);
  const grip = paramGrips(def, insert)[index];
  if (!spec || !grip) return insert;
  const p = spec.params.find((x) => x.name === grip.param)!;
  const inv = invert(insertMatrix(insert, def.basePoint));
  if (!inv) return insert;
  const l = mapPoint(inv, to);
  const set = (patch: ParamValues): InsertEntity => ({ ...insert, params: resolveParamValues(def, spec, { ...resolveParamValues(def, spec, insert.params), ...patch }) });
  switch (p.kind) {
    case "linear": {
      const len = dist(p.base, p.end) || 1;
      const t = ((l.x - p.base.x) * (p.end.x - p.base.x) + (l.y - p.base.y) * (p.end.y - p.base.y)) / len;
      return set({ [p.name]: Math.max(t, p.values?.min ?? 0) });
    }
    case "polar":
      return set({ [p.name]: dist(p.base, l), [`${p.name}.angle`]: Math.atan2(l.y - p.base.y, l.x - p.base.x) });
    case "xy":
    case "point":
      return set({ [`${p.name}.x`]: l.x - p.base.x, [`${p.name}.y`]: l.y - p.base.y });
    case "rotation":
      return set({ [p.name]: Math.atan2(l.y - p.center.y, l.x - p.center.x) });
    case "flip": {
      const cross = (p.end.x - p.base.x) * (l.y - p.base.y) - (p.end.y - p.base.y) * (l.x - p.base.x);
      if (Math.abs(cross) < EPS) return insert;
      return set({ [p.name]: cross < 0 ? 1 : 0 });
    }
    default:
      return insert;
  }
}

/** The instance's values with every param back at its default ("Reset block"). */
export function resetParams(insert: InsertEntity): InsertEntity {
  const { params: _p, ...rest } = insert;
  void _p;
  return rest;
}

/** One entry of the Properties panel's "Custom" section. */
export interface ParamField {
  /** Key in `insert.params` the control edits. */
  key: string;
  label: string;
  control: "number" | "angle" | "choice" | "toggle";
  value: number | string;
  options?: (number | string)[];
  set?: ValueSet;
}

/** What the panel shows for an instance of `def`: one field per editable value. */
export function paramFields(def: BlockDefinition, insert: Pick<InsertEntity, "params">): ParamField[] {
  const spec = dynamicSpecOf(def);
  if (!spec) return [];
  const v = resolveParamValues(def, spec, insert.params);
  const out: ParamField[] = [];
  for (const p of spec.params) {
    const label = p.label ?? p.name;
    switch (p.kind) {
      case "linear":
      case "dimension":
        out.push({ key: p.name, label, control: "number", value: v[p.name], ...(p.values ? { set: p.values } : {}), ...(p.values?.list ? { options: p.values.list } : {}) });
        break;
      case "polar":
        out.push({ key: p.name, label, control: "number", value: v[p.name], ...(p.values ? { set: p.values } : {}) });
        out.push({ key: `${p.name}.angle`, label: `${label} angle`, control: "angle", value: v[`${p.name}.angle`] });
        break;
      case "xy":
      case "point":
        out.push({ key: `${p.name}.x`, label: `${label} X`, control: "number", value: v[`${p.name}.x`] });
        out.push({ key: `${p.name}.y`, label: `${label} Y`, control: "number", value: v[`${p.name}.y`] });
        break;
      case "rotation":
        out.push({ key: p.name, label, control: "angle", value: v[p.name] });
        break;
      case "flip":
        out.push({ key: p.name, label, control: "toggle", value: v[p.name] });
        break;
      case "visibility":
        out.push({ key: p.name, label, control: "choice", value: v[p.name], options: (spec.visibilityStates ?? []).map((s) => s.name) });
        break;
      case "lookup":
        out.push({ key: p.name, label, control: "choice", value: v[p.name], options: (spec.lookup?.find((t) => t.name === p.table)?.rows ?? []).map((r) => r.label) });
        break;
      default:
        break;
    }
  }
  return out;
}

/** Sets one field's value on an insert (the result is validated at evaluation, so an out-of-set number simply snaps). */
export function withParamValue(def: BlockDefinition, insert: InsertEntity, key: string, value: number | string): InsertEntity {
  const spec = dynamicSpecOf(def);
  if (!spec) return insert;
  return { ...insert, params: resolveParamValues(def, spec, { ...resolveParamValues(def, spec, insert.params), [key]: value }) };
}
