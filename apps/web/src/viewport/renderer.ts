import { canvasFontFamily, layoutMText, layoutOf, resolveTextLook, type TableRecord } from "@sketchor/core";
import type { Bounds, BoxSelectMode, CanvasTokens, ClosedRegion, Entity, EntityId, Point, SketchDocument } from "@sketchor/core";
import {
  arcPointAt,
  arcSweep,
  builtinLinetype,
  bulgeToArc,
  DEFAULT_DARK,
  dist,
  entityPoints,
  gripsOf,
  insertContents,
  kindTessellate,
  layerOf,
  polylineSegments,
  resolveLinetype,
  screenDashPattern,
  transformed,
  translated,
  drawOrderOf,
} from "@sketchor/core";
import type { MeasureResult } from "../state/store";
import { gridStep, worldToScreen, type View } from "./view";
import type { Snap } from "./snapping";
import { getCachedImage } from "./imageCache";
import { beginHatchFrame, drawHatchEntity } from "./hatchRender";

/** A pending rigid transform (rotate about a pivot) previewed dashed over the real geometry. */
export interface TransformPreview {
  ids: ReadonlySet<EntityId>;
  pivot: Point;
  rotation: number;
}

export interface RenderUiState {
  selection: ReadonlySet<EntityId>;
  /** B-04 edit in place: the surrounding drawing in the edited block's local coordinates, drawn faded behind everything. */
  backdrop?: readonly Entity[] | null;
  /** Entities being drawn right now (not yet in the document) — the active tool's live preview, dashed. */
  preview: readonly Entity[];
  snap: Snap | null;
  /** Ortho/polar guide: dashed ray from the tool's anchor through the tracked point, with the angle. */
  trackingRay: { from: Point; to: Point; angleDeg: number } | null;
  /** Object-snap-tracking guides (T-20): one per alignment the cursor is riding, drawn from the acquired point. */
  trackRays: readonly { from: Point; to: Point; angleDeg: number }[];
  /** Feature points the cursor has hovered and can now track from — marked so the user knows they're live. */
  acquiredPoints: readonly Point[];
  /** The relative zero `@dx,dy` measures from when the active tool has no anchor of its own (T-08). */
  relativeZero: Point | null;
  /** Constraint marks (T-41): one per place a constraint holds, clickable in the viewport. */
  constraintGlyphs: readonly { at: Point; glyph: string; state: "normal" | "conflict" | "highlight" }[];
  /** T-44: constrained geometry's freedom — blue under-defined, red conflicting; fully defined keeps its colour. Absent/empty = off. */
  dofStates?: ReadonlyMap<EntityId, "under" | "full" | "conflict">;
  /** Live offset while dragging a selection. */
  moveOffset: { dx: number; dy: number } | null;
  /** Active measure-tool result overlay, if any. */
  measurement: MeasureResult | null;
  /** Measurements pinned to stay on screen alongside the live one, drawn dimmed. */
  pinnedMeasurements: readonly MeasureResult[];
  /** Names of layers to skip drawing. */
  hiddenLayers: ReadonlySet<string>;
  /** Locked layers: drawn, but dimmed, and never selected (see store.ts). */
  lockedLayers: ReadonlySet<string>;
  /** The straighten tool's chosen reference edge, highlighted distinctly. */
  referenceEdgeId: EntityId | null;
  /** Entity currently under the cursor (measure tool), highlighted distinctly from selection. */
  hoverId: EntityId | null;
  /** The straighten tool's live preview of the rotated selection. */
  transformPreview: TransformPreview | null;
  /** World locations of current heal-diagnostics findings. */
  healMarkers: readonly Point[];
  /** World locations of current duplicate/overlap findings. */
  duplicateMarkers: readonly Point[];
  /** World locations of current line-crossing findings (read-only — see crossings.ts). */
  crossingMarkers: readonly Point[];
  /** Dashed bbox + rotate handle shown when the selection is exactly one whole group. */
  groupHandle: { bounds: Bounds; pivot: Point } | null;
  /** While a grip is being dragged: the entity as it will be, drawn dashed over the original. */
  /** Dragged-grip preview: the entity under the cursor, plus anything the solver moved with it. */
  gripPreview: readonly Entity[];
  /**
   * R2's interim connectivity hint (opt-in, off by default): entities with a
   * free endpoint render blue. NOT real constraint/DOF status — see
   * connectivity.ts. Null when the hint is turned off.
   */
  freeEndpointIds: ReadonlySet<EntityId> | null;
  /** Live window/crossing drag-select rectangle, while dragging. */
  boxSelect: { start: Point; end: Point; mode: BoxSelectMode } | null;
  /** Live lasso (closed) or fence (open) path, while dragging one. */
  freeSelect: { points: readonly Point[]; kind: "lasso" | "fence"; mode: BoxSelectMode } | null;
  /** Boundary polygons of detected closed loops (lines/arcs chained shut, or circles) — filled with a translucent tint. */
  closedRegions: readonly (readonly Point[])[];
  /** Formats a world-unit length/area for on-canvas labels, honoring the current display unit. */
  fmtLength: (worldValue: number) => string;
  fmtArea: (worldValueSquared: number) => string;
}

/** Constraint glyph geometry — Viewport.tsx hit-tests against these same numbers. */
export const CONSTRAINT_GLYPH_SIZE = 15;
export const CONSTRAINT_GLYPH_OFFSET = { x: 11, y: -11 };

/** Must match GROUP_HANDLE_OFFSET_PX in Viewport.tsx, which hit-tests this same handle. */
const GROUP_HANDLE_OFFSET_PX = 26;

// Z-03: mutable so a theme change takes effect on the next frame without
// touching any of the ~45 call sites below. `apps/web/src/theme/themeStore.ts`
// is the only writer, via `setCanvasTheme`. Starts as `DEFAULT_DARK.canvas`
// from `@sketchor/core/theme` — the single source of truth these values used
// to be hard-coded from — so the very first frame (before the theme store's
// init effect runs) still renders today's dark theme exactly.
let COLORS: CanvasTokens = DEFAULT_DARK.canvas;

export function setCanvasTheme(tokens: CanvasTokens): void {
  COLORS = tokens;
}

/** T-44: the tint for an entity's DOF state, if any. */
function dofColour(ui: RenderUiState, id: EntityId): string | null {
  const s = ui.dofStates?.get(id);
  return s === "under" ? COLORS.dofUnder : s === "conflict" ? COLORS.dofConflict : null;
}

function fmtNum(n: number): string {
  const r = Math.round(n * 100) / 100;
  return String(Object.is(r, -0) ? 0 : r);
}

export function render(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  view: View,
  doc: SketchDocument,
  ui: RenderUiState,
): void {
  ctx.fillStyle = COLORS.bg;
  ctx.fillRect(0, 0, width, height);

  drawGrid(ctx, width, height, view);

  if (ui.closedRegions.length > 0) drawClosedRegions(ctx, view, ui.closedRegions);

  if (ui.backdrop && ui.backdrop.length > 0) {
    ctx.globalAlpha = 0.25;
    for (const e of ui.backdrop) {
      if (ui.hiddenLayers.has(layerOf(e))) continue;
      drawEntity(ctx, view, e, e.color ?? COLORS.entity, 1);
    }
    ctx.globalAlpha = 1;
  }

  beginHatchFrame();
  textStyleLookup = (name) => doc.getRecord("textStyles", name);
  const ltscale = doc.settings.ltscale ?? 1;
  const everything = doc.all();
  // H-08: lower drawOrder first (stable), so a hatch can sit behind its boundary.
  const drawList = everything.some((e) => drawOrderOf(e) !== 0) ? [...everything].sort((a, b) => drawOrderOf(a) - drawOrderOf(b)) : everything;
  for (const entity of drawList) {
    if (ui.hiddenLayers.has(layerOf(entity))) continue;
    const locked = ui.lockedLayers.has(layerOf(entity));
    const selected = ui.selection.has(entity.id);
    const isReference = entity.id === ui.referenceEdgeId;
    const isFreeEndpoint = !!ui.freeEndpointIds?.has(entity.id);
    const isHovered = !selected && !isReference && entity.id === ui.hoverId;
    const shown =
      selected && ui.moveOffset
        ? translated(entity, ui.moveOffset.dx, ui.moveOffset.dy)
        : entity;
    const color = isReference
      ? COLORS.reference
      : selected
        ? COLORS.selected
        : isHovered
          ? COLORS.hover
          : isFreeEndpoint
            ? COLORS.connectivityHint
            : dofColour(ui, entity.id) ?? (shown.color ?? COLORS.entity);
    // A locked layer is background, not geometry you are working on.
    if (locked) ctx.globalAlpha = 0.45;
    if (shown.fill) drawHatch(ctx, view, shown, shown.fill);
    drawEntity(ctx, view, shown, color, selected || isReference || isHovered ? 2 : 1.5, resolveLinetype(doc, entity), ltscale);
    if (selected) drawHandles(ctx, view, shown);
    ctx.globalAlpha = 1;
  }

  if (ui.groupHandle) drawGroupHandle(ctx, view, ui.groupHandle);

  if (ui.gripPreview.length > 0) {
    ctx.setLineDash([6, 4]);
    for (const preview of ui.gripPreview) drawEntity(ctx, view, preview, COLORS.preview, 1.5);
    ctx.setLineDash([]);
    for (const preview of ui.gripPreview) drawHandles(ctx, view, preview);
  }

  if (ui.transformPreview) {
    const { ids, pivot, rotation } = ui.transformPreview;
    ctx.setLineDash([6, 4]);
    for (const id of ids) {
      const entity = doc.get(id);
      if (!entity) continue;
      drawEntity(ctx, view, transformed(entity, pivot, 0, 0, rotation, 1), COLORS.preview, 1.5);
    }
    ctx.setLineDash([]);
  }

  if (ui.preview.length > 0) {
    ctx.setLineDash([6, 4]);
    for (const p of ui.preview) drawEntity(ctx, view, p, COLORS.preview, 1.25);
    ctx.setLineDash([]);
  }

  if (ui.trackingRay) drawTrackingRay(ctx, width, height, view, ui.trackingRay);
  for (const g of ui.constraintGlyphs) drawConstraintGlyph(ctx, view, g);
  if (ui.relativeZero) drawRelativeZero(ctx, view, ui.relativeZero);
  for (const p of ui.acquiredPoints) drawAcquiredMarker(ctx, view, p);
  for (const ray of ui.trackRays) drawTrackingRay(ctx, width, height, view, ray);

  // Drawn over the geometry, like a CAD axis icon: geometry frequently runs
  // straight through the origin, and a reference marker hidden underneath it
  // is no use.
  drawOrigin(ctx, width, height, view);

  if (ui.pinnedMeasurements.length > 0) {
    ctx.globalAlpha = 0.5;
    for (const pinned of ui.pinnedMeasurements) drawMeasurement(ctx, view, doc, pinned, ui.fmtLength, ui.fmtArea, null);
    ctx.globalAlpha = 1;
  }

  if (ui.measurement) {
    const refEdge = ui.referenceEdgeId ? doc.get(ui.referenceEdgeId) : null;
    const referenceAngleDeg =
      refEdge?.type === "line" ? (Math.atan2(refEdge.b.y - refEdge.a.y, refEdge.b.x - refEdge.a.x) * 180) / Math.PI : null;
    drawMeasurement(ctx, view, doc, ui.measurement, ui.fmtLength, ui.fmtArea, referenceAngleDeg);
  }

  for (const p of ui.healMarkers) drawHealMarker(ctx, view, p);
  for (const p of ui.duplicateMarkers) drawHealMarker(ctx, view, p, COLORS.duplicateMarker);
  for (const p of ui.crossingMarkers) drawHealMarker(ctx, view, p, COLORS.crossingMarker);

  if (ui.snap) drawSnapMarker(ctx, view, ui.snap);

  if (ui.boxSelect) drawBoxSelect(ctx, view, ui.boxSelect);
  if (ui.freeSelect) drawFreeSelect(ctx, view, ui.freeSelect);
}

/** The lasso loop (closed, tinted) or the fence stroke (open, dashed) as it is drawn. */
function drawFreeSelect(
  ctx: CanvasRenderingContext2D,
  view: View,
  path: { points: readonly Point[]; kind: "lasso" | "fence"; mode: BoxSelectMode },
): void {
  if (path.points.length < 2) return;
  const color = path.kind === "fence" ? COLORS.crossingSelect : path.mode === "window" ? COLORS.windowSelect : COLORS.crossingSelect;
  ctx.beginPath();
  const first = worldToScreen(view, path.points[0]);
  ctx.moveTo(first.x, first.y);
  for (let i = 1; i < path.points.length; i++) {
    const p = worldToScreen(view, path.points[i]);
    ctx.lineTo(p.x, p.y);
  }
  if (path.kind === "lasso") {
    ctx.closePath();
    ctx.fillStyle = color;
    ctx.globalAlpha = 0.1;
    ctx.fill();
    ctx.globalAlpha = 1;
  }
  ctx.strokeStyle = color;
  ctx.lineWidth = path.kind === "fence" ? 1.5 : 1;
  ctx.setLineDash(path.kind === "lasso" && path.mode === "window" ? [] : [5, 4]);
  ctx.stroke();
  ctx.setLineDash([]);
}

/** Window selection (blue, solid, filled) vs crossing selection (green, dashed) — the standard CAD convention. */
function drawBoxSelect(
  ctx: CanvasRenderingContext2D,
  view: View,
  box: { start: Point; end: Point; mode: BoxSelectMode },
): void {
  const a = worldToScreen(view, box.start);
  const b = worldToScreen(view, box.end);
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  const w = Math.abs(b.x - a.x);
  const h = Math.abs(b.y - a.y);
  const color = box.mode === "window" ? COLORS.windowSelect : COLORS.crossingSelect;

  ctx.fillStyle = color;
  ctx.globalAlpha = 0.1;
  ctx.fillRect(x, y, w, h);
  ctx.globalAlpha = 1;

  ctx.strokeStyle = color;
  ctx.lineWidth = 1;
  ctx.setLineDash(box.mode === "window" ? [] : [5, 4]);
  ctx.strokeRect(x + 0.5, y + 0.5, w, h);
  ctx.setLineDash([]);
}

function drawClosedRegions(ctx: CanvasRenderingContext2D, view: View, regions: readonly (readonly Point[])[]): void {
  ctx.fillStyle = COLORS.closedRegionFill;
  for (const polygon of regions) {
    if (polygon.length < 3) continue;
    ctx.beginPath();
    const p0 = worldToScreen(view, polygon[0]);
    ctx.moveTo(p0.x, p0.y);
    for (let i = 1; i < polygon.length; i++) {
      const p = worldToScreen(view, polygon[i]);
      ctx.lineTo(p.x, p.y);
    }
    ctx.closePath();
    ctx.fill();
  }
}

/**
 * Fills a closed shape (a `closed` polyline or a circle) with a 45° line hatch
 * in `fill`. Clips to the shape and strokes parallel diagonals across its
 * screen bounding box — cheap, resolution-independent, and reads as a fill
 * without hiding the geometry underneath. Open shapes are skipped by the caller.
 */
function drawHatch(ctx: CanvasRenderingContext2D, view: View, entity: Entity, fill: string): void {
  ctx.save();
  ctx.beginPath();
  if (entity.type === "circle") {
    const c = worldToScreen(view, entity.center);
    ctx.arc(c.x, c.y, entity.radius * view.scale, 0, Math.PI * 2);
  } else if (entity.type === "polyline" && entity.closed && entity.points.length >= 3) {
    const p0 = worldToScreen(view, entity.points[0]);
    ctx.moveTo(p0.x, p0.y);
    for (let i = 1; i < entity.points.length; i++) {
      const p = worldToScreen(view, entity.points[i]);
      ctx.lineTo(p.x, p.y);
    }
    ctx.closePath();
  } else {
    ctx.restore();
    return;
  }
  ctx.clip();

  const pts = entityPoints(entity).map((p) => worldToScreen(view, p));
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of pts) {
    minX = Math.min(minX, p.x);
    minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, p.x);
    maxY = Math.max(maxY, p.y);
  }
  const span = maxX - minX + (maxY - minY);
  const gap = 7;
  ctx.strokeStyle = fill;
  ctx.globalAlpha = 0.32;
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let d = -span; d <= span; d += gap) {
    ctx.moveTo(minX + d, minY);
    ctx.lineTo(minX + d + (maxY - minY), maxY);
  }
  ctx.stroke();
  ctx.restore();
}

function drawGroupHandle(
  ctx: CanvasRenderingContext2D,
  view: View,
  gh: { bounds: Bounds; pivot: Point },
): void {
  const bb = gh.bounds;
  const topLeft = worldToScreen(view, { x: bb.minX, y: bb.maxY });
  const bottomRight = worldToScreen(view, { x: bb.maxX, y: bb.minY });

  ctx.strokeStyle = COLORS.selected;
  ctx.lineWidth = 1;
  ctx.setLineDash([5, 4]);
  ctx.strokeRect(topLeft.x, topLeft.y, bottomRight.x - topLeft.x, bottomRight.y - topLeft.y);
  ctx.setLineDash([]);

  const topCenter = worldToScreen(view, { x: (bb.minX + bb.maxX) / 2, y: bb.maxY });
  const handle = { x: topCenter.x, y: topCenter.y - GROUP_HANDLE_OFFSET_PX };

  ctx.beginPath();
  ctx.moveTo(topCenter.x, topCenter.y);
  ctx.lineTo(handle.x, handle.y);
  ctx.stroke();

  ctx.beginPath();
  ctx.arc(handle.x, handle.y, 6, 0, Math.PI * 2);
  ctx.fillStyle = COLORS.selected;
  ctx.fill();
  ctx.strokeStyle = COLORS.bg;
  ctx.lineWidth = 1.5;
  ctx.stroke();
}

function drawHealMarker(ctx: CanvasRenderingContext2D, view: View, p: Point, color: string = COLORS.reference): void {
  const s = worldToScreen(view, p);
  ctx.strokeStyle = color;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.arc(s.x, s.y, 7, 0, Math.PI * 2);
  ctx.moveTo(s.x - 4, s.y - 4);
  ctx.lineTo(s.x + 4, s.y + 4);
  ctx.moveTo(s.x + 4, s.y - 4);
  ctx.lineTo(s.x - 4, s.y + 4);
  ctx.stroke();
}

function drawMeasurement(
  ctx: CanvasRenderingContext2D,
  view: View,
  doc: SketchDocument,
  m: MeasureResult,
  fmtLength: (n: number) => string,
  fmtArea: (n: number) => string,
  referenceAngleDeg: number | null,
): void {
  switch (m.kind) {
    case "distance":
      drawDistanceMeasurement(ctx, view, m.a, m.b, fmtLength, referenceAngleDeg);
      break;
    case "length":
      drawLengthMeasurement(ctx, view, doc, m, fmtLength);
      break;
    case "radius":
      drawRadiusMeasurement(ctx, view, m, fmtLength);
      break;
    case "area":
      drawAreaMeasurement(ctx, view, m.region, fmtLength, fmtArea);
      break;
  }
}

/** A small rounded pill, one or more lines of text, centered at a screen point. */
function drawLabel(ctx: CanvasRenderingContext2D, cx: number, cy: number, lines: string[]): void {
  ctx.font = "12px 'Segoe UI', system-ui, sans-serif";
  ctx.textBaseline = "middle";
  ctx.textAlign = "center";
  const padX = 7;
  const lineH = 15;
  const w = Math.max(...lines.map((l) => ctx.measureText(l).width)) + padX * 2;
  const h = lineH * lines.length + 6;

  ctx.fillStyle = COLORS.measureLabelBg;
  ctx.strokeStyle = COLORS.measure;
  ctx.lineWidth = 1;
  roundRect(ctx, cx - w / 2, cy - h / 2, w, h, 5);
  ctx.fill();
  ctx.stroke();

  ctx.fillStyle = COLORS.measure;
  const top = cy - h / 2 + lineH / 2 + 3;
  lines.forEach((line, i) => ctx.fillText(line, cx, top + i * lineH));
  ctx.textAlign = "start";
  ctx.textBaseline = "alphabetic";
}

/** Normalizes a difference of two degree angles to (-180, 180]. */
function wrapDeg(deg: number): number {
  let d = deg % 360;
  if (d <= -180) d += 360;
  if (d > 180) d -= 360;
  return d;
}

function drawDistanceMeasurement(
  ctx: CanvasRenderingContext2D,
  view: View,
  wa: Point,
  wb: Point,
  fmtLength: (n: number) => string,
  referenceAngleDeg: number | null,
): void {
  const a = worldToScreen(view, wa);
  const b = worldToScreen(view, wb);

  ctx.strokeStyle = COLORS.measure;
  ctx.fillStyle = COLORS.measure;
  ctx.lineWidth = 1.5;
  ctx.setLineDash([5, 4]);
  ctx.beginPath();
  ctx.moveTo(a.x, a.y);
  ctx.lineTo(b.x, b.y);
  ctx.stroke();
  ctx.setLineDash([]);

  for (const p of [a, b]) {
    ctx.beginPath();
    ctx.arc(p.x, p.y, 3, 0, Math.PI * 2);
    ctx.fill();
  }

  const d = dist(wa, wb);
  if (d < 1e-9) return;

  // World Y grows upward, so negate dy for a screen-consistent angle.
  const angle = (Math.atan2(wb.y - wa.y, wb.x - wa.x) * 180) / Math.PI;
  const dx = Math.abs(wb.x - wa.x);
  const dy = Math.abs(wb.y - wa.y);
  const cx = (a.x + b.x) / 2;
  const cy = (a.y + b.y) / 2 - 18;
  const angleLine =
    referenceAngleDeg === null
      ? `${fmtLength(d)}  ${fmtNum(angle)}°`
      : `${fmtLength(d)}  ${fmtNum(angle)}°  (∠ edge ${fmtNum(wrapDeg(angle - referenceAngleDeg))}°)`;
  drawLabel(ctx, cx, cy, [angleLine, `Δx ${fmtLength(dx)}  Δy ${fmtLength(dy)}`]);
}

function drawLengthMeasurement(
  ctx: CanvasRenderingContext2D,
  view: View,
  doc: SketchDocument,
  m: Extract<MeasureResult, { kind: "length" }>,
  fmtLength: (n: number) => string,
): void {
  let lastMid: Point | null = null;
  for (const id of m.ids) {
    const entity = doc.get(id);
    if (!entity || (entity.type !== "line" && entity.type !== "arc" && entity.type !== "polyline")) continue;
    drawEntity(ctx, view, entity, COLORS.measure, 3);
    if (entity.type === "line") {
      lastMid = worldToScreen(view, { x: (entity.a.x + entity.b.x) / 2, y: (entity.a.y + entity.b.y) / 2 });
    } else if (entity.type === "arc") {
      const sweep = arcSweep(entity.startAngle, entity.endAngle, entity.ccw);
      const midAngle = entity.ccw ? entity.startAngle + sweep / 2 : entity.startAngle - sweep / 2;
      lastMid = worldToScreen(view, arcPointAt(entity.center, entity.radius, midAngle));
    } else {
      // Label near the middle vertex — good enough to sit on the run without extra arc-length math.
      lastMid = worldToScreen(view, entity.points[Math.floor(entity.points.length / 2)]);
    }
  }
  if (!lastMid) return;
  const label =
    m.ids.length > 1 ? `Total ${fmtLength(m.total)}  (${m.ids.length} entities)` : `Length ${fmtLength(m.total)}`;
  drawLabel(ctx, lastMid.x, lastMid.y - 14, [label]);
}

function drawRadiusMeasurement(
  ctx: CanvasRenderingContext2D,
  view: View,
  m: Extract<MeasureResult, { kind: "radius" }>,
  fmtLength: (n: number) => string,
): void {
  const c = worldToScreen(view, m.center);
  const edge = worldToScreen(view, { x: m.center.x + m.radius, y: m.center.y });

  ctx.strokeStyle = COLORS.measure;
  ctx.fillStyle = COLORS.measure;
  ctx.lineWidth = 1.5;
  ctx.setLineDash([5, 4]);
  ctx.beginPath();
  ctx.moveTo(c.x, c.y);
  ctx.lineTo(edge.x, edge.y);
  ctx.stroke();
  ctx.setLineDash([]);

  ctx.beginPath();
  ctx.arc(c.x, c.y, 3, 0, Math.PI * 2);
  ctx.fill();

  const lines = [`R ${fmtLength(m.radius)}   Ø ${fmtLength(m.radius * 2)}`];
  if (m.arcLength !== undefined) lines.push(`Arc length ${fmtLength(m.arcLength)}`);
  drawLabel(ctx, (c.x + edge.x) / 2, (c.y + edge.y) / 2 - 14, lines);
}

function perimeterOf(points: readonly Point[]): number {
  let total = 0;
  for (let i = 0; i < points.length; i++) {
    total += dist(points[i], points[(i + 1) % points.length]);
  }
  return total;
}

function drawAreaMeasurement(
  ctx: CanvasRenderingContext2D,
  view: View,
  region: ClosedRegion,
  fmtLength: (n: number) => string,
  fmtArea: (n: number) => string,
): void {
  if (region.points.length < 3) return;
  ctx.fillStyle = COLORS.measure;
  ctx.globalAlpha = 0.18;
  ctx.beginPath();
  const p0 = worldToScreen(view, region.points[0]);
  ctx.moveTo(p0.x, p0.y);
  let cx = p0.x;
  let cy = p0.y;
  for (let i = 1; i < region.points.length; i++) {
    const p = worldToScreen(view, region.points[i]);
    ctx.lineTo(p.x, p.y);
    cx += p.x;
    cy += p.y;
  }
  ctx.closePath();
  ctx.fill();
  ctx.globalAlpha = 1;
  cx /= region.points.length;
  cy /= region.points.length;
  drawLabel(ctx, cx, cy, [`Area ${fmtArea(region.area)}`, `Perimeter ${fmtLength(perimeterOf(region.points))}`]);
}

function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): void {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function drawGrid(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  view: View,
): void {
  const step = gridStep(view.scale);
  const left = -view.ox / view.scale;
  const right = (width - view.ox) / view.scale;
  const bottom = (view.oy - height) / view.scale;
  const top = view.oy / view.scale;

  const startX = Math.floor(left / step) * step;
  const startY = Math.floor(bottom / step) * step;

  ctx.lineWidth = 1;
  for (let wx = startX, i = Math.round(startX / step); wx <= right; wx += step, i++) {
    const sx = Math.round(wx * view.scale + view.ox) + 0.5;
    ctx.strokeStyle = wx === 0 ? COLORS.axis : i % 5 === 0 ? COLORS.gridMajor : COLORS.gridMinor;
    ctx.beginPath();
    ctx.moveTo(sx, 0);
    ctx.lineTo(sx, height);
    ctx.stroke();
  }
  for (let wy = startY, i = Math.round(startY / step); wy <= top; wy += step, i++) {
    const sy = Math.round(-wy * view.scale + view.oy) + 0.5;
    ctx.strokeStyle = wy === 0 ? COLORS.axis : i % 5 === 0 ? COLORS.gridMajor : COLORS.gridMinor;
    ctx.beginPath();
    ctx.moveTo(0, sy);
    ctx.lineTo(width, sy);
    ctx.stroke();
  }
}

/**
 * The world origin: a small crosshair with labelled +X/+Y axis stubs, so
 * "where is 0,0" is answerable at a glance and snapping to it has something
 * visible to aim at. Drawn at a fixed screen size, and clamped to the edge of
 * the viewport with a muted marker when the origin is panned off-screen so it
 * still reads as a direction rather than disappearing.
 */
function drawOrigin(ctx: CanvasRenderingContext2D, width: number, height: number, view: View): void {
  const o = worldToScreen(view, { x: 0, y: 0 });
  const onScreen = o.x >= 0 && o.x <= width && o.y >= 0 && o.y <= height;

  if (!onScreen) {
    const x = Math.max(8, Math.min(width - 8, o.x));
    const y = Math.max(8, Math.min(height - 8, o.y));
    ctx.strokeStyle = COLORS.originOff;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(x, y, 4, 0, Math.PI * 2);
    ctx.stroke();
    return;
  }

  const AXIS = 26;
  ctx.lineWidth = 1.5;

  // +X to the right, +Y upward (screen Y is flipped).
  ctx.strokeStyle = COLORS.axisX;
  ctx.beginPath();
  ctx.moveTo(o.x, o.y);
  ctx.lineTo(o.x + AXIS, o.y);
  ctx.stroke();

  ctx.strokeStyle = COLORS.axisY;
  ctx.beginPath();
  ctx.moveTo(o.x, o.y);
  ctx.lineTo(o.x, o.y - AXIS);
  ctx.stroke();

  ctx.strokeStyle = COLORS.origin;
  ctx.beginPath();
  ctx.arc(o.x, o.y, 3.5, 0, Math.PI * 2);
  ctx.stroke();

  ctx.font = "10px 'Segoe UI', system-ui, sans-serif";
  ctx.textBaseline = "middle";
  ctx.fillStyle = COLORS.axisX;
  ctx.fillText("X", o.x + AXIS + 3, o.y);
  ctx.fillStyle = COLORS.axisY;
  ctx.textAlign = "center";
  ctx.fillText("Y", o.x, o.y - AXIS - 7);
  ctx.textAlign = "start";
  ctx.fillStyle = COLORS.origin;
  ctx.fillText("0, 0", o.x + 7, o.y + 10);
  ctx.textBaseline = "alphabetic";
}

/** D-01: set at the start of each frame so `drawEntity` (which has no document) can resolve a text's style. */
let textStyleLookup: ((name: string) => TableRecord | undefined) | undefined;

function drawEntity(
  ctx: CanvasRenderingContext2D,
  view: View,
  entity: Entity,
  color: string,
  lineWidth: number,
  // Z-04: BYLAYER-resolved by the caller when it has a document to resolve
  // against (the main loop); other callers (tool previews, grip previews,
  // the measure overlay) draw transient, document-less entities and just
  // fall back to the entity's own linetype — BYLAYER there would have
  // nothing to resolve against anyway.
  linetypeName: string | undefined = entity.linetype,
  ltscale = 1,
): void {
  ctx.strokeStyle = color;
  ctx.lineWidth = lineWidth;

  if (entity.type === "insert") {
    // B-01: draw what the block stands for; a sub-entity keeps its own colour unless the instance is highlighted.
    const plain = color === (entity.color ?? COLORS.entity);
    for (const part of insertContents(entity)) {
      if (part.fill) drawHatch(ctx, view, part, part.fill);
      drawEntity(ctx, view, part, plain ? (part.color ?? color) : color, lineWidth, part.linetype ?? linetypeName, ltscale);
    }
    return;
  }

  if (entity.type === "hatch") {
    drawHatchEntity(ctx, view, entity, color, lineWidth);
    return;
  }

  if (entity.type === "text") {
    const p = worldToScreen(view, entity.at);
    ctx.save();
    ctx.translate(p.x, p.y);
    ctx.rotate(-entity.rotation); // world CCW → screen CW
    ctx.fillStyle = color;
    // D-01: the named style's font/shape, with the entity's own overrides on top.
    const look = resolveTextLook(entity, textStyleLookup);
    ctx.textBaseline = entity.valign === "middle" ? "middle" : entity.valign === "top" ? "top" : entity.valign === "bottom" ? "bottom" : "alphabetic";
    ctx.textAlign = entity.halign ?? "left";
    ctx.font = `${Math.max(1, entity.height * view.scale)}px ${canvasFontFamily(look.font)}`;
    if (look.oblique) ctx.transform(1, 0, -Math.tan((look.oblique * Math.PI) / 180), 1, 0, 0);
    if (look.widthFactor !== 1 || look.backwards || look.upsideDown) {
      ctx.scale(look.widthFactor * (look.backwards ? -1 : 1), look.upsideDown ? -1 : 1);
    }
    ctx.fillText(entity.text, 0, 0);
    ctx.restore();
    return;
  }

  if (entity.type === "mtext") {
    // D-04: the same layout the exporters use (core mtext/layout.ts) - runs at baseline positions, rules as segments.
    const lay = layoutMText(entity);
    if (entity.background) {
      ctx.fillStyle = entity.background.color ?? COLORS.bg;
      ctx.beginPath();
      lay.box.forEach((pt, i) => {
        const s = worldToScreen(view, pt);
        if (i === 0) ctx.moveTo(s.x, s.y);
        else ctx.lineTo(s.x, s.y);
      });
      ctx.closePath();
      ctx.fill();
    }
    const look = resolveTextLook({ style: entity.style } as never, textStyleLookup);
    ctx.textBaseline = "alphabetic";
    ctx.textAlign = "left";
    for (const r of lay.runs) {
      const p = worldToScreen(view, r.at);
      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.rotate(-r.rotation);
      ctx.fillStyle = r.color && r.color.startsWith("#") ? r.color : color;
      const family = r.font && !/^sketchor/i.test(r.font) ? `"${r.font}", ${canvasFontFamily(look.font)}` : canvasFontFamily(look.font);
      ctx.font = `${r.italic ? "italic " : ""}${r.bold ? "bold " : ""}${Math.max(1, r.height * view.scale)}px ${family}`;
      const wf = (r.widthFactor ?? 1) * look.widthFactor;
      if (wf !== 1) ctx.scale(wf, 1);
      ctx.fillText(r.text, 0, 0);
      ctx.restore();
    }
    ctx.strokeStyle = color;
    ctx.lineWidth = Math.max(1, entity.height * view.scale * 0.06);
    ctx.setLineDash([]);
    for (const seg of lay.lines) {
      ctx.beginPath();
      seg.forEach((pt, i) => {
        const s = worldToScreen(view, pt);
        if (i === 0) ctx.moveTo(s.x, s.y);
        else ctx.lineTo(s.x, s.y);
      });
      ctx.stroke();
    }
    return;
  }

  if (entity.type === "dimension") {
    // D-02a: the same layout the exporters use (core dimensions/layout.ts) — strokes, filled arrow heads, centred text.
    const layout = layoutOf(entity);
    ctx.strokeStyle = color;
    ctx.fillStyle = color;
    ctx.lineWidth = lineWidth;
    ctx.setLineDash([]);
    for (const run of layout.lines) {
      ctx.beginPath();
      run.forEach((pt, i) => {
        const s = worldToScreen(view, pt);
        if (i === 0) ctx.moveTo(s.x, s.y);
        else ctx.lineTo(s.x, s.y);
      });
      ctx.stroke();
    }
    for (const poly of layout.fills) {
      ctx.beginPath();
      poly.forEach((pt, i) => {
        const s = worldToScreen(view, pt);
        if (i === 0) ctx.moveTo(s.x, s.y);
        else ctx.lineTo(s.x, s.y);
      });
      ctx.closePath();
      ctx.fill();
    }
    if (layout.text && layout.text.text) {
      const p = worldToScreen(view, layout.text.at);
      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.rotate(-layout.text.rotation);
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.font = `${Math.max(1, layout.text.height * view.scale)}px ui-sans-serif, system-ui, sans-serif`;
      ctx.fillText(layout.text.text, 0, 0);
      ctx.restore();
    }
    return;
  }

  if (entity.type === "image") {
    const p = worldToScreen(view, entity.insert);
    const w = entity.width * view.scale;
    const h = entity.height * view.scale;
    ctx.save();
    ctx.translate(p.x, p.y);
    ctx.rotate(-entity.rotation); // world CCW → screen CW
    const img = getCachedImage(entity.dataUrl);
    if (img) {
      // `insert` is the bottom-left corner; canvas Y grows down, so the image
      // spans upward (negative local y) from the origin.
      ctx.drawImage(img, 0, -h, w, h);
    } else {
      ctx.strokeStyle = color;
      ctx.setLineDash([4, 3]);
      ctx.strokeRect(0, -h, w, h);
      ctx.setLineDash([]);
    }
    ctx.restore();
    return;
  }

  // Infinite construction lines always draw dashed, regardless of linetype — they're a drawing aid, not real geometry.
  ctx.setLineDash(
    entity.type === "line" && entity.infinite ? [6, 4] : screenDashPattern(builtinLinetype(linetypeName).pattern, ltscale, view.scale),
  );
  ctx.beginPath();
  if (entity.type === "line") {
    let a = worldToScreen(view, entity.a);
    let b = worldToScreen(view, entity.b);
    if (entity.infinite) {
      // Extend far past any screen the canvas could be; the browser clips the rest.
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const l = Math.hypot(dx, dy) || 1;
      const reach = 1e5;
      const ux = (dx / l) * reach;
      const uy = (dy / l) * reach;
      a = { x: a.x - ux, y: a.y - uy };
      b = { x: b.x + ux, y: b.y + uy };
    }
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
  } else if (entity.type === "circle") {
    const c = worldToScreen(view, entity.center);
    ctx.arc(c.x, c.y, entity.radius * view.scale, 0, Math.PI * 2);
  } else if (entity.type === "point") {
    // Fixed screen size regardless of zoom, like a CAD PDMODE marker.
    const p = worldToScreen(view, entity.p);
    ctx.moveTo(p.x - 5, p.y);
    ctx.lineTo(p.x + 5, p.y);
    ctx.moveTo(p.x, p.y - 5);
    ctx.lineTo(p.x, p.y + 5);
  } else if (entity.type === "arc") {
    // World angles increase CCW in a Y-up plane; screen Y is flipped, so
    // angles negate and the sweep direction flips (canvas's own
    // "counterclockwise" flag already matches our ccw once negated).
    const c = worldToScreen(view, entity.center);
    ctx.arc(c.x, c.y, entity.radius * view.scale, -entity.startAngle, -entity.endAngle, entity.ccw);
  } else if (entity.type !== "polyline") {
    // A kind outside the built-in seven (kinds/registry.ts): its tessellation to ~half a pixel.
    for (const run of kindTessellate(entity, 0.5 / view.scale)) {
      run.forEach((q, i) => {
        const p = worldToScreen(view, q);
        if (i === 0) ctx.moveTo(p.x, p.y);
        else ctx.lineTo(p.x, p.y);
      });
    }
  } else {
    // One continuous stroke through every vertex; a bulged segment draws as
    // its real arc rather than the straight chord.
    polylineSegments(entity).forEach((seg, i) => {
      const a = worldToScreen(view, seg.a);
      if (i === 0) ctx.moveTo(a.x, a.y);
      const bulgeArc = bulgeToArc(seg.a, seg.b, seg.bulge);
      if (!bulgeArc) {
        const b = worldToScreen(view, seg.b);
        ctx.lineTo(b.x, b.y);
        return;
      }
      const c = worldToScreen(view, bulgeArc.center);
      ctx.arc(c.x, c.y, bulgeArc.radius * view.scale, -bulgeArc.startAngle, -bulgeArc.endAngle, bulgeArc.ccw);
    });
    if (entity.closed) ctx.closePath();
  }
  ctx.stroke();
  ctx.setLineDash([]);
}

/** Grips (T-27): a filled square per handle; midpoint/center grips are hollow so they read as "move", not "stretch". */
function drawHandles(ctx: CanvasRenderingContext2D, view: View, entity: Entity): void {
  ctx.fillStyle = COLORS.handle;
  ctx.strokeStyle = COLORS.handle;
  ctx.lineWidth = 1.5;
  const grips = gripsOf(entity);
  for (const g of grips) {
    const s = worldToScreen(view, g.point);
    if (g.kind === "tangent" && entity.type === "spline" && entity.fitPoints) {
      // A tangent handle hangs off its end by a thin line and reads as a round knob.
      const fit = entity.fitPoints;
      const from = worldToScreen(view, g.index === 0 ? fit[0] : fit[fit.length - 1]);
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(from.x, from.y);
      ctx.lineTo(s.x, s.y);
      ctx.stroke();
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(s.x, s.y, 4, 0, Math.PI * 2);
      ctx.fill();
    } else if (g.kind === "rotate" && entity.type === "insert") {
      // Rotation handle: a round knob on a thin line back to the insertion point.
      const from = worldToScreen(view, entity.insert);
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(from.x, from.y);
      ctx.lineTo(s.x, s.y);
      ctx.stroke();
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(s.x, s.y, 4, 0, Math.PI * 2);
      ctx.fill();
    } else if (g.kind === "cv") {
      ctx.strokeRect(s.x - 3, s.y - 3, 6, 6); // a hollow, smaller square: pulls the curve, is not on it
    } else if (g.kind === "mid" || g.kind === "center") ctx.strokeRect(s.x - 3.5, s.y - 3.5, 7, 7);
    else ctx.fillRect(s.x - 3.5, s.y - 3.5, 7, 7);
  }
}

function drawSnapMarker(ctx: CanvasRenderingContext2D, view: View, snap: Snap): void {
  const s = worldToScreen(view, snap.point);
  ctx.strokeStyle = COLORS.snap;
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  switch (snap.kind) {
    case "endpoint":
    case "quadrant":
      ctx.rect(s.x - 5, s.y - 5, 10, 10);
      break;
    case "midpoint":
      ctx.moveTo(s.x, s.y - 6);
      ctx.lineTo(s.x + 6, s.y + 5);
      ctx.lineTo(s.x - 6, s.y + 5);
      ctx.closePath();
      break;
    case "center":
      ctx.arc(s.x, s.y, 5, 0, Math.PI * 2);
      break;
    case "intersection":
      ctx.moveTo(s.x - 5, s.y - 5);
      ctx.lineTo(s.x + 5, s.y + 5);
      ctx.moveTo(s.x + 5, s.y - 5);
      ctx.lineTo(s.x - 5, s.y + 5);
      break;
    case "origin":
      // Concentric rings, distinct from the plain circle used for a center snap.
      ctx.arc(s.x, s.y, 6, 0, Math.PI * 2);
      ctx.moveTo(s.x + 2.5, s.y);
      ctx.arc(s.x, s.y, 2.5, 0, Math.PI * 2);
      break;
    case "on-line":
      ctx.arc(s.x, s.y, 2.5, 0, Math.PI * 2);
      break;
    case "grid":
      ctx.moveTo(s.x - 4, s.y);
      ctx.lineTo(s.x + 4, s.y);
      ctx.moveTo(s.x, s.y - 4);
      ctx.lineTo(s.x, s.y + 4);
      break;
    case "node":
      ctx.arc(s.x, s.y, 4, 0, Math.PI * 2);
      ctx.moveTo(s.x - 6, s.y);
      ctx.lineTo(s.x + 6, s.y);
      ctx.moveTo(s.x, s.y - 6);
      ctx.lineTo(s.x, s.y + 6);
      break;
    case "perpendicular":
      // AutoCAD's ⟂: a corner mark.
      ctx.moveTo(s.x - 6, s.y - 6);
      ctx.lineTo(s.x - 6, s.y + 6);
      ctx.lineTo(s.x + 6, s.y + 6);
      ctx.moveTo(s.x - 6, s.y);
      ctx.lineTo(s.x, s.y);
      ctx.lineTo(s.x, s.y + 6);
      break;
    case "tangent":
      // A circle with a tangent bar on top.
      ctx.arc(s.x, s.y + 1, 5, 0, Math.PI * 2);
      ctx.moveTo(s.x - 7, s.y - 5);
      ctx.lineTo(s.x + 7, s.y - 5);
      break;
    case "extension":
      // A short dashed tick; the guide ray is drawn separately.
      ctx.moveTo(s.x - 5, s.y + 5);
      ctx.lineTo(s.x + 5, s.y - 5);
      break;
    case "tracking":
      // A diamond: the point is on a guide, not on geometry.
      ctx.moveTo(s.x, s.y - 6);
      ctx.lineTo(s.x + 6, s.y);
      ctx.lineTo(s.x, s.y + 6);
      ctx.lineTo(s.x - 6, s.y);
      ctx.closePath();
      break;
  }
  ctx.stroke();
  if (snap.kind === "extension" && snap.guideFrom) {
    const g = worldToScreen(view, snap.guideFrom);
    ctx.save();
    ctx.globalAlpha = 0.55;
    ctx.setLineDash([2, 4]);
    ctx.beginPath();
    ctx.moveTo(g.x, g.y);
    ctx.lineTo(s.x, s.y);
    ctx.stroke();
    ctx.restore();
  }
}

/**
 * The ortho/polar guide: a faint dashed ray from the anchor out past the
 * tracked point to the edge of the canvas, and the angle next to the point
 * (AutoCAD's polar tooltip).
 */
/**
 * A constraint mark: the glyph in a small chip, offset up and right of the
 * geometry so it doesn't sit on top of the line it describes.
 */
function drawConstraintGlyph(
  ctx: CanvasRenderingContext2D,
  view: View,
  g: { at: Point; glyph: string; state: "normal" | "conflict" | "highlight" },
): void {
  const p = worldToScreen(view, g.at);
  const x = p.x + CONSTRAINT_GLYPH_OFFSET.x;
  const y = p.y + CONSTRAINT_GLYPH_OFFSET.y;
  const color = g.state === "conflict" ? COLORS.crossingMarker : g.state === "highlight" ? COLORS.selected : COLORS.snap;
  ctx.save();
  ctx.globalAlpha = g.state === "normal" ? 0.85 : 1;
  ctx.fillStyle = COLORS.bg;
  ctx.strokeStyle = color;
  ctx.lineWidth = 1;
  roundRect(ctx, x - CONSTRAINT_GLYPH_SIZE / 2, y - CONSTRAINT_GLYPH_SIZE / 2, CONSTRAINT_GLYPH_SIZE, CONSTRAINT_GLYPH_SIZE, 3);
  ctx.fill();
  ctx.stroke();
  ctx.fillStyle = color;
  ctx.font = `${CONSTRAINT_GLYPH_SIZE - 5}px system-ui, sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(g.glyph, x, y + 0.5);
  ctx.restore();
}


/** LibreCAD's relative-zero marker: a small crossed circle at the last point placed. */
function drawRelativeZero(ctx: CanvasRenderingContext2D, view: View, p: Point): void {
  const s = worldToScreen(view, p);
  ctx.save();
  ctx.strokeStyle = COLORS.snap;
  ctx.globalAlpha = 0.7;
  ctx.lineWidth = 1.2;
  ctx.beginPath();
  ctx.arc(s.x, s.y, 5, 0, Math.PI * 2);
  ctx.moveTo(s.x - 8, s.y);
  ctx.lineTo(s.x + 8, s.y);
  ctx.moveTo(s.x, s.y - 8);
  ctx.lineTo(s.x, s.y + 8);
  ctx.stroke();
  ctx.restore();
}

/** The small plus AutoCAD puts on an acquired point, so it's clear what the guides come from. */
function drawAcquiredMarker(ctx: CanvasRenderingContext2D, view: View, p: Point): void {
  const s = worldToScreen(view, p);
  ctx.save();
  ctx.strokeStyle = COLORS.snap;
  ctx.globalAlpha = 0.8;
  ctx.lineWidth = 1.2;
  ctx.beginPath();
  ctx.moveTo(s.x - 4, s.y);
  ctx.lineTo(s.x + 4, s.y);
  ctx.moveTo(s.x, s.y - 4);
  ctx.lineTo(s.x, s.y + 4);
  ctx.stroke();
  ctx.restore();
}

function drawTrackingRay(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  view: View,
  ray: { from: Point; to: Point; angleDeg: number },
): void {
  const a = worldToScreen(view, ray.from);
  const b = worldToScreen(view, ray.to);
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = Math.hypot(dx, dy);
  if (len < 1e-6) return;
  const reach = width + height;
  const end = { x: a.x + (dx / len) * reach, y: a.y + (dy / len) * reach };
  ctx.save();
  ctx.strokeStyle = COLORS.snap;
  ctx.globalAlpha = 0.55;
  ctx.lineWidth = 1;
  ctx.setLineDash([2, 4]);
  ctx.beginPath();
  ctx.moveTo(a.x, a.y);
  ctx.lineTo(end.x, end.y);
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.globalAlpha = 1;
  ctx.fillStyle = COLORS.snap;
  ctx.font = "11px system-ui, sans-serif";
  ctx.textBaseline = "bottom";
  const label = `${Number.isInteger(ray.angleDeg) ? ray.angleDeg : ray.angleDeg.toFixed(1)}°`;
  ctx.fillText(label, b.x + 10, b.y - 8);
  ctx.restore();
}
