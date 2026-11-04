import type { Command } from "./commands";
import { dimOfCircle, dimOfLine } from "./dimensions/build";
import type { DimensionEntity, Entity } from "./entities";

/**
 * T-08 post-commit quick edit: the length of the line (or the radius of the
 * circle/arc) a tool has just drawn can be retyped without drawing it again.
 * Pure: the tool collects the typed number, this says what to change.
 *
 *  - a line keeps its first end and direction, the far end moves;
 *  - a circle or arc keeps its centre (an arc its sweep), the radius changes;
 *  - with `driving` the edit also leaves a driving dimension (D-02b) holding
 *    the typed value, so the sketch keeps it; geometry is moved first so the
 *    solver has nothing left to correct (the far end, not both ends, moves).
 */

export type QuickEditKind = "length" | "radius";

export interface QuickEditTarget {
  kind: QuickEditKind;
  /** Current value in world units (mm). */
  value: number;
}

/** What can be retyped on `e`, or null (infinite construction lines, zero-length lines, other types). */
export function quickEditTarget(e: Entity): QuickEditTarget | null {
  if (e.type === "line") {
    if (e.infinite) return null;
    const len = Math.hypot(e.b.x - e.a.x, e.b.y - e.a.y);
    return len > 1e-9 ? { kind: "length", value: len } : null;
  }
  if ((e.type === "circle" || e.type === "arc") && e.radius > 1e-9) return { kind: "radius", value: e.radius };
  return null;
}

/** `e` with the target set to `value`; null when the value is unusable (not finite, zero or negative) or `e` has no target. */
export function applyQuickEdit(e: Entity, value: number): Entity | null {
  if (!Number.isFinite(value) || value <= 1e-9) return null;
  if (!quickEditTarget(e)) return null;
  if (e.type === "line") {
    const len = Math.hypot(e.b.x - e.a.x, e.b.y - e.a.y);
    const k = value / len;
    return { ...e, b: { x: e.a.x + (e.b.x - e.a.x) * k, y: e.a.y + (e.b.y - e.a.y) * k } };
  }
  if (e.type === "circle" || e.type === "arc") return { ...e, radius: value };
  return null;
}

/**
 * The commands for one quick edit (empty when the value is unusable): the
 * geometry update, plus a driving dimension when `driving`. Run them as one
 * batch so it is a single undo step.
 */
export function quickEditCommands(e: Entity, value: number, opts: { driving: boolean; layer?: string } = { driving: false }): Command[] {
  const next = applyQuickEdit(e, value);
  if (!next) return [];
  const commands: Command[] = [{ type: "update-entity", entity: next }];
  if (opts.driving) {
    const dim = quickEditDimension(next, value, opts.layer);
    if (dim) commands.push({ type: "add-entity", entity: dim });
  }
  return commands;
}

/** The driving dimension that holds a quick-edited value, placed clear of the geometry. */
function quickEditDimension(e: Entity, value: number, layer?: string): DimensionEntity | null {
  const o = layer ? { layer } : {};
  let dim: DimensionEntity | null = null;
  if (e.type === "line") {
    const dx = e.b.x - e.a.x;
    const dy = e.b.y - e.a.y;
    const len = Math.hypot(dx, dy);
    const off = Math.max(len * 0.15, 1e-3);
    const mid = { x: (e.a.x + e.b.x) / 2, y: (e.a.y + e.b.y) / 2 };
    dim = dimOfLine(e, { x: mid.x - (dy / len) * off, y: mid.y + (dx / len) * off }, o);
  } else if (e.type === "circle" || e.type === "arc") {
    dim = dimOfCircle(e, { x: e.center.x + e.radius * 2, y: e.center.y }, "radial", o);
  }
  return dim ? { ...dim, driving: true, value } : null;
}
