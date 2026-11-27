import type { HatchEntity } from "../entities";
import { gradientSpec } from "../hatch/gradient";
import { hatchFillCached } from "../hatch/fillLines";
import { hatchPolygons, paintedPolygons } from "../hatch/loops";
import { worldToScreen, type View } from "./view";

/**
 * Canvas drawing of a hatch entity (H-02). A pattern is drawn as the exact
 * strokes the fill engine produced; when the strokes would be sub-pixel
 * (zoomed far out) or the engine's density guard fired, the average tone is
 * drawn as a tint instead, so a dense pattern never hangs the UI.
 */

/** Closer than this many screen pixels and the lines read as a tint. */
const TINT_BELOW_PX = 2.5;

function regionPath(ctx: CanvasRenderingContext2D, view: View, h: HatchEntity): void {
  ctx.beginPath();
  for (const poly of paintedPolygons(h, 0.5 / view.scale)) {
    poly.forEach((q, i) => {
      const p = worldToScreen(view, q);
      if (i === 0) ctx.moveTo(p.x, p.y);
      else ctx.lineTo(p.x, p.y);
    });
    ctx.closePath();
  }
}

const strokePaths = new WeakMap<object, Path2D>();
/** The fill's strokes as one world-space Path2D (cached on the fill object, which is replaced whenever the hatch changes). */
function strokePath(fill: { segments: Float32Array }): Path2D {
  let path = strokePaths.get(fill);
  if (!path) {
    path = new Path2D();
    const s = fill.segments;
    for (let i = 0; i < s.length; i += 4) {
      path.moveTo(s[i], s[i + 1]);
      path.lineTo(s[i + 2], s[i + 3]);
    }
    strokePaths.set(fill, path);
  }
  return path;
}

let tintedThisFrame = 0;
/** Call at the start of a frame; `hatchesTinted()` then says whether any hatch drawn since was summarised as a tint (H-02 status-bar notice). */
export function beginHatchFrame(): void {
  tintedThisFrame = 0;
}
export function hatchesTinted(): boolean {
  return tintedThisFrame > 0;
}

export interface HatchDrawResult {
  /** The pattern was summarised as a tint (zoomed out or too dense) — the status bar can say so. */
  tinted: boolean;
}

export function drawHatchEntity(ctx: CanvasRenderingContext2D, view: View, h: HatchEntity, color: string, lineWidth: number): HatchDrawResult {
  const opacity = 1 - Math.min(1, Math.max(0, h.transparency ?? 0));
  const alpha = ctx.globalAlpha;
  let tinted = false;
  ctx.save();
  if (h.backgroundColor && h.paint.kind === "pattern") {
    ctx.globalAlpha = alpha * opacity;
    ctx.fillStyle = h.backgroundColor;
    regionPath(ctx, view, h);
    ctx.fill("evenodd");
  }
  ctx.globalAlpha = alpha * opacity;
  const p = h.paint;
  if (p.kind === "solid") {
    ctx.fillStyle = p.color;
    regionPath(ctx, view, h);
    ctx.fill("evenodd");
  } else if (p.kind === "gradient") {
    const polys = hatchPolygons(h, 0.5 / view.scale).flat();
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const q of polys) {
      minX = Math.min(minX, q.x);
      minY = Math.min(minY, q.y);
      maxX = Math.max(maxX, q.x);
      maxY = Math.max(maxY, q.y);
    }
    if (Number.isFinite(minX)) {
      const spec = gradientSpec(p, { minX, minY, maxX, maxY });
      if (spec) {
        const P = (x: number, y: number) => worldToScreen(view, { x, y });
        let g: CanvasGradient;
        if (spec.kind === "linear") {
          const a = P(spec.x1, spec.y1);
          const b = P(spec.x2, spec.y2);
          g = ctx.createLinearGradient(a.x, a.y, b.x, b.y);
        } else {
          const c = P(spec.cx, spec.cy);
          const f = P(spec.fx, spec.fy);
          g = ctx.createRadialGradient(f.x, f.y, 0, c.x, c.y, spec.r * view.scale);
        }
        for (const st of spec.stops) g.addColorStop(st.t, st.color);
        ctx.fillStyle = g;
      }
      regionPath(ctx, view, h);
      ctx.fill("evenodd");
    }
  } else {
    const fill = hatchFillCached(h);
    ctx.strokeStyle = color;
    if (fill.truncated || fill.minSpacing * view.scale < TINT_BELOW_PX) {
      tinted = true;
      // Average tone: ink length per area × one pixel of line width (in world units) = covered fraction.
      ctx.globalAlpha = alpha * opacity * Math.min(0.8, (fill.inkPerArea / view.scale) * 1.0);
      ctx.fillStyle = color;
      regionPath(ctx, view, h);
      ctx.fill("evenodd");
    } else {
      // H-10: one Path2D per hatch in world units, built once per fill; pan/zoom only changes the transform.
      if (fill.segments.length > 0) {
        ctx.save();
        ctx.translate(view.ox, view.oy);
        ctx.scale(view.scale, -view.scale);
        ctx.lineWidth = 1 / view.scale;
        ctx.stroke(strokePath(fill));
        ctx.restore();
      }
      const d = fill.dots;
      if (d.length > 0) {
        ctx.fillStyle = color;
        ctx.beginPath();
        for (let i = 0; i < d.length; i += 2) {
          const q = worldToScreen(view, { x: d[i], y: d[i + 1] });
          ctx.rect(q.x - 0.75, q.y - 0.75, 1.5, 1.5);
        }
        ctx.fill();
      }
    }
  }
  // The boundary is geometry the user drew separately; the hatch itself only outlines when picked or hovered.
  if (lineWidth >= 2 || h.boundaryLost) {
    ctx.globalAlpha = alpha;
    ctx.strokeStyle = h.boundaryLost ? "#e5484d" : color;
    ctx.lineWidth = h.boundaryLost ? Math.max(lineWidth, 1.5) : lineWidth;
    ctx.setLineDash([4, 3]);
    ctx.beginPath();
    for (const poly of hatchPolygons(h, 0.5 / view.scale)) {
      poly.forEach((q, i) => {
        const s = worldToScreen(view, q);
        if (i === 0) ctx.moveTo(s.x, s.y);
        else ctx.lineTo(s.x, s.y);
      });
      ctx.closePath();
    }
    ctx.stroke();
  }
  ctx.restore();
  if (tinted) tintedThisFrame++;
  return { tinted };
}
