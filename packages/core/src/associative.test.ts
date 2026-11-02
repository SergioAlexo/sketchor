import { describe, expect, it } from "vitest";
import { axisLineFor, filletConstraints, filletCurveConstraints, mirrorConstraints, offsetConstraints } from "./associative";
import type { ArcEntity, Entity, LineEntity } from "./entities";
import { filletCurves } from "./filletCurves";
import { solveSketch } from "./solver";
import { filletLines } from "./fillet";
import { mirrored } from "./mirror";

const ln = (id: string, ax: number, ay: number, bx: number, by: number): LineEntity => ({ id, type: "line", a: { x: ax, y: ay }, b: { x: bx, y: by } });

describe("associative tools (T-46)", () => {
  it("finds the axis line only when both points lie on it", () => {
    const axis = ln("ax", 0, -5, 0, 5);
    expect(axisLineFor({ x: 0, y: 0 }, { x: 0, y: 1 }, [ln("o", 1, 1, 2, 2), axis])?.id).toBe("ax");
    expect(axisLineFor({ x: 1, y: 0 }, { x: 1, y: 1 }, [axis])).toBeNull();
    expect(axisLineFor({ x: 0, y: 0 }, { x: 0, y: 0 }, [ln("z", 0, 0, 0, 0)])).toBeNull();
  });

  it("mirror emits symmetric per point, equal for curves, nothing without an axis", () => {
    const axis = ln("ax", 0, -5, 0, 5);
    const src = ln("s", 1, 0, 2, 1);
    const copy = { ...mirrored(src, axis.a, axis.b), id: "c" };
    const k = mirrorConstraints([{ source: src, copy }], axis);
    expect(k.map((c) => c.type)).toEqual(["symmetric", "symmetric"]);
    expect(mirrorConstraints([{ source: src, copy }], null)).toEqual([]);
    const circ = { id: "k", type: "circle" as const, center: { x: 3, y: 0 }, radius: 1 };
    expect(mirrorConstraints([{ source: circ, copy: { ...circ, id: "k2" } }], axis).map((c) => c.type)).toEqual(["symmetric", "equal"]);
    expect(mirrorConstraints([{ source: axis, copy: { ...axis, id: "x" } }], axis)).toEqual([]);
  });

  it("offset keeps lines parallel and arcs concentric", () => {
    expect(offsetConstraints(ln("a", 0, 0, 1, 0), ln("b", 0, 1, 1, 1))[0].type).toBe("parallel");
    const c = { id: "c", type: "circle" as const, center: { x: 0, y: 0 }, radius: 1 };
    expect(offsetConstraints(c, { ...c, id: "d", radius: 2 })[0].type).toBe("concentric");
    expect(offsetConstraints(c, ln("l", 0, 0, 1, 1))).toEqual([]);
  });

  it("fillet ties both trimmed ends to the arc with tangents (+ optional radius), sharp corner = coincident", () => {
    const r = filletLines(ln("l1", 0, 0, 10, 0), ln("l2", 0, 0, 0, 10), 2, { x: 8, y: 0 }, { x: 0, y: 8 })!;
    const arc: ArcEntity = { ...r.arc!, id: "arc" };
    expect(filletConstraints(r.line1, r.line2, arc).map((c) => c.type)).toEqual(["coincident", "coincident", "tangent", "tangent"]);
    expect(filletConstraints(r.line1, r.line2, arc, true).at(-1)).toMatchObject({ type: "radius", value: 2 });
    expect(filletConstraints(r.line1, r.line2, null).map((c) => c.type)).toEqual(["coincident"]);
  });

  it("line–arc and line–circle fillets leave constraints the solver finds already satisfied", () => {
    const cases: [Entity, Entity, { x: number; y: number }, { x: number; y: number }][] = [
      [ln("l", -20, 0, 20, 0), { id: "k", type: "circle", center: { x: 0, y: 6 }, radius: 5 }, { x: 15, y: 0 }, { x: 5, y: 6 }],
      [ln("l", -20, 0, 20, 0), { id: "k", type: "arc", center: { x: 0, y: 6 }, radius: 5, startAngle: Math.PI, endAngle: 2 * Math.PI, ccw: true } as ArcEntity, { x: 15, y: 0 }, { x: 3.5, y: 2.9 }],
    ];
    for (const [e1, e2, n1, n2] of cases) {
      const f = filletCurves(e1, e2, 2, n1, n2)!;
      expect(f.arc).toBeTruthy();
      const arc: ArcEntity = { ...f.arc!, id: "fa" };
      const cs = filletCurveConstraints(f, arc, true);
      expect(cs.filter((c) => c.type === "tangent")).toHaveLength(2);
      expect(cs.filter((c) => c.type === "coincident" || c.type === "point-on-curve").length).toBeGreaterThanOrEqual(2);
      const r = solveSketch([f.first, f.second, arc], cs);
      expect(r.conflicts).toEqual([]);
      expect(r.residual).toBeLessThan(1e-4);
    }
    // sharp corner of two crossing lines
    const j = filletCurves(ln("a", 0, 0, 5, 0), ln("b", 3, -4, 3, 4), 0, { x: 1, y: 0 }, { x: 3, y: 2 })!;
    expect(filletCurveConstraints(j, null).map((c) => c.type)).toEqual(["coincident"]);
  });
});
