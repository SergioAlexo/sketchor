import { describe, expect, it } from "vitest";
import type { Constraint } from "../constraints";
import type { Entity } from "../entities";
import { solveSketch } from "./solve";

/**
 * The solver is the parametric layer's engine: it decides where geometry
 * *goes* when a constraint is added, a dimension is edited, or a
 * constrained point is dragged. Two failure modes matter and both are
 * silent. It can converge to a solution that satisfies the equations but
 * isn't the one the user meant — a rectangle that solves itself inside
 * out, a circle that jumps to the far side of a tangent line — and it can
 * report the wrong degrees of freedom, which is the number telling the
 * user whether their sketch is done. So these tests check the geometry
 * that comes back, not just that it converged, and they check the DoF and
 * conflict reporting on sketches whose answers are known by hand.
 */

const line = (id: string, ax: number, ay: number, bx: number, by: number): Entity => ({
  id,
  type: "line",
  a: { x: ax, y: ay },
  b: { x: bx, y: by },
});

const circle = (id: string, cx: number, cy: number, r: number): Entity => ({
  id,
  type: "circle",
  center: { x: cx, y: cy },
  radius: r,
});

const arc = (id: string, cx: number, cy: number, r: number, start: number, end: number): Entity => ({
  id,
  type: "arc",
  center: { x: cx, y: cy },
  radius: r,
  startAngle: start,
  endAngle: end,
  ccw: true,
});

const point = (id: string, x: number, y: number): Entity => ({ id, type: "point", p: { x, y } });

/** Applies a solve result to the sketch, the way the command bus will. */
function applied(entities: Entity[], updates: Entity[]): Map<string, Entity> {
  const map = new Map(entities.map((e) => [e.id, e]));
  for (const u of updates) map.set(u.id, u);
  return map;
}

const asLine = (e: Entity | undefined) => {
  if (!e || e.type !== "line") throw new Error("expected a line");
  return e;
};
const asCircle = (e: Entity | undefined) => {
  if (!e || e.type !== "circle") throw new Error("expected a circle");
  return e;
};

describe("solving one constraint at a time", () => {
  it("makes a nearly-horizontal line horizontal, moving it as little as it can", () => {
    const entities = [line("l", 0, 0, 100, 4)];
    const constraints: Constraint[] = [{ id: "k1", type: "horizontal", entityId: "l" }];
    const result = solveSketch(entities, constraints);
    expect(result.converged).toBe(true);
    const l = asLine(applied(entities, result.updates).get("l"));
    expect(l.a.y).toBeCloseTo(l.b.y, 9);
    // Least squares splits the 4mm error between the two ends rather than
    // dragging one of them all the way to the other.
    expect(l.a.y).toBeCloseTo(2, 6);
    expect(l.b.y).toBeCloseTo(2, 6);
    // Nothing else had any reason to move.
    expect(l.a.x).toBeCloseTo(0, 6);
    expect(l.b.x).toBeCloseTo(100, 6);
  });

  it("holds a fixed entity still and moves the other one instead", () => {
    const entities = [line("fixed", 0, 0, 100, 0), line("l", 0, 10, 100, 14)];
    const constraints: Constraint[] = [
      { id: "k1", type: "fix", entityId: "fixed" },
      { id: "k2", type: "parallel", a: "fixed", b: "l" },
    ];
    const result = solveSketch(entities, constraints);
    const map = applied(entities, result.updates);
    expect(asLine(map.get("fixed"))).toEqual(entities[0]);
    const l = asLine(map.get("l"));
    expect(l.a.y).toBeCloseTo(l.b.y, 6);
  });

  it("drives a distance to its value", () => {
    const entities = [point("p1", 0, 0), point("p2", 30, 40)];
    const constraints: Constraint[] = [
      { id: "k1", type: "fix", entityId: "p1" },
      { id: "k2", type: "distance", a: { entityId: "p1", point: "a" }, b: { entityId: "p2", point: "a" }, value: 100 },
    ];
    const result = solveSketch(entities, constraints);
    const p2 = applied(entities, result.updates).get("p2")!;
    if (p2.type !== "point") throw new Error("expected a point");
    expect(Math.hypot(p2.p.x, p2.p.y)).toBeCloseTo(100, 6);
    // It grew along the direction it already had (3-4-5), rather than
    // swinging round to some other point at the same distance.
    expect(p2.p.x / p2.p.y).toBeCloseTo(30 / 40, 6);
  });

  it("sets a radius, and makes two circles equal", () => {
    const entities = [circle("c1", 0, 0, 10), circle("c2", 50, 0, 25)];
    const constraints: Constraint[] = [
      { id: "k1", type: "radius", entityId: "c1", value: 17 },
      { id: "k2", type: "equal", a: "c1", b: "c2" },
    ];
    const result = solveSketch(entities, constraints);
    const map = applied(entities, result.updates);
    expect(asCircle(map.get("c1")).radius).toBeCloseTo(17, 6);
    expect(asCircle(map.get("c2")).radius).toBeCloseTo(17, 6);
  });

  it("puts two lines at a given angle", () => {
    const entities = [line("a", 0, 0, 100, 0), line("b", 0, 0, 100, 5)];
    const constraints: Constraint[] = [
      { id: "k1", type: "fix", entityId: "a" },
      { id: "k2", type: "angle", a: "a", b: "b", value: Math.PI / 4 },
    ];
    const result = solveSketch(entities, constraints);
    const b = asLine(applied(entities, result.updates).get("b"));
    const angle = Math.atan2(b.b.y - b.a.y, b.b.x - b.a.x);
    expect(angle).toBeCloseTo(Math.PI / 4, 6);
  });

  it("makes a line tangent to a circle without flipping it to the other side", () => {
    const entities = [circle("c", 50, 30, 20), line("l", 0, 0, 100, 0)];
    const constraints: Constraint[] = [
      { id: "k1", type: "fix", entityId: "l" },
      { id: "k2", type: "tangent", a: "c", b: "l" },
    ];
    const result = solveSketch(entities, constraints);
    const c = asCircle(applied(entities, result.updates).get("c"));
    // The line is y = 0, so tangency means the centre sits a radius above
    // it — above, because that is the side the circle started on.
    expect(Math.abs(c.center.y)).toBeCloseTo(c.radius, 6);
    expect(c.center.y).toBeGreaterThan(0);
  });

  it("moves an arc's endpoint by moving the arc, since that is all it can do", () => {
    // The arc's end is derived from its centre, radius and angle — a
    // constraint on it has to reach through all three.
    const entities = [arc("arc", 0, 0, 50, 0, Math.PI / 2), point("p", 0, 60)];
    const constraints: Constraint[] = [
      { id: "k1", type: "fix", entityId: "p" },
      { id: "k2", type: "coincident", a: { entityId: "arc", point: "b" }, b: { entityId: "p", point: "a" } },
    ];
    const result = solveSketch(entities, constraints);
    expect(result.converged).toBe(true);
    const a = applied(entities, result.updates).get("arc")!;
    if (a.type !== "arc") throw new Error("expected an arc");
    const end = { x: a.center.x + a.radius * Math.cos(a.endAngle), y: a.center.y + a.radius * Math.sin(a.endAngle) };
    expect(end.x).toBeCloseTo(0, 6);
    expect(end.y).toBeCloseTo(60, 6);
  });
});

describe("a rectangle, the sketch everyone draws first", () => {
  // Four sloppy lines, roughly a 100 × 60 box. The bottom is drawn level
  // on purpose: the tests below pin it, and pinning a line that isn't
  // horizontal while also demanding that it is would be a genuine
  // conflict rather than the sketch these tests mean to describe.
  const sketch = (): Entity[] => [
    line("bottom", 0, 0, 101, 0),
    line("right", 101, 2, 99, 61),
    line("top", 99, 61, -1, 59),
    line("left", -1, 59, 0, 0),
  ];

  const closed: Constraint[] = [
    { id: "c1", type: "coincident", a: { entityId: "bottom", point: "b" }, b: { entityId: "right", point: "a" } },
    { id: "c2", type: "coincident", a: { entityId: "right", point: "b" }, b: { entityId: "top", point: "a" } },
    { id: "c3", type: "coincident", a: { entityId: "top", point: "b" }, b: { entityId: "left", point: "a" } },
    { id: "c4", type: "coincident", a: { entityId: "left", point: "b" }, b: { entityId: "bottom", point: "a" } },
  ];

  const squared: Constraint[] = [
    ...closed,
    { id: "h1", type: "horizontal", entityId: "bottom" },
    { id: "h2", type: "horizontal", entityId: "top" },
    { id: "v1", type: "vertical", entityId: "left" },
    { id: "v2", type: "vertical", entityId: "right" },
  ];

  it("closes and squares up", () => {
    const entities = sketch();
    const result = solveSketch(entities, squared);
    expect(result.converged).toBe(true);
    const map = applied(entities, result.updates);
    const [bottom, right, top, left] = ["bottom", "right", "top", "left"].map((id) => asLine(map.get(id)));
    expect(bottom.a.y).toBeCloseTo(bottom.b.y, 6);
    expect(top.a.y).toBeCloseTo(top.b.y, 6);
    expect(left.a.x).toBeCloseTo(left.b.x, 6);
    expect(right.a.x).toBeCloseTo(right.b.x, 6);
    // Corners really meet.
    expect(bottom.b.x).toBeCloseTo(right.a.x, 6);
    expect(bottom.b.y).toBeCloseTo(right.a.y, 6);
  });

  it("counts the degrees of freedom a rectangle has left", () => {
    const entities = sketch();
    // 16 parameters: four lines of four. Closing the corners costs 8
    // equations and squaring it another 4, leaving exactly what a
    // rectangle is free to be — where it sits (2), how wide and how tall.
    const result = solveSketch(entities, squared);
    expect(result.status).toBe("under-constrained");
    expect(result.dof).toBe(4);
  });

  it("is fully constrained once it is fixed, sized and squared", () => {
    const entities = sketch();
    // Pinning the bottom edge settles position and width; one height
    // dimension settles the rest.
    const result = solveSketch(entities, [
      ...squared,
      { id: "f1", type: "fix", entityId: "bottom" },
      { id: "d1", type: "distance", a: { entityId: "left", point: "a" }, b: { entityId: "left", point: "b" }, value: 60 },
    ]);
    expect(result.dof).toBe(0);
    expect(result.status).toBe("fully-constrained");
    const map = applied(entities, result.updates);
    const left = asLine(map.get("left"));
    expect(Math.hypot(left.b.x - left.a.x, left.b.y - left.a.y)).toBeCloseTo(60, 6);
  });

  it("names the constraint it can't satisfy instead of silently settling", () => {
    const entities = sketch();
    const result = solveSketch(entities, [
      ...squared,
      { id: "f1", type: "fix", entityId: "bottom" },
      // Two different heights for the same side.
      { id: "d1", type: "distance", a: { entityId: "left", point: "a" }, b: { entityId: "left", point: "b" }, value: 60 },
      { id: "d2", type: "distance", a: { entityId: "left", point: "a" }, b: { entityId: "left", point: "b" }, value: 80 },
    ]);
    expect(result.status).toBe("over-constrained");
    expect(result.conflicts.sort()).toEqual(["d1", "d2"]);
  });

  it("spots a constraint that is merely implied by the others", () => {
    const entities = sketch();
    const result = solveSketch(entities, [
      ...squared,
      // Both sides are already vertical, so telling them they are also
      // parallel adds nothing.
      { id: "p1", type: "parallel", a: "left", b: "right" },
    ]);
    expect(result.redundant).toContain("p1");
    expect(result.status).not.toBe("over-constrained");
  });
});

describe("dragging", () => {
  it("follows the cursor as far as the constraints allow", () => {
    // A horizontal line, fixed at one end: its other end can only slide
    // along the horizontal, however far up the cursor goes.
    const entities = [line("l", 0, 0, 100, 0), point("anchor", 0, 0)];
    const constraints: Constraint[] = [
      { id: "k1", type: "fix", entityId: "anchor" },
      { id: "k2", type: "coincident", a: { entityId: "l", point: "a" }, b: { entityId: "anchor", point: "a" } },
      { id: "k3", type: "horizontal", entityId: "l" },
    ];
    const result = solveSketch(entities, constraints, {
      drag: { ref: { entityId: "l", point: "b" }, to: { x: 150, y: 40 } },
    });
    const l = asLine(applied(entities, result.updates).get("l"));
    expect(l.a.x).toBeCloseTo(0, 6);
    expect(l.a.y).toBeCloseTo(0, 6);
    expect(l.b.x).toBeCloseTo(150, 3);
    expect(l.b.y).toBeCloseTo(0, 6);
  });

  it("doesn't let the drag's pull count as a constraint in the diagnosis", () => {
    const entities = [line("l", 0, 0, 100, 0)];
    const free = solveSketch(entities, []);
    const dragged = solveSketch(entities, [], { drag: { ref: { entityId: "l", point: "b" }, to: { x: 120, y: 0 } } });
    expect(dragged.dof).toBe(free.dof);
    expect(dragged.status).toBe("under-constrained");
  });
});

describe("edge cases that must not throw or hang", () => {
  it("solves an empty sketch", () => {
    const result = solveSketch([], []);
    expect(result).toMatchObject({ updates: [], dof: 0, conflicts: [], converged: true });
  });

  it("ignores constraints pointing at entities that are gone", () => {
    const entities = [line("l", 0, 0, 100, 4)];
    const result = solveSketch(entities, [
      { id: "k1", type: "horizontal", entityId: "ghost" },
      { id: "k2", type: "coincident", a: { entityId: "ghost", point: "a" }, b: { entityId: "l", point: "a" } },
      { id: "k3", type: "horizontal", entityId: "l" },
    ]);
    expect(result.converged).toBe(true);
    expect(asLine(applied(entities, result.updates).get("l")).a.y).toBeCloseTo(2, 6);
  });

  it("ignores constraints on geometry it has no parameters for", () => {
    const text: Entity = { id: "t", type: "image", insert: { x: 0, y: 0 }, width: 5, height: 5, rotation: 0 } as unknown as Entity;
    const result = solveSketch([text], [{ id: "k1", type: "horizontal", entityId: "t" }]);
    expect(result.updates).toEqual([]);
    expect(result.dof).toBe(0);
  });

  it("reports an unconstrained sketch's degrees of freedom", () => {
    const result = solveSketch([line("l", 0, 0, 10, 0), circle("c", 0, 0, 5)], []);
    expect(result.dof).toBe(7); // 4 for the line, 3 for the circle
    expect(result.updates).toEqual([]);
  });

  it("leaves an already-satisfied sketch exactly alone", () => {
    const entities = [line("l", 0, 0, 100, 0)];
    const result = solveSketch(entities, [{ id: "k1", type: "horizontal", entityId: "l" }]);
    expect(result.updates).toEqual([]);
    expect(result.iterations).toBe(0);
  });

  it("gives up rather than spinning on constraints that can't be met", () => {
    // Two points fixed 100 apart, told to be 5 apart: nothing can move.
    const entities = [point("p1", 0, 0), point("p2", 100, 0)];
    const result = solveSketch(entities, [
      { id: "f1", type: "fix", entityId: "p1" },
      { id: "f2", type: "fix", entityId: "p2" },
      { id: "d1", type: "distance", a: { entityId: "p1", point: "a" }, b: { entityId: "p2", point: "a" }, value: 5 },
    ]);
    expect(result.status).toBe("over-constrained");
    expect(result.conflicts).toEqual(["d1"]);
    expect(result.updates).toEqual([]);
  });
});
