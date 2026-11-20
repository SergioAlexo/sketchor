import { kindBounds, type Entity, type Point } from "@sketchor/core";
import type { View } from "./view";

/** The world rectangle a `width` x `height` canvas shows, grown by `padPx` screen pixels on every side. */
export interface WorldRect {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export function viewWorldRect(view: View, width: number, height: number, padPx: number): WorldRect {
  return {
    minX: (-padPx - view.ox) / view.scale,
    maxX: (width + padPx - view.ox) / view.scale,
    minY: (view.oy - height - padPx) / view.scale,
    maxY: (view.oy + padPx) / view.scale,
  };
}

/**
 * Below this many screen pixels across, an entity is drawn as a one-pixel
 * speck of its colour instead of its full geometry: at that size the outline
 * is a dot anyway, and stroking thousands of sub-pixel paths is what made a
 * zoomed-out assembly drawing slow down with every step out.
 */
export const SPECK_PX = 1.5;

export type ViewClass = { vis: "offscreen" } | { vis: "speck"; at: Point } | { vis: "visible" };

/**
 * Whether `e` is off-screen, a speck (with where to put it), or worth drawing
 * in full at `scale` pixels per world unit. Without this every entity of a big
 * drawing was drawn in full on every frame, wherever the view was. Conservative
 * on purpose: an infinite construction line is drawn clipped to the view
 * whatever its two defining points are, and an entity with no bounds is never
 * skipped.
 */
export function classifyForView(e: Entity, rect: WorldRect, scale: number): ViewClass {
  if (e.type === "line" && e.infinite) return { vis: "visible" };
  const bb = kindBounds(e);
  if (!bb) return { vis: "visible" };
  if (bb.maxX < rect.minX || bb.minX > rect.maxX || bb.maxY < rect.minY || bb.minY > rect.maxY) return { vis: "offscreen" };
  if (Math.max(bb.maxX - bb.minX, bb.maxY - bb.minY) * scale < SPECK_PX) return { vis: "speck", at: { x: (bb.minX + bb.maxX) / 2, y: (bb.minY + bb.maxY) / 2 } };
  return { vis: "visible" };
}

/** A closed-region tint worth filling: on screen and bigger than a speck (an invisible fill still costs a full path). */
export function regionWorthDrawing(polygon: readonly Point[], rect: WorldRect, scale: number): boolean {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of polygon) {
    if (p.x < minX) minX = p.x;
    if (p.x > maxX) maxX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.y > maxY) maxY = p.y;
  }
  if (maxX < rect.minX || minX > rect.maxX || maxY < rect.minY || minY > rect.maxY) return false;
  return Math.max(maxX - minX, maxY - minY) * scale >= SPECK_PX;
}

/**
 * Below this many screen pixels tall, text is drawn as a faint stroke the
 * length of the string instead of glyphs ("greeking", as AutoCAD does): at
 * that size no glyph is readable, and setting a font and filling glyphs for
 * thousands of labels is what made a zoomed-out assembly drawing crawl.
 */
export const GREEK_TEXT_PX = 2.5;
