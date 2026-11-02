import type { Entity, Point, SketchDocument } from "@sketchor/core";
import {
  arcPointAt,
  arcSweep,
  bulgeToArc,
  closestParam,
  closestPointOnSegment,
  dist,
  entityPoints,
  exactPathOf,
  perpendicularTangentPoints,
  imageCorners,
  intersectCurves,
  kindPath,
  kindSnaps,
  mid,
  pathOf,
  polylineSegments,
  type Curve,
  type XCurve,
} from "@sketchor/core";
import { gridStep, type View } from "./view";

/**
 * Snap kinds (roadmap T-21). Tiered: feature points beat midpoints beat
 * on-curve beat extension beat the grid — see findSnap. "perpendicular"
 * and "tangent" need an anchor (the tool's last pick) and only appear when
 * one is given. "tracking" is not found here: the viewport produces it
 * when ortho/polar projected the cursor (tools/tracking.ts).
 */
export type SnapKind =
  | "origin"
  | "endpoint"
  | "midpoint"
  | "center"
  | "quadrant"
  | "intersection"
  | "node"
  | "perpendicular"
  | "tangent"
  | "on-line"
  | "extension"
  | "grid"
  | "tracking";

export interface Snap {
  point: Point;
  kind: SnapKind;
  /** For an extension snap: the endpoint the guide ray is drawn from. */
  guideFrom?: Point;
}

/** Which snap kinds are on (T-21's per-kind switches). Persisted; see snapSettings.ts. */
export type SnapSettings = Record<Exclude<SnapKind, "origin" | "tracking">, boolean>;

export const ALL_SNAPS_ON: SnapSettings = {
  endpoint: true,
  midpoint: true,
  center: true,
  quadrant: true,
  intersection: true,
  node: true,
  perpendicular: true,
  tangent: true,
  "on-line": true,
  extension: true,
  grid: true,
};

export interface SnapOptions {
  /** Entities that must not act as targets (a selection being dragged). */
  exclude?: readonly string[];
  /** The tool's previous pick — what perpendicular and tangent snaps are measured from. */
  anchor?: Point | null;
  settings?: SnapSettings;
  /** L-01: only entities passing this are snap targets (the space - model or one layout - being drawn in). */
  entityFilter?: (e: Entity) => boolean;
}

/** Pick aperture, in pixels — also what object snap tracking uses for "lines up with". */
export const SNAP_PX = 10;

/**
 * Finds the best snap near a world-space cursor position, in priority tiers:
 * specific feature points (endpoint/center/quadrant/intersection) win over
 * the generic midpoint, which wins over a nearest-point-on-curve fallback,
 * which itself wins over the always-available grid point. Without tiering, a
 * "closest point on this line" candidate would almost always out-distance a
 * feature point sitting further along the same line, making corners and
 * centers effectively unreachable.
 */
export function findSnap(doc: SketchDocument, view: View, cursor: Point, options: SnapOptions | readonly string[] = {}): Snap {
  const opts: SnapOptions = Array.isArray(options) ? { exclude: options as readonly string[] } : (options as SnapOptions);
  const on = opts.settings ?? ALL_SNAPS_ON;
  const excludeIds = opts.exclude;
  const tol = SNAP_PX / view.scale;
  // While dragging a selection, its own geometry must not act as a snap target
  // — it moves with the cursor, so it would snap to itself and pin the drag.
  const inSpace = opts.entityFilter;
  const entities = excludeIds?.length || inSpace ? doc.all().filter((e) => (!inSpace || inSpace(e)) && !excludeIds?.includes(e.id)) : doc.all();

  const bestOf = (candidates: Snap[]): Snap | null => {
    let best: Snap | null = null;
    let bestDist = tol;
    for (const c of candidates) {
      if (c.kind !== "origin" && !on[c.kind as keyof SnapSettings]) continue;
      const d = dist(c.point, cursor);
      if (d <= bestDist) {
        best = c;
        bestDist = d;
      }
    }
    return best;
  };

  // The world origin is always snappable, even in an empty drawing — it's the
  // one reference point that exists before any geometry does.
  const featurePoints: Snap[] = [{ point: { x: 0, y: 0 }, kind: "origin" }];
  const midpoints: Snap[] = [];
  const onCurve: Snap[] = [];
  const extensions: Snap[] = [];

  for (const e of entities) {
    // Feature and midpoint snaps come from the entity's kind (kinds/builtin.ts,
    // or a registered plugin kind); only the cursor-dependent "nearest point
    // along" candidates are worked out here.
    for (const s of kindSnaps(e)) (s.kind === "midpoint" ? midpoints : featurePoints).push(s);
    if (e.type === "line") {
      onCurve.push({ point: closestPointOnSegment(cursor, e.a, e.b), kind: "on-line" });
    } else if (e.type === "polyline") {
      for (const seg of polylineSegments(e)) {
        if (!bulgeToArc(seg.a, seg.b, seg.bulge)) {
          onCurve.push({ point: closestPointOnSegment(cursor, seg.a, seg.b), kind: "on-line" });
        }
      }
    } else if (e.type !== "circle" && e.type !== "arc" && e.type !== "point" && e.type !== "text" && e.type !== "image") {
      // A kind outside the built-in seven: nearest point on each straight piece of its outline.
      for (const c of kindPath(e)?.curves ?? []) {
        if (c.kind === "segment") onCurve.push({ point: closestPointOnSegment(cursor, c.a, c.b), kind: "on-line" });
      }
    }
  }

  // Curve-level snaps: intersections (any pair of segments/arcs/circles),
  // the nearest point on arcs and circles, perpendicular/tangent from the
  // anchor, and line extensions. Only curves whose bounding box is near the
  // cursor take part, so this stays cheap on a large drawing.
  // Ellipses and splines take part as ONE exact curve (C-08), not a chain of chords.
  const nearby: XCurve[] = [];
  const lines: { a: Point; b: Point }[] = [];
  for (const e of entities) {
    const path = e.type === "ellipse" || e.type === "spline" ? exactPathOf(e) : pathOf(e);
    if (!path) continue;
    for (const c of path.curves) {
      if (curveNear(c, cursor, tol)) nearby.push(c);
      if (c.kind === "segment") lines.push({ a: c.a, b: c.b });
    }
  }
  for (let i = 0; i < nearby.length; i++) {
    for (let j = i + 1; j < nearby.length; j++) {
      for (const hit of intersectCurves(nearby[i], nearby[j])) featurePoints.push({ point: hit.point, kind: "intersection" });
    }
  }
  for (const c of nearby) {
    if (c.kind !== "segment") onCurve.push({ point: closestParam(c, cursor).point, kind: "on-line" });
  }
  const anchor = opts.anchor ?? null;
  if (anchor) {
    for (const c of nearby) {
      if (c.kind === "ellipse" || c.kind === "nurbs") {
        const pt = perpendicularTangentPoints(c, anchor);
        for (const p of pt.perpendicular) featurePoints.push({ point: p, kind: "perpendicular" });
        for (const p of pt.tangent) featurePoints.push({ point: p, kind: "tangent" });
        continue;
      }
      if (c.kind !== "segment" && c.kind !== "arc") continue;
      for (const p of perpendicularFeet(c, anchor)) featurePoints.push({ point: p, kind: "perpendicular" });
      for (const p of tangentPoints(c, anchor)) featurePoints.push({ point: p, kind: "tangent" });
    }
  }
  // A line's extension: the foot of the cursor on its infinite line, when
  // that foot lies past one of its ends — with the guide drawn from that end.
  for (const l of lines) {
    const dx = l.b.x - l.a.x;
    const dy = l.b.y - l.a.y;
    const len2 = dx * dx + dy * dy;
    if (len2 < 1e-18) continue;
    const t = ((cursor.x - l.a.x) * dx + (cursor.y - l.a.y) * dy) / len2;
    if (t >= 0 && t <= 1) continue;
    const foot = { x: l.a.x + dx * t, y: l.a.y + dy * t };
    if (dist(foot, cursor) > tol) continue;
    // Not unboundedly far: within three lengths of the line, as AutoCAD's aperture in practice.
    if (t < -3 || t > 4) continue;
    extensions.push({ point: foot, kind: "extension", guideFrom: t < 0 ? l.a : l.b });
  }

  const snap = bestOf(featurePoints) ?? bestOf(midpoints) ?? bestOf(onCurve) ?? bestOf(extensions);
  if (snap) return snap;

  if (!on.grid) return { point: cursor, kind: "grid" };
  const step = gridStep(view.scale);
  return {
    point: {
      x: Math.round(cursor.x / step) * step,
      y: Math.round(cursor.y / step) * step,
    },
    kind: "grid",
  };
}

/** Cheap bounding-box test: is any part of the curve within `tol` of the cursor? */
function curveNear(c: XCurve, cursor: Point, tol: number): boolean {
  if (c.kind === "ellipse" || c.kind === "nurbs") return closestParam(c, cursor).distance <= tol * 1.5;
  if (c.kind === "segment") {
    return (
      cursor.x >= Math.min(c.a.x, c.b.x) - tol &&
      cursor.x <= Math.max(c.a.x, c.b.x) + tol &&
      cursor.y >= Math.min(c.a.y, c.b.y) - tol &&
      cursor.y <= Math.max(c.a.y, c.b.y) + tol
    );
  }
  return Math.abs(dist(cursor, c.center) - c.radius) <= tol * 1.5;
}

/** Feet of the perpendicular from `from` onto the curve (within its extent). */
export function perpendicularFeet(c: Curve, from: Point): Point[] {
  if (c.kind === "segment") {
    const foot = closestPointOnSegment(from, c.a, c.b);
    // Only a true foot (not clamped to an end) is a perpendicular snap.
    const dx = c.b.x - c.a.x;
    const dy = c.b.y - c.a.y;
    const len2 = dx * dx + dy * dy;
    if (len2 < 1e-18) return [];
    const t = ((from.x - c.a.x) * dx + (from.y - c.a.y) * dy) / len2;
    return t > 1e-9 && t < 1 - 1e-9 ? [foot] : [];
  }
  const d = dist(from, c.center);
  if (d < 1e-9) return [];
  const ux = (from.x - c.center.x) / d;
  const uy = (from.y - c.center.y) / d;
  const out: Point[] = [];
  for (const sgn of [1, -1]) {
    const p = { x: c.center.x + ux * c.radius * sgn, y: c.center.y + uy * c.radius * sgn };
    if (closestParam(c, p).distance < 1e-6) out.push(p);
  }
  return out;
}

/** Points on a circle/arc where a line from `from` is tangent to it (none for a segment, or from inside the circle). */
export function tangentPoints(c: Curve, from: Point): Point[] {
  if (c.kind !== "arc") return [];
  const d = dist(from, c.center);
  if (d <= c.radius + 1e-9) return [];
  const base = Math.atan2(from.y - c.center.y, from.x - c.center.x);
  const alpha = Math.acos(c.radius / d);
  const out: Point[] = [];
  for (const a of [base + alpha, base - alpha]) {
    const p = arcPointAt(c.center, c.radius, a);
    if (closestParam(c, p).distance < 1e-6) out.push(p);
  }
  return out;
}

/** 45° in radians — the step a rotate-drag snaps to. */
const ANGLE_STEP = Math.PI / 4;

/** Rounds a rotation (radians) to the nearest 45°, unless `free` (Ctrl held). */
export function snapRotation(radians: number, free: boolean): number {
  return free ? radians : Math.round(radians / ANGLE_STEP) * ANGLE_STEP;
}

/**
 * Corner / endpoint / centre points of every entity except `excludeIds`, plus
 * the world origin — the anchors a dragged selection can align to.
 */
function featureAnchors(doc: SketchDocument, excludeIds: readonly string[]): Point[] {
  const out: Point[] = [{ x: 0, y: 0 }];
  for (const e of doc.all()) {
    if (excludeIds.includes(e.id)) continue;
    if (e.type === "line") {
      out.push(e.a, e.b);
    } else if (e.type === "circle") {
      const { center: c, radius: r } = e;
      out.push(
        c,
        { x: c.x + r, y: c.y },
        { x: c.x - r, y: c.y },
        { x: c.x, y: c.y + r },
        { x: c.x, y: c.y - r },
      );
    } else if (e.type === "point") {
      out.push(e.p);
    } else if (e.type === "text") {
      out.push(e.at);
    } else if (e.type === "arc") {
      out.push(
        e.center,
        arcPointAt(e.center, e.radius, e.startAngle),
        arcPointAt(e.center, e.radius, e.endAngle),
      );
    } else if (e.type === "image") {
      out.push(...imageCorners(e));
    } else if (e.type === "polyline") {
      for (const p of e.points) out.push(p);
    } else {
      out.push(...entityPoints(e));
    }
  }
  return out;
}

/**
 * Given a selection being dragged by `(rawDx, rawDy)`, returns the offset to
 * actually apply. The two axes snap **independently**: `dx` is nudged by the
 * smallest correction that lands some dragged vertex exactly on some anchor's x,
 * and `dy` likewise for y. Snapping the axes apart is what lets one edge slide
 * flush along another (only one axis catches) while a corner still locks when
 * both catch at once — "snap to a corner, or to two lines at the same time".
 *
 * `baseVertices` are the selection's vertices at grab time (world space);
 * `excludeIds` is the selection itself, so it never snaps to its own geometry.
 */
export function snapMovingSelection(
  doc: SketchDocument,
  view: View,
  baseVertices: readonly Point[],
  rawDx: number,
  rawDy: number,
  excludeIds: readonly string[],
): { dx: number; dy: number } {
  const tol = SNAP_PX / view.scale;
  const anchors = featureAnchors(doc, excludeIds);
  let dxAdj = 0;
  let dyAdj = 0;
  let bestX = tol;
  let bestY = tol;
  for (const v of baseVertices) {
    const mx = v.x + rawDx;
    const my = v.y + rawDy;
    for (const a of anchors) {
      const ex = Math.abs(a.x - mx);
      if (ex < bestX) {
        bestX = ex;
        dxAdj = a.x - mx;
      }
      const ey = Math.abs(a.y - my);
      if (ey < bestY) {
        bestY = ey;
        dyAdj = a.y - my;
      }
    }
  }
  return { dx: rawDx + dxAdj, dy: rawDy + dyAdj };
}
