import type { Bounds } from "../dxf";
import type { Entity } from "../entities";
import { layerOf } from "../entities";
import type { Point } from "../geometry";
import { drawOrderOf } from "../hatch/ops";
import { kindBounds } from "../kinds/registry";
import { classifyForView, viewWorldRect } from "./cull";
import { drawEntity, drawFillHatch, type DrawEnv } from "./entity";
import { beginHatchFrame } from "./hatch";
import { worldToScreen, type View } from "./view";

export interface DrawEntitiesOptions {
  /** Canvas size in CSS pixels (what `view` maps to); used to skip entities that are off-screen. */
  width: number;
  height: number;
  env: DrawEnv;
  /** Layers not drawn. */
  hiddenLayers?: ReadonlySet<string>;
  /** Z-04: an entity's BYLAYER-resolved linetype name; default its own. */
  linetypeOf?: (e: Entity) => string | undefined;
  /** The document's global linetype scale (`$LTSCALE`). */
  ltscale?: number;
  /** Stroke width in screen pixels. Default 1.5, as in the app. */
  lineWidth?: number;
  /** A colour every entity is drawn in instead of its own (a monochrome preview). */
  monochrome?: string;
}

/**
 * E-01: draws a whole drawing — the entity loop of the app's viewport without
 * any of its interaction (selection, grips, snaps, previews). Lower
 * `drawOrder` first (H-08), entities wholly off-screen skipped, and the ones
 * smaller than a pixel batched into single-pixel specks per colour, so a big
 * drawing stays fast zoomed out. Does not clear the canvas.
 */
export function drawEntities(ctx: CanvasRenderingContext2D, entities: readonly Entity[], view: View, opts: DrawEntitiesOptions): void {
  beginHatchFrame();
  const onScreen = viewWorldRect(view, opts.width, opts.height, 40);
  const lw = opts.lineWidth ?? 1.5;
  const ltscale = opts.ltscale ?? 1;
  const specks = new Map<string, Point[]>();
  const list = entities.some((e) => drawOrderOf(e) !== 0) ? [...entities].sort((a, b) => drawOrderOf(a) - drawOrderOf(b)) : entities;
  for (const e of list) {
    if (opts.hiddenLayers?.has(layerOf(e))) continue;
    const vis = classifyForView(e, onScreen, view.scale);
    if (vis.vis === "offscreen") continue;
    const color = opts.monochrome ?? e.color ?? opts.env.ink;
    if (vis.vis === "speck") {
      const pts = specks.get(color);
      if (pts) pts.push(vis.at);
      else specks.set(color, [vis.at]);
      continue;
    }
    if (e.fill) drawFillHatch(ctx, view, e, opts.monochrome ?? e.fill);
    drawEntity(ctx, view, e, color, lw, opts.env, opts.linetypeOf ? opts.linetypeOf(e) : e.linetype, ltscale);
  }
  for (const [color, pts] of specks) {
    ctx.fillStyle = color;
    ctx.beginPath();
    for (const p of pts) {
      const s = worldToScreen(view, p);
      ctx.rect(Math.round(s.x) - 0.5, Math.round(s.y) - 0.5, 1.5, 1.5);
    }
    ctx.fill();
  }
}

/** The union of the entities' bounds (infinite construction lines left out), or null when none has any. */
export function entitiesBounds(entities: readonly Entity[]): Bounds | null {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const e of entities) {
    if (e.type === "line" && e.infinite) continue;
    const b = kindBounds(e);
    if (!b || !Number.isFinite(b.minX + b.minY + b.maxX + b.maxY)) continue;
    if (b.minX < minX) minX = b.minX;
    if (b.minY < minY) minY = b.minY;
    if (b.maxX > maxX) maxX = b.maxX;
    if (b.maxY > maxY) maxY = b.maxY;
  }
  return Number.isFinite(minX) ? { minX, minY, maxX, maxY } : null;
}
