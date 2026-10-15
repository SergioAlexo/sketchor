import { describe, expect, it } from "vitest";
import { axisLineFor, filletConstraints, mirrorConstraints, offsetConstraints } from "./associative";
import type { ArcEntity, LineEntity } from "./entities";
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
});
