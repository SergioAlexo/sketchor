import { newEntityId } from "@sketchor/core";
import type {
  ArcEntity,
  CircleEntity,
  Command,
  Entity,
  EntityId,
  LineEntity,
  LinearDimensionOptions,
  Point,
  PointEntity,
  PolylineEntity,
  TextEntity,
} from "@sketchor/core";
import { linearDimension } from "@sketchor/core";

/**
 * Convenience builders so plugin authors write `line(a, b)` / `add(line(a, b))`
 * instead of hand-assembling entity records and raw command objects. Entity
 * ids are minted here via the core id generator; the resulting values are plain
 * data, safe to send over the RPC transport to `document.apply`.
 */

export interface EntityOptions {
  /** Human-readable handle shown in the sketch-code view. */
  name?: string;
  /** Layer name; omit for the default layer "0". */
  layer?: string;
  /** Stroke colour (any CSS colour); omit for the theme default. */
  color?: string;
  /** Hatch-fill colour for closed shapes; omit for no fill. */
  fill?: string;
  /** Named linetype (CONTINUOUS, DASHED, HIDDEN, CENTER, ...); omit for BYLAYER. */
  linetype?: string;
  /** Plot/display line weight in mm; omit for BYLAYER. */
  lineweight?: number;
  /** This entity's own linetype scale (DXF group 48), multiplied with the drawing's `$LTSCALE`; omit for 1. */
  linetypeScale?: number;
  /** A construction/guide entity, excluded from export weight. */
  construction?: boolean;
}

function base(opts?: EntityOptions): {
  id: EntityId;
  name?: string;
  layer?: string;
  color?: string;
  fill?: string;
  linetype?: string;
  lineweight?: number;
  linetypeScale?: number;
  construction?: boolean;
} {
  return {
    id: newEntityId(),
    ...(opts?.name !== undefined ? { name: opts.name } : {}),
    ...(opts?.layer !== undefined ? { layer: opts.layer } : {}),
    ...(opts?.color !== undefined ? { color: opts.color } : {}),
    ...(opts?.fill !== undefined ? { fill: opts.fill } : {}),
    ...(opts?.linetype !== undefined ? { linetype: opts.linetype } : {}),
    ...(opts?.lineweight !== undefined ? { lineweight: opts.lineweight } : {}),
    ...(opts?.linetypeScale !== undefined ? { linetypeScale: opts.linetypeScale } : {}),
    ...(opts?.construction ? { construction: true } : {}),
  };
}

export function line(a: Point, b: Point, opts?: EntityOptions): LineEntity {
  return { ...base(opts), type: "line", a, b };
}

export function circle(center: Point, radius: number, opts?: EntityOptions): CircleEntity {
  return { ...base(opts), type: "circle", center, radius };
}

export function arc(
  center: Point,
  radius: number,
  startAngle: number,
  endAngle: number,
  ccw = true,
  opts?: EntityOptions,
): ArcEntity {
  return { ...base(opts), type: "arc", center, radius, startAngle, endAngle, ccw };
}

export function point(p: Point, opts?: EntityOptions): PointEntity {
  return { ...base(opts), type: "point", p };
}

/** A single line of text with its baseline start at `at`. `rotation` is radians, CCW. */
export function text(
  at: Point,
  str: string,
  opts?: EntityOptions & { height?: number; rotation?: number },
): TextEntity {
  const { fill: _f, linetype: _lt, lineweight: _lw, linetypeScale: _ls, construction: _c, ...b } = base(opts);
  return { ...b, type: "text", at, text: str, height: opts?.height ?? 10, rotation: opts?.rotation ?? 0 };
}

/**
 * Linear dimension geometry (see core's `linearDimension`) as ready-to-add
 * `Command`s: the extension/dimension lines as polylines plus the label as a
 * text entity, all on `layer`.
 */
export function linearDimensionCommands(
  a: Point,
  b: Point,
  opts: LinearDimensionOptions & { layer?: string; color?: string; name?: string },
): Command[] {
  const d = linearDimension(a, b, opts);
  const common = { layer: opts.layer, color: opts.color, name: opts.name };
  return [
    ...d.lines.map((pts) => add(polyline(pts, false, common))),
    add(text(d.text.at, d.text.text, { ...common, height: d.text.height, rotation: d.text.rotation })),
  ];
}

export function polyline(
  points: Point[],
  closed = false,
  opts?: EntityOptions & { bulges?: number[] },
): PolylineEntity {
  return {
    ...base(opts),
    type: "polyline",
    points,
    closed,
    ...(opts?.bulges ? { bulges: opts.bulges } : {}),
  };
}

/** Command builders mirroring the core `Command` union. */
export const cmd = {
  add: (entity: Entity): Command => ({ type: "add-entity", entity }),
  update: (entity: Entity): Command => ({ type: "update-entity", entity }),
  delete: (ids: EntityId[]): Command => ({ type: "delete-entities", ids }),
  move: (ids: EntityId[], dx: number, dy: number): Command => ({ type: "move-entities", ids, dx, dy }),
  batch: (commands: Command[]): Command => ({ type: "batch", commands }),
} as const;

/** Shorthand: the add-entity command for a freshly built entity. */
export const add = (entity: Entity): Command => cmd.add(entity);
