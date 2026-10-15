import { parseDxfHatch } from "./hatch/hatchDxf";
import { hatchArt } from "./hatch/render";
import type { Entity, InsertEntity, SplineEntity } from "./entities";
import type { AttributeDef, BlockDefinition } from "./blocks/types";
import { blockWouldCycle } from "./blocks/evaluate";
import { imageCorners, newEntityId, polylineSegments, textCorners, transformed } from "./entities";
import type { Point } from "./geometry";
import { kindBounds, kindTessellate, kindTransform } from "./kinds/registry";
import { arcExtentPoints, arcPointAt, arcSweep, bulgeToArc, dist } from "./geometry";
import { aciToHex } from "./aci";
import { transformEllipse } from "./ellipse";
import { clampedUniformKnots as clampedKnots, interpolateNurbs, isValidNurbs, type NurbsData } from "./nurbs";
import { unescapeDxfText } from "./dxfText";
import { binaryDxfToText } from "./dxfBinary";
import { STANDARD_TEXT_STYLE, hAlignFromCode, vAlignFromCode, type TextStyle } from "./textStyle";
import { SKETCHOR_DICT_KEY, decodeDocData, parseEntityXdata, type SketchorDocData } from "./sketchorData";
import { newGroupId, type Group } from "./groups";
import type { Constraint } from "./constraints";
import type { TableRecord } from "./tables";
import type { ForeignRecord } from "./foreign";

/** Minimal XML text-content escape for the thumbnail SVG. */
function escapeXml(s: string): string {
  return s.replace(/[&<>]/g, (c) => (c === "&" ? "&amp;" : c === "<" ? "&lt;" : "&gt;"));
}

/**
 * Minimal ASCII DXF support: enough to import and preview typical 2D
 * drawings. Handles LINE, CIRCLE, ARC, POINT, ELLIPSE, LWPOLYLINE, legacy
 * POLYLINE/VERTEX, SPLINE, and TEXT/MTEXT. Ellipses, splines, and text are
 * tessellated into line segments so they fit the current entity model —
 * they display and export correctly, just decomposed. Entities with no
 * pure-geometry equivalent (HATCH, DIMENSION, INSERT, LEADER, ...) are
 * intentionally not imported; they're still tallied and surfaced via
 * {@link DxfImportReport}'s `skipped` list rather than silently dropped.
 *
 * The same parser feeds two consumers: the in-app DXF browser (thumbnails
 * + open) and the planned native Explorer thumbnail handler.
 */

interface Pair {
  code: number;
  value: string;
}

interface RawEntity {
  type: string;
  pairs: Pair[];
}

function tokenize(text: string): Pair[] {
  const lines = text.split(/\r\n|\r|\n/);
  const pairs: Pair[] = [];
  for (let i = 0; i + 1 < lines.length; i += 2) {
    const code = parseInt(lines[i].trim(), 10);
    if (Number.isNaN(code)) continue;
    pairs.push({ code, value: lines[i + 1] });
  }
  return pairs;
}

/** Collects raw records from one named section (ENTITIES, BLOCKS, ...), in document order. */
function collectSectionRecords(pairs: Pair[], section: string): RawEntity[] {
  const raws: RawEntity[] = [];
  let inSection = false;
  let current: RawEntity | null = null;

  for (let i = 0; i < pairs.length; i++) {
    const { code, value } = pairs[i];
    const v = value.trim();

    if (code === 0 && v === "SECTION") {
      const name = pairs[i + 1]?.value.trim();
      inSection = name === section;
      continue;
    }
    if (code === 0 && v === "ENDSEC") {
      if (current) raws.push(current);
      current = null;
      inSection = false;
      continue;
    }
    if (!inSection) continue;

    if (code === 0) {
      if (current) raws.push(current);
      current = { type: v.toUpperCase(), pairs: [] };
    } else if (current) {
      current.pairs.push({ code, value });
    }
  }
  if (current) raws.push(current);
  return raws;
}

/** Collects raw entities from the ENTITIES section. */
function collectRawEntities(pairs: Pair[]): RawEntity[] {
  return collectSectionRecords(pairs, "ENTITIES");
}

/** A reusable block definition from the BLOCKS section — its body plus the base point that lands on an INSERT's insertion point. */
interface BlockDef {
  base: Point;
  body: RawEntity[];
}

/**
 * Parses the BLOCKS section into named, reusable definitions. A block's
 * geometry is written in its own coordinate space; `base` (the BLOCK
 * record's code 10/20) is the origin that gets placed at each INSERT's
 * insertion point.
 */
function collectBlocks(pairs: Pair[]): Map<string, BlockDef> {
  const blocks = new Map<string, BlockDef>();
  let name: string | null = null;
  let def: BlockDef | null = null;

  for (const raw of collectSectionRecords(pairs, "BLOCKS")) {
    if (raw.type === "BLOCK") {
      name = str(raw, 2, "");
      def = { base: { x: num(raw, 10), y: num(raw, 20) }, body: [] };
      if (name) blocks.set(name, def);
    } else if (raw.type === "ENDBLK") {
      name = null;
      def = null;
    } else if (def) {
      def.body.push(raw);
    }
  }
  return blocks;
}

/** The pairs following a HEADER variable's `9 $NAME` marker, up to the next variable. Empty if absent. */
function headerVar(pairs: Pair[], name: string): Pair[] {
  for (let i = 0; i < pairs.length; i++) {
    if (pairs[i].code === 9 && pairs[i].value.trim() === name) {
      const out: Pair[] = [];
      for (let j = i + 1; j < pairs.length && pairs[j].code !== 9 && pairs[j].code !== 0; j++) out.push(pairs[j]);
      return out;
    }
  }
  return [];
}

/** A HEADER variable's value for one group code (e.g. 70 for `$INSUNITS`), or null if absent/unreadable. */
function headerNum(pairs: Pair[], name: string, code: number): number | null {
  const p = headerVar(pairs, name).find((x) => x.code === code);
  if (!p) return null;
  const v = parseFloat(p.value);
  return Number.isFinite(v) ? v : null;
}

/**
 * Where a DXF's unit came from, most to least trustworthy:
 * - `insunits`: the file's `$INSUNITS` names a unit.
 * - `measurement`: no `$INSUNITS` (it only exists from R2000/AC1015 on —
 *   e.g. Onshape's R14 exports never carry it) or it's 0 "unitless", so
 *   `$MEASUREMENT` decides (0 imperial → in, 1 metric → mm), as AutoCAD does.
 * - `inferred`: neither variable, but the header still carries its
 *   template's imperial or metric drawing defaults (text size, arrow size,
 *   sheet limits, alternate-unit factor) — a guess, flagged to the user.
 * - `none`: no hint at all; coordinates are read in the caller's
 *   `assumeUnits` (the numbers as written), also flagged to the user.
 * - `conflict`: the file says millimetres, but its `$DIMALTF` of 1000
 *   (primary → alternate dimension factor) only makes sense for a drawing
 *   in metres — read as metres, flagged to the user. Seen in real
 *   production files: parts that measured 0.3 mm read as mm, 12" as metres.
 */
export type DxfUnitSource = "insunits" | "measurement" | "inferred" | "none" | "conflict";

/**
 * Millimetres per unit for every `$INSUNITS` code the DXF spec defines
 * (1 in, 2 ft, 3 mi, 4 mm, 5 cm, 6 m, 7 km, 8 µin, 9 mil, 10 yd, 11 Å,
 * 12 nm, 13 µm, 14 dm, 15 dam, 16 hm, 17 Gm, 18 AU, 19 ly, 20 pc,
 * 21–24 US survey ft/in/yd/mi). 0 (unitless) has no factor.
 */
export const MM_PER_INSUNIT: Readonly<Record<number, number>> = {
  1: 25.4,
  2: 304.8,
  3: 1609344,
  4: 1,
  5: 10,
  6: 1000,
  7: 1e6,
  8: 25.4e-6,
  9: 0.0254,
  10: 914.4,
  11: 1e-7,
  12: 1e-6,
  13: 1e-3,
  14: 100,
  15: 1e4,
  16: 1e5,
  17: 1e12,
  18: 1.495978707e14,
  19: 9.4607304725808e18,
  20: 3.0856775814913673e19,
  21: 1200000 / 3937,
  22: 100000 / 3937,
  23: 3600000 / 3937,
  24: 6336000000 / 3937,
};

const near = (v: number | null, target: number): boolean =>
  v !== null && Math.abs(v - target) <= Math.abs(target) * 0.02;

/**
 * Guesses imperial (1) vs metric (4) from the stock values AutoCAD's
 * acad.dwt / acadiso.dwt templates leave in the header. Only answers when
 * every recognisable hint agrees; 0 if there are none or they conflict.
 */
function inferUnitsFromDefaults(pairs: Pair[]): number {
  let imperial = 0;
  let metric = 0;
  const vote = (v: number | null, imp: number[], met: number[]) => {
    if (imp.some((t) => near(v, t))) imperial++;
    else if (met.some((t) => near(v, t))) metric++;
  };
  vote(headerNum(pairs, "$DIMALTF", 40), [25.4], [0.03937]);
  vote(headerNum(pairs, "$DIMTXT", 40), [0.18], [2.5]);
  vote(headerNum(pairs, "$DIMASZ", 40), [0.18], [2.5]);
  vote(headerNum(pairs, "$DIMEXO", 40), [0.0625], [0.625]);
  vote(headerNum(pairs, "$TEXTSIZE", 40), [0.2], [2.5]);
  const limX = headerNum(pairs, "$LIMMAX", 10);
  const limY = headerNum(pairs, "$LIMMAX", 20);
  if (near(limX, 12) && near(limY, 9)) imperial++;
  else if (near(limX, 420) && near(limY, 297)) metric++;
  if (imperial > 0 && metric === 0) return 1;
  if (metric > 0 && imperial === 0) return 4;
  return 0;
}

/** Resolves the drawing's unit as an `$INSUNITS` code plus where it came from (see {@link DxfUnitSource}). */
function resolveUnits(pairs: Pair[]): { code: number; source: DxfUnitSource } {
  const declared = declaredUnits(pairs);
  if (declared.code === 4 && near(headerNum(pairs, "$DIMALTF", 40), 1000)) return { code: 6, source: "conflict" };
  return declared;
}

function declaredUnits(pairs: Pair[]): { code: number; source: DxfUnitSource } {
  const insUnits = headerNum(pairs, "$INSUNITS", 70);
  if (insUnits && MM_PER_INSUNIT[insUnits]) return { code: insUnits, source: "insunits" };
  const measurement = headerNum(pairs, "$MEASUREMENT", 70);
  if (measurement === 0) return { code: 1, source: "measurement" };
  if (measurement === 1) return { code: 4, source: "measurement" };
  const inferred = inferUnitsFromDefaults(pairs);
  if (inferred) return { code: inferred, source: "inferred" };
  return { code: 0, source: "none" };
}

const ORIGIN: Point = { x: 0, y: 0 };

/**
 * Entities are always stored internally in millimeters (see units.ts), but a
 * DXF's coordinates are in whatever real-world unit it declares — so they're
 * rescaled to mm here, once, right after parsing. Without this, an
 * inch-based file's raw numbers would be stored as if they were already
 * millimeters: 25.4x too small, and silently wrong again on export.
 */
function scaleToMm(entities: Entity[], insUnits: number): Entity[] {
  const mmPerUnit = MM_PER_INSUNIT[insUnits];
  if (!mmPerUnit || mmPerUnit === 1) return entities;
  return entities.map((e) => scaleKept(e, mmPerUnit));
}

/** `e` scaled about the origin by `k`; an insert only moves (see {@link scaleKept}) — pair it with {@link scaleBlockDefinition}. */
export function scaleEntityKeepingInserts(e: Entity, k: number): Entity {
  return scaleKept(e, k);
}

/** A block definition with every length scaled by `k` (body, base point, attribute positions and heights). */
export function scaleBlockDefinition(def: BlockDefinition, k: number): BlockDefinition {
  return {
    ...def,
    basePoint: { x: def.basePoint.x * k, y: def.basePoint.y * k },
    entities: def.entities.map((e) => scaleKept(e, k)),
    attributeDefs: def.attributeDefs.map((a) => ({ ...a, at: { x: a.at.x * k, y: a.at.y * k }, height: a.height * k })),
  };
}

/** Scales file units to mm. An insert only moves (and its array spacing grows): its scale is a ratio, and the definitions it names are scaled the same way. */
function scaleKept(e: Entity, k: number): Entity {
  if (e.type !== "insert") return transformed(e, ORIGIN, 0, 0, 0, k);
  return {
    ...e,
    insert: { x: e.insert.x * k, y: e.insert.y * k },
    ...(e.array ? { array: { ...e.array, colSpacing: e.array.colSpacing * k, rowSpacing: e.array.rowSpacing * k } } : {}),
  };
}

function num(raw: RawEntity, code: number, fallback = 0): number {
  const p = raw.pairs.find((x) => x.code === code);
  return p ? parseFloat(p.value) : fallback;
}

/** First string value for a group code (e.g. code 8 = layer name). */
function str(raw: RawEntity, code: number, fallback = ""): string {
  const p = raw.pairs.find((x) => x.code === code);
  if (!p) return fallback;
  const v = p.value.trim();
  // Names (block 2, layer 8) in R12 files carry backslash-U escapes for non-ASCII.
  return code === 2 || code === 8 ? unescapeDxfText(v) : v;
}

/** Every numeric value for a repeated group code, in document order (e.g. SPLINE control points). */
function allNums(raw: RawEntity, code: number): number[] {
  return raw.pairs.filter((p) => p.code === code).map((p) => parseFloat(p.value));
}

/**
 * X-04: an entity's own colour, if it declared one explicitly — true colour
 * (group 420, a packed 0xRRGGBB int, AC1018+) over the indexed one (group
 * 62) when both are present, since 420 is exact and 62 is only ever the
 * writer's nearest-palette guess for readers that don't understand 420 (see
 * `dxfw/entities.ts`). ACI 0 ("ByBlock") and 256 ("ByLayer", sometimes
 * written negative for "layer off") aren't real colours — Sketchor has no
 * per-layer colour to inherit from, so both read as "no explicit colour",
 * same as the group being absent.
 */
function rawColor(raw: RawEntity): string | undefined {
  const trueColor = raw.pairs.find((p) => p.code === 420);
  if (trueColor) {
    const n = parseInt(trueColor.value, 10);
    if (Number.isFinite(n) && n >= 0) return `#${(n & 0xffffff).toString(16).padStart(6, "0")}`;
  }
  const aci = raw.pairs.find((p) => p.code === 62);
  if (aci) {
    const n = parseInt(aci.value, 10);
    if (n >= 1 && n <= 255) return aciToHex(n);
  }
  return undefined;
}

/**
 * Z-04: an entity's own linetype name (group 6), if it declared one
 * explicitly. `BYLAYER`/`BYBLOCK` (and absence) all mean "no explicit
 * linetype" the same way an absent group 62 means "no explicit colour" —
 * Sketchor has no per-layer *or* per-block linetype to resolve a block
 * reference against at parse time, so both collapse to the same thing. A
 * name that isn't one of the nine built-ins (linetypes.ts) is kept verbatim
 * rather than dropped — the renderer falls back to drawing it solid
 * (`builtinLinetype`'s unknown-name case) but the name itself still
 * round-trips, and a future `.lin` import can give it a real pattern.
 */
function rawLinetype(raw: RawEntity): string | undefined {
  const name = str(raw, 6, "");
  return name && name !== "BYLAYER" && name !== "BYBLOCK" ? name : undefined;
}

/**
 * Z-04: an entity's own lineweight in mm (group 370, DXF's own unit is
 * hundredths of a millimetre). The negative sentinels -1/-2/-3 (BYLAYER/
 * BYBLOCK/DEFAULT) all mean "no explicit lineweight", same as the group
 * being absent — Sketchor has no per-layer lineweight to resolve BYLAYER
 * against at parse time either (same limitation as colour and linetype).
 */
function rawLineweight(raw: RawEntity): number | undefined {
  const lw = raw.pairs.find((p) => p.code === 370);
  if (!lw) return undefined;
  const n = parseInt(lw.value, 10);
  return Number.isFinite(n) && n >= 0 ? n / 100 : undefined;
}

function line(a: Point, b: Point, layer?: string): Entity {
  return { id: newEntityId(), type: "line", a, b, ...(layer ? { layer } : {}) };
}

/** Builds one polyline entity from `points`, or null if there aren't enough points to draw anything. */
function polylineEntity(points: Point[], closed: boolean, bulges: number[] | undefined, layer?: string): Entity | null {
  if (points.length < 2) return null;
  const hasBulge = bulges?.some((b) => Math.abs(b) > 1e-9);
  return {
    id: newEntityId(),
    type: "polyline",
    points,
    closed,
    ...(hasBulge ? { bulges } : {}),
    ...(layer ? { layer } : {}),
  };
}

/** Emits a tessellated point run (SPLINE, ELLIPSE, a text stroke, ...) as one polyline entity — auto-closes if the first and last points coincide. */
function polyline(pts: Point[], out: Entity[], layer?: string): void {
  if (pts.length < 2) return;
  const closed = pts.length > 2 && dist(pts[0], pts[pts.length - 1]) < 1e-6;
  const points = closed ? pts.slice(0, -1) : pts;
  const entity = polylineEntity(points, closed, undefined, layer);
  if (entity) out.push(entity);
}

function arc(
  center: Point,
  radius: number,
  startAngle: number,
  endAngle: number,
  ccw: boolean,
  layer?: string,
): Entity {
  return {
    id: newEntityId(),
    type: "arc",
    center,
    radius,
    startAngle,
    endAngle,
    ccw,
    ...(layer ? { layer } : {}),
  };
}

/** DXF ARC (angles in degrees, always swept counterclockwise from code 50 to code 51). */
function dxfArc(cx: number, cy: number, r: number, a0deg: number, a1deg: number, layer?: string): Entity {
  return arc({ x: cx, y: cy }, r, (a0deg * Math.PI) / 180, (a1deg * Math.PI) / 180, true, layer);
}

/** A polyline vertex, carrying the bulge for the segment that follows it. */
interface Vertex {
  x: number;
  y: number;
  bulge: number;
}

/**
 * Parses LWPOLYLINE vertices in document order, keeping each vertex's
 * bulge (code 42) attached. `nums()` can't be used here because it would
 * decouple coordinates from their bulges.
 */
function lwpolylineVertices(raw: RawEntity): Vertex[] {
  const verts: Vertex[] = [];
  let cur: Vertex | null = null;
  for (const p of raw.pairs) {
    if (p.code === 10) {
      if (cur) verts.push(cur);
      cur = { x: parseFloat(p.value), y: 0, bulge: 0 };
    } else if (p.code === 20 && cur) {
      cur.y = parseFloat(p.value);
    } else if (p.code === 42 && cur) {
      cur.bulge = parseFloat(p.value);
    }
  }
  if (cur) verts.push(cur);
  return verts;
}

/** Builds one polyline entity from LWPOLYLINE/POLYLINE vertices, preserving each segment's bulge (curved segments stay real arcs on render/export). */
function emitPolylineWithBulges(verts: Vertex[], closed: boolean, out: Entity[], layer?: string): void {
  if (verts.length < 2) return;
  const points = verts.map((v) => ({ x: v.x, y: v.y }));
  // A vertex's bulge belongs to the segment leaving it; the last vertex's bulge only matters for the closing segment.
  const bulges = closed ? verts.map((v) => v.bulge) : verts.slice(0, -1).map((v) => v.bulge);
  const entity = polylineEntity(points, closed, bulges, layer);
  if (entity) out.push(entity);
}

/* ------------------------- SPLINE tessellation ------------------------ */

/** A standard clamped/open uniform knot vector, used when a SPLINE's own knots are missing or malformed. */
function clampedUniformKnots(count: number, degree: number): number[] {
  const numMid = Math.max(0, count + degree + 1 - 2 * (degree + 1));
  const knots: number[] = [];
  for (let i = 0; i <= degree; i++) knots.push(0);
  for (let i = 1; i <= numMid; i++) knots.push(i / (numMid + 1));
  for (let i = 0; i <= degree; i++) knots.push(1);
  return knots;
}

/** Knot span containing `u`, via binary search (Piegl & Tiller, "The NURBS Book", A2.1). */
function findSpan(degree: number, n: number, u: number, knots: number[]): number {
  if (u >= knots[n + 1]) return n;
  if (u <= knots[degree]) return degree;
  let lo = degree;
  let hi = n + 1;
  while (u < knots[lo] || u >= knots[lo + 1]) {
    const mid = Math.floor((lo + hi) / 2);
    if (u < knots[mid]) hi = mid;
    else lo = mid;
  }
  return lo;
}

interface HomogeneousPoint {
  x: number;
  y: number;
  w: number;
}

/** Evaluates a (rational) B-spline curve at parameter `u` via de Boor's algorithm in homogeneous coordinates. */
function deBoorPoint(degree: number, knots: number[], weighted: HomogeneousPoint[], u: number): Point {
  const n = weighted.length - 1;
  const k = findSpan(degree, n, u, knots);
  const d: HomogeneousPoint[] = [];
  for (let j = 0; j <= degree; j++) d[j] = { ...weighted[k - degree + j] };
  for (let r = 1; r <= degree; r++) {
    for (let j = degree; j >= r; j--) {
      const i = k - degree + j;
      const denom = knots[i + degree - r + 1] - knots[i];
      const alpha = denom !== 0 ? (u - knots[i]) / denom : 0;
      d[j] = {
        x: (1 - alpha) * d[j - 1].x + alpha * d[j].x,
        y: (1 - alpha) * d[j - 1].y + alpha * d[j].y,
        w: (1 - alpha) * d[j - 1].w + alpha * d[j].w,
      };
    }
  }
  const res = d[degree];
  return res.w !== 0 ? { x: res.x / res.w, y: res.y / res.w } : { x: res.x, y: res.y };
}

/** A DXF SPLINE as a spline entity's data: control points when they are valid, else its fit points interpolated. */
function splineFromRaw(raw: RawEntity): Omit<SplineEntity, "id" | "type" | "layer"> | null {
  const flags = Math.round(num(raw, 70, 0));
  const xs = allNums(raw, 10);
  const ys = allNums(raw, 20);
  const count = Math.min(xs.length, ys.length);
  const fx = allNums(raw, 11);
  const fy = allNums(raw, 21);
  const fit = Array.from({ length: Math.min(fx.length, fy.length) }, (_, i) => ({ x: fx[i], y: fy[i] }));
  const closed = (flags & 3) !== 0;
  // Degree 3 with two control points is impossible; it degrades to what the points support (a line).
  const degree = Math.max(1, Math.min(11, count - 1, Math.round(num(raw, 71, 3))));
  const controlPoints = Array.from({ length: count }, (_, i) => ({ x: xs[i], y: ys[i] }));
  const knots = allNums(raw, 40);
  const weights = allNums(raw, 41);
  const candidate: NurbsData = {
    degree,
    controlPoints,
    knots: knots.length === count + degree + 1 ? knots : clampedKnots(count, degree),
    ...(weights.length === count ? { weights } : {}),
  };
  // Start/end tangents (12/13) are directions only; scale them to a handle about a third of the first/last fit leg.
  const handle = (code: number, a: Point, b: Point): { x: number; y: number } | undefined => {
    const x = num(raw, code, NaN);
    const y = num(raw, code + 10, NaN);
    const len = Math.hypot(x, y);
    if (!(len > 1e-12)) return undefined;
    const k = Math.hypot(b.x - a.x, b.y - a.y) / 3 / len;
    return { x: x * k, y: y * k };
  };
  const tangents =
    fit.length >= 2 && !closed
      ? {
          ...(handle(12, fit[0], fit[1]) ? { startTangent: handle(12, fit[0], fit[1]) } : {}),
          ...(handle(13, fit[fit.length - 2], fit[fit.length - 1]) ? { endTangent: handle(13, fit[fit.length - 2], fit[fit.length - 1]) } : {}),
        }
      : {};
  if (count >= degree + 1 && isValidNurbs(candidate)) {
    return { ...candidate, ...(fit.length >= 2 ? { fitPoints: fit, ...tangents } : {}), closed };
  }
  if (fit.length >= 2) {
    const fitted = interpolateNurbs(fit, degree, closed ? undefined : { start: tangents.startTangent, end: tangents.endTangent });
    if (fitted) return { ...fitted, fitPoints: fit, ...tangents, closed };
  }
  return null;
}

/** Tessellates a DXF SPLINE (control points, degree, knots, optional weights) to a polyline. */
function splinePoints(raw: RawEntity): Point[] {
  const xs = allNums(raw, 10);
  const ys = allNums(raw, 20);
  const count = Math.min(xs.length, ys.length);
  if (count < 2) return [];
  const degree = Math.max(1, Math.min(Math.round(num(raw, 71, 3)), count - 1));
  const weights = allNums(raw, 41);
  const ctrl = Array.from({ length: count }, (_, i) => ({ x: xs[i], y: ys[i], w: weights[i] ?? 1 }));

  let knots = allNums(raw, 40);
  if (knots.length !== count + degree + 1) knots = clampedUniformKnots(count, degree);

  const lo = knots[degree];
  const hi = knots[count];
  if (!(hi > lo)) return ctrl.map((c) => ({ x: c.x, y: c.y })); // degenerate knots: fall back to the control polygon

  const weighted = ctrl.map((c) => ({ x: c.w * c.x, y: c.w * c.y, w: c.w }));
  const steps = Math.min(200, Math.max(16, count * 12));
  const pts: Point[] = [];
  for (let i = 0; i <= steps; i++) {
    pts.push(deBoorPoint(degree, knots, weighted, lo + (hi - lo) * (i / steps)));
  }
  return pts;
}

/** Strips MTEXT's inline formatting codes (`\P`, `{\C1;...}`, font/height overrides) down to plain text. */
function cleanMtext(s: string): string {
  return s
    .replace(/\\P/g, " ")
    .replace(/\\~/g, " ")
    .replace(/[{}]/g, "")
    .replace(/\\[A-Za-z][^;]*;/g, "")
    .replace(/\\\\/g, "\\");
}

export interface DxfImportReport {
  /** Entity types that produced geometry, with how many raw records of that type were found. */
  parsed: { type: string; count: number }[];
  /** Entity types found in the file but not imported (e.g. HATCH, DIMENSION). */
  skipped: { type: string; count: number }[];
}

export interface DxfParseResult {
  entities: Entity[];
  warnings: string[];
  report: DxfImportReport;
  /**
   * The unit the coordinates were read in, as an `$INSUNITS` code (entities
   * are already scaled from it to mm). For `unitSource: "none"` this is the
   * caller's `assumeUnits` (0 if none given — coordinates left as-is).
   */
  insUnits: number;
  /** B-07: the file's named block definitions (mm), empty when exploded. Anonymous `*` blocks are expanded where used. */
  blocks: BlockDefinition[];
  /** How {@link insUnits} was decided — anything but `insunits`/`measurement` is a guess worth showing the user. */
  unitSource: DxfUnitSource;
  /** D-01: the file's STYLE table as text styles (heights in mm); empty when it only has Standard defaults. */
  textStyles: TextStyle[];
  /** X-05/X-08: groups (from the SKETCHOR record, else DXF GROUP objects), and the constraints / `params` records a Sketchor-written file carries. Entity ids match `entities`. */
  groups: Group[];
  constraints: Constraint[];
  params: TableRecord[];
  /** X-09: unmodelled entities kept verbatim for re-save. */
  foreign: ForeignRecord[];
}

/** Font file name (group 3) → a `TextStyle.font` value: `.shx` → `shx:<name>`, `.ttf`/`.otf` → `ttf:<family>`, anything else the stroke font. */
export function fontFromStyleFile(file: string): string {
  const f = file.trim().replace(/^.*[\\/]/, "");
  const m = /^(.*)\.(shx|ttf|otf|ttc)$/i.exec(f);
  if (!m || !m[1]) return "sketchor-stroke";
  return m[2].toLowerCase() === "shx" ? (m[1].toLowerCase() === "txt" ? "sketchor-stroke" : `shx:${m[1].toLowerCase()}`) : `ttf:${m[1]}`;
}

/** The STYLE table (TABLES section) as {@link TextStyle}s, scaled by `k` (mm per file unit). */
function collectTextStyles(pairs: Pair[], k: number): TextStyle[] {
  const out: TextStyle[] = [];
  for (const r of collectSectionRecords(pairs, "TABLES")) {
    if (r.type !== "STYLE") continue;
    const name = str(r, 2, "");
    if (!name || name.startsWith("*")) continue;
    const flags = Math.round(num(r, 71, 0));
    const wf = num(r, 41, 1);
    const style: TextStyle = {
      name,
      font: fontFromStyleFile(str(r, 3, "")),
      height: Math.max(0, num(r, 40, 0)) * k,
      widthFactor: wf > 0 ? wf : 1,
      oblique: num(r, 50, 0),
      backwards: (flags & 2) !== 0,
      upsideDown: (flags & 4) !== 0,
    };
    // A bare Standard with every default carries no information.
    if (name === "Standard" && JSON.stringify({ ...style, name: "" }) === JSON.stringify({ ...STANDARD_TEXT_STYLE, name: "" })) continue;
    out.push(style);
  }
  return out;
}

export interface DxfParseOptions {
  /** B-07: "keep" (default) turns BLOCKS into block definitions and INSERT into `insert` entities; "explode" expands every INSERT in place (what a thumbnail wants). */
  blocks?: "keep" | "explode";
  /**
   * `$INSUNITS` code to read the file in when it gives no unit hint at all
   * (e.g. the unit the user is already working in, so the numbers show up
   * exactly as written). Default 0: coordinates are taken as millimetres.
   */
  assumeUnits?: number;
}

/**
 * Places a block's entity into world space for one INSERT:
 * `world = insertion + Rz(rotation) · S(sx, sy) · (blockPoint − base)`.
 * Always assigns a fresh id, so the same definition can be stamped many times.
 *
 * Non-uniform scaling of a circle/arc is really an ellipse, which the entity
 * model can't express — those fall back to the geometric-mean radius and warn.
 * A negative scale on one axis mirrors, which flips an arc's sweep direction.
 */
function placeEntity(
  entity: Entity,
  base: Point,
  insertion: Point,
  sx: number,
  sy: number,
  rotation: number,
  warn: (msg: string) => void,
): Entity {
  const cos = Math.cos(rotation);
  const sin = Math.sin(rotation);
  const map = (p: Point): Point => {
    const x = (p.x - base.x) * sx;
    const y = (p.y - base.y) * sy;
    return { x: insertion.x + x * cos - y * sin, y: insertion.y + x * sin + y * cos };
  };
  const mirrored = sx * sy < 0;
  const radiusScale = Math.sqrt(Math.abs(sx * sy));
  const id = newEntityId();

  switch (entity.type) {
    case "line":
      return { ...entity, id, a: map(entity.a), b: map(entity.b) };
    case "point":
      return { ...entity, id, p: map(entity.p) };
    case "polyline":
      // Bulge is a signed ratio of the included angle: mirroring reverses the
      // sweep, so each bulge flips sign; scaling leaves the angle unchanged.
      return {
        ...entity,
        id,
        points: entity.points.map(map),
        ...(entity.bulges ? { bulges: mirrored ? entity.bulges.map((b) => -b) : entity.bulges } : {}),
      };
    case "circle": {
      if (Math.abs(Math.abs(sx) - Math.abs(sy)) > 1e-9) {
        warn("a block was inserted with non-uniform scale — its circles/arcs are approximated as circular");
      }
      return { ...entity, id, center: map(entity.center), radius: entity.radius * radiusScale };
    }
    case "arc": {
      if (Math.abs(Math.abs(sx) - Math.abs(sy)) > 1e-9) {
        warn("a block was inserted with non-uniform scale — its circles/arcs are approximated as circular");
      }
      // Re-derive the endpoints through the same map, so rotation and any
      // mirroring land correctly without special-casing each reflection axis.
      const center = map(entity.center);
      const startPt = map(arcPointAt(entity.center, entity.radius, entity.startAngle));
      const endPt = map(arcPointAt(entity.center, entity.radius, entity.endAngle));
      return {
        ...entity,
        id,
        center,
        radius: entity.radius * radiusScale,
        startAngle: Math.atan2(startPt.y - center.y, startPt.x - center.x),
        endAngle: Math.atan2(endPt.y - center.y, endPt.x - center.x),
        ccw: mirrored ? !entity.ccw : entity.ccw,
      };
    }
    case "ellipse": {
      // The insert map is affine, and an ellipse stays an ellipse under any affine map — including non-uniform scale.
      const a = cos * sx;
      const b = sin * sx;
      const c = -sin * sy;
      const d = cos * sy;
      const g = transformEllipse(entity, [a, b, c, d, insertion.x - (a * base.x + c * base.y), insertion.y - (b * base.x + d * base.y)]);
      return g ? { ...entity, ...g, id } : { ...entity, id };
    }
    case "hatch": {
      const a = cos * sx;
      const b = sin * sx;
      const c = -sin * sy;
      const d = cos * sy;
      const t = kindTransform(entity, [a, b, c, d, insertion.x - (a * base.x + c * base.y), insertion.y - (b * base.x + d * base.y)]);
      if (!t) warn("a block was inserted with non-uniform scale — a hatch inside it was left unscaled");
      return { ...(t ?? entity), id };
    }
    case "insert": {
      const a = cos * sx;
      const b = sin * sx;
      const c = -sin * sy;
      const d = cos * sy;
      return { ...(kindTransform(entity, [a, b, c, d, insertion.x - (a * base.x + c * base.y), insertion.y - (b * base.x + d * base.y)]) ?? entity), id };
    }
    case "spline":
      return {
        ...entity,
        id,
        controlPoints: entity.controlPoints.map(map),
        ...(entity.fitPoints ? { fitPoints: entity.fitPoints.map(map) } : {}),
      };
    case "text":
      return { ...entity, id, at: map(entity.at), height: entity.height * radiusScale, rotation: entity.rotation + rotation };
    case "dimension": {
      // Same map as above as a matrix; a shearing insert leaves the dimension unmoved (its parts are not recomputed here).
      const a = cos * sx;
      const b = sin * sx;
      const c = -sin * sy;
      const d = cos * sy;
      const placed = kindTransform(entity, [a, b, c, d, insertion.x - (a * base.x + c * base.y), insertion.y - (b * base.x + d * base.y)]) ?? entity;
      const { refs: _r, target: _t, targets: _ts, ...rest } = placed as typeof entity;
      return { ...rest, id } as Entity;
    }
    case "image":
      return {
        ...entity,
        id,
        insert: map(entity.insert),
        width: entity.width * Math.abs(sx),
        height: entity.height * Math.abs(sy),
        rotation: entity.rotation + rotation,
      };
  }
}

/** Nested INSERTs are legal; this caps how deep instantiation will follow them. */
const MAX_BLOCK_DEPTH = 8;

interface ConvertContext {
  blocks: Map<string, BlockDef>;
  /** B-07: named INSERTs become `insert` entities instead of being expanded in place. */
  keep?: boolean;
  warnings: string[];
  depth: number;
  /** Block names currently being instantiated, to break self-referential definitions. */
  stack: ReadonlySet<string>;
  /**
   * The layer of the INSERT that's instantiating these records, if any.
   * Entities drawn on layer "0" inside a block inherit the INSERT's layer —
   * standard DXF behavior, and what makes block geometry respect the layer
   * it was placed on.
   */
  insertLayer?: string;
  /** HATCH sources (330 handles) to resolve once every entity has its handle: hatch entity id -> handles. */
  hatchSources?: Map<string, string[]>;
  /** Top-level entity handle (group 5) -> entity id, for the hatch sources above. */
  handleToId?: Map<string, string>;
  /** X-08: ids already restored from SKETCHOR XDATA in this scope; absent = don't restore ids (inserts being expanded). */
  usedIds?: Set<string>;
  /** X-09: top-level records no case modelled, collected to be kept verbatim. */
  foreign?: RawEntity[];
}

/**
 * Converts a run of raw DXF records into entities. Used for the ENTITIES
 * section and, recursively, for each block body an INSERT instantiates.
 */
function convertRecords(raws: RawEntity[], ctx: ConvertContext): Entity[] {
  const entities: Entity[] = [];
  const warnings = ctx.warnings;

  // Records an INSERT has claimed (its ATTRIBs and SEQEND) — not converted on their own.
  const claimed = new Set<number>();
  for (let ri = 0; ri < raws.length; ri++) {
    if (claimed.has(ri)) continue;
    const raw = raws[ri];
    const rawLayer = str(raw, 8, "0") || "0";
    const layer = rawLayer === "0" && ctx.insertLayer ? ctx.insertLayer : rawLayer;
    const beforeCount = entities.length;
    switch (raw.type) {
      case "ATTRIB": {
        // A loose attribute (or one met while exploding): its value becomes visible text.
        const value = unescapeDxfText(str(raw, 1, ""));
        if (value && (num(raw, 70, 0) & 1) === 0) {
          entities.push({
            id: newEntityId(),
            type: "text",
            layer,
            at: { x: num(raw, 10), y: num(raw, 20) },
            text: value,
            height: num(raw, 40, 2.5) || 2.5,
            rotation: (num(raw, 50, 0) * Math.PI) / 180,
          });
        }
        break;
      }
      case "ATTDEF":
        break;
      case "LINE":
        entities.push(
          line(
            { x: num(raw, 10), y: num(raw, 20) },
            { x: num(raw, 11), y: num(raw, 21) },
            layer,
          ),
        );
        break;
      case "CIRCLE": {
        const r = num(raw, 40);
        if (r > 0) {
          entities.push({
            id: newEntityId(),
            type: "circle",
            layer,
            center: { x: num(raw, 10), y: num(raw, 20) },
            radius: r,
          });
        }
        break;
      }
      case "ARC": {
        const r = num(raw, 40);
        if (r > 0) {
          entities.push(dxfArc(num(raw, 10), num(raw, 20), r, num(raw, 50), num(raw, 51), layer));
        }
        break;
      }
      case "POINT": {
        entities.push({ id: newEntityId(), type: "point", layer, p: { x: num(raw, 10), y: num(raw, 20) } });
        break;
      }
      case "SOLID":
      case "TRACE":
      case "3DFACE": {
        // X-03: filled quad / triangle / 3D face, as its outline (DXF stores corners 1,2,4,3 for SOLID/TRACE, 1,2,3,4 for 3DFACE).
        const c = (k: number): Point => ({ x: num(raw, 10 + k), y: num(raw, 20 + k) });
        const corners = raw.type === "3DFACE" ? [c(0), c(1), c(2), c(3)] : [c(0), c(1), c(3), c(2)];
        const pts = corners.filter((p, i) => i === 0 || Math.hypot(p.x - corners[i - 1].x, p.y - corners[i - 1].y) > 1e-9);
        if (pts.length > 1 && Math.hypot(pts[0].x - pts[pts.length - 1].x, pts[0].y - pts[pts.length - 1].y) < 1e-9) pts.pop();
        if (pts.length >= 3) entities.push({ id: newEntityId(), type: "polyline", layer, points: pts, closed: true });
        break;
      }
      case "ELLIPSE": {
        // A real ellipse entity (C-03). DXF stores the major-axis endpoint relative to the centre, the
        // minor/major ratio, and parametric start/end (counterclockwise, 0..2π for a full one).
        const major = { x: num(raw, 11), y: num(raw, 21) };
        const ratio = num(raw, 40, 1);
        if (Math.hypot(major.x, major.y) < 1e-9 || !(ratio > 0)) break;
        const start = num(raw, 41, 0);
        let end = num(raw, 42, 2 * Math.PI);
        if (end <= start) end += 2 * Math.PI * Math.ceil((start - end) / (2 * Math.PI) + 1e-12);
        // Writers round angles (6 decimals is common): a sweep within that of a full turn is a full ellipse.
        if (end - start > 2 * Math.PI - 1e-5) end = start + 2 * Math.PI;
        entities.push({
          id: newEntityId(),
          type: "ellipse",
          layer,
          center: { x: num(raw, 10), y: num(raw, 20) },
          // A ratio above 1 means the "major" axis was really the minor: swap the roles (turn 90°, invert).
          ...(ratio > 1
            ? { majorAxis: { x: -major.y * ratio, y: major.x * ratio }, ratio: 1 / ratio, start: start - Math.PI / 2, end: end - Math.PI / 2 }
            : { majorAxis: major, ratio, start, end }),
        });
        break;
      }
      case "LWPOLYLINE": {
        const verts = lwpolylineVertices(raw);
        const closed = (num(raw, 70) & 1) === 1;
        emitPolylineWithBulges(verts, closed, entities, layer);
        break;
      }
      case "SPLINE": {
        // A real spline (C-03); only a curve with no usable control or fit data falls back to the old polyline.
        const spline = splineFromRaw(raw);
        if (spline) entities.push({ id: newEntityId(), type: "spline", layer, ...spline });
        else polyline(splinePoints(raw), entities, layer);
        break;
      }
      case "HATCH": {
        const parsed = parseDxfHatch(raw.pairs, warnings);
        if (!parsed) {
          warnings.push("a HATCH without a readable boundary was skipped");
          break;
        }
        const id = newEntityId();
        const paint = parsed.paint.kind === "solid" ? { kind: "solid" as const, color: rawColor(raw) ?? "#9aa4b2" } : parsed.paint;
        entities.push({
          id,
          type: "hatch",
          layer,
          loops: parsed.loops,
          paint,
          style: parsed.style,
          ...(parsed.transparency !== undefined ? { transparency: parsed.transparency } : {}),
        });
        if (parsed.associative && ctx.hatchSources) ctx.hatchSources.set(id, parsed.sourceHandles);
        break;
      }
      case "TEXT":
      case "MTEXT": {
        const at = { x: num(raw, 10), y: num(raw, 20) };
        const height = num(raw, 40, 2.5) || 2.5;
        const rotation = (num(raw, 50, 0) * Math.PI) / 180;
        const raw1 = str(raw, 1, "");
        const content =
          raw.type === "MTEXT"
            ? cleanMtext(unescapeDxfText(raw.pairs.filter((p) => p.code === 3).map((p) => p.value).join("") + raw1))
            : unescapeDxfText(raw1);
        if (content) {
          const style = str(raw, 7, "");
          const hc = Math.round(num(raw, 72, 0));
          const vc = Math.round(num(raw, 73, 0));
          const halign = raw.type === "TEXT" ? hAlignFromCode(hc) : undefined;
          const valign = raw.type === "TEXT" ? vAlignFromCode(vc) : undefined;
          const wf = num(raw, 41, 1);
          const ob = num(raw, 51, 0);
          // With a non-default alignment the real insertion point is group 11.
          const place = (halign || valign) && raw.pairs.some((p) => p.code === 11) ? { x: num(raw, 11), y: num(raw, 21) } : at;
          entities.push({
            id: newEntityId(),
            type: "text",
            layer,
            at: place,
            text: content,
            height,
            rotation,
            ...(style && style !== "Standard" ? { style } : {}),
            ...(halign ? { halign } : {}),
            ...(valign ? { valign } : {}),
            ...(raw.type === "TEXT" && wf > 0 && wf !== 1 ? { widthFactor: wf } : {}),
            ...(raw.type === "TEXT" && ob ? { oblique: ob } : {}),
          });
        }
        break;
      }
      case "INSERT": {
        const name = str(raw, 2, "");
        const block = ctx.blocks.get(name);
        if (ctx.keep && block && !name.startsWith("*")) {
          // B-07: keep the reference. Anonymous (`*U`, `*X`...) blocks are still expanded below.
          const attributes: Record<string, string> = {};
          if (num(raw, 66, 0) === 1) {
            for (let k = ri + 1; k < raws.length; k++) {
              if (raws[k].type === "ATTRIB") {
                claimed.add(k);
                attributes[str(raws[k], 2, "")] = unescapeDxfText(str(raws[k], 1, ""));
              } else {
                if (raws[k].type === "SEQEND") claimed.add(k);
                break;
              }
            }
          }
          const cols = Math.max(1, Math.round(num(raw, 70, 1)) || 1);
          const rows = Math.max(1, Math.round(num(raw, 71, 1)) || 1);
          const ins: InsertEntity = {
            id: newEntityId(),
            type: "insert",
            block: name,
            insert: { x: num(raw, 10), y: num(raw, 20) },
            scale: { x: num(raw, 41, 1) || 1, y: num(raw, 42, 1) || 1 },
            rotation: (num(raw, 50, 0) * Math.PI) / 180,
            attributes,
            ...(rawLayer !== "0" ? { layer: rawLayer } : {}),
            ...(cols > 1 || rows > 1 ? { array: { cols, rows, colSpacing: num(raw, 44, 0), rowSpacing: num(raw, 45, 0) } } : {}),
          };
          entities.push(ins);
          break;
        }
        if (!block) {
          warnings.push(`a block reference points at a missing block definition ('${name}')`);
          break;
        }
        if (ctx.stack.has(name)) {
          warnings.push(`block '${name}' inserts itself — skipped to avoid infinite nesting`);
          break;
        }
        if (ctx.depth >= MAX_BLOCK_DEPTH) {
          warnings.push(`blocks nested deeper than ${MAX_BLOCK_DEPTH} levels were not expanded`);
          break;
        }

        const insertion = { x: num(raw, 10), y: num(raw, 20) };
        const sx = num(raw, 41, 1) || 1;
        const sy = num(raw, 42, 1) || 1;
        const rotation = (num(raw, 50, 0) * Math.PI) / 180;
        // A single INSERT can stamp a rectangular array of copies.
        const cols = Math.max(1, Math.round(num(raw, 70, 1)) || 1);
        const rows = Math.max(1, Math.round(num(raw, 71, 1)) || 1);
        const colSpacing = num(raw, 44, 0);
        const rowSpacing = num(raw, 45, 0);

        // Convert the body once, then stamp transformed copies (fresh ids each).
        const body = convertRecords(block.body, {
          ...ctx,
          depth: ctx.depth + 1,
          stack: new Set([...ctx.stack, name]),
          insertLayer: layer,
          usedIds: undefined,
        });
        const cos = Math.cos(rotation);
        const sin = Math.sin(rotation);
        for (let c = 0; c < cols; c++) {
          for (let r = 0; r < rows; r++) {
            // Array offsets are along the INSERT's own rotated axes.
            const ox = c * colSpacing;
            const oy = r * rowSpacing;
            const at = {
              x: insertion.x + ox * cos - oy * sin,
              y: insertion.y + ox * sin + oy * cos,
            };
            for (const e of body) {
              entities.push(placeEntity(e, block.base, at, sx, sy, rotation, (m) => warnings.push(m)));
            }
          }
        }
        break;
      }
      case "DIMENSION": {
        // F-04: with blocks expanded (thumbnails), a DIMENSION is drawn from the anonymous `*D` block that
        // holds its already-laid-out lines, arrows and text, at world position (no INSERT transform).
        const dimBlock = ctx.keep ? undefined : ctx.blocks.get(str(raw, 2, ""));
        if (dimBlock && !ctx.stack.has(str(raw, 2, "")) && ctx.depth < MAX_BLOCK_DEPTH) {
          const body = convertRecords(dimBlock.body, {
            ...ctx,
            depth: ctx.depth + 1,
            stack: new Set([...ctx.stack, str(raw, 2, "")]),
            insertLayer: layer,
            usedIds: undefined,
          });
          for (const e of body) entities.push(placeEntity(e, dimBlock.base, dimBlock.base, 1, 1, 0, (m) => warnings.push(m)));
          break;
        }
        warnings.push(`unsupported entity: ${raw.type}`);
        if (ctx.depth === 0) ctx.foreign?.push(raw);
        break;
      }
      // POLYLINE / VERTEX / SEQEND are handled in the legacy second pass below.
      default:
        if (!KNOWN_IGNORED.has(raw.type)) {
          warnings.push(`unsupported entity: ${raw.type}`);
          if (ctx.depth === 0) ctx.foreign?.push(raw);
        }
    }
    // Restore a Sketchor-written name, and the entity's own colour/linetype/
    // lineweight, onto the one entity this record produced (ELLIPSE/SPLINE/
    // INSERT can expand into several — none of these belong unambiguously to
    // just one of them, so all are dropped there, same as the name).
    if (entities.length === beforeCount + 1) {
      const handle = str(raw, 5, "");
      if (handle && ctx.handleToId && ctx.depth === 0) ctx.handleToId.set(handle.toUpperCase(), entities[entities.length - 1].id);
      const target = entities[entities.length - 1];
      const x = parseEntityXdata(raw.pairs);
      if (x.name) target.name = x.name;
      if (x.fill) target.fill = x.fill;
      if (x.construction) target.construction = true;
      // X-08: the entity's own id comes back, so constraints/groups saved by id still resolve. A duplicate (an entity copied in another CAD app carries the same XDATA) keeps its fresh id.
      if (x.id && ctx.usedIds && !ctx.usedIds.has(x.id)) {
        ctx.usedIds.add(x.id);
        target.id = x.id;
      }
      const color = rawColor(raw);
      if (color) entities[entities.length - 1].color = color;
      const linetype = rawLinetype(raw);
      if (linetype) entities[entities.length - 1].linetype = linetype;
      const lineweight = rawLineweight(raw);
      if (lineweight !== undefined) entities[entities.length - 1].lineweight = lineweight;
    }
  }

  // Second pass for legacy POLYLINE/VERTEX sequences.
  stitchLegacyPolylines(raws, entities, ctx.insertLayer);

  return entities;
}

export function parseDxf(text: string, options: DxfParseOptions = {}): DxfParseResult {
  const warnings: string[] = [];
  if (text.startsWith("AutoCAD Binary DXF")) {
    // X-11: a caller that decoded the bytes as text (one char per byte) can still be read; otherwise the bytes are gone.
    const bytes = new Uint8Array(text.length);
    let ok = true;
    for (let i = 0; i < text.length && ok; i++) {
      const c = text.charCodeAt(i);
      if (c > 255) ok = false;
      else bytes[i] = c;
    }
    if (ok) text = binaryDxfToText(bytes);
    else warnings.push("binary DXF arrived as text and could not be recovered — open it from its file bytes or re-save as ASCII DXF");
  }
  const allPairs = tokenize(text);
  const resolved = resolveUnits(allPairs);
  const insUnits = resolved.source === "none" ? (options.assumeUnits ?? 0) : resolved.code;
  const raws = collectRawEntities(allPairs);
  const blocks = collectBlocks(allPairs);
  const keep = (options.blocks ?? "keep") === "keep";

  const hatchSources = new Map<string, string[]>();
  const handleToId = new Map<string, string>();
  const usedIds = new Set<string>();
  const foreignRaws: RawEntity[] = [];
  const converted = convertRecords(raws, { blocks, warnings, depth: 0, stack: new Set(), keep, hatchSources, handleToId, usedIds, foreign: foreignRaws });
  // H-09: an associative HATCH follows its boundary objects only when every one of them came through as an entity.
  for (const e of converted) {
    const handles = e.type === "hatch" ? hatchSources.get(e.id) : undefined;
    if (!handles || e.type !== "hatch") continue;
    const ids = handles.map((h) => handleToId.get(h.toUpperCase()));
    if (ids.length > 0 && ids.every((x): x is string => !!x)) {
      e.associative = true;
      e.sources = ids;
    }
  }
  const entities = scaleToMm(converted, insUnits);
  const blockDefs = keep ? buildBlockDefinitions(blocks, { blocks, warnings, depth: 0, stack: new Set(), keep }, insUnits) : [];
  const sketchor = readObjects(allPairs, handleToId, warnings, new Set(entities.map((e) => e.id)));
  if (sketchor.data?.blocks) {
    for (const d of blockDefs) {
      const x = sketchor.data.blocks[d.name];
      if (!x) continue;
      if (x.explodable !== undefined) d.explodable = x.explodable;
      if (x.scaleUniformly !== undefined) d.scaleUniformly = x.scaleUniformly;
      if (x.description) d.description = x.description;
      if (x.units !== undefined) d.units = x.units;
      if (x.dynamic !== undefined) d.dynamic = x.dynamic;
      if (x.constraints) d.constraints = x.constraints;
    }
  }

  return {
    entities,
    blocks: blockDefs,
    warnings: dedupe(warnings),
    report: buildImportReport(raws),
    insUnits,
    unitSource: resolved.source,
    textStyles: collectTextStyles(allPairs, MM_PER_INSUNIT[insUnits] || 1),
    foreign: keepForeign(foreignRaws, allPairs, insUnits),
    groups: sketchor.groups,
    constraints: sketchor.data?.constraints ?? [],
    params: sketchor.data?.params ?? [],
  };
}

/** X-09: raw unsupported records (+ their CLASSES entries) as `foreign` table records. */
function keepForeign(raws: RawEntity[], pairs: Pair[], insUnits: number): ForeignRecord[] {
  if (raws.length === 0) return [];
  const classes = new Map<string, [number, string][]>();
  for (const c of collectSectionRecords(pairs, "CLASSES")) {
    if (c.type === "CLASS") classes.set(str(c, 1, "").toUpperCase(), c.pairs.map((p) => [p.code, p.value] as [number, string]));
  }
  const withClass = new Set<string>();
  // Only well-formed record names: a corrupt file's misaligned groups must not be written back as "0 \`10".
  const valid = raws.filter((r) => /^(?=.*[A-Za-z])[A-Za-z0-9][A-Za-z0-9_$]*$/.test(r.type));
  return valid.slice(0, 50000).map((raw, i) => {
    const rec: ForeignRecord = {
      name: `foreign-${i + 1}`,
      type: raw.type,
      layer: str(raw, 8, "0") || "0",
      pairs: raw.pairs.map((p) => [p.code, p.value] as [number, string]),
      units: insUnits,
    };
    const cls = classes.get(raw.type.toUpperCase());
    if (cls && !withClass.has(raw.type)) {
      withClass.add(raw.type);
      rec.cls = cls;
    }
    return rec;
  });
}

/**
 * OBJECTS section: the SKETCHOR_DATA XRECORD (X-08) and GROUP objects (X-05).
 * Exact groups from the XRECORD win (they keep ids and nesting); otherwise
 * each non-anonymous DXF GROUP with 2+ importable members becomes a group.
 * Members are checked against `entityIds`, so a group never names a ghost.
 */
function readObjects(
  pairs: Pair[],
  handleToId: Map<string, string>,
  warnings: string[],
  entityIds: Set<string>,
): { data: SketchorDocData | null; groups: Group[] } {
  const objs = collectSectionRecords(pairs, "OBJECTS");
  const nameOf = new Map<string, string>(); // object handle -> dictionary key
  for (const r of objs) {
    if (r.type !== "DICTIONARY") continue;
    for (let i = 0; i < r.pairs.length - 1; i++) {
      if (r.pairs[i].code === 3 && r.pairs[i + 1].code === 350) nameOf.set(r.pairs[i + 1].value.trim().toUpperCase(), r.pairs[i].value);
    }
  }
  let data: SketchorDocData | null = null;
  for (const r of objs) {
    if (r.type !== "XRECORD" || nameOf.get(str(r, 5, "").toUpperCase()) !== SKETCHOR_DICT_KEY) continue;
    data = decodeDocData(r.pairs.filter((p) => p.code === 1).map((p) => p.value));
    if (!data) warnings.push("the SKETCHOR data record is unreadable — groups and constraints were not restored");
  }
  if (data?.groups) {
    const groups = data.groups
      .map((g) => ({ ...g, members: g.members.filter((m) => entityIds.has(m) || data!.groups!.some((o) => o.id === m)) }))
      .filter((g) => g.members.length > 0);
    return { data, groups };
  }
  const groups: Group[] = [];
  for (const r of objs) {
    if (r.type !== "GROUP" || (num(r, 70, 0) & 1) === 1) continue;
    const ids = r.pairs.filter((p) => p.code === 340).map((p) => handleToId.get(p.value.trim().toUpperCase())).filter((x): x is string => !!x);
    const unique = [...new Set(ids)];
    if (unique.length < 2) continue;
    groups.push({ id: newGroupId(), name: nameOf.get(str(r, 5, "").toUpperCase()) || str(r, 300, "") || "Group", members: unique });
  }
  return { data, groups };
}

/** Named (non-`*`) BLOCKs → definitions in mm: ATTDEFs become attribute defs, nested INSERTs stay inserts, self-nesting is cut with a warning. */
function buildBlockDefinitions(blocks: Map<string, BlockDef>, ctx: ConvertContext, insUnits: number): BlockDefinition[] {
  const k = MM_PER_INSUNIT[insUnits] || 1;
  const defs = new Map<string, BlockDefinition>();
  for (const [name, raw] of blocks) {
    if (name.startsWith("*")) continue;
    const attributeDefs: AttributeDef[] = raw.body
      .filter((r) => r.type === "ATTDEF")
      .map((r) => {
        const flags = num(r, 70, 0);
        const prompt = str(r, 3, "");
        const def = unescapeDxfText(str(r, 1, ""));
        return {
          tag: str(r, 2, ""),
          at: { x: num(r, 10) * k, y: num(r, 20) * k },
          height: (num(r, 40, 2.5) || 2.5) * k,
          rotation: (num(r, 50, 0) * Math.PI) / 180,
          ...(prompt ? { prompt } : {}),
          ...(def ? { default: def } : {}),
          flags: { invisible: (flags & 1) !== 0, constant: (flags & 2) !== 0, verify: (flags & 4) !== 0, preset: (flags & 8) !== 0 },
        } satisfies AttributeDef;
      })
      .filter((a) => a.tag !== "");
    const body = raw.body.filter((r) => r.type !== "ATTDEF");
    const entities = convertRecords(body, { ...ctx, stack: new Set([name]) }).map((e) => (k === 1 ? e : scaleKept(e, k)));
    defs.set(name, {
      name,
      basePoint: { x: raw.base.x * k, y: raw.base.y * k },
      entities,
      attributeDefs,
      explodable: true,
      scaleUniformly: false,
    });
  }
  // A cyclic or absurdly deep nesting would make the evaluator draw nothing for it: drop the nested references and say so.
  const host = { getRecord: (_t: string, n: string) => defs.get(n), tablesRevision: 0 };
  for (const [name, def] of defs) {
    if (blockWouldCycle(host, name, def.entities)) {
      ctx.warnings.push(`block '${name}' nests itself — its nested block references were dropped`);
      defs.set(name, { ...def, entities: def.entities.filter((e) => e.type !== "insert") });
    }
  }
  return [...defs.values()];
}

const SUPPORTED_TYPES = new Set([
  "LINE",
  "CIRCLE",
  "ARC",
  "ELLIPSE",
  "LWPOLYLINE",
  "SPLINE",
  "TEXT",
  "MTEXT",
  "POLYLINE",
  "POINT",
  "INSERT",
  "SOLID",
  "TRACE",
  "3DFACE",
  "HATCH",
]);

/** Tallies raw DXF entity types into parsed/skipped buckets for the import report. */
function buildImportReport(raws: RawEntity[]): DxfImportReport {
  const counts = new Map<string, number>();
  for (const raw of raws) {
    // Records that aren't drawable geometry in the first place (POLYLINE's own
    // VERTEX/SEQEND sub-records, paper-space VIEWPORTs) aren't losses, so they
    // don't belong in either bucket.
    if (raw.type === "POLYLINE" ? false : KNOWN_IGNORED.has(raw.type)) continue;
    counts.set(raw.type, (counts.get(raw.type) ?? 0) + 1);
  }
  const parsed: { type: string; count: number }[] = [];
  const skipped: { type: string; count: number }[] = [];
  for (const [type, count] of counts) {
    (SUPPORTED_TYPES.has(type) ? parsed : skipped).push({ type, count });
  }
  parsed.sort((a, b) => a.type.localeCompare(b.type));
  skipped.sort((a, b) => b.count - a.count);
  return { parsed, skipped };
}

/**
 * Records that carry no drawable geometry, so they're skipped without a
 * warning. POLYLINE/VERTEX/SEQEND are handled by the legacy second pass;
 * VIEWPORT and paper-space layout records describe *how* a drawing is
 * presented on a sheet, not what it contains.
 */
const KNOWN_IGNORED = new Set(["SEQEND", "POLYLINE", "VERTEX", "VIEWPORT", "ATTRIB", "ATTDEF"]);

function dedupe(list: string[]): string[] {
  return [...new Set(list)];
}

function stitchLegacyPolylines(raws: RawEntity[], entities: Entity[], insertLayer?: string): void {
  let verts: Vertex[] | null = null;
  let closed = false;
  let layer = "0";
  const flush = () => {
    if (verts && verts.length > 1) {
      emitPolylineWithBulges(verts, closed && verts.length > 2, entities, layer);
    }
    verts = null;
    closed = false;
  };
  for (const raw of raws) {
    if (raw.type === "POLYLINE") {
      flush();
      verts = [];
      closed = (num(raw, 70) & 1) === 1;
      const own = str(raw, 8, "0") || "0";
      layer = own === "0" && insertLayer ? insertLayer : own;
    } else if (raw.type === "VERTEX" && verts) {
      verts.push({ x: num(raw, 10), y: num(raw, 20), bulge: num(raw, 42) });
    } else if (raw.type === "SEQEND") {
      flush();
    }
  }
  flush();
}

/* ---------------- bounds + headless SVG rendering ---------------- */

export interface Bounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export function boundsOf(entities: Entity[]): Bounds | null {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  const acc = (x: number, y: number) => {
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  };
  for (const e of entities) {
    if (e.type === "line") {
      acc(e.a.x, e.a.y);
      acc(e.b.x, e.b.y);
    } else if (e.type === "circle") {
      acc(e.center.x - e.radius, e.center.y - e.radius);
      acc(e.center.x + e.radius, e.center.y + e.radius);
    } else if (e.type === "point") {
      acc(e.p.x, e.p.y);
    } else if (e.type === "arc") {
      for (const p of arcExtentPoints(e.center, e.radius, e.startAngle, e.endAngle, e.ccw)) {
        acc(p.x, p.y);
      }
    } else if (e.type === "text") {
      for (const p of textCorners(e)) acc(p.x, p.y);
    } else if (e.type === "image") {
      for (const p of imageCorners(e)) acc(p.x, p.y);
    } else if (e.type !== "polyline") {
      // A kind outside the built-in seven: its own bounds (or its tessellation's).
      const kb = kindBounds(e);
      if (kb) {
        acc(kb.minX, kb.minY);
        acc(kb.maxX, kb.maxY);
      }
    } else {
      for (const seg of polylineSegments(e)) {
        acc(seg.a.x, seg.a.y);
        acc(seg.b.x, seg.b.y);
        const bulgeArc = bulgeToArc(seg.a, seg.b, seg.bulge);
        if (bulgeArc) {
          for (const p of arcExtentPoints(bulgeArc.center, bulgeArc.radius, bulgeArc.startAngle, bulgeArc.endAngle, bulgeArc.ccw)) {
            acc(p.x, p.y);
          }
        }
      }
    }
  }
  return Number.isFinite(minX) ? { minX, minY, maxX, maxY } : null;
}

export interface ThumbnailOptions {
  size?: number;
  stroke?: string;
  background?: string;
  padding?: number;
}

/**
 * Renders entities to a standalone SVG string that fits a `size` box.
 * Pure string output — safe under strict CSP and runnable in Node, so the
 * same code produces browser thumbnails and (later) Explorer bitmaps.
 */
export function entitiesToSvg(entities: Entity[], opts: ThumbnailOptions = {}): string {
  const size = opts.size ?? 128;
  const stroke = opts.stroke ?? "#dfe1e5";
  const background = opts.background ?? "#1e1f22";
  const pad = opts.padding ?? Math.round(size * 0.08);

  const b = boundsOf(entities);
  const body: string[] = [];

  if (b) {
    const w = Math.max(b.maxX - b.minX, 1e-6);
    const h = Math.max(b.maxY - b.minY, 1e-6);
    const scale = Math.min((size - pad * 2) / w, (size - pad * 2) / h);
    const drawW = w * scale;
    const drawH = h * scale;
    const offX = (size - drawW) / 2;
    const offY = (size - drawH) / 2;
    // World Y up -> SVG Y down.
    const sx = (x: number) => offX + (x - b.minX) * scale;
    const sy = (y: number) => offY + (b.maxY - y) * scale;
    const f = (n: number) => Math.round(n * 100) / 100;

    for (const e of entities) {
      if (e.type === "line") {
        body.push(
          `<line x1="${f(sx(e.a.x))}" y1="${f(sy(e.a.y))}" x2="${f(sx(e.b.x))}" y2="${f(sy(e.b.y))}"/>`,
        );
      } else if (e.type === "circle") {
        body.push(
          `<circle cx="${f(sx(e.center.x))}" cy="${f(sy(e.center.y))}" r="${f(e.radius * scale)}" fill="none"/>`,
        );
      } else if (e.type === "point") {
        body.push(`<circle cx="${f(sx(e.p.x))}" cy="${f(sy(e.p.y))}" r="1.5" fill="${stroke}"/>`);
      } else if (e.type === "text") {
        body.push(
          `<text x="${f(sx(e.at.x))}" y="${f(sy(e.at.y))}" font-size="${f(e.height * scale)}" fill="${stroke}">${escapeXml(e.text)}</text>`,
        );
      } else if (e.type === "image") {
        // A placeholder box, not the embedded pixels — this is a small,
        // fast preview thumbnail, not worth inflating with a base64 blob.
        const c = imageCorners(e).map((p) => ({ x: f(sx(p.x)), y: f(sy(p.y)) }));
        body.push(
          `<path d="M${c[0].x} ${c[0].y} L${c[1].x} ${c[1].y} L${c[2].x} ${c[2].y} L${c[3].x} ${c[3].y} Z M${c[0].x} ${c[0].y} L${c[2].x} ${c[2].y} M${c[1].x} ${c[1].y} L${c[3].x} ${c[3].y}" fill="none"/>`,
        );
      } else if (e.type === "arc") {
        // Tessellated for display only — the document keeps the arc as one entity.
        const sweep = arcSweep(e.startAngle, e.endAngle, e.ccw);
        const steps = Math.min(64, Math.max(2, Math.ceil((sweep / (2 * Math.PI)) * 64)));
        const d: string[] = [];
        for (let i = 0; i <= steps; i++) {
          const t = e.ccw
            ? e.startAngle + sweep * (i / steps)
            : e.startAngle - sweep * (i / steps);
          const p = arcPointAt(e.center, e.radius, t);
          d.push(`${i === 0 ? "M" : "L"}${f(sx(p.x))} ${f(sy(p.y))}`);
        }
        body.push(`<path d="${d.join(" ")}" fill="none"/>`);
      } else if (e.type === "hatch") {
        // F-04: thumbnails tint the region (even-odd, so islands stay empty) instead of drawing every pattern line.
        const art = hatchArt(e);
        if (art && art.rings.length) {
          const d = art.rings.map((ring) => ring.map((q, i) => `${i === 0 ? "M" : "L"}${f(sx(q.x))} ${f(sy(q.y))}`).join(" ") + " Z").join(" ");
          body.push(`<path d="${d}" fill="${stroke}" fill-opacity="0.28" fill-rule="evenodd" stroke="none"/>`);
        }
      } else if (e.type !== "polyline") {
        // A kind outside the built-in seven: its tessellation, drawn as open paths.
        for (const run of kindTessellate(e)) {
          if (run.length < 2) continue;
          body.push(`<path d="${run.map((p, i) => `${i === 0 ? "M" : "L"}${f(sx(p.x))} ${f(sy(p.y))}`).join(" ")}" fill="none"/>`);
        }
      } else {
        // Tessellated for display only — the document keeps each segment's true geometry (line or bulge-arc).
        const d: string[] = [];
        polylineSegments(e).forEach((seg, i) => {
          if (i === 0) d.push(`M${f(sx(seg.a.x))} ${f(sy(seg.a.y))}`);
          const bulgeArc = bulgeToArc(seg.a, seg.b, seg.bulge);
          if (!bulgeArc) {
            d.push(`L${f(sx(seg.b.x))} ${f(sy(seg.b.y))}`);
            return;
          }
          const sweep = arcSweep(bulgeArc.startAngle, bulgeArc.endAngle, bulgeArc.ccw);
          const steps = Math.min(32, Math.max(2, Math.ceil((sweep / (2 * Math.PI)) * 64)));
          for (let s = 1; s <= steps; s++) {
            const t = bulgeArc.ccw
              ? bulgeArc.startAngle + sweep * (s / steps)
              : bulgeArc.startAngle - sweep * (s / steps);
            const p = arcPointAt(bulgeArc.center, bulgeArc.radius, t);
            d.push(`L${f(sx(p.x))} ${f(sy(p.y))}`);
          }
        });
        if (e.closed) d.push("Z");
        body.push(`<path d="${d.join(" ")}" fill="none"/>`);
      }
    }
  }

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">` +
    `<rect width="${size}" height="${size}" fill="${background}"/>` +
    `<g stroke="${stroke}" stroke-width="1" fill="none" stroke-linecap="round">${body.join("")}</g>` +
    `</svg>`
  );
}

/** Convenience: DXF text straight to a thumbnail SVG string. */
export function dxfToSvg(text: string, opts: ThumbnailOptions = {}): string {
  return entitiesToSvg(parseDxf(text, { blocks: "explode" }).entities, opts);
}
