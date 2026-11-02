import type { Entity, EntityId } from "./entities";
import { centroidOfEntities, newEntityId, transformed, translated } from "./entities";
import { pathOf, type Path } from "./intersect";
import { dist, rotatePoint, type Point } from "./geometry";
import { kindBounds, kindTransform } from "./kinds/registry";
import type { Command } from "./commands";
import type { SketchDocument } from "./document";

/**
 * Patterns (arrays): repeat a selection in a grid or around a circle. Every
 * copy is a genuinely new entity produced through `add-entity` commands, so a
 * pattern is one undoable step and the copies are independently editable
 * afterwards — there's no live "array object" linking them back to the source.
 *
 * The source entities are left untouched and are not counted as a copy: a
 * 3x2 rectangular pattern yields 6 total (5 new), matching how CAD tools
 * count array instances.
 */

export interface RectangularPattern {
  kind: "rectangular";
  /** Total instances across, including the original column. Minimum 1. */
  columns: number;
  /** Total instances down, including the original row. Minimum 1. */
  rows: number;
  /** Centre-to-centre spacing; negative values array left/down. */
  columnSpacing: number;
  rowSpacing: number;
}

export interface CircularPattern {
  kind: "circular";
  /** Total instances including the original. Minimum 1. */
  count: number;
  center: Point;
  /** Total sweep in radians the instances are spread over (2π for a full circle). */
  totalAngle: number;
  /** Whether each copy is rotated to follow the circle, or kept at its original orientation. */
  rotateItems: boolean;
}

export type PatternSpec = RectangularPattern | CircularPattern;

/** How many new entities a spec would create for `sourceCount` selected entities. */
export function patternCopyCount(spec: PatternSpec, sourceCount: number): number {
  const instances =
    spec.kind === "rectangular"
      ? Math.max(1, Math.floor(spec.columns)) * Math.max(1, Math.floor(spec.rows))
      : Math.max(1, Math.floor(spec.count));
  return (instances - 1) * sourceCount;
}

/**
 * The commands that lay out `ids` according to `spec`. Empty when the pattern
 * would produce nothing (no selection, or a single instance).
 */
export function patternCommands(doc: SketchDocument, ids: EntityId[], spec: PatternSpec): Command[] {
  const sources = ids.map((id) => doc.get(id)).filter((e): e is Entity => !!e);
  if (sources.length === 0) return [];

  const copies: Entity[] = [];
  const stamp = (place: (e: Entity) => Entity) => {
    for (const source of sources) copies.push({ ...place(source), id: newEntityId(), name: undefined });
  };

  if (spec.kind === "rectangular") {
    const cols = Math.max(1, Math.floor(spec.columns));
    const rows = Math.max(1, Math.floor(spec.rows));
    for (let c = 0; c < cols; c++) {
      for (let r = 0; r < rows; r++) {
        if (c === 0 && r === 0) continue; // the originals stay as they are
        stamp((e) => translated(e, c * spec.columnSpacing, r * spec.rowSpacing));
      }
    }
  } else {
    const count = Math.max(1, Math.floor(spec.count));
    // A sweep that closes on itself shouldn't stack a duplicate on the
    // original, so a full turn divides by `count` rather than `count - 1`.
    const full = Math.abs(Math.abs(spec.totalAngle) - 2 * Math.PI) < 1e-9;
    const step = spec.totalAngle / (full ? count : Math.max(1, count - 1));

    for (let i = 1; i < count; i++) {
      const angle = step * i;
      stamp((e) => {
        if (spec.rotateItems) return transformed(e, spec.center, 0, 0, angle, 1);
        // Orientation preserved: carry the entity along the arc by translating
        // it, using how far its own anchor point travels under the rotation.
        const anchor = centerOf(e);
        const moved = rotateAbout(anchor, spec.center, angle);
        return translated(e, moved.x - anchor.x, moved.y - anchor.y);
      });
    }
  }

  return copies.map((entity) => ({ type: "add-entity", entity }) as Command);
}

const rotateAbout = (p: Point, pivot: Point, angle: number): Point => rotatePoint(p, pivot, angle);

/** An entity's own anchor point — what travels along the arc when copies keep their orientation. */
function centerOf(entity: Entity): Point {
  switch (entity.type) {
    case "circle":
    case "arc":
      return entity.center;
    case "point":
      return entity.p;
    case "line":
      return { x: (entity.a.x + entity.b.x) / 2, y: (entity.a.y + entity.b.y) / 2 };
    case "polyline": {
      let sx = 0;
      let sy = 0;
      for (const p of entity.points) {
        sx += p.x;
        sy += p.y;
      }
      const n = Math.max(1, entity.points.length);
      return { x: sx / n, y: sy / n };
    }
    case "text":
      return entity.at;
    case "image":
      return entity.insert;
    default: {
      const b = kindBounds(entity as Entity);
      return b ? { x: (b.minX + b.maxX) / 2, y: (b.minY + b.maxY) / 2 } : { x: 0, y: 0 };
    }
  }
}

/* --------------------------- array along a path --------------------------- */

/**
 * T-35: array along a path (AutoCAD ARRAYPATH). Copies of the selection are
 * placed at stations along another entity — a line, arc, circle, polyline,
 * ellipse or spline — either `count` of them spread over the whole path
 * ("divide") or one every `spacing` from the start ("measure"). The
 * selection's base point (default: its centroid) rides the path; with `align`
 * each copy also turns by how far the path's direction has turned since the
 * first station, so a part drawn in place at the path's start keeps its
 * orientation relative to the curve.
 *
 * It is not part of {@link PatternSpec}: the pattern plugin mirrors that union
 * over the public API and a third member would break its exhaustive layout.
 * The result is the same kind of thing as the other patterns — independent
 * `add-entity` copies, one undo step; the originals stay unless
 * `replaceSource`, which deletes them (AutoCAD's array consumes the source).
 */
export interface PathPattern {
  /** The entity the copies follow. */
  path: EntityId;
  /** `count`: that many stations over the whole path; `spacing`: one every `spacing` from the start. */
  mode: "count" | "spacing";
  /** Total stations (count mode); minimum 1. */
  count: number;
  /** Centre-to-centre distance along the path (spacing mode); must be positive. */
  spacing: number;
  /** Rotate the copies to follow the path's direction. */
  align: boolean;
  /** Distance along the path where the first station sits (default 0). */
  startOffset?: number;
  /** The point of the selection that rides the path (default: the selection's centroid). */
  basePoint?: Point;
  /** Delete the originals after copying. */
  replaceSource?: boolean;
}

/** Stations are capped so a tiny spacing on a long path cannot freeze the app. */
export const MAX_PATH_STATIONS = 10000;

export interface PathStation {
  point: Point;
  /** Direction of travel at the station, radians. */
  angle: number;
}

/** Total length of a path of curves, and a lookup from distance to point + direction. */
function pathFrames(path: Path): { length: number; at: (s: number) => PathStation } | null {
  const lengths = path.curves.map((c) => (c.kind === "segment" ? dist(c.a, c.b) : c.radius * arcSweepMagnitude(c)));
  const length = lengths.reduce((a, b) => a + b, 0);
  if (!(length > 1e-12)) return null;
  const at = (s: number): PathStation => {
    let target = Math.max(0, Math.min(length, s));
    for (let i = 0; i < path.curves.length; i++) {
      const last = i === path.curves.length - 1;
      if (target < lengths[i] - 1e-12 || last) {
        const c = path.curves[i];
        const t = lengths[i] > 0 ? Math.max(0, Math.min(1, target / lengths[i])) : 0;
        if (c.kind === "segment") {
          return { point: { x: c.a.x + (c.b.x - c.a.x) * t, y: c.a.y + (c.b.y - c.a.y) * t }, angle: Math.atan2(c.b.y - c.a.y, c.b.x - c.a.x) };
        }
        const dir = c.ccw || c.full ? 1 : -1;
        const a = c.startAngle + dir * arcSweepMagnitude(c) * t;
        return { point: { x: c.center.x + c.radius * Math.cos(a), y: c.center.y + c.radius * Math.sin(a) }, angle: a + (dir * Math.PI) / 2 };
      }
      target -= lengths[i];
    }
    /* unreachable: the last curve always answers */
    return { point: { x: 0, y: 0 }, angle: 0 };
  };
  return { length, at };
}

function arcSweepMagnitude(c: Extract<Path["curves"][number], { kind: "arc" }>): number {
  if (c.full) return Math.PI * 2;
  const raw = c.ccw ? c.endAngle - c.startAngle : c.startAngle - c.endAngle;
  const s = ((raw % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2);
  return s === 0 ? Math.PI * 2 : s;
}

/** The stations a spec puts on `path` (empty for an unusable path or spec). */
export function pathPatternStations(path: Path, spec: Pick<PathPattern, "mode" | "count" | "spacing" | "startOffset">): PathStation[] {
  const frames = pathFrames(path);
  if (!frames) return [];
  const offset = Math.max(0, Math.min(frames.length, spec.startOffset ?? 0));
  const usable = frames.length - offset;
  const distances: number[] = [];
  if (spec.mode === "count") {
    const n = Math.min(MAX_PATH_STATIONS, Math.max(1, Math.floor(spec.count)));
    // An open path spans first-to-last inclusive; a closed one must not stack a copy on the start.
    const step = n === 1 ? 0 : path.closed ? usable / n : usable / (n - 1);
    for (let k = 0; k < n; k++) distances.push(offset + step * k);
  } else {
    if (!(spec.spacing > 0)) return [];
    for (let k = 0; k < MAX_PATH_STATIONS; k++) {
      const s = offset + k * spec.spacing;
      if (path.closed ? s >= frames.length - 1e-9 : s > frames.length + 1e-9) break;
      distances.push(s);
    }
  }
  return distances.map((s) => frames.at(s));
}

/** Entities an array along the path would add for `sourceCount` selected entities (0 when the path is unusable). */
export function pathPatternCopyCount(doc: SketchDocument, spec: PathPattern, sourceCount: number): number {
  const target = doc.get(spec.path);
  const p = target ? pathOf(target) : null;
  return p ? pathPatternStations(p, spec).length * sourceCount : 0;
}

/**
 * The commands that array `ids` along `spec.path`. Empty when the path is
 * missing or has no stroke, the spec makes no station, or nothing is selected
 * (the path itself is never one of its own sources).
 */
export function pathPatternCommands(doc: SketchDocument, ids: EntityId[], spec: PathPattern): Command[] {
  const target = doc.get(spec.path);
  const path = target ? pathOf(target) : null;
  if (!path) return [];
  const sources = ids.filter((id) => id !== spec.path).map((id) => doc.get(id)).filter((e): e is Entity => !!e);
  if (sources.length === 0) return [];
  const stations = pathPatternStations(path, spec);
  if (stations.length === 0) return [];

  const base = spec.basePoint ?? centroidOfEntities(sources);
  const copies: Entity[] = [];
  for (const st of stations) {
    const turn = spec.align ? st.angle - stations[0].angle : 0;
    for (const source of sources) {
      copies.push({ ...transformed(source, base, st.point.x - base.x, st.point.y - base.y, turn, 1), id: newEntityId(), name: undefined });
    }
  }
  const commands: Command[] = copies.map((entity) => ({ type: "add-entity", entity }) as Command);
  if (spec.replaceSource) commands.push({ type: "delete-entities", ids: sources.map((s) => s.id) });
  return commands;
}
