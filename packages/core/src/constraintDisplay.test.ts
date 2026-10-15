import { describe, expect, it } from "vitest";
import { constraintAnchors, entityAnchor, pointRefAt } from "./constraintDisplay";
import type { Entity } from "./entities";

/**
 * Constraint marks are the only thing on screen that says *why* a line
 * won't tilt. If a mark lands somewhere unrelated to the geometry it
 * describes — or a pairwise constraint marks only one of its two
 * entities — the sketch becomes unreadable exactly when it misbehaves,
 * which is when the marks matter.
 */

const lookup = (entities: Entity[]) => (id: string) => entities.find((e) => e.id === id);

const line: Entity = { id: "l", type: "line", a: { x: 0, y: 0 }, b: { x: 100, y: 0 } };
const other: Entity = { id: "m", type: "line", a: { x: 0, y: 40 }, b: { x: 100, y: 40 } };
const circle: Entity = { id: "c", type: "circle", center: { x: 50, y: 50 }, radius: 10 };

describe("entityAnchor", () => {
  it("marks a line at its middle and a circle on its rim", () => {
    expect(entityAnchor(line)).toEqual({ x: 50, y: 0 });
    const at = entityAnchor(circle)!;
    expect(Math.hypot(at.x - 50, at.y - 50)).toBeCloseTo(10, 9);
  });

  it("marks a polyline near the middle of its run, not at an end", () => {
    const pl: Entity = {
      id: "pl",
      type: "polyline",
      points: [
        { x: 0, y: 0 },
        { x: 10, y: 0 },
        { x: 10, y: 10 },
        { x: 20, y: 10 },
      ],
      closed: false,
    };
    expect(entityAnchor(pl)).toEqual({ x: 10, y: 5 });
  });

  it("has nowhere to mark on geometry a constraint can't hold", () => {
    const text: Entity = { id: "t", type: "image", insert: { x: 0, y: 0 }, width: 5, height: 5, rotation: 0 } as unknown as Entity;
    expect(entityAnchor(text)).toBeNull();
  });
});

describe("constraintAnchors", () => {
  it("marks both entities of a pairwise constraint", () => {
    const at = constraintAnchors(lookup([line, other]), { id: "k", type: "parallel", a: "l", b: "m" });
    expect(at).toEqual([
      { x: 50, y: 0 },
      { x: 50, y: 40 },
    ]);
  });

  it("marks the point, for constraints that are about a point", () => {
    expect(constraintAnchors(lookup([line, other]), { id: "k", type: "coincident", a: { entityId: "l", point: "b" }, b: { entityId: "m", point: "a" } })).toEqual([
      { x: 100, y: 0 },
    ]);
    expect(
      constraintAnchors(lookup([line, other]), {
        id: "k",
        type: "distance",
        a: { entityId: "l", point: "a" },
        b: { entityId: "m", point: "a" },
        value: 40,
      }),
    ).toEqual([{ x: 0, y: 20 }]);
  });

  it("marks nothing at all when the geometry is gone", () => {
    expect(constraintAnchors(lookup([]), { id: "k", type: "horizontal", entityId: "ghost" })).toEqual([]);
    expect(constraintAnchors(lookup([line]), { id: "k", type: "parallel", a: "l", b: "ghost" })).toEqual([{ x: 50, y: 0 }]);
  });
});

describe("pointRefAt", () => {
  it("resolves ends, centres, midpoints and numbered vertices", () => {
    const arc: Entity = { id: "a", type: "arc", center: { x: 0, y: 0 }, radius: 10, startAngle: 0, endAngle: Math.PI / 2, ccw: true };
    const pl: Entity = {
      id: "pl",
      type: "polyline",
      points: [
        { x: 0, y: 0 },
        { x: 5, y: 5 },
        { x: 10, y: 0 },
      ],
      closed: false,
    };
    const at = lookup([line, arc, pl, circle]);
    expect(pointRefAt(at, { entityId: "l", point: "center" })).toEqual({ x: 50, y: 0 });
    expect(pointRefAt(at, { entityId: "c", point: "center" })).toEqual({ x: 50, y: 50 });
    const arcEnd = pointRefAt(at, { entityId: "a", point: "b" })!;
    expect(arcEnd.x).toBeCloseTo(0, 9);
    expect(arcEnd.y).toBeCloseTo(10, 9);
    expect(pointRefAt(at, { entityId: "pl", point: "vertex", index: 1 })).toEqual({ x: 5, y: 5 });
    expect(pointRefAt(at, { entityId: "pl", point: "b" })).toEqual({ x: 10, y: 0 });
    expect(pointRefAt(at, { entityId: "pl", point: "vertex", index: 9 })).toBeNull();
  });
});
