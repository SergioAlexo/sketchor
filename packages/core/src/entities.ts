import type { Point } from "./geometry";
import type { PointRef } from "./constraints";
import { arcPointAt, arcSweep, bulgeToArc, dist, rotatePoint } from "./geometry";
import { kindPoints, kindTransform } from "./kinds/registry";

export type EntityId = string;

export interface LineEntity {
  id: EntityId;
  type: "line";
  /** Human-readable handle used in the sketch code view (e.g. "L1"). */
  name?: string;
  /** Layer this entity belongs to; absent means the default layer "0". */
  layer?: string;
  /** Stroke colour (any CSS colour). Absent = the theme's default entity colour. */
  color?: string;
  /**
   * Hatch-fill colour for closed shapes (a `closed` polyline or a circle);
   * ignored for open shapes. Absent = no fill. Set by the Fill/Hatch tool and
   * by plugins (e.g. the load planner colours pallets by order).
   */
  fill?: string;
  /** Named linetype from the `linetypes` table (CONTINUOUS, DASHED, HIDDEN, CENTER, PHANTOM, DOT, DASHDOT, BORDER, DIVIDE, or a custom imported one — see linetypes.ts). Absent = BYLAYER: inherit the entity's layer's linetype, or CONTINUOUS if the layer has none either. */
  linetype?: string;
  /** Plot/display line weight in mm (the DXF standard set: 0, 0.05, 0.09, ... up to 2.11). Absent = BYLAYER, same inheritance as {@link linetype}. */
  lineweight?: number;
  /**
   * A construction/guide entity: visible but excluded from export weight —
   * BOM/measure/nest and similar tools treat it as a reference, not real
   * geometry. Independent of {@link linetype} (before Z-04 this one boolean,
   * `dashed`, meant both "draw dashed" and "is construction" at once; an old
   * document's `dashed: true` migrates to `construction: true` +
   * `linetype: "DASHED"`, see `tables.ts`'s v3→v4 migration).
   */
  construction?: boolean;
  a: Point;
  b: Point;
  /**
   * An infinite construction line (AutoCAD XLINE, roadmap T-07): `a` and
   * `b` only fix its direction. Drawn clipped to the viewport, always
   * dashed, never exported to DXF/SVG, and it snaps like any line.
   */
  infinite?: boolean;
}

export interface CircleEntity {
  id: EntityId;
  type: "circle";
  /** Human-readable handle used in the sketch code view (e.g. "C1"). */
  name?: string;
  /** Layer this entity belongs to; absent means the default layer "0". */
  layer?: string;
  /** Stroke colour (any CSS colour). Absent = the theme's default entity colour. */
  color?: string;
  /**
   * Hatch-fill colour for closed shapes (a `closed` polyline or a circle);
   * ignored for open shapes. Absent = no fill. Set by the Fill/Hatch tool and
   * by plugins (e.g. the load planner colours pallets by order).
   */
  fill?: string;
  /** Named linetype from the `linetypes` table (CONTINUOUS, DASHED, HIDDEN, CENTER, PHANTOM, DOT, DASHDOT, BORDER, DIVIDE, or a custom imported one — see linetypes.ts). Absent = BYLAYER: inherit the entity's layer's linetype, or CONTINUOUS if the layer has none either. */
  linetype?: string;
  /** Plot/display line weight in mm (the DXF standard set: 0, 0.05, 0.09, ... up to 2.11). Absent = BYLAYER, same inheritance as {@link linetype}. */
  lineweight?: number;
  /**
   * A construction/guide entity: visible but excluded from export weight —
   * BOM/measure/nest and similar tools treat it as a reference, not real
   * geometry. Independent of {@link linetype} (before Z-04 this one boolean,
   * `dashed`, meant both "draw dashed" and "is construction" at once; an old
   * document's `dashed: true` migrates to `construction: true` +
   * `linetype: "DASHED"`, see `tables.ts`'s v3→v4 migration).
   */
  construction?: boolean;
  center: Point;
  radius: number;
}

export interface ArcEntity {
  id: EntityId;
  type: "arc";
  /** Human-readable handle used in the sketch code view (e.g. "A1"). */
  name?: string;
  /** Layer this entity belongs to; absent means the default layer "0". */
  layer?: string;
  /** Stroke colour (any CSS colour). Absent = the theme's default entity colour. */
  color?: string;
  /**
   * Hatch-fill colour for closed shapes (a `closed` polyline or a circle);
   * ignored for open shapes. Absent = no fill. Set by the Fill/Hatch tool and
   * by plugins (e.g. the load planner colours pallets by order).
   */
  fill?: string;
  /** Named linetype from the `linetypes` table (CONTINUOUS, DASHED, HIDDEN, CENTER, PHANTOM, DOT, DASHDOT, BORDER, DIVIDE, or a custom imported one — see linetypes.ts). Absent = BYLAYER: inherit the entity's layer's linetype, or CONTINUOUS if the layer has none either. */
  linetype?: string;
  /** Plot/display line weight in mm (the DXF standard set: 0, 0.05, 0.09, ... up to 2.11). Absent = BYLAYER, same inheritance as {@link linetype}. */
  lineweight?: number;
  /**
   * A construction/guide entity: visible but excluded from export weight —
   * BOM/measure/nest and similar tools treat it as a reference, not real
   * geometry. Independent of {@link linetype} (before Z-04 this one boolean,
   * `dashed`, meant both "draw dashed" and "is construction" at once; an old
   * document's `dashed: true` migrates to `construction: true` +
   * `linetype: "DASHED"`, see `tables.ts`'s v3→v4 migration).
   */
  construction?: boolean;
  center: Point;
  radius: number;
  /** Radians. The arc runs from startAngle to endAngle; both map to real points via {@link arcPointAt}. */
  startAngle: number;
  endAngle: number;
  /** Sweep direction from startAngle to endAngle: true = counterclockwise (increasing angle), false = clockwise. */
  ccw: boolean;
}

export interface PointEntity {
  id: EntityId;
  type: "point";
  /** Human-readable handle used in the sketch code view (e.g. "P1"). */
  name?: string;
  /** Layer this entity belongs to; absent means the default layer "0". */
  layer?: string;
  /** Stroke colour (any CSS colour). Absent = the theme's default entity colour. */
  color?: string;
  /**
   * Hatch-fill colour for closed shapes (a `closed` polyline or a circle);
   * ignored for open shapes. Absent = no fill. Set by the Fill/Hatch tool and
   * by plugins (e.g. the load planner colours pallets by order).
   */
  fill?: string;
  /** Named linetype from the `linetypes` table (CONTINUOUS, DASHED, HIDDEN, CENTER, PHANTOM, DOT, DASHDOT, BORDER, DIVIDE, or a custom imported one — see linetypes.ts). Absent = BYLAYER: inherit the entity's layer's linetype, or CONTINUOUS if the layer has none either. */
  linetype?: string;
  /** Plot/display line weight in mm (the DXF standard set: 0, 0.05, 0.09, ... up to 2.11). Absent = BYLAYER, same inheritance as {@link linetype}. */
  lineweight?: number;
  /**
   * A construction/guide entity: visible but excluded from export weight —
   * BOM/measure/nest and similar tools treat it as a reference, not real
   * geometry. Independent of {@link linetype} (before Z-04 this one boolean,
   * `dashed`, meant both "draw dashed" and "is construction" at once; an old
   * document's `dashed: true` migrates to `construction: true` +
   * `linetype: "DASHED"`, see `tables.ts`'s v3→v4 migration).
   */
  construction?: boolean;
  p: Point;
}

export interface EllipseEntity {
  id: EntityId;
  type: "ellipse";
  /** Human-readable handle used in the sketch code view (e.g. "E1"). */
  name?: string;
  /** Layer this entity belongs to; absent means the default layer "0". */
  layer?: string;
  /** Stroke colour (any CSS colour). Absent = the theme's default entity colour. */
  color?: string;
  /**
   * Hatch-fill colour for closed shapes (a `closed` polyline or a circle);
   * ignored for open shapes. Absent = no fill. Set by the Fill/Hatch tool and
   * by plugins (e.g. the load planner colours pallets by order).
   */
  fill?: string;
  /** Named linetype from the `linetypes` table (CONTINUOUS, DASHED, HIDDEN, CENTER, PHANTOM, DOT, DASHDOT, BORDER, DIVIDE, or a custom imported one — see linetypes.ts). Absent = BYLAYER: inherit the entity's layer's linetype, or CONTINUOUS if the layer has none either. */
  linetype?: string;
  /** Plot/display line weight in mm (the DXF standard set: 0, 0.05, 0.09, ... up to 2.11). Absent = BYLAYER, same inheritance as {@link linetype}. */
  lineweight?: number;
  /**
   * A construction/guide entity: visible but excluded from export weight —
   * BOM/measure/nest and similar tools treat it as a reference, not real
   * geometry. Independent of {@link linetype} (before Z-04 this one boolean,
   * `dashed`, meant both "draw dashed" and "is construction" at once; an old
   * document's `dashed: true` migrates to `construction: true` +
   * `linetype: "DASHED"`, see `tables.ts`'s v3→v4 migration).
   */
  construction?: boolean;
  center: Point;
  /**
   * The semi-major axis as a vector from the centre (DXF convention), so its
   * length is the major radius and its direction the ellipse's rotation.
   */
  majorAxis: Point;
  /** Minor radius / major radius, 0 < ratio <= 1. The minor axis is the major axis turned +90 degrees, scaled by this. */
  ratio: number;
  /**
   * Parametric start/end in radians (counterclockwise, measured on the
   * ellipse's own parameter — not the polar angle): a point is
   * `center + major*cos(t) + minor*sin(t)`. A full ellipse is `0 .. 2*PI`.
   */
  start: number;
  end: number;
}


export interface SplineEntity {
  id: EntityId;
  type: "spline";
  /** Human-readable handle used in the sketch code view (e.g. "S1"). */
  name?: string;
  /** Layer this entity belongs to; absent means the default layer "0". */
  layer?: string;
  /** Stroke colour (any CSS colour). Absent = the theme's default entity colour. */
  color?: string;
  /**
   * Hatch-fill colour for closed shapes (a `closed` polyline or a circle);
   * ignored for open shapes. Absent = no fill. Set by the Fill/Hatch tool and
   * by plugins (e.g. the load planner colours pallets by order).
   */
  fill?: string;
  /** Named linetype from the `linetypes` table (CONTINUOUS, DASHED, HIDDEN, CENTER, PHANTOM, DOT, DASHDOT, BORDER, DIVIDE, or a custom imported one — see linetypes.ts). Absent = BYLAYER: inherit the entity's layer's linetype, or CONTINUOUS if the layer has none either. */
  linetype?: string;
  /** Plot/display line weight in mm (the DXF standard set: 0, 0.05, 0.09, ... up to 2.11). Absent = BYLAYER, same inheritance as {@link linetype}. */
  lineweight?: number;
  /**
   * A construction/guide entity: visible but excluded from export weight —
   * BOM/measure/nest and similar tools treat it as a reference, not real
   * geometry. Independent of {@link linetype} (before Z-04 this one boolean,
   * `dashed`, meant both "draw dashed" and "is construction" at once; an old
   * document's `dashed: true` migrates to `construction: true` +
   * `linetype: "DASHED"`, see `tables.ts`'s v3→v4 migration).
   */
  construction?: boolean;
  /** Polynomial degree, 1..11 (cubic is the CAD default). */
  degree: number;
  /** NURBS control points; with `knots` and `weights` they define the curve. */
  controlPoints: Point[];
  /** `controlPoints.length + degree + 1` non-decreasing values. */
  knots: number[];
  /** One positive weight per control point; absent = non-rational (all 1). */
  weights?: number[];
  /**
   * Fit splines only: the direction the curve leaves its first / arrives at its last fit point, as a handle
   * vector in world units (the Bezier leg: the curve's end derivative per unit parameter is 3x this). Absent = free end.
   */
  startTangent?: { x: number; y: number };
  endTangent?: { x: number; y: number };
  /**
   * Points the curve was drawn through, when it was drawn that way (DXF keeps
   * both). While present, editing a fit point re-solves the control points;
   * editing a control point drops them, as AutoCAD does.
   */
  fitPoints?: Point[];
  /** The ends meet (or the data is periodic): the curve closes on itself. */
  closed: boolean;
}

export interface PolylineEntity {
  id: EntityId;
  type: "polyline";
  /** Human-readable handle used in the sketch code view (e.g. "PL1"). */
  name?: string;
  /** Layer this entity belongs to; absent means the default layer "0". */
  layer?: string;
  /** Stroke colour (any CSS colour). Absent = the theme's default entity colour. */
  color?: string;
  /**
   * Hatch-fill colour for closed shapes (a `closed` polyline or a circle);
   * ignored for open shapes. Absent = no fill. Set by the Fill/Hatch tool and
   * by plugins (e.g. the load planner colours pallets by order).
   */
  fill?: string;
  /** Named linetype from the `linetypes` table (CONTINUOUS, DASHED, HIDDEN, CENTER, PHANTOM, DOT, DASHDOT, BORDER, DIVIDE, or a custom imported one — see linetypes.ts). Absent = BYLAYER: inherit the entity's layer's linetype, or CONTINUOUS if the layer has none either. */
  linetype?: string;
  /** Plot/display line weight in mm (the DXF standard set: 0, 0.05, 0.09, ... up to 2.11). Absent = BYLAYER, same inheritance as {@link linetype}. */
  lineweight?: number;
  /**
   * A construction/guide entity: visible but excluded from export weight —
   * BOM/measure/nest and similar tools treat it as a reference, not real
   * geometry. Independent of {@link linetype} (before Z-04 this one boolean,
   * `dashed`, meant both "draw dashed" and "is construction" at once; an old
   * document's `dashed: true` migrates to `construction: true` +
   * `linetype: "DASHED"`, see `tables.ts`'s v3→v4 migration).
   */
  construction?: boolean;
  /** Ordered vertices. Does not repeat the first point when `closed`. */
  points: Point[];
  /**
   * Per-segment bulge (DXF convention): `bulges[i]` is the bulge of the
   * segment from `points[i]` to `points[i+1]` (wrapping to `points[0]` for
   * the closing segment when `closed`). 0 or absent = straight segment;
   * otherwise `tan(includedAngle / 4)`, signed by sweep direction — see
   * {@link bulgeToArc}. Absent entirely means every segment is straight.
   */
  bulges?: number[];
  /** True if the last vertex connects back to the first. */
  closed: boolean;
}

/**
 * A single line of text placed in the drawing. Rendered in a plain sans font;
 * `at` is the baseline start (DXF `TEXT` convention), `height` the cap height in
 * world units, `rotation` radians CCW about `at`. Editable in place with the
 * text tool.
 */
export interface TextEntity {
  id: EntityId;
  type: "text";
  name?: string;
  layer?: string;
  /** Text colour (any CSS colour). Absent = the theme's default entity colour. */
  color?: string;
  /** Ignored for text — present only so every entity shares one shape. */
  fill?: string;
  /** Ignored for text — present only so every entity shares one shape. */
  linetype?: string;
  /** Ignored for text — present only so every entity shares one shape. */
  lineweight?: number;
  /** Ignored for text — present only so every entity shares one shape. */
  construction?: boolean;
  at: Point;
  text: string;
  height: number;
  rotation: number;
  /** D-01: name of a `textStyles` record (absent = Standard). */
  style?: string;
  /** D-01: horizontal alignment of `at` against the text (DXF 72). Absent = left. */
  halign?: "left" | "center" | "right";
  /** D-01: vertical alignment of `at` (DXF 73). Absent = baseline. */
  valign?: "baseline" | "bottom" | "middle" | "top";
  /** D-01: width factor override (style's when absent). */
  widthFactor?: number;
  /** D-01: oblique angle override in degrees (style's when absent). */
  oblique?: number;
}

/**
 * A raster image placed in the drawing (a photo, a logo, a scanned trace
 * reference). `insert` is the bottom-left corner before rotation (DXF IMAGE
 * convention), `width`/`height` are the *displayed* size in world units
 * (mm) — independent of the source pixel dimensions — and `rotation` is
 * radians CCW about `insert`. The pixel data is embedded as a `data:` URI
 * rather than referencing an external file, so a `.sketchor` document (or an
 * SVG export) stays self-contained; DXF has no way to embed raster bytes
 * inline (its IMAGE entity references an external file via a separate
 * IMAGEDEF object), so that direction is necessarily lossy — see dxfExport.ts.
 */
export interface ImageEntity {
  id: EntityId;
  type: "image";
  name?: string;
  layer?: string;
  /** Ignored for image — present only so every entity shares one shape. */
  color?: string;
  /** Ignored for image — present only so every entity shares one shape. */
  fill?: string;
  /** Ignored for image — present only so every entity shares one shape. */
  linetype?: string;
  /** Ignored for image — present only so every entity shares one shape. */
  lineweight?: number;
  /** Ignored for image — present only so every entity shares one shape. */
  construction?: boolean;
  insert: Point;
  width: number;
  height: number;
  rotation: number;
  /** The image itself, as a `data:image/...;base64,...` URI. */
  dataUrl: string;
}

/**
 * Z-04 migration: before this, one boolean (`dashed`) meant both "draw
 * dashed" and "is a construction/guide entity" at once. An older document's
 * `dashed: true` becomes both `construction: true` and `linetype: "DASHED"`
 * (unless the entity already somehow has a `linetype`, which no old file
 * could), so neither its look nor its export-exclusion changes; `dashed:
 * false`/absent just has the dead field dropped. Idempotent — safe to run on
 * an entity that never had `dashed` at all. Called once per entity in
 * `document.ts`'s `fromJSON`.
 */
export function migrateDashedEntity<T extends Entity>(entity: T): T {
  const raw = entity as unknown as Record<string, unknown>;
  if (raw.dashed === undefined) return entity;
  const { dashed, ...rest } = raw;
  if (!dashed) return rest as unknown as T;
  return { ...rest, construction: true, linetype: rest.linetype ?? "DASHED" } as unknown as T;
}

/** The layer an entity is drawn on, defaulting to "0" (DXF convention). */
export function layerOf(entity: Entity): string {
  return entity.layer ?? DEFAULT_LAYER;
}

export const DEFAULT_LAYER = "0";

/** One boundary edge of a hatch loop — the geometry fields of the matching entity, without id/layer/style. */
export type HatchEdge =
  | { type: "line"; a: Point; b: Point }
  | { type: "arc"; center: Point; radius: number; startAngle: number; endAngle: number; ccw: boolean }
  | { type: "ellipse"; center: Point; majorAxis: Point; ratio: number; start: number; end: number }
  | { type: "spline"; degree: number; controlPoints: Point[]; knots: number[]; weights?: number[]; closed?: boolean };

/** A closed boundary loop: edges in chain order (each edge may run either way; the tessellation joins them by proximity). */
export interface HatchLoop {
  edges: HatchEdge[];
  /** DXF boundary-path flags: an outermost loop, or one derived from a boundary entity (informational). */
  outer?: boolean;
  derived?: boolean;
}

/** One line family of a hatch pattern, `.pat` convention (angle in degrees; origin/offset/dashes in pattern units, scaled by the hatch). */
export interface PatternFamily {
  angle: number;
  origin: Point;
  /** Step to the next parallel line, in the line's own frame (x along the line, y perpendicular). */
  offset: Point;
  /** Alternating dash lengths: positive = pen down, negative = gap, 0 = dot. Empty = continuous. */
  dashes: number[];
}

/** How a hatch is painted. A pattern is named (library / `hatchPatterns` table) and may carry its own `def` so a pattern Sketchor lacks still renders. */
export type HatchPaint =
  | { kind: "pattern"; name: string; scale: number; angle: number; origin?: Point; double?: boolean; def?: PatternFamily[] }
  | { kind: "solid"; color: string }
  | { kind: "gradient"; name: string; colors: [string, string?]; angle: number; centered?: boolean; shift?: number };

/**
 * A hatched region (H-01): boundary loops plus a paint. Named `paint`, not
 * `fill`, because generic code reads `entity.fill` as a colour string on closed shapes.
 */
export interface HatchEntity {
  id: EntityId;
  type: "hatch";
  /** Human-readable handle used in the sketch code view (e.g. "H1"). */
  name?: string;
  layer?: string;
  /** Pattern line / outline colour. Absent = the theme's default entity colour. */
  color?: string;
  linetype?: string;
  lineweight?: number;
  construction?: boolean;
  /** Never set: keeps `entity.fill` (a colour on closed shapes) readable on the whole union. */
  fill?: undefined;
  loops: HatchLoop[];
  paint: HatchPaint;
  /** Island handling: normal = alternate (even-odd), outer = only the outermost area, ignore = outer boundary only. */
  style: "normal" | "outer" | "ignore";
  /** Follows its boundary entities (H-05). */
  associative?: boolean;
  /** Boundary entity ids, when associative. */
  sources?: EntityId[];
  /** Draw order, lower first (H-08); absent = 0. A negative number sends the hatch behind its boundary. */
  drawOrder?: number;
  /** An associative hatch whose boundary could no longer be formed keeps its last loops and is flagged (H-05). */
  boundaryLost?: boolean;
  backgroundColor?: string;
  /** 0..1, 0 = opaque. */
  transparency?: number;
}

/** A rectangular array stamped by one insert (DXF MINSERT); spacings run along the insert's own rotated axes. */
export interface InsertArray {
  cols: number;
  rows: number;
  colSpacing: number;
  rowSpacing: number;
}

/**
 * A placed instance of a block definition (B-01). `block` names a record of the
 * `blocks` table; the instance is drawn by evaluating that definition under
 * translate(insert) · rotate · scale · translate(-basePoint), so editing the
 * definition updates every instance. Selected, moved and deleted as one entity.
 */
export interface InsertEntity {
  id: EntityId;
  type: "insert";
  /** Human-readable handle used in the sketch code view (e.g. "I1"). */
  name?: string;
  /** Layer of the instance; layer-"0" content of the definition inherits it. */
  layer?: string;
  /** Inherited by definition entities whose colour is BYBLOCK. */
  color?: string;
  linetype?: string;
  lineweight?: number;
  construction?: boolean;
  /** Never set: keeps `entity.fill` (a colour on closed shapes) readable on the whole union. */
  fill?: undefined;
  /** Name of the `blocks` record this instance shows. */
  block: string;
  /** Where the definition's base point lands. */
  insert: Point;
  /** Per-axis scale; a negative value mirrors. */
  scale: { x: number; y: number };
  /** Radians, counter-clockwise. */
  rotation: number;
  /** Attribute values by tag (B-05). */
  attributes: Record<string, string>;
  array?: InsertArray;
  /** Parameter values of a dynamic block (Phase 6). */
  params?: Record<string, number | string>;
}

/** The dimension forms (D-02). */
export type DimKind = "linear" | "aligned" | "angular2l" | "angular3p" | "radial" | "diametric" | "arclength" | "ordinate" | "jogged";

/**
 * A dimension (D-02a): measured value, extension lines, dimension line,
 * arrows and text, all laid out from the data below by `dimensions/layout.ts`.
 *
 * `defPoints` is the always-valid fallback and the DXF/block-insert form; when
 * `refs`/`target`/`targets` name geometry in the active document the layout
 * reads the live positions instead, so the dimension follows its geometry
 * (associative). Meaning of `defPoints` per kind —
 * linear/aligned: [measured 1, measured 2, a point on the dimension line];
 * angular3p: [vertex, end 1, end 2, a point on the dimension arc];
 * angular2l: [line 1 a, line 1 b, line 2 a, line 2 b, a point on the arc];
 * radial/diametric: [centre, a point on the circle]; jogged: [centre, point on
 * the arc, substitute centre]; arclength: [centre, arc start, arc end, a point
 * on the dimension arc]; ordinate: [datum origin, feature, leader end].
 *
 * A driving dimension IS the solver constraint (`dimensions/driving.ts`):
 * `value` is its target (mm, or radians for angles) and the geometry follows.
 */
export interface DimensionEntity {
  id: EntityId;
  type: "dimension";
  name?: string;
  layer?: string;
  color?: string;
  /** Ignored for dimensions — present only so every entity shares one shape. */
  fill?: string;
  linetype?: string;
  lineweight?: number;
  construction?: boolean;
  kind: DimKind;
  defPoints: Point[];
  /** Associative anchors, index-aligned with `defPoints` (null = free point). */
  refs?: (PointRef | null)[];
  /** The circle/arc a radial, diametric, jogged or arc-length dimension measures. */
  target?: EntityId;
  /** The two lines of an associative angular2l dimension. */
  targets?: [EntityId, EntityId];
  /** Linear: direction of the dimension line, radians (0 = horizontal, π/2 = vertical). */
  angle?: number;
  /** Ordinate: which coordinate it reads. */
  axis?: "x" | "y";
  /** Text centre when moved off its default place. */
  textPos?: Point;
  /** Replaces the measured text; `<>` stands for it. */
  textOverride?: string;
  /** `dimStyles` record name (absent = built-in default). */
  style?: string;
  /** Per-dimension overrides of the style. */
  overrides?: Partial<import("./dimensions/style").DimStyle>;
  /** Multiplies every style size (DIMSCALE); block inserts scale it with the block. */
  scale?: number;
  /** True = this dimension drives the geometry; false = reference (shown in parentheses). */
  driving: boolean;
  /** The driving target value (mm / radians). */
  value?: number;
  /** Formula for `value` once parameters exist (T-45). */
  expression?: string;
}

/**
 * D-04: multi-line rich text. `text` holds MTEXT inline codes (`\P`, `\L..\l`,
 * `\S1/2;`, `{\C1;..}` ...; see `mtext/parse.ts`); `width` is the wrap width
 * (0 = never wrap); `attachment` is DXF's 1-9 (1 top-left .. 9 bottom-right) and
 * says which corner/edge of the box `at` is.
 */
export interface MTextEntity {
  id: EntityId;
  type: "mtext";
  name?: string;
  layer?: string;
  color?: string;
  /** Ignored for mtext - present only so every entity shares one shape. */
  fill?: string;
  linetype?: string;
  lineweight?: number;
  construction?: boolean;
  at: Point;
  width: number;
  attachment: number;
  text: string;
  height: number;
  rotation: number;
  /** `textStyles` record name (absent = Standard). */
  style?: string;
  /** Line spacing factor (1 = single, DXF group 44). */
  lineSpacing?: number;
  /** Background mask: fill colour (absent = the canvas background) and border offset factor (DXF 45, default 1.5). */
  background?: { color?: string; scale?: number };
}

export type Entity =
  | LineEntity
  | CircleEntity
  | ArcEntity
  | PointEntity
  | EllipseEntity
  | SplineEntity
  | HatchEntity
  | InsertEntity
  | PolylineEntity
  | TextEntity
  | ImageEntity
  | DimensionEntity
  | MTextEntity;

/** Rough width of a {@link TextEntity} string in world units — one built-in font, ~0.55 em per glyph. */
export function textWidth(text: string, height: number): number {
  return text.length * height * 0.55;
}

/** The four corners of a text entity's bounding box, in world space (rotated about `at`). */
export function textCorners(entity: TextEntity): Point[] {
  const w = textWidth(entity.text, entity.height) * (entity.widthFactor && entity.widthFactor > 0 ? entity.widthFactor : 1);
  const h = entity.height;
  const ox = entity.at.x + (entity.halign === "center" ? -w / 2 : entity.halign === "right" ? -w : 0);
  const oy = entity.at.y + (entity.valign === "middle" ? -h / 2 : entity.valign === "top" ? -h : 0);
  return [
    { x: ox, y: oy },
    { x: ox + w, y: oy },
    { x: ox + w, y: oy + h },
    { x: ox, y: oy + h },
  ].map((p) => rotatePoint(p, entity.at, entity.rotation));
}

/** The four corners of an image's displayed rectangle, in world space (rotated about `insert`). */
export function imageCorners(entity: ImageEntity): Point[] {
  const { insert, width, height, rotation } = entity;
  return [
    { x: insert.x, y: insert.y },
    { x: insert.x + width, y: insert.y },
    { x: insert.x + width, y: insert.y + height },
    { x: insert.x, y: insert.y + height },
  ].map((p) => rotatePoint(p, insert, rotation));
}

/** `entity.points[i]` to `entity.points[i+1]` for every segment, wrapping once more if `closed`. Bulge defaults to 0 (straight). */
export function polylineSegments(entity: PolylineEntity): { a: Point; b: Point; bulge: number }[] {
  const n = entity.points.length;
  const segCount = entity.closed ? n : n - 1;
  const segments: { a: Point; b: Point; bulge: number }[] = [];
  for (let i = 0; i < segCount; i++) {
    segments.push({
      a: entity.points[i],
      b: entity.points[(i + 1) % n],
      bulge: entity.bulges?.[i] ?? 0,
    });
  }
  return segments;
}

let counter = 0;

export function newEntityId(): EntityId {
  counter += 1;
  return `e${Date.now().toString(36)}${counter.toString(36)}`;
}

export function translated<T extends Entity>(entity: T, dx: number, dy: number): T {
  switch (entity.type) {
    case "line":
      return {
        ...entity,
        a: { x: entity.a.x + dx, y: entity.a.y + dy },
        b: { x: entity.b.x + dx, y: entity.b.y + dy },
      };
    case "circle":
      return {
        ...entity,
        center: { x: entity.center.x + dx, y: entity.center.y + dy },
      };
    case "arc":
      return {
        ...entity,
        center: { x: entity.center.x + dx, y: entity.center.y + dy },
      };
    case "point":
      return { ...entity, p: { x: entity.p.x + dx, y: entity.p.y + dy } };
    case "polyline":
      return { ...entity, points: entity.points.map((p) => ({ x: p.x + dx, y: p.y + dy })) };
    case "text":
      return { ...entity, at: { x: entity.at.x + dx, y: entity.at.y + dy } };
    case "image":
      return { ...entity, insert: { x: entity.insert.x + dx, y: entity.insert.y + dy } };
    default:
      // A kind outside the built-in seven (see kinds/registry.ts): its own affine map, or unmoved.
      return (kindTransform(entity as Entity, [1, 0, 0, 1, dx, dy]) ?? entity) as T;
  }
}

/** Scale, then rotate, then translate about `pivot`, as the affine matrix the kind registry takes. */
function similarityAbout(pivot: Point, dx: number, dy: number, rotation: number, scale: number): [number, number, number, number, number, number] {
  const a = scale * Math.cos(rotation);
  const b = scale * Math.sin(rotation);
  return [a, b, -b, a, pivot.x + dx - (a * pivot.x - b * pivot.y), pivot.y + dy - (b * pivot.x + a * pivot.y)];
}

/**
 * Rotates an entity rigidly about `pivot` by `angle` radians. The shared
 * primitive behind the straighten tool and group rotation — one pivot, one
 * angle, applied to every point of the entity so shapes stay congruent.
 */
export function rotated<T extends Entity>(entity: T, pivot: Point, angle: number): T {
  switch (entity.type) {
    case "line":
      return { ...entity, a: rotatePoint(entity.a, pivot, angle), b: rotatePoint(entity.b, pivot, angle) };
    case "circle":
      return { ...entity, center: rotatePoint(entity.center, pivot, angle) };
    case "arc":
      return {
        ...entity,
        center: rotatePoint(entity.center, pivot, angle),
        startAngle: entity.startAngle + angle,
        endAngle: entity.endAngle + angle,
      };
    case "point":
      return { ...entity, p: rotatePoint(entity.p, pivot, angle) };
    case "polyline":
      // Bulge is a ratio of angle, not position, so it's unaffected by rotation.
      return { ...entity, points: entity.points.map((p) => rotatePoint(p, pivot, angle)) };
    case "text":
      return { ...entity, at: rotatePoint(entity.at, pivot, angle), rotation: entity.rotation + angle };
    case "image":
      return { ...entity, insert: rotatePoint(entity.insert, pivot, angle), rotation: entity.rotation + angle };
    default:
      return (kindTransform(entity as Entity, similarityAbout(pivot, 0, 0, angle, 1)) ?? entity) as T;
  }
}

/**
 * General rigid/uniform transform about `pivot`: scale, then rotate, then
 * translate by (dx, dy). Backs the `transform-entities` command that groups
 * (move/rotate as a unit) and the straighten tool both build on.
 */
export function transformed<T extends Entity>(
  entity: T,
  pivot: Point,
  dx: number,
  dy: number,
  rotation: number,
  scale: number,
): T {
  const movePoint = (p: Point): Point => {
    const scaled = { x: pivot.x + (p.x - pivot.x) * scale, y: pivot.y + (p.y - pivot.y) * scale };
    const rotatedP = rotatePoint(scaled, pivot, rotation);
    return { x: rotatedP.x + dx, y: rotatedP.y + dy };
  };
  switch (entity.type) {
    case "line":
      return { ...entity, a: movePoint(entity.a), b: movePoint(entity.b) };
    case "circle":
      return { ...entity, center: movePoint(entity.center), radius: entity.radius * scale };
    case "arc":
      return {
        ...entity,
        center: movePoint(entity.center),
        radius: entity.radius * scale,
        startAngle: entity.startAngle + rotation,
        endAngle: entity.endAngle + rotation,
      };
    case "point":
      return { ...entity, p: movePoint(entity.p) };
    case "polyline":
      // Uniform scale changes segment length but not the angle bulge encodes, so bulges carry over unchanged.
      return { ...entity, points: entity.points.map(movePoint) };
    case "text":
      return { ...entity, at: movePoint(entity.at), rotation: entity.rotation + rotation, height: entity.height * scale };
    case "image":
      return {
        ...entity,
        insert: movePoint(entity.insert),
        rotation: entity.rotation + rotation,
        width: entity.width * scale,
        height: entity.height * scale,
      };
    default:
      return (kindTransform(entity as Entity, similarityAbout(pivot, dx, dy, rotation, scale)) ?? entity) as T;
  }
}

/** The vertex/handle points of an entity, in world space — used for bounds, snapping, and centroids. */
export function entityPoints(entity: Entity): Point[] {
  switch (entity.type) {
    case "line":
      return [entity.a, entity.b];
    case "circle":
      return [
        { x: entity.center.x + entity.radius, y: entity.center.y },
        { x: entity.center.x - entity.radius, y: entity.center.y },
        { x: entity.center.x, y: entity.center.y + entity.radius },
        { x: entity.center.x, y: entity.center.y - entity.radius },
      ];
    case "arc":
      return [
        arcPointAt(entity.center, entity.radius, entity.startAngle),
        arcPointAt(entity.center, entity.radius, entity.endAngle),
      ];
    case "point":
      return [entity.p];
    case "polyline":
      return entity.points;
    case "text":
      return [entity.at, ...textCorners(entity)];
    case "image":
      return [entity.insert, ...imageCorners(entity)];
    default:
      return kindPoints(entity as Entity);
  }
}

/** Total run length of a polyline, following each segment's real curve (bulged segments contribute arc length, not chord length). */
export function polylineLength(entity: PolylineEntity): number {
  let total = 0;
  for (const seg of polylineSegments(entity)) {
    const bulgeArc = bulgeToArc(seg.a, seg.b, seg.bulge);
    total += bulgeArc
      ? bulgeArc.radius * arcSweep(bulgeArc.startAngle, bulgeArc.endAngle, bulgeArc.ccw)
      : dist(seg.a, seg.b);
  }
  return total;
}

/** Arithmetic mean of every entity's defining points — the pivot the straighten tool and group-rotate use by default. */
export function centroidOfEntities(entities: Entity[]): Point {
  let sx = 0;
  let sy = 0;
  let n = 0;
  for (const e of entities) {
    for (const p of entityPoints(e)) {
      sx += p.x;
      sy += p.y;
      n += 1;
    }
  }
  return n > 0 ? { x: sx / n, y: sy / n } : { x: 0, y: 0 };
}
