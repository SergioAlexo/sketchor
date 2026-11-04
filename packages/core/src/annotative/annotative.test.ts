import { describe, expect, it } from "vitest";
import { CommandBus } from "../commands";
import { SketchDocument } from "../document";
import { entitiesToDxf2018 } from "../dxfw";
import { parseDxf } from "../dxf";
import type { Entity, TextEntity } from "../entities";
import "../kinds/builtin";
import {
  addScaleCommands, annotatedFor, annotationFactor, annotationScaleList, parseAnnotationScale, removeScaleCommands,
  sameAnnotationScale, scaledForAnnotation, setAnnotationScaleCommands, setAnnotativeCommands, supportsScale, viewportAnnotationScale, withScaleRemoved,
} from "./annotative";

/**
 * D-08: if scale maths drifts, text printed on a 1:50 sheet stops being 2.5 mm tall; if the flag or the scale list is
 * lost on a round trip, a drawing's notes silently change size. The renderer and the PDF plotter share annotatedFor.
 */
const text = (o: Partial<TextEntity> = {}): TextEntity => ({ id: "t1", type: "text", at: { x: 5, y: 5 }, text: "A", height: 2.5, rotation: 0, annotative: true, annoScales: ["1:50"], ...o });

describe("scale names", () => {
  it("parses ratios and architectural forms", () => {
    expect(parseAnnotationScale("1:50")).toBeCloseTo(0.02);
    expect(parseAnnotationScale("2:1")).toBe(2);
    expect(parseAnnotationScale('1"=1\'-0"')).toBeCloseTo(1 / 12);
    expect(parseAnnotationScale('1/4"=1\'-0"')).toBeCloseTo(1 / 48);
    expect(parseAnnotationScale('1"=10\'')).toBeCloseTo(1 / 120);
  });
  it("rejects nonsense and degenerate ratios", () => {
    for (const bad of ["", "abc", "0:1", "1:0", "-1:5", '0"=1\'']) expect(parseAnnotationScale(bad)).toBeNull();
  });
  it("factor is model per paper, 1 when unknown", () => {
    expect(annotationFactor("1:50")).toBeCloseTo(50);
    expect(annotationFactor("2:1")).toBeCloseTo(0.5);
    expect(annotationFactor("junk")).toBe(1);
    expect(annotationFactor(undefined)).toBe(1);
  });
  it("same scale compares by value", () => {
    expect(sameAnnotationScale("1:50", "1 : 50.0")).toBe(true);
    expect(sameAnnotationScale("1:50", "1:100")).toBe(false);
  });
  it("list falls back to defaults", () => {
    expect(annotationScaleList({})).toContain("1:50");
    expect(annotationScaleList({ annotationScales: [] })).toContain("1:50");
    expect(annotationScaleList({ annotationScales: ["1:7"] })).toEqual(["1:7"]);
  });
});

describe("annotatedFor", () => {
  it("leaves non-annotative entities alone", () => {
    const line = { id: "l", type: "line", a: { x: 0, y: 0 }, b: { x: 1, y: 1 } } as unknown as Entity;
    expect(annotatedFor(line, "1:50")).toBe(line);
    const t = text({ annotative: false });
    expect(annotatedFor(t, "1:50")).toBe(t);
  });
  it("scales text height by model-per-paper", () => {
    expect((annotatedFor(text(), "1:50") as TextEntity).height).toBeCloseTo(125);
    expect((annotatedFor(text({ annoScales: undefined }), "1:10") as TextEntity).height).toBeCloseTo(25);
  });
  it("hides unsupported scales unless allVisible, then uses its own first scale", () => {
    expect(annotatedFor(text(), "1:100")).toBeNull();
    expect((annotatedFor(text(), "1:100", { allVisible: true }) as TextEntity).height).toBeCloseTo(125);
  });
  it("scales mtext, hatch pattern, insert and dimension", () => {
    const m = scaledForAnnotation({ id: "m", type: "mtext", at: { x: 0, y: 0 }, width: 10, attachment: 1, text: "x", height: 2, rotation: 0 } as Entity, 5);
    expect(m.type === "mtext" && [m.height, m.width]).toEqual([10, 50]);
    const h = scaledForAnnotation({ id: "h", type: "hatch", loops: [], style: "normal", paint: { kind: "pattern", name: "ANSI31", scale: 1, angle: 0 } } as Entity, 5);
    expect(h.type === "hatch" && h.paint.kind === "pattern" && h.paint.scale).toBe(5);
    const solid = { id: "h2", type: "hatch", loops: [], style: "normal", paint: { kind: "solid", color: "#fff" } } as Entity;
    expect(scaledForAnnotation(solid, 5)).toBe(solid);
    const i = scaledForAnnotation({ id: "i", type: "insert", block: "B", insert: { x: 0, y: 0 }, scale: { x: 1, y: -1 }, rotation: 0 } as Entity, 5);
    expect(i.type === "insert" && i.scale).toEqual({ x: 5, y: -5 });
    const d = scaledForAnnotation({ id: "d", type: "dimension", kind: "linear", defPoints: [], scale: 2 } as unknown as Entity, 5);
    expect(d.type === "dimension" && d.scale).toBe(10);
  });
  it("ignores zero, negative and non-finite factors", () => {
    const t = text();
    for (const f of [0, -2, NaN, Infinity, 1]) expect(scaledForAnnotation(t, f)).toBe(t);
  });
  it("viewport scale name comes from its own setting or its ratio", () => {
    expect(viewportAnnotationScale({ scale: 0.02 })).toBe("1:50");
    expect(viewportAnnotationScale({ scale: 2 })).toBe("2:1");
    expect(viewportAnnotationScale({ scale: 0.02, annotationScale: "1:20" })).toBe("1:20");
    expect(viewportAnnotationScale({ scale: 0.02, annotationScale: "bogus" })).toBe("1:50");
    expect(viewportAnnotationScale({ scale: 0 })).toBe("1:1");
  });
});

describe("scale list edits", () => {
  it("add and remove respect the last-scale rule", () => {
    const t = text();
    expect(supportsScale(t, "1:50")).toBe(true);
    expect(withScaleRemoved(t, "1:50")).toBeNull();
    const two = text({ annoScales: ["1:50", "1:100"] });
    expect((withScaleRemoved(two, "1:100") as TextEntity).annoScales).toEqual(["1:50"]);
    expect(withScaleRemoved(two, "1:5")).toBeNull();
  });
  it("commands are one undo step and reversible", () => {
    const doc = new SketchDocument();
    const bus = new CommandBus(doc);
    bus.execute({ type: "add-entity", entity: { ...text(), annotative: undefined, annoScales: undefined } });
    bus.execute({ type: "set-settings", patch: { annotationScale: "1:20" } });
    const before = JSON.stringify(doc.get("t1"));
    const on = setAnnotativeCommands(doc, ["t1", "missing"], true);
    expect(on).toHaveLength(1);
    bus.execute(on[0]);
    expect((doc.get("t1") as TextEntity).annoScales).toEqual(["1:20"]);
    expect(setAnnotativeCommands(doc, ["t1"], true)).toEqual([]);
    bus.execute({ type: "set-settings", patch: { annotationScale: "1:50" } });
    bus.execute(addScaleCommands(doc, ["t1"])[0]);
    expect((doc.get("t1") as TextEntity).annoScales).toEqual(["1:20", "1:50"]);
    expect(addScaleCommands(doc, ["t1"])).toEqual([]);
    bus.execute(removeScaleCommands(doc, ["t1"])[0]);
    expect((doc.get("t1") as TextEntity).annoScales).toEqual(["1:20"]);
    bus.undo();
    bus.undo();
    bus.undo();
    bus.undo();
    expect(JSON.stringify(doc.get("t1"))).toBe(before);
  });
  it("setting the annotation scale adds new names to the list and refuses junk", () => {
    const doc = new SketchDocument();
    expect(setAnnotationScaleCommands(doc, "nope")).toEqual([]);
    const cmd = setAnnotationScaleCommands(doc, "1:7")[0];
    expect((cmd as { patch: { annotationScales: string[] } }).patch.annotationScales).toContain("1:7");
    expect((setAnnotationScaleCommands(doc, "1:50")[0] as { patch: object }).patch).toEqual({ annotationScale: "1:50" });
  });
});

describe("DXF 2018 round trip", () => {
  it("keeps the flag and the scale list (and the unrestricted case)", () => {
    const a = text({ id: "a", annoScales: ["1:50", "1:100"] });
    const b = text({ id: "b", annoScales: undefined });
    const c = text({ id: "c", annotative: false, annoScales: undefined });
    const dxf = entitiesToDxf2018([a, b, c], { annotation: { scale: "1:50" } });
    const back = parseDxf(dxf);
    const get = (id: string) => back.entities.find((e) => e.id === id) as TextEntity;
    expect(get("a").annotative).toBe(true);
    expect(get("a").annoScales).toEqual(["1:50", "1:100"]);
    expect(get("b").annotative).toBe(true);
    expect(get("b").annoScales).toBeUndefined();
    expect(get("c").annotative).toBeUndefined();
    expect(back.annotation).toEqual({ scale: "1:50" });
  });
});
