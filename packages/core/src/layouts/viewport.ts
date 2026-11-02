import type { Entity, ViewportEntity } from "../entities";
import type { Point } from "../geometry";
import { newEntityId } from "../entities";
import { pointInPolygon } from "../regions";

/**
 * L-03: the pure geometry of a paper-space viewport. `paper = (model -
 * viewCenter) * scale + center`; the window is the rectangle `width x height`
 * around `center` unless a `clip` polygon replaces it.
 */

export interface Bounds4 {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

/** The window as a closed polygon (first point not repeated), paper coordinates. */
export function viewportOutline(v: ViewportEntity): Point[] {
  if (v.clip && v.clip.length >= 3) return v.clip;
  const hw = v.width / 2;
  const hh = v.height / 2;
  const { x, y } = v.center;
  return [
    { x: x - hw, y: y - hh },
    { x: x + hw, y: y - hh },
    { x: x + hw, y: y + hh },
    { x: x - hw, y: y + hh },
  ];
}

export function viewportBounds(v: ViewportEntity): Bounds4 {
  const o = viewportOutline(v);
  return {
    minX: Math.min(...o.map((p) => p.x)),
    minY: Math.min(...o.map((p) => p.y)),
    maxX: Math.max(...o.map((p) => p.x)),
    maxY: Math.max(...o.map((p) => p.y)),
  };
}

export function modelToPaper(v: ViewportEntity, p: Point): Point {
  return { x: (p.x - v.viewCenter.x) * v.scale + v.center.x, y: (p.y - v.viewCenter.y) * v.scale + v.center.y };
}

export function paperToModel(v: ViewportEntity, p: Point): Point {
  const s = v.scale > 1e-12 ? v.scale : 1e-12;
  return { x: (p.x - v.center.x) / s + v.viewCenter.x, y: (p.y - v.center.y) / s + v.viewCenter.y };
}

/** The model-space rectangle that can be seen through the window (its bounding box when clipped). */
export function viewportModelWindow(v: ViewportEntity): Bounds4 {
  const b = viewportBounds(v);
  const a = paperToModel(v, { x: b.minX, y: b.minY });
  const c = paperToModel(v, { x: b.maxX, y: b.maxY });
  return { minX: Math.min(a.x, c.x), minY: Math.min(a.y, c.y), maxX: Math.max(a.x, c.x), maxY: Math.max(a.y, c.y) };
}

export function pointInViewport(v: ViewportEntity, paper: Point): boolean {
  return pointInPolygon(paper, viewportOutline(v));
}

/** Layers a window shows: everything except its frozen layers. */
export function viewportShowsLayer(v: ViewportEntity, layer: string): boolean {
  return !v.frozenLayers?.includes(layer);
}

/** Pans the view inside the window by a paper-space delta (what a drag of the cursor means). Refused when locked. */
export function panViewport(v: ViewportEntity, dxPaper: number, dyPaper: number): ViewportEntity {
  if (v.locked) return v;
  return { ...v, viewCenter: { x: v.viewCenter.x - dxPaper / v.scale, y: v.viewCenter.y - dyPaper / v.scale } };
}

/** Zooms about a paper point so the model point under it stays put. Refused when locked. */
export function zoomViewport(v: ViewportEntity, aboutPaper: Point, factor: number): ViewportEntity {
  if (v.locked || !(factor > 0)) return v;
  const scale = Math.min(1000, Math.max(1e-6, v.scale * factor));
  const m = paperToModel(v, aboutPaper);
  return { ...v, scale, viewCenter: { x: m.x - (aboutPaper.x - v.center.x) / scale, y: m.y - (aboutPaper.y - v.center.y) / scale } };
}

/** Sets the scale about the window's own centre (the status-bar scale dropdown). Refused when locked. */
export function setViewportScale(v: ViewportEntity, scale: number): ViewportEntity {
  if (v.locked || !(scale > 0)) return v;
  return { ...v, scale };
}

/* ----------------------------------- scales ---------------------------------- */

/** Standard drawing scales as `paper:model`. */
export const STANDARD_SCALES: readonly string[] = ["10:1", "5:1", "2:1", "1:1", "1:2", "1:5", "1:10", "1:20", "1:25", "1:50", "1:100", "1:200", "1:500", "1:1000"];

/** "1:50" -> 0.02, "2:1" -> 2; null when it isn't `a:b` with positive numbers. */
export function parseScale(text: string): number | null {
  const m = /^\s*([0-9]*\.?[0-9]+)\s*[:=]\s*([0-9]*\.?[0-9]+)\s*$/.exec(text);
  if (!m) return null;
  const a = parseFloat(m[1]);
  const b = parseFloat(m[2]);
  return a > 0 && b > 0 ? a / b : null;
}

/** 0.02 -> "1:50", 4 -> "4:1"; odd ratios fall back to "1:n" with up to 3 decimals. */
export function scaleLabel(scale: number): string {
  if (!(scale > 0)) return "1:1";
  const r = (n: number) => String(Math.round(n * 1000) / 1000);
  return scale >= 1 ? `${r(scale)}:1` : `1:${r(1 / scale)}`;
}

/** The standard scale closest to `scale` in log terms, if within 0.1 percent; else null. */
export function standardScaleName(scale: number): string | null {
  for (const s of STANDARD_SCALES) {
    const v = parseScale(s)!;
    if (Math.abs(v - scale) / v < 1e-3) return s;
  }
  return null;
}

/* --------------------------------- construction ------------------------------ */

export function newViewport(rect: { x: number; y: number; w: number; h: number }, view: { center: Point; scale: number }, opts: { id?: string; space?: string; layer?: string } = {}): ViewportEntity {
  return {
    id: opts.id ?? newEntityId(),
    type: "viewport",
    ...(opts.layer ? { layer: opts.layer } : {}),
    ...(opts.space ? { space: opts.space } : {}),
    center: { x: rect.x + rect.w / 2, y: rect.y + rect.h / 2 },
    width: rect.w,
    height: rect.h,
    viewCenter: { ...view.center },
    scale: view.scale,
  };
}

/** A viewport whose polygon window is `polygon` (paper coords); width/height/center follow its bounding box. */
export function viewportFromPolygon(polygon: Point[], view: { center: Point; scale: number }, opts: { id?: string; space?: string; layer?: string } = {}): ViewportEntity {
  const xs = polygon.map((p) => p.x);
  const ys = polygon.map((p) => p.y);
  const minX = Math.min(...xs);
  const minY = Math.min(...ys);
  const v = newViewport({ x: minX, y: minY, w: Math.max(...xs) - minX, h: Math.max(...ys) - minY }, view, opts);
  return { ...v, clip: polygon.map((p) => ({ ...p })) };
}

/**
 * "Viewports: 1/2/3/4" presets: `n` windows tiling `area` (paper rect) with a
 * gap, each showing `modelBounds` fitted at its own size (the same scale for all, so the sheet reads consistently).
 */
export function viewportPreset(n: 1 | 2 | 3 | 4, area: { x: number; y: number; w: number; h: number }, modelBounds: Bounds4 | null, opts: { gap?: number; space?: string } = {}): ViewportEntity[] {
  const gap = opts.gap ?? 5;
  const cols = n === 1 ? 1 : n === 4 ? 2 : 2;
  const rects: { x: number; y: number; w: number; h: number }[] = [];
  if (n === 1) rects.push({ ...area });
  else if (n === 2) {
    const w = (area.w - gap) / 2;
    rects.push({ x: area.x, y: area.y, w, h: area.h }, { x: area.x + w + gap, y: area.y, w, h: area.h });
  } else if (n === 3) {
    const w = (area.w - gap) / 2;
    const h = (area.h - gap) / 2;
    rects.push({ x: area.x, y: area.y, w, h: area.h }, { x: area.x + w + gap, y: area.y + h + gap, w, h }, { x: area.x + w + gap, y: area.y, w, h });
  } else {
    const w = (area.w - gap) / cols;
    const h = (area.h - gap) / 2;
    for (const j of [1, 0]) for (const i of [0, 1]) rects.push({ x: area.x + i * (w + gap), y: area.y + j * (h + gap), w, h });
  }
  const mb = modelBounds ?? { minX: 0, minY: 0, maxX: 100, maxY: 100 };
  const mw = Math.max(mb.maxX - mb.minX, 1e-6);
  const mh = Math.max(mb.maxY - mb.minY, 1e-6);
  const center = { x: (mb.minX + mb.maxX) / 2, y: (mb.minY + mb.maxY) / 2 };
  return rects.map((r) => {
    const fit = Math.min(r.w / mw, r.h / mh) * 0.9;
    return newViewport(r, { center, scale: niceScaleBelow(fit) }, { ...(opts.space ? { space: opts.space } : {}) });
  });
}

/** The largest standard scale that is no bigger than `scale` (so the model still fits); `scale` itself when below every standard one. */
export function niceScaleBelow(scale: number): number {
  let best = 0;
  for (const s of STANDARD_SCALES) {
    const v = parseScale(s)!;
    if (v <= scale + 1e-12 && v > best) best = v;
  }
  return best > 0 ? best : scale;
}

/**
 * What a new window of paper size `w x h` should show: the model extents centred,
 * at the largest standard scale that still fits them (10 percent breathing room).
 * An empty model gets 1:1 around the origin.
 */
export function fitViewportView(w: number, h: number, modelBounds: Bounds4 | null): { center: Point; scale: number } {
  if (!modelBounds) return { center: { x: 0, y: 0 }, scale: 1 };
  const mw = Math.max(modelBounds.maxX - modelBounds.minX, 1e-6);
  const mh = Math.max(modelBounds.maxY - modelBounds.minY, 1e-6);
  return {
    center: { x: (modelBounds.minX + modelBounds.maxX) / 2, y: (modelBounds.minY + modelBounds.maxY) / 2 },
    scale: niceScaleBelow(Math.min(w / mw, h / mh) * 0.9),
  };
}

export function isViewport(e: Entity): e is ViewportEntity {
  return e.type === "viewport";
}

/** The layout's viewports in drawing order. */
export function viewportsOf(entities: Iterable<Entity>, layout: string): ViewportEntity[] {
  const out: ViewportEntity[] = [];
  for (const e of entities) if (e.type === "viewport" && e.space === layout) out.push(e);
  return out;
}
