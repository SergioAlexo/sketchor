import type { Constraint } from "../constraints";
import type { DimensionEntity, Entity, EntityId } from "../entities";
import { evaluateValue, exprRefs, parseExpr, type ParamEnv } from "../expr";
import { solveSketch } from "../solver/solve";
import { cannotDrive, dimConstraintId, dimensionConstraint } from "./driving";
import { measureOf } from "./resolve";

/**
 * D-02b UI, pure half: what the double-click value editor, the Properties
 * "Driving" toggle and the dimension tool (in Sketch mode) ask before they
 * change a dimension.
 *
 *  - `dimValueKind` / `dimEditValue`: what the editor shows (a driving
 *    dimension's target, else what it measures now).
 *  - `parseDimValue`: the typed text → mm / radians. Expressions and
 *    parameters (T-45) work; a bare number is in the display unit (lengths)
 *    or degrees (angles), like everywhere else a user types a value.
 *  - `drivingCheck`: would this dimension, driving at this value, over-define
 *    the sketch? Onshape and Fusion both stop and ask at exactly this point —
 *    a driving dimension that the other constraints already imply is either
 *    redundant (harmless now, a conflict the moment one of them changes) or
 *    in conflict.
 *  - `withDimValue` / `withDriving`: the replacement entity, ready for one
 *    `update-entity`.
 */

type Lookup = (id: EntityId) => Entity | undefined;

export type DimValueKind = "length" | "angle";

export const dimValueKind = (e: Pick<DimensionEntity, "kind">): DimValueKind => (e.kind === "angular2l" || e.kind === "angular3p" ? "angle" : "length");

/** What the value editor opens with: the driving target, or the current measurement for a reference dimension. */
export function dimEditValue(e: DimensionEntity, lookup?: Lookup): number {
  if (e.driving && e.value !== undefined && Number.isFinite(e.value)) return e.value;
  return measureNow(e, lookup);
}

/** The dimension's measurement with references followed through `lookup` (or the active document when omitted). */
function measureNow(e: DimensionEntity, lookup?: Lookup): number {
  if (!lookup) return measureOf(e);
  // The measurement needs no styles, only the geometry the references name.
  return measureOf(e, { get: lookup, getRecord: () => undefined, tablesRevision: 0 });
}

export type ParsedDimValue = { ok: true; value: number; expression?: string } | { ok: false; error: string };

/**
 * Typed text → value. `unitToMm` is how many mm one display unit is (25.4 for
 * inches). A plain number keeps no expression; anything naming a parameter
 * is kept as the dimension's `expression`, so editing the parameter later
 * moves the geometry again.
 */
export function parseDimValue(text: string, kind: DimValueKind, env: ParamEnv = new Map(), unitToMm = 1): ParsedDimValue {
  const src = text.trim();
  if (!src) return { ok: false, error: "Type a value" };
  const r = evaluateValue(src, env, kind);
  if (!r.ok) return { ok: false, error: r.error };
  // evaluateValue already turned a bare angle into radians; a bare length is in the display unit.
  const value = kind === "length" && !r.usesUnit ? r.value * unitToMm : r.value;
  if (!Number.isFinite(value) || value <= 0) return { ok: false, error: kind === "angle" ? "The angle must be more than 0" : "The value must be more than 0" };
  const usesParam = exprRefs(parseExpr(src)).size > 0;
  return usesParam ? { ok: true, value, expression: src } : { ok: true, value };
}

export type DrivingCheck =
  /** Safe to make driving. */
  | { ok: true }
  /** Cannot drive at all (`cannotDrive`'s reason). */
  | { ok: false; reason: "cannot"; message: string }
  /** Would over-define the sketch: the other constraints already fix this value (redundant) or contradict it (conflict). */
  | { ok: false; reason: "over"; message: string; conflict: boolean };

/**
 * Would `dim`, driving at `value`, over-define the sketch made of `entities`
 * and `constraints` (the document's `solverConstraints()`; any constraint the
 * dimension itself already stands for is ignored)? Runs the solver once
 * without applying anything.
 */
export function drivingCheck(dim: DimensionEntity, value: number, entities: Iterable<Entity>, constraints: readonly Constraint[]): DrivingCheck {
  const all = [...entities];
  const byId = new Map(all.map((e) => [e.id, e]));
  const lookup: Lookup = (id) => byId.get(id);
  const why = cannotDrive(dim, lookup);
  if (why) return { ok: false, reason: "cannot", message: why };
  const candidate = dimensionConstraint({ ...dim, driving: true, value }, lookup);
  if (!candidate) return { ok: false, reason: "cannot", message: "This dimension cannot drive at that value" };
  const id = dimConstraintId(dim.id);
  const others = constraints.filter((c) => c.id !== id);
  const result = solveSketch(all, [...others, candidate]);
  if (result.conflicts.includes(id)) return { ok: false, reason: "over", conflict: true, message: "The other constraints contradict this value — driving it would over-define the sketch" };
  if (result.redundant.includes(id)) return { ok: false, reason: "over", conflict: false, message: "The other constraints already fix this value — driving it would over-define the sketch" };
  // A conflict elsewhere that only appears with the candidate is still this dimension's doing.
  const before = others.length ? solveSketch(all, others, { maxIterations: 0 }) : null;
  const newConflicts = result.conflicts.filter((c) => !(before?.conflicts ?? []).includes(c));
  if (newConflicts.length) return { ok: false, reason: "over", conflict: true, message: "Driving this value would put other constraints in conflict" };
  return { ok: true };
}

/** `dim` set to `value` (and `expression`, or none): driving when it can drive, else a reference dimension showing that text. */
export function withDimValue(dim: DimensionEntity, value: number, expression: string | undefined, lookup: Lookup, driving = true): DimensionEntity {
  const { expression: _old, ...rest } = dim;
  void _old;
  const canDrive = driving && !cannotDrive(dim, lookup);
  return { ...rest, ...(expression ? { expression } : {}), driving: canDrive, value };
}

/**
 * `dim` switched to driving (holding its current measurement, so nothing
 * moves) or to reference. Returns the reason instead when it cannot drive.
 */
export function withDriving(dim: DimensionEntity, driving: boolean, lookup: Lookup): DimensionEntity | { error: string } {
  if (!driving) return { ...dim, driving: false };
  const why = cannotDrive(dim, lookup);
  if (why) return { error: why };
  const value = dim.expression && dim.value !== undefined ? dim.value : measureNow(dim, lookup);
  return { ...dim, driving: true, value };
}

/**
 * Sketch mode (K-03): a new dimension drives at what it measures when it can
 * and doesn't over-define the sketch; otherwise it stays a reference (and the
 * reason is returned for the status bar).
 */
export function asNewDriving(dim: DimensionEntity, entities: Iterable<Entity>, constraints: readonly Constraint[]): { dim: DimensionEntity; note?: string } {
  const all = [...entities];
  const byId = new Map(all.map((e) => [e.id, e]));
  const lookup: Lookup = (id) => byId.get(id);
  if (cannotDrive(dim, lookup)) return { dim };
  const value = measureNow(dim, lookup);
  if (!(value > 0)) return { dim };
  const check = drivingCheck(dim, value, all, constraints);
  if (!check.ok) return { dim, note: check.reason === "over" ? "Added as a reference dimension: the sketch already fixes that value" : check.message };
  return { dim: { ...dim, driving: true, value } };
}

/** `asNewDriving` over a batch (QDIM chains, baseline sets): each dimension is checked against the sketch plus the ones accepted before it. */
export function asNewDrivingAll(dims: readonly DimensionEntity[], entities: Iterable<Entity>, constraints: readonly Constraint[]): { dims: DimensionEntity[]; note?: string } {
  const all = [...entities];
  const cs = [...constraints];
  const out: DimensionEntity[] = [];
  let note: string | undefined;
  for (const d of dims) {
    const r = asNewDriving(d, all, cs);
    out.push(r.dim);
    note ??= r.note;
    all.push(r.dim);
    const byId = new Map(all.map((e) => [e.id, e]));
    const c = dimensionConstraint(r.dim, (id) => byId.get(id));
    if (c) cs.push(c);
  }
  return note ? { dims: out, note } : { dims: out };
}
