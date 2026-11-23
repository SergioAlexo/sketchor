import { describe, expect, it } from "vitest";
import { planBars } from "./barCutting";
import { groupMiterBars, miterCutLength, miterDepth, orientations, pieceShape, planMiterBars, sequenceBar } from "./miterNest";

const D = 50; // 50 mm deep tube
const t45 = 50; // what a 45-degree mitre spans along the bar at that depth

describe("pieceShape / orientations", () => {
  it("a 45/45 frame piece is a trapezoid, long point to long point = length", () => {
    const s = pieceShape(1000, 45, 45, D);
    expect(s.l0).toBeCloseTo(0);
    expect(s.l1).toBeCloseTo(t45);
    expect(s.r0).toBeCloseTo(1000);
    expect(s.r1).toBeCloseTo(1000 - t45);
  });
  it("a 45/-45 piece is a parallelogram; a square piece has one orientation", () => {
    const s = pieceShape(1000, 45, -45, D);
    // parallel ends: the same length on both faces (a parallelogram is measured along a face), slanted by the mitre
    expect(s.r0 - s.l0).toBeCloseTo(1000);
    expect(s.r1 - s.l1).toBeCloseTo(1000);
    expect(s.l1 - s.l0).toBeCloseTo(t45);
    expect(orientations(pieceShape(500, 0, 0, D), true)).toHaveLength(1);
    expect(orientations(pieceShape(500, 45, 45, D), true)).toHaveLength(2); // as drawn, upside down
  });
});

describe("sequenceBar", () => {
  it("nests frame pieces alternately upside down so they share their cuts", () => {
    const base = pieceShape(1000, 45, 45, D);
    const u = { label: "A", length: 1000, a1: 45, a2: 45, base };
    const r = sequenceBar([u, u, u, u], { kerf: 0, trimStart: 0, depth: D, allowTurn: true });
    expect(r.pieces.map((p) => p.upsideDown)).toEqual([false, true, false, true]);
    // 4 trapezoids sharing cuts: long + short + long + short faces line up -> 4 * 1000 - 3 * 50 along the bottom
    expect(r.used).toBeCloseTo(4 * 1000 - 3 * t45, 6);
    // first end + 3 shared cuts + last end
    expect(r.cutAngles).toHaveLength(5);
    expect(r.cutAngles.every((a) => Math.abs(a - 45) < 1e-6)).toBe(true);
    // without turning every gap wastes a full wedge
    const stiff = sequenceBar([u, u, u, u], { kerf: 0, trimStart: 0, depth: D, allowTurn: false });
    expect(stiff.used).toBeCloseTo(4 * 1000, 6);
    expect(stiff.cutAngles).toHaveLength(8);
  });
  it("counts the kerf on a slanted cut along the bar", () => {
    const base = pieceShape(1000, 45, 45, D);
    const u = { label: "A", length: 1000, a1: 45, a2: 45, base };
    const r = sequenceBar([u, u], { kerf: 2, trimStart: 0, depth: D, allowTurn: true });
    expect(r.used).toBeCloseTo(2000 - t45 + 2 * Math.SQRT2, 6);
  });
});

describe("planMiterBars", () => {
  const stock = [{ length: 6000, qty: null }];
  it("matches the 1D planner exactly when every end is square", () => {
    const items = [{ label: "A", length: 1200, qty: 7 }, { label: "B", length: 800, qty: 5 }];
    const a = planMiterBars(items, stock, { kerf: 3, trimStart: 5, tail: 50, depth: D });
    const b = planBars(items, stock, { kerf: 3, trimStart: 5, tail: 50 });
    expect(a.mitred).toBe(false);
    expect(a.bars.map((x) => x.cuts)).toEqual(b.bars.map((x) => x.cuts));
    expect(a.bars[0]!.cutAngles.length).toBe(1 + a.bars[0]!.cuts.length);
  });
  it("fits more mitred frame pieces per bar by turning them", () => {
    // 6 frame pieces of 1000 (long point): end to end they need 6000; nested they need 5750 + kerf
    const items = [{ label: "F", length: 1000, qty: 6, a1: 45, a2: 45 }];
    const turned = planMiterBars(items, stock, { kerf: 2, trimStart: 0, tail: 0, depth: D });
    expect(turned.mitred).toBe(true);
    expect(turned.bars).toHaveLength(1);
    expect(turned.unplaced).toEqual([]);
    const stiff = planMiterBars(items, [{ length: 5900, qty: null }], { kerf: 2, trimStart: 0, tail: 0, depth: D, allowTurn: false });
    expect(stiff.bars.length).toBe(2);
    // every bar fits its stock
    for (const b of turned.bars) expect(b.used).toBeLessThanOrEqual(b.stockLength + 1e-6);
  });
  it("never overfills a bar and reports what cannot fit", () => {
    const items = [{ label: "F", length: 1500, qty: 13, a1: 45, a2: 45 }, { label: "P", length: 700, qty: 9, a1: 30, a2: -30 }, { label: "S", length: 400, qty: 5 }, { label: "X", length: 7000, qty: 1, a1: 45, a2: 45 }];
    const r = planMiterBars(items, [{ length: 6000, qty: null }, { length: 3000, qty: 2 }], { kerf: 3, trimStart: 10, tail: 80, depth: 60 });
    for (const b of r.bars) {
      expect(b.used + 80).toBeLessThanOrEqual(b.stockLength + 1e-6);
      for (let i = 1; i < b.pieces.length; i++) {
        const a = b.pieces[i - 1]!.shape, c = b.pieces[i]!.shape;
        expect(c.l0).toBeGreaterThanOrEqual(a.r0 - 1e-6);
        expect(c.l1).toBeGreaterThanOrEqual(a.r1 - 1e-6);
      }
    }
    expect(r.unplaced).toEqual([{ label: "X", length: 7000, count: 1 }]);
    expect(r.pieces).toBe(13 + 9 + 5);
    expect(groupMiterBars(r.bars).reduce((n, g) => n + g.count, 0)).toBe(r.bars.length);
  });
});

describe("miterCutLength / miterDepth", () => {
  it("a 45-degree cut is longer across the mitred faces only", () => {
    const sq = { shape: "square" as const, a: 50, wall: 3 };
    expect(miterCutLength(sq, 0)).toBeCloseTo(200);
    expect(miterCutLength(sq, 45)).toBeCloseTo(100 + 100 * Math.SQRT2);
    const round = { shape: "round" as const, a: 50, wall: 3 };
    expect(miterCutLength(round, 0)).toBeCloseTo(Math.PI * 50, 6);
    expect(miterCutLength(round, 45)).toBeGreaterThan(Math.PI * 50 * 1.19);
    expect(miterDepth({ shape: "rect", a: 80, b: 40, wall: 3 }, "b")).toBe(40);
  });
});
