import { describe, expect, it } from "vitest";
import type { Constraint } from "./constraints";
import type { Entity } from "./entities";
import { inferConstraints } from "./inference";
import { solveSketch } from "./solver/solve";

/**
 * Auto-constraints (T-43) must name only relationships the user really
 * drew. A false positive silently pins geometry the user wants to move;
 * a near-miss (cursor a hair off a corner) must never qualify.
 */

const line = (id: string, ax: number, ay: number, bx: number, by: number): Entity => ({
  id,
  type: "line",
  a: { x: ax, y: ay },
  b: { x: bx, y: by },
});
const circle = (id: string, cx: number, cy: number, r: number): Entity => ({ id, type: "circle", center: { x: cx, y: cy }, radius: r });
const types = (cs: Constraint[]) => cs.map((c) => c.type).sort();

describe("inferConstraints", () => {
  it("makes a horizontal and a vertical line", () => {
    expect(types(inferConstraints([line("h", 0, 5, 10, 5)], []))).toEqual(["horizontal"]);
    expect(types(inferConstraints([line("v", 3, 0, 3, 9)], []))).toEqual(["vertical"]);
  });

  it("leaves a slanted, unrelated line alone", () => {
    expect(inferConstraints([line("s", 0, 0, 10, 3)], [])).toEqual([]);
  });

  it("ignores a near miss", () => {
    const base = line("a", 0, 0, 10, 0);
    expect(inferConstraints([line("b", 10.001, 0, 20, 7)], [base])).toEqual([]);
    expect(types(inferConstraints([line("b", 0, 0, 10, 0.001)], []))).toEqual([]);
  });

  it("joins a line to an existing endpoint with a coincident", () => {
    const cs = inferConstraints([line("b", 10, 0, 20, 7)], [line("a", 0, 0, 10, 0)]);
    expect(cs).toMatchObject([{ type: "coincident", a: { entityId: "b", point: "a" }, b: { entityId: "a", point: "b" } }]);
  });

  it("states a joint between two new lines once, not twice", () => {
    const cs = inferConstraints([line("a", 0, 0, 10, 4), line("b", 10, 4, 12, 20)], []);
    expect(cs.filter((c) => c.type === "coincident")).toHaveLength(1);
  });

  it("finds a midpoint and a point on a curve", () => {
    const base = line("a", 0, 0, 10, 0);
    const cs = inferConstraints([line("b", 5, 0, 5, 8)], [base]);
    expect(types(cs)).toEqual(["midpoint", "vertical"]);
    const onLine = inferConstraints([line("c", 3, 0, 4, 9)], [base]);
    expect(onLine).toMatchObject([{ type: "point-on-curve", point: { entityId: "c", point: "a" }, entityId: "a" }]);
  });

  it("recognises a perpendicular to a slanted line", () => {
    const base = line("a", 0, 0, 10, 10);
    const cs = inferConstraints([line("b", 5, 5, 8, 2)], [base]);
    expect(types(cs)).toContain("perpendicular");
  });

  it("recognises a line tangent to a circle at its end", () => {
    const c = circle("c", 0, 0, 5);
    const cs = inferConstraints([line("t", 5, 0, 5, 9)], [c]);
    expect(types(cs)).toContain("tangent");
    expect(types(cs)).toContain("point-on-curve");
  });

  it("recognises a slanted line parallel to another, but not two horizontals", () => {
    const base = line("a", 0, 0, 4, 3);
    expect(types(inferConstraints([line("b", 10, 10, 18, 16)], [base]))).toEqual(["parallel"]);
    expect(types(inferConstraints([line("b", 0, 9, 4, 9)], [line("a", 0, 0, 4, 0)]))).toEqual(["horizontal"]);
  });

  it("handles degenerate input without throwing", () => {
    expect(inferConstraints([line("z", 1, 1, 1, 1)], [])).toEqual([]);
    expect(inferConstraints([circle("c", 0, 0, 0)], [])).toEqual([]);
    expect(inferConstraints([], [line("a", 0, 0, 1, 1)])).toEqual([]);
  });

  it("builds a rectangle that the solver accepts as fully consistent", () => {
    const rect = [line("r1", 0, 0, 10, 0), line("r2", 10, 0, 10, 6), line("r3", 10, 6, 0, 6), line("r4", 0, 6, 0, 0)];
    const cs = inferConstraints(rect, []);
    expect(cs.filter((c) => c.type === "coincident")).toHaveLength(4);
    expect(cs.filter((c) => c.type === "horizontal" || c.type === "vertical")).toHaveLength(4);
    const r = solveSketch(rect, cs);
    expect(r.status).not.toBe("over-constrained");
    expect(r.conflicts).toEqual([]);
  });
});
