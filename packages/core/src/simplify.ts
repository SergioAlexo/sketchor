import { bulgeFrom3Points } from "./arcs";
import type { Command } from "./commands";
import type { Entity, PolylineEntity } from "./entities";
import { newEntityId, polylineSegments } from "./entities";
import { arcPointAt, bulgeToArc, dist, shortestTurn, type Point } from "./geometry";

/**
 * Polyline simplification (roadmap P-03). A curve imported from another
 * program — a DXF `SPLINE`/`ELLIPSE` (tessellated on import, see `dxf.ts`)
 * or an already-dense `LWPOLYLINE` another CAD package exported — routinely
 * carries dozens to hundreds of straight-segment vertices for what is
 * really a handful of arcs. `simplifyPolylineEntity` re-derives a much
 * smaller polyline within a tolerance: Ramer–Douglas–Peucker first to drop
 * points that don't change the shape, then a pass that fits maximal runs
 * of the survivors back onto real arcs (stored as bulges, not more
 * points) — the same "one drawing, three renderings" contour, just fewer
 * vertices holding it up.
 */

const EPS = 1e-9;

/** Perpendicular distance from `p` to the infinite line through `a`/`b` (or to `a` itself if they coincide). */
function perpDistance(p: Point, a: Point, b: Point): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lenSq = dx * dx + dy * dy;
  if (lenSq < EPS) return dist(p, a);
  const t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / lenSq;
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

/**
 * Ramer–Douglas–Peucker simplification of an open point run: always keeps
 * the first and last point, drops any interior point that stays within
 * `tolerance` of the straight line between its surviving neighbours.
 */
export function simplifyOpenRun(points: readonly Point[], tolerance: number): Point[] {
  const n = points.length;
  if (n < 3) return points.slice();
  const first = points[0];
  const last = points[n - 1];
  let maxDist = 0;
  let maxIndex = 0;
  for (let i = 1; i < n - 1; i++) {
    const d = perpDistance(points[i], first, last);
    if (d > maxDist) {
      maxDist = d;
      maxIndex = i;
    }
  }
  if (maxDist <= tolerance) return [first, last];
  const left = simplifyOpenRun(points.slice(0, maxIndex + 1), tolerance);
  const right = simplifyOpenRun(points.slice(maxIndex), tolerance);
  return [...left.slice(0, -1), ...right];
}

/** Every point from `from` to `to` inclusive, wrapping forward through the ring if `to < from`. */
function ringSlice(points: readonly Point[], from: number, to: number): Point[] {
  const n = points.length;
  const out: Point[] = [];
  for (let i = from; ; i = (i + 1) % n) {
    out.push(points[i]);
    if (i === to) break;
  }
  return out;
}

/**
 * Same, for a closed loop (`points` doesn't repeat its first point at the
 * end — the codebase's `PolylineEntity` convention). RDP needs two fixed
 * ends to measure against, so this splits the ring at its two
 * farthest-apart points into two open runs, simplifies each, and rejoins.
 */
export function simplifyClosedRing(points: readonly Point[], tolerance: number): Point[] {
  const n = points.length;
  if (n < 4) return points.slice();
  let bestI = 0;
  let bestJ = 1;
  let bestD = -1;
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const d = dist(points[i], points[j]);
      if (d > bestD) {
        bestD = d;
        bestI = i;
        bestJ = j;
      }
    }
  }
  const runA = simplifyOpenRun(ringSlice(points, bestI, bestJ), tolerance);
  const runB = simplifyOpenRun(ringSlice(points, bestJ, bestI), tolerance);
  return [...runA.slice(0, -1), ...runB.slice(0, -1)];
}

/**
 * Algebraic (Kasa) least-squares circle fit through `points` — closed form,
 * so it's cheap to refit for every candidate arc run below. Null for fewer
 * than 3 points, exactly collinear points, or a degenerate (non-positive)
 * radius.
 */
export function fitCircle(points: readonly Point[]): { center: Point; radius: number } | null {
  const n = points.length;
  if (n < 3) return null;
  let sxx = 0;
  let sxy = 0;
  let syy = 0;
  let sx = 0;
  let sy = 0;
  let sxz = 0;
  let syz = 0;
  let sz = 0;
  for (const p of points) {
    const z = p.x * p.x + p.y * p.y;
    sxx += p.x * p.x;
    sxy += p.x * p.y;
    syy += p.y * p.y;
    sx += p.x;
    sy += p.y;
    sxz += p.x * z;
    syz += p.y * z;
    sz += z;
  }
  // Fits x^2+y^2 + A*x + B*y + C = 0 by least squares; solve the 3x3 normal
  // equations [[sxx,sxy,sx],[sxy,syy,sy],[sx,sy,n]] * [A,B,C] = [-sxz,-syz,-sz] via Cramer's rule.
  const det3 = (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number) =>
    a * (e * i - f * h) - b * (d * i - f * g) + c * (d * h - e * g);
  const det = det3(sxx, sxy, sx, sxy, syy, sy, sx, sy, n);
  if (Math.abs(det) < EPS) return null; // collinear / degenerate
  const rx = -sxz;
  const ry = -syz;
  const rz = -sz;
  const A = det3(rx, sxy, sx, ry, syy, sy, rz, sy, n) / det;
  const B = det3(sxx, rx, sx, sxy, ry, sy, sx, rz, n) / det;
  const C = det3(sxx, sxy, rx, sxy, syy, ry, sx, sy, rz) / det;
  const center = { x: -A / 2, y: -B / 2 };
  const radiusSq = center.x * center.x + center.y * center.y - C;
  if (radiusSq <= EPS) return null;
  return { center, radius: Math.sqrt(radiusSq) };
}

function withinTolerance(points: readonly Point[], circle: { center: Point; radius: number }, tolerance: number): boolean {
  for (const p of points) {
    if (Math.abs(dist(p, circle.center) - circle.radius) > tolerance) return false;
  }
  return true;
}

/**
 * The largest fraction any two *consecutive* points in a candidate run are
 * allowed to be apart, relative to the fitted circle's radius — the guard
 * against the false positive that motivated it: any 4+ points spaced far
 * apart around a circle (a square's corners are exactly concyclic; so are
 * a pentagon's or hexagon's) fit a circle and can sit well within a loose
 * tolerance of it, but that doesn't mean the *polyline edges between them*
 * traced an arc — a straight chord between two 90°-apart points isn't a
 * curve. A real tessellated curve samples far more densely than this
 * (single-digit degrees per step); 0.35 (≈20°) comfortably clears that
 * while still rejecting an octagon's 45° corner spacing.
 */
const MAX_CHORD_TO_RADIUS = 0.35;

function chordsPlausibleForArc(points: readonly Point[], circle: { center: Point; radius: number }): boolean {
  const maxChord = MAX_CHORD_TO_RADIUS * circle.radius;
  for (let i = 0; i < points.length - 1; i++) {
    if (dist(points[i], points[i + 1]) > maxChord) return false;
  }
  return true;
}

/**
 * A bulge's included angle blows up (`tan(θ/4)`) as θ approaches a full
 * turn, so a run is capped well short of 360° — a dense circle should come
 * back as a couple of well-behaved arcs, never one segment with an
 * enormous bulge (and never a literal 360°, which a single bulge can't
 * represent at all). Summed as signed per-step deltas around the fitted
 * center, not the raw angle between the run's endpoints, so a run that
 * doubles back on itself can't be mistaken for a short sweep.
 */
const MAX_ARC_SWEEP = (170 * Math.PI) / 180;

function sweepPlausibleForArc(points: readonly Point[], circle: { center: Point; radius: number }): boolean {
  let total = 0;
  let prevAngle = Math.atan2(points[0].y - circle.center.y, points[0].x - circle.center.x);
  for (let i = 1; i < points.length; i++) {
    const angle = Math.atan2(points[i].y - circle.center.y, points[i].x - circle.center.x);
    total += Math.abs(shortestTurn(angle - prevAngle));
    prevAngle = angle;
  }
  return total <= MAX_ARC_SWEEP;
}

export interface ArcFitResult {
  points: Point[];
  /** One entry per segment between consecutive `points` (wrapping once more if the run is closed); 0 for straight. */
  bulges: number[];
}

/**
 * Replaces maximal consecutive runs of `points` that lie on a common circle
 * (within `tolerance`) with a single bulge-arc segment — the second half of
 * P-03, run after RDP has already thinned the straight stretches. `closed`
 * treats the run as wrapping from the last point back to the first.
 *
 * A run has to reach `minRunPoints` (default 4: at least 3 segments) before
 * it's accepted as an arc — any 3 points fit *some* circle exactly, so
 * requiring a 4th point that's still within tolerance is what actually
 * confirms the points are circular rather than just locally curved noise.
 */
export function fitArcRuns(points: readonly Point[], closed: boolean, tolerance: number, minRunPoints = 4): ArcFitResult {
  const n = points.length;
  const segCount = closed ? n : n - 1;
  if (n === 0) return { points: [], bulges: [] };
  if (n < minRunPoints || segCount <= 0) {
    return { points: points.slice(), bulges: new Array(Math.max(0, segCount)).fill(0) };
  }
  const at = (i: number) => points[((i % n) + n) % n];
  const outPoints: Point[] = [at(0)];
  const outBulges: number[] = [];
  let i = 0;
  while (i < segCount) {
    let bestEnd = -1;
    let bestCircle: { center: Point; radius: number } | null = null;
    // Absolute end index a run starting at `i` may reach. For a closed
    // ring, `end === segCount` (=== n) means "closes back onto the ring's
    // very first point" — a real, non-degenerate endpoint for any run that
    // doesn't itself start there. Only the run that starts at the ring's
    // own first point (i === 0) must stop one short of that, or its last
    // "arc" would run from point 0 back to point 0: a zero-length chord,
    // and a bulge can't represent a full 360° sweep as one segment anyway.
    const maxEnd = closed && i === 0 ? segCount - 1 : segCount;
    if (i + minRunPoints - 1 <= maxEnd) {
      let end = i + minRunPoints - 1;
      for (;;) {
        const window: Point[] = [];
        for (let k = i; k <= end; k++) window.push(at(k));
        const circle = fitCircle(window);
        if (
          !circle ||
          !withinTolerance(window, circle, tolerance) ||
          !chordsPlausibleForArc(window, circle) ||
          !sweepPlausibleForArc(window, circle)
        )
          break;
        bestEnd = end;
        bestCircle = circle;
        if (end >= maxEnd) break;
        end += 1;
      }
    }
    if (bestEnd > i && bestCircle) {
      const startPt = at(i);
      const endPt = at(bestEnd);
      const viaPt = at(i + Math.max(1, Math.floor((bestEnd - i) / 2)));
      const bulge = bulgeFrom3Points(startPt, viaPt, endPt);
      outBulges.push(bulge);
      outPoints.push(endPt);
      i = bestEnd;
    } else {
      outBulges.push(0);
      outPoints.push(at(i + 1));
      i += 1;
    }
  }
  if (closed) outPoints.pop(); // drop the duplicated closing point — PolylineEntity stores it implicitly
  return { points: outPoints, bulges: outBulges };
}

/** `chordTol`-tessellated points along one polyline segment (straight or bulged), not including `a` (the caller already has it from the previous segment). */
function flattenSegment(a: Point, b: Point, bulge: number, chordTol: number): Point[] {
  const arc = bulgeToArc(a, b, bulge);
  if (!arc) return [b];
  const { center, radius, startAngle, endAngle, ccw } = arc;
  let sweep = ccw ? endAngle - startAngle : startAngle - endAngle;
  sweep = ((sweep % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
  if (sweep < EPS) return [b];
  const maxTheta = radius > chordTol ? 2 * Math.acos(1 - Math.min(1, chordTol / radius)) : Math.PI;
  const steps = Math.max(1, Math.ceil(sweep / Math.max(maxTheta, 1e-6)));
  const pts: Point[] = [];
  for (let k = 1; k <= steps; k++) {
    if (k === steps) {
      pts.push(b);
    } else {
      const t = ccw ? startAngle + sweep * (k / steps) : startAngle - sweep * (k / steps);
      pts.push(arcPointAt(center, radius, t));
    }
  }
  return pts;
}

/** A polyline's boundary as plain points, tessellating any existing bulge segments finely first — the common starting point for both RDP and arc-fitting, regardless of what the source polyline already looked like. */
export function flattenPolylineToPoints(entity: PolylineEntity, chordTol = 0.02): Point[] {
  const segs = polylineSegments(entity);
  if (segs.length === 0) return entity.points.slice();
  const out: Point[] = [segs[0].a];
  for (const seg of segs) out.push(...flattenSegment(seg.a, seg.b, seg.bulge, chordTol));
  if (entity.closed) out.pop(); // last flattened point duplicates segs[0].a for a closed loop
  return out;
}

/**
 * Simplifies one polyline to `tolerance` (mm): flatten to dense points,
 * Ramer–Douglas–Peucker, then fit arcs to what survives. Returns the same
 * entity (by reference) unchanged if there's nothing to simplify (too few
 * points, or nothing within tolerance to drop) — callers should compare by
 * reference to skip a no-op undo entry.
 */
export function simplifyPolylineEntity(entity: PolylineEntity, tolerance: number): PolylineEntity {
  if (entity.points.length < 3) return entity;
  const dense = flattenPolylineToPoints(entity, Math.min(tolerance / 4, 0.05));
  const reduced = entity.closed ? simplifyClosedRing(dense, tolerance) : simplifyOpenRun(dense, tolerance);
  const { points, bulges } = fitArcRuns(reduced, entity.closed, tolerance);
  // No improvement (a short or already-minimal polyline, or one whose
  // straight/arc structure the fit can't beat) — return the same object by
  // reference so the caller can skip a no-op undo entry.
  if (points.length >= entity.points.length) return entity;
  return { ...entity, points, bulges: bulges.some((b) => b !== 0) ? bulges : undefined };
}

/**
 * Commands to simplify every polyline in `entities` to `tolerance` (mm) —
 * the selection action ("Simplify polyline"). A polyline that's already at
 * or below its simplified point count is left alone entirely, so running
 * this twice, or on a selection that includes non-polylines, is a no-op
 * for anything that doesn't need it.
 */
export function simplifyPolylineCommands(entities: readonly Entity[], tolerance: number): Command[] {
  const commands: Command[] = [];
  for (const e of entities) {
    if (e.type !== "polyline") continue;
    const simplified = simplifyPolylineEntity(e, tolerance);
    if (simplified === e) continue;
    commands.push({ type: "delete-entities", ids: [e.id] });
    commands.push({ type: "add-entity", entity: { ...simplified, id: newEntityId() } });
  }
  return commands;
}

/**
 * How many polylines in `entities` would actually lose points at `tolerance`
 * (mm) - what the import banner offers to simplify (P-03b). Polylines under
 * `minPoints` vertices are skipped without being fitted, so counting a large
 * import stays cheap.
 */
export function countSimplifiable(entities: Iterable<Entity>, tolerance: number, minPoints = 8): number {
  let n = 0;
  for (const e of entities) {
    if (e.type !== "polyline" || e.points.length < minPoints) continue;
    if (simplifyPolylineEntity(e, tolerance) !== e) n++;
  }
  return n;
}
