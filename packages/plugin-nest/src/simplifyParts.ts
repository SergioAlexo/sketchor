import { simplifyClosedRing } from "@sketchor/core";
import { bounds, rotate } from "./geometry";
import type { TrueNestPart, TrueNestPlacement } from "./trueNest";
import type { Point } from "./types";

/**
 * NF-05: nest on simplified geometry. Parts are flattened from the real
 * curves at the chord tolerance, which leaves tens of near-collinear
 * vertices on every curve; the NFP maths is quadratic in vertex count. A
 * Douglas-Peucker pass at the same tolerance removes them. The output still
 * materialises the original entities (placementTransform on the original
 * outline), so only the search sees the simplified outline.
 *
 * Simplified vertices are a subset of the original ones, so a chord can cut
 * a corner by at most `tol` (inward) or bridge a concavity by at most `tol`
 * (outward). The caller therefore widens part spacing by 2 x tol and the
 * edge margin by tol, so the clearance the user asked for still holds on the
 * real outlines. The bbox-min corner of the simplified outline can also sit
 * a little off the original's, and `restorePlacements` corrects for that.
 */

export const DEFAULT_SIMPLIFY_TOLERANCE = 0.05;

export interface SimplifiedParts {
  parts: TrueNestPart[];
  /** Whether any vertex was removed (when false, nothing needs widening or restoring). */
  changed: boolean;
  /** Maps placements found on the simplified outlines back onto the originals. */
  restorePlacements(placed: TrueNestPlacement[]): TrueNestPlacement[];
}

function simplifyRing(ring: Point[], tol: number): Point[] {
  if (ring.length < 5) return ring;
  const out = simplifyClosedRing(ring, tol);
  // Never degrade a ring to a sliver: keep the original if it collapsed.
  return out.length >= 3 ? out : ring;
}

export function simplifyParts(parts: TrueNestPart[], tol = DEFAULT_SIMPLIFY_TOLERANCE): SimplifiedParts {
  if (!(tol > 0)) return { parts, changed: false, restorePlacements: (p) => p };
  const original = new Map<string, TrueNestPart>();
  let changed = false;
  const out = parts.map((part) => {
    original.set(part.id, part);
    const outer = simplifyRing(part.outer, tol);
    const holes = part.holes.map((h) => simplifyRing(h, tol));
    if (outer.length !== part.outer.length || holes.some((h, i) => h.length !== part.holes[i]!.length)) changed = true;
    return outer === part.outer && holes.every((h, i) => h === part.holes[i]) ? part : { ...part, outer, holes };
  });
  if (!changed) return { parts, changed: false, restorePlacements: (p) => p };

  const minOf = (poly: Point[], deg: number, mirrored: boolean): Point => {
    const m = mirrored ? poly.map((p) => ({ x: -p.x, y: p.y })) : poly;
    const b = bounds(rotate(m, deg));
    return { x: b.minX, y: b.minY };
  };
  const simplified = new Map(out.map((p) => [p.id, p]));
  return {
    parts: out,
    changed,
    restorePlacements(placed) {
      return placed.map((pl) => {
        const o = original.get(pl.partId);
        const s = simplified.get(pl.partId);
        if (!o || !s || o === s) return pl;
        const bo = minOf(o.outer, pl.rotationDeg, pl.mirrored);
        const bs = minOf(s.outer, pl.rotationDeg, pl.mirrored);
        return { ...pl, translation: { x: pl.translation.x + bo.x - bs.x, y: pl.translation.y + bo.y - bs.y } };
      });
    },
  };
}
