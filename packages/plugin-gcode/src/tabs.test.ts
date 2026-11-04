import { describe, expect, it } from "vitest";
import { curveLength, type Curve } from "@sketchor/core";
import { loopLength, planTabs, sliceLoop, splitLoopAtTabs } from "./tabs";

/**
 * Tabs keep a cut part attached to the skeleton. A wrong plan either drops
 * the part (no/too-small bridge) or leaves a run uncuttable, so these pin
 * the invariants (cut + bridge lengths add up to the perimeter, bridges have
 * the asked width) and the degenerate requests (zero tabs, a tab wider than
 * the contour, tiny closed contours) that must degrade, never throw.
 */
function rect(w: number, h: number): Curve[] {
  const p = [{ x: 0, y: 0 }, { x: w, y: 0 }, { x: w, y: h }, { x: 0, y: h }];
  return [0, 1, 2, 3].map((i) => ({ kind: "segment", a: p[i]!, b: p[(i + 1) % 4]! }));
}
const sum = (cs: Curve[][]) => cs.reduce((n, run) => n + run.reduce((m, c) => m + curveLength(c), 0), 0);

describe("planTabs", () => {
  it("places evenly spread tabs of the asked width", () => {
    const plan = planTabs(400, { count: 4, width: 4 });
    expect(plan.count).toBe(4);
    expect(plan.tabs.map((t) => t.start + 2)).toEqual([50, 150, 250, 350]);
    for (const t of plan.tabs) expect(t.end - t.start).toBeCloseTo(4);
    expect(plan.warnings).toEqual([]);
  });
  it("zero or negative tabs means none, silently", () => {
    expect(planTabs(100, { count: 0, width: 3 })).toMatchObject({ count: 0, tabs: [], warnings: [] });
    expect(planTabs(100, { count: -2, width: 3 }).tabs).toEqual([]);
    expect(planTabs(100, { count: Number.NaN, width: 3 }).tabs).toEqual([]);
  });
  it("a tab as wide as or wider than the contour places none and warns", () => {
    for (const width of [100, 250]) {
      const plan = planTabs(100, { count: 2, width });
      expect(plan.tabs).toEqual([]);
      expect(plan.warnings[0]).toMatch(/not smaller than the contour/);
    }
  });
  it("tiny contours: caps the count so every cut run is at least a tab wide", () => {
    const plan = planTabs(25, { count: 4, width: 4 });
    expect(plan.count).toBe(3);
    expect(plan.warnings[0]).toMatch(/only 3 of 4/);
    expect(planTabs(6, { count: 2, width: 4 })).toMatchObject({ count: 0 });
  });
  it("rejects bad width / zero perimeter without throwing", () => {
    expect(planTabs(100, { count: 2, width: 0 }).tabs).toEqual([]);
    expect(planTabs(100, { count: 2, width: Number.NaN }).tabs).toEqual([]);
    expect(planTabs(0, { count: 2, width: 3 }).tabs).toEqual([]);
    expect(planTabs(Number.NaN, { count: 2, width: 3 }).tabs).toEqual([]);
  });
  it("a tab straddling the loop start is split in two ranges inside [0, perimeter]", () => {
    const plan = planTabs(100, { count: 1, width: 10, offset: 2 });
    expect(plan.tabs).toEqual([
      { tab: 0, start: 0, end: 7 },
      { tab: 0, start: 97, end: 100 },
    ]);
    const end = planTabs(100, { count: 1, width: 10, offset: 98 });
    expect(end.tabs.reduce((n, t) => n + t.end - t.start, 0)).toBeCloseTo(10);
  });
});

describe("splitLoopAtTabs", () => {
  it("cut runs + bridges cover the whole contour exactly", () => {
    const loop = rect(100, 50);
    const s = splitLoopAtTabs(loop, { count: 4, width: 3 });
    expect(s.closed).toBe(false);
    expect(sum(s.bridges)).toBeCloseTo(12);
    expect(sum(s.runs) + sum(s.bridges)).toBeCloseTo(loopLength(loop));
    expect(s.bridges).toHaveLength(4);
  });
  it("zero tabs returns the untouched closed loop", () => {
    const loop = rect(10, 10);
    const s = splitLoopAtTabs(loop, { count: 0, width: 2 });
    expect(s.closed).toBe(true);
    expect(s.runs).toEqual([loop]);
  });
  it("a tab wider than the contour leaves the loop whole", () => {
    const s = splitLoopAtTabs(rect(2, 2), { count: 1, width: 20 });
    expect(s.closed).toBe(true);
    expect(s.plan.warnings.length).toBe(1);
  });
  it("handles a full circle", () => {
    const circle: Curve[] = [{ kind: "arc", center: { x: 0, y: 0 }, radius: 10, startAngle: 0, endAngle: Math.PI * 2, ccw: true, full: true }];
    const s = splitLoopAtTabs(circle, { count: 3, width: 2 });
    expect(s.bridges).toHaveLength(3);
    expect(sum(s.runs) + sum(s.bridges)).toBeCloseTo(2 * Math.PI * 10, 5);
  });
  it("a tab wrapped over the start leaves one run of the remaining length", () => {
    const s = splitLoopAtTabs(rect(10, 10), { count: 1, width: 4, offset: 0 });
    expect(sum(s.runs)).toBeCloseTo(36);
    expect(s.runs).toHaveLength(1);
  });
  it("empty and zero-length loops give no runs", () => {
    expect(splitLoopAtTabs([], { count: 2, width: 1 }).runs).toEqual([]);
    const dot: Curve[] = [{ kind: "segment", a: { x: 1, y: 1 }, b: { x: 1, y: 1 } }];
    expect(splitLoopAtTabs(dot, { count: 2, width: 1 }).runs).toEqual([]);
  });
  it("sliceLoop of a span across a corner keeps both legs", () => {
    const out = sliceLoop(rect(10, 10), 8, 12);
    expect(out).toHaveLength(2);
    expect(out.reduce((n, c) => n + curveLength(c), 0)).toBeCloseTo(4);
  });
});
