/**
 * Smoke tests for the raster nesting engine (RN-01). The reference
 * comparison and the clearance/margin invariants live in
 * `engineGolden.test.ts`; this file pins the basics a regression would break
 * first: everything fits when it should, quantities are conserved, and a
 * part too big for the sheet is reported unplaced instead of looping.
 */
import { describe, expect, it } from "vitest";
import { nestRasterSync, type RasterInput, type RPoint } from "./engine";

const rect = (w: number, h: number): RPoint[] => [[0, 0], [w, 0], [w, h], [0, h]];

const job = (over: Partial<RasterInput> = {}): RasterInput => ({
  parts: [{ polys: [rect(100, 50)], rots: [0, 90], qty: 6, area: 5000 }],
  sheetW: 400, sheetH: 300, spacing: 2, margin: 5, cell: 2.5, timeMs: 0, seed: 12345,
  ...over,
});

describe("nestRasterSync", () => {
  it("places every instance and conserves counts", () => {
    const r = nestRasterSync(job());
    const placed = r.sheets.reduce((n, s) => n + s.placements.length, 0);
    expect(placed + r.unplaced.length).toBe(6);
    expect(r.unplaced).toEqual([]);
  });
  it("reports a part larger than the sheet as unplaced", () => {
    const r = nestRasterSync(job({ parts: [{ polys: [rect(900, 900)], rots: [0], qty: 2, area: 810000 }] }));
    expect(r.sheets).toEqual([]);
    expect(r.unplaced).toEqual([0, 0]);
  });
  it("is deterministic for a fixed seed", () => {
    const a = nestRasterSync(job({ timeMs: 1e9, maxIterations: 20 }));
    const b = nestRasterSync(job({ timeMs: 1e9, maxIterations: 20 }));
    expect(a.sheets).toEqual(b.sheets);
  });
});
