import type { PolylineEntity } from "./entities";
import { bulgeToArc, type Point } from "./geometry";

/**
 * T-27 multifunction vertex grip (AutoCAD's hover menu): the edits offered
 * on a polyline vertex besides dragging it. Pure — the viewport shows the
 * menu and runs the result as one `update-entity`.
 *
 * Vertex `i` owns the segment that starts there (`points[i]` to
 * `points[i+1]`), so "add vertex" and "convert" act on that segment; a last
 * vertex of an open polyline owns none.
 */

export type GripMenuAction = "add" | "remove" | "arc" | "line";

/** Bulge of a quarter-circle: the default arc a straight segment turns into. */
export const DEFAULT_ARC_BULGE = Math.tan(Math.PI / 8);

const segmentCount = (e: PolylineEntity): number => (e.closed ? e.points.length : e.points.length - 1);
const bulgeOf = (e: PolylineEntity, i: number): number => e.bulges?.[i] ?? 0;
const hasBulge = (b: number[]): boolean => b.some((x) => Math.abs(x) > 1e-12);

/** Bulges padded to one per segment, so inserting and removing stay index-aligned. */
function paddedBulges(e: PolylineEntity): number[] {
  return Array.from({ length: segmentCount(e) }, (_, i) => bulgeOf(e, i));
}

/** `e` with `points` and per-segment `bulges` replaced; the bulges array is dropped when all are straight. */
function rebuilt(e: PolylineEntity, points: Point[], bulges: number[]): PolylineEntity {
  const { bulges: _old, ...rest } = e;
  return hasBulge(bulges) ? { ...rest, points, bulges } : { ...rest, points };
}

/** Which menu actions apply at vertex `i`, in menu order. Empty for a bad index. */
export function gripMenuActions(e: PolylineEntity, i: number): GripMenuAction[] {
  if (!Number.isInteger(i) || i < 0 || i >= e.points.length) return [];
  const out: GripMenuAction[] = [];
  const ownsSegment = i < segmentCount(e);
  const chord = ownsSegment ? Math.hypot(e.points[(i + 1) % e.points.length].x - e.points[i].x, e.points[(i + 1) % e.points.length].y - e.points[i].y) : 0;
  if (ownsSegment && chord > 1e-9) out.push("add");
  if (polylineRemoveVertex(e, i)) out.push("remove");
  if (ownsSegment && chord > 1e-9) out.push(Math.abs(bulgeOf(e, i)) > 1e-9 ? "line" : "arc");
  return out;
}

/** Adds a vertex in the middle of the segment that starts at vertex `i` (an arc segment is split into two equal arcs). Null when there is no such segment or it has no length. */
export function polylineAddVertex(e: PolylineEntity, i: number): PolylineEntity | null {
  if (!Number.isInteger(i) || i < 0 || i >= segmentCount(e)) return null;
  const n = e.points.length;
  const a = e.points[i];
  const b = e.points[(i + 1) % n];
  if (Math.hypot(b.x - a.x, b.y - a.y) < 1e-9) return null;
  const bulge = bulgeOf(e, i);
  let mid: Point = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
  let half = 0;
  const arc = bulgeToArc(a, b, bulge);
  if (arc) {
    // Midpoint of the arc itself: half-way along the signed sweep.
    const theta = 4 * Math.atan(bulge);
    const startAngle = Math.atan2(a.y - arc.center.y, a.x - arc.center.x);
    const midAngle = startAngle + theta / 2;
    mid = { x: arc.center.x + arc.radius * Math.cos(midAngle), y: arc.center.y + arc.radius * Math.sin(midAngle) };
    half = Math.tan(theta / 8);
  }
  const points = [...e.points.slice(0, i + 1), mid, ...e.points.slice(i + 1)];
  const bulges = paddedBulges(e);
  bulges.splice(i, 1, half, half);
  return rebuilt(e, points, bulges);
}

/**
 * Removes vertex `i`; the two segments around it join into one straight
 * segment. Null when too few vertices would remain (an open polyline keeps 2,
 * a closed one 3).
 */
export function polylineRemoveVertex(e: PolylineEntity, i: number): PolylineEntity | null {
  const n = e.points.length;
  if (!Number.isInteger(i) || i < 0 || i >= n) return null;
  if (n - 1 < (e.closed ? 3 : 2)) return null;
  const points = e.points.filter((_, k) => k !== i);
  const old = paddedBulges(e);
  let bulges: number[];
  if (e.closed) {
    // Segments i-1 and i merge; keep the slot of i-1 (wrapping), straight.
    const prev = (i - 1 + n) % n;
    bulges = old.map((b, k) => (k === prev ? 0 : b)).filter((_, k) => k !== i);
  } else if (i === 0) {
    bulges = old.slice(1);
  } else if (i === n - 1) {
    bulges = old.slice(0, n - 2);
  } else {
    bulges = old.map((b, k) => (k === i - 1 ? 0 : b)).filter((_, k) => k !== i);
  }
  return rebuilt(e, points, bulges);
}

/** Turns the segment that starts at vertex `i` into an arc (`bulge`, default a quarter circle) or back into a straight line (`bulge` 0). */
export function polylineSetSegmentBulge(e: PolylineEntity, i: number, bulge: number): PolylineEntity | null {
  if (!Number.isInteger(i) || i < 0 || i >= segmentCount(e) || !Number.isFinite(bulge)) return null;
  const a = e.points[i];
  const b = e.points[(i + 1) % e.points.length];
  if (Math.hypot(b.x - a.x, b.y - a.y) < 1e-9) return null;
  const bulges = paddedBulges(e);
  bulges[i] = bulge;
  return rebuilt(e, e.points, bulges);
}

/** Runs one menu action on vertex `i`; null when it does not apply. */
export function applyGripMenuAction(e: PolylineEntity, i: number, action: GripMenuAction): PolylineEntity | null {
  switch (action) {
    case "add":
      return polylineAddVertex(e, i);
    case "remove":
      return polylineRemoveVertex(e, i);
    case "arc":
      return polylineSetSegmentBulge(e, i, DEFAULT_ARC_BULGE);
    case "line":
      return polylineSetSegmentBulge(e, i, 0);
  }
}

/** Menu label for an action. */
export function gripMenuLabel(action: GripMenuAction): string {
  return { add: "Add vertex", remove: "Remove vertex", arc: "Convert to arc", line: "Convert to line" }[action];
}
