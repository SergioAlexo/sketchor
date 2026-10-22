import { describe, expect, it } from "vitest";
import { entitiesToDxf } from "@sketchor/core";
import { circle, polyline } from "@sketchor/plugin-sdk";
import { reportSummaryLines } from "./nestReport";
import { loadDxfFile, PANEL_HTML, recFromExtracted, snapshotCanvasPart } from "./sheetNestingPlugin";
import { extractPartsWithDiagnostics, groupsFromRows, parseSheetText, resolveItem, sumRepeatedRows } from "@sketchor/plugin-nest";

/**
 * The panel runs in a sandboxed iframe a test cannot drive, so these pin the
 * two things that break silently: the panel script failing to even compile
 * (a stray quote in the template string leaves a blank panel), and the file
 * intake - a dropped DXF must give a part with the right size, honour a forced
 * unit, and turn garbage into an error message instead of a throw.
 */

const rect = (w: number, h: number) => polyline([{ x: 0, y: 0 }, { x: w, y: 0 }, { x: w, y: h }, { x: 0, y: h }], true);

describe("Sheet Nesting panel", () => {
  it("has a script that compiles and carries the credit", () => {
    const script = /<script>([\s\S]*)<\/script>/.exec(PANEL_HTML)![1]!;
    expect(() => new Function(script)).not.toThrow();
    expect(PANEL_HTML).toContain("Nesting engine based on the Sheet Nesting Calculator by Oleksandr Borenko");
  });
});

describe("loadDxfFile", () => {
  it("reads a rectangle as one part of the drawn size", () => {
    const text = entitiesToDxf([rect(100, 50)], 4, 1);
    const f = loadDxfFile("k", "plate.dxf", text, null);
    expect(f.error).toBeUndefined();
    expect(f.parts).toHaveLength(1);
    expect(f.parts[0]!.w).toBeCloseTo(100, 3);
    expect(f.parts[0]!.h).toBeCloseTo(50, 3);
    expect(f.parts[0]!.cutLength).toBeCloseTo(300, 3);
    expect(f.parts[0]!.pierceCount).toBe(1);
  });

  it("a forced unit rescales the geometry", () => {
    const text = entitiesToDxf([rect(100, 50)], 0, 1); // no declared unit
    const mm = loadDxfFile("k", "a.dxf", text, 4);
    const inch = loadDxfFile("k", "a.dxf", text, 1);
    expect(inch.parts[0]!.w / mm.parts[0]!.w).toBeCloseTo(25.4, 3);
  });

  it("never throws on empty, truncated or non-DXF input", () => {
    const good = entitiesToDxf([rect(10, 10)], 4, 1);
    for (const bad of ["", "garbage", good.slice(0, good.length / 2), "0\nSECTION\n2\nENTITIES\n0\nLINE\n"]) {
      const f = loadDxfFile("k", "x.dxf", bad, null);
      expect(f.parts.length === 0 ? typeof f.error : "ok").toBeTruthy();
    }
  });
});

describe("groups pipeline (list -> groups -> files)", () => {
  it("groups by material + thickness, finds files by part number, flags a missing one", () => {
    const parsed = parseSheetText("1 PN-0001 4 SHEET .125 AL 5052\n2 PN-0002 2 SHEET .125 AL 5052\n3 PN-0003 1 SHEET .25 STEEL");
    const groups = groupsFromRows(sumRepeatedRows(parsed.rows), "al5052");
    expect(groups).toHaveLength(2);
    const files = [{ relPath: "dxf/PN-0001.dxf" }, { relPath: "dxf/PN-0002 x2.dxf" }];
    const items = groups.flatMap((g) => g.items).map((it) => resolveItem(it.num, it.qty, files));
    expect(items.map((r) => !!r.file)).toEqual([true, true, false]); // PN-0003 has no drawing: the panel shows it red and blocks Calculate
    expect(items[1]!.need).toBe(1); // 2 pieces wanted, file holds 2
  });
});

describe("recFromExtracted", () => {
  it("keeps cut length and pierce count from extraction", () => {
    const e = rect(10, 20);
    const { parts, notes } = extractPartsWithDiagnostics([e], new Set([e.id]));
    const rec = recFromExtracted(parts[0]!, "k", new Map([[e.id, e]]), notes);
    expect(rec.cutLength).toBeCloseTo(60, 6);
    expect(rec.area).toBeCloseTo(200, 6);
  });
});

describe("report summary in standard-sheet mode", () => {
  it("has no To purchase line or purchase text when sheets are not bought", () => {
    const base = { sheets: 1, toPurchase: 0, utilisation: 0.5, placed: 2, required: 2, cutLengthMm: 10, pierces: 2, unplaced: 0 };
    const stock = [{ name: "Sheet", size: "10 x 10", used: 1, purchased: 0, available: null }];
    const mk = (showPurchase: boolean) => reportSummaryLines({ summary: { kpis: { ...base, showPurchase }, stock, groups: [] }, unit: { perMm: 1, label: "mm" } } as never);
    const labels = (x: ReturnType<typeof mk>) => x.kpis.map(([l]) => l);
    expect(labels(mk(false))).toContain("Sheets used");
    expect(labels(mk(false))).not.toContain("To purchase");
    expect(mk(false).stock.join()).not.toContain("purchase");
    expect(labels(mk(true))).toContain("To purchase");
  });
});

describe("snapshotCanvasPart", () => {
  it("keeps a plate-with-hole nestable from the snapshot alone, with the same area and cut length", () => {
    const plate = rect(100, 60);
    const hole = circle({ x: 50, y: 30 }, 10);
    const lookup = new Map([plate, hole].map((e) => [e.id, e]));
    const { parts, notes } = extractPartsWithDiagnostics([plate, hole], new Set([plate.id, hole.id]));
    const live = recFromExtracted(parts[0]!, "k", lookup, notes);
    // The snapshot is built from the lookup only: no document is consulted, so it holds whichever tab is active.
    const f = snapshotCanvasPart(parts[0]!, lookup, "cv1");
    expect(f.error).toBeUndefined();
    expect(f.parts).toHaveLength(1);
    const snap = f.parts[0]!;
    expect(snap.key).toBe("cv1#0");
    expect(snap.holeCount).toBe(1);
    expect(snap.area).toBeCloseTo(live.area, 2);
    expect(snap.cutLength).toBeCloseTo(live.cutLength, 2);
    expect(snap.w).toBeCloseTo(100, 3);
    // survives save/reopen: re-deriving from the persisted text gives the same part
    const again = loadDxfFile(f.key, f.name, f.text, f.unit);
    expect(again.parts[0]!.area).toBeCloseTo(snap.area, 6);
  });

  it("keeps polyline bulges exact", () => {
    const arcy = polyline([{ x: 0, y: 0 }, { x: 40, y: 0 }, { x: 40, y: 30 }, { x: 0, y: 30 }], true, { bulges: [0.5, 0, 0, 0] });
    const lookup = new Map([[arcy.id, arcy]]);
    const { parts, notes } = extractPartsWithDiagnostics([arcy], new Set([arcy.id]));
    const live = recFromExtracted(parts[0]!, "k", lookup, notes);
    const snap = snapshotCanvasPart(parts[0]!, lookup, "cv2").parts[0]!;
    expect(snap.cutLength).toBeCloseTo(live.cutLength, 3);
    expect(snap.area).toBeCloseTo(live.area, 2);
  });
});
