/**
 * D-02a: a dimension is one entity whose layout (extension lines, arrows, text)
 * is computed, not drawn. If the layout, the associative references, the block
 * placement or the exporters disagree, a drawing shows one number while the
 * file carries another — so each of those is pinned here.
 */
import { describe, expect, it } from "vitest";
import { evaluateInsert } from "../blocks/evaluate";
import type { BlockDefinition } from "../blocks/types";
import { parseClipboard, pasteCommands, serializeSelection } from "../clipboard";
import { CommandBus } from "../commands";
import { SketchDocument } from "../document";
import { entitiesToDxf2018 } from "../dxfw";
import { entitiesToDxf } from "../dxfExport";
import type { DimensionEntity, Entity, InsertEntity, LineEntity } from "../entities";
import { rotated, translated, transformed } from "../entities";
import { kindBounds, kindHitDistance, kindTessellate, kindTransform } from "../kinds/registry";
import "../kinds/builtin";
import { entitiesToSvgDocument } from "../svg";
import { diffToCommands, parseCode, toCode } from "../sketchtext";
import { withDimHost } from "./context";
import { explodeDimension } from "./explode";
import { layoutOf, measureOf } from "./resolve";
import { DEFAULT_DIM_STYLE, DIM_STYLE_PRESETS, dimStyleOf } from "./style";

const dim = (over: Partial<DimensionEntity> = {}): DimensionEntity => ({
  id: "d1",
  type: "dimension",
  kind: "linear",
  defPoints: [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 50, y: 20 }],
  driving: false,
  ...over,
});

const line = (id: string, ax: number, ay: number, bx: number, by: number): LineEntity => ({ id, type: "line", a: { x: ax, y: ay }, b: { x: bx, y: by } });

describe("layout", () => {
  it("horizontal linear: measure, ext lines, dimension line, two arrows and text", () => {
    const l = layoutOf(dim(), null);
    expect(l.measure).toBeCloseTo(100);
    expect(l.text?.text).toBe("100");
    expect(l.fills).toHaveLength(2); // closed filled arrows
    expect(l.lines.length).toBeGreaterThanOrEqual(3);
    // The dimension line sits at y = 20 and the text above it.
    expect(l.text!.at.y).toBeGreaterThan(20);
    expect(l.text!.rotation).toBeCloseTo(0);
  });
  it("vertical linear (angle 90) measures the y distance only", () => {
    const l = layoutOf(dim({ angle: Math.PI / 2, defPoints: [{ x: 0, y: 0 }, { x: 30, y: 40 }, { x: 60, y: 20 }] }), null);
    expect(l.measure).toBeCloseTo(40);
  });
  it("aligned follows the slope", () => {
    const l = layoutOf(dim({ kind: "aligned", defPoints: [{ x: 0, y: 0 }, { x: 30, y: 40 }, { x: 0, y: 40 }] }), null);
    expect(l.measure).toBeCloseTo(50);
    expect(l.text!.text).toBe("50");
  });
  it("angular3p measures the sector holding the arc point, both ways round", () => {
    const pts = (ap: { x: number; y: number }) => [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 0, y: 10 }, ap];
    expect(layoutOf(dim({ kind: "angular3p", defPoints: pts({ x: 7, y: 7 }) }), null).measure).toBeCloseTo(Math.PI / 2);
    expect(layoutOf(dim({ kind: "angular3p", defPoints: pts({ x: -7, y: -7 }) }), null).measure).toBeCloseTo((3 * Math.PI) / 2);
    expect(layoutOf(dim({ kind: "angular3p", defPoints: pts({ x: 7, y: 7 }) }), null).text!.text).toBe("90°");
  });
  it("angular2l between two lines, picking the sector with the arc point", () => {
    const d = dim({ kind: "angular2l", defPoints: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 0, y: 0 }, { x: 10, y: 10 }, { x: 8, y: 3 }] });
    expect(layoutOf(d, null).measure).toBeCloseTo(Math.PI / 4);
    const obtuse = dim({ kind: "angular2l", defPoints: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 0, y: 0 }, { x: 10, y: 10 }, { x: -3, y: 5 }] });
    expect(layoutOf(obtuse, null).measure).toBeCloseTo((3 * Math.PI) / 4);
    // Parallel lines: nothing to measure.
    const par = dim({ kind: "angular2l", defPoints: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 0, y: 5 }, { x: 10, y: 5 }, { x: 5, y: 2 }] });
    expect(layoutOf(par, null).measure).toBeNaN();
  });
  it("radial, diametric, jogged from def points", () => {
    const base = { defPoints: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: -6, y: 5 }] };
    expect(layoutOf(dim({ ...base, kind: "radial" }), null).text!.text).toBe("R10");
    expect(layoutOf(dim({ ...base, kind: "diametric" }), null).text!.text).toBe("⌀20");
    const j = layoutOf(dim({ ...base, kind: "jogged" }), null);
    expect(j.text!.text).toBe("R10");
    expect(j.lines[0].length).toBeGreaterThanOrEqual(5); // zig-zag
  });
  it("arc length and ordinate", () => {
    const arc = dim({ kind: "arclength", defPoints: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 0, y: 10 }, { x: 8, y: 8 }] });
    expect(layoutOf(arc, null).measure).toBeCloseTo((10 * Math.PI) / 2);
    const ord = dim({ kind: "ordinate", axis: "x", defPoints: [{ x: 0, y: 0 }, { x: 35, y: 10 }, { x: 35, y: 25 }] });
    expect(layoutOf(ord, null).measure).toBeCloseTo(35);
    expect(layoutOf({ ...ord, axis: "y" }, null).measure).toBeCloseTo(10);
  });
  it("text override with <> and reference parentheses", () => {
    expect(layoutOf(dim({ textOverride: "<> typ." }), null).text!.text).toBe("100 typ.");
    expect(layoutOf(dim({ textOverride: "see note" }), null).text!.text).toBe("see note");
    expect(layoutOf(dim({ overrides: { referenceParens: true } }), null).text!.text).toBe("(100)");
    expect(layoutOf(dim({ driving: true, value: 100, overrides: { referenceParens: true } }), null).text!.text).toBe("100");
  });
  it("short dimensions put arrows and text outside; zero length does not blow up", () => {
    const tiny = layoutOf(dim({ defPoints: [{ x: 0, y: 0 }, { x: 3, y: 0 }, { x: 1, y: 8 }] }), null);
    expect(tiny.text!.at.x).toBeGreaterThan(3);
    const zero = layoutOf(dim({ defPoints: [{ x: 5, y: 5 }, { x: 5, y: 5 }, { x: 5, y: 9 }] }), null);
    expect(zero.measure).toBe(0);
    expect(zero.text).toBeNull();
    expect(layoutOf(dim({ defPoints: [] }), null).measure).toBeNaN();
  });
  it("presets differ where the standards differ", () => {
    const gost = DIM_STYLE_PRESETS.find((s) => s.name === "GOST")!;
    const ansi = DIM_STYLE_PRESETS.find((s) => s.name === "ANSI")!;
    expect(gost.decimalSep).toBe(",");
    expect(ansi.textAbove).toBe(false);
    expect(dimStyleOf(undefined).textHeight).toBe(DEFAULT_DIM_STYLE.textHeight);
    expect(dimStyleOf({ name: "x", textHeight: Number.NaN, decimals: 99 }).decimals).toBe(8);
  });
  it("scale multiplies sizes", () => {
    const a = layoutOf(dim(), null).text!.height;
    expect(layoutOf(dim({ scale: 2 }), null).text!.height).toBeCloseTo(2 * a);
  });
});

describe("kind registration", () => {
  it("has bounds containing the tessellation, and is hit near its line and in its text", () => {
    const d = dim();
    const b = kindBounds(d)!;
    for (const p of kindTessellate(d, 0.01).flat()) {
      expect(p.x).toBeGreaterThanOrEqual(b.minX - 1e-6);
      expect(p.y).toBeLessThanOrEqual(b.maxY + 1e-6);
    }
    expect(kindHitDistance(d, { x: 20, y: 20 })).toBeLessThan(0.01);
    expect(kindHitDistance(d, layoutOf(d, null).text!.at)).toBe(0);
    expect(kindHitDistance(d, { x: 20, y: 80 })).toBeGreaterThan(30);
  });
  it("translated / rotated keep id, layer, colour; geometry follows", () => {
    const d = dim({ layer: "DIM", color: "#f00" });
    const t = translated(d, 5, 7) as DimensionEntity;
    expect(t).toMatchObject({ id: "d1", layer: "DIM", color: "#f00" });
    expect(t.defPoints[0]).toEqual({ x: 5, y: 7 });
    const r = rotated(d, { x: 0, y: 0 }, Math.PI / 2) as DimensionEntity;
    expect(r.angle).toBeCloseTo(Math.PI / 2);
    expect(layoutOf(r, null).measure).toBeCloseTo(100);
  });
  it("uniform scale scales sizes and the driving value; shear is refused", () => {
    const s = kindTransform(dim({ driving: true, value: 100 }), [2, 0, 0, 2, 0, 0]) as DimensionEntity;
    expect(s.scale).toBe(2);
    expect(s.value).toBe(200);
    expect(layoutOf(s, null).measure).toBeCloseTo(200);
    expect(kindTransform(dim(), [1, 0, 0.5, 1, 0, 0])).toBeNull();
    expect(kindTransform(dim(), [1, 0, 0, 3, 0, 0])).toBeNull();
    const ordinate = dim({ kind: "ordinate", axis: "x", defPoints: [{ x: 0, y: 0 }, { x: 5, y: 5 }, { x: 5, y: 9 }] });
    expect((kindTransform(ordinate, [0, 1, -1, 0, 0, 0]) as DimensionEntity).axis).toBe("y");
    expect(kindTransform(ordinate, [Math.cos(0.5), Math.sin(0.5), -Math.sin(0.5), Math.cos(0.5), 0, 0])).toBeNull();
  });
  it("mirror keeps the measured value", () => {
    const m = transformed(dim(), { x: 0, y: 0 }, 0, 0, 0, 1) as DimensionEntity;
    expect(layoutOf(m, null).measure).toBeCloseTo(100);
  });
});

describe("associativity", () => {
  it("follows the geometry it is attached to, and degrades to def points when it is gone", () => {
    const doc = new SketchDocument();
    const bus = new CommandBus(doc);
    bus.execute({ type: "add-entity", entity: line("l1", 0, 0, 100, 0) });
    bus.execute({
      type: "add-entity",
      entity: dim({ refs: [{ entityId: "l1", point: "a" }, { entityId: "l1", point: "b" }, null] }),
    });
    const d = () => doc.get("d1") as DimensionEntity;
    expect(measureOf(d(), doc)).toBeCloseTo(100);
    bus.execute({ type: "update-entity", entity: line("l1", 0, 0, 160, 0) });
    expect(measureOf(d(), doc)).toBeCloseTo(160);
    bus.execute({ type: "delete-entities", ids: ["l1"] });
    expect(measureOf(d(), doc)).toBeCloseTo(100);
  });
  it("radial follows the circle's radius", () => {
    const doc = new SketchDocument();
    const bus = new CommandBus(doc);
    bus.execute({ type: "add-entity", entity: { id: "c1", type: "circle", center: { x: 0, y: 0 }, radius: 10 } });
    bus.execute({ type: "add-entity", entity: dim({ kind: "radial", target: "c1", defPoints: [{ x: 0, y: 0 }, { x: 10, y: 0 }] }) });
    bus.execute({ type: "update-entity", entity: { id: "c1", type: "circle", center: { x: 3, y: 3 }, radius: 25 } });
    expect(measureOf(doc.get("d1") as DimensionEntity, doc)).toBeCloseTo(25);
  });
});

describe("inside block inserts", () => {
  const block: BlockDefinition = {
    name: "B",
    basePoint: { x: 0, y: 0 },
    entities: [line("ll", 0, 0, 100, 0), dim({ id: "bd", refs: [{ entityId: "ll", point: "a" }, { entityId: "ll", point: "b" }, null], target: "ll" })],
    attributeDefs: [],
    explodable: true,
    scaleUniformly: false,
  };
  const insert = (over: Partial<InsertEntity> = {}): InsertEntity => ({
    id: "i1",
    type: "insert",
    block: "B",
    insert: { x: 10, y: 10 },
    scale: { x: 1, y: 1 },
    rotation: 0,
    attributes: {},
    ...over,
  });
  const host = { getRecord: (_t: string, n: string) => (n === "B" ? block : undefined), tablesRevision: 1 };
  it("is placed, scaled and detached from the definition's ids", () => {
    const placed = evaluateInsert(host, insert({ scale: { x: 2, y: 2 }, rotation: Math.PI / 2 })).find((e) => e.type === "dimension") as DimensionEntity;
    expect(placed.refs).toBeUndefined();
    expect(placed.target).toBeUndefined();
    expect(placed.scale).toBe(2);
    expect(layoutOf(placed, null).measure).toBeCloseTo(200);
  });
  it("a mirrored insert keeps the dimension readable", () => {
    const placed = evaluateInsert(host, insert({ scale: { x: -1, y: 1 } })).find((e) => e.type === "dimension") as DimensionEntity;
    expect(layoutOf(placed, null).measure).toBeCloseTo(100);
    expect(layoutOf(placed, null).text!.rotation).toBeGreaterThan(-Math.PI / 2 - 1e-9);
  });
  it("DXF 2018 and SVG writers expand it instead of dropping it", () => {
    const doc = new SketchDocument();
    const bus = new CommandBus(doc);
    bus.execute({ type: "put-table-record", table: "blocks", record: block });
    bus.execute({ type: "add-entity", entity: insert() });
    const dxf = entitiesToDxf2018(doc.all(), { blocks: [block] });
    expect(dxf).toContain("100"); // the dimension text
    expect(dxf).toMatch(/0\nTEXT/);
    const svg = entitiesToSvgDocument(doc.all(), { blocks: [block] });
    expect(svg).toContain(">100</text>");
  });
});

describe("exports", () => {
  it("explodeDimension gives lines, solid-hatch arrows and one centred text", () => {
    const parts = explodeDimension(dim(), null);
    expect(parts.filter((p) => p.type === "hatch" && p.paint.kind === "solid")).toHaveLength(2);
    const t = parts.find((p) => p.type === "text")!;
    expect(t).toMatchObject({ text: "100", halign: "center", valign: "middle" });
  });
  it("R12 DXF, 2018 DXF and SVG all carry the same number", () => {
    const d = dim();
    expect(entitiesToDxf([d])).toContain("\n1\n100\n");
    expect(entitiesToDxf2018([d])).toContain("\n1\n100\n");
    expect(entitiesToSvgDocument([d])).toContain(">100</text>");
  });
});

describe("sketch code", () => {
  it("round trips through toCode -> parseCode -> diffToCommands with the same id, keeping associations", () => {
    const doc = new SketchDocument();
    const bus = new CommandBus(doc);
    bus.execute({ type: "add-entity", entity: { ...line("l1", 0, 0, 100, 0), name: "L1" } });
    bus.execute({
      type: "add-entity",
      entity: dim({ name: "D1", textOverride: "<> typ.", style: "ISO-25", refs: [{ entityId: "l1", point: "a" }, { entityId: "l1", point: "b" }, null], driving: true, value: 100 }),
    });
    const code = toCode(doc);
    expect(code).toContain("dimension D1 linear");
    expect(code).toContain("driving 100");
    const parsed = parseCode(code);
    expect(parsed.errors).toEqual([]);
    expect(diffToCommands(doc, parsed.entities)).toEqual([]);
    // Edit a number in the code: same id, refs kept.
    const edited = code.replace("(50, 20)", "(50, 30)");
    for (const c of diffToCommands(doc, parseCode(edited).entities)) bus.execute(c);
    const d = doc.get("d1") as DimensionEntity;
    expect(d.defPoints[2]).toEqual({ x: 50, y: 30 });
    expect(d.refs?.[0]?.entityId).toBe("l1");
    expect(d.textOverride).toBe("<> typ.");
  });
  it("reports malformed dimension lines instead of throwing", () => {
    for (const bad of ["dimension D1", "dimension D1 weird (0,0)", "dimension D1 linear (0,0) (1,1)", 'dimension D1 linear (0,0) (1,1) (2,2) text "x', "dimension D1 linear (0,0) (1,1) (2,2) bogus"]) {
      const r = parseCode(bad);
      expect(r.entities).toEqual([]);
      expect(r.errors).toHaveLength(1);
    }
  });
});

describe("clipboard", () => {
  it("a pasted dimension follows the pasted copy of its geometry, or detaches if the geometry was not copied", () => {
    const doc = new SketchDocument();
    const bus = new CommandBus(doc);
    bus.execute({ type: "add-entity", entity: line("l1", 0, 0, 100, 0) });
    bus.execute({ type: "add-entity", entity: dim({ refs: [{ entityId: "l1", point: "a" }, { entityId: "l1", point: "b" }, null] }) });
    const both = parseClipboard(serializeSelection(doc, ["l1", "d1"]))!;
    const r1 = pasteCommands(both, { x: 0, y: 50 }, doc);
    for (const c of r1.commands) bus.execute(c);
    const pastedDim = doc.get(r1.ids[1]) as DimensionEntity;
    expect(pastedDim.refs?.[0]?.entityId).toBe(r1.ids[0]);
    const only = parseClipboard(serializeSelection(doc, ["d1"]))!;
    const r2 = pasteCommands(only, { x: 0, y: 0 }, doc);
    for (const c of r2.commands) bus.execute(c);
    expect((doc.get(r2.ids[0]) as DimensionEntity).refs).toBeUndefined();
  });
});

describe("document integration", () => {
  it("doc round trips through JSON", () => {
    const doc = new SketchDocument();
    const bus = new CommandBus(doc);
    bus.execute({ type: "add-entity", entity: dim({ driving: true, value: 100, overrides: { textHeight: 4 } }) });
    const again = SketchDocument.fromJSON(JSON.parse(JSON.stringify(doc.toJSON())));
    expect(again.get("d1")).toEqual(doc.get("d1"));
  });
  it("withDimHost resolves references on a bare document", () => {
    const doc = new SketchDocument();
    doc._put(line("l1", 0, 0, 40, 0));
    const d = dim({ refs: [{ entityId: "l1", point: "a" }, { entityId: "l1", point: "b" }, null] });
    expect(withDimHost(doc, () => measureOf(d))).toBeCloseTo(40);
    expect(measureOf(d, null)).toBeCloseTo(100);
  });
  it("entities outside the union stay assignable", () => {
    const e: Entity = dim();
    expect(e.type).toBe("dimension");
  });
});
