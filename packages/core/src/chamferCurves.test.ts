/**
 * Chamfer between arcs/circles and lines (T-17 leftover). A chamfer's two
 * distances are measured along each curve from where they meet; get the
 * side wrong and the corner the user wanted is the piece that is deleted,
 * and a circle must never be trimmed. Properties: the cut points sit the
 * requested arc/line distance from the meeting point, on their curves; the
 * chamfer line joins them; too-large distances and non-meeting curves
 * refuse instead of producing a wrong shape.
 */
import { describe, expect, it } from "vitest";
import "./kinds/builtin";
import type { ArcEntity, CircleEntity, LineEntity } from "./entities";
import { chamferCurves } from "./filletCurves";
import { arcPointAt, dist } from "./geometry";

// Quarter arc r=10 about the origin, and a horizontal line y=5 that crosses it at (sqrt(75), 5).
const arc: ArcEntity = { id: "a", type: "arc", center: { x: 0, y: 0 }, radius: 10, startAngle: 0, endAngle: Math.PI / 2, ccw: true };
const hline: LineEntity = { id: "l", type: "line", a: { x: 0, y: 5 }, b: { x: 20, y: 5 } };
const X = { x: Math.sqrt(75), y: 5 };

describe("chamferCurves", () => {
  it("line + arc: cuts both at the distances from the corner and joins the cut points", () => {
    // Click the arc below the corner (toward angle 0) and the line left of it.
    const r = chamferCurves(arc, hline, 2, 3, { x: 9.9, y: 1.4 }, { x: 3, y: 5 })!;
    expect(r).not.toBeNull();
    const a = r.first as ArcEntity;
    // Kept arc runs from angle 0 up to the cut, 2 mm of arc short of the corner.
    const cornerAngle = Math.atan2(5, Math.sqrt(75));
    expect(a.startAngle).toBeCloseTo(0, 9);
    expect(a.endAngle).toBeCloseTo(cornerAngle - 2 / 10, 9);
    const l = r.second as LineEntity;
    const ends = [l.a, l.b].sort((p, q) => p.x - q.x);
    expect(ends[0].x).toBeCloseTo(0, 9);
    expect(ends[1].x).toBeCloseTo(X.x - 3, 9);
    const p1 = arcPointAt(arc.center, 10, a.endAngle);
    const c = r.line!;
    const cEnds = [c.a, c.b];
    expect(cEnds.some((p) => dist(p, p1) < 1e-9)).toBe(true);
    expect(cEnds.some((p) => dist(p, { x: X.x - 3, y: 5 }) < 1e-9)).toBe(true);
  });

  it("the click side decides which piece survives", () => {
    const r = chamferCurves(arc, hline, 2, 3, { x: 9.9, y: 1.4 }, { x: 18, y: 5 })!;
    const l = r.second as LineEntity;
    const ends = [l.a, l.b].sort((p, q) => p.x - q.x);
    expect(ends[0].x).toBeCloseTo(X.x + 3, 9);
    expect(ends[1].x).toBeCloseTo(20, 9);
  });

  it("arc + arc", () => {
    const a2: ArcEntity = { id: "b", type: "arc", center: { x: 10, y: 0 }, radius: 10, startAngle: Math.PI / 3, endAngle: Math.PI, ccw: true };
    const a1: ArcEntity = { ...arc, endAngle: Math.PI / 2 };
    // Circles cross at (5, 8.66); a1 keeps the side toward angle 0, a2 the side toward its end (angle pi).
    const r = chamferCurves(a1, a2, 1, 1, { x: 9, y: 4 }, { x: 1, y: 4 });
    expect(r).not.toBeNull();
    expect(dist(r!.line!.a, r!.line!.b)).toBeGreaterThan(0);
    for (const p of [r!.line!.a, r!.line!.b]) {
      const onOne = Math.abs(dist(p, a1.center) - 10) < 1e-9;
      const onTwo = Math.abs(dist(p, a2.center) - 10) < 1e-9;
      expect(onOne || onTwo).toBe(true);
    }
  });

  it("a circle is not trimmed: only the chamfer line is added", () => {
    const circle: CircleEntity = { id: "c", type: "circle", center: { x: 0, y: 0 }, radius: 10 };
    const r = chamferCurves(circle, hline, 1.5, 2, { x: 9, y: 4.5 }, { x: 3, y: 5 })!;
    expect(r.first).toEqual(circle);
    expect(r.line).not.toBeNull();
    // One end of the chamfer is on the circle 1.5 mm of arc from the corner, the other 2 mm along the line.
    const near = [r.line!.a, r.line!.b].find((p) => Math.abs(dist(p, { x: 0, y: 0 }) - 10) < 1e-9);
    expect(near).toBeDefined();
  });

  it("refuses a distance longer than the piece being kept", () => {
    expect(chamferCurves(arc, hline, 50, 1, { x: 9.9, y: 1.4 }, { x: 3, y: 5 })).toBeNull();
    expect(chamferCurves(arc, hline, 1, 50, { x: 9.9, y: 1.4 }, { x: 3, y: 5 })).toBeNull();
  });

  it("refuses curves that never meet, the same entity, bad distances and unsupported curves", () => {
    const far: LineEntity = { id: "f", type: "line", a: { x: 0, y: 50 }, b: { x: 20, y: 50 } };
    expect(chamferCurves(arc, far, 1, 1, { x: 9.9, y: 1.4 }, { x: 3, y: 50 })).toBeNull();
    expect(chamferCurves(arc, arc, 1, 1, { x: 9.9, y: 1.4 }, { x: 9.9, y: 1.4 })).toBeNull();
    expect(chamferCurves(arc, hline, -1, 1, { x: 9.9, y: 1.4 }, { x: 3, y: 5 })).toBeNull();
    expect(chamferCurves(arc, hline, NaN, 1, { x: 9.9, y: 1.4 }, { x: 3, y: 5 })).toBeNull();
    expect(chamferCurves({ id: "t", type: "text", at: { x: 0, y: 0 }, text: "x", height: 1, rotation: 0 }, hline, 1, 1, { x: 0, y: 0 }, { x: 3, y: 5 })).toBeNull();
  });

  it("two zero distances is a corner join (no chamfer line)", () => {
    const r = chamferCurves(arc, hline, 0, 0, { x: 9.9, y: 1.4 }, { x: 3, y: 5 })!;
    expect(r.line).toBeNull();
    const l = r.second as LineEntity;
    expect([l.a.x, l.b.x].some((x) => Math.abs(x - X.x) < 1e-9)).toBe(true);
  });

  it("one zero distance chamfers along the other curve only", () => {
    const r = chamferCurves(arc, hline, 0, 4, { x: 9.9, y: 1.4 }, { x: 3, y: 5 })!;
    expect(dist(r.line!.a, X) < 1e-9 || dist(r.line!.b, X) < 1e-9).toBe(true);
  });
});
