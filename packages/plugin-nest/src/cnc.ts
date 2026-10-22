import { pointInPolygon } from "./geometry";
import type { Point } from "./types";

/**
 * RN-50: CNC router checks. Ported from the Sheet Nesting Calculator by
 * Oleksandr Borenko.
 *
 * A router bit is round, so a hole narrower than the bit cannot be cut and a
 * sharp inside corner comes out rounded to the bit's radius. Both are silent
 * failures on the machine, so we warn up front, per part. The geometry facts
 * (`cncInfo`) do not depend on the bit and can be cached per part; the
 * warnings (`cncWarnings`) are a cheap comparison against a bit diameter.
 * Units are whatever the points are in; compare against a bit in the same unit.
 */

const CORNER_TURN = (40 * Math.PI) / 180;

function signedArea(poly: Point[]): number {
  let a = 0;
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i];
    const q = poly[(i + 1) % poly.length];
    a += p.x * q.y - q.x * p.y;
  }
  return a / 2;
}

/**
 * Radius of the largest circle that fits inside `poly` (approximate: a
 * four-pass grid refinement around the bounding-box centre, so it is accurate
 * to a small fraction of the polygon size, never an overestimate).
 * 0 for a degenerate polygon.
 */
export function inscribedR(poly: Point[]): number {
  const n = poly.length;
  if (n < 3) return 0;
  let minx = Infinity;
  let miny = Infinity;
  let maxx = -Infinity;
  let maxy = -Infinity;
  for (const p of poly) {
    if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) return 0;
    if (p.x < minx) minx = p.x;
    if (p.x > maxx) maxx = p.x;
    if (p.y < miny) miny = p.y;
    if (p.y > maxy) maxy = p.y;
  }
  const distToEdges = (x: number, y: number): number => {
    let best = Infinity;
    for (let k = 0; k < n; k++) {
      const a = poly[k];
      const b = poly[(k + 1) % n];
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const l2 = dx * dx + dy * dy;
      let t = l2 > 0 ? ((x - a.x) * dx + (y - a.y) * dy) / l2 : 0;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      const ex = a.x + t * dx - x;
      const ey = a.y + t * dy - y;
      const d = ex * ex + ey * ey;
      if (d < best) best = d;
    }
    return Math.sqrt(best);
  };
  let bx = (minx + maxx) / 2;
  let by = (miny + maxy) / 2;
  let br = -1;
  let sx = (maxx - minx) / 2;
  let sy = (maxy - miny) / 2;
  const G = 14;
  for (let pass = 0; pass < 4; pass++) {
    const cx = bx;
    const cy = by;
    for (let gx = -G; gx <= G; gx++) {
      for (let gy = -G; gy <= G; gy++) {
        const x = cx + (sx * gx) / G;
        const y = cy + (sy * gy) / G;
        if (!pointInPolygon({ x, y }, poly)) continue;
        const d = distToEdges(x, y);
        if (d > br) {
          br = d;
          bx = x;
          by = y;
        }
      }
    }
    sx /= 4;
    sy /= 4;
  }
  return Math.max(br, 0);
}

/** One closed contour of a part: `hole` true for an inner cutout. */
export interface CncContour {
  points: Point[];
  hole: boolean;
}

export interface CncInfo {
  /** Inscribed-circle DIAMETER of every hole: the largest bit that could cut it. */
  holes: number[];
  /** Inside corners (turn above 40 degrees, so arc facets do not count) a round bit cannot reach. */
  corners: number;
}

/** Bit-independent geometry facts for a part. Never throws; degenerate contours contribute nothing. */
export function cncInfo(contours: readonly CncContour[]): CncInfo {
  const holes: number[] = [];
  let corners = 0;
  for (const c of contours) {
    const poly = c.points;
    const n = poly.length;
    if (n < 3) continue;
    const sgn = signedArea(poly) >= 0 ? 1 : -1;
    if (c.hole) holes.push(2 * inscribedR(poly));
    for (let i = 0; i < n; i++) {
      const a = poly[(i + n - 1) % n];
      const b = poly[i];
      const d = poly[(i + 1) % n];
      const ux = b.x - a.x;
      const uy = b.y - a.y;
      const vx = d.x - b.x;
      const vy = d.y - b.y;
      const cr = ux * vy - uy * vx;
      const dt = ux * vx + uy * vy;
      if (Math.abs(cr) + Math.abs(dt) < 1e-12) continue;
      if (Math.atan2(Math.abs(cr), dt) < CORNER_TURN) continue; // smooth arc segment
      const convex = cr * sgn > 0;
      // outer boundary: a reflex vertex is an inside corner; a hole: its convex vertices are
      if (c.hole ? convex : !convex) corners++;
    }
  }
  return { holes, corners };
}

export type CncWarning =
  | { kind: "small-holes"; count: number; smallestDiameter: number; bitDiameter: number }
  | { kind: "inside-corners"; count: number; cornerRadius: number };

/** Warnings for a part's `info` against a bit of diameter `bit`. Empty when the bit is unknown (not > 0). */
export function cncWarnings(info: CncInfo, bit: number): CncWarning[] {
  if (!(bit > 0)) return [];
  const out: CncWarning[] = [];
  const small = info.holes.filter((d) => d < bit - 1e-6);
  if (small.length > 0) out.push({ kind: "small-holes", count: small.length, smallestDiameter: Math.min(...small), bitDiameter: bit });
  if (info.corners > 0) out.push({ kind: "inside-corners", count: info.corners, cornerRadius: bit / 2 });
  return out;
}

/** Convenience for an extracted part (`outer` + `holes`). */
export function cncInfoForPart(part: { outer: Point[]; holes: Point[][] }): CncInfo {
  return cncInfo([{ points: part.outer, hole: false }, ...part.holes.map((h) => ({ points: h, hole: true }))]);
}
