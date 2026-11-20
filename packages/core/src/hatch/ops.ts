import type { Command } from "../commands";
import type { Entity, HatchEdge, HatchEntity } from "../entities";
import { newEntityId } from "../entities";
import { newGroupId } from "../groups";
import { hatchFill } from "./fillLines";

/**
 * Hatch editing operations (H-08), as pure functions returning commands:
 * recreate the boundary as real entities, explode a pattern into lines, and
 * re-order a hatch relative to other geometry.
 */

const TAU = Math.PI * 2;

function common(h: HatchEntity): { layer?: string; color?: string; linetype?: string; lineweight?: number; linetypeScale?: number } {
  return {
    ...(h.layer ? { layer: h.layer } : {}),
    ...(h.color ? { color: h.color } : {}),
    ...(h.linetype ? { linetype: h.linetype } : {}),
    ...(h.lineweight !== undefined ? { lineweight: h.lineweight } : {}),
    ...(h.linetypeScale !== undefined ? { linetypeScale: h.linetypeScale } : {}),
  };
}

function edgeEntity(e: HatchEdge, h: HatchEntity): Entity {
  const base = { id: newEntityId(), ...common(h) };
  switch (e.type) {
    case "line":
      return { ...base, type: "line", a: { ...e.a }, b: { ...e.b } };
    case "arc":
      // A whole turn is a circle, not an arc.
      if (Math.abs(Math.abs(e.endAngle - e.startAngle) - TAU) < 1e-9) return { ...base, type: "circle", center: { ...e.center }, radius: e.radius };
      return { ...base, type: "arc", center: { ...e.center }, radius: e.radius, startAngle: e.startAngle, endAngle: e.endAngle, ccw: e.ccw };
    case "ellipse":
      return { ...base, type: "ellipse", center: { ...e.center }, majorAxis: { ...e.majorAxis }, ratio: e.ratio, start: e.start, end: e.end };
    case "spline":
      return { ...base, type: "spline", degree: e.degree, controlPoints: e.controlPoints.map((p) => ({ ...p })), knots: [...e.knots], ...(e.weights ? { weights: [...e.weights] } : {}), closed: !!e.closed };
  }
}

/** The hatch boundary as ordinary entities (one per edge: lines, arcs, circles, ellipses, splines) on the hatch's layer. */
export function hatchBoundaryEntities(h: HatchEntity): Entity[] {
  return h.loops.flatMap((l) => l.edges.map((e) => edgeEntity(e, h)));
}

/** "Recreate boundary": adds the boundary entities; the hatch stays (and, if associative, now has real sources to follow). */
export function recreateBoundaryCommands(h: HatchEntity): { commands: Command[]; ids: string[] } {
  const ents = hatchBoundaryEntities(h);
  return { commands: ents.map((entity) => ({ type: "add-entity", entity })), ids: ents.map((e) => e.id) };
}

/** Largest number of strokes "Explode" will write; beyond it the hatch is refused rather than flooding the document. */
export const EXPLODE_LIMIT = 50_000;

/** The pattern strokes of a hatch as line / point entities, or the boundary for a solid or gradient. Null when the pattern is too dense or unknown. */
export function explodeHatchEntities(h: HatchEntity): Entity[] | null {
  if (h.paint.kind !== "pattern") return hatchBoundaryEntities(h);
  const f = hatchFill(h);
  if (f.truncated || f.unknownPattern || f.segments.length / 4 + f.dots.length / 2 > EXPLODE_LIMIT) return null;
  const entities: Entity[] = [];
  const c = common(h);
  for (let i = 0; i < f.segments.length; i += 4) {
    entities.push({ id: newEntityId(), type: "line", ...c, a: { x: f.segments[i], y: f.segments[i + 1] }, b: { x: f.segments[i + 2], y: f.segments[i + 3] } });
  }
  for (let i = 0; i < f.dots.length; i += 2) {
    entities.push({ id: newEntityId(), type: "point", ...(h.layer ? { layer: h.layer } : {}), ...(h.color ? { color: h.color } : {}), p: { x: f.dots[i], y: f.dots[i + 1] } });
  }
  return entities;
}

/**
 * Explodes a hatch: the pattern becomes grouped line (and point) entities, the
 * hatch is removed. A solid/gradient hatch has no lines, so it becomes its
 * boundary. Returns null when the pattern is too dense or unknown.
 */
export function explodeHatchCommands(h: HatchEntity): Command[] | null {
  const entities = explodeHatchEntities(h);
  if (!entities) return null;
  const commands: Command[] = [{ type: "delete-entities", ids: [h.id] }];
  for (const entity of entities) commands.push({ type: "add-entity", entity });
  if (entities.length > 1) commands.push({ type: "group-entities", groupId: newGroupId(), ids: entities.map((e) => e.id), name: h.name ? `${h.name} exploded` : undefined });
  return commands;
}

/** Draw order: lower numbers are drawn first (behind). Hatches default to 0, so -1 sends one behind its boundary. */
export function setHatchDrawOrder(h: HatchEntity, order: number): HatchEntity {
  const { drawOrder: _o, ...rest } = h;
  void _o;
  return order === 0 ? rest : { ...rest, drawOrder: order };
}

export function drawOrderOf(e: Entity): number {
  return (e as { drawOrder?: number }).drawOrder ?? 0;
}
