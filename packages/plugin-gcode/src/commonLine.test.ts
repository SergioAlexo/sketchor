import { describe, expect, it } from "vitest";
import type { Entity } from "@sketchor/core";
import { loopLength } from "./tabs";
import { buildCutPlan, type GcodePlacement } from "./toolpath";
import { cutTimeSec, toolpathPreview } from "./preview";
import { writeGcode } from "./write";

const line = (id: string, a: { x: number; y: number }, b: { x: number; y: number }): Entity => ({ id, type: "line", a, b });
function rect(prefix: string, x: number, y: number, w: number, h: number): Entity[] {
  const p = [{ x, y }, { x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h }];
  return [0, 1, 2, 3].map((i) => line(`${prefix}${i}`, p[i]!, p[(i + 1) % 4]!));
}
const part = (id: string, x: number, y: number, w = 100, h = 50): GcodePlacement => ({ id, number: Number(id) + 1, outerEntities: rect(`p${id}-`, x, y, w, h), holeEntities: [] });
const cutLength = (plan: ReturnType<typeof buildCutPlan>) =>
  plan.features.reduce((n, f) => n + (f.runs ? f.runs.reduce((m, r) => m + loopLength(r), 0) : loopLength(f.loop)), 0);

describe("N-51 common-line cutting", () => {
  const kerf = 2;
  it("is off by default: output unchanged", () => {
    const parts = [part("0", 10, 10), part("1", 112, 10)];
    const a = buildCutPlan(parts, { kerf });
    expect(a.commonLineMm).toBeUndefined();
    expect(a.features.every((f) => !f.runs)).toBe(true);
  });

  it("two parts one kerf apart share the edge between them: it is cut once", () => {
    const parts = [part("0", 10, 10), part("1", 112, 10)]; // gap 2 = kerf: compensated paths meet on x = 111
    const off = buildCutPlan(parts, { kerf });
    const on = buildCutPlan(parts, { kerf, commonLine: true });
    expect(on.commonLineMm).toBeCloseTo(52, 6); // the compensated edge is 50 + kerf long
    expect(cutLength(off) - cutLength(on)).toBeCloseTo(52, 6);
    const second = on.features[1]!;
    expect(second.runs).toHaveLength(1);
    // the run starts at one end of the shared edge and ends at the other: an open U, not a closed loop
    const r = second.runs![0]!;
    const start = r[0]!.kind === "segment" ? r[0]!.a : null, endC = r[r.length - 1]!;
    const end = endC.kind === "segment" ? endC.b : null;
    expect(start!.x).toBeCloseTo(111, 6);
    expect(end!.x).toBeCloseTo(111, 6);
  });

  it("a 2 x 2 block: the last part cuts only its two outer edges", () => {
    const parts = [part("0", 0, 0), part("1", 102, 0), part("2", 0, 52), part("3", 102, 52)];
    const on = buildCutPlan(parts, { kerf, commonLine: true });
    // shared: the vertical line (2 x 52) and the horizontal line (2 x 102)
    expect(on.commonLineMm).toBeCloseTo(2 * 52 + 2 * 102, 6);
    expect(on.features).toHaveLength(4);
  });

  it("parts further apart than the kerf share nothing", () => {
    const on = buildCutPlan([part("0", 10, 10), part("1", 115, 10)], { kerf, commonLine: true });
    expect(on.commonLineMm).toBe(0);
    expect(on.features.every((f) => !f.runs)).toBe(true);
  });

  it("the G-code, preview and cut time follow the shortened cut", () => {
    const parts = [part("0", 10, 10), part("1", 112, 10)];
    const off = buildCutPlan(parts, { kerf });
    const on = buildCutPlan(parts, { kerf, commonLine: true });
    const speeds = { feedRateMmPerMin: 1000, rapidMmPerMin: 10000, pierceTimeSec: 0.5 };
    const pOff = toolpathPreview(off.features), pOn = toolpathPreview(on.features);
    expect(pOff.stats.cutLength - pOn.stats.cutLength).toBeGreaterThan(50);
    expect(cutTimeSec(pOn.stats, speeds)).toBeLessThan(cutTimeSec(pOff.stats, speeds));
    const g = writeGcode(on.features, { unit: "mm", scale: 1, feedRateMmPerMin: 1000, pierceTimeSec: 0.5 });
    expect(g).toMatch(/G1/);
  });
});
