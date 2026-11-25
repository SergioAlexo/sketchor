import type { Bounds } from "../dxf";
import type { Point } from "../geometry";

/**
 * Screen mapping: sx = wx * scale + ox ; sy = -wy * scale + oy
 * (world Y grows upward, CAD convention)
 */
export interface View {
  scale: number;
  ox: number;
  oy: number;
}

export function worldToScreen(view: View, p: Point): Point {
  return { x: p.x * view.scale + view.ox, y: -p.y * view.scale + view.oy };
}

export function screenToWorld(view: View, p: Point): Point {
  return { x: (p.x - view.ox) / view.scale, y: (view.oy - p.y) / view.scale };
}

export function zoomAt(view: View, screen: Point, factor: number): View {
  const scale = Math.min(1000, Math.max(0.001, view.scale * factor));
  const f = scale / view.scale;
  return {
    scale,
    ox: screen.x - (screen.x - view.ox) * f,
    oy: screen.y - (screen.y - view.oy) * f,
  };
}

/** A view that frames `bb` within a `viewW` x `viewH` viewport, centered, with a fractional `padding` margin. */
export function fitToBounds(bb: Bounds, viewW: number, viewH: number, padding = 0.1): View {
  const w = Math.max(bb.maxX - bb.minX, 1e-6);
  const h = Math.max(bb.maxY - bb.minY, 1e-6);
  const scale = Math.min(1000, Math.max(0.001, Math.min(viewW / w, viewH / h) * (1 - padding)));
  const cx = (bb.minX + bb.maxX) / 2;
  const cy = (bb.minY + bb.maxY) / 2;
  return { scale, ox: viewW / 2 - cx * scale, oy: viewH / 2 + cy * scale };
}

/** Smallest 1/2/5*10^n grid step that is at least minPx on screen. */
export function gridStep(scale: number, minPx = 24): number {
  const raw = minPx / scale;
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  for (const m of [1, 2, 5, 10]) {
    if (mag * m >= raw) return mag * m;
  }
  return mag * 10;
}
