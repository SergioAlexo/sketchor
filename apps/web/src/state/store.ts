import type { TextStyle } from "@sketchor/core";
import { create } from "zustand";
import { newEntityId, type Group, type Constraint, type TableRecord, scaleBlockDefinition, scaleEntityKeepingInserts, setActiveBlocks, setActiveDimHost, blockEditChanges, blockEditDocument, getBlock, inPlaceBackdrop, instancesOf, type AttributeDef, type BlockDefinition } from "@sketchor/core";
import type { Model3D } from "../model3d/types";
import {
  displayUnitToDxfCode,
  dxfCodeToDisplayUnit,
  formatArea,
  formatLength,
  loadDisplayUnit,
  saveDisplayUnit,
  type DisplayUnit,
} from "../units";
import { formatOf, magnitudeBucket, reportError, track } from "../metrics/metrics";
import {
  CommandBus,
  DEFAULT_DUPLICATE_OPTIONS,
  DEFAULT_HEAL_OPTIONS,
  DEFAULT_LAYER,
  SketchDocument,
  centroidOfEntities,
  arcSweep,
  diffToCommands,
  dist,
  dxfToSvg,
  fixAllDuplicates,
  fixAllIssues,
  fixDuplicate,
  fixIssue,
  freeEndpointEntityIds,
  issueEntityIds,
  layerList,
  layerOf,
  layerRecordWith,
  mid,
  newGroupId,
  PALETTE,
  parseCode,
  MM_PER_INSUNIT,
  parseDxf,
  parseSvgText,
  patternCommands,
  polylineLength,
  entityLength,
  setSplineShowCvs,
  polylineSegments,
  reduceToHalfTurn,
  scanForCrossings,
  scanForDuplicates,
  scanForIssues,
  toCode,
  transformed,
  wholeGroupSelected,
  type ClosedRegion,
  type Command,
  type CrossingIssue,
  type DuplicateIssue,
  type DuplicateOptions,
  type DxfImportReport,
  type DxfParseResult,
  type DxfUnitSource,
  type Entity,
  type EntityId,
  type GroupId,
  type HealIssue,
  type HealOptions,
  type ParseIssue,
  type SvgUnits,
  type PatternSpec,
  type Point,
  syncDocPatterns,
} from "@sketchor/core";

/**
 * Multi-document sessions ("tabs"). Each open drawing gets its own
 * `SketchDocument` + `CommandBus` (so undo/redo is isolated per tab) plus
 * its own selection, layers, and viewport. `doc`/`bus` below stay as the
 * two names every other module already imports — they're now proxies that
 * always forward to the *active* session, so the rest of the app didn't
 * need to change to become multi-document aware.
 */
export interface DocSession {
  id: string;
  name: string;
  /** True once this tab has been loaded from or saved to a real file (vs. a fresh "Untitled-N"). */
  named: boolean;
  dirty: boolean;
  doc: SketchDocument;
  bus: CommandBus;
  selection: EntityId[];
  layers: Layer[];
  activeLayer: string;
  /** Saved pan/zoom, restored when this tab becomes active again; null until the viewport has set one. */
  view: { scale: number; ox: number; oy: number } | null;
  /** Display unit for this tab (e.g. from a DXF's $INSUNITS on open), restored when it becomes active again. */
  displayUnit: DisplayUnit;
  /**
   * A 3D model tab (STEP/IGES, view-only — see model3d/). While set, the
   * stage shows the 3D viewer instead of the drawing canvas; `doc` stays
   * empty and there is nothing to save. `null` with `modelLoading` means the
   * tab exists but the file is still being read.
   */
  model?: Model3D | null;
  modelLoading?: boolean;
  modelError?: string | null;
  /** B-04: set on a tab that edits a block definition of another tab (see {@link beginBlockEdit}). */
  blockEdit?: BlockEditSession;
}

/** The state of one block-editor tab: where the definition came from and what it was before editing. */
export interface BlockEditSession {
  parentId: string;
  name: string;
  /** The definition as it was when editing began — restored on Discard, and the base the Save command diffs against. */
  original: BlockDefinition;
  basePoint: { x: number; y: number };
  attributeDefs: AttributeDef[];
  unbind: () => void;
  /** Edit in place (REFEDIT): the instance the editor was opened from; the rest of the drawing is drawn faded behind the definition. */
  contextInsert?: string;
  /** Whether that faded context is shown (default on when there is a context instance). */
  showContext?: boolean;
}

/** True for a tab that shows (or is loading) a 3D model rather than a drawing. */
export function isModelSession(s: DocSession | undefined): boolean {
  return !!s && (s.model != null || !!s.modelLoading || !!s.modelError);
}

let sessionCounter = 0;
function newSessionId(): string {
  sessionCounter += 1;
  return `sess${Date.now().toString(36)}${sessionCounter.toString(36)}`;
}

function newSession(name: string): DocSession {
  const document = new SketchDocument();
  return {
    id: newSessionId(),
    name,
    named: false,
    dirty: false,
    doc: document,
    bus: new CommandBus(document),
    selection: [],
    layers: [{ name: DEFAULT_LAYER, visible: true }],
    activeLayer: DEFAULT_LAYER,
    view: null,
    displayUnit: loadDisplayUnit() ?? "mm",
  };
}

const sessions: DocSession[] = [newSession("Untitled-1")];

function activeSession(): DocSession {
  const id = useApp.getState().activeSessionId;
  return sessions.find((s) => s.id === id) ?? sessions[0];
}

/** A proxy that always forwards property access to `getTarget()`'s current value — see the module doc comment. */
function makeProxy<T extends object>(getTarget: () => T): T {
  return new Proxy({} as T, {
    get(_t, prop) {
      const target = getTarget();
      const value = Reflect.get(target as object, prop, target as object);
      return typeof value === "function" ? value.bind(target) : value;
    },
    set(_t, prop, value) {
      const target = getTarget();
      return Reflect.set(target as object, prop, value, target as object);
    },
  });
}

export const doc: SketchDocument = makeProxy(() => activeSession().doc);
export const bus: CommandBus = makeProxy(() => activeSession().bus);

/** Reads the whole drawing as sketch code. */
export function sketchToCode(): string {
  return toCode(doc);
}

/**
 * Applies edited sketch code to the drawing as one undoable step.
 * Returns parse issues instead of applying if the code is invalid.
 * This is the intended entry point for AI agents.
 */
export function applySketchCode(text: string): ParseIssue[] {
  const { entities, errors } = parseCode(text);
  if (errors.length > 0) return errors;
  const commands = diffToCommands(doc, entities);
  if (commands.length === 1) bus.execute(commands[0]);
  else if (commands.length > 1) bus.execute({ type: "batch", commands });
  return [];
}

/** Shared by every import path: replaces (or adds to) the drawing's entities as one undoable step. */
function applyImportedEntities(entities: Entity[], replace: boolean, blocks: BlockDefinition[] = [], textStyles: TextStyle[] = [], extras: { groups?: Group[]; constraints?: Constraint[]; params?: TableRecord[]; foreign?: TableRecord[] } = {}): void {
  const commands: Command[] = [];
  if (!replace) {
    // Ids restored from SKETCHOR XDATA may already exist here: an add-import gets fresh ids, and the id-keyed extras are dropped.
    entities = entities.map((e) => (doc.get(e.id) ? { ...e, id: newEntityId() } : e));
    extras = {};
  }
  if (replace) {
    const ids = doc.all().map((e) => e.id);
    if (ids.length) commands.push({ type: "delete-entities", ids });
    // A fresh file brings its own layers: what was hidden or locked in the old drawing must not carry over by name.
    for (const r of doc.records("layers")) commands.push({ type: "delete-table-record", table: "layers", name: r.name });
    for (const r of doc.records("blocks")) commands.push({ type: "delete-table-record", table: "blocks", name: r.name });
    for (const r of doc.records("textStyles")) commands.push({ type: "delete-table-record", table: "textStyles", name: r.name });
    for (const r of doc.records("params")) commands.push({ type: "delete-table-record", table: "params", name: r.name });
    for (const r of doc.records("foreign")) commands.push({ type: "delete-table-record", table: "foreign", name: r.name });
  }
  // D-01: the file's text styles; an add-import never overwrites an existing style of the same name.
  for (const s of textStyles) if (replace || !doc.hasRecord("textStyles", s.name)) commands.push({ type: "put-table-record", table: "textStyles", record: s });
  // B-07: the file's block definitions come before the inserts that name them; an existing block of the same name is never overwritten by an add-import.
  for (const b of blocks) if (replace || !doc.hasRecord("blocks", b.name)) commands.push({ type: "put-table-record", table: "blocks", record: b });
  for (const entity of entities) commands.push({ type: "add-entity", entity });
  // X-05/X-08: groups (parents before children), the `params` table and constraints a Sketchor-written DXF carries.
  for (const record of extras.params ?? []) commands.push({ type: "put-table-record", table: "params", record });
  for (const record of extras.foreign ?? []) commands.push({ type: "put-table-record", table: "foreign", record });
  for (const g of extras.groups ?? []) commands.push({ type: "group-entities", groupId: g.id, ids: g.members, name: g.name, ...(g.parent ? { parent: g.parent } : {}) });
  for (const constraint of extras.constraints ?? []) commands.push({ type: "add-constraint", constraint });
  if (commands.length === 1) bus.execute(commands[0]);
  else if (commands.length > 1) bus.execute({ type: "batch", commands });
  useApp.getState().syncLayersFromDoc(replace);
  useApp.getState().setTool("select");
  useApp.getState().requestFit();
}

/**
 * Imports already-parsed entities (SVG, DWG): replaces the drawing as one
 * undoable step and surfaces any parse warnings via the import banner.
 */
export function importEntities(entities: Entity[], warnings: string[], replace = true): { count: number } {
  applyImportedEntities(entities, replace);
  useApp.getState().setFileWarnings(warnings);
  return { count: entities.length };
}

/* -------------------------------- groups -------------------------------- */

/** Groups the current selection into a named group; requires 2+ selected entities. Returns the new group id, or null if not applicable. */
export function groupSelection(name?: string): GroupId | null {
  const { selection } = useApp.getState();
  if (selection.length < 2) return null;
  const groupId = newGroupId();
  bus.execute({ type: "group-entities", groupId, ids: selection, name: name ?? "Group" });
  useApp.getState().setSelection(selection); // keep the (now grouped) selection as-is
  return groupId;
}

/** Ungroups the current selection, if it's exactly one whole group. */
export function ungroupSelection(): boolean {
  const { selection } = useApp.getState();
  const groupId = wholeGroupSelected(doc, selection);
  if (!groupId) return false;
  bus.execute({ type: "ungroup", groupId });
  return true;
}

/**
 * The unit a DXF/DWG import was read in, shown on the import banner. A
 * guessed unit (`inferred` / `none`) comes with buttons that re-read the
 * geometry in another unit — see {@link reinterpretImportUnits}.
 */
export interface ImportUnits {
  /** `$INSUNITS` code the coordinates were read in (0 = left as-is). */
  code: number;
  source: DxfUnitSource | "user" | "svg-assumed";
  /** mm per raw file unit when that isn't an `$INSUNITS` code — an SVG read at 96 dpi. Overrides `code` when re-reading. */
  fileUnitMm?: number;
  /** Set for an overlay import: only that layer is re-read. */
  layer?: string;
}

/** `$INSUNITS` code of the active tab's display unit — what a file with no unit hint is read in, so its numbers show up exactly as written. */
function currentUnitCode(): number {
  return displayUnitToDxfCode(useApp.getState().displayUnit);
}

/**
 * Imports DXF text: replaces the drawing with the file's geometry as one
 * undoable step. Returns the entity count and any parse warnings.
 */
export function importDxfText(text: string, replace = true): { count: number; warnings: string[] } {
  return importParsedDxf(parseDxf(text, { assumeUnits: currentUnitCode() }), replace);
}

/** {@link importDxfText} for an already-parsed file. */
function importParsedDxf(result: DxfParseResult, replace: boolean): { count: number; warnings: string[] } {
  const { entities, warnings, report, insUnits, unitSource } = result;
  applyImportedEntities(entities, replace, result.blocks, result.textStyles, { groups: result.groups, constraints: result.constraints, params: result.params, foreign: result.foreign });
  useApp.getState().setImportReport(report);
  useApp.getState().setFileWarnings(warnings.filter((w) => !w.startsWith("unsupported entity")));
  useApp.getState().setImportUnits({ code: insUnits, source: unitSource });
  // The file's own unit becomes the document's saved unit; unmapped units
  // leave it as-is. Only a real open (replace) may do this — the document
  // keeps its own unit unless the user explicitly changes it (via the
  // display-unit picker) or opens a new file over it; an overlay add (see
  // overlayEntities) never reaches this branch.
  const unit = dxfCodeToDisplayUnit(insUnits);
  if (replace && unit) useApp.getState().setDisplayUnit(unit);
  return { count: entities.length, warnings };
}

/**
 * Re-reads the last import's geometry as if the file had been in `to`
 * instead of the unit it was read in — the fix for a file that didn't say
 * (or lied about) its unit. One undoable batch; a replace import also
 * switches the display unit so the numbers read the same as in the file.
 */
export function reinterpretImportUnits(to: DisplayUnit): void {
  const { importUnits } = useApp.getState();
  if (!importUnits) return;
  const toCode = displayUnitToDxfCode(to);
  const factor = (MM_PER_INSUNIT[toCode] ?? 1) / (importUnits.fileUnitMm ?? MM_PER_INSUNIT[importUnits.code] ?? 1);
  if (factor !== 1) {
    const targets = doc.all().filter((e) => importUnits.layer === undefined || layerOf(e) === importUnits.layer);
    const origin = { x: 0, y: 0 };
    const commands: Command[] = targets.map((e) => ({
      type: "update-entity",
      entity: scaleEntityKeepingInserts(e, factor),
    }));
    // Definitions live in the same unit as the geometry (B-07): scale them with it.
    if (importUnits.layer === undefined) {
      for (const r of doc.records("blocks")) commands.push({ type: "put-table-record", table: "blocks", record: scaleBlockDefinition(r as BlockDefinition, factor) });
    }
    if (commands.length) bus.execute({ type: "batch", commands });
  }
  if (importUnits.layer === undefined) useApp.getState().setDisplayUnit(to);
  useApp.getState().setImportUnits({ ...importUnits, code: toCode, source: "user", fileUnitMm: undefined });
  useApp.getState().requestFit();
}

/** Layer name for {@link overlayEntities}: `base` if free, else `base (2)`, `base (3)`, ... */
function uniqueOverlayLayerName(base: string): string {
  const used = new Set(useApp.getState().layers.map((l) => l.name));
  if (!used.has(base)) return base;
  let i = 2;
  while (used.has(`${base} (${i})`)) i += 1;
  return `${base} (${i})`;
}

/**
 * Adds entities to the current drawing on their own new layer, without
 * replacing anything — used to overlay a second file (e.g. another
 * revision of the same part) on top of the current one so the differences
 * show up visually and the overlay can be toggled or selected apart from
 * the existing geometry. Deliberately never touches `displayUnit`: unlike
 * {@link importDxfText}'s replace path, overlaying isn't "opening" a
 * document, so the document keeps whatever unit it already had.
 */
export function overlayEntities(entities: Entity[], label: string, blocks: BlockDefinition[] = []): { count: number; layer: string } {
  const layer = uniqueOverlayLayerName(label);
  const tagged = entities.map((e) => ({ ...e, layer }));
  applyImportedEntities(tagged, false, blocks);
  useApp.getState().setActiveLayer(layer);
  return { count: entities.length, layer };
}

/** DXF-specific overlay: parses `text` and adds it via {@link overlayEntities}. The file's own unit still scales its coordinates into the shared millimeter space (see dxf.ts) — only the document's own saved unit is left alone. A file with no unit hint is read in the document's unit. */
export function overlayDxfText(text: string, label: string): { count: number; warnings: string[]; layer: string } {
  const { entities, warnings, report, insUnits, unitSource } = parseDxf(text, { assumeUnits: currentUnitCode(), blocks: "explode" });
  useApp.getState().setImportReport(report);
  const added = overlayEntities(entities, label);
  useApp.getState().setImportUnits({ code: insUnits, source: unitSource, layer: added.layer });
  return { ...added, warnings };
}

/** Import report for an SVG: what was read, in the DXF report's shape (an SVG has nothing to skip that we can count). */
function svgReport(entities: Entity[]): DxfImportReport {
  const counts = new Map<string, number>();
  for (const e of entities) counts.set(e.type.toUpperCase(), (counts.get(e.type.toUpperCase()) ?? 0) + 1);
  return { parsed: [...counts].map(([type, count]) => ({ type, count })), skipped: [] };
}

/** The banner's unit record for a parsed SVG. A size the file never stated (96 dpi assumed) is amber and re-readable, like a DXF with no $INSUNITS. */
function svgImportUnits(units: SvgUnits, layer?: string): ImportUnits {
  const assumed = units.source === "assumed";
  return {
    code: assumed ? 4 : (units.insUnits ?? 4),
    source: assumed ? "svg-assumed" : "insunits",
    ...(assumed ? { fileUnitMm: units.mmPerUserUnit } : {}),
    ...(layer !== undefined ? { layer } : {}),
  };
}

/**
 * Imports SVG text: replaces the drawing (one undoable step) with geometry at
 * the size the file states — `width`/`height` against `viewBox` — or at
 * 96 dpi with an amber "Read as" banner when it states none (SV-02). A
 * declared inch/cm/mm size also becomes the tab's display unit, as a DXF's
 * `$INSUNITS` does.
 */
export function importSvgText(text: string): { count: number; warnings: string[] } {
  const { entities, warnings, units, blocks } = parseSvgText(text, { blocks: "keep" });
  applyImportedEntities(entities, true, blocks);
  useApp.getState().setImportReport(svgReport(entities));
  useApp.getState().setFileWarnings(warnings);
  useApp.getState().setImportUnits(svgImportUnits(units));
  const unit = units.source === "declared" ? dxfCodeToDisplayUnit(units.insUnits ?? 0) : null;
  if (unit) useApp.getState().setDisplayUnit(unit);
  return { count: entities.length, warnings };
}

/** SVG overlay: as {@link overlayDxfText} — the drawing keeps its own unit; only the overlay layer is re-readable. */
export function overlaySvgText(text: string, label: string): { count: number; warnings: string[]; layer: string } {
  const { entities, warnings, units, blocks } = parseSvgText(text, { blocks: "keep" });
  useApp.getState().setImportReport(svgReport(entities));
  useApp.getState().setFileWarnings(warnings);
  const added = overlayEntities(entities, label, blocks);
  useApp.getState().setImportUnits(svgImportUnits(units, added.layer));
  return { ...added, warnings };
}

/**
 * F-01: replaces the drawing with an imported EPS/AI (already parsed — see
 * io/epsImport.ts). Points are already mm; the document's unit is left as it is.
 */
export function importEpsResult(entities: Entity[], warnings: string[]): { count: number; warnings: string[] } {
  applyImportedEntities(entities, true);
  useApp.getState().setImportReport(svgReport(entities));
  useApp.getState().setFileWarnings(warnings);
  useApp.getState().setImportUnits(null);
  return { count: entities.length, warnings };
}

/** EPS/AI overlay: as {@link overlaySvgText} — the geometry goes on its own layer. */
export function overlayEpsResult(entities: Entity[], warnings: string[], label: string): { count: number; warnings: string[]; layer: string } {
  useApp.getState().setImportReport(svgReport(entities));
  useApp.getState().setFileWarnings(warnings);
  const added = overlayEntities(entities, label);
  return { ...added, warnings };
}

export type ToolId =
  | "select"
  | "line"
  | "polyline"
  | "rectangle"
  | "circle"
  | "arc"
  | "ellipse"
  | "spline"
  | "splinedit"
  | "polygon"
  | "slot"
  | "point"
  | "image"
  | "measure"
  | "straighten"
  | "fill"
  | "text"
  | "dim"
  | "pan"
  | "move"
  | "copy"
  | "rotate"
  | "scale"
  | "mirror"
  | "trim"
  | "split"
  | "fillet"
  | "chamfer"
  | "offset"
  | "zoom"
  | "divide"
  | "align"
  | "lengthen"
  | "match"
  | "stretch"
  | "block"
  | "blockbase"
  | "insert"
  | "attdef";

export const TOOL_HINTS: Record<ToolId, string> = {
  select: "Click to select (Shift adds; click again to cycle what's underneath) - drag left-to-right to window-select, right-to-left to crossing-select - Alt-drag lassos, Ctrl+Alt-drag fences - drag to move - Del deletes - G groups - U ungroups - Shift+C toggles construction",
  line: "Click start point, then click next points to chain - or type a length, 100<45, @dx,dy - F8 ortho, F10 polar - Tab draws an infinite construction line instead - Esc finishes and returns to the select tool",
  polyline: "Click each vertex - A switches to an arc leg (two clicks: through-point, end), T to a tangent arc, L back to lines - Enter or double-click to finish, C to close, Backspace undoes the last vertex",
  rectangle: "Click one corner, then the opposite corner - Tab cycles to center + corner and to three-point (rotated)",
  circle: "Click center, then a point on the circle or type the radius - Tab cycles to center-diameter, two-point, three-point, and tangent-tangent-radius (type the radius, click two entities)",
  ellipse: "Click one end of an axis, the other end, then a point at the other half-axis (or type it) - Tab cycles to center + axis end and to an elliptical arc (then click its start and end)",
  spline: "Click points the curve passes through - Tab switches to control vertices (they pull the curve) - Enter or double-click to finish, C to close, Backspace undoes the last point",
  splinedit: "Select a spline (or click one): click the curve to add a fit point / control vertex, Shift-click to remove the nearest - type rebuild N, cv or polyline [tolerance] to act on the selected splines",
  polygon: "Type the number of sides, click the center, then a vertex - Tab cycles to circumscribed (click an edge midpoint - across flats) and by edge",
  slot: "Click the two centres, then type the width or pick a point at half the width from the centreline - Tab switches to an arc slot (center, start, end, width)",
  arc: "Three-point arc: click start, end, then a point on the arc - Tab cycles to center-start-end (Shift-click for clockwise) and tangent arc (click near the end of a line or arc, then the end point)",
  point: "Click to place a point",
  image: "Click where the image goes, then pick a picture file — drops back to the select tool once it's placed",
  measure: "Click two points to measure distance (snaps to endpoints, midpoints, centers, on-line points, intersections) - Ctrl-click a line to set it as the angle reference - Alt-click a line/circle/arc for its whole length/radius, Shift-Alt-click more lines/arcs to total - click inside a closed area for its area+perimeter - Ctrl+C copies the readout",
  straighten: "Select the part with V, switch here, click the reference edge — a line or a straight polyline segment — then Enter to apply",
  fill: "Pick a colour, then click a closed shape to hatch-fill it - Alt-click removes a fill - use the panel to apply to a whole selection",
  text: "Click where the text goes and type - Enter places it, Esc cancels - double-click existing text to edit it",
  dim: "Click two points to place a linear dimension on the Dimensions layer, in the current display unit",
  pan: "Drag to pan the view - pinch with two fingers to zoom - double-tap to fit the drawing",
  move: "Select, then click a base point and a destination - or type @dx,dy or a distance - Ctrl-click the destination to copy instead",
  copy: "Select, then click a base point; every further click places another copy - Enter or Esc stops",
  rotate: "Select, then click the pivot, a reference direction and the new direction - or type the angle in degrees after the pivot - Ctrl-click copies",
  scale: "Select, then click the base point and type the factor - or pick a reference length and then its new length (pick or type) - Ctrl-click copies",
  mirror: "Select, then click two points of the mirror line (Shift or F8 for a horizontal/vertical axis) - Ctrl-click the second point to delete the original",
  trim: "Click the piece of a line, arc, circle or polyline to remove - everything visible acts as a cutting edge - Shift-click near an end to extend it to the next boundary instead",
  split: "Click a point on a line, arc, circle or polyline to cut it there into two",
  fillet: "Type a radius (0 = sharp corner join), then click two lines on the halves to keep - or click a polyline corner to round it, Enter rounds every corner of the selected polylines",
  chamfer: "Type a distance, then click two lines on the halves to keep - the corner is bevelled at that distance along each",
  offset: "Type the distance, click a line, arc, circle or polyline, then click the side the parallel copy goes on",
  zoom: "Click two corners of the area to zoom into - Shift+Z goes back to the previous view",
  divide: "Type the number of parts (or a spacing with a unit, e.g. 25mm), then click a line, arc, circle or polyline - point entities mark the divisions",
  align: "Select, then click a source point and where it goes, a second source point and where it goes - the selection moves and rotates to match (Ctrl-click the last point to scale too)",
  lengthen: "Type +5 / -5 (change), 40 (new total length) or 150% - then click a line or arc near the end to change",
  match: "Click the source entity, then every entity that should take its layer, colour and construction flag",
  block: "Select the objects first, name the block in the panel, then click its base point - the objects become one insert (or are kept / removed, per the panel)",
  insert: "Choose the block (and attribute values) in the panel, then click the insertion point - the tool stays active for more copies, Esc finishes",
  attdef: "In the block editor: set the tag in the panel, then click where the attribute text goes",
  blockbase: "Click the new base point of the block being edited - instances re-anchor to it",
  stretch: "Drag a crossing box around the ends to move (two corners), then click a base point and a destination - endpoints inside the box move, the rest stay",
};

export type StraightenAxis = "horizontal" | "vertical";
export type StraightenPivot = "center" | "edge-mid" | "edge-start";

/**
 * The pivot the straighten tool rotates the whole selection about,
 * matching the pivot-mode toggle from the spec (selection center by
 * default, or a point on the reference edge itself).
 */
function straightenPivotPoint(mode: StraightenPivot, selectionEntities: Entity[], edge: { a: Point; b: Point }): Point {
  switch (mode) {
    case "edge-mid":
      return mid(edge.a, edge.b);
    case "edge-start":
      return edge.a;
    case "center":
    default:
      return centroidOfEntities(selectionEntities);
  }
}

/**
 * The straighten tool's reference edge as a plain `{a, b}` segment — either a
 * whole line, or one straight (non-bulged) segment of a polyline, picked by
 * {@link referenceEdgeSegment} when the user clicked it. Null for anything
 * that isn't a valid straight edge (a curved polyline segment, an out-of-range
 * segment index after the polyline was edited, or any other entity type).
 */
function referenceEdgeSegmentPoints(ref: Entity, segment: number | null): { a: Point; b: Point } | null {
  if (ref.type === "line") return { a: ref.a, b: ref.b };
  if (ref.type === "polyline") {
    const segs = polylineSegments(ref);
    const s = segs[segment ?? 0];
    if (!s || s.bulge !== 0) return null;
    return { a: s.a, b: s.b };
  }
  return null;
}

/**
 * The rigid rotation the straighten tool would apply right now: one pivot,
 * one angle, for the whole selection — the smallest turn that lands the
 * reference edge on the chosen axis. Null when there's no valid reference
 * edge picked yet. Shared by the live dashed preview and the commit below.
 */
export function computeStraightenTransform(): { ids: EntityId[]; pivot: Point; rotation: number } | null {
  const { referenceEdgeId, referenceEdgeSegment, selection, straightenAxis, straightenPivot } = useApp.getState();
  if (!referenceEdgeId || !selection.includes(referenceEdgeId)) return null;
  const ref = doc.get(referenceEdgeId);
  if (!ref) return null;
  const edge = referenceEdgeSegmentPoints(ref, referenceEdgeSegment);
  if (!edge) return null;

  const selectionEntities = selection.map((id) => doc.get(id)).filter((e): e is Entity => !!e);
  if (selectionEntities.length === 0) return null;

  const currentAngle = Math.atan2(edge.b.y - edge.a.y, edge.b.x - edge.a.x);
  const target = straightenAxis === "horizontal" ? 0 : Math.PI / 2;
  const rotation = reduceToHalfTurn(target - currentAngle);
  const pivot = straightenPivotPoint(straightenPivot, selectionEntities, edge);
  return { ids: selection, pivot, rotation };
}

/**
 * Commits the straighten tool: rotates the whole current selection, as one
 * rigid body about a single pivot, by the smallest angle that lands the
 * reference edge on the chosen axis. Returns false (no-op) if there's no
 * valid reference edge to straighten against.
 */
export function applyStraighten(): boolean {
  const plan = computeStraightenTransform();
  if (!plan) return false;
  bus.execute({ type: "transform-entities", ...plan, dx: 0, dy: 0, scale: 1 });
  useApp.getState().setReferenceEdge(null);
  return true;
}

/* ------------------------------- healing -------------------------------- */

function runCommands(commands: Command[]): void {
  if (commands.length === 1) bus.execute(commands[0]);
  else if (commands.length > 1) bus.execute({ type: "batch", commands });
}

/** Re-scans the drawing for unjointed-line issues under the current tolerances. */
export function rescanHeal(): void {
  useApp.getState().setHealIssues(scanForIssues(doc, useApp.getState().healOptions));
}

/** Fixes one diagnostics-panel finding, then re-scans. */
export function fixOneHeal(issueId: string): void {
  const { healIssues, joinCollinear } = useApp.getState();
  const issue = healIssues.find((i) => i.id === issueId);
  if (!issue) return;
  runCommands(fixIssue(doc, issue, joinCollinear));
  rescanHeal();
}

/** Fixes every current finding as one undoable step, then re-scans. */
export function fixAllHeal(): void {
  const { healIssues, joinCollinear } = useApp.getState();
  runCommands(fixAllIssues(doc, healIssues, joinCollinear));
  rescanHeal();
}

/* --------------------------------- pattern -------------------------------- */

/**
 * Arrays the current selection, as one undoable step, and selects the result
 * (originals plus copies) so it can be moved or patterned again. No-op when
 * nothing is selected or the spec produces no copies.
 */
export function applyPattern(spec: PatternSpec): number {
  const { selection } = useApp.getState();
  if (selection.length === 0) return 0;
  const commands = patternCommands(doc, selection, spec);
  if (commands.length === 0) return 0;

  bus.execute({ type: "batch", commands });
  const added = commands
    .map((c) => (c.type === "add-entity" ? c.entity.id : null))
    .filter((id): id is EntityId => id !== null);
  useApp.getState().setSelection([...selection, ...added]);
  return added.length;
}

/* ---------------------------- duplicate geometry -------------------------- */

/** Re-scans the drawing for duplicate/overlapping geometry under the current tolerance, and for line crossings. */
export function rescanDuplicates(): void {
  useApp.getState().setDuplicateIssues(scanForDuplicates(doc, useApp.getState().duplicateOptions));
  useApp.getState().setCrossingIssues(scanForCrossings(doc));
}

/** Fixes one duplicates-panel finding (deletes the redundant copies), then re-scans. */
export function fixOneDuplicate(issueId: string): void {
  const issue = useApp.getState().duplicateIssues.find((i) => i.id === issueId);
  if (!issue) return;
  runCommands(fixDuplicate(issue));
  rescanDuplicates();
}

/** Fixes every current finding as one undoable step, then re-scans. */
export function fixAllDuplicatesAction(): void {
  runCommands(fixAllDuplicates(useApp.getState().duplicateIssues));
  rescanDuplicates();
}

/**
 * A live or frozen result from the measure tool. `distance` is the original
 * two-point mode (now also carrying delta X/Y); the rest cover clicking an
 * entity or a closed area directly instead of picking two points.
 */
export type MeasureResult =
  | { kind: "distance"; a: Point; b: Point }
  | { kind: "length"; ids: EntityId[]; total: number }
  | { kind: "radius"; id: EntityId; center: Point; radius: number; arcLength?: number }
  | { kind: "area"; region: ClosedRegion };

function wrapDeg(deg: number): number {
  let d = deg % 360;
  if (d <= -180) d += 360;
  if (d > 180) d -= 360;
  return d;
}

/** Plain-text rendering of a measurement (status bar readout, and what Ctrl+C copies). `referenceAngleDeg` is the measure tool's Ctrl-clicked reference edge, if any. */
export function measurementText(m: MeasureResult, unit: DisplayUnit, referenceAngleDeg: number | null = null): string {
  switch (m.kind) {
    case "distance": {
      const d = dist(m.a, m.b);
      const dx = Math.abs(m.b.x - m.a.x);
      const dy = Math.abs(m.b.y - m.a.y);
      const angle = (Math.atan2(m.b.y - m.a.y, m.b.x - m.a.x) * 180) / Math.PI;
      const angleText = referenceAngleDeg === null ? "" : `  ∠ edge ${wrapDeg(angle - referenceAngleDeg).toFixed(2)}°`;
      return `distance ${formatLength(d, unit)}  (Δx ${formatLength(dx, unit)}, Δy ${formatLength(dy, unit)})${angleText}`;
    }
    case "length":
      return m.ids.length > 1
        ? `total length ${formatLength(m.total, unit)} (${m.ids.length} entities)`
        : `length ${formatLength(m.total, unit)}`;
    case "radius":
      return (
        `radius ${formatLength(m.radius, unit)}  diameter ${formatLength(m.radius * 2, unit)}` +
        (m.arcLength !== undefined ? `  arc length ${formatLength(m.arcLength, unit)}` : "")
      );
    case "area": {
      let perimeter = 0;
      const pts = m.region.points;
      for (let i = 0; i < pts.length; i++) perimeter += dist(pts[i], pts[(i + 1) % pts.length]);
      return `area ${formatArea(m.region.area, unit)}  perimeter ${formatLength(perimeter, unit)}`;
    }
  }
}

/**
 * The natural dimension of a single entity — length for a line/polyline,
 * radius/diameter(+arc length) for a circle/arc — same shape the measure
 * tool's Alt-click ("whole entity") gesture produces. Null for entity types
 * with no natural length (text, image, point, dimension). Powers the select
 * tool's click-to-copy readout: selecting one line or circle/arc shows its
 * size without switching to the measure tool at all.
 */
export function entityMeasurement(entity: Entity): MeasureResult | null {
  switch (entity.type) {
    case "line":
      return { kind: "length", ids: [entity.id], total: dist(entity.a, entity.b) };
    case "polyline":
      return { kind: "length", ids: [entity.id], total: polylineLength(entity) };
    case "circle":
      return { kind: "radius", id: entity.id, center: entity.center, radius: entity.radius };
    case "arc":
      return {
        kind: "radius",
        id: entity.id,
        center: entity.center,
        radius: entity.radius,
        arcLength: entity.radius * arcSweep(entity.startAngle, entity.endAngle, entity.ccw),
      };
    case "ellipse":
    case "spline": {
      const total = entityLength(entity);
      return total === null ? null : { kind: "length", ids: [entity.id], total };
    }
    default:
      return null;
  }
}

/** Direction (degrees) of the measure/straighten tool's Ctrl/click-picked reference edge, or null if none/not a line. */
export function referenceEdgeAngleDeg(): number | null {
  const id = useApp.getState().referenceEdgeId;
  const edge = id ? doc.get(id) : null;
  return edge?.type === "line" ? (Math.atan2(edge.b.y - edge.a.y, edge.b.x - edge.a.x) * 180) / Math.PI : null;
}

/** A named drawing layer with visibility and lock toggles. */
export interface Layer {
  name: string;
  visible: boolean;
  /**
   * A locked layer is visible but untouchable: it can't be picked, boxed,
   * lassoed or edited, and it draws dimmed. This is how you trace over an
   * imported background without dragging it by accident.
   */
  locked?: boolean;
}

/** Names of layers currently hidden — consulted by the renderer/hit-test. */
export function hiddenLayerSet(): Set<string> {
  return new Set(useApp.getState().layers.filter((l) => !l.visible).map((l) => l.name));
}

/** Names of layers currently locked — consulted by every selection path. */
export function lockedLayerSet(): Set<string> {
  return new Set(useApp.getState().layers.filter((l) => l.locked).map((l) => l.name));
}

/** True when `entity` is on a layer that is hidden or locked, i.e. not selectable. */
export function isPickable(entity: Entity, hidden: Set<string>, locked: Set<string>): boolean {
  const layer = layerOf(entity);
  return !hidden.has(layer) && !locked.has(layer);
}

/** Every entity a click, box, lasso or fence is allowed to select right now. */
export function selectableEntities(): Entity[] {
  const hidden = hiddenLayerSet();
  const locked = lockedLayerSet();
  return doc.all().filter((e) => isPickable(e, hidden, locked));
}

/** Create-block tool settings (B-03): the definition's name/options and what happens to the selected objects. */
export interface BlockSettings {
  name: string;
  /** convert = replace the selection by one insert; retain = keep the objects, no insert; delete = remove them, no insert. */
  mode: "convert" | "retain" | "delete";
  description: string;
  explodable: boolean;
  scaleUniformly: boolean;
}

/** Insert tool settings (B-05/B-06): which block, how it is placed, and the attribute values typed into the prompt. */
export interface InsertSettings {
  block: string;
  scale: number;
  /** Degrees. */
  rotation: number;
  values: Record<string, string>;
}

export const DEFAULT_INSERT_SETTINGS: InsertSettings = { block: "", scale: 1, rotation: 0, values: {} };

/** Attribute-definition tool settings (B-05). */
export interface AttdefSettings {
  tag: string;
  prompt: string;
  default: string;
  fieldExpr: string;
  height: number;
  invisible: boolean;
  constant: boolean;
  verify: boolean;
  preset: boolean;
  multiline: boolean;
}

export const DEFAULT_ATTDEF_SETTINGS: AttdefSettings = {
  tag: "",
  prompt: "",
  default: "",
  fieldExpr: "",
  height: 2.5,
  invisible: false,
  constant: false,
  verify: false,
  preset: false,
  multiline: false,
};

export const DEFAULT_BLOCK_SETTINGS: BlockSettings = { name: "", mode: "convert", description: "", explodable: true, scaleUniformly: false };

/** Hatch tool settings: the paint, island style and how boundaries are found. */
export interface HatchSettings {
  kind: "pattern" | "solid" | "gradient";
  pattern: string;
  scale: number;
  angle: number;
  solidColor: string;
  gradientName: string;
  gradientColors: [string, string];
  gradientAngle: number;
  gradientCentered: boolean;
  gradientShift: number;
  /** 0 (opaque) .. 1 (invisible). */
  transparency: number;
  /** Fill behind a pattern; empty = none. */
  backgroundColor: string;
  style: "normal" | "outer" | "ignore";
  /** HPGAPTOL: endpoints this close count as joined (world units). */
  gapTol: number;
  /** New hatches follow their boundary entities (H-05). */
  associative: boolean;
  /** Click inside a region, pick boundary objects, or copy the paint of an existing hatch. */
  mode: "point" | "objects" | "match";
}

export const DEFAULT_HATCH_SETTINGS: HatchSettings = {
  kind: "pattern",
  pattern: "ANSI31",
  scale: 1,
  angle: 0,
  solidColor: PALETTE[0],
  gradientName: "LINEAR",
  gradientColors: ["#2f6fdb", "#ffffff"],
  gradientAngle: 0,
  gradientCentered: true,
  gradientShift: 0.3,
  transparency: 0,
  backgroundColor: "",
  style: "normal",
  gapTol: 0,
  associative: true,
  mode: "point",
};

interface AppState {
  tool: ToolId;
  selection: EntityId[];
  revision: number;
  cursor: { x: number; y: number } | null;
  zoom: number;
  measurement: MeasureResult | null;
  /** Measurements kept on screen alongside the live one (measure tool's "pin" action), newest last. */
  pinnedMeasurements: MeasureResult[];
  layers: Layer[];
  activeLayer: string;
  /** Which tab (see DocSession) is currently shown; bump `sessionsVersion` after mutating the sessions array itself. */
  activeSessionId: string;
  sessionsVersion: number;
  /** Parsed-vs-skipped tally from the most recent DXF import; null once dismissed. */
  importReport: DxfImportReport | null;
  setImportReport: (report: DxfImportReport | null) => void;
  /** The unit the most recent DXF/DWG import was read in; null once dismissed. */
  importUnits: ImportUnits | null;
  setImportUnits: (units: ImportUnits | null) => void;
  /** Warnings from the most recent SVG/DWG import (e.g. curve approximation, unreadable file); [] once dismissed. */
  fileWarnings: string[];
  setFileWarnings: (warnings: string[]) => void;
  /** The line (or polyline) entity picked as the straighten tool's reference edge (must be in `selection`). */
  referenceEdgeId: EntityId | null;
  /** Which segment of `referenceEdgeId` is the reference, when it's a polyline (unused for a plain line). */
  referenceEdgeSegment: number | null;
  straightenAxis: StraightenAxis;
  straightenPivot: StraightenPivot;
  setReferenceEdge: (id: EntityId | null, segment?: number | null) => void;
  setStraightenAxis: (axis: StraightenAxis) => void;
  setStraightenPivot: (pivot: StraightenPivot) => void;
  /** The colour the Fill/Hatch tool applies on click and the Fill panel seeds from. */
  fillColor: string;
  setFillColor: (color: string) => void;
  /** What the Hatch tool applies (H-04). */
  hatchSettings: HatchSettings;
  setHatchSettings: (patch: Partial<HatchSettings>) => void;
  /** An existing hatch being edited with the Hatch panel (double-click / Properties → Edit), optionally waiting for an origin pick (H-08). */
  hatchEdit: { id: EntityId; pickOrigin: boolean } | null;
  /** The last frame drew at least one hatch as an average-tone tint (zoomed out or too dense) — shown in the status bar. */
  hatchTinted: boolean;
  setHatchTinted: (v: boolean) => void;
  setHatchEdit: (v: { id: EntityId; pickOrigin: boolean } | null) => void;
  /** B-04: the block the active tab is editing (null in a normal drawing tab). */
  editingBlock: string | null;
  insertSettings: InsertSettings;
  setInsertSettings: (patch: Partial<InsertSettings>) => void;
  attdefSettings: AttdefSettings;
  setAttdefSettings: (patch: Partial<AttdefSettings>) => void;
  /** B-05: the insert whose attribute values the ATTEDIT dialog is editing. */
  atteditId: string | null;
  setAttedit: (id: string | null) => void;
  /** What the Create-block tool applies (B-03). */
  blockSettings: BlockSettings;
  setBlockSettings: (patch: Partial<BlockSettings>) => void;
  /** Cap height (world units / mm) for new text and dimension labels. */
  textHeight: number;
  setTextHeight: (h: number) => void;
  /** Findings from the most recent heal scan (see the Diagnostics panel). */
  healIssues: HealIssue[];
  healOptions: HealOptions;
  joinCollinear: boolean;
  /** World point the Diagnostics panel last asked the viewport to frame. */
  healFocus: Point | null;
  setHealIssues: (issues: HealIssue[]) => void;
  setHealOptions: (options: Partial<HealOptions>) => void;
  setJoinCollinear: (v: boolean) => void;
  setHealFocus: (p: Point | null) => void;
  /** Findings from the most recent duplicate/overlap scan (see the Duplicates panel). */
  duplicateIssues: DuplicateIssue[];
  duplicateOptions: DuplicateOptions;
  /** World point the Duplicates panel last asked the viewport to frame. */
  duplicateFocus: Point | null;
  setDuplicateIssues: (issues: DuplicateIssue[]) => void;
  setDuplicateOptions: (options: Partial<DuplicateOptions>) => void;
  setDuplicateFocus: (p: Point | null) => void;
  /** Read-only findings from the most recent line-crossing scan — no auto-fix (see crossings.ts). */
  crossingIssues: CrossingIssue[];
  setCrossingIssues: (issues: CrossingIssue[]) => void;
  /**
   * Outcome of the most recent save, surfaced in the status bar. Ctrl+S over
   * an already-chosen file writes with no dialog, so without this the app
   * gives no sign it did anything.
   */
  saveNotice: { kind: "saved" | "error"; message: string; at: number } | null;
  setSaveNotice: (notice: { kind: "saved" | "error"; message: string; at: number } | null) => void;
  /** The group currently "entered" for editing individual members (double-click a group, Esc to exit). */
  enteredGroupId: GroupId | null;
  setEnteredGroup: (id: GroupId | null) => void;
  /** In-app file browser (R9): left-dock panel visibility. */
  fileBrowserVisible: boolean;
  setFileBrowserVisible: (v: boolean) => void;
  /** Desktop only: a directory the file browser should auto-load (set when a file is opened from Explorer). */
  fileBrowserDesktopDir: string | null;
  setFileBrowserDesktopDir: (dir: string | null) => void;
  /**
   * R2's interim connectivity hint: colors entities with a free (unshared)
   * endpoint blue. This is NOT real constraint/DOF status — there's no
   * solver yet — so it's opt-in and off by default. See connectivity.ts.
   */
  showConnectivityHint: boolean;
  /** The docked command line (T-08), at the bottom of the drawing area. */
  commandLine: boolean;
  toggleCommandLine: () => void;
  /** Draw a glyph beside each constrained entity (T-41). */
  showConstraintGlyphs: boolean;
  /** AUTOCON (T-43): drawing tools add the constraints their snaps imply. Off by default until K-03's Sketch mode. */
  autoConstrain: boolean;
  /** T-44: tint constrained geometry by how much freedom it has left. */
  showDofColours: boolean;
  setShowDofColours: (v: boolean) => void;
  setAutoConstrain: (v: boolean) => void;
  setShowConstraintGlyphs: (v: boolean) => void;
  /** The constraint the pointer is over in the panel — its geometry is highlighted on the canvas. */
  highlightedConstraint: string | null;
  setHighlightedConstraint: (id: string | null) => void;
  setShowConnectivityHint: (v: boolean) => void;
  /** Fills detected closed loops (lines/arcs chained shut, or circles) with a translucent tint — on by default. */
  showClosedRegions: boolean;
  setShowClosedRegions: (v: boolean) => void;
  /** Also show a fit spline's control vertices as grips (a view preference; the properties panel toggles it). */
  showSplineCvs: boolean;
  setShowSplineCvs: (v: boolean) => void;
  /** Bumped whenever the viewport should zoom-to-fit (e.g. after opening a file) — Viewport watches this. */
  fitRequestId: number;
  requestFit: () => void;
  setTool: (tool: ToolId) => void;
  /** The active tool's status-bar prompt ("Specify next point"); "" when the tool has none. */
  prompt: string;
  setPrompt: (prompt: string) => void;
  setSelection: (ids: EntityId[]) => void;
  setCursor: (cursor: { x: number; y: number } | null) => void;
  setZoom: (zoom: number) => void;
  setMeasurement: (measurement: MeasureResult | null) => void;
  /** Adds the current live measurement to the pinned list (capped, drops the oldest). No-op if there's nothing live. */
  pinMeasurement: () => void;
  clearPinnedMeasurements: () => void;
  displayUnit: DisplayUnit;
  setDisplayUnit: (unit: DisplayUnit) => void;
  setActiveLayer: (name: string) => void;
  addLayer: () => void;
  deleteLayer: (name: string) => void;
  renameLayer: (from: string, to: string) => void;
  toggleLayer: (name: string) => void;
  toggleLayerLock: (name: string) => void;
  /** Rebuild the layer list from the document (used after DXF import). */
  syncLayersFromDoc: (reset?: boolean) => void;
  /** Moves every entity onto the default layer and drops all other layer definitions, as one undo step. */
  flattenLayers: () => void;
  /** Removes every layer with no entities on it (never the default layer). */
  deleteEmptyLayers: () => void;
}

/** entity with its `layer` field cleared (falls back to the default layer via layerOf). */
function withoutLayer(e: Entity): Entity {
  const { layer: _layer, ...rest } = e;
  return rest as Entity;
}

export const useApp = create<AppState>((set, get) => ({
  tool: "select",
  selection: [],
  revision: 0,
  cursor: null,
  zoom: 1,
  measurement: null,
  pinnedMeasurements: [],
  layers: [{ name: DEFAULT_LAYER, visible: true }],
  activeLayer: DEFAULT_LAYER,
  activeSessionId: sessions[0].id,
  sessionsVersion: 0,
  importReport: null,
  setImportReport: (report) => set({ importReport: report }),
  importUnits: null,
  setImportUnits: (importUnits) => set({ importUnits }),
  fileWarnings: [],
  setFileWarnings: (warnings) => set({ fileWarnings: warnings }),
  referenceEdgeId: null,
  referenceEdgeSegment: null,
  straightenAxis: "horizontal",
  straightenPivot: "center",
  setReferenceEdge: (id, segment = null) => set({ referenceEdgeId: id, referenceEdgeSegment: id ? segment : null }),
  setStraightenAxis: (axis) => set({ straightenAxis: axis }),
  setStraightenPivot: (pivot) => set({ straightenPivot: pivot }),
  fillColor: PALETTE[0],
  setFillColor: (color) => set({ fillColor: color }),
  hatchSettings: DEFAULT_HATCH_SETTINGS,
  setHatchSettings: (patch) => set((s) => ({ hatchSettings: { ...s.hatchSettings, ...patch } })),
  hatchEdit: null,
  hatchTinted: false,
  setHatchTinted: (hatchTinted) => set((s) => (s.hatchTinted === hatchTinted ? s : { hatchTinted })),
  setHatchEdit: (hatchEdit) => set({ hatchEdit }),
  editingBlock: null,
  insertSettings: DEFAULT_INSERT_SETTINGS,
  setInsertSettings: (patch) => set((s) => ({ insertSettings: { ...s.insertSettings, ...patch } })),
  attdefSettings: DEFAULT_ATTDEF_SETTINGS,
  setAttdefSettings: (patch) => set((s) => ({ attdefSettings: { ...s.attdefSettings, ...patch } })),
  atteditId: null,
  setAttedit: (id) => set({ atteditId: id }),
  blockSettings: DEFAULT_BLOCK_SETTINGS,
  setBlockSettings: (patch) => set((s) => ({ blockSettings: { ...s.blockSettings, ...patch } })),
  textHeight: 100,
  setTextHeight: (textHeight) => set({ textHeight: Math.max(1, textHeight) }),
  healIssues: [],
  healOptions: DEFAULT_HEAL_OPTIONS,
  joinCollinear: false,
  healFocus: null,
  setHealIssues: (healIssues) => set({ healIssues }),
  setHealOptions: (options) => set((s) => ({ healOptions: { ...s.healOptions, ...options } })),
  setJoinCollinear: (v) => set({ joinCollinear: v }),
  setHealFocus: (p) => set({ healFocus: p }),
  duplicateIssues: [],
  duplicateOptions: DEFAULT_DUPLICATE_OPTIONS,
  duplicateFocus: null,
  setDuplicateIssues: (duplicateIssues) => set({ duplicateIssues }),
  setDuplicateOptions: (options) => set((s) => ({ duplicateOptions: { ...s.duplicateOptions, ...options } })),
  setDuplicateFocus: (p) => set({ duplicateFocus: p }),
  crossingIssues: [],
  setCrossingIssues: (crossingIssues) => set({ crossingIssues }),
  saveNotice: null,
  setSaveNotice: (saveNotice) => set({ saveNotice }),
  enteredGroupId: null,
  setEnteredGroup: (id) => set({ enteredGroupId: id }),
  fileBrowserVisible: true,
  setFileBrowserVisible: (v) => set({ fileBrowserVisible: v }),
  fileBrowserDesktopDir: null,
  setFileBrowserDesktopDir: (dir) => set({ fileBrowserDesktopDir: dir }),
  showConnectivityHint: false,
  setShowConnectivityHint: (v) => set({ showConnectivityHint: v }),
  commandLine: false,
  toggleCommandLine: () => set((s) => ({ commandLine: !s.commandLine })),
  showConstraintGlyphs: true,
  autoConstrain: false,
  showDofColours: true,
  setShowDofColours: (v) => set({ showDofColours: v }),
  setAutoConstrain: (v) => set({ autoConstrain: v }),
  setShowConstraintGlyphs: (v) => set({ showConstraintGlyphs: v }),
  highlightedConstraint: null,
  setHighlightedConstraint: (id) => set((s) => (s.highlightedConstraint === id ? s : { highlightedConstraint: id })),
  showClosedRegions: true,
  setShowClosedRegions: (v) => set({ showClosedRegions: v }),
  showSplineCvs: false,
  setShowSplineCvs: (v) => {
    setSplineShowCvs(v);
    set({ showSplineCvs: v });
  },
  fitRequestId: 0,
  requestFit: () => set((s) => ({ fitRequestId: s.fitRequestId + 1 })),
  // Switching tools invalidates any in-progress reference-edge pick or entered group.
  setTool: (tool) => set((s) => ({ tool, referenceEdgeId: null, referenceEdgeSegment: null, enteredGroupId: null, hatchEdit: tool === "fill" ? s.hatchEdit : null })),
  prompt: "",
  setPrompt: (prompt) => set((s) => (s.prompt === prompt ? s : { prompt })),
  setSelection: (selection) => set({ selection }),
  setCursor: (cursor) => set({ cursor }),
  setZoom: (zoom) => set({ zoom }),
  setMeasurement: (measurement) => set({ measurement }),
  pinMeasurement: () =>
    set((s) => (s.measurement ? { pinnedMeasurements: [...s.pinnedMeasurements, s.measurement].slice(-5) } : s)),
  clearPinnedMeasurements: () => set({ pinnedMeasurements: [] }),
  displayUnit: loadDisplayUnit() ?? "mm",
  setDisplayUnit: (displayUnit) => {
    saveDisplayUnit(displayUnit);
    set({ displayUnit });
  },
  setActiveLayer: (name) => set({ activeLayer: name }),
  // Layers live in the document's `layers` table (Z-02); `layers` above is a
  // projection of it that syncFromBus refreshes whenever a table changes, so
  // every action here is a command — undoable, and saved with the drawing.
  addLayer: () => {
    const used = new Set(get().layers.map((l) => l.name));
    let i = 1;
    while (used.has(`layer${i}`)) i += 1;
    const name = `layer${i}`;
    bus.execute({ type: "put-table-record", table: "layers", record: layerRecordWith(doc, name, {}) });
    set({ activeLayer: name });
  },
  deleteLayer: (name) => {
    if (name === DEFAULT_LAYER) return; // the default layer is permanent
    // Deleting a layer removes the grouping, not the geometry: its entities
    // move to the default layer, and the record goes, as one undoable step
    // rather than being destroyed along with the layer.
    const commands: Command[] = doc
      .all()
      .filter((e) => layerOf(e) === name)
      .map((e) => ({ type: "update-entity", entity: withoutLayer(e) }));
    if (doc.hasRecord("layers", name)) commands.push({ type: "delete-table-record", table: "layers", name });
    if (get().activeLayer === name) set({ activeLayer: DEFAULT_LAYER });
    if (commands.length > 0) bus.execute({ type: "batch", commands });
    get().syncLayersFromDoc();
  },
  renameLayer: (from, to) => {
    const t = to.trim();
    if (from === DEFAULT_LAYER || t === "" || t === from || get().layers.some((l) => l.name === t)) return;
    const commands: Command[] = [];
    // A layer only entities mention has no record yet; rename needs one to move.
    if (!doc.hasRecord("layers", from)) commands.push({ type: "put-table-record", table: "layers", record: layerRecordWith(doc, from, {}) });
    commands.push({ type: "rename-table-record", table: "layers", from, to: t });
    // Set first: the sync that follows the command validates the active layer against the new list.
    if (get().activeLayer === from) set({ activeLayer: t });
    bus.execute({ type: "batch", commands });
  },
  toggleLayer: (name) => {
    const visible = get().layers.find((l) => l.name === name)?.visible ?? true;
    bus.execute({ type: "put-table-record", table: "layers", record: layerRecordWith(doc, name, { visible: !visible }) });
  },
  toggleLayerLock: (name) => {
    const locked = get().layers.find((l) => l.name === name)?.locked ?? false;
    bus.execute({ type: "put-table-record", table: "layers", record: layerRecordWith(doc, name, { locked: !locked }) });
    // Anything on the layer that just locked has to leave the selection, or
    // the next Delete or drag would edit what the user just protected.
    const lockedNow = lockedLayerSet();
    const selection = get().selection.filter((id) => {
      const e = doc.get(id);
      return e ? !lockedNow.has(layerOf(e)) : false;
    });
    if (selection.length !== get().selection.length) set({ selection });
  },
  syncLayersFromDoc: () => {
    const layers: Layer[] = layerList(doc);
    const activeLayer = layers.some((l) => l.name === get().activeLayer) ? get().activeLayer : DEFAULT_LAYER;
    set({ layers, activeLayer });
  },
  flattenLayers: () => {
    const commands: Command[] = doc
      .all()
      .filter((e) => layerOf(e) !== DEFAULT_LAYER)
      .map((e) => ({ type: "update-entity", entity: withoutLayer(e) }));
    for (const r of doc.records("layers")) commands.push({ type: "delete-table-record", table: "layers", name: r.name });
    set({ activeLayer: DEFAULT_LAYER });
    if (commands.length > 0) bus.execute({ type: "batch", commands });
    get().syncLayersFromDoc();
  },
  deleteEmptyLayers: () => {
    const used = new Set(doc.all().map((e) => layerOf(e)));
    const commands: Command[] = doc
      .records("layers")
      .filter((r) => r.name !== DEFAULT_LAYER && !used.has(r.name))
      .map((r) => ({ type: "delete-table-record", table: "layers", name: r.name }));
    if (commands.length > 0) bus.execute({ type: "batch", commands });
    get().syncLayersFromDoc();
  },
}));

function syncFromBus(): void {
  const session = activeSession();
  const becameDirty = !session.dirty;
  session.dirty = true;

  useApp.setState((s) => {
    const selection = s.selection.filter((id) => doc.has(id));
    return {
      revision: doc.revision,
      selection,
      // `dirty` lives on the session object, which the tab strip reads through
      // getSessions() rather than subscribing to. Bumping the version here is
      // what actually makes the unsaved-changes dot appear — without it the
      // flag flips but nothing re-renders, so an edit looked unrecorded.
      ...(becameDirty ? { sessionsVersion: s.sessionsVersion + 1 } : {}),
      // The straighten tool's reference edge must stay part of the selection;
      // the measure tool's angle-reference edge (Ctrl-click) isn't selection-bound,
      // so it only needs to still exist.
      referenceEdgeId: s.referenceEdgeId && doc.has(s.referenceEdgeId) && (s.tool === "measure" || selection.includes(s.referenceEdgeId))
        ? s.referenceEdgeId
        : null,
      referenceEdgeSegment: s.referenceEdgeId && doc.has(s.referenceEdgeId) && (s.tool === "measure" || selection.includes(s.referenceEdgeId))
        ? s.referenceEdgeSegment
        : null,
      // Drop findings that no longer make sense (their entities were edited/removed elsewhere).
      healIssues: s.healIssues.filter((issue) => issueEntityIds(issue).every((id) => doc.has(id))),
      duplicateIssues: s.duplicateIssues.filter((issue) => issue.entityIds.every((id) => doc.has(id))),
      crossingIssues: s.crossingIssues.filter((issue) => issue.entityIds.every((id) => doc.has(id))),
    };
  });
}

// After any command, undo or redo the layer list is re-projected from the
// document — a layer can appear or vanish with a table edit *or* just because
// entities moved onto or off it (undoing a layer delete). Re-set only on a real
// change, so subscribers to `layers` are not woken on every edit.
function refreshLayers(): void {
  const next = layerList(doc);
  const prev = useApp.getState().layers;
  const same =
    next.length === prev.length &&
    next.every((l, i) => l.name === prev[i].name && l.visible === prev[i].visible && !!l.locked === !!prev[i].locked);
  if (!same) useApp.getState().syncLayersFromDoc();
}

let unbindBus: (() => void) | null = null;
/** Re-subscribes the revision/selection/dirty sync to whichever session's bus is now active. */
function rebindBus(): void {
  unbindBus?.();
  syncDocPatterns(doc);
  unbindBus = bus.onChange(() => {
    syncDocPatterns(doc);
    syncFromBus();
    refreshLayers();
  });
}
rebindBus();

/* ------------------------------ document tabs ---------------------------- */

function bumpSessionsVersion(): void {
  useApp.setState((s) => ({ sessionsVersion: s.sessionsVersion + 1 }));
}

function isSessionBlank(s: DocSession): boolean {
  return s.doc.all().length === 0 && !s.dirty && !s.named && !isModelSession(s) && !s.blockEdit;
}

function nextUntitledName(): string {
  const used = new Set(sessions.filter((s) => !s.named).map((s) => s.name));
  let i = 1;
  while (used.has(`Untitled-${i}`)) i += 1;
  return `Untitled-${i}`;
}

/** All open tabs, in order. Re-read this after `sessionsVersion` changes. */
export function getSessions(): DocSession[] {
  return sessions;
}

export function getSessionView(id: string): { scale: number; ox: number; oy: number } | null {
  return sessions.find((s) => s.id === id)?.view ?? null;
}

export function setSessionView(id: string, view: { scale: number; ox: number; oy: number }): void {
  const s = sessions.find((s) => s.id === id);
  if (s) s.view = { ...view };
}

/** Switches the active tab, saving the outgoing tab's selection/layers and rebinding undo/redo sync. */
export function switchToSession(id: string): void {
  const state = useApp.getState();
  if (id === state.activeSessionId) return;
  const outgoing = sessions.find((s) => s.id === state.activeSessionId);
  if (outgoing) {
    outgoing.selection = state.selection;
    outgoing.layers = state.layers;
    outgoing.activeLayer = state.activeLayer;
    outgoing.displayUnit = state.displayUnit;
  }
  const incomingIdx = sessions.findIndex((s) => s.id === id);
  if (incomingIdx === -1) return;
  // Most-recently-used ordering: the tab being switched to moves to the front of the strip.
  const [incoming] = sessions.splice(incomingIdx, 1);
  sessions.unshift(incoming);
  useApp.setState({
    activeSessionId: id,
    selection: incoming.selection,
    activeLayer: incoming.activeLayer,
    displayUnit: incoming.displayUnit,
    revision: incoming.doc.revision,
    // Tool-scoped state doesn't carry meaning across a document switch.
    referenceEdgeId: null,
    referenceEdgeSegment: null,
    enteredGroupId: null,
    healIssues: [],
    duplicateIssues: [],
    crossingIssues: [],
    measurement: null,
    pinnedMeasurements: [],
    importReport: null,
    importUnits: null,
    editingBlock: incoming.blockEdit?.name ?? null,
  });
  rebindBus();
  setActiveBlocks(incoming.doc);
  setActiveDimHost(incoming.doc);
  useApp.getState().syncLayersFromDoc(); // the layers are the incoming document's own
  bumpSessionsVersion();
}

/** Opens a new, empty tab and switches to it. */
export function newTab(): void {
  const s = newSession(nextUntitledName());
  sessions.push(s);
  switchToSession(s.id);
  bumpSessionsVersion();
}

/** Closes a tab (prompting if it has unsaved changes); always leaves at least one tab open. */
export function closeTab(id: string): void {
  const idx = sessions.findIndex((s) => s.id === id);
  if (idx === -1) return;
  if (sessions[idx].dirty) {
    const ok = window.confirm(`"${sessions[idx].name}" has unsaved changes. Close anyway?`);
    if (!ok) return;
  }
  if (sessions[idx].blockEdit) restoreBlockOriginal(sessions[idx]);
  const wasActive = useApp.getState().activeSessionId === id;
  sessions.splice(idx, 1);
  if (sessions.length === 0) sessions.push(newSession(nextUntitledName()));
  if (wasActive) {
    // The closed session is already gone from `sessions`, so switchToSession's
    // "save the outgoing tab" step is naturally a no-op (nothing to save into).
    const next = sessions[Math.max(0, idx - 1)] ?? sessions[0];
    switchToSession(next.id);
  }
  bumpSessionsVersion();
}

/**
 * Targets a tab for opening a file into: if a tab with this name is already
 * open, switches to it and re-runs `load` there (so re-opening a file never
 * duplicates its tab — reloads it instead). Otherwise reuses the active tab
 * if it's still blank (a fresh, unmodified "Untitled" tab), else opens a new
 * one — matching Ctrl+O / desktop file-association behavior from the spec.
 */
export function openIntoSession(name: string, load: () => void): void {
  const existing = sessions.find((s) => s.named && s.name === name);
  let active: DocSession;
  if (existing) {
    switchToSession(existing.id);
    active = existing;
  } else {
    active = sessions.find((s) => s.id === useApp.getState().activeSessionId)!;
    if (!isSessionBlank(active)) {
      active = newSession(name);
      sessions.push(active);
      switchToSession(active.id);
    }
  }
  // Every drawing open converges here, so this is where it gets counted:
  // format (extension only), size bucket and how long the load took. Model
  // tabs report from openModelIntoSession once the worker has answered.
  const started = performance.now();
  try {
    load();
  } catch (err) {
    track("file_opened", { format: formatOf(name), ok: false, error_kind: err instanceof Error ? err.name : "unknown" });
    throw err;
  }
  active.name = name;
  active.named = true;
  active.dirty = false;
  bumpSessionsVersion();
  if (!isModelSession(active)) {
    track("file_opened", {
      format: formatOf(name),
      ok: true,
      entities: magnitudeBucket(active.doc.all().length),
      load_ms: Math.round(performance.now() - started),
    });
  }
}

/**
 * Opens a 3D model into a tab. The tab appears at once (so the user sees it
 * queued and can keep working elsewhere — reading a big STEP file can take a
 * while) and fills in when `loading` settles. Errors show in the tab too.
 */
export function openModelIntoSession(name: string, loading: Promise<Model3D>): void {
  let target: DocSession | undefined;
  const started = performance.now();
  const report = (ok: boolean, parts?: number) =>
    track("model_opened", {
      format: formatOf(name),
      ok,
      ...(parts !== undefined ? { parts: magnitudeBucket(parts) } : {}),
      load_ms: Math.round(performance.now() - started),
    });
  openIntoSession(name, () => {
    target = activeSession();
    // A reused tab could be an "Untitled" drawing or a re-open of this same
    // model — either way it becomes a fresh loading model tab.
    target.model = null;
    target.modelLoading = true;
    target.modelError = null;
  });
  loading.then(
    (model) => {
      if (!target) return;
      target.model = model;
      target.modelLoading = false;
      bumpSessionsVersion();
      report(true, model.parts.length);
    },
    (err: Error) => {
      if (!target) return;
      target.modelLoading = false;
      target.modelError = err?.message ?? String(err);
      bumpSessionsVersion();
      report(false);
      // The tab shows the error and nothing rethrows, so this is the only
      // place a bad STEP/IGES read (or a wasm worker crash) gets reported.
      reportError(err, "model_open", { format: formatOf(name) });
    },
  );
}

/** The active tab itself (read-only use; mutate through the helpers above). */
export function getActiveSession(): DocSession {
  return activeSession();
}

/** Marks the active tab as saved under `name` (e.g. after a successful Save-as). */
export function finishSessionSave(name: string): void {
  const active = sessions.find((s) => s.id === useApp.getState().activeSessionId);
  if (!active) return;
  active.name = name;
  active.named = true;
  active.dirty = false;
  bumpSessionsVersion();
}

// Debug handle; later this same surface becomes the AI-assistant entry
// point (an LLM proposes Command values, the user previews and accepts).
declare global {
  interface Window {
    sketchor: {
      doc: SketchDocument;
      bus: CommandBus;
      toCode: typeof sketchToCode;
      applyCode: typeof applySketchCode;
      importDxf: typeof importDxfText;
      dxfToSvg: typeof dxfToSvg;
      rescanHeal: typeof rescanHeal;
      fixAllHeal: typeof fixAllHeal;
      getHealIssues: () => HealIssue[];
      getSelection: () => EntityId[];
      getEnteredGroup: () => GroupId | null;
      newTab: typeof newTab;
      closeTab: typeof closeTab;
      switchToSession: typeof switchToSession;
      getSessions: typeof getSessions;
      /** The 3D model shown in the active tab, if it is a model tab (see model3d/). */
      getModel: () => Model3D | null;
      /** Opens STEP/IGES bytes in a viewer tab; attached by io/drawingFile.ts (it can't be imported here). */
      openModel: (name: string, buffer: ArrayBuffer) => void;
    };
  }
}
window.sketchor = {
  doc,
  bus,
  toCode: sketchToCode,
  applyCode: applySketchCode,
  importDxf: importDxfText,
  dxfToSvg,
  rescanHeal,
  fixAllHeal,
  getSelection: () => useApp.getState().selection,
  getEnteredGroup: () => useApp.getState().enteredGroupId,
  getHealIssues: () => useApp.getState().healIssues,
  newTab,
  closeTab,
  switchToSession,
  getSessions,
  getModel: () => activeSession().model ?? null,
  openModel: () => {
    throw new Error("io/drawingFile.ts not loaded yet");
  },
};

/* ------------------------------ block editor (B-04) ----------------------------- */

/** Writes the editor's current body into the parent's definition without history, so the parent tab (and every instance) is live. */
function liveSyncBlock(editor: DocSession): void {
  const be = editor.blockEdit;
  const parent = be && sessions.find((x) => x.id === be.parentId);
  if (!be || !parent) return;
  const cur = getBlock(parent.doc, be.name) ?? be.original;
  parent.doc._putRecord("blocks", { ...cur, ...blockEditChanges(editor.doc), basePoint: be.basePoint, attributeDefs: be.attributeDefs });
  parent.bus.notify();
}

function restoreBlockOriginal(editor: DocSession): void {
  const be = editor.blockEdit;
  if (!be) return;
  be.unbind();
  const parent = sessions.find((x) => x.id === be.parentId);
  if (parent) {
    parent.doc._putRecord("blocks", be.original);
    parent.bus.notify();
  }
  editor.blockEdit = undefined;
}

/** The active tab's block-edit session, if it is one. */
export function activeBlockEdit(): BlockEditSession | null {
  return activeSession().blockEdit ?? null;
}

/**
 * B-04: opens `name` for editing in its own tab — the definition in local
 * coordinates, every tool working, its own undo history. Each change is
 * mirrored into the drawing's definition at once (without history), so the
 * instances re-render live; Save collapses the session into one undoable
 * `update-block`, Discard puts the old body back.
 */
export function beginBlockEdit(name: string, contextInsert?: string): string | null {
  const parent = activeSession();
  const existing = sessions.find((x) => x.blockEdit?.parentId === parent.id && x.blockEdit.name === name);
  if (existing) {
    if (contextInsert && !existing.blockEdit!.contextInsert) {
      existing.blockEdit!.contextInsert = contextInsert;
      existing.blockEdit!.showContext = true;
    }
    switchToSession(existing.id);
    return null;
  }
  const def = getBlock(parent.doc, name);
  if (!def) return `No block named '${name}'`;
  const scratch = blockEditDocument(parent.doc, name);
  if (!scratch) return `No block named '${name}'`;
  const s: DocSession = {
    id: newSessionId(),
    name: `Block: ${name}`,
    named: false,
    dirty: false,
    doc: scratch,
    bus: new CommandBus(scratch),
    selection: [],
    layers: parent.layers,
    activeLayer: parent.activeLayer,
    view: null,
    displayUnit: parent.displayUnit,
    blockEdit: { parentId: parent.id, name, original: def, basePoint: { ...def.basePoint }, attributeDefs: def.attributeDefs.map((a) => ({ ...a })), unbind: () => {}, ...(contextInsert ?? instancesOf(parent.doc, name)[0] ? { contextInsert: contextInsert ?? instancesOf(parent.doc, name)[0], showContext: true } : {}) },
  };
  s.blockEdit!.unbind = s.bus.onChange(() => liveSyncBlock(s));
  sessions.push(s);
  switchToSession(s.id);
  useApp.getState().requestFit();
  return null;
}

let backdropCache: { key: string; parentDoc: unknown; rev: number; count: number; entities: Entity[] | null } | null = null;

/** Edit in place: the parent drawing in the edited block's local coordinates (faded context), or null when there is none / it is switched off. Cached per parent revision. */
export function blockEditBackdrop(): Entity[] | null {
  const be = activeSession().blockEdit;
  if (!be || !be.contextInsert || be.showContext === false) return null;
  const parent = sessions.find((x) => x.id === be.parentId);
  if (!parent) return null;
  const key = `${be.parentId}|${be.name}|${be.contextInsert}`;
  const rev = parent.doc.tablesRevision;
  const count = parent.doc.all().length;
  if (backdropCache && backdropCache.key === key && backdropCache.parentDoc === parent.doc && backdropCache.rev === rev && backdropCache.count === count) return backdropCache.entities;
  const entities = inPlaceBackdrop(parent.doc, be.contextInsert, be.name);
  backdropCache = { key, parentDoc: parent.doc, rev, count, entities };
  return entities;
}

/** Shows/hides the faded context of the active in-place block edit; returns the new state. */
export function toggleBlockEditContext(): boolean {
  const be = activeSession().blockEdit;
  if (!be) return false;
  be.showContext = be.showContext === false;
  useApp.setState((s) => ({ revision: s.revision + 1 }));
  return be.showContext;
}

/** Saves the active block edit as one `update-block` on the drawing it came from and closes the tab. Returns an error text when refused. */
export function saveBlockEdit(): string | null {
  const editor = activeSession();
  const be = editor.blockEdit;
  if (!be) return "Not editing a block";
  const parent = sessions.find((x) => x.id === be.parentId);
  const finish = () => {
    be.unbind();
    editor.blockEdit = undefined;
    const idx = sessions.indexOf(editor);
    if (idx >= 0) sessions.splice(idx, 1);
    if (parent) switchToSession(parent.id);
    bumpSessionsVersion();
  };
  if (!parent) {
    finish();
    return null;
  }
  const changes = { ...blockEditChanges(editor.doc), basePoint: be.basePoint, attributeDefs: be.attributeDefs };
  parent.doc._putRecord("blocks", be.original); // the command's inverse must restore the pre-edit body
  parent.bus.execute({ type: "update-block", name: be.name, changes });
  const saved = getBlock(parent.doc, be.name);
  if (!saved || saved === be.original) {
    liveSyncBlock(editor); // refused (e.g. a cycle): keep the live state and stay in the editor
    return "The block could not be saved (it would contain itself)";
  }
  parent.dirty = true;
  finish();
  return null;
}

/** Throws the active block edit away and returns to the drawing. */
export function discardBlockEdit(): void {
  const editor = activeSession();
  if (!editor.blockEdit) return;
  const parentId = editor.blockEdit.parentId;
  restoreBlockOriginal(editor);
  const idx = sessions.indexOf(editor);
  if (idx >= 0) sessions.splice(idx, 1);
  const parent = sessions.find((x) => x.id === parentId) ?? sessions[0];
  switchToSession(parent.id);
  bumpSessionsVersion();
}

/** Moves the edited block's base point (local coordinates) and mirrors it live. */
export function setBlockEditBase(p: { x: number; y: number }): void {
  const editor = activeSession();
  if (!editor.blockEdit) return;
  editor.blockEdit.basePoint = { x: p.x, y: p.y };
  liveSyncBlock(editor);
  useApp.setState((s) => ({ sessionsVersion: s.sessionsVersion + 1 }));
}

/** Replaces the edited block's attribute definitions (B-05) and mirrors them live. */
export function setBlockEditAttributes(defs: AttributeDef[]): void {
  const editor = activeSession();
  if (!editor.blockEdit) return;
  editor.blockEdit.attributeDefs = defs;
  liveSyncBlock(editor);
  useApp.setState((s) => ({ sessionsVersion: s.sessionsVersion + 1 }));
}
