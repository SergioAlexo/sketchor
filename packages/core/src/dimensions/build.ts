import type { PointRef } from "../constraints";
import type { DimensionEntity, Entity, LineEntity } from "../entities";
import { newEntityId } from "../entities";
import type { Point } from "../geometry";
import { arcPointAt } from "../geometry";

/**
 * D-02c: pure construction of dimension entities from picks. The tools only
 * collect clicks (an entity, a point, a placement); everything that decides
 * *which* dimension that is — smart-DIM classification, linear orientation,
 * baseline / continue chains, QDIM — lives here so it is tested without a UI.
 */

export interface DimBuildOptions {
  style?: string;
  layer?: string;
  /** Overrides the generated id (tests, previews). */
  id?: string;
}

const sub = (a: Point, b: Point): Point => ({ x: a.x - b.x, y: a.y - b.y });
const add = (a: Point, b: Point): Point => ({ x: a.x + b.x, y: a.y + b.y });
const mul = (a: Point, k: number): Point => ({ x: a.x * k, y: a.y * k });
const dot = (a: Point, b: Point): number => a.x * b.x + a.y * b.y;
const len = (a: Point): number => Math.hypot(a.x, a.y);

function base(kind: DimensionEntity["kind"], defPoints: Point[], o: DimBuildOptions, extra: Partial<DimensionEntity> = {}): DimensionEntity {
  return {
    id: o.id ?? newEntityId(),
    type: "dimension",
    kind,
    defPoints: defPoints.map((p) => ({ x: p.x, y: p.y })),
    driving: false,
    ...(o.layer && o.layer !== "0" ? { layer: o.layer } : {}),
    ...(o.style ? { style: o.style } : {}),
    ...extra,
  };
}

/** The associative anchor at `p` (an end, centre or vertex of some entity), or null for a free point. */
export function refAtPoint(entities: Iterable<Entity>, p: Point, tol = 1e-6): PointRef | null {
  const near = (q: Point | undefined | null): boolean => !!q && Math.hypot(q.x - p.x, q.y - p.y) <= tol;
  for (const e of entities) {
    switch (e.type) {
      case "line":
        if (near(e.a)) return { entityId: e.id, point: "a" };
        if (near(e.b)) return { entityId: e.id, point: "b" };
        break;
      case "circle":
        if (near(e.center)) return { entityId: e.id, point: "center" };
        break;
      case "arc":
        if (near(e.center)) return { entityId: e.id, point: "center" };
        if (near(arcPointAt(e.center, e.radius, e.startAngle))) return { entityId: e.id, point: "a" };
        if (near(arcPointAt(e.center, e.radius, e.endAngle))) return { entityId: e.id, point: "b" };
        break;
      case "point":
        if (near(e.p)) return { entityId: e.id, point: "a" };
        break;
      case "polyline":
        for (let i = 0; i < e.points.length; i++) if (near(e.points[i])) return { entityId: e.id, point: "vertex", index: i };
        break;
      default:
        break;
    }
  }
  return null;
}

/** Linear dimension orientation from where the dimension line is dragged: above/below => horizontal, left/right => vertical. */
export function linearAngleFor(p1: Point, p2: Point, placement: Point): number {
  const m = mul(add(p1, p2), 0.5);
  const d = sub(placement, m);
  // A placement on the diagonal decides by the points themselves (the longer span is measured).
  if (Math.abs(Math.abs(d.y) - Math.abs(d.x)) < 1e-12) return Math.abs(p2.x - p1.x) >= Math.abs(p2.y - p1.y) ? 0 : Math.PI / 2;
  return Math.abs(d.y) > Math.abs(d.x) ? 0 : Math.PI / 2;
}

/** Two points: linear (orientation from the placement) or aligned. */
export function dimBetweenPoints(
  p1: Point,
  p2: Point,
  placement: Point,
  mode: "linear" | "aligned",
  o: DimBuildOptions = {},
  refs?: [PointRef | null, PointRef | null],
): DimensionEntity {
  const extra: Partial<DimensionEntity> = mode === "linear" ? { angle: linearAngleFor(p1, p2, placement) } : {};
  if (refs && (refs[0] || refs[1])) extra.refs = [refs[0], refs[1], null];
  return base(mode, [p1, p2, placement], o, extra);
}

/** One line => its length. Horizontal / vertical lines become linear dimensions, anything else aligned. */
export function dimOfLine(line: LineEntity, placement: Point, o: DimBuildOptions = {}): DimensionEntity {
  const d = sub(line.b, line.a);
  const horiz = Math.abs(d.y) < 1e-9 * Math.max(1, Math.abs(d.x));
  const vert = Math.abs(d.x) < 1e-9 * Math.max(1, Math.abs(d.y));
  const refs: (PointRef | null)[] = [{ entityId: line.id, point: "a" }, { entityId: line.id, point: "b" }, null];
  const dim = base(horiz || vert ? "linear" : "aligned", [line.a, line.b, placement], o, { refs });
  if (horiz) dim.angle = 0;
  else if (vert) dim.angle = Math.PI / 2;
  return dim;
}

/** Circle => diameter, arc => radius (smart DIM); `kind` forces radial / diametric / jogged. `through` sets the side the dimension line leaves on. */
export function dimOfCircle(c: Entity, through: Point, kind?: "radial" | "diametric" | "jogged", o: DimBuildOptions = {}): DimensionEntity | null {
  if (c.type !== "circle" && c.type !== "arc") return null;
  const k = kind ?? (c.type === "circle" ? "diametric" : "radial");
  const d = sub(through, c.center);
  const dir = len(d) < 1e-12 ? { x: 1, y: 0 } : mul(d, 1 / len(d));
  const dirPoint = add(c.center, mul(dir, c.radius));
  const pts = k === "jogged" ? [c.center, dirPoint, add(c.center, mul(dir, c.radius * 0.5))] : [c.center, dirPoint];
  return base(k, pts, o, { target: c.id });
}

/** Arc length of an arc entity, dimension arc through `through`. */
export function dimOfArcLength(arc: Entity, through: Point, o: DimBuildOptions = {}): DimensionEntity | null {
  if (arc.type !== "arc") return null;
  const s = arcPointAt(arc.center, arc.radius, arc.startAngle);
  const e = arcPointAt(arc.center, arc.radius, arc.endAngle);
  return base("arclength", [arc.center, s, e, through], o, { target: arc.id });
}

function crossing(a: LineEntity, b: LineEntity): boolean {
  const r = sub(a.b, a.a);
  const s = sub(b.b, b.a);
  const den = r.x * s.y - r.y * s.x;
  return Math.abs(den) >= 1e-12 * Math.max(1, len(r) * len(s));
}

/** Two lines: the angle between them when they cross (arc through `placement`), the perpendicular distance when parallel. */
export function dimOfTwoLines(l1: LineEntity, l2: LineEntity, placement: Point, o: DimBuildOptions = {}): DimensionEntity | null {
  if (len(sub(l1.b, l1.a)) < 1e-12 || len(sub(l2.b, l2.a)) < 1e-12) return null;
  if (crossing(l1, l2)) return base("angular2l", [l1.a, l1.b, l2.a, l2.b, placement], o, { targets: [l1.id, l2.id] });
  // Parallel: from the middle of line 1 square to line 2.
  const u = sub(l1.b, l1.a);
  const un = mul(u, 1 / len(u));
  const m = mul(add(l1.a, l1.b), 0.5);
  const foot = add(l2.a, mul(un, dot(sub(m, l2.a), un)));
  if (len(sub(foot, m)) < 1e-12) return null;
  return base("aligned", [m, foot, placement], o);
}

/** Angle at `vertex` between the rays to p1 and p2, arc through `placement`. */
export function dimAngle3(vertex: Point, p1: Point, p2: Point, placement: Point, o: DimBuildOptions = {}): DimensionEntity {
  return base("angular3p", [vertex, p1, p2, placement], o);
}

/** Ordinate from `origin`: with no axis given, a leader running up/down reads X and one running sideways reads Y. */
export function dimOrdinate(origin: Point, feature: Point, leaderEnd: Point, axis?: "x" | "y", o: DimBuildOptions = {}): DimensionEntity {
  const d = sub(leaderEnd, feature);
  const ax = axis ?? (Math.abs(d.y) >= Math.abs(d.x) ? "x" : "y");
  return base("ordinate", [origin, feature, leaderEnd], o, { axis: ax });
}

/* --------------------- baseline / continue / quick dimension --------------------- */

/** Direction of a linear/aligned dimension line and its normal. */
function frame(d: DimensionEntity): { u: Point; n: Point } | null {
  if ((d.kind !== "linear" && d.kind !== "aligned") || d.defPoints.length < 3) return null;
  const [p1, p2] = d.defPoints;
  const th = d.kind === "aligned" ? Math.atan2(p2.y - p1.y, p2.x - p1.x) : (d.angle ?? 0);
  const u = { x: Math.cos(th), y: Math.sin(th) };
  return { u, n: { x: -u.y, y: u.x } };
}

/**
 * The next dimension in a chain that starts from `prev`:
 *  - continue: starts where `prev` ended, on the same dimension line;
 *  - baseline: shares `prev`'s first point and steps the dimension line out by `spacing`.
 * `nextPoint` is the new measured point. Returns null for kinds that cannot chain.
 */
export function chainDimension(
  prev: DimensionEntity,
  nextPoint: Point,
  mode: "continue" | "baseline",
  spacing: number,
  o: DimBuildOptions = {},
  nextRef?: PointRef | null,
): DimensionEntity | null {
  const f = frame(prev);
  if (!f) return null;
  const [p1, p2, loc] = prev.defPoints;
  const side = dot(sub(loc, p1), f.n) >= 0 ? 1 : -1;
  const a = mode === "continue" ? p2 : p1;
  const aRef = (mode === "continue" ? prev.refs?.[1] : prev.refs?.[0]) ?? null;
  const at = mode === "continue" ? loc : add(loc, mul(f.n, side * spacing * (prev.scale ?? 1)));
  const extra: Partial<DimensionEntity> = {};
  if (prev.kind === "linear") extra.angle = prev.angle ?? 0;
  if (aRef || nextRef) extra.refs = [aRef, nextRef ?? null, null];
  const out = base(prev.kind, [a, nextPoint, at], { layer: prev.layer, style: prev.style, ...o }, extra);
  if (prev.scale) out.scale = prev.scale;
  if (prev.overrides) out.overrides = prev.overrides;
  return out;
}

export type QDimMode = "continued" | "baseline" | "ordinate";

/**
 * QDIM: the selection plus a placement point give a chain of linear
 * dimensions across the selection's vertices. `orientation` "auto" measures X
 * (horizontal) when the placement is above/below the selection and Y when it
 * is beside it. Circles and arcs in the selection get diameter / radius
 * dimensions instead.
 */
export function quickDimension(
  entities: Entity[],
  placement: Point,
  mode: QDimMode,
  spacing: number,
  orientation: "horizontal" | "vertical" | "auto" = "auto",
  o: DimBuildOptions = {},
): DimensionEntity[] {
  const out: DimensionEntity[] = [];
  for (const c of entities) {
    if (c.type !== "circle" && c.type !== "arc") continue;
    const d = dimOfCircle(c, placement, undefined, o);
    if (d) out.push(d);
  }
  const owners: { p: Point; ref: PointRef }[] = [];
  for (const e of entities) {
    if (e.type === "line") owners.push({ p: e.a, ref: { entityId: e.id, point: "a" } }, { p: e.b, ref: { entityId: e.id, point: "b" } });
    else if (e.type === "polyline") e.points.forEach((p, i) => owners.push({ p, ref: { entityId: e.id, point: "vertex", index: i } }));
    else if (e.type === "point") owners.push({ p: e.p, ref: { entityId: e.id, point: "a" } });
  }
  if (owners.length < 2) return out;
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const { p } of owners) {
    minX = Math.min(minX, p.x);
    maxX = Math.max(maxX, p.x);
    minY = Math.min(minY, p.y);
    maxY = Math.max(maxY, p.y);
  }
  const beside = placement.x > maxX || placement.x < minX;
  const aboveBelow = placement.y > maxY || placement.y < minY;
  const horizontal = orientation === "auto" ? aboveBelow || !beside : orientation === "horizontal";
  const key = (p: Point): number => (horizontal ? p.x : p.y);
  const sorted = owners.slice().sort((a, b) => key(a.p) - key(b.p));
  const uniq: typeof owners = [];
  for (const s of sorted) if (!uniq.length || Math.abs(key(s.p) - key(uniq[uniq.length - 1].p)) > 1e-9) uniq.push(s);
  if (uniq.length < 2) return out;
  const angle = horizontal ? 0 : Math.PI / 2;
  const side = (horizontal ? placement.y >= (minY + maxY) / 2 : placement.x >= (minX + maxX) / 2) ? 1 : -1;
  const lineAt = (step: number): Point => (horizontal ? { x: uniq[0].p.x, y: placement.y + side * step } : { x: placement.x + side * step, y: uniq[0].p.y });
  const first = uniq[0];
  for (let i = 1; i < uniq.length; i++) {
    const b = uniq[i];
    if (mode === "ordinate") {
      out.push(dimOrdinate(first.p, b.p, horizontal ? { x: b.p.x, y: placement.y } : { x: placement.x, y: b.p.y }, horizontal ? "x" : "y", o));
      continue;
    }
    const a = mode === "continued" ? uniq[i - 1] : first;
    const loc = mode === "baseline" ? lineAt((i - 1) * spacing) : lineAt(0);
    out.push(base("linear", [a.p, b.p, loc], o, { angle, refs: [a.ref, b.ref, null] }));
  }
  return out;
}

/* --------------------- D-07: centre marks and centrelines --------------------- */

/**
 * A centre mark on a circle or arc. It follows the entity (`target`), so moving
 * or resizing the circle moves the cross. `extended` runs the cross past the
 * circle in the CENTER linetype (a centre-line cross); otherwise it is the short
 * solid cross of DIMCEN "mark".
 */
export function dimCenterMark(c: Entity, o: DimBuildOptions = {}, opts: { extended?: boolean } = {}): DimensionEntity | null {
  if (c.type !== "circle" && c.type !== "arc") return null;
  if (!(c.radius > 0) || !Number.isFinite(c.radius)) return null;
  const extended = !!opts.extended;
  return base("centermark", [c.center, { x: c.center.x + c.radius, y: c.center.y }], o, {
    target: c.id,
    overrides: { centerMark: extended ? "line" : "mark" },
    ...(extended ? { linetype: "CENTER" } : {}),
  });
}

/**
 * The centreline midway between two lines (a slot, a bar, a shaft): from the
 * midpoint of their start points to the midpoint of their end points, reaching
 * past by the style's centre-mark size. Both lines are followed (associative).
 * Null for a zero-length line, or when the midline collapses to a point.
 */
export function dimCenterLine(l1: Entity, l2: Entity, o: DimBuildOptions = {}): DimensionEntity | null {
  if (l1.type !== "line" || l2.type !== "line" || l1.id === l2.id) return null;
  if (len(sub(l1.b, l1.a)) < 1e-12 || len(sub(l2.b, l2.a)) < 1e-12) return null;
  // Pair the ends that point the same way, whichever way each line was drawn.
  const flip = dot(sub(l1.b, l1.a), sub(l2.b, l2.a)) < 0;
  const a2 = flip ? l2.b : l2.a;
  const b2 = flip ? l2.a : l2.b;
  const rA2: PointRef = { entityId: l2.id, point: flip ? "b" : "a" };
  const rB2: PointRef = { entityId: l2.id, point: flip ? "a" : "b" };
  const mid = len(sub(mul(add(l1.b, b2), 0.5), mul(add(l1.a, a2), 0.5)));
  if (mid < 1e-9) return null;
  return base("centerline", [l1.a, l1.b, a2, b2], o, {
    refs: [{ entityId: l1.id, point: "a" }, { entityId: l1.id, point: "b" }, rA2, rB2],
    targets: [l1.id, l2.id],
    linetype: "CENTER",
  });
}
