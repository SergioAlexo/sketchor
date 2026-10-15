import { describe, expect, it } from "vitest";
import { buildConstraints, constraintOptions, nearestPair, type BuildContext } from "./constraintBuilder";
import type { Entity } from "./entities";
import { solveSketch } from "./solver/solve";

/**
 * Turning a selection into constraints is where a parametric sketch is
 * actually built, and the cost of getting it wrong is subtle: a
 * constraint applied to the wrong pair of endpoints doesn't look wrong
 * until the sketch is dragged, and then the geometry folds in a way the
 * user can't explain. So these check *which points* a constraint picked,
 * not just that one was made — and each new constraint type is solved
 * end-to-end, because a constraint the solver can't satisfy is worse than
 * no constraint at all.
 */

let counter = 0;
const ctx: BuildContext = { newId: () => `k${(counter += 1)}` };

const line = (id: string, ax: number, ay: number, bx: number, by: number): Entity => ({
  id,
  type: "line",
  a: { x: ax, y: ay },
  b: { x: bx, y: by },
});
const circle = (id: string, cx: number, cy: number, r: number): Entity => ({ id, type: "circle", center: { x: cx, y: cy }, radius: r });
const point = (id: string, x: number, y: number): Entity => ({ id, type: "point", p: { x, y } });
const arc = (id: string, cx: number, cy: number, r: number): Entity => ({
  id,
  type: "arc",
  center: { x: cx, y: cy },
  radius: r,
  startAngle: 0,
  endAngle: Math.PI / 2,
  ccw: true,
});

const built = (result: ReturnType<typeof buildConstraints>) => {
  if ("error" in result) throw new Error(`expected constraints, got: ${result.error}`);
  return result.constraints;
};
const errorOf = (result: ReturnType<typeof buildConstraints>) => ("error" in result ? result.error : null);

describe("picking the points a constraint attaches to", () => {
  it("joins the nearest ends of two lines, not the first ones it finds", () => {
    // Two lines meeting near (100, 0): it is b–a that should be joined.
    const l1 = line("l1", 0, 0, 100, 0);
    const l2 = line("l2", 101, 1, 200, 50);
    expect(nearestPair(l1, l2)).toEqual({ a: { entityId: "l1", point: "b" }, b: { entityId: "l2", point: "a" } });
    const [c] = built(buildConstraints("coincident", [l1, l2], ctx));
    expect(c).toMatchObject({ type: "coincident", a: { point: "b" }, b: { point: "a" } });
  });

  it("uses a circle's centre, the only point it has", () => {
    // Nearer the far end of the line, so the answer isn't a coin toss.
    expect(nearestPair(circle("c", 80, 0, 10), line("l", 0, 0, 100, 0))).toEqual({
      a: { entityId: "c", point: "center" },
      b: { entityId: "l", point: "b" },
    });
  });

  it("can name a polyline's middle vertex, which a PointRef could not before", () => {
    const pl: Entity = {
      id: "pl",
      type: "polyline",
      points: [
        { x: 0, y: 0 },
        { x: 50, y: 50 },
        { x: 100, y: 0 },
      ],
      closed: false,
    };
    expect(nearestPair(pl, point("p", 51, 52))).toEqual({
      a: { entityId: "pl", point: "vertex", index: 1 },
      b: { entityId: "p", point: "a" },
    });
  });
});

describe("what applies to what", () => {
  it("takes one or many for the constraints that repeat", () => {
    const ls = [line("l1", 0, 0, 10, 1), line("l2", 0, 5, 10, 6), line("l3", 0, 9, 10, 10)];
    expect(built(buildConstraints("horizontal", ls, ctx))).toHaveLength(3);
    // Pairwise constraints chain along the selection: l1–l2, l2–l3.
    expect(built(buildConstraints("parallel", ls, ctx))).toHaveLength(2);
    expect(built(buildConstraints("equal", ls, ctx))).toHaveLength(2);
  });

  it("insists on exactly two where a third would be ambiguous", () => {
    const ls = [line("l1", 0, 0, 10, 0), line("l2", 0, 5, 10, 5), line("l3", 0, 9, 10, 9)];
    expect(errorOf(buildConstraints("perpendicular", ls, ctx))).toBe("Two lines");
    expect(built(buildConstraints("perpendicular", ls.slice(0, 2), ctx))).toHaveLength(1);
  });

  it("won't equate a length with a radius", () => {
    const mixed = [line("l", 0, 0, 10, 0), circle("c", 0, 0, 5)];
    expect(errorOf(buildConstraints("equal", mixed, ctx))).toContain("Two or more lines");
    expect(built(buildConstraints("equal", [circle("c1", 0, 0, 5), circle("c2", 20, 0, 8)], ctx))).toHaveLength(1);
  });

  it("locks the value a dimension-like constraint already has", () => {
    const [r] = built(buildConstraints("radius", [circle("c", 0, 0, 12.5)], ctx));
    expect(r).toMatchObject({ type: "radius", value: 12.5 });
    const [d] = built(buildConstraints("distance", [point("p1", 0, 0), point("p2", 30, 40)], ctx));
    expect(d).toMatchObject({ type: "distance", value: 50 });
    const [a] = built(buildConstraints("angle", [line("l1", 0, 0, 10, 0), line("l2", 0, 0, 0, 10)], ctx));
    expect(a).toMatchObject({ type: "angle" });
    expect((a as { value: number }).value).toBeCloseTo(Math.PI / 2, 9);
  });

  it("explains what's missing instead of just refusing", () => {
    const options = constraintOptions([line("l", 0, 0, 10, 0)]);
    const byKind = Object.fromEntries(options.map((o) => [o.kind, o]));
    expect(byKind.horizontal.enabled).toBe(true);
    expect(byKind.parallel.enabled).toBe(false);
    expect(byKind.parallel.hint).toBe("Two or more lines");
    expect(byKind.tangent.enabled).toBe(false);
    expect(byKind.fix.enabled).toBe(true);
  });

  it("offers nothing at all for an empty selection", () => {
    expect(constraintOptions([]).every((o) => !o.enabled)).toBe(true);
  });

  it("ignores geometry it can't constrain", () => {
    const text: Entity = { id: "t", type: "image", insert: { x: 0, y: 0 }, width: 5, height: 5, rotation: 0 } as unknown as Entity; // images (unlike text, K-01) have nothing to attach to
    expect(errorOf(buildConstraints("fix", [text], ctx))).toBeTruthy();
    expect(errorOf(buildConstraints("horizontal", [text], ctx))).toBeTruthy();
  });
});

describe("the new constraint types solve", () => {
  const solved = (entities: Entity[], kind: Parameters<typeof buildConstraints>[0], extra: Entity[] = []) => {
    const constraints = built(buildConstraints(kind, entities, ctx));
    const all = [...entities, ...extra];
    const result = solveSketch(all, constraints);
    expect(result.converged).toBe(true);
    const map = new Map(all.map((e) => [e.id, e]));
    for (const u of result.updates) map.set(u.id, u);
    return map;
  };

  it("concentric moves two circles onto one centre", () => {
    const map = solved([circle("c1", 0, 0, 10), circle("c2", 30, 40, 5)], "concentric");
    const a = map.get("c1") as Extract<Entity, { type: "circle" }>;
    const b = map.get("c2") as Extract<Entity, { type: "circle" }>;
    expect(a.center.x).toBeCloseTo(b.center.x, 6);
    expect(a.center.y).toBeCloseTo(b.center.y, 6);
    // Radii are none of concentric's business.
    expect(a.radius).toBeCloseTo(10, 9);
    expect(b.radius).toBeCloseTo(5, 9);
  });

  it("collinear puts two lines on one infinite line", () => {
    const map = solved([line("l1", 0, 0, 100, 0), line("l2", 120, 8, 200, 12)], "collinear");
    const a = map.get("l1") as Extract<Entity, { type: "line" }>;
    const b = map.get("l2") as Extract<Entity, { type: "line" }>;
    const cross = (b.a.x - a.a.x) * (a.b.y - a.a.y) - (b.a.y - a.a.y) * (a.b.x - a.a.x);
    expect(cross / Math.hypot(a.b.x - a.a.x, a.b.y - a.a.y)).toBeCloseTo(0, 6);
    const cross2 = (b.b.x - a.a.x) * (a.b.y - a.a.y) - (b.b.y - a.a.y) * (a.b.x - a.a.x);
    expect(cross2 / Math.hypot(a.b.x - a.a.x, a.b.y - a.a.y)).toBeCloseTo(0, 6);
  });

  it("midpoint slides a point to the middle of a line", () => {
    const map = solved([point("p", 10, 30), line("l", 0, 0, 100, 0)], "midpoint");
    const p = map.get("p") as Extract<Entity, { type: "point" }>;
    const l = map.get("l") as Extract<Entity, { type: "line" }>;
    expect(p.p.x).toBeCloseTo((l.a.x + l.b.x) / 2, 6);
    expect(p.p.y).toBeCloseTo((l.a.y + l.b.y) / 2, 6);
  });

  it("point-on-curve drops a point onto a circle and onto a line", () => {
    const onCircle = solved([point("p", 40, 40), circle("c", 0, 0, 25)], "point-on-curve");
    const p = onCircle.get("p") as Extract<Entity, { type: "point" }>;
    const c = onCircle.get("c") as Extract<Entity, { type: "circle" }>;
    expect(Math.hypot(p.p.x - c.center.x, p.p.y - c.center.y)).toBeCloseTo(c.radius, 6);

    const onLine = solved([point("q", 50, 20), line("l", 0, 0, 100, 0)], "point-on-curve");
    const q = onLine.get("q") as Extract<Entity, { type: "point" }>;
    const l = onLine.get("l") as Extract<Entity, { type: "line" }>;
    const dy = Math.abs((q.p.x - l.a.x) * (l.b.y - l.a.y) - (q.p.y - l.a.y) * (l.b.x - l.a.x)) / 100;
    expect(dy).toBeCloseTo(0, 6);
  });

  it("symmetric mirrors two points about an axis", () => {
    // The axis is the y-axis; the two points should end up mirrored across it.
    const entities = [point("p1", -40, 10), point("p2", 50, 30), line("axis", 0, -50, 0, 50)];
    const constraints = built(buildConstraints("symmetric", entities, ctx));
    const result = solveSketch(entities, [...constraints, { id: "fx", type: "fix", entityId: "axis" }]);
    expect(result.converged).toBe(true);
    const map = new Map(entities.map((e) => [e.id, e]));
    for (const u of result.updates) map.set(u.id, u);
    const p1 = (map.get("p1") as Extract<Entity, { type: "point" }>).p;
    const p2 = (map.get("p2") as Extract<Entity, { type: "point" }>).p;
    expect(p1.x).toBeCloseTo(-p2.x, 6);
    expect(p1.y).toBeCloseTo(p2.y, 6);
  });

  it("tangent works with an arc as readily as a circle", () => {
    // The line is pinned, so tangency has to be reached by moving the arc —
    // otherwise least squares would meet in the middle and the test would
    // be checking nothing in particular.
    const entities = [arc("a", 50, 40, 20), line("l", 0, 0, 100, 0)];
    const constraints = built(buildConstraints("tangent", entities, ctx));
    const result = solveSketch(entities, [...constraints, { id: "fx", type: "fix", entityId: "l" }]);
    expect(result.converged).toBe(true);
    const a = (result.updates.find((u) => u.id === "a") ?? entities[0]) as Extract<Entity, { type: "arc" }>;
    expect(Math.abs(a.center.y)).toBeCloseTo(a.radius, 6);
    expect(a.center.y).toBeGreaterThan(0);
  });
});
