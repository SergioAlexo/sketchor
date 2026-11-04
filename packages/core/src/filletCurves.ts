import type { ArcEntity, Entity, LineEntity } from "./entities";
import { dist, type Point } from "./geometry";
import { curveLength, entityFromPath, exactPathOf, intersectCurves, pointAt, subCurve, tangentAt, type XCurve } from "./intersect";

/**
 * Fillet between any two single-curve entities (C-08): line, arc, circle,
 * ellipse, spline. `filletLines` stays the exact closed form for two lines;
 * this is the numeric one for every other pair.
 *
 * The fillet circle's centre is `P1(t1) ± r·n1(t1) = P2(t2) ± r·n2(t2)` —
 * the same point offset by r along each curve's normal. That is two
 * equations in (t1, t2), solved by Newton from a grid of seeds for each of
 * the four side combinations; the candidate whose tangent points lie nearest
 * the user's two picks wins (the same rule that decides which quadrant of a
 * "+" gets rounded).
 *
 * Lines extend along their line to reach a tangent point; arcs, ellipse arcs
 * and splines do not. A circle or other closed curve is never trimmed (the
 * fillet arc is just added), as in AutoCAD. Radius 0 is the corner join:
 * trim/extend both to where they meet.
 */

export interface CurveFillet {
  first: Entity;
  second: Entity;
  /** The fillet arc (radius > 0), id left blank for the caller. */
  arc: ArcEntity | null;
}

interface Operand {
  entity: Entity;
  curve: XCurve;
  closed: boolean;
  /** Parameter of the click on the curve. */
  tc: number;
}

const operand = (entity: Entity, near: Point): Operand | null => {
  const path = exactPathOf(entity);
  if (!path || path.curves.length !== 1) return null;
  const curve = path.curves[0];
  return { entity, curve, closed: path.closed, tc: closestT(curve, near) };
};

function closestT(c: XCurve, p: Point): number {
  if (c.kind === "segment") {
    const dx = c.b.x - c.a.x;
    const dy = c.b.y - c.a.y;
    const l2 = dx * dx + dy * dy;
    return l2 > 0 ? ((p.x - c.a.x) * dx + (p.y - c.a.y) * dy) / l2 : 0;
  }
  // Sample: good enough to say which side of a tangent point the click is on.
  let best = 0;
  let bd = Infinity;
  for (let i = 0; i <= 200; i++) {
    const d = dist(pointAt(c, i / 200), p);
    if (d < bd) {
      bd = d;
      best = i / 200;
    }
  }
  return best;
}

const normalAt = (c: XCurve, t: number): Point => {
  const d = tangentAt(c, t);
  return { x: -d.y, y: d.x };
};

const clampT = (c: XCurve, t: number): number => (c.kind === "segment" ? t : Math.min(1, Math.max(0, t)));

export function filletCurves(e1: Entity, e2: Entity, radius: number, near1: Point, near2: Point): CurveFillet | null {
  const a = operand(e1, near1);
  const b = operand(e2, near2);
  if (!a || !b || e1.id === e2.id) return null;
  if (radius <= 0) return cornerJoin(a, b);

  const segSeeds = [-2, -1, -0.5, 0, 0.25, 0.5, 0.75, 1, 1.5, 2, 3];
  const curveSeeds = Array.from({ length: 17 }, (_, i) => i / 16);
  const seedsOf = (o: Operand): number[] => (o.curve.kind === "segment" ? segSeeds : curveSeeds);

  type Cand = { t1: number; t2: number; f1: Point; f2: Point; center: Point };
  const found: Cand[] = [];
  const resid = (s1: number, s2: number, t1: number, t2: number): Point => {
    const p1 = pointAt(a.curve, clampT(a.curve, t1));
    const p2 = pointAt(b.curve, clampT(b.curve, t2));
    const n1 = normalAt(a.curve, clampT(a.curve, t1));
    const n2 = normalAt(b.curve, clampT(b.curve, t2));
    return { x: p1.x + s1 * radius * n1.x - p2.x - s2 * radius * n2.x, y: p1.y + s1 * radius * n1.y - p2.y - s2 * radius * n2.y };
  };

  for (const s1 of [1, -1]) {
    for (const s2 of [1, -1]) {
      for (const u of seedsOf(a)) {
        for (const v of seedsOf(b)) {
          let t1 = u;
          let t2 = v;
          let ok = false;
          for (let it = 0; it < 40; it++) {
            const f = resid(s1, s2, t1, t2);
            if (Math.hypot(f.x, f.y) < 1e-10) {
              ok = true;
              break;
            }
            const h = 1e-6;
            const fa = resid(s1, s2, t1 + h, t2);
            const fb = resid(s1, s2, t1 - h, t2);
            const fc = resid(s1, s2, t1, t2 + h);
            const fd = resid(s1, s2, t1, t2 - h);
            const j11 = (fa.x - fb.x) / (2 * h);
            const j21 = (fa.y - fb.y) / (2 * h);
            const j12 = (fc.x - fd.x) / (2 * h);
            const j22 = (fc.y - fd.y) / (2 * h);
            const det = j11 * j22 - j12 * j21;
            if (Math.abs(det) < 1e-14) break;
            const d1 = (-f.x * j22 + f.y * j12) / det;
            const d2 = (-j11 * f.y + j21 * f.x) / det;
            // Damp wild steps so a bad seed doesn't leap across the drawing.
            const k = Math.min(1, 1 / Math.max(Math.abs(d1), Math.abs(d2), 1e-12));
            t1 = clampT(a.curve, t1 + d1 * k);
            t2 = clampT(b.curve, t2 + d2 * k);
          }
          if (!ok) continue;
          const bounded = (o: Operand, t: number): boolean => o.curve.kind === "segment" || (t >= -1e-9 && t <= 1 + 1e-9);
          if (!bounded(a, t1) || !bounded(b, t2)) continue;
          const f1 = pointAt(a.curve, t1);
          const f2 = pointAt(b.curve, t2);
          const n1 = normalAt(a.curve, t1);
          const center = { x: f1.x + s1 * radius * n1.x, y: f1.y + s1 * radius * n1.y };
          if (found.some((c) => dist(c.center, center) < 1e-6 && dist(c.f1, f1) < 1e-6)) continue;
          found.push({ t1, t2, f1, f2, center });
        }
      }
    }
  }
  if (found.length === 0) return null;
  const score = (c: Cand): number => dist(c.f1, near1) + dist(c.f2, near2);
  found.sort((x, y) => score(x) - score(y));
  const best = found[0];

  const first = trimTo(a, best.t1);
  const second = trimTo(b, best.t2);
  if (!first || !second) return null;
  const a1 = Math.atan2(best.f1.y - best.center.y, best.f1.x - best.center.x);
  const a2 = Math.atan2(best.f2.y - best.center.y, best.f2.x - best.center.x);
  const ccwSweep = ((((a2 - a1) % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI));
  const arc: ArcEntity = { id: "", type: "arc", ...props(e1), center: best.center, radius, startAngle: a1, endAngle: a2, ccw: ccwSweep <= Math.PI };
  return { first, second, arc };
}

function props(e: Entity): { layer?: string; color?: string; linetype?: string; lineweight?: number; construction?: boolean } {
  const out: { layer?: string; color?: string; linetype?: string; lineweight?: number; construction?: boolean } = {};
  if (e.layer !== undefined) out.layer = e.layer;
  if (e.color !== undefined) out.color = e.color;
  if (e.linetype !== undefined) out.linetype = e.linetype;
  if (e.lineweight !== undefined) out.lineweight = e.lineweight;
  if (e.construction !== undefined) out.construction = e.construction;
  return out;
}

/** The operand cut at parameter `tf`, keeping the side the click was on. A closed curve is returned unchanged. */
function trimTo(o: Operand, tf: number): Entity | null {
  if (o.closed) return o.entity;
  const keepStart = o.tc < tf; // click is before the foot → keep the start side
  const piece = keepStart ? subCurve(o.curve, 0, tf) : subCurve(o.curve, tf, 1);
  const made = entityFromPath({ curves: [piece], closed: false }, o.entity, o.entity.id);
  if (!made) return null;
  const merged = { ...o.entity, ...made, id: o.entity.id } as Entity;
  if (merged.type === "spline") delete (merged as { fitPoints?: unknown }).fitPoints;
  return merged;
}

/** Radius 0: trim/extend both to the intersection nearest the picks. */
function cornerJoin(a: Operand, b: Operand): CurveFillet | null {
  const hits = intersectCurves(a.curve, b.curve, a.curve.kind === "segment", b.curve.kind === "segment");
  if (hits.length === 0) return null;
  const pa = pointAt(a.curve, a.tc);
  const pb = pointAt(b.curve, b.tc);
  hits.sort((x, y) => dist(x.point, pa) + dist(x.point, pb) - (dist(y.point, pa) + dist(y.point, pb)));
  const h = hits[0];
  const first = trimTo(a, h.t1);
  const second = trimTo(b, h.t2);
  return first && second ? { first, second, arc: null } : null;
}

/* --------------------------------- chamfer -------------------------------- */

export interface CurveChamfer {
  first: Entity;
  second: Entity;
  /** The chamfer line between the two cut points, id left blank for the caller; null when both distances are 0 (a corner join). */
  line: LineEntity | null;
}

/**
 * Chamfer between two lines/arcs/circles (T-17 leftover). Distances are
 * measured *along each curve* from where the two meet (the intersection
 * nearest the picks, a line extended to reach it as for a corner join),
 * toward the side that was clicked; the curves are cut there and a straight
 * line joins the cut points. A circle is never trimmed (only the chamfer
 * line is added), as for fillet. Null when the curves never meet, are not
 * lines/arcs/circles, or a distance runs past the end of the piece to keep.
 * Both distances 0 is the corner join.
 */
export function chamferCurves(e1: Entity, e2: Entity, d1: number, d2: number, near1: Point, near2: Point): CurveChamfer | null {
  if (!(d1 >= 0) || !(d2 >= 0) || !Number.isFinite(d1) || !Number.isFinite(d2)) return null;
  const a = operand(e1, near1);
  const b = operand(e2, near2);
  if (!a || !b || e1.id === e2.id) return null;
  if (!(a.curve.kind === "segment" || a.curve.kind === "arc") || !(b.curve.kind === "segment" || b.curve.kind === "arc")) return null;
  if (d1 === 0 && d2 === 0) {
    const j = cornerJoin(a, b);
    return j ? { first: j.first, second: j.second, line: null } : null;
  }
  const hits = intersectCurves(a.curve, b.curve, a.curve.kind === "segment", b.curve.kind === "segment");
  if (hits.length === 0) return null;
  const pa = pointAt(a.curve, a.tc);
  const pb = pointAt(b.curve, b.tc);
  hits.sort((x, y) => dist(x.point, pa) + dist(x.point, pb) - (dist(y.point, pa) + dist(y.point, pb)));
  const h = hits[0];

  const foot = (o: Operand, tHit: number, d: number): { tf: number; keepEnd: boolean } | null => {
    const len = curveLength(o.curve);
    if (!(len > 1e-12)) return null;
    let delta = o.tc - tHit;
    if (o.closed) delta = delta - Math.round(delta); // shortest way round
    const s = delta >= 0 ? 1 : -1;
    const tf = tHit + (s * d) / len;
    if (o.closed) return { tf: ((tf % 1) + 1) % 1, keepEnd: s > 0 };
    // The piece kept must still be there: past the far end means the distance is too large.
    if (s > 0 ? tf > 1 + 1e-9 : tf < -1e-9) return null;
    return { tf, keepEnd: s > 0 };
  };
  const f1 = foot(a, h.t1, d1);
  const f2 = foot(b, h.t2, d2);
  if (!f1 || !f2) return null;
  const cut = (o: Operand, f: { tf: number; keepEnd: boolean }): Entity | null => {
    if (o.closed) return o.entity;
    const piece = f.keepEnd ? subCurve(o.curve, f.tf, 1) : subCurve(o.curve, 0, f.tf);
    const made = entityFromPath({ curves: [piece], closed: false }, o.entity, o.entity.id);
    return made ? ({ ...o.entity, ...made, id: o.entity.id } as Entity) : null;
  };
  const first = cut(a, f1);
  const second = cut(b, f2);
  if (!first || !second) return null;
  const p1 = pointAt(a.curve, f1.tf);
  const p2 = pointAt(b.curve, f2.tf);
  if (dist(p1, p2) < 1e-9) return null;
  const line: LineEntity = { id: "", type: "line", ...props(e1), a: p1, b: p2 };
  return { first, second, line };
}
