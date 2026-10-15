import type { Constraint, ConstraintId, PointRef } from "./constraints";
import { ellipsePointAt, isFullEllipse } from "./ellipse";
import type { Entity, EntityId } from "./entities";
import { dist, type Point } from "./geometry";

/**
 * What a selection can be constrained to (roadmap T-41).
 *
 * Onshape's model, which is the one people expect: select the geometry,
 * then apply the constraint — rather than a modal tool per constraint
 * with its own pick sequence. The rules for "can this apply to that?" are
 * here, pure and tested, so the panel only has to draw buttons and the
 * same rules can drive a keyboard shortcut, a plugin, or the AI assistant
 * later.
 *
 * Where a constraint needs *points* and the selection only names whole
 * entities, the nearest pair is used — select two lines and ask for
 * coincident and you mean the ends nearest each other, which is what the
 * user was looking at when they asked.
 */

export type ConstraintKind = Constraint["type"];

export interface BuildContext {
  /** Fresh ids; the caller supplies these so tests get predictable ones. */
  newId: () => ConstraintId;
}

export type BuildResult = { constraints: Constraint[] } | { error: string };

/** The order the constraint panel lists them in. */
export const CONSTRAINT_KINDS: ConstraintKind[] = [
  "coincident",
  "horizontal",
  "vertical",
  "parallel",
  "perpendicular",
  "tangent",
  "concentric",
  "collinear",
  "equal",
  "midpoint",
  "symmetric",
  "point-on-curve",
  "radius",
  "distance",
  "angle",
  "rotation",
  "fix",
];

/** What each constraint needs, for the button's tooltip. */
export const CONSTRAINT_HINTS: Record<ConstraintKind, string> = {
  coincident: "Two entities — their nearest ends meet",
  horizontal: "One or more lines",
  vertical: "One or more lines",
  parallel: "Two or more lines",
  perpendicular: "Two lines",
  tangent: "A circle or arc, and a line, circle or arc (an ellipse or spline can be tangent to a line, circle or arc)",
  concentric: "Two or more circles or arcs",
  collinear: "Two or more lines",
  equal: "Two or more lines (length), circles and arcs (radius), or ellipses (major axis)",
  midpoint: "A point and a line",
  symmetric: "Two points and a line to mirror them about",
  "point-on-curve": "A point and a line, circle, arc, ellipse or spline",
  radius: "A circle or arc — locks its current radius",
  distance: "Two entities — locks the current distance between their nearest ends",
  angle: "Two lines — locks the current angle between them",
  rotation: "Text or a block insert — locks its current rotation",
  fix: "Any geometry — pins it where it is",
};

const isLine = (e: Entity) => e.type === "line";
const isCurve = (e: Entity) => e.type === "circle" || e.type === "arc";
/** Horizontal/vertical read an ellipse's major axis. */
const hasAxis = (e: Entity) => e.type === "line" || e.type === "ellipse";
/** Something a point can lie on, or that has a centre another curve can share. */
const isOval = (e: Entity) => isCurve(e) || e.type === "ellipse";
const linelike = (e: Entity) => e.type === "line" || e.type === "polyline";
/** An ellipse's major axis turns like a line for parallel/perpendicular. */
const axislike = (e: Entity) => linelike(e) || e.type === "ellipse";
/** Ellipse and spline are tangent through a foot parameter (solver/footCurves.ts). */
const footcurve = (e: Entity) => e.type === "ellipse" || e.type === "spline";

/** The points of an entity a constraint can attach to, nearest-pair matching included. */
export function attachPoints(entity: Entity): { ref: PointRef; at: Point }[] {
  const ref = (point: PointRef["point"]): PointRef => ({ entityId: entity.id, point });
  switch (entity.type) {
    case "line":
      return [
        { ref: ref("a"), at: entity.a },
        { ref: ref("b"), at: entity.b },
      ];
    case "polyline":
      return entity.points.map((p, i) => ({
        ref: i === 0 ? ref("a") : i === entity.points.length - 1 ? ref("b") : { entityId: entity.id, point: "vertex" as const, index: i },
        at: p,
      }));
    case "arc": {
      const end = (angle: number): Point => ({
        x: entity.center.x + entity.radius * Math.cos(angle),
        y: entity.center.y + entity.radius * Math.sin(angle),
      });
      return [
        { ref: ref("a"), at: end(entity.startAngle) },
        { ref: ref("b"), at: end(entity.endAngle) },
        { ref: ref("center"), at: entity.center },
      ];
    }
    case "circle":
      return [{ ref: ref("center"), at: entity.center }];
    case "ellipse": {
      const g = { center: entity.center, majorAxis: entity.majorAxis, ratio: entity.ratio, start: entity.start, end: entity.end };
      const out = [
        { ref: ref("center"), at: entity.center },
        { ref: ref("a"), at: ellipsePointAt(g, entity.start) },
      ];
      if (!isFullEllipse(g)) out.push({ ref: ref("b"), at: ellipsePointAt(g, entity.end) });
      return out;
    }
    case "spline":
      // A clamped spline starts and ends on its first and last control vertex.
      return entity.controlPoints.length < 2
        ? []
        : [
            { ref: ref("a"), at: entity.controlPoints[0] },
            { ref: ref("b"), at: entity.controlPoints[entity.controlPoints.length - 1] },
          ];
    case "point":
      return [{ ref: ref("a"), at: entity.p }];
    case "text":
      return [{ ref: ref("a"), at: entity.at }]; // K-01: the text anchor
    case "insert":
      return [{ ref: ref("a"), at: entity.insert }]; // K-01: a block's base point
    case "image":
    default:
      return []; // nothing a constraint can attach to (yet)
  }
}

/** The pair of attach points — one from each entity — that are nearest each other. */
export function nearestPair(a: Entity, b: Entity): { a: PointRef; b: PointRef } | null {
  const pa = attachPoints(a);
  const pb = attachPoints(b);
  if (pa.length === 0 || pb.length === 0) return null;
  let best: { a: PointRef; b: PointRef; d: number } | null = null;
  for (const x of pa) {
    for (const y of pb) {
      const d = dist(x.at, y.at);
      if (!best || d < best.d) best = { a: x.ref, b: y.ref, d };
    }
  }
  return best ? { a: best.a, b: best.b } : null;
}

function directionOf(e: Entity): Point | null {
  if (e.type === "line") return { x: e.b.x - e.a.x, y: e.b.y - e.a.y };
  if (e.type === "polyline" && e.points.length >= 2) {
    return { x: e.points[1].x - e.points[0].x, y: e.points[1].y - e.points[0].y };
  }
  return null;
}

function radiusOf(e: Entity): number | null {
  return e.type === "circle" || e.type === "arc" ? e.radius : null;
}

/** Chains a pairwise constraint across a selection: a–b, b–c, c–d. */
function chain(entities: Entity[], ctx: BuildContext, make: (a: EntityId, b: EntityId, id: ConstraintId) => Constraint): Constraint[] {
  const out: Constraint[] = [];
  for (let i = 1; i < entities.length; i++) out.push(make(entities[i - 1].id, entities[i].id, ctx.newId()));
  return out;
}

/**
 * Builds the constraint(s) `kind` means for this selection, or explains
 * why it doesn't apply. The message is what the disabled button says, so
 * it names what is missing rather than merely refusing.
 */
export function buildConstraints(kind: ConstraintKind, selection: readonly Entity[], ctx: BuildContext): BuildResult {
  const sel = [...selection];
  const lines = sel.filter(isLine);
  const curves = sel.filter(isCurve);
  const points = sel.filter((e) => e.type === "point");
  const need = (ok: boolean): BuildResult | null => (ok ? null : { error: CONSTRAINT_HINTS[kind] });

  switch (kind) {
    case "horizontal":
    case "vertical": {
      const axes = sel.filter(hasAxis);
      const bad = need(axes.length > 0 && axes.length === sel.length);
      if (bad) return bad;
      return { constraints: axes.map((l) => ({ id: ctx.newId(), type: kind, entityId: l.id })) };
    }
    case "parallel": {
      const usable = sel.filter(axislike);
      const bad = need(usable.length >= 2 && usable.length === sel.length);
      if (bad) return bad;
      return { constraints: chain(usable, ctx, (a, b, id) => ({ id, type: "parallel", a, b })) };
    }
    case "perpendicular": {
      const usable = sel.filter(axislike);
      const bad = need(usable.length === 2 && sel.length === 2);
      if (bad) return bad;
      return { constraints: [{ id: ctx.newId(), type: "perpendicular", a: usable[0].id, b: usable[1].id }] };
    }
    case "collinear": {
      const usable = sel.filter(linelike);
      const bad = need(usable.length >= 2 && usable.length === sel.length);
      if (bad) return bad;
      return { constraints: chain(usable, ctx, (a, b, id) => ({ id, type: "collinear", a, b })) };
    }
    case "concentric": {
      const ovals = sel.filter(isOval);
      const bad = need(ovals.length >= 2 && ovals.length === sel.length);
      if (bad) return bad;
      return { constraints: chain(ovals, ctx, (a, b, id) => ({ id, type: "concentric", a, b })) };
    }
    case "tangent": {
      const withFoot = sel.length === 2 && sel.some(footcurve) && sel.some((e) => isCurve(e) || e.type === "line");
      const bad = need(withFoot || (sel.length === 2 && curves.length >= 1 && sel.every((e) => isCurve(e) || linelike(e))));
      if (bad) return bad;
      return { constraints: [{ id: ctx.newId(), type: "tangent", a: sel[0].id, b: sel[1].id }] };
    }
    case "equal": {
      // Equal means length for lines and radius for curves; mixing the two
      // would be comparing a length with a radius, which means nothing.
      const allLines = lines.length === sel.length && lines.length >= 2;
      const allCurves = curves.length === sel.length && curves.length >= 2;
      // Ellipses: equal major axis (the semi-major length).
      const ellipses = sel.filter((e) => e.type === "ellipse");
      const allEllipses = ellipses.length === sel.length && ellipses.length >= 2;
      const bad = need(allLines || allCurves || allEllipses);
      if (bad) return bad;
      return { constraints: chain(allLines ? lines : allEllipses ? ellipses : curves, ctx, (a, b, id) => ({ id, type: "equal", a, b })) };
    }
    case "coincident": {
      const bad = need(sel.length === 2);
      if (bad) return bad;
      const pair = nearestPair(sel[0], sel[1]);
      if (!pair) return { error: "These have no points to join" };
      return { constraints: [{ id: ctx.newId(), type: "coincident", a: pair.a, b: pair.b }] };
    }
    case "midpoint": {
      const line = sel.find(isLine);
      const other = sel.find((e) => e !== line);
      const bad = need(sel.length === 2 && !!line && !!other && attachPoints(other!).length > 0);
      if (bad) return bad;
      const point = nearestPair(other!, line!)?.a;
      if (!point) return { error: CONSTRAINT_HINTS.midpoint };
      return { constraints: [{ id: ctx.newId(), type: "midpoint", point, entityId: line!.id }] };
    }
    case "symmetric": {
      const axis = sel.find(isLine);
      const rest = sel.filter((e) => e !== axis);
      const bad = need(sel.length === 3 && !!axis && rest.length === 2 && rest.every((e) => attachPoints(e).length > 0));
      if (bad) return bad;
      const a = nearestPair(rest[0], axis!)?.a;
      const b = nearestPair(rest[1], axis!)?.a;
      if (!a || !b) return { error: CONSTRAINT_HINTS.symmetric };
      return { constraints: [{ id: ctx.newId(), type: "symmetric", a, b, axis: axis!.id }] };
    }
    case "point-on-curve": {
      const curve = sel.find((e) => isOval(e) || linelike(e) || e.type === "spline");
      const other = sel.find((e) => e !== curve);
      const bad = need(sel.length === 2 && !!curve && !!other && attachPoints(other!).length > 0);
      if (bad) return bad;
      const point = nearestPair(other!, curve!)?.a;
      if (!point) return { error: CONSTRAINT_HINTS["point-on-curve"] };
      return { constraints: [{ id: ctx.newId(), type: "point-on-curve", point, entityId: curve!.id }] };
    }
    case "radius": {
      const bad = need(curves.length > 0 && curves.length === sel.length);
      if (bad) return bad;
      return {
        constraints: curves.map((c) => ({ id: ctx.newId(), type: "radius", entityId: c.id, value: radiusOf(c)! })),
      };
    }
    case "distance": {
      const bad = need(sel.length === 2);
      if (bad) return bad;
      const pair = nearestPair(sel[0], sel[1]);
      if (!pair) return { error: "These have no points to measure between" };
      const at = (ref: PointRef) => attachPoints(sel.find((e) => e.id === ref.entityId)!).find((p) => samePointRef(p.ref, ref))!.at;
      return {
        constraints: [{ id: ctx.newId(), type: "distance", a: pair.a, b: pair.b, value: dist(at(pair.a), at(pair.b)) }],
      };
    }
    case "angle": {
      const usable = sel.filter(linelike);
      const bad = need(usable.length === 2 && sel.length === 2);
      if (bad) return bad;
      const u = directionOf(usable[0])!;
      const v = directionOf(usable[1])!;
      const value = Math.atan2(u.x * v.y - u.y * v.x, u.x * v.x + u.y * v.y);
      return { constraints: [{ id: ctx.newId(), type: "angle", a: usable[0].id, b: usable[1].id, value }] };
    }
    case "rotation": {
      const usable = sel.filter((e) => e.type === "text" || e.type === "insert");
      const bad = need(usable.length > 0 && usable.length === sel.length);
      if (bad) return bad;
      return {
        constraints: usable.map((e) => ({ id: ctx.newId(), type: "rotation" as const, entityId: e.id, value: (e as { rotation: number }).rotation })),
      };
    }
    case "fix": {
      const usable = sel.filter((e) => attachPoints(e).length > 0 || isCurve(e));
      const bad = need(usable.length > 0);
      if (bad) return bad;
      return { constraints: usable.map((e) => ({ id: ctx.newId(), type: "fix", entityId: e.id })) };
    }
  }
}

function samePointRef(a: PointRef, b: PointRef): boolean {
  return a.entityId === b.entityId && a.point === b.point && (a.index ?? 0) === (b.index ?? 0);
}

/** Which constraints this selection can take, and why the others can't — one pass, for the panel. */
export function constraintOptions(selection: readonly Entity[]): { kind: ConstraintKind; enabled: boolean; hint: string }[] {
  const ctx: BuildContext = { newId: () => "probe" };
  return CONSTRAINT_KINDS.map((kind) => {
    const result = buildConstraints(kind, selection, ctx);
    return { kind, enabled: "constraints" in result, hint: "error" in result ? result.error : CONSTRAINT_HINTS[kind] };
  });
}
