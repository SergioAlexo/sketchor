/**
 * D-07 centre marks / centrelines and D-09 dimension editing. What breaks in a
 * user's drawing: a centre mark that stays behind when its circle moves, a
 * centreline between lines drawn in opposite directions that comes out twisted,
 * a text-reset or DIMSPACE that is several undo steps, flipped arrows or
 * oblique extension lines that vanish on the next code-panel edit or a DXF
 * save, and a grip drag that silently keeps the old association.
 */
import { describe, expect, it } from "vitest";
import { CommandBus } from "../commands";
import { SketchDocument } from "../document";
import { entitiesToDxf2018 } from "../dxfw/index";
import { parseDxf } from "../dxf";
import type { DimensionEntity, Entity, LineEntity } from "../entities";
import { kindApplyGrip, kindBounds, kindGrips, kindHitDistance } from "../kinds/registry";
import "../kinds/builtin";
import { diffToCommands, parseCode, toCode } from "../sketchtext";
import { dimBetweenPoints, dimCenterLine, dimCenterMark, dimOfCircle } from "./build";
import { flipDimArrows, moveDimText, obliqueDim, reassociateDim, resetDimText, restyleDim, spaceDimensions, updateCommands } from "./edit";
import { explodeDimension } from "./explode";
import { layoutOf } from "./resolve";

const line = (id: string, ax: number, ay: number, bx: number, by: number): LineEntity => ({ id, type: "line", a: { x: ax, y: ay }, b: { x: bx, y: by } });
const circle = (id: string, x: number, y: number, r: number): Entity => ({ id, type: "circle", center: { x, y }, radius: r });
const D = (kind: DimensionEntity["kind"], pts: [number, number][], extra: Partial<DimensionEntity> = {}): DimensionEntity => ({
  id: `d-${kind}`,
  type: "dimension",
  kind,
  defPoints: pts.map(([x, y]) => ({ x, y })),
  driving: false,
  ...extra,
});
const withBus = (entities: Entity[]) => {
  const doc = new SketchDocument();
  const bus = new CommandBus(doc);
  for (const entity of entities) bus.execute({ type: "add-entity", entity });
  return { doc, bus };
};

describe("D-07 centre marks", () => {
  it("a short mark is a cross of the style's size; the extended one runs past the circle", () => {
    const c = circle("c", 10, 20, 8);
    const mark = dimCenterMark(c)!;
    const l = layoutOf(mark);
    expect(l.lines).toHaveLength(2);
    const xs = l.lines.flat().map((p) => p.x);
    expect(Math.min(...xs)).toBeCloseTo(10 - 2.5);
    expect(Math.max(...xs)).toBeCloseTo(10 + 2.5);
    const ext = dimCenterMark(c, {}, { extended: true })!;
    expect(ext.linetype).toBe("CENTER");
    const xe = layoutOf(ext).lines.flat().map((p) => p.x);
    expect(Math.max(...xe)).toBeCloseTo(10 + 8 + 2.5);
  });

  it("follows its circle: move, resize and undo are all one step", () => {
    const { doc, bus } = withBus([circle("c", 0, 0, 5)]);
    bus.execute({ type: "add-entity", entity: dimCenterMark(doc.get("c")!, { id: "cm" }, { extended: true })! });
    const reach = () => Math.max(...layoutOf(doc.get("cm") as DimensionEntity).lines.flat().map((p) => p.x));
    expect(reach()).toBeCloseTo(7.5);
    bus.execute({ type: "update-entity", entity: circle("c", 100, 0, 20) });
    expect(reach()).toBeCloseTo(122.5);
    const xs = layoutOf(doc.get("cm") as DimensionEntity).lines.flat().map((p) => p.x);
    expect(Math.min(...xs)).toBeCloseTo(77.5);
    bus.undo();
    expect(reach()).toBeCloseTo(7.5);
  });

  it("degenerate input: no centre mark for a line, a zero radius, or a missing target; a bare mark with no radius still draws", () => {
    expect(dimCenterMark(line("l", 0, 0, 1, 0))).toBeNull();
    expect(dimCenterMark(circle("c", 0, 0, 0))).toBeNull();
    expect(dimCenterMark(circle("c", 0, 0, NaN))).toBeNull();
    // Circle deleted: falls back to the stored points.
    const orphan = D("centermark", [[3, 4], [8, 4]], { target: "gone", overrides: { centerMark: "line" } });
    const l = layoutOf(orphan);
    expect(l.lines.flat().some((p) => Math.abs(p.x - (3 + 5 + 2.5)) < 1e-9)).toBe(true);
    expect(layoutOf(D("centermark", [], {})).lines).toEqual([]);
    expect(layoutOf(D("centermark", [[NaN, 0], [1, 1]])).lines).toEqual([]);
  });

  it("has bounds, a hit distance and no stray grips", () => {
    const m = dimCenterMark(circle("c", 0, 0, 5))!;
    const b = kindBounds(m)!;
    expect(b.minX).toBeCloseTo(-2.5);
    expect(kindHitDistance(m, { x: 0, y: 1 })).toBeLessThan(1e-9);
    expect(kindGrips(m)).toEqual([]);
  });
});

describe("D-07 centrelines", () => {
  it("runs midway between two lines whichever way each was drawn, and follows them", () => {
    const { doc, bus } = withBus([line("l1", 0, 0, 100, 0), line("l2", 100, 10, 0, 10)]);
    const cl = dimCenterLine(doc.get("l1")!, doc.get("l2")!, { id: "cl" })!;
    expect(cl.linetype).toBe("CENTER");
    bus.execute({ type: "add-entity", entity: cl });
    const run = () => layoutOf(doc.get("cl") as DimensionEntity).lines[0];
    expect(run()[0]).toEqual({ x: -2.5, y: 5 });
    expect(run()[1]).toEqual({ x: 102.5, y: 5 });
    bus.execute({ type: "update-entity", entity: line("l2", 100, 30, 0, 30) });
    expect(run()[0].y).toBeCloseTo(15);
    bus.undo();
    expect(run()[0].y).toBeCloseTo(5);
  });

  it("degenerate: same line, zero-length line, non-line, too few points", () => {
    const l = line("l1", 0, 0, 10, 0);
    expect(dimCenterLine(l, l)).toBeNull();
    expect(dimCenterLine(l, line("z", 5, 5, 5, 5))).toBeNull();
    expect(dimCenterLine(l, circle("c", 0, 0, 1))).toBeNull();
    expect(layoutOf(D("centerline", [[0, 0], [1, 0]])).lines).toEqual([]);
  });

  it("explodes to CENTER-linetype geometry for DXF 2018 and R12 readers", () => {
    const cl = dimCenterLine(line("l1", 0, 0, 100, 0), line("l2", 0, 10, 100, 10), { id: "cl" })!;
    const parts = explodeDimension(cl);
    expect(parts).toHaveLength(1);
    expect(parts[0].type).toBe("polyline");
    expect(parts[0].linetype).toBe("CENTER");
    const text = entitiesToDxf2018([cl]);
    expect(text).not.toContain("DIMENSION");
    const back = parseDxf(text);
    expect(back.entities.length).toBeGreaterThan(0);
  });

  it("round trips through sketch code and keeps its associations", () => {
    const { doc, bus } = withBus([{ ...line("l1", 0, 0, 100, 0), name: "L1" }, { ...line("l2", 0, 10, 100, 10), name: "L2" }]);
    bus.execute({ type: "add-entity", entity: { ...dimCenterLine(doc.get("l1")!, doc.get("l2")!, { id: "cl" })!, name: "CL1" } });
    bus.execute({ type: "add-entity", entity: { ...dimCenterMark(circle("c", 0, 0, 3), { id: "cm" })!, name: "CM1" } });
    const code = toCode(doc);
    expect(code).toContain("dimension CL1 centerline");
    expect(code).toContain("dimension CM1 centermark");
    const parsed = parseCode(code);
    expect(parsed.errors).toEqual([]);
    expect(diffToCommands(doc, parsed.entities)).toEqual([]);
    expect((doc.get("cl") as DimensionEntity).refs?.[2]?.entityId).toBe("l2");
  });
});

describe("D-09 text, arrows, style", () => {
  const base = () => dimBetweenPoints({ x: 0, y: 0 }, { x: 40, y: 0 }, { x: 20, y: 9 }, "linear", { id: "d" });

  it("moves the text (with a leader to the dimension line) and resets it", () => {
    const d = base();
    const m = moveDimText(d, { x: 60, y: 30 }, true);
    const l = layoutOf(m);
    expect(l.text!.at).toEqual({ x: 60, y: 30 });
    const leader = l.lines[l.lines.length - 1];
    expect(leader[0].x).toBeCloseTo(20);
    expect(leader[0].y).toBeCloseTo(9);
    expect(Math.hypot(leader[1].x - 60, leader[1].y - 30)).toBeLessThan(l.text!.width);
    expect(layoutOf(moveDimText(d, { x: 60, y: 30 })).lines.length).toBeLessThan(l.lines.length);
    const r = resetDimText(m);
    expect(r.textPos).toBeUndefined();
    expect(r.textLeader).toBeUndefined();
    expect(layoutOf(r).text!.at.x).toBeCloseTo(20);
    // Resetting an untouched dimension is a no-op for the command builder.
    expect(updateCommands([d], [resetDimText(d)])).toBeNull();
  });

  it("flips the arrows to the outside and back", () => {
    const d = base();
    const inside = layoutOf(d).fills[0];
    const f = flipDimArrows(d);
    expect(f.flipArrows).toBe(true);
    const outside = layoutOf(f).fills[0];
    // An arrow inside the extension lines points apart from the middle; outside it points inward — the tip stays, the body moves.
    expect(Math.max(...outside.map((p) => p.x))).not.toBeCloseTo(Math.max(...inside.map((p) => p.x)));
    expect(flipDimArrows(f).flipArrows).toBeUndefined();
  });

  it("oblique extension lines lean to the given angle and keep the measured length", () => {
    const d = obliqueDim(base(), Math.PI / 4);
    const l = layoutOf(d);
    expect(l.measure).toBeCloseTo(40);
    const ext = l.lines[0];
    const ang = Math.atan2(ext[1].y - ext[0].y, ext[1].x - ext[0].x);
    expect(ang).toBeCloseTo(Math.PI / 4);
    // The dimension line still sits at the placement height.
    expect(l.lines.some((r) => r.some((p) => Math.abs(p.y - 9) < 1e-9))).toBe(true);
    expect(obliqueDim(d, null).oblique).toBeUndefined();
    // Parallel to the dimension line is meaningless: ignored, not NaN.
    const flat = layoutOf(obliqueDim(base(), 0));
    expect(flat.lines.flat().every((p) => Number.isFinite(p.x) && Number.isFinite(p.y))).toBe(true);
    // Only linear / aligned have them.
    const rad = dimOfCircle(circle("c", 0, 0, 5), { x: 9, y: 0 })!;
    expect(obliqueDim(rad, 1)).toBe(rad);
  });

  it("restyle drops the overrides and rebinds the style", () => {
    const d = { ...base(), style: "A", overrides: { textHeight: 9 } };
    const r = restyleDim(d, "ISO-25");
    expect(r.style).toBe("ISO-25");
    expect(r.overrides).toBeUndefined();
    expect(restyleDim(d, undefined).style).toBeUndefined();
  });

  it("the new fields survive a code-panel edit and a DXF 2018 round trip", () => {
    const { doc, bus } = withBus([line("l1", 0, 0, 40, 0)]);
    const d = obliqueDim(flipDimArrows(moveDimText({ ...base(), name: "D1" }, { x: 50, y: 20 }, true)), 1);
    bus.execute({ type: "add-entity", entity: d });
    const edited = toCode(doc).replace("(20, 9)", "(20, 11)");
    for (const c of diffToCommands(doc, parseCode(edited).entities)) bus.execute(c);
    const got = doc.get("d") as DimensionEntity;
    expect(got.defPoints[2].y).toBe(11);
    expect(got.flipArrows).toBe(true);
    expect(got.textLeader).toBe(true);
    expect(got.oblique).toBe(1);
    const back = parseDxf(entitiesToDxf2018([got], { insUnits: 4 }));
    const dim = back.entities.find((e) => e.type === "dimension") as DimensionEntity;
    expect(dim.flipArrows).toBe(true);
    expect(dim.textLeader).toBe(true);
    expect(dim.oblique).toBe(1);
  });

  it("a whole edit is one undo step", () => {
    const { doc, bus } = withBus([]);
    const a = base();
    const b = { ...base(), id: "d2" };
    bus.execute({ type: "add-entity", entity: a });
    bus.execute({ type: "add-entity", entity: b });
    const cmd = updateCommands([a, b], [flipDimArrows(a), flipDimArrows(b)])!;
    bus.execute(cmd);
    expect((doc.get("d") as DimensionEntity).flipArrows).toBe(true);
    expect((doc.get("d2") as DimensionEntity).flipArrows).toBe(true);
    bus.undo();
    expect((doc.get("d") as DimensionEntity).flipArrows).toBeUndefined();
    expect((doc.get("d2") as DimensionEntity).flipArrows).toBeUndefined();
  });
});

describe("D-09 grips", () => {
  it("a linear dimension grips its extension-line origins; dragging one frees its association", () => {
    const { doc } = withBus([line("l", 0, 0, 40, 0)]);
    const d = { ...dimBetweenPoints({ x: 0, y: 0 }, { x: 40, y: 0 }, { x: 20, y: 9 }, "linear", { id: "d" }, [{ entityId: "l", point: "a" }, { entityId: "l", point: "b" }]) };
    const grips = kindGrips(d);
    expect(grips.map((g) => g.index).sort((a, b) => a - b)).toEqual([0, 100, 101, 102]);
    const g = grips.find((x) => x.index === 101)!;
    const moved = kindApplyGrip(d, g, { x: 55, y: 0 }) as DimensionEntity;
    expect(moved.defPoints[1]).toEqual({ x: 55, y: 0 });
    expect(moved.refs?.[1]).toBeNull();
    expect(moved.refs?.[0]?.entityId).toBe("l");
    void doc;
  });

  it("an attached circle dimension only exposes the dimension-line grip", () => {
    const r = dimOfCircle(circle("c", 0, 0, 5), { x: 9, y: 0 })!;
    expect(kindGrips(r).map((g) => g.index).sort((a, b) => a - b)).toEqual([0, 101]);
  });
});

describe("D-09 DIMSPACE", () => {
  const stack = () => [
    dimBetweenPoints({ x: 0, y: 0 }, { x: 40, y: 0 }, { x: 20, y: 10 }, "linear", { id: "a" }),
    dimBetweenPoints({ x: 0, y: 0 }, { x: 70, y: 0 }, { x: 20, y: 17 }, "linear", { id: "b" }),
    dimBetweenPoints({ x: 0, y: 0 }, { x: 90, y: 0 }, { x: 20, y: 40 }, "linear", { id: "c" }),
  ];

  it("stacks parallel dimensions an equal distance apart, counting from the base", () => {
    const out = spaceDimensions(stack(), 8, "a");
    const y = (id: string) => out.find((d) => d.id === id)!.defPoints[2].y;
    expect(y("b")).toBeCloseTo(18);
    expect(y("c")).toBeCloseTo(26);
    expect(out.find((d) => d.id === "a")).toBeUndefined();
  });

  it("spacing 0 lines them up on the base's line; below-the-base ones stack the other way", () => {
    const flat = spaceDimensions(stack(), 0, "a");
    expect(flat.every((d) => Math.abs(d.defPoints[2].y - 10) < 1e-9)).toBe(true);
    const dims = stack();
    dims[2] = dimBetweenPoints({ x: 0, y: 0 }, { x: 90, y: 0 }, { x: 20, y: -30 }, "linear", { id: "c" });
    const out = spaceDimensions(dims, 6, "a");
    expect(out.find((d) => d.id === "c")!.defPoints[2].y).toBeCloseTo(4);
  });

  it("leaves non-parallel and non-linear dimensions alone, and rejects nonsense", () => {
    const vertical = dimBetweenPoints({ x: 0, y: 0 }, { x: 0, y: 40 }, { x: 30, y: 20 }, "linear", { id: "v" });
    const rad = dimOfCircle(circle("c", 0, 0, 5), { x: 9, y: 0 })!;
    expect(spaceDimensions([stack()[0], vertical, rad], 5)).toEqual([]);
    expect(spaceDimensions([stack()[0]], 5)).toEqual([]);
    expect(spaceDimensions(stack(), -1)).toEqual([]);
    expect(spaceDimensions(stack(), NaN)).toEqual([]);
    expect(spaceDimensions([], 5)).toEqual([]);
  });

  it("applies as one undo step", () => {
    const { doc, bus } = withBus(stack());
    const before = stack();
    const cmd = updateCommands(before, spaceDimensions(before, 8, "a"))!;
    bus.execute(cmd);
    expect((doc.get("b") as DimensionEntity).defPoints[2].y).toBeCloseTo(18);
    bus.undo();
    expect((doc.get("b") as DimensionEntity).defPoints[2].y).toBeCloseTo(17);
    expect((doc.get("c") as DimensionEntity).defPoints[2].y).toBeCloseTo(40);
  });
});

describe("D-09 reassociate", () => {
  it("re-binds a free linear dimension to the lines under its points", () => {
    const d = dimBetweenPoints({ x: 0, y: 0 }, { x: 40, y: 0 }, { x: 20, y: 9 }, "linear", { id: "d" });
    const out = reassociateDim(d, [line("l", 0, 0, 40, 0)])!;
    expect(out.refs?.[0]).toEqual({ entityId: "l", point: "a" });
    expect(out.refs?.[1]).toEqual({ entityId: "l", point: "b" });
    expect(out.refs?.[2]).toBeNull();
    expect(reassociateDim(out, [line("l", 0, 0, 40, 0)])).toBeNull();
  });

  it("re-binds a radius dimension to the circle at its centre, and a centreline to its lines", () => {
    const r = { ...dimOfCircle(circle("c", 0, 0, 5), { x: 9, y: 0 })!, target: undefined } as DimensionEntity;
    expect(reassociateDim(r, [circle("c2", 0, 0, 5)])!.target).toBe("c2");
    const cl = dimCenterLine(line("a", 0, 0, 10, 0), line("b", 0, 4, 10, 4))!;
    const loose: DimensionEntity = { ...cl, refs: undefined, targets: undefined };
    const out = reassociateDim(loose, [line("a", 0, 0, 10, 0), line("b", 0, 4, 10, 4)])!;
    expect(out.targets).toEqual(["a", "b"]);
    expect(out.refs?.[3]?.entityId).toBe("b");
  });

  it("finds nothing => null (never a half-bound dimension)", () => {
    const d = dimBetweenPoints({ x: 0, y: 0 }, { x: 40, y: 0 }, { x: 20, y: 9 }, "linear", { id: "d" });
    expect(reassociateDim(d, [])).toBeNull();
    expect(reassociateDim(d, [line("l", 100, 100, 200, 100)])).toBeNull();
    expect(reassociateDim(D("radial", [[0, 0], [1, 0]]), [line("l", 0, 0, 1, 0)])).toBeNull();
    expect(reassociateDim(D("angular2l", [[0, 0]]), [])).toBeNull();
  });
});
