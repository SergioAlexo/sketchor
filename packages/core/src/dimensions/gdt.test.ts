/**
 * D-06 GD&T feature control frames. What breaks in a user's drawing: a frame
 * that loses its datums or modifiers on save/open, a composite frame that
 * stops sharing its symbol cell, a frame missing from R12 / SVG exports (no
 * TOLERANCE record there, so it must explode into real strokes), a rotated
 * frame that does not turn with its selection, and a foreign TOLERANCE record
 * importing as nothing.
 */
import { describe, expect, it } from "vitest";
import { CommandBus } from "../commands";
import { SketchDocument } from "../document";
import { parseDxf } from "../dxf";
import { entitiesToDxf } from "../dxfExport";
import { entitiesToDxf2018 } from "../dxfw";
import type { DimensionEntity, Entity } from "../entities";
import { kindBounds, kindTransform } from "../kinds/registry";
import "../kinds/builtin";
import { diffToCommands, parseCode, toCode } from "../sketchtext";
import { entitiesToSvgDocument } from "../svg";
import { explodeDimension } from "./explode";
import { buildTolerance, fcfFromDxf, fcfFromTyped, fcfLocalStrokes, fcfText, fcfToDxf, GDT_SYMBOLS, gdtSymbolKey, gdtSymbolStrokes, layoutFcf, parseFcf, toleranceFromRecord } from "./gdt";
import { layoutOf } from "./resolve";

const P = (x: number, y: number) => ({ x, y });
const FRAME = "position|Ø0.5(M)|A|B(M)|C";
const mk = (content = FRAME, extra: Partial<DimensionEntity> = {}): DimensionEntity => ({ ...buildTolerance(content, P(10, 20), { id: "t1", layer: "GDT" }), ...extra });
const back = (e: Entity[], opts: Parameters<typeof entitiesToDxf2018>[1] = {}) => parseDxf(entitiesToDxf2018(e, opts)).entities;

describe("frame text", () => {
  it("parses symbol, tolerance with diameter + modifier, and up to three datums", () => {
    const [row] = parseFcf(FRAME);
    expect(row.symbol).toBe("position");
    expect(row.cells[0]).toEqual([{ kind: "dia" }, { kind: "text", text: "0.5" }, { kind: "mod", ch: "M" }]);
    expect(row.cells.length).toBe(4);
    expect(row.cells[2]).toEqual([{ kind: "text", text: "B" }, { kind: "mod", ch: "M" }]);
  });

  it("canonicalises: fcfText(parseFcf(x)) is stable", () => {
    const t = fcfText(parseFcf(FRAME + "\n|Ø0.2|A"));
    expect(fcfText(parseFcf(t))).toBe(t);
  });

  it("accepts symbol aliases and %%c for the diameter", () => {
    expect(parseFcf("pos|%%c0.1|A")[0].symbol).toBe("position");
    expect(parseFcf("pos|%%c0.1|A")[0].cells[0][0]).toEqual({ kind: "dia" });
    expect(gdtSymbolKey("Total Runout")).toBe("total-runout");
    expect(gdtSymbolKey("nonsense")).toBeNull();
  });

  it("typed command line form: symbol, * for Ø, / for composite rows", () => {
    expect(fcfFromTyped("position *0.5(M) A B(M)")).toBe("position|Ø0.5(M)|A|B(M)");
    expect(fcfFromTyped("flat 0.05")).toBe("flatness|0.05");
    expect(fcfFromTyped("0.1 A")).toBe("position|0.1|A");
    expect(fcfFromTyped("position *0.5 A / *0.2 A")).toBe("position|Ø0.5|A\n|Ø0.2|A");
  });

  it("never throws on empty or odd input", () => {
    for (const s of ["", "|", "||||||||", "((", "Ø(", "\n\n", "x|(M", "position|\n"]) {
      expect(() => parseFcf(s)).not.toThrow();
      expect(() => layoutFcf(s, P(0, 0), 3.5, 0)).not.toThrow();
    }
    expect(parseFcf(undefined)).toEqual([]);
  });
});

describe("symbols", () => {
  it("has all 14 characteristic symbols, each drawn, with unique DXF letters", () => {
    expect(GDT_SYMBOLS.length).toBe(14);
    expect(new Set(GDT_SYMBOLS.map((s) => s.letter)).size).toBe(14);
    for (const s of GDT_SYMBOLS) {
      const strokes = gdtSymbolStrokes(s.key, 2);
      expect(strokes.length, s.key).toBeGreaterThan(0);
      for (const run of strokes) for (const p of run) expect(Math.hypot(p.x, p.y), s.key).toBeLessThan(2 * 1.5);
    }
  });
});

describe("layout", () => {
  it("a frame is boxes + lettering, left edge at the insertion point, first row centred on it", () => {
    const { runs, width, height } = fcfLocalStrokes(parseFcf(FRAME), 3.5);
    expect(height).toBeCloseTo(7, 9);
    expect(width).toBeGreaterThan(7 * 3);
    const xs = runs.flat().map((p) => p.x);
    const ys = runs.flat().map((p) => p.y);
    expect(Math.min(...xs)).toBeCloseTo(0, 9);
    expect(Math.max(...xs)).toBeCloseTo(width, 6);
    expect(Math.max(...ys)).toBeCloseTo(3.5, 9);
    expect(Math.min(...ys)).toBeCloseTo(-3.5, 9);
  });

  it("a composite frame is taller and shares one symbol cell", () => {
    const one = fcfLocalStrokes(parseFcf(FRAME), 3.5);
    const two = fcfLocalStrokes(parseFcf(FRAME + "\n|Ø0.2|A"), 3.5);
    expect(two.height).toBeCloseTo(14, 9);
    const symbolOutlines = (runs: { x: number; y: number }[][]) => runs.filter((r) => r.length === 5 && r.every((p) => p.x <= 7 + 1e-9) && r.some((p) => Math.abs(p.x) < 1e-9)).length;
    expect(symbolOutlines(one.runs)).toBe(0); // a single row has no separate symbol box (it is a divider inside the row)
    expect(symbolOutlines(two.runs)).toBe(1);
    expect(Math.min(...two.runs.flat().map((p) => p.y))).toBeCloseTo(-10.5, 9);
  });

  it("rotation turns the whole frame about the insertion point", () => {
    const a = layoutFcf(FRAME, P(5, 5), 3, 0).flat();
    const b = layoutFcf(FRAME, P(5, 5), 3, Math.PI / 2).flat();
    a.forEach((p, i) => {
      expect(b[i].x).toBeCloseTo(5 - (p.y - 5), 9);
      expect(b[i].y).toBeCloseTo(5 + (p.x - 5), 9);
    });
  });

  it("scales with the dimension's style text height and `scale`", () => {
    const w = (e: DimensionEntity) => {
      const b = kindBounds(e)!;
      return b.maxX - b.minX;
    };
    expect(w(mk(FRAME, { scale: 2 }))).toBeCloseTo(2 * w(mk()), 6);
    expect(w(mk(FRAME, { overrides: { textHeight: 7 } }))).toBeCloseTo(2 * w(mk(FRAME, { overrides: { textHeight: 3.5 } })), 6);
  });

  it("is a tolerance with no measure and no loose text", () => {
    const l = layoutOf(mk());
    expect(l.text).toBeNull();
    expect(Number.isNaN(l.measure)).toBe(true);
    expect(l.lines.length).toBeGreaterThan(10);
  });
});

describe("transform", () => {
  it("moves with its selection and turns by the rotation", () => {
    const r = kindTransform(mk(), [0, 1, -1, 0, 0, 0])!; // 90 degrees CCW about the origin
    expect(r.type).toBe("dimension");
    const d = r as DimensionEntity;
    expect(d.defPoints[0].x).toBeCloseTo(-20, 9);
    expect(d.defPoints[0].y).toBeCloseTo(10, 9);
    expect(d.angle).toBeCloseTo(Math.PI / 2, 9);
    expect(d.textOverride).toBe(FRAME);
  });
});

describe("DXF strings", () => {
  it("writes gdt tags, %%v cell breaks and ^J row breaks", () => {
    const s = fcfToDxf(FRAME + "\n|Ø0.2|A");
    expect(s).toBe("{\\Fgdt;j}%%v{\\Fgdt;n}0.5{\\Fgdt;m}%%vA%%vB{\\Fgdt;m}%%vC^J%%v{\\Fgdt;n}0.2%%vA");
  });

  it("every symbol and modifier survives text -> DXF -> text", () => {
    for (const sym of GDT_SYMBOLS) {
      const t = `${sym.key}|Ø0.25(M)(L)|A(M)|B(S)|C(P)\n|0.1(F)(T)(U)|A`;
      expect(fcfFromDxf(fcfToDxf(t))).toBe(t);
    }
  });

  it("reads %%c and a record without cell breaks for the symbol without throwing", () => {
    expect(fcfFromDxf("{\\Fgdt;c}%%v%%c0.1%%vA")).toBe("flatness|Ø0.1|A");
    expect(() => fcfFromDxf("{\\Fgdt;")).not.toThrow();
    expect(() => fcfFromDxf("")).not.toThrow();
  });
});

describe("TOLERANCE in AC1032", () => {
  it("writes a real TOLERANCE record and reads one frame back (same id, layer, content, position)", () => {
    const dxf = entitiesToDxf2018([mk()]);
    expect(dxf).toContain("\nTOLERANCE\n");
    expect(dxf).toContain("AcDbFcf");
    const out = back([mk()]);
    expect(out.length).toBe(1);
    const d = out[0] as DimensionEntity;
    expect(d.kind).toBe("tolerance");
    expect(d.id).toBe("t1");
    expect(d.layer).toBe("GDT");
    expect(d.textOverride).toBe(FRAME);
    expect(d.defPoints[0]).toEqual(P(10, 20));
    expect(layoutOf(d).lines).toEqual(layoutOf(mk()).lines);
  });

  it("round trips a composite frame and a rotation", () => {
    const e = mk("position|Ø0.5(M)|A|B\n|Ø0.2|A", { angle: 0.5 });
    const d = back([e])[0] as DimensionEntity;
    expect(d.textOverride).toBe("position|Ø0.5(M)|A|B\n|Ø0.2|A");
    expect(d.angle).toBeCloseTo(0.5, 9);
  });

  it("a foreign TOLERANCE record (no SKETCHOR data) still comes in", () => {
    const d = toleranceFromRecord([
      { code: 3, value: "ISO-25" }, { code: 10, value: "4" }, { code: 20, value: "5" }, { code: 30, value: "0" },
      { code: 1, value: "{\\Fgdt;b}%%v{\\Fgdt;n}0.05%%vA" }, { code: 11, value: "0" }, { code: 21, value: "1" }, { code: 31, value: "0" },
    ])!;
    expect(d.kind).toBe("tolerance");
    expect(d.textOverride).toBe("perpendicularity|Ø0.05|A");
    expect(d.style).toBe("ISO-25");
    expect(d.angle).toBeCloseTo(Math.PI / 2, 9);
    expect(toleranceFromRecord([{ code: 1, value: "x" }])).toBeNull();
  });

  it("an inch file brings the frame back at the same size and place", () => {
    const e = mk();
    const d = back([e], { insUnits: 1, scale: 1 / 25.4 })[0] as DimensionEntity;
    expect(d.defPoints[0].x).toBeCloseTo(10, 4);
    const b0 = kindBounds(e)!;
    const b1 = kindBounds(d)!;
    expect(b1.maxX - b1.minX).toBeCloseTo(b0.maxX - b0.minX, 3);
  });
});

describe("frames without a TOLERANCE record", () => {
  it("explode into polylines only (R12, SVG, PDF, EPS draw those)", () => {
    const parts = explodeDimension(mk());
    expect(parts.length).toBeGreaterThan(10);
    expect(parts.every((p) => p.type === "polyline")).toBe(true);
  });

  it("R12 DXF draws the frame as LWPOLYLINE/LINE strokes, not a TOLERANCE", () => {
    const dxf = entitiesToDxf([mk()]);
    expect(dxf).not.toContain("TOLERANCE");
    const out = parseDxf(dxf).entities;
    expect(out.length).toBeGreaterThan(10);
    expect(out.every((e) => e.type === "polyline" || e.type === "line")).toBe(true);
  });

  it("SVG carries the frame as paths", () => {
    const svg = entitiesToSvgDocument([mk()]);
    expect((svg.match(/<(path|polyline|line)\b/g) ?? []).length).toBeGreaterThan(10);
  });
});

describe("sketch code", () => {
  it("round trips with the same id and survives a code edit", () => {
    const doc = new SketchDocument();
    const bus = new CommandBus(doc);
    bus.execute({ type: "add-entity", entity: { ...mk(FRAME + "\n|Ø0.2|A", { angle: (30 * Math.PI) / 180 }), name: "T1" } });
    const code = toCode(doc);
    expect(code).toContain("dimension T1 tolerance (10, 20)");
    const parsed = parseCode(code);
    expect(parsed.errors).toEqual([]);
    expect(diffToCommands(doc, parsed.entities)).toEqual([]);
    for (const c of diffToCommands(doc, parseCode(code.replace("(10, 20)", "(12, 20)")).entities)) bus.execute(c);
    const d = doc.get("t1") as DimensionEntity;
    expect(d.defPoints[0]).toEqual(P(12, 20));
    expect(d.textOverride).toBe(FRAME + "\n|Ø0.2|A");
    expect(d.angle).toBeCloseTo(Math.PI / 6, 9);
  });
});
