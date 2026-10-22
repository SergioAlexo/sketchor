/**
 * Cooperative-run tests (RN-03). The plugin worker can only receive a
 * "cancel" message if the search hands the event loop back; if `nestRaster`
 * ever regresses to a blocking loop, Stop silently stops working and the
 * panel freezes for the whole optimisation budget.
 */
import { describe, expect, it } from "vitest";
import { nestRaster, nestRasterSync, type RasterInput, type RPoint } from "./engine";

const lshape = (s: number, t: number): RPoint[] => [[0, 0], [s, 0], [s, t], [t, t], [t, s], [0, s]];

// Awkward shapes on a small sheet: the area lower bound is never reached, so
// the search keeps restarting until the budget (or a cancel) ends it.
const hard = (timeMs: number): RasterInput => ({
  parts: [{ polys: [lshape(90, 30)], rots: [0, 90, 180, 270, 45], qty: 40, area: 90 * 30 + 60 * 30 }],
  sheetW: 400, sheetH: 300, spacing: 3, margin: 6, cell: 2.5, arcTol: 0.05, timeMs, seed: 12345,
});

describe("nestRaster (async)", () => {
  it("lets other macrotasks run during the search", async () => {
    let fired = 0;
    const timer = setInterval(() => { fired++; }, 10);
    await nestRaster(hard(400), { sliceMs: 20 });
    clearInterval(timer);
    expect(fired).toBeGreaterThan(3);
  });

  it("cancel returns the best layout so far, well before the budget", async () => {
    const t0 = Date.now();
    let cancelled = false;
    setTimeout(() => { cancelled = true; }, 80);
    const r = await nestRaster(hard(20_000), { isCancelled: () => cancelled, sliceMs: 10 });
    expect(Date.now() - t0).toBeLessThan(5000);
    expect(r.sheets.length).toBeGreaterThan(0);
    const placed = r.sheets.reduce((n, s) => n + s.placements.length, 0);
    expect(placed + r.unplaced.length).toBe(40);
  });

  it("streams a best-so-far before finishing and matches the sync result without a budget", async () => {
    const seen: number[] = [];
    const a = await nestRaster(hard(0), { onBest: (_b, info) => seen.push(info.iter) });
    expect(seen.length).toBeGreaterThanOrEqual(1);
    expect(a.sheets).toEqual(nestRasterSync(hard(0)).sheets);
  });
});
