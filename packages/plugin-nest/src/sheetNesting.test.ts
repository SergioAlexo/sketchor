import { describe, expect, it } from "vitest";
import { defaultJob } from "./nestJob";
import { clampHatchEntities } from "./sheetGroups";
import type { RasterNestResult } from "./raster/rasterNest";
import {
  bedWarning,
  clampStripRect,
  combineResults,
  groupsFromRows,
  jobReadiness,
  lengthStatus,
  parseJobFile,
  resultKpis,
  serializeJobFile,
  stockUsage,
} from "./sheetNesting";

/**
 * The panel's pure rules. Worth testing because `combineResults` re-bases
 * sheet / stock / placement indices (an off-by-one puts a part on another
 * group's sheet or cuts a hole before the part inside it), the readiness
 * rules decide whether Calculate is enabled, and `parseJobFile` reads files
 * a user may have edited or truncated.
 */

const res = (sheets: number, placed: number, purchased: boolean[] = []): RasterNestResult => ({
  sheets: Array.from({ length: sheets }, () => ({ stockIndex: 0, width: 100, height: 200 })),
  placed: Array.from({ length: placed }, (_, i) => ({
    partId: "p",
    sheet: i % Math.max(1, sheets),
    rotationDeg: 0,
    mirrored: false,
    translation: { x: i, y: 0 },
    ...(i === 1 ? { insideOfPlacementIndex: 0 } : {}),
  })),
  unplaced: [],
  utilisation: 0.5,
  stock: [{ size: { name: "s", width: 100, height: 200 }, qty: null }],
  purchased: purchased.length ? purchased : Array(sheets).fill(false),
  cellMm: 1,
  iterations: 1,
  ms: 1,
  lbSheets: 0,
  notes: [],
});

describe("readiness", () => {
  it("empty is missing, garbage is bad, fractions are ok", () => {
    expect(lengthStatus({ v: "", u: "in" })).toBe("missing");
    expect(lengthStatus({ v: "", u: "in" }, true)).toBe("ok");
    expect(lengthStatus({ v: "abc", u: "in" })).toBe("bad");
    expect(lengthStatus({ v: "1 3/16", u: "in" })).toBe("ok");
  });
  it("default job needs parts; with parts it can calculate", () => {
    const job = defaultJob();
    expect(jobReadiness(job, { manualParts: 0, groupCount: 0, groupProblems: 0 }).canCalculate).toBe(false);
    expect(jobReadiness(job, { manualParts: 2, groupCount: 0, groupProblems: 0 }).canCalculate).toBe(true);
  });
  it("blank thickness blocks manual mode but not groups mode; group problems block groups mode", () => {
    const job = { ...defaultJob(), thickness: { v: "", u: "in" as const } };
    expect(jobReadiness(job, { manualParts: 1, groupCount: 0, groupProblems: 0 }).fields.thickness).toBe("missing");
    const g = { ...job, mode: "groups" as const };
    expect(jobReadiness(g, { manualParts: 0, groupCount: 2, groupProblems: 0 }).canCalculate).toBe(true);
    expect(jobReadiness(g, { manualParts: 0, groupCount: 2, groupProblems: 1 }).canCalculate).toBe(false);
  });
});

describe("geometry helpers", () => {
  it("bed warning only when neither orientation fits", () => {
    expect(bedWarning({ width: 3000, height: 1500 }, { width: 1500, height: 3000 })).toBe(false);
    expect(bedWarning({ width: 3000, height: 1500 }, { width: 1000, height: 3000 })).toBe(true);
    expect(bedWarning({ width: 3000, height: 1500 }, null)).toBe(false);
  });
  it("clamp strip sits on the low-y edge of a wide sheet and the high-x edge of a tall one", () => {
    expect(clampStripRect({ width: 3000, height: 1500 }, 75)).toEqual({ x: 0, y: 0, w: 3000, h: 75 });
    expect(clampStripRect({ width: 1500, height: 3000 }, 75)).toEqual({ x: 1425, y: 0, w: 75, h: 3000 });
    expect(clampStripRect({ width: 1500, height: 3000 }, 0)).toBeNull();
  });
});

describe("clampHatchEntities (RN-22)", () => {
  it("draws only inside the strip, for wide and tall sheets, and nothing without a clamp", () => {
    for (const sheet of [{ width: 3000, height: 1500 }, { width: 1500, height: 3000 }]) {
      const r = clampStripRect(sheet, 75)!;
      const es = clampHatchEntities(sheet, 75);
      expect(es.length).toBeGreaterThan(8);
      for (const e of es) {
        if (e.type !== "line") continue;
        for (const p of [e.a, e.b]) {
          expect(p.x).toBeGreaterThanOrEqual(r.x - 1e-6);
          expect(p.x).toBeLessThanOrEqual(r.x + r.w + 1e-6);
          expect(p.y).toBeGreaterThanOrEqual(r.y - 1e-6);
          expect(p.y).toBeLessThanOrEqual(r.y + r.h + 1e-6);
        }
      }
    }
    expect(clampHatchEntities({ width: 3000, height: 1500 }, 0)).toEqual([]);
  });
});

describe("groupsFromRows", () => {
  it("groups by material + thickness, sums repeats, treats missing qty as 1", () => {
    const rows = [
      { num: "PN-0001", qty: 2, mat: "al5052" as const, thick: "0.125", text: "" },
      { num: "PN-0002", qty: null, mat: "al5052" as const, thick: "0.125", text: "" },
      { num: "PN-0001", qty: 3, mat: "al5052" as const, thick: "0.125", text: "" },
      { num: "PN-0003", qty: 1, mat: "ss" as const, thick: "0.125", text: "" },
      { num: "PN-0004", qty: 1, mat: null, thick: "", text: "" },
    ];
    const g = groupsFromRows(rows, "cs");
    expect(g.map((x) => x.id)).toEqual(["al5052|0.125", "ss|0.125", "cs|"]);
    expect(g[0]!.items).toEqual([{ num: "PN-0001", qty: 5 }, { num: "PN-0002", qty: 1 }]);
    expect(groupsFromRows([], "cs")).toEqual([]);
  });
});

describe("combineResults", () => {
  it("re-bases sheets, stock rows and in-hole indices; conserves counts", () => {
    const a = res(2, 3, [false, true]);
    const b = res(1, 2);
    const { result, sheetRun } = combineResults([a, b]);
    expect(result.sheets.length).toBe(3);
    expect(result.placed.length).toBe(5);
    expect(result.stock.length).toBe(2);
    expect(result.sheets.map((s) => s.stockIndex)).toEqual([0, 0, 1]);
    expect(sheetRun).toEqual([0, 0, 1]);
    // b's second placement (index 1 in b) points at b's first, which is global index 3
    expect(result.placed[4]!.insideOfPlacementIndex).toBe(3);
    expect(result.placed[4]!.sheet).toBe(2);
    expect(result.purchased).toEqual([false, true, false]);
    expect(combineResults([]).result.sheets).toEqual([]);
  });
});

describe("kpis and stock usage", () => {
  it("standard source buys every sheet; stock source only the purchased ones", () => {
    const r = res(3, 3, [false, true, true]);
    expect(resultKpis(r, "standard", 3, { cutLengthMm: 10, pierces: 4 }).toPurchase).toBe(0);
    expect(resultKpis(r, "standard", 3, { cutLengthMm: 10, pierces: 4 }).showPurchase).toBe(false);
    expect(stockUsage(r, "standard").every((u) => u.purchased === 0)).toBe(true); // regression: standard sheets are never "bought"
    expect(resultKpis(r, "stock", 3, { cutLengthMm: 10, pierces: 4 }).toPurchase).toBe(2);
    const u = stockUsage(r, "stock");
    expect(u).toHaveLength(1);
    expect(u[0]).toMatchObject({ used: 3, purchased: 2 });
  });
});

describe("job file", () => {
  it("round-trips and rejects garbage without throwing", () => {
    const text = serializeJobFile(defaultJob(), [{ key: "f1", name: "a.dxf", kind: "dxf", text: "0\nEOF", unit: 4 }], { bomText: "x" });
    const back = parseJobFile(text)!;
    expect(back.files).toEqual([{ key: "f1", name: "a.dxf", kind: "dxf", text: "0\nEOF", unit: 4 }]);
    expect(back.bomText).toBe("x");
    for (const bad of ["", "{", "[]", "null", '{"format":"other"}', '{"format":"sketchor-nest"}', text.slice(0, text.length / 2)]) {
      expect(parseJobFile(bad)).toBeNull();
    }
    expect(parseJobFile('{"format":"sketchor-nest","job":{},"files":[1,{"key":1}]}')!.files).toEqual([]);
  });
});
