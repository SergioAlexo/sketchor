/**
 * D-02c: which dimension a set of picks becomes. A wrong classification (a
 * length where the user meant an angle, a baseline stacked on the wrong side)
 * ships a wrong number into a drawing, so the decisions are pinned here.
 */
import { describe, expect, it } from "vitest";
import type { ArcEntity, CircleEntity, LineEntity } from "../entities";
import "../kinds/builtin";
import { chainDimension, dimAngle3, dimBetweenPoints, dimOfArcLength, dimOfCircle, dimOfLine, dimOfTwoLines, dimOrdinate, linearAngleFor, quickDimension, refAtPoint } from "./build";
import { layoutOf } from "./resolve";

const line = (id: string, ax: number, ay: number, bx: number, by: number): LineEntity => ({ id, type: "line", a: { x: ax, y: ay }, b: { x: bx, y: by } });
const circle: CircleEntity = { id: "c", type: "circle", center: { x: 5, y: 5 }, radius: 4 };
const arc: ArcEntity = { id: "a", type: "arc", center: { x: 0, y: 0 }, radius: 10, startAngle: 0, endAngle: Math.PI / 2, ccw: true };

describe("smart dimension builders", () => {
  it("a horizontal line becomes a linear dimension, a slanted one aligned, both attached to the line", () => {
    const h = dimOfLine(line("h", 0, 0, 30, 0), { x: 15, y: 5 });
    expect(h.kind).toBe("linear");
    expect(h.angle).toBe(0);
    expect(h.refs?.[0]).toEqual({ entityId: "h", point: "a" });
    expect(layoutOf(h, null).measure).toBeCloseTo(30);
    const v = dimOfLine(line("v", 0, 0, 0, 12), { x: 5, y: 6 });
    expect(v.angle).toBeCloseTo(Math.PI / 2);
    const s = dimOfLine(line("s", 0, 0, 3, 4), { x: 5, y: 0 });
    expect(s.kind).toBe("aligned");
    expect(layoutOf(s, null).measure).toBeCloseTo(5);
  });

  it("circle gives a diameter, arc a radius, and the target travels with it", () => {
    const d = dimOfCircle(circle, { x: 20, y: 5 })!;
    expect(d.kind).toBe("diametric");
    expect(d.target).toBe("c");
    expect(layoutOf(d, null).measure).toBeCloseTo(8);
    const r = dimOfCircle(arc, { x: 3, y: 3 })!;
    expect(r.kind).toBe("radial");
    expect(layoutOf(r, null).measure).toBeCloseTo(10);
    expect(dimOfCircle(line("l", 0, 0, 1, 1), { x: 0, y: 0 })).toBeNull();
    // A pick exactly on the centre must not produce NaN.
    expect(dimOfCircle(circle, { x: 5, y: 5 })!.defPoints[1].x).toBeCloseTo(9);
  });

  it("two crossing lines give an angle, two parallel lines the distance between them", () => {
    const ang = dimOfTwoLines(line("a", 0, 0, 10, 0), line("b", 0, 0, 0, 10), { x: 4, y: 4 })!;
    expect(ang.kind).toBe("angular2l");
    expect(ang.targets).toEqual(["a", "b"]);
    expect(layoutOf(ang, null).measure).toBeCloseTo(Math.PI / 2);
    const par = dimOfTwoLines(line("a", 0, 0, 10, 0), line("b", 0, 7, 10, 7), { x: 12, y: 3 })!;
    expect(par.kind).toBe("aligned");
    expect(layoutOf(par, null).measure).toBeCloseTo(7);
    expect(dimOfTwoLines(line("a", 0, 0, 10, 0), line("b", 2, 0, 8, 0), { x: 0, y: 1 })).toBeNull(); // collinear
    expect(dimOfTwoLines(line("z", 1, 1, 1, 1), line("b", 0, 0, 1, 0), { x: 0, y: 1 })).toBeNull(); // zero length
  });

  it("linear orientation follows where the dimension line is dragged", () => {
    const a = { x: 0, y: 0 };
    const b = { x: 10, y: 10 };
    expect(linearAngleFor(a, b, { x: 5, y: 30 })).toBe(0);
    expect(linearAngleFor(a, b, { x: 40, y: 5 })).toBeCloseTo(Math.PI / 2);
    const d = dimBetweenPoints(a, { x: 10, y: 4 }, { x: 5, y: -8 }, "linear");
    expect(layoutOf(d, null).measure).toBeCloseTo(10);
    expect(dimBetweenPoints(a, { x: 10, y: 4 }, { x: 5, y: -8 }, "aligned").kind).toBe("aligned");
  });

  it("arc length, angle by three points and ordinate", () => {
    expect(layoutOf(dimOfArcLength(arc, { x: 8, y: 8 })!, null).measure).toBeCloseTo((10 * Math.PI) / 2);
    expect(dimOfArcLength(circle, { x: 0, y: 0 })).toBeNull();
    expect(layoutOf(dimAngle3({ x: 0, y: 0 }, { x: 5, y: 0 }, { x: 0, y: 5 }, { x: 3, y: 3 }), null).measure).toBeCloseTo(Math.PI / 2);
    const o = dimOrdinate({ x: 0, y: 0 }, { x: 12, y: 3 }, { x: 12, y: 10 });
    expect(o.axis).toBe("x");
    expect(layoutOf(o, null).measure).toBeCloseTo(12);
    expect(dimOrdinate({ x: 0, y: 0 }, { x: 12, y: 3 }, { x: 30, y: 3 }).axis).toBe("y");
  });

  it("refAtPoint finds ends, centres and vertices, and answers null for a free point", () => {
    const ents = [line("l", 0, 0, 5, 0), circle, arc];
    expect(refAtPoint(ents, { x: 5, y: 0 })).toEqual({ entityId: "l", point: "b" });
    expect(refAtPoint(ents, { x: 5, y: 5 })).toEqual({ entityId: "c", point: "center" });
    expect(refAtPoint(ents, { x: 10, y: 0 })).toEqual({ entityId: "a", point: "a" });
    expect(refAtPoint(ents, { x: 77, y: 1 })).toBeNull();
    expect(refAtPoint([], { x: 0, y: 0 })).toBeNull();
  });
});

describe("baseline and continue", () => {
  const first = dimBetweenPoints({ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 5, y: -6 }, "linear", { style: "ISO-25" });
  it("continue starts at the previous end and shares its dimension line", () => {
    const next = chainDimension(first, { x: 25, y: 0 }, "continue", 8)!;
    expect(next.defPoints[0]).toEqual({ x: 10, y: 0 });
    expect(next.defPoints[2].y).toBe(-6);
    expect(next.style).toBe("ISO-25");
    expect(layoutOf(next, null).measure).toBeCloseTo(15);
  });
  it("baseline keeps the first point and steps further out on the same side", () => {
    const next = chainDimension(first, { x: 25, y: 0 }, "baseline", 8)!;
    expect(next.defPoints[0]).toEqual({ x: 0, y: 0 });
    expect(next.defPoints[2].y).toBeCloseTo(-14);
    expect(layoutOf(next, null).measure).toBeCloseTo(25);
    const above = dimBetweenPoints({ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 5, y: 6 }, "linear");
    expect(chainDimension(above, { x: 25, y: 0 }, "baseline", 8)!.defPoints[2].y).toBeCloseTo(14);
  });
  it("only linear and aligned dimensions chain", () => {
    expect(chainDimension(dimOfCircle(circle, { x: 9, y: 5 })!, { x: 0, y: 0 }, "continue", 8)).toBeNull();
  });
});

describe("quick dimension", () => {
  const ents = [line("a", 0, 0, 10, 0), line("b", 10, 0, 25, 0), line("c", 25, 0, 40, 0)];
  it("continued chain across the vertices, left to right, one dimension line", () => {
    const out = quickDimension(ents, { x: 20, y: -10 }, "continued", 6);
    expect(out.map((d) => Math.round(layoutOf(d, null).measure))).toEqual([10, 15, 15]);
    expect(new Set(out.map((d) => d.defPoints[2].y))).toEqual(new Set([-10]));
  });
  it("baseline measures from the first vertex and steps the lines out", () => {
    const out = quickDimension(ents, { x: 20, y: -10 }, "baseline", 6);
    expect(out.map((d) => Math.round(layoutOf(d, null).measure))).toEqual([10, 25, 40]);
    expect(out.map((d) => d.defPoints[2].y)).toEqual([-10, -16, -22]);
  });
  it("ordinate mode reads every vertex from the first", () => {
    const out = quickDimension(ents, { x: 20, y: -10 }, "ordinate", 6);
    expect(out.every((d) => d.kind === "ordinate")).toBe(true);
    expect(out.map((d) => Math.round(layoutOf(d, null).measure))).toEqual([10, 25, 40]);
  });
  it("placement beside the selection measures vertically; circles get their own dimension; degenerate input is empty", () => {
    const v = quickDimension([line("a", 0, 0, 0, 10), line("b", 0, 10, 0, 30)], { x: -8, y: 5 }, "continued", 6);
    expect(v.map((d) => d.angle)).toEqual([Math.PI / 2, Math.PI / 2]);
    expect(quickDimension([circle], { x: 20, y: 5 }, "continued", 6).map((d) => d.kind)).toEqual(["diametric"]);
    expect(quickDimension([], { x: 0, y: 0 }, "continued", 6)).toEqual([]);
    expect(quickDimension([line("z", 3, 3, 3, 3)], { x: 0, y: 9 }, "continued", 6)).toEqual([]);
  });
});
