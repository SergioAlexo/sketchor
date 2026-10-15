import { boundsOf } from "../dxf";
import type {
  ArcEntity,
  CircleEntity,
  EllipseEntity,
  Entity,
  HatchEntity,
  ImageEntity,
  LineEntity,
  PointEntity,
  PolylineEntity,
  SplineEntity,
  TextEntity,
} from "../entities";
import {
  distToEllipse,
  ellipseBounds,
  ellipseHasParam,
  ellipseParamOfPoint,
  ellipsePointAt,
  ellipseSweep,
  isFullEllipse,
  minorAxisOf,
  pointInEllipse,
  tessellateEllipse,
  transformEllipse,
} from "../ellipse";
import { hatchBounds, hatchContains, hatchPolygons, transformLoop } from "../hatch/loops";
import { applySplineGrip, splineGrips, splineSnaps, splineTransform } from "../spline";
import { distToNurbs, nurbsBounds, tessellateNurbs } from "../nurbs";
import { imageCorners, polylineSegments, textCorners } from "../entities";
import type { Point } from "../geometry";
import { arcPointAt, arcSweep, bulgeToArc, dist, distToArc, distToSegment, mid } from "../geometry";
import { applyGrip, gripsOf, type Grip } from "../grips";
import { pathOf } from "../intersect";
import { pointInPolygon } from "../regions";
import { flattenPolylineToPoints } from "../simplify";
import { insertKind } from "./insert";
import { dimensionKind } from "./dimension";
import { mtextKind } from "./mtext";
import { mapPoint, similarity } from "./affine";
import { DEFAULT_TESSELLATION_TOL, registerKind, type Affine, type EntityKind, type KindSnap } from "./registry";

/**
 * The seven built-in kinds, registered by moving in what used to be a
 * `switch (entity.type)` in each generic consumer (hit testing lived in
 * Viewport.tsx, feature points in snapping.ts, bounds in dxf.ts). Behaviour
 * is unchanged; the point is that a new kind now plugs into the same slots.
 *
 * Importing this module registers them — `index.ts` does so for the package.
 */

/* --------------------------------- helpers --------------------------------- */

/** Points along an arc so no chord strays further than `tol` from the curve. */
function sampleArc(center: Point, radius: number, start: number, end: number, ccw: boolean, tol: number, full = false): Point[] {
  const sweep = full ? TAU : arcSweep(start, end, ccw);
  const maxStep = radius > tol ? 2 * Math.acos(1 - Math.min(1, tol / radius)) : Math.PI / 2;
  const steps = Math.max(full ? 8 : 2, Math.ceil(sweep / Math.max(maxStep, 1e-3)));
  const out: Point[] = [];
  for (let i = 0; i <= steps; i++) {
    const t = ccw ? start + sweep * (i / steps) : start - sweep * (i / steps);
    out.push(arcPointAt(center, radius, t));
  }
  return out;
}

const TAU = Math.PI * 2;

const closedRun = (pts: Point[]): Point[] => [...pts, pts[0]];

/* ---------------------------------- kinds ---------------------------------- */

const lineKind: EntityKind<LineEntity> = {
  type: "line",
  tessellate: (e) => [[e.a, e.b]],
  bounds: (e) => boundsOf([e]),
  transform: (e, m) => ({ ...e, a: mapPoint(m, e.a), b: mapPoint(m, e.b) }),
  path: pathOf,
  snaps: (e): KindSnap[] => [
    { point: e.a, kind: "endpoint" },
    { point: e.b, kind: "endpoint" },
    { point: mid(e.a, e.b), kind: "midpoint" },
  ],
  grips: gripsOf,
  applyGrip: (e, g, to) => applyGrip(e, g, to) as LineEntity,
  hitDistance: (e, p) => distToSegment(p, e.a, e.b),
};

const circleKind: EntityKind<CircleEntity> = {
  type: "circle",
  tessellate: (e, tol) => [sampleArc(e.center, e.radius, 0, TAU, true, tol, true)],
  bounds: (e) => boundsOf([e]),
  transform: (e, m) => {
    const s = similarity(m);
    return s ? { ...e, center: mapPoint(m, e.center), radius: e.radius * s.scale } : null;
  },
  path: pathOf,
  snaps: (e): KindSnap[] => {
    const { center: c, radius: r } = e;
    return [
      { point: c, kind: "center" },
      { point: { x: c.x + r, y: c.y }, kind: "quadrant" },
      { point: { x: c.x - r, y: c.y }, kind: "quadrant" },
      { point: { x: c.x, y: c.y + r }, kind: "quadrant" },
      { point: { x: c.x, y: c.y - r }, kind: "quadrant" },
    ];
  },
  grips: gripsOf,
  applyGrip: (e, g, to) => applyGrip(e, g, to) as CircleEntity,
  // A hatch-filled circle (e.g. a round pallet) is clickable anywhere inside it,
  // not just on its rim — matching how a solid shape behaves in every other drawing app.
  hitDistance: (e, p) => (e.fill && dist(p, e.center) <= e.radius ? 0 : Math.abs(dist(p, e.center) - e.radius)),
};

const arcKind: EntityKind<ArcEntity> = {
  type: "arc",
  tessellate: (e, tol) => [sampleArc(e.center, e.radius, e.startAngle, e.endAngle, e.ccw, tol)],
  bounds: (e) => boundsOf([e]),
  transform: (e, m) => {
    const s = similarity(m);
    if (!s) return null;
    // A mirror flips the sweep direction: x-axis reflection then rotation maps angle φ to rotation − φ.
    const map = (a: number): number => (s.mirrored ? s.rotation - a : a + s.rotation);
    return {
      ...e,
      center: mapPoint(m, e.center),
      radius: e.radius * s.scale,
      startAngle: map(e.startAngle),
      endAngle: map(e.endAngle),
      ccw: s.mirrored ? !e.ccw : e.ccw,
    };
  },
  path: pathOf,
  snaps: (e): KindSnap[] => {
    const sweep = arcSweep(e.startAngle, e.endAngle, e.ccw);
    const midAngle = e.ccw ? e.startAngle + sweep / 2 : e.startAngle - sweep / 2;
    return [
      { point: e.center, kind: "center" },
      { point: arcPointAt(e.center, e.radius, e.startAngle), kind: "endpoint" },
      { point: arcPointAt(e.center, e.radius, e.endAngle), kind: "endpoint" },
      { point: arcPointAt(e.center, e.radius, midAngle), kind: "midpoint" },
    ];
  },
  grips: gripsOf,
  applyGrip: (e, g, to) => applyGrip(e, g, to) as ArcEntity,
  hitDistance: (e, p) => distToArc(p, e.center, e.radius, e.startAngle, e.endAngle, e.ccw),
};

const pointKind: EntityKind<PointEntity> = {
  type: "point",
  tessellate: (e) => [[e.p]],
  bounds: (e) => boundsOf([e]),
  transform: (e, m) => ({ ...e, p: mapPoint(m, e.p) }),
  path: () => null,
  snaps: (e): KindSnap[] => [{ point: e.p, kind: "node" }],
  grips: gripsOf,
  applyGrip: (e, g, to) => applyGrip(e, g, to) as PointEntity,
  hitDistance: (e, p) => dist(p, e.p),
};

const ellipseKind: EntityKind<EllipseEntity> = {
  type: "ellipse",
  tessellate: (e, tol) => [tessellateEllipse(e, tol)],
  bounds: (e) => ellipseBounds(e),
  transform: (e, m) => {
    const g = transformEllipse(e, m);
    return g ? { ...e, ...g } : null;
  },
  // No exact ellipse curve in intersect.ts yet (C-08): trim/offset/etc. see it as a fine segment chain.
  snaps: (e): KindSnap[] => {
    const out: KindSnap[] = [{ point: e.center, kind: "center" }];
    const n = minorAxisOf(e);
    const axisEnds = [
      { x: e.center.x + e.majorAxis.x, y: e.center.y + e.majorAxis.y },
      { x: e.center.x + n.x, y: e.center.y + n.y },
      { x: e.center.x - e.majorAxis.x, y: e.center.y - e.majorAxis.y },
      { x: e.center.x - n.x, y: e.center.y - n.y },
    ];
    axisEnds.forEach((p, i) => {
      if (ellipseHasParam(e, (i * Math.PI) / 2)) out.push({ point: p, kind: "quadrant" });
    });
    if (!isFullEllipse(e)) {
      out.push({ point: ellipsePointAt(e, e.start), kind: "endpoint" });
      out.push({ point: ellipsePointAt(e, e.start + ellipseSweep(e)), kind: "endpoint" });
      out.push({ point: ellipsePointAt(e, e.start + ellipseSweep(e) / 2), kind: "midpoint" });
    }
    return out;
  },
  grips: (e): Grip[] => {
    const n = minorAxisOf(e);
    const c = e.center;
    const grips: Grip[] = [
      { point: c, kind: "center", index: 0 },
      { point: { x: c.x + e.majorAxis.x, y: c.y + e.majorAxis.y }, kind: "quadrant", index: 0 },
      { point: { x: c.x + n.x, y: c.y + n.y }, kind: "quadrant", index: 1 },
      { point: { x: c.x - e.majorAxis.x, y: c.y - e.majorAxis.y }, kind: "quadrant", index: 2 },
      { point: { x: c.x - n.x, y: c.y - n.y }, kind: "quadrant", index: 3 },
    ];
    if (!isFullEllipse(e)) {
      grips.push({ point: ellipsePointAt(e, e.start), kind: "end", index: 0 });
      grips.push({ point: ellipsePointAt(e, e.start + ellipseSweep(e)), kind: "end", index: 1 });
    }
    return grips;
  },
  applyGrip: (e, g, to) => {
    const c = e.center;
    if (g.kind === "center") return { ...e, center: to };
    if (g.kind === "quadrant") {
      const a = Math.hypot(e.majorAxis.x, e.majorAxis.y);
      if (g.index === 0 || g.index === 2) {
        // Stretch the major radius, keeping the ratio and the centre.
        const v = g.index === 0 ? { x: to.x - c.x, y: to.y - c.y } : { x: c.x - to.x, y: c.y - to.y };
        return Math.hypot(v.x, v.y) < 1e-9 ? e : { ...e, majorAxis: v };
      }
      // Minor-axis grips: the ratio follows the cursor's distance along the minor direction.
      const mu = { x: -e.majorAxis.y / a, y: e.majorAxis.x / a };
      const along = Math.abs((to.x - c.x) * mu.x + (to.y - c.y) * mu.y);
      return { ...e, ratio: Math.min(1, Math.max(1e-4, along / a)) };
    }
    // Arc end grips: the parameter of the direction the cursor is in.
    const t = ellipseParamOfPoint(e, to);
    const sweep = ellipseSweep(e);
    if (g.index === 0) {
      const end = e.start + sweep;
      const span = (((end - t) % TAU) + TAU) % TAU;
      return { ...e, start: t, end: t + (span < 1e-9 ? TAU : span) };
    }
    const rel = (((t - e.start) % TAU) + TAU) % TAU;
    return { ...e, end: e.start + (rel < 1e-9 ? TAU : rel) };
  },
  hitDistance: (e, p) => (e.fill && isFullEllipse(e) && pointInEllipse(e, p) ? 0 : distToEllipse(e, p)),
};

const splineKind: EntityKind<SplineEntity> = {
  type: "spline",
  tessellate: (e, tol) => [tessellateNurbs(e, tol)],
  bounds: (e) => nurbsBounds(e),
  transform: (e, m) => splineTransform(e, m),
  // No exact NURBS curve in intersect.ts yet (C-08): edits see the tessellated chain.
  snaps: (e): KindSnap[] => splineSnaps(e),
  grips: (e) => splineGrips(e),
  applyGrip: (e, g, to) => applySplineGrip(e, g, to),
  hitDistance: (e, p) => distToNurbs(e, p),
};

const polylineKind: EntityKind<PolylineEntity> = {
  type: "polyline",
  tessellate: (e, tol) => {
    const pts = flattenPolylineToPoints(e, tol);
    return [e.closed && pts.length > 0 ? closedRun(pts) : pts];
  },
  bounds: (e) => boundsOf([e]),
  transform: (e, m) => {
    const hasBulge = e.bulges?.some((b) => b !== 0) ?? false;
    const s = similarity(m);
    if (hasBulge && !s) return null; // a bulge arc under shear/uneven scale is an ellipse arc
    const flip = s?.mirrored ?? m[0] * m[3] - m[1] * m[2] < 0;
    return {
      ...e,
      points: e.points.map((p) => mapPoint(m, p)),
      ...(e.bulges ? { bulges: flip ? e.bulges.map((b) => -b) : e.bulges } : {}),
    };
  },
  path: pathOf,
  snaps: (e): KindSnap[] => {
    // Every vertex is an endpoint; every segment additionally offers a midpoint (arc segments their centre too).
    const out: KindSnap[] = e.points.map((p) => ({ point: p, kind: "endpoint" as const }));
    for (const seg of polylineSegments(e)) {
      const arc = bulgeToArc(seg.a, seg.b, seg.bulge);
      if (arc) {
        out.push({ point: arc.center, kind: "center" });
        const sweep = arcSweep(arc.startAngle, arc.endAngle, arc.ccw);
        const midAngle = arc.ccw ? arc.startAngle + sweep / 2 : arc.startAngle - sweep / 2;
        out.push({ point: arcPointAt(arc.center, arc.radius, midAngle), kind: "midpoint" });
      } else {
        out.push({ point: mid(seg.a, seg.b), kind: "midpoint" });
      }
    }
    return out;
  },
  grips: gripsOf,
  applyGrip: (e, g, to) => applyGrip(e, g, to) as PolylineEntity,
  hitDistance: (e, p) => {
    // A closed, hatch-filled polyline (e.g. a pallet) is clickable anywhere inside it,
    // not just near its outline — otherwise clicking the middle of a big filled shape selects nothing.
    if (e.closed && e.fill && pointInPolygon(p, e.points)) return 0;
    // Whichever of its segments the cursor is nearest to.
    return Math.min(
      ...polylineSegments(e).map((seg) => {
        const arc = bulgeToArc(seg.a, seg.b, seg.bulge);
        return arc ? distToArc(p, arc.center, arc.radius, arc.startAngle, arc.endAngle, arc.ccw) : distToSegment(p, seg.a, seg.b);
      }),
    );
  },
};

const textKind: EntityKind<TextEntity> = {
  type: "text",
  tessellate: (e) => [closedRun(textCorners(e))],
  bounds: (e) => boundsOf([e]),
  transform: (e, m) => {
    const s = similarity(m);
    if (!s || s.mirrored) return null;
    return { ...e, at: mapPoint(m, e.at), rotation: e.rotation + s.rotation, height: e.height * s.scale };
  },
  path: () => null,
  snaps: (e): KindSnap[] => [{ point: e.at, kind: "endpoint" }],
  grips: gripsOf,
  applyGrip: (e, g, to) => applyGrip(e, g, to) as TextEntity,
  // Anywhere inside the label's box counts (the caller's aperture handles the rim).
  hitDistance: (e, p) => {
    const c = textCorners(e);
    return pointInPolygon(p, c) ? 0 : Math.min(...c.map((q, i) => distToSegment(p, q, c[(i + 1) % c.length])));
  },
};

const imageKind: EntityKind<ImageEntity> = {
  type: "image",
  tessellate: (e) => [closedRun(imageCorners(e))],
  bounds: (e) => boundsOf([e]),
  transform: (e, m) => {
    const s = similarity(m);
    if (!s || s.mirrored) return null;
    return {
      ...e,
      insert: mapPoint(m, e.insert),
      rotation: e.rotation + s.rotation,
      width: e.width * s.scale,
      height: e.height * s.scale,
    };
  },
  path: () => null,
  snaps: (e): KindSnap[] => imageCorners(e).map((p) => ({ point: p, kind: "endpoint" as const })),
  grips: gripsOf,
  applyGrip: (e, g, to) => applyGrip(e, g, to) as ImageEntity,
  hitDistance: (e, p) => (pointInPolygon(p, imageCorners(e)) ? 0 : Infinity),
};

const DEG = 180 / Math.PI;

/** H-01: the boundary loops are the stroke; the pattern/solid paint is the hatch engine's job (hatch/fillLines.ts). */
const hatchKind: EntityKind<HatchEntity> = {
  type: "hatch",
  tessellate: (e, tol) => hatchPolygons(e, tol).map((poly) => [...poly, poly[0]]),
  bounds: (e) => hatchBounds(e),
  transform: (e, m) => {
    const loops = [];
    for (const l of e.loops) {
      const t = transformLoop(l, m);
      if (!t) return null;
      loops.push(t);
    }
    const s = similarity(m);
    const turn = (deg: number): number => (s ? (s.mirrored ? s.rotation * DEG - deg : deg + s.rotation * DEG) : deg);
    let paint = e.paint;
    if (paint.kind === "pattern") {
      if (!s) return null;
      paint = {
        ...paint,
        scale: paint.scale * s.scale,
        angle: turn(paint.angle),
        ...(paint.origin ? { origin: mapPoint(m, paint.origin) } : {}),
      };
    } else if (paint.kind === "gradient") paint = { ...paint, angle: turn(paint.angle) };
    return { ...e, loops, paint };
  },
  // A hatch is an area, not a stroke: it isn't a trim/intersection target.
  path: () => null,
  hitDistance: (e, p) => {
    if (hatchContains(e, p)) return 0;
    let best = Infinity;
    for (const poly of hatchPolygons(e, DEFAULT_TESSELLATION_TOL)) {
      for (let i = 0; i < poly.length; i++) best = Math.min(best, distToSegment(p, poly[i], poly[(i + 1) % poly.length]));
    }
    return best;
  },
};

for (const kind of [lineKind, circleKind, arcKind, pointKind, ellipseKind, splineKind, hatchKind, insertKind, polylineKind, textKind, imageKind, dimensionKind, mtextKind] as EntityKind<never>[]) {
  registerKind(kind as unknown as EntityKind<Entity>);
}
