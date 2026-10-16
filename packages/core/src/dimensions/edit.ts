import type { Command } from "../commands";
import type { PointRef } from "../constraints";
import type { DimensionEntity, Entity } from "../entities";
import type { Point } from "../geometry";
import { arcPointAt } from "../geometry";
import { locatorIndex } from "../kinds/dimension";
import { refAtPoint } from "./build";

/**
 * D-09: pure dimension edits. Every function takes dimensions (and, when it
 * needs the drawing, the entities) and returns the *replacement* dimensions;
 * {@link updateCommands} turns them into one command, so a user action is a
 * single undo step. Nothing here reads the active document.
 */

const dot = (a: Point, b: Point): number => a.x * b.x + a.y * b.y;
const near = (a: Point, b: Point, tol: number): boolean => Math.hypot(a.x - b.x, a.y - b.y) <= tol;

/** The dimensions among `entities` (everything else is ignored). */
export function dimensionsOf(entities: Iterable<Entity | undefined>): DimensionEntity[] {
  const out: DimensionEntity[] = [];
  for (const e of entities) if (e && e.type === "dimension") out.push(e);
  return out;
}

/** One undoable command for a set of replaced dimensions (null when nothing changed). */
export function updateCommands(before: readonly DimensionEntity[], after: readonly DimensionEntity[]): Command | null {
  const old = new Map(before.map((d) => [d.id, d]));
  const cmds: Command[] = after
    .filter((d) => JSON.stringify(d) !== JSON.stringify(old.get(d.id)))
    .map((entity) => ({ type: "update-entity" as const, entity }));
  if (cmds.length === 0) return null;
  return cmds.length === 1 ? cmds[0] : { type: "batch", commands: cmds };
}

/** Text moved to `to`; with `leader` a line joins it back to the dimension line. */
export function moveDimText(d: DimensionEntity, to: Point, leader = false): DimensionEntity {
  const { textLeader, ...rest } = d;
  void textLeader;
  return { ...rest, textPos: { x: to.x, y: to.y }, ...(leader ? { textLeader: true } : {}) };
}

/** Text back in its default place (and its leader gone). */
export function resetDimText(d: DimensionEntity): DimensionEntity {
  const { textPos, textLeader, ...rest } = d;
  void textPos;
  void textLeader;
  return rest;
}

/** Arrows swapped between inside and outside the extension lines. */
export function flipDimArrows(d: DimensionEntity): DimensionEntity {
  const { flipArrows, ...rest } = d;
  return flipArrows ? rest : { ...rest, flipArrows: true };
}

/** Oblique extension lines at `angle` radians (null = square again). Only linear and aligned dimensions have them. */
export function obliqueDim(d: DimensionEntity, angle: number | null): DimensionEntity {
  if (d.kind !== "linear" && d.kind !== "aligned") return d;
  const { oblique, ...rest } = d;
  void oblique;
  return angle === null || !Number.isFinite(angle) ? rest : { ...rest, oblique: angle };
}

/** The dimension re-bound to a style: its per-dimension overrides are dropped (AutoCAD's "update"). */
export function restyleDim(d: DimensionEntity, style: string | undefined): DimensionEntity {
  const { overrides, style: oldStyle, ...rest } = d;
  void overrides;
  void oldStyle;
  return { ...rest, ...(style ? { style } : {}) };
}

/** Direction of a linear / aligned dimension line, or null for other kinds. */
function lineDirection(d: DimensionEntity): number | null {
  if ((d.kind !== "linear" && d.kind !== "aligned") || d.defPoints.length < 3) return null;
  const [p1, p2] = d.defPoints;
  return d.kind === "aligned" ? Math.atan2(p2.y - p1.y, p2.x - p1.x) : (d.angle ?? 0);
}

/**
 * DIMSPACE: stack parallel linear / aligned dimensions so their dimension
 * lines are `spacing` apart, counting out from `baseId` (the first dimension
 * when absent). `spacing` 0 lines them all up on the base's line. Dimensions
 * that are not parallel to the base, or are not linear / aligned, are left
 * out; the base itself never moves. Returns only the dimensions that move.
 */
export function spaceDimensions(dims: readonly DimensionEntity[], spacing: number, baseId?: string): DimensionEntity[] {
  const ok = dims.filter((d) => lineDirection(d) !== null);
  const base = ok.find((d) => d.id === baseId) ?? ok[0];
  if (!base || ok.length < 2 || !Number.isFinite(spacing) || spacing < 0) return [];
  const th = lineDirection(base)!;
  const n = { x: -Math.sin(th), y: Math.cos(th) };
  const parallel = ok.filter((d) => d.id !== base.id && Math.abs(Math.sin(lineDirection(d)! - th)) < 1e-9);
  if (parallel.length === 0) return [];
  const offset = (d: DimensionEntity): number => dot(d.defPoints[2], n);
  const o0 = offset(base);
  const out: DimensionEntity[] = [];
  const place = (list: DimensionEntity[], side: 1 | -1) =>
    list.forEach((d, i) => {
      const want = o0 + side * spacing * (i + 1) * (d.scale ?? 1);
      const delta = want - offset(d);
      const loc = d.defPoints[2];
      const defPoints = d.defPoints.slice();
      defPoints[2] = { x: loc.x + n.x * delta, y: loc.y + n.y * delta };
      out.push({ ...d, defPoints });
    });
  // Stack outward from the base on each side, nearest first, keeping the order they already had.
  place(parallel.filter((d) => offset(d) >= o0).sort((a, b) => offset(a) - offset(b)), 1);
  place(parallel.filter((d) => offset(d) < o0).sort((a, b) => offset(b) - offset(a)), -1);
  return out;
}

/**
 * Re-binds a dimension to the geometry now sitting at its definition points:
 * point refs for the measured points, `target` for the circle / arc it
 * measures, `targets` for the lines of an angle or centreline. Returns null
 * when it finds nothing to attach (or nothing changed).
 */
export function reassociateDim(d: DimensionEntity, entities: readonly Entity[], tol = 1e-6): DimensionEntity | null {
  const out: DimensionEntity = { ...d };
  switch (d.kind) {
    case "radial":
    case "diametric":
    case "jogged":
    case "arclength":
    case "centermark": {
      const c = d.defPoints[0];
      if (!c) return null;
      const hit = entities.find((e) => (e.type === "circle" && d.kind !== "arclength" && near(e.center, c, tol)) || (e.type === "arc" && near(e.center, c, tol)));
      if (!hit || (hit.type !== "circle" && hit.type !== "arc")) return null;
      out.target = hit.id;
      if (d.kind === "arclength" && hit.type === "arc" && d.defPoints.length >= 4) {
        out.defPoints = [hit.center, arcPointAt(hit.center, hit.radius, hit.startAngle), arcPointAt(hit.center, hit.radius, hit.endAngle), d.defPoints[3]];
      }
      break;
    }
    case "angular2l":
    case "centerline": {
      const ends = d.defPoints;
      if (ends.length < 4) return null;
      const pair = (p: Point, q: Point) => entities.find((e) => e.type === "line" && ((near(e.a, p, tol) && near(e.b, q, tol)) || (near(e.a, q, tol) && near(e.b, p, tol))));
      const l1 = pair(ends[0], ends[1]);
      const l2 = pair(ends[2], ends[3]);
      if (!l1 || !l2 || l1.id === l2.id) return null;
      out.targets = [l1.id, l2.id];
      if (d.kind === "centerline") out.refs = ends.slice(0, 4).map((p) => refAtPoint([l1, l2], p, tol));
      break;
    }
    default: {
      const loc = locatorIndex(d);
      const refs: (PointRef | null)[] = d.defPoints.map((p, i) => (i === loc || (d.kind === "ordinate" && i === 0) ? null : refAtPoint(entities, p, tol)));
      if (!refs.some(Boolean)) return null;
      out.refs = refs;
      break;
    }
  }
  return JSON.stringify(out) === JSON.stringify(d) ? null : out;
}
