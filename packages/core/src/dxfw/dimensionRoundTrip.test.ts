/**
 * D-10: dimensions and dimension styles through DXF. What breaks in a user's
 * drawing: a dimension that comes back as loose lines (no longer follows its
 * geometry or style), a style whose variables silently reset, or a file in
 * inches whose text sizes come back 25.4x off. The anonymous `*D` block must
 * exist so readers that do not recompute dimensions still draw our rendering.
 */
import { describe, expect, it } from "vitest";
import { CommandBus } from "../commands";
import { SketchDocument } from "../document";
import { dimStyleFromDxf, dimStyleToDxf } from "../dimensions/dxfVars";
import { layoutOf } from "../dimensions/resolve";
import { DEFAULT_DIM_STYLE, DIM_STYLE_PRESETS, dimStyleOf, dimStyleRecord, type DimStyle } from "../dimensions/style";
import { parseDxf } from "../dxf";
import type { DimensionEntity, Entity } from "../entities";
import "../kinds/builtin";
import { entitiesToDxf2018 } from "./index";

const D = (kind: DimensionEntity["kind"], pts: [number, number][], extra: Partial<DimensionEntity> = {}): DimensionEntity => ({
  id: `d-${kind}`,
  type: "dimension",
  kind,
  defPoints: pts.map(([x, y]) => ({ x, y })),
  driving: false,
  ...extra,
});

const SAMPLES: DimensionEntity[] = [
  D("linear", [[0, 0], [40, 10], [20, 25]], { angle: 0 }),
  D("linear", [[0, 0], [40, 10], [50, 5]], { angle: Math.PI / 2, id: "d-vertical" }),
  D("aligned", [[0, 0], [30, 40], [10, 30]]),
  D("angular2l", [[0, 0], [10, 0], [0, 0], [0, 10], [6, 6]]),
  D("angular3p", [[0, 0], [10, 0], [0, 10], [6, 6]]),
  D("radial", [[5, 5], [15, 5]]),
  D("diametric", [[5, 5], [15, 5]]),
  D("ordinate", [[0, 0], [30, 12], [30, 25]], { axis: "x" }),
];

function roundTrip(entities: Entity[], opts: Parameters<typeof entitiesToDxf2018>[1] = {}) {
  const text = entitiesToDxf2018(entities, opts);
  return { text, parsed: parseDxf(text) };
}

const near = (a: number, b: number, tol = 1e-4) => Math.abs(a - b) <= tol;

describe("DIMENSION records", () => {
  it("each kind comes back as the same kind with the same points, text and measurement", () => {
    for (const d of SAMPLES) {
      const { parsed } = roundTrip([d]);
      const back = parsed.entities.filter((e) => e.type === "dimension") as DimensionEntity[];
      expect(back, d.id).toHaveLength(1);
      expect(back[0].id).toBe(d.id);
      expect(back[0].kind).toBe(d.kind);
      d.defPoints.forEach((p, i) => {
        expect(near(back[0].defPoints[i].x, p.x), `${d.id} p${i}.x`).toBe(true);
        expect(near(back[0].defPoints[i].y, p.y), `${d.id} p${i}.y`).toBe(true);
      });
      const a = layoutOf(d, null);
      const b = layoutOf(back[0], null);
      expect(b.text?.text, d.id).toBe(a.text?.text);
      expect(near(b.measure, a.measure), d.id).toBe(true);
    }
  });

  it("writes a DIMENSION per dimension plus an anonymous *D block with its drawn parts", () => {
    const { text } = roundTrip([SAMPLES[0], SAMPLES[2]]);
    expect(text.match(/\n0\nDIMENSION\n/g)).toHaveLength(2);
    expect(text).toContain("\n2\n*D1\n");
    expect(text).toContain("\n2\n*D2\n");
    expect(text).toContain("AcDbAlignedDimension");
    // The block carries real geometry: the expanded parse (what thumbnails use) draws it.
    const expanded = parseDxf(text, { blocks: "explode" });
    expect(expanded.entities.some((e) => e.type === "polyline" || e.type === "line")).toBe(true);
    expect(expanded.entities.some((e) => e.type === "text")).toBe(true);
  });

  it("anonymous *D blocks do not become block definitions", () => {
    expect(roundTrip([SAMPLES[0]]).parsed.blocks.map((b) => b.name)).toEqual([]);
  });

  it("associations, driving value, override text, text position and scale survive exactly (SKETCHOR record)", () => {
    const d = D("linear", [[0, 0], [40, 0], [20, 10]], {
      angle: 0,
      refs: [{ entityId: "a", point: "a" }, { entityId: "a", point: "b" }, null],
      driving: true,
      value: 40,
      textOverride: "<> TYP",
      textPos: { x: 30, y: 14 },
      scale: 2,
      overrides: { arrow: "open" },
      style: "S",
    });
    const back = roundTrip([d], { dimStyles: [{ name: "S", textHeight: 4 }] }).parsed.entities.find((e) => e.type === "dimension") as DimensionEntity;
    expect(back.refs).toEqual(d.refs);
    expect(back.driving).toBe(true);
    expect(back.value).toBe(40);
    expect(back.textOverride).toBe("<> TYP");
    expect(back.textPos).toEqual({ x: 30, y: 14 });
    expect(back.scale).toBe(2);
    expect(back.overrides).toEqual({ arrow: "open" });
    expect(back.style).toBe("S");
  });

  it("a plain file (no SKETCHOR record) still gets text override, style name and the moved text", () => {
    const d = D("aligned", [[0, 0], [30, 40], [10, 30]], { textOverride: "50 REF", textPos: { x: 25, y: 5 }, style: "ISO-25" });
    const text = entitiesToDxf2018([d]).replace(/\n0\nXRECORD\n[\s\S]*?(?=\n0\n(?:ENDSEC|XRECORD))/, "").replace("3\nSKETCHOR_DATA\n350\n", "3\nNOPE\n350\n");
    const back = parseDxf(text).entities.find((e) => e.type === "dimension") as DimensionEntity;
    expect(back.kind).toBe("aligned");
    expect(back.textOverride).toBe("50 REF");
    expect(back.style).toBe("ISO-25");
    expect(back.textPos).toBeDefined();
    expect(back.refs).toBeUndefined();
  });

  it("a record whose own measurement disagrees with its points is not trusted (falls back to the *D geometry)", () => {
    const text = entitiesToDxf2018([SAMPLES[0]]).replace(/\n42\n40\.0\n/, "\n42\n99.0\n");
    expect(text).toContain("\n42\n99.0\n");
    const kept = parseDxf(text);
    expect(kept.entities.some((e) => e.type === "dimension")).toBe(false);
    expect(kept.report.skipped.some((s) => s.type === "DIMENSION")).toBe(true);
    // Expanded, the author's block geometry is still there.
    expect(parseDxf(text, { blocks: "explode" }).entities.length).toBeGreaterThan(0);
  });

  it("arc length and jogged have no DIMENSION type: they are written as their parts", () => {
    const arc = D("arclength", [[0, 0], [10, 0], [0, 10], [8, 8]]);
    const text = entitiesToDxf2018([arc]);
    expect(text).not.toContain("\n0\nDIMENSION\n");
    expect(parseDxf(text).entities.length).toBeGreaterThan(0);
  });

  it("a file in inches: geometry, sizes and the printed number all come back in mm", () => {
    const d = D("linear", [[0, 0], [25.4, 0], [12.7, 10]], { angle: 0, style: "S" });
    const style = { name: "S", textHeight: 5, arrowSize: 3, lengthFactor: 1 };
    const { parsed } = roundTrip([d], { insUnits: 1, scale: 1 / 25.4, dimStyles: [style] });
    const back = parsed.entities.find((e) => e.type === "dimension") as DimensionEntity;
    expect(near(back.defPoints[1].x, 25.4, 1e-3)).toBe(true);
    const rec = parsed.dimStyles.find((r) => r.name === "S")!;
    const st = dimStyleOf(rec);
    expect(near(st.textHeight, 5, 1e-3)).toBe(true);
    expect(near(st.arrowSize, 3, 1e-3)).toBe(true);
    expect(layoutOf(back, null).text?.text).toBe(layoutOf(d, null).text?.text);
  });
});

describe("DIMSTYLE table", () => {
  const eq = (a: DimStyle, b: DimStyle, keys: string[]) => keys.forEach((k) => expect(a[k], k).toEqual(b[k]));
  // Every variable DXF has a group for, which a foreign file would carry.
  const VARS = [
    "scale", "arrowSize", "extOffset", "baselineSpacing", "extExtend", "round", "lineExtend", "tolPlus", "tolMinus", "extFixedLength",
    "jogAngle", "textHeight", "centerMark", "centerSize", "altFactor", "lengthFactor", "tolScale", "gap", "textFrame", "altRound",
    "tolMode", "textHorizontal", "suppressExt1", "suppressExt2", "textAbove", "textBelow", "zeroSuppress", "alt", "altDecimals",
    "textInside", "suppressOutsideLine", "angleDecimals", "decimals", "tolDecimals", "angleFormat", "unitFormat", "decimalSep",
    "textMove", "textJustify", "suppressLine1", "suppressLine2", "tolJustify", "fit", "prefix", "suffix", "altPrefix", "altSuffix",
  ];

  it("every preset's DIMVARs survive style -> DXF groups -> style identically", () => {
    for (const p of DIM_STYLE_PRESETS) {
      const style = dimStyleOf(p);
      const pairs = dimStyleToDxf(style).map(([code, value]) => ({ code, value: String(value) }));
      eq(dimStyleOf(dimStyleFromDxf(p.name, pairs)), style, VARS);
    }
  });

  it("a style with unusual values round-trips through the groups alone", () => {
    const style = dimStyleOf({
      name: "Odd",
      scale: 2, textHeight: 3.5, tolMode: "deviation", tolPlus: 0.2, tolMinus: 0.1, textFrame: true, gap: 1.5, centerMark: "line", centerSize: 3,
      unitFormat: "fractional", decimals: 3, angleFormat: "dms", angleDecimals: 2, zeroSuppress: "both", textBelow: true, textAbove: false,
      textJustify: "ext2", suppressLine1: true, extFixedLength: 7, prefix: "~", suffix: " mm", alt: true, altFactor: 0.04, altPrefix: "[", altSuffix: "]", decimalSep: ",",
    });
    const pairs = dimStyleToDxf(style).map(([code, value]) => ({ code, value: String(value) }));
    eq(dimStyleOf(dimStyleFromDxf("Odd", pairs)), style, VARS);
  });

  it("symmetric tolerance is DIMTOL with equal DIMTP/DIMTM, limits is DIMLIM", () => {
    const sym = dimStyleToDxf(dimStyleOf({ name: "s", tolMode: "symmetric", tolPlus: 0.05, tolMinus: 0.05 }));
    expect(sym.find(([c]) => c === 71)![1]).toBe(1);
    expect(sym.find(([c]) => c === 72)![1]).toBe(0);
    const lim = dimStyleToDxf(dimStyleOf({ name: "l", tolMode: "limits", tolPlus: 0.05, tolMinus: 0.02 }));
    expect(lim.find(([c]) => c === 72)![1]).toBe(1);
  });

  it("tick arrows are DIMTSZ and come back as ticks", () => {
    const arch = dimStyleOf(DIM_STYLE_PRESETS.find((p) => p.name === "Architectural"));
    const pairs = dimStyleToDxf(arch).map(([code, value]) => ({ code, value: String(value) }));
    expect(Number(pairs.find((p) => p.code === 142)!.value)).toBeCloseTo(arch.arrowSize);
    expect(dimStyleFromDxf("A", pairs).arrow).toBe("tick");
  });

  it("the whole record, children and exotic arrows included, is exact in a Sketchor file", () => {
    const rec = { ...dimStyleRecord(dimStyleOf({ name: "Full", arrow: "integral", leaderArrow: "dotBlank", textFill: "#ffff00" })), children: { angular: { textHeight: 7 } } };
    const doc = new SketchDocument();
    const bus = new CommandBus(doc);
    bus.execute({ type: "put-table-record", table: "dimStyles", record: rec });
    const text = entitiesToDxf2018([SAMPLES[0]], { dimStyles: doc.records("dimStyles") });
    expect(text).toContain("\n2\nFull\n");
    const back = parseDxf(text).dimStyles.find((r) => r.name === "Full")!;
    expect(back).toEqual(rec);
  });

  it("the file's current dimension style is $DIMSTYLE, and every named style has a table entry", () => {
    const text = entitiesToDxf2018([D("linear", [[0, 0], [10, 0], [5, 3]], { angle: 0, style: "ISO-25" })], { currentDimStyle: "ISO-25", dimStyles: [{ name: "ISO-25" }] });
    expect(text).toContain("9\n$DIMSTYLE\n2\nISO-25\n");
    expect(text.match(/\n0\nDIMSTYLE\n/g)!.length).toBe(2); // Standard + ISO-25
  });

  it("a style named by a dimension but missing from the table is written with the preset's (else default) values", () => {
    const { parsed } = roundTrip([D("linear", [[0, 0], [10, 0], [5, 3]], { angle: 0, style: "DIN" })]);
    const din = parsed.dimStyles.find((r) => r.name === "DIN")!;
    expect(dimStyleOf(din).decimalSep).toBe(",");
    const other = roundTrip([D("linear", [[0, 0], [10, 0], [5, 3]], { angle: 0, style: "Mine" })]).parsed;
    expect(dimStyleOf(other.dimStyles.find((r) => r.name === "Mine")!).textHeight).toBe(DEFAULT_DIM_STYLE.textHeight);
  });

  it("handles stay unique when styles add records (HANDSEED above every handle)", () => {
    const text = entitiesToDxf2018(SAMPLES, { dimStyles: DIM_STYLE_PRESETS.map((p) => dimStyleRecord(p)) });
    const handles = [...text.replace(/\$HANDSEED\n5\n[0-9A-F]+/, "").matchAll(/\n(?:5|105)\n([0-9A-F]+)\n/g)].map((m) => m[1]);
    expect(new Set(handles).size).toBe(handles.length);
    const seed = parseInt(/\$HANDSEED\n5\n([0-9A-F]+)/.exec(text)![1], 16);
    expect(Math.max(...handles.map((h) => parseInt(h, 16)))).toBeLessThan(seed);
  });
});
