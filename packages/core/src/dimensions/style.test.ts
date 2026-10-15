/**
 * D-03: the dimension style is what makes the same measurement read as ISO,
 * ANSI or architectural. A wrong unit format or a style that silently ignores
 * a variable puts a wrong number or a wrong symbol on a drawing, and an edit
 * that is not one undo step would leave half a restyle behind.
 */
import { describe, expect, it } from "vitest";
import { CommandBus } from "../commands";
import { SketchDocument } from "../document";
import type { DimensionEntity } from "../entities";
import "../kinds/builtin";
import { arrowShape } from "./arrows";
import { formatAngle, formatLength, measuredText } from "./format";
import { layoutDimension } from "./layout";
import { ARROW_KINDS, DEFAULT_DIM_STYLE, DIM_STYLE_PRESETS, diffDimStyles, dimStyleOf, dimStyleRecord, type DimStyle } from "./style";
import { layoutOf } from "./resolve";
import { DIM_STYLE_FIELDS, missingFormFields } from "./styleFields";
import { newStyleCommand, presetCommand, styleUsage, withoutChildField, withStyleField } from "./styleOps";

const S = (over: Partial<DimStyle> = {}): DimStyle => ({ ...DEFAULT_DIM_STYLE, ...over });
const dim = (over: Partial<DimensionEntity> = {}): DimensionEntity => ({
  id: "d",
  type: "dimension",
  kind: "linear",
  defPoints: [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 50, y: 20 }],
  driving: false,
  ...over,
});
const geo = (e: DimensionEntity) => ({ pts: e.defPoints });

describe("presets", () => {
  it("ship ISO-25, ANSI, DIN, JIS, GOST and Architectural, each resolving to a complete style", () => {
    expect(DIM_STYLE_PRESETS.map((p) => p.name)).toEqual(["ISO-25", "ANSI", "DIN", "JIS", "GOST", "Architectural"]);
    for (const p of DIM_STYLE_PRESETS) {
      const r = dimStyleOf(p);
      expect(r.textHeight).toBeGreaterThan(0);
      expect(Object.keys(DEFAULT_DIM_STYLE).every((k) => k in r)).toBe(true);
    }
  });
  it("Architectural reads feet-inches with ticks", () => {
    const a = dimStyleOf(DIM_STYLE_PRESETS.find((p) => p.name === "Architectural"));
    expect(a.arrow).toBe("tick");
    expect(formatLength(25.4 * 15.5, a)).toBe(`1'-3 1/2"`);
  });
});

describe("arrow heads", () => {
  it("there are at least twenty and every one but none draws something", () => {
    expect(ARROW_KINDS.length).toBeGreaterThanOrEqual(20);
    for (const k of ARROW_KINDS) {
      const s = arrowShape(k, { x: 0, y: 0 }, { x: 1, y: 0 }, 2.5, 20);
      const pts = [...s.lines.flat(), ...s.fills.flat()];
      if (k === "none") expect(pts).toHaveLength(0);
      else {
        expect(pts.length, k).toBeGreaterThan(1);
        expect(pts.every((p) => Number.isFinite(p.x) && Number.isFinite(p.y)), k).toBe(true);
      }
    }
    expect(arrowShape("closed", { x: 0, y: 0 }, { x: 1, y: 0 }, 0, 20)).toEqual({ lines: [], fills: [] });
  });
  it("each end can take its own head, the leader its own", () => {
    const l = layoutDimension(dim(), S({ arrow1: "dot", arrow2: "none" }), geo(dim()));
    expect(l.fills).toHaveLength(1); // the dot; none draws nothing
    const r = layoutDimension(dim({ kind: "radial", defPoints: [{ x: 0, y: 0 }, { x: 10, y: 0 }] }), S({ leaderArrow: "open" }), { pts: [{ x: 0, y: 0 }, { x: 10, y: 0 }] });
    expect(r.fills).toHaveLength(0);
  });
});

describe("unit formats", () => {
  it("decimal with rounding to a step, comma separator and zero suppression", () => {
    expect(formatLength(10.26, S({ round: 0.5, zeroSuppress: "none" }))).toBe("10.50");
    expect(formatLength(10.5, S({ decimalSep: ",", decimals: 3 }))).toBe("10,5");
    expect(formatLength(0.5, S({ zeroSuppress: "leading" }))).toBe(".50");
    expect(formatLength(-3, S())).toBe("-3");
  });
  it("engineering, architectural and fractional read the value as inches", () => {
    const inch = { lengthFactor: 1 / 25.4 };
    expect(formatLength(25.4 * 40.5, S({ ...inch, unitFormat: "engineering", decimals: 2, zeroSuppress: "none" }))).toBe(`3'-4.50"`);
    expect(formatLength(25.4 * 40.5, S({ ...inch, unitFormat: "architectural", decimals: 4, zeroSuppress: "none" }))).toBe(`3'-4 1/2"`);
    expect(formatLength(25.4 * 4.25, S({ ...inch, unitFormat: "fractional", decimals: 4 }))).toBe("4 1/4");
    expect(formatLength(25.4 * 0.5, S({ ...inch, unitFormat: "fractional", decimals: 4 }))).toBe("1/2");
    expect(formatLength(0, S({ ...inch, unitFormat: "fractional" }))).toBe("0");
    expect(formatLength(12345, S({ unitFormat: "scientific", decimals: 2 }))).toBe("1.23E+4");
  });
  it("angles in degrees, DMS, gradians and radians", () => {
    const a = (Math.PI / 180) * 45.5;
    expect(formatAngle(a, S())).toBe("45.5°");
    expect(formatAngle(a, S({ angleFormat: "dms", angleDecimals: 0 }))).toBe(`45°30'`);
    expect(formatAngle(Math.PI / 2, S({ angleFormat: "gradians", angleDecimals: 0 }))).toBe("100g");
    expect(formatAngle(Math.PI, S({ angleFormat: "radians", angleDecimals: 4 }))).toBe("3.1416r");
  });
});

describe("alternate units and tolerances", () => {
  const lin = { kind: "linear" } as const;
  it("alternate units follow the primary in brackets", () => {
    expect(measuredText(lin, S({ alt: true, altFactor: 1 / 25.4, altDecimals: 2 }), 25.4)).toBe("25.4 [1]");
    expect(measuredText(lin, S({ alt: true, altSuffix: "in" }), 50.8)).toBe("50.8 [2in]");
  });
  it("symmetric, deviation, limits", () => {
    expect(measuredText(lin, S({ tolMode: "symmetric", tolPlus: 0.05 }), 10)).toBe("10 ±0.05");
    expect(measuredText(lin, S({ tolMode: "deviation", tolPlus: 0.05, tolMinus: 0.02 }), 10)).toBe("10 +0.05/-0.02");
    expect(measuredText(lin, S({ tolMode: "limits", tolPlus: 0.05, tolMinus: 0.02 }), 10)).toBe("10.05 / 9.98");
    expect(measuredText({ kind: "diametric" }, S({ tolMode: "limits", tolPlus: 0.1, tolMinus: 0.1, prefix: "" }), 10)).toBe("⌀10.1 / ⌀9.9");
  });
  it("basic dimensions get a frame around the text", () => {
    const plain = layoutDimension(dim(), S(), geo(dim()));
    const basic = layoutDimension(dim(), S({ tolMode: "basic" }), geo(dim()));
    expect(basic.lines.length).toBe(plain.lines.length + 1);
  });
});

describe("layout variables", () => {
  const base = layoutDimension(dim(), S(), geo(dim()));
  it("DIMSCALE scales every size", () => {
    const big = layoutDimension(dim(), S({ scale: 2 }), geo(dim()));
    expect(big.text!.height).toBeCloseTo(base.text!.height * 2);
    expect(big.measure).toBe(base.measure);
  });
  it("suppressed extension lines are not drawn; fixed length ignores the offset", () => {
    expect(layoutDimension(dim(), S({ suppressExt1: true }), geo(dim())).lines.length).toBe(base.lines.length - 1);
    expect(layoutDimension(dim(), S({ suppressExt1: true, suppressExt2: true }), geo(dim())).lines.length).toBe(base.lines.length - 2);
    const fx = layoutDimension(dim(), S({ extFixedLength: 5 }), geo(dim()));
    const len = Math.hypot(fx.lines[0][1].x - fx.lines[0][0].x, fx.lines[0][1].y - fx.lines[0][0].y);
    expect(len).toBeCloseTo(5);
  });
  it("suppressing a dimension-line half leaves the other half", () => {
    const half = layoutDimension(dim(), S({ suppressLine1: true, textAbove: true }), geo(dim()));
    const dl = half.lines.find((l) => l.length === 2 && Math.abs(l[0].y - l[1].y) < 1e-9 && Math.abs(l[0].y - 20) < 1e-9)!;
    expect(Math.min(dl[0].x, dl[1].x)).toBeCloseTo(50);
  });
  it("text below the line goes to the other side", () => {
    const above = layoutDimension(dim(), S({ textAbove: true }), geo(dim())).text!;
    const below = layoutDimension(dim(), S({ textAbove: true, textBelow: true }), geo(dim())).text!;
    expect(above.at.y).toBeGreaterThan(20);
    expect(below.at.y).toBeLessThan(20);
  });
  it("justification moves the text toward an extension line", () => {
    const c = layoutDimension(dim(), S({ textJustify: "center" }), geo(dim())).text!.at.x;
    const first = layoutDimension(dim(), S({ textJustify: "ext1" }), geo(dim())).text!.at.x;
    const second = layoutDimension(dim(), S({ textJustify: "ext2" }), geo(dim())).text!.at.x;
    expect(first).toBeLessThan(c);
    expect(second).toBeGreaterThan(c);
  });
  it("centre marks add a cross at the circle's centre", () => {
    const r = dim({ kind: "radial", defPoints: [{ x: 5, y: 5 }, { x: 15, y: 5 }] });
    const without = layoutDimension(r, S(), geo(r));
    const withMark = layoutDimension(r, S({ centerMark: "mark", centerSize: 2 }), geo(r));
    expect(withMark.lines.length).toBe(without.lines.length + 2);
    const line = layoutDimension(r, S({ centerMark: "line", centerSize: 2 }), geo(r)).lines.slice(-2)[0];
    expect(Math.abs(line[1].x - line[0].x)).toBeCloseTo(24);
  });
  it("tick arrows extend the dimension line past the extension lines (DIMDLE)", () => {
    const l = layoutDimension(dim(), S({ arrow: "tick", lineExtend: 1.5, textAbove: true }), geo(dim()));
    const xs = l.lines.filter((x) => x.length === 2 && Math.abs(x[0].y - 20) < 1e-9 && Math.abs(x[1].y - 20) < 1e-9).flatMap((x) => x.map((p) => p.x));
    expect(Math.min(...xs)).toBeCloseTo(-1.5);
    expect(Math.max(...xs)).toBeCloseTo(101.5);
  });
});

describe("child styles, overrides and table records", () => {
  it("a child style applies to its family only and a dimension override beats it", () => {
    const rec = { name: "S", textHeight: 3, children: { angular: { textHeight: 5, angleDecimals: 0 }, radial: { arrow: "open" } } };
    expect(dimStyleOf(rec, undefined, "linear").textHeight).toBe(3);
    expect(dimStyleOf(rec, undefined, "angular3p").textHeight).toBe(5);
    expect(dimStyleOf(rec, undefined, "angular2l").angleDecimals).toBe(0);
    expect(dimStyleOf(rec, undefined, "jogged").arrow).toBe("open");
    expect(dimStyleOf(rec, { textHeight: 7 }, "angular2l").textHeight).toBe(7);
  });
  it("unknown enum values and non-finite numbers fall back to the default", () => {
    const s = dimStyleOf({ name: "x", arrow: "wobble", unitFormat: "klingon", scale: Number.NaN, fit: "3" });
    expect(s.arrow).toBe("closed");
    expect(s.unitFormat).toBe("decimal");
    expect(s.scale).toBe(1);
    expect(s.fit).toBe(3);
  });
  it("dimStyleRecord keeps only what differs from the defaults and round-trips", () => {
    const s = dimStyleOf({ name: "Mine", textHeight: 4, arrow: "tick", suppressExt1: true });
    const rec = dimStyleRecord(s);
    expect(Object.keys(rec).sort()).toEqual(["arrow", "name", "suppressExt1", "textHeight"]);
    expect(dimStyleOf(rec)).toEqual(s);
    expect(diffDimStyles(dimStyleOf(undefined), s).map((d) => d.key).sort()).toEqual(["arrow", "suppressExt1", "textHeight"]);
  });
  it("editing a style is one command, restyles every dimension using it, and one undo restores them", () => {
    const doc = new SketchDocument();
    const bus = new CommandBus(doc);
    bus.execute({ type: "put-table-record", table: "dimStyles", record: { name: "S", textHeight: 2.5 } });
    bus.execute({ type: "add-entity", entity: dim({ id: "a", style: "S" }) });
    bus.execute({ type: "add-entity", entity: dim({ id: "b", style: "S" }) });
    const h = (id: string) => layoutOf(doc.get(id) as DimensionEntity).text!.height;
    expect(h("a")).toBeCloseTo(2.5);
    bus.execute({ type: "put-table-record", table: "dimStyles", record: { name: "S", textHeight: 5 } });
    expect(h("a")).toBeCloseTo(5);
    expect(h("b")).toBeCloseTo(5);
    bus.undo();
    expect(h("a")).toBeCloseTo(2.5);
    expect(h("b")).toBeCloseTo(2.5);
  });
});

describe("style manager model", () => {
  it("every style field has a form entry with a sane control", () => {
    expect(missingFormFields()).toEqual([]);
    for (const f of DIM_STYLE_FIELDS) {
      const def = (DEFAULT_DIM_STYLE as Record<string, unknown>)[f.key];
      expect(def, f.key).not.toBeUndefined();
      if (f.type === "enum") expect(f.options, f.key).toContain(def);
      if (f.type === "number") expect(typeof def, f.key).toBe("number");
      if (f.type === "boolean") expect(typeof def, f.key).toBe("boolean");
    }
  });
  it("new-from copies a style under a free name and refuses empty or taken names", () => {
    const existing = [{ name: "A", textHeight: 4 }];
    const cmd = newStyleCommand(existing, existing[0], "B")!;
    expect(cmd.type).toBe("put-table-record");
    expect((cmd as unknown as { record: { name: string; textHeight: number } }).record).toMatchObject({ name: "B", textHeight: 4 });
    expect(newStyleCommand(existing, existing[0], "A")).toBeNull();
    expect(newStyleCommand(existing, existing[0], "  ")).toBeNull();
  });
  it("presets import once", () => {
    expect(presetCommand([], "DIN")).not.toBeNull();
    expect(presetCommand([{ name: "DIN" }], "DIN")).toBeNull();
    expect(presetCommand([], "nope")).toBeNull();
  });
  it("withStyleField edits the parent or one child family, withoutChildField undoes the latter", () => {
    const rec = { name: "S", textHeight: 3 };
    expect(withStyleField(rec, "arrow", "tick")).toMatchObject({ name: "S", textHeight: 3, arrow: "tick" });
    const child = withStyleField(rec, "textHeight", 6, "angular");
    expect(dimStyleOf(child, undefined, "angular2l").textHeight).toBe(6);
    expect(dimStyleOf(child, undefined, "linear").textHeight).toBe(3);
    const back = withoutChildField(child, "textHeight", "angular");
    expect(back.children).toBeUndefined();
    expect(dimStyleOf(back, undefined, "angular2l").textHeight).toBe(3);
  });
  it("counts the dimensions using a style (unnamed ones use Standard)", () => {
    const ents = [dim({ id: "1", style: "S" }), dim({ id: "2" }), dim({ id: "3", style: "S" })];
    expect(styleUsage(ents, "S")).toBe(2);
    expect(styleUsage(ents, "Standard")).toBe(1);
  });
});
