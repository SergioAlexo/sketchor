import { describe, expect, it } from "vitest";
import { curveLength, pathOf, type Entity, type LineEntity, type TextEntity } from "@sketchor/core";
import { buildCutPlan, type GcodePlacement } from "./toolpath";
import { writeGcode } from "./write";
import { gcodeToEntities } from "./parse";
import { TOOLPATH_COLORS, TOOLPATH_CUT_LAYER, TOOLPATH_ORDER_LAYER, TOOLPATH_RAPID_LAYER, toolpathPreview, toolpathPreviewScale } from "./preview";

/**
 * N-43: the preview is how an operator checks a sheet before burning it — a
 * preview that disagrees with the program is worse than none, because it
 * says "holes first, short rapids" while the machine does something else.
 * So the central check here runs the real writer and the real reader and
 * demands the same beam-on and beam-off lengths the preview reports.
 */

function line(id: string, a: { x: number; y: number }, b: { x: number; y: number }): Entity {
  return { id, type: "line", a, b };
}
function rectLines(prefix: string, x: number, y: number, w: number, h: number): Entity[] {
  const p = [{ x, y }, { x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h }];
  return [0, 1, 2, 3].map((i) => line(`${prefix}${i}`, p[i], p[(i + 1) % 4]));
}

const plate = (id: string, number: number, x: number): GcodePlacement => ({
  id,
  number,
  outerEntities: rectLines(`${id}o`, x, 20, 100, 60),
  holeEntities: [{ id: `${id}h`, type: "circle", center: { x: x + 50, y: 50 }, radius: 10 }],
});

const length = (e: Entity): number => pathOf(e)?.curves.reduce((s, c) => s + curveLength(c), 0) ?? 0;
const onLayer = (es: Entity[], layer: string) => es.filter((e) => e.layer === layer);

describe("toolpathPreview", () => {
  it("draws what the program does: the same beam-on and beam-off length as the emitted G-code read back", () => {
    for (const tabs of [undefined, { count: 3, width: 4 }]) {
      const plan = buildCutPlan([plate("a", 1, 10), plate("b", 2, 130)], { kerf: 0.2, tabs });
      const { stats } = toolpathPreview(plan.features);
      const gcode = writeGcode(plan.features, { unit: "mm", scale: 1, feedRateMmPerMin: 3000, pierceTimeSec: 0.3 });
      const back = gcodeToEntities(gcode, { unit: "mm", includeRapids: true, layer: "cut" });
      const added = back.commands.flatMap((c) => (c.type === "add-entity" ? [c.entity] : []));
      const rapids = added.filter((e) => e.layer === "cut rapids").reduce((s, e) => s + length(e), 0);
      const cuts = added.filter((e) => e.layer === "cut").reduce((s, e) => s + length(e), 0);
      // The writer rounds coordinates to its output precision; a few thousandths over a whole sheet is that, not a disagreement.
      expect(stats.rapidLength).toBeCloseTo(rapids, 1);
      expect(stats.cutLength).toBeCloseTo(cuts, 1);
    }
  });

  it("starts and ends at home, and the rapids chain from where each cut stopped", () => {
    const plan = buildCutPlan([plate("a", 1, 10)], { leadInLength: 3 });
    const home = { x: -5, y: -5 };
    const rapids = onLayer(toolpathPreview(plan.features, { home }).entities, TOOLPATH_RAPID_LAYER) as LineEntity[];
    expect(rapids[0].a).toEqual(home);
    expect(rapids[rapids.length - 1].b).toEqual(home);
    // hole then outer: home -> hole pierce, hole end -> outer pierce, outer end -> home
    expect(rapids).toHaveLength(3);
    expect(rapids[0].b).toEqual(plan.features[0].pierce);
    expect(rapids[1].a).toEqual(plan.features[0].leadIn);
    expect(rapids[1].b).toEqual(plan.features[1].pierce);
  });

  it("numbers the cuts in program order — a part's hole is 1, its outer profile 2 — and colours them by role", () => {
    const plan = buildCutPlan([plate("a", 1, 10)]);
    const { entities } = toolpathPreview(plan.features);
    const labels = onLayer(entities, TOOLPATH_ORDER_LAYER).filter((e): e is TextEntity => e.type === "text");
    expect(labels.map((t) => t.text)).toEqual(["1", "2"]);
    const cutColours = onLayer(entities, TOOLPATH_CUT_LAYER).map((e) => e.color);
    expect(cutColours[0]).toBe(TOOLPATH_COLORS.hole);
    expect(cutColours[cutColours.length - 1]).toBe(TOOLPATH_COLORS.outer);
  });

  it("draws rapids dashed (with the asked-for linetype scale) and cuts solid", () => {
    const plan = buildCutPlan([plate("a", 1, 10)]);
    const { entities } = toolpathPreview(plan.features, { rapidLinetypeScale: 12 });
    for (const r of onLayer(entities, TOOLPATH_RAPID_LAYER)) expect(r).toMatchObject({ linetype: "DASHED", linetypeScale: 12, color: TOOLPATH_COLORS.rapid });
    for (const c of onLayer(entities, TOOLPATH_CUT_LAYER)) {
      expect(c.linetype).toBeUndefined();
      expect(c.linetypeScale).toBeUndefined();
    }
  });

  it("counts one pierce per contour without tabs, and one more for every run the beam restarts after a tab", () => {
    const plain = toolpathPreview(buildCutPlan([plate("a", 1, 10)]).features).stats;
    expect(plain).toMatchObject({ contours: 2, pierces: 2 });

    const tabbed = buildCutPlan([plate("a", 1, 10)], { tabs: { count: 3, width: 4 } });
    const runs = tabbed.features.reduce((n, f) => n + (f.runs?.length ?? 1), 0);
    const { stats, entities } = toolpathPreview(tabbed.features);
    expect(runs).toBeGreaterThan(2);
    expect(stats).toMatchObject({ contours: 2, pierces: runs });
    // every run is its own cut piece, plus one lead-in per contour
    expect(onLayer(entities, TOOLPATH_CUT_LAYER).length).toBe(runs + 2);
  });

  it("an empty plan draws nothing and moves nowhere", () => {
    expect(toolpathPreview([])).toEqual({ entities: [], stats: { contours: 0, pierces: 0, cutLength: 0, rapidLength: 0 } });
  });

  it("never draws a cut number bigger than its own contour, so small neighbours' labels don't pile up", () => {
    const washer: GcodePlacement = { id: "w", number: 2, outerEntities: [{ id: "wo", type: "circle", center: { x: 200, y: 30 }, radius: 5 }], holeEntities: [] };
    const plan = buildCutPlan([plate("a", 1, 10), washer]);
    const labels = onLayer(toolpathPreview(plan.features, { labelHeight: 25 }).entities, TOOLPATH_ORDER_LAYER).filter((e): e is TextEntity => e.type === "text");
    const washerLabel = labels[plan.features.findIndex((f) => f.placementId === "w")]!;
    const plateLabel = labels[plan.features.findIndex((f) => f.placementId === "a" && f.role === "outer")]!;
    expect(plateLabel.height).toBe(25); // a 100 x 60 plate has room for the full size
    expect(washerLabel.height).toBeLessThanOrEqual(10 * 0.4 + 1e-9); // a 10 mm washer gets at most 40 % of itself
  });
});

describe("toolpathPreviewScale", () => {
  it("keeps the rapids dashed with a whole sheet in view, at any sheet size", () => {
    // fit zoom ≈ 1100 px across the sheet's long side; DASHED is a 9 mm period, solid below 6 px
    for (const [w, h] of [[300, 200], [1219.2, 2438.4], [1500, 3000], [6000, 2000]]) {
      const { rapidLinetypeScale } = toolpathPreviewScale(w, h);
      const pxPerMm = 1100 / Math.max(w, h);
      expect(9 * rapidLinetypeScale * pxPerMm).toBeGreaterThanOrEqual(6);
    }
  });

  it("never shrinks the dash below DASHED's own size, and keeps labels between 3 and 30 mm", () => {
    expect(toolpathPreviewScale(100, 50).rapidLinetypeScale).toBe(1);
    expect(toolpathPreviewScale(100, 50).labelHeight).toBe(3);
    expect(toolpathPreviewScale(20000, 9000).labelHeight).toBe(30);
  });
});
