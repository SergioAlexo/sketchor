import { describe, expect, it } from "vitest";
import { computeJobMetrics, cutRowForThickness, type CutTableRow, type PartGeometry } from "./metrics";
import type { TrueNestResult } from "./trueNest";
import type { StockRow } from "./stock";

function rect(w: number, h: number) {
  return [
    { x: 0, y: 0 },
    { x: w, y: 0 },
    { x: w, y: h },
    { x: 0, y: h },
  ];
}

describe("computeJobMetrics", () => {
  it("computes utilisation from net part area (outer minus holes) over sheet area", () => {
    const geo: PartGeometry = { outer: rect(20, 10), holes: [rect(4, 2)] }; // net 200 - 8 = 192
    const result: TrueNestResult = {
      sheets: [{ stockIndex: 0, width: 100, height: 100 }],
      placed: [{ partId: "p", sheet: 0, rotationDeg: 0, mirrored: false, translation: { x: 0, y: 0 } }],
      unplaced: [],
      utilisation: 0,
    };
    const stock: StockRow[] = [{ size: { name: "s", width: 100, height: 100 }, qty: 1 }];
    const metrics = computeJobMetrics(result, new Map([["p", geo]]), stock, []);
    expect(metrics.sheets[0].netPartArea).toBeCloseTo(192, 6);
    expect(metrics.sheets[0].utilisation).toBeCloseTo(192 / 10000, 6);
    expect(metrics.totalUtilisation).toBeCloseTo(192 / 10000, 6);
  });

  it("sums outer + hole perimeter into cut length and counts one pierce per closed loop", () => {
    const geo: PartGeometry = { outer: rect(10, 10), holes: [rect(2, 2)] }; // perim 40 + 8 = 48
    const result: TrueNestResult = {
      sheets: [{ stockIndex: 0, width: 100, height: 100 }],
      placed: [{ partId: "p", sheet: 0, rotationDeg: 0, mirrored: false, translation: { x: 0, y: 0 } }],
      unplaced: [],
      utilisation: 0,
    };
    const stock: StockRow[] = [{ size: { name: "s", width: 100, height: 100 }, qty: 1 }];
    const metrics = computeJobMetrics(result, new Map([["p", geo]]), stock, []);
    expect(metrics.sheets[0].cutLengthMm).toBeCloseTo(48, 6);
    expect(metrics.sheets[0].pierceCount).toBe(2); // 1 outer + 1 hole
  });

  it("reports a reusable remnant only when the clean strip clears the minimum height", () => {
    const geo: PartGeometry = { outer: rect(10, 10), holes: [] };
    const result: TrueNestResult = {
      sheets: [{ stockIndex: 0, width: 100, height: 100 }],
      // Bottom-left gravity: the part sits at y=[0,10], leaving an 90mm strip above it.
      placed: [{ partId: "p", sheet: 0, rotationDeg: 0, mirrored: false, translation: { x: 0, y: 0 } }],
      unplaced: [],
      utilisation: 0,
    };
    const stock: StockRow[] = [{ size: { name: "s", width: 100, height: 100 }, qty: 1 }];

    const withDefaultMin = computeJobMetrics(result, new Map([["p", geo]]), stock, []);
    expect(withDefaultMin.sheets[0].remnant).toEqual({ width: 100, height: 90, area: 9000 });

    const withHighMin = computeJobMetrics(result, new Map([["p", geo]]), stock, [], { remnantMinHeight: 200 });
    expect(withHighMin.sheets[0].remnant).toBeNull();
  });

  it("puts the remnant on the opposite side for top-anchored gravity", () => {
    const geo: PartGeometry = { outer: rect(10, 10), holes: [] };
    const result: TrueNestResult = {
      sheets: [{ stockIndex: 0, width: 100, height: 100 }],
      // Top-left gravity: the part sits at the top, y=[90,100], leaving a 90mm strip below it.
      placed: [{ partId: "p", sheet: 0, rotationDeg: 0, mirrored: false, translation: { x: 0, y: 90 } }],
      unplaced: [],
      utilisation: 0,
    };
    const stock: StockRow[] = [{ size: { name: "s", width: 100, height: 100 }, qty: 1 }];
    const metrics = computeJobMetrics(result, new Map([["p", geo]]), stock, [], { gravity: "top-left" });
    expect(metrics.sheets[0].remnant).toEqual({ width: 100, height: 90, area: 9000 });
  });

  it("leaves cutting time null when no cut-table row matches the sheet's material/thickness", () => {
    const geo: PartGeometry = { outer: rect(10, 10), holes: [] };
    const result: TrueNestResult = {
      sheets: [{ stockIndex: 0, width: 100, height: 100 }],
      placed: [{ partId: "p", sheet: 0, rotationDeg: 0, mirrored: false, translation: { x: 0, y: 0 } }],
      unplaced: [],
      utilisation: 0,
    };
    const stock: StockRow[] = [{ size: { name: "s", width: 100, height: 100 }, material: "steel", thickness: 3, qty: 1 }];
    const metrics = computeJobMetrics(result, new Map([["p", geo]]), stock, []);
    expect(metrics.sheets[0].cuttingTimeSec).toBeNull();
    expect(metrics.totalCuttingTimeSec).toBeNull();
  });

  it("computes cutting time and weight from a matching cut-table row", () => {
    const geo: PartGeometry = { outer: rect(100, 100), holes: [] }; // perimeter 400mm, area 10000mm2
    const result: TrueNestResult = {
      sheets: [{ stockIndex: 0, width: 200, height: 200 }],
      placed: [{ partId: "p", sheet: 0, rotationDeg: 0, mirrored: false, translation: { x: 0, y: 0 } }],
      unplaced: [],
      utilisation: 0,
    };
    const stock: StockRow[] = [{ size: { name: "s", width: 200, height: 200 }, material: "steel", thickness: 3, qty: 1, cost: 50 }];
    const cutTable: CutTableRow[] = [
      { material: "steel", thickness: 3, feedRateMmPerMin: 1200, pierceTimeSec: 1, rapidMmPerMin: 6000, estimated: true, densityKgPerM3: 7850 },
    ];
    const metrics = computeJobMetrics(result, new Map([["p", geo]]), stock, cutTable);
    const sheet = metrics.sheets[0];
    // cutLength/feed*60 + pierces*pierceTime + rapid/rapidSpeed*60
    const expectedCut = (400 / 1200) * 60 + 1 * 1 + (0 / 6000) * 60;
    expect(sheet.cuttingTimeSec).toBeCloseTo(expectedCut, 6);
    // weight = area(m2) * thickness(m) * density
    const expectedWeight = (10000 / 1e6) * (3 / 1000) * 7850;
    expect(sheet.weightKg).toBeCloseTo(expectedWeight, 6);
    expect(sheet.costEstimate).toBe(50);
    expect(metrics.totalCost).toBe(50);
    expect(metrics.totalCuttingTimeSec).toBeCloseTo(expectedCut, 6);
  });

  it("returns zeros for an empty result rather than throwing", () => {
    const result: TrueNestResult = { sheets: [], placed: [], unplaced: [], utilisation: 0 };
    const metrics = computeJobMetrics(result, new Map(), [], []);
    expect(metrics.sheets).toEqual([]);
    expect(metrics.totalUtilisation).toBe(0);
    expect(metrics.totalCuttingTimeSec).toBeNull();
    expect(metrics.totalCost).toBeNull();
  });
});

describe("cutRowForThickness", () => {
  const table: CutTableRow[] = [
    { material: "Aluminum", thickness: 1, feedRateMmPerMin: 10000, pierceTimeSec: 0.2, rapidMmPerMin: 15000, estimated: true, densityKgPerM3: 2700 },
    { material: "Aluminum", thickness: 3, feedRateMmPerMin: 4500, pierceTimeSec: 0.4, rapidMmPerMin: 15000, estimated: true, densityKgPerM3: 2700 },
    { material: "Aluminum", thickness: 6, feedRateMmPerMin: 1500, pierceTimeSec: 1.2, rapidMmPerMin: 12000, estimated: false, densityKgPerM3: 2700 },
  ];

  it("uses a row within 0.05 mm as is", () => {
    expect(cutRowForThickness(" aluminum ", 3.03, table)).toBe(table[1]);
  });

  it("estimates 1/8 in (3.175 mm) between the 3 and 6 mm rows instead of giving up - the reported missing cutting time", () => {
    const r = cutRowForThickness("Aluminum", 3.175, table)!;
    expect(r.feedRateMmPerMin).toBeLessThan(4500);
    expect(r.feedRateMmPerMin).toBeGreaterThan(1500);
    // log interpolation: at the geometric midpoint of feed for t half-way
    expect(cutRowForThickness("Aluminum", 4.5, table)!.feedRateMmPerMin).toBeCloseTo(Math.sqrt(4500 * 1500), 6);
    expect(cutRowForThickness("Aluminum", 4.5, table)!.pierceTimeSec).toBeCloseTo(0.8, 9);
    expect(r.estimated).toBe(true);
    expect(r.densityKgPerM3).toBe(2700);
  });

  it("slows down in proportion past the thickest row and stays at the thinnest row's (conservative) speed below it", () => {
    const thick = cutRowForThickness("Aluminum", 12, table)!;
    expect(thick.feedRateMmPerMin).toBeCloseTo(750, 9);
    expect(thick.pierceTimeSec).toBeCloseTo(2.4, 9);
    expect(thick.estimated).toBe(true);
    expect(cutRowForThickness("Aluminum", 0.5, table)!.feedRateMmPerMin).toBe(10000);
  });

  it("gives nothing for a material with no rows or no thickness", () => {
    expect(cutRowForThickness("Plywood", 3, table)).toBeUndefined();
    expect(cutRowForThickness("Aluminum", 0, table)).toBeUndefined();
    expect(cutRowForThickness("Aluminum", Number.NaN, table)).toBeUndefined();
  });

  it("gives a cutting time for a gauge thickness that matches no row exactly", () => {
    const geo: PartGeometry = { outer: rect(100, 100), holes: [] };
    const result: TrueNestResult = {
      sheets: [{ stockIndex: 0, width: 200, height: 200 }],
      placed: [{ partId: "p", sheet: 0, rotationDeg: 0, mirrored: false, translation: { x: 0, y: 0 } }],
      unplaced: [],
      utilisation: 0,
    };
    const stock: StockRow[] = [{ size: { name: "s", width: 200, height: 200 }, material: "Aluminum", thickness: 3.175, qty: 1 }];
    const m = computeJobMetrics(result, new Map([["p", geo]]), stock, table);
    expect(m.sheets[0].cuttingTimeSec).toBeGreaterThan(0);
    expect(m.sheets[0].weightKg).toBeCloseTo((10000 / 1e6) * (3.175 / 1000) * 2700, 9);
  });
});
