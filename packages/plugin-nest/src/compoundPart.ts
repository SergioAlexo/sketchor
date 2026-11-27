/**
 * NT-01: one drawing file = one part. A DXF often holds several separate
 * outlines that belong together (a bracket and its gusset, a set of spacers
 * drawn as a kit). Instead of splitting them into independent parts, the
 * pieces are kept as one rigid compound part:
 *
 * - its nesting outline is the convex hull of every piece, so the nester
 *   moves and rotates the whole drawing as one unit and keeps the pieces
 *   exactly where they were drawn relative to each other;
 * - its holes are the pieces' own holes, minus any hole that has another
 *   piece drawn inside it (that space is taken);
 * - `pieces` keeps each piece's own outer/hole entity ids, so the cut plan
 *   still cuts every piece as its own closed contour (one outer each);
 * - cut length and pierces are the sum of the pieces.
 */
import { area, pointInPolygon } from "./geometry";
import type { Point } from "./types";
import type { ExtractedPart } from "./partExtraction";

/** One piece of a compound part: the entity ids of its outline and of each of its holes. */
export interface PartPiece {
  outerSourceIds: string[];
  holeSourceIds: string[][];
}

export interface CompoundPart extends ExtractedPart {
  /** Present (length >= 2) when the part is several separate pieces kept together. */
  pieces?: PartPiece[];
  /** With `pieces`: the material area of the pieces (outer minus holes, summed) - `outer` is only the envelope. */
  netArea?: number;
}

/** Andrew's monotone chain, counter-clockwise, no repeated closing point. */
export function convexHull(points: Point[]): Point[] {
  const pts = [...points].sort((a, b) => a.x - b.x || a.y - b.y);
  if (pts.length < 3) return pts;
  const cross = (o: Point, a: Point, b: Point) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
  const lower: Point[] = [];
  for (const p of pts) {
    while (lower.length >= 2 && cross(lower[lower.length - 2]!, lower[lower.length - 1]!, p) <= 0) lower.pop();
    lower.push(p);
  }
  const upper: Point[] = [];
  for (let i = pts.length - 1; i >= 0; i--) {
    const p = pts[i]!;
    while (upper.length >= 2 && cross(upper[upper.length - 2]!, upper[upper.length - 1]!, p) <= 0) upper.pop();
    upper.push(p);
  }
  return lower.slice(0, -1).concat(upper.slice(0, -1));
}

/**
 * Merges the parts extracted from ONE file into a single part. One part in,
 * the same part out (no `pieces`). Empty in, null out.
 */
export function mergeIntoOnePart(parts: ExtractedPart[], name: string): CompoundPart | null {
  if (parts.length === 0) return null;
  if (parts.length === 1) return { ...parts[0]!, name };
  const outer = convexHull(parts.flatMap((p) => p.outer));
  const holes: Point[][] = [];
  const holeSourceIds: string[][] = [];
  parts.forEach((p, pi) => {
    p.holes.forEach((h, hi) => {
      // A hole with another piece drawn inside it is not free space any more.
      const occupied = parts.some((q, qi) => qi !== pi && q.outer.length > 0 && pointInPolygon(q.outer[0]!, h));
      if (occupied) return;
      holes.push(h);
      holeSourceIds.push(p.holeSourceIds[hi] ?? []);
    });
  });
  return {
    id: parts[0]!.id,
    name,
    outer,
    holes,
    sourceIds: parts.flatMap((p) => p.sourceIds),
    outerSourceIds: parts.flatMap((p) => p.outerSourceIds),
    holeSourceIds,
    cutLength: parts.reduce((n, p) => n + p.cutLength, 0),
    holeCount: parts.reduce((n, p) => n + p.holeCount, 0),
    pierceCount: parts.reduce((n, p) => n + p.pierceCount, 0),
    netArea: parts.reduce((n, p) => n + Math.max(0, area(p.outer) - p.holes.reduce((m, h) => m + area(h), 0)), 0),
    pieces: parts.map((p) => ({ outerSourceIds: p.outerSourceIds, holeSourceIds: p.holeSourceIds })),
  };
}
