import type { Model3D, Vec3 } from "./types";

/**
 * Screen-space picking of vertices and edges (faces come free from the
 * raycast — a triangle knows its face). Kept pure by taking a projector
 * rather than a camera: the viewer supplies "world point → pixel", and
 * this file only does the searching, which is what needs testing.
 *
 * Onshape's rule, and this one: whatever is nearest the cursor within a
 * few pixels wins, with a vertex beating an edge beating a face — you aim
 * at a corner, you get the corner.
 */

export interface ScreenPoint {
  x: number;
  y: number;
  /** False when the point is behind the camera, where the projection is meaningless. */
  visible: boolean;
  /** Distance from the camera, so an edge behind the surface under the cursor can be rejected. */
  depth: number;
}

export type Projector = (p: Vec3) => ScreenPoint;

export interface PickOptions {
  /** Pixel radius of the aperture. */
  tolPx: number;
  /**
   * Reject candidates deeper than this (the surface hit's distance plus a
   * little slack), so a click never grabs an edge on the far side of a solid.
   * Infinity when nothing was hit — then anything near the cursor is fair game.
   */
  maxDepth: number;
}

/** Nearest vertex of `part` to `cursor`, or null when none is within the aperture. */
export function pickVertex(model: Model3D, part: number, cursor: { x: number; y: number }, project: Projector, opts: PickOptions): number | null {
  const p = model.parts[part];
  if (!p) return null;
  let best: { index: number; d: number } | null = null;
  for (let i = p.nodeStart; i < p.nodeStart + p.nodeCount; i++) {
    const s = project([model.nodes.xyz[i * 3], model.nodes.xyz[i * 3 + 1], model.nodes.xyz[i * 3 + 2]]);
    if (!s.visible || s.depth > opts.maxDepth) continue;
    const d = Math.hypot(s.x - cursor.x, s.y - cursor.y);
    if (d <= opts.tolPx && (!best || d < best.d)) best = { index: i, d };
  }
  return best?.index ?? null;
}

/** Nearest edge of `part` to `cursor` (measured to its projected segments), or null. */
export function pickEdge(model: Model3D, part: number, cursor: { x: number; y: number }, project: Projector, opts: PickOptions): number | null {
  const p = model.parts[part];
  if (!p) return null;
  let best: { index: number; d: number } | null = null;
  const end = (p.edgeStart + p.edgeCount) * 6;
  for (let o = p.edgeStart * 6; o < end; o += 6) {
    const a = project([model.edges[o], model.edges[o + 1], model.edges[o + 2]]);
    const b = project([model.edges[o + 3], model.edges[o + 4], model.edges[o + 5]]);
    if (!a.visible || !b.visible) continue;
    if (Math.min(a.depth, b.depth) > opts.maxDepth) continue;
    // Cheap reject before the exact distance: the segment's bounding box.
    if (cursor.x < Math.min(a.x, b.x) - opts.tolPx || cursor.x > Math.max(a.x, b.x) + opts.tolPx) continue;
    if (cursor.y < Math.min(a.y, b.y) - opts.tolPx || cursor.y > Math.max(a.y, b.y) + opts.tolPx) continue;
    const d = pointToSegment2d(cursor, a, b);
    if (d <= opts.tolPx && (!best || d < best.d)) best = { index: model.edgeOfSegment[o / 6], d };
  }
  return best?.index ?? null;
}

export function pointToSegment2d(p: { x: number; y: number }, a: { x: number; y: number }, b: { x: number; y: number }): number {
  const abx = b.x - a.x;
  const aby = b.y - a.y;
  const len2 = abx * abx + aby * aby;
  if (len2 < 1e-12) return Math.hypot(p.x - a.x, p.y - a.y);
  let t = ((p.x - a.x) * abx + (p.y - a.y) * aby) / len2;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return Math.hypot(p.x - (a.x + abx * t), p.y - (a.y + aby * t));
}
