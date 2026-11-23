/**
 * The bar calculator decides how much stock a shop orders. An overfilled bar
 * (pieces + kerfs + trim longer than the bar) means a piece that cannot be
 * cut and a second trip to the supplier; a wasteful plan means money left on
 * the rack. These pin the invariants: never overfill, place everything that
 * fits, respect limited stock, prefer the plan with less to buy.
 */
import { describe, expect, it } from "vitest";
import { groupBars, planBars, tubeCutLength, tubeTime } from "./barCutting";
import { runBarCalc, runTubeCalc, defaultTubeInput } from "./calculators";
import { newMachineProfile } from "./machineProfile";

const opts = { kerf: 3, trimStart: 5, tail: 50 };

describe("planBars", () => {
  it("never overfills a bar and places every piece that fits", () => {
    const items = [
      { label: "A", length: 1200, qty: 7 },
      { label: "B", length: 850, qty: 11 },
      { label: "C", length: 333, qty: 9 },
    ];
    const plan = planBars(items, [{ length: 6000, qty: null }], opts);
    expect(plan.pieces).toBe(27);
    expect(plan.unplaced).toEqual([]);
    for (const b of plan.bars) {
      const used = opts.trimStart + b.cuts.reduce((n, c) => n + c.length + opts.kerf, 0);
      expect(used + opts.tail).toBeLessThanOrEqual(b.stockLength + 1e-6);
    }
  });

  it("packs an exact-fit job into the minimum number of bars", () => {
    // Usable 6000-5-50 = 5945; four 1480 pieces + 4 kerfs = 5932 fit, so 8 pieces = 2 bars.
    const plan = planBars([{ label: "A", length: 1480, qty: 8 }], [{ length: 6000, qty: null }], opts);
    expect(plan.bars.length).toBe(2);
  });

  it("reports pieces longer than every bar as unplaced instead of dropping them", () => {
    const plan = planBars([{ label: "L", length: 7000, qty: 2 }, { label: "S", length: 100, qty: 1 }], [{ length: 6000, qty: null }], opts);
    expect(plan.unplaced).toEqual([{ label: "L", length: 7000, count: 2 }]);
    expect(plan.pieces).toBe(1);
  });

  it("stops at the stock on hand and reports the rest", () => {
    const plan = planBars([{ label: "A", length: 2900, qty: 6 }], [{ length: 6000, qty: 2 }], { kerf: 0, trimStart: 0, tail: 0 });
    expect(plan.bars.length).toBe(2);
    expect(plan.unplaced[0]!.count).toBe(2);
  });

  it("picks the shorter bar when it holds the job just as well", () => {
    const plan = planBars([{ label: "A", length: 1000, qty: 4 }], [{ length: 6100, qty: null }, { length: 4100, qty: null }], { kerf: 0, trimStart: 0, tail: 0 });
    expect(plan.bars.map((b) => b.stockLength)).toEqual([4100]);
  });

  it("finds the least stock across mixed lengths (found in the panel: 288+288+240 when 3 x 240 holds it)", () => {
    const i = 25.4;
    const plan = planBars([{ label: "A", length: 48 * i, qty: 6 }, { label: "B", length: 30.5 * i, qty: 10 }], [{ length: 240 * i, qty: null }, { length: 288 * i, qty: null }], { kerf: 0.125 * i, trimStart: 0.25 * i, tail: 0 });
    expect(plan.pieces).toBe(16);
    expect(plan.totalStockLength).toBeCloseTo(720 * i, 6);
  });

  it("prefers the cheaper plan when every length has a price", () => {
    // One piece per bar either way; the 6000 bar costs less than the 4000 one, so the plan must not "downsize" onto the dearer bar.
    const plan = planBars([{ label: "A", length: 3900, qty: 3 }], [{ length: 4000, qty: null, cost: 100 }, { length: 6000, qty: null, cost: 60 }], { kerf: 0, trimStart: 0, tail: 0 });
    expect(plan.byStock.map((b) => [b.length, b.count])).toEqual([[6000, 3]]);
  });

  it("returns an empty plan for empty or nonsense input without throwing", () => {
    expect(planBars([], [], opts).bars).toEqual([]);
    expect(planBars([{ label: "x", length: NaN, qty: 3 }], [{ length: -1, qty: null }], opts).bars).toEqual([]);
  });

  it("groups identical bars for the cut list", () => {
    const plan = planBars([{ label: "A", length: 1000, qty: 10 }], [{ length: 5000, qty: null }], { kerf: 0, trimStart: 0, tail: 0 });
    const g = groupBars(plan.bars);
    expect(g).toHaveLength(1);
    expect(g[0]!.count).toBe(2);
  });
});

describe("tube time", () => {
  it("counts one separating cut per piece plus a facing cut per bar", () => {
    const plan = planBars([{ label: "A", length: 500, qty: 4 }], [{ length: 6000, qty: null }], { kerf: 0, trimStart: 5, tail: 0 });
    const prof = { shape: "square" as const, a: 50, wall: 3 };
    const t = tubeTime(plan, { profile: prof, feedMmPerMin: 6000, pierceSec: 1, indexSec: 0, barLoadSec: 0, partUnloadSec: 0, piercesPerCut: 1, facingCut: true });
    expect(t.cuts).toBe(5);
    expect(t.cutLength).toBeCloseTo(5 * tubeCutLength(prof), 6);
    expect(t.totalSec).toBeCloseTo((5 * 200) / 100 + 5, 6);
  });
});

describe("calculators", () => {
  it("reads inch and feet input and reports bars to buy", () => {
    const r = runBarCalc({ unit: "in", kerf: "1/8", trim: "0", tail: "0", stock: [{ length: "20'", qty: "", cost: "30" }], cuts: [{ label: "A", length: "60", qty: "8" }] });
    expect(r.error).toBeUndefined();
    // 240" bar holds three 60 1/8" pieces (180.375"), so 8 pieces = 3 bars.
    expect(r.buy).toEqual([{ length: expect.any(String), count: 3, cost: "90.00" }]);
  });

  it("explains what is missing instead of throwing", () => {
    expect(runBarCalc({ unit: "mm", kerf: "", trim: "", tail: "", stock: [], cuts: [] }).error).toMatch(/stock/);
  });

  it("takes the tube feed from a machine file when the field is blank", () => {
    const prof = { ...newMachineProfile("t1", "Tube laser"), type: "tube" as const };
    const r = runTubeCalc({ ...defaultTubeInput(), profileId: "t1", wall: "0.125", material: "cs" }, [prof]);
    expect(r.error).toBeUndefined();
    expect(r.summary.find((s) => s[0] === "Cut time")).toBeTruthy();
  });
});
