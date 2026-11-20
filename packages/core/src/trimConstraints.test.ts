import { describe, expect, it } from "vitest";
import type { Constraint } from "./constraints";
import type { CircleEntity, Entity, LineEntity } from "./entities";
import { trimAt } from "./intersect";
import { solveSketch } from "./solver";
import { trimConstraints } from "./trimConstraints";

const ln = (id: string, ax: number, ay: number, bx: number, by: number): LineEntity => ({ id, type: "line", a: { x: ax, y: ay }, b: { x: bx, y: by } });

/** Trims `target` at `near` against `cutters` and gives the pieces final ids `<target>-0`, `<target>-1`. */
function trim(target: Entity, cutters: Entity[], near: { x: number; y: number }): Entity[] {
  const r = trimAt(target, cutters, near)!;
  expect(r).toBeTruthy();
  return r.pieces.map((p, i) => ({ ...p, id: `${target.id}-${i}` }) as Entity);
}

const types = (cs: Constraint[]) => cs.map((c) => c.type).sort();

describe("trimConstraints (T-46: trim keeps the sketch's intent)", () => {
  it("keeps the corner and orientation of an end-trimmed line and ties the cut end to the cutter", () => {
    const l = ln("l", 0, 0, 20, 0);
    const m = ln("m", 0, 0, 0, 10);
    const cut = ln("c", 10, -5, 10, 5);
    const constraints: Constraint[] = [
      { id: "h", type: "horizontal", entityId: "l" },
      { id: "k", type: "coincident", a: { entityId: "l", point: "a" }, b: { entityId: "m", point: "a" } },
      { id: "v", type: "vertical", entityId: "m" },
    ];
    const pieces = trim(l, [m, cut], { x: 15, y: 0 });
    expect(pieces).toHaveLength(1);
    const after = [m, cut, ...pieces];
    const r = trimConstraints([{ original: l, pieces }], constraints, after);
    expect(r.remove.sort()).toEqual(["h", "k"]);
    expect(types(r.add)).toEqual(["coincident", "horizontal", "point-on-curve"]);
    const corner = r.add.find((c) => c.type === "coincident")!;
    expect(corner).toMatchObject({ a: { entityId: "l-0", point: "a" }, b: { entityId: "m", point: "a" } });
    const onCut = r.add.find((c) => c.type === "point-on-curve")!;
    expect(onCut).toMatchObject({ point: { entityId: "l-0", point: "b" }, entityId: "c" });
    const kept = constraints.filter((c) => !r.remove.includes(c.id));
    const s = solveSketch(after, [...kept, ...r.add]);
    expect(s.conflicts).toEqual([]);
    expect(s.residual).toBeLessThan(1e-6);
  });

  it("a cut at the cutter's own end becomes coincident with that end", () => {
    const l = ln("l", 0, 0, 20, 0);
    const cut = ln("c", 10, 0, 10, 8); // starts on l
    const pieces = trim(l, [cut], { x: 15, y: 0 });
    const r = trimConstraints([{ original: l, pieces }], [], [cut, ...pieces]);
    expect(r.add).toHaveLength(1);
    expect(r.add[0]).toMatchObject({ type: "coincident", a: { entityId: "l-0", point: "b" }, b: { entityId: "c", point: "a" } });
  });

  it("a middle trim leaves two collinear-in-spirit pieces, each horizontal and each on its cutter", () => {
    const l = ln("l", 0, 0, 30, 0);
    const c1 = ln("c1", 10, -5, 10, 5);
    const c2 = ln("c2", 20, -5, 20, 5);
    const pieces = trim(l, [c1, c2], { x: 15, y: 0 });
    expect(pieces).toHaveLength(2);
    const r = trimConstraints([{ original: l, pieces }], [{ id: "h", type: "horizontal", entityId: "l" }], [c1, c2, ...pieces]);
    expect(types(r.add)).toEqual(["horizontal", "horizontal", "point-on-curve", "point-on-curve"]);
    const on = r.add.filter((c) => c.type === "point-on-curve").map((c) => (c.type === "point-on-curve" ? c.entityId : "")).sort();
    expect(on).toEqual(["c1", "c2"]);
  });

  it("drops what a cut invalidates: equal length, the midpoint of the trimmed line, a point on the removed part", () => {
    const l = ln("l", 0, 0, 20, 0);
    const other = ln("o", 0, 5, 20, 5);
    const cut = ln("c", 10, -5, 10, 5);
    const p: Entity = { id: "p", type: "point", p: { x: 15, y: 0 } };
    const q: Entity = { id: "q", type: "point", p: { x: 4, y: 0 } };
    const constraints: Constraint[] = [
      { id: "eq", type: "equal", a: "l", b: "o" },
      { id: "mid", type: "midpoint", point: { entityId: "o", point: "a" }, entityId: "l" },
      { id: "gone", type: "point-on-curve", point: { entityId: "p", point: "a" }, entityId: "l" },
      { id: "kept", type: "point-on-curve", point: { entityId: "q", point: "a" }, entityId: "l" },
      { id: "par", type: "parallel", a: "l", b: "o" },
    ];
    const pieces = trim(l, [cut], { x: 15, y: 0 });
    const r = trimConstraints([{ original: l, pieces }], constraints, [other, cut, p, q, ...pieces]);
    expect(r.remove.sort()).toEqual(["eq", "gone", "kept", "mid", "par"]);
    expect(types(r.add)).toEqual(["parallel", "point-on-curve", "point-on-curve"]);
    expect(r.add.find((c) => c.type === "parallel")).toMatchObject({ a: "l-0", b: "o" });
    expect(r.add.some((c) => c.type === "point-on-curve" && c.point.entityId === "q" && c.entityId === "l-0")).toBe(true);
  });

  it("a circle trimmed to an arc keeps its radius and concentricity; both new ends sit on the cutter", () => {
    const circle: CircleEntity = { id: "k", type: "circle", center: { x: 0, y: 0 }, radius: 5 };
    const ring: CircleEntity = { id: "r", type: "circle", center: { x: 0, y: 0 }, radius: 8 };
    const cut = ln("c", -10, 2, 10, 2);
    const constraints: Constraint[] = [
      { id: "rad", type: "radius", entityId: "k", value: 5 },
      { id: "con", type: "concentric", a: "k", b: "r" },
      { id: "cen", type: "coincident", a: { entityId: "k", point: "center" }, b: { entityId: "c", point: "a" } },
    ];
    const pieces = trim(circle, [cut], { x: 0, y: 5 });
    expect(pieces).toHaveLength(1);
    expect(pieces[0].type).toBe("arc");
    const after = [ring, cut, ...pieces];
    const r = trimConstraints([{ original: circle, pieces }], constraints, after);
    expect(types(r.add)).toEqual(["coincident", "concentric", "point-on-curve", "point-on-curve", "radius"]);
    expect(r.add.find((c) => c.type === "coincident")).toMatchObject({ a: { entityId: "k-0", point: "center" } });
  });

  it("handles several replacements at once (a fence trim) without tying pieces of the same original together", () => {
    const a = ln("a", 0, 0, 20, 0);
    const b = ln("b", 10, -10, 10, 10);
    const pa = trim(a, [b], { x: 15, y: 0 });
    const pb = trim(b, [a], { x: 10, y: 5 });
    const after = [...pa, ...pb];
    const k: Constraint = { id: "perp", type: "perpendicular", a: "a", b: "b" };
    const r = trimConstraints(
      [
        { original: a, pieces: pa },
        { original: b, pieces: pb },
      ],
      [k],
      after,
    );
    expect(r.remove).toEqual(["perp"]);
    expect(r.add.find((c) => c.type === "perpendicular")).toMatchObject({ a: "a-0", b: "b-0" });
    // a's cut end and b's cut end meet at (10,0): one coincident each way is fine, but never a piece with itself.
    for (const c of r.add) if (c.type === "coincident") expect(c.a.entityId).not.toBe(c.b.entityId);
    const s = solveSketch(after, r.add);
    expect(s.conflicts).toEqual([]);
  });
});
