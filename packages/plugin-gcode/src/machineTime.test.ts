/**
 * The machine-file time model is what a quote is priced on. It must agree
 * with the plain length/feed estimate when acceleration and overheads are
 * zero (so switching models never changes a number for no reason), and it
 * must get slower - never faster - as the real-machine effects are added.
 */
import { describe, expect, it } from "vitest";
import { machineTimeSec, strokeTime } from "./machineTime";
import { cutTimeSec, toolpathPreview } from "./preview";
import { buildCutPlan } from "./toolpath";
import type { Entity } from "@sketchor/core";

const rect = (id: string, x: number, y: number, w: number, h: number): Entity => ({ id, type: "polyline", closed: true, points: [{ x, y }, { x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h }] } as Entity);
const circle = (id: string, x: number, y: number, r: number): Entity => ({ id, type: "circle", center: { x, y }, radius: r } as Entity);

const plan = buildCutPlan([{ id: "0", number: 1, outerEntities: [rect("o", 10, 10, 200, 100)], holeEntities: [circle("h", 50, 50, 4)] }]);
const base = { feedMmPerMin: 3000, rapidMmPerMin: 20000, pierceSec: 0.5, cutAccel: 0, rapidAccel: 0, headLiftSec: 0 };

describe("machineTimeSec", () => {
  it("matches the plain estimate with no acceleration or overheads", () => {
    const plain = cutTimeSec(toolpathPreview(plan.features).stats, { feedRateMmPerMin: 3000, pierceTimeSec: 0.5, rapidMmPerMin: 20000 });
    const t = machineTimeSec(plan.features, base);
    expect(t.totalSec).toBeCloseTo(plain, 1);
    expect(t.pierces).toBe(2);
  });

  it("gets slower with acceleration, head lift and small-hole feed", () => {
    const t0 = machineTimeSec(plan.features, base).totalSec;
    const t1 = machineTimeSec(plan.features, { ...base, cutAccel: 500, rapidAccel: 2000 }).totalSec;
    const t2 = machineTimeSec(plan.features, { ...base, cutAccel: 500, rapidAccel: 2000, headLiftSec: 0.7 }).totalSec;
    const t3 = machineTimeSec(plan.features, { ...base, cutAccel: 500, rapidAccel: 2000, headLiftSec: 0.7, smallHoleMm: 10, smallHoleFeedPct: 50 }).totalSec;
    expect(t1).toBeGreaterThan(t0);
    expect(t2).toBeCloseTo(t1 + 1.4, 6);
    expect(t3).toBeGreaterThan(t2);
  });

  it("stroke time: trapezoid when long, triangle when short", () => {
    expect(strokeTime(1000, 100, 1000)).toBeCloseTo(10 + 0.1, 9);
    expect(strokeTime(1, 100, 1000)).toBeCloseTo(2 * Math.sqrt(0.001), 9);
    expect(strokeTime(0, 100, 1000)).toBe(0);
  });
});
