import { paperSizeMm, type LayoutRecord, type ViewportEntity } from "@sketchor/core";
import { worldToScreen, type View } from "./view";

/**
 * L-02: the sheet a layout is printed on, drawn in paper millimetres with the
 * origin at the sheet's lower-left corner. Colours are derived from the theme's
 * entity ink (a faint wash of it is the paper, so default-coloured geometry
 * stays legible in both dark and light themes) rather than new tokens.
 */
export function sheetRect(layout: LayoutRecord): { x: number; y: number; w: number; h: number } {
  const { w, h } = paperSizeMm(layout.paper);
  return { x: 0, y: 0, w, h };
}

/** Printable area (inside the margins) in mm, same frame as {@link sheetRect}. */
export function printableRect(layout: LayoutRecord): { x: number; y: number; w: number; h: number } {
  const { w, h } = paperSizeMm(layout.paper);
  const k = layout.paper.units === "in" ? 25.4 : 1;
  const m = layout.margins;
  const left = m.left * k;
  const bottom = m.bottom * k;
  return { x: left, y: bottom, w: Math.max(0, w - left - m.right * k), h: Math.max(0, h - bottom - m.top * k) };
}

/**
 * The screen mapping of model space seen through `vp` when the sheet is shown
 * with `paper`: worldToScreen(result, m) === worldToScreen(paper, modelToPaper(vp, m)).
 * Because a viewport has no rotation this is again a plain scale + offset, so
 * the whole model renderer (and, in MSPACE, every tool) works unchanged.
 */
export function viewportScreenView(paper: View, vp: ViewportEntity): View {
  const s = vp.scale;
  return {
    scale: s * paper.scale,
    ox: (vp.center.x - vp.viewCenter.x * s) * paper.scale + paper.ox,
    oy: paper.oy + (vp.viewCenter.y * s - vp.center.y) * paper.scale,
  };
}

/** The inverse: the sheet's own view that goes with model view `model` inside `vp` (keeps the paper where it is when the model view pans/zooms). */
export function paperViewFromModelView(model: View, vp: ViewportEntity): View {
  const scale = model.scale / vp.scale;
  return {
    scale,
    ox: model.ox - (vp.center.x - vp.viewCenter.x * vp.scale) * scale,
    oy: model.oy - (vp.viewCenter.y * vp.scale - vp.center.y) * scale,
  };
}

/**
 * MSPACE zoom/pan: the sheet stays put, so a change of the model view is a change of the viewport's own
 * `scale`/`viewCenter`. Returns `vp` with the values that make `viewportScreenView(paper, result)` equal `model`.
 */
export function viewportFromModelView(paper: View, model: View, vp: ViewportEntity): ViewportEntity {
  const scale = Math.min(1000, Math.max(1e-6, model.scale / paper.scale));
  // A zoom changes the window's scale, so an explicit annotation scale no longer describes it: annotative objects follow the new ratio.
  const { annotationScale: _a, ...keep } = vp;
  return {
    ...keep,
    scale,
    viewCenter: {
      x: (vp.center.x - (model.ox - paper.ox) / paper.scale) / scale,
      y: ((model.oy - paper.oy) / paper.scale + vp.center.y) / scale,
    },
  };
}

export function drawSheet(ctx: CanvasRenderingContext2D, view: View, layout: LayoutRecord, ink: string): void {
  const r = sheetRect(layout);
  const a = worldToScreen(view, { x: r.x, y: r.y + r.h });
  const w = r.w * view.scale;
  const h = r.h * view.scale;
  ctx.save();
  // Shadow, then the sheet itself.
  ctx.fillStyle = "rgba(0, 0, 0, 0.35)";
  ctx.fillRect(a.x + 4, a.y + 4, w, h);
  ctx.fillStyle = ink;
  ctx.globalAlpha = 0.1;
  ctx.fillRect(a.x, a.y, w, h);
  ctx.globalAlpha = 0.6;
  ctx.strokeStyle = ink;
  ctx.lineWidth = 1;
  ctx.strokeRect(a.x + 0.5, a.y + 0.5, w, h);
  // Printable area.
  const p = printableRect(layout);
  const pa = worldToScreen(view, { x: p.x, y: p.y + p.h });
  ctx.globalAlpha = 0.35;
  ctx.setLineDash([5, 4]);
  ctx.strokeRect(pa.x + 0.5, pa.y + 0.5, p.w * view.scale, p.h * view.scale);
  ctx.restore();
}
