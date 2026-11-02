import { paperSizeMm, type LayoutRecord } from "@sketchor/core";
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
