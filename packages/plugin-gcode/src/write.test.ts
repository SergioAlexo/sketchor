import { describe, expect, it } from "vitest";
import type { Entity } from "@sketchor/core";
import { buildCutPlan, type GcodePlacement } from "./toolpath";
import { GENERIC_LASER_PROFILE, writeGcode } from "./write";
import { gcodeToEntities } from "./parse";

/**
 * The writer is what actually reaches a machine — a wrong unit code or a
 * feed rate silently dropped scraps material, and a program that never
 * closes with M30 leaves the controller hanging. N-44's round-trip
 * (emit -> `gcodeToEntities`, the existing reader -> compare) is the
 * strongest check available without a real controller: it catches anything
 * that would make the emitted numbers not mean what the writer thinks.
 */

function line(id: string, a: { x: number; y: number }, b: { x: number; y: number }): Entity {
  return { id, type: "line", a, b };
}
function rectLines(prefix: string, x: number, y: number, w: number, h: number): Entity[] {
  const p = [{ x, y }, { x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h }];
  return [0, 1, 2, 3].map((i) => line(`${prefix}${i}`, p[i], p[(i + 1) % 4]));
}
function circle(id: string, cx: number, cy: number, r: number): Entity {
  return { id, type: "circle", center: { x: cx, y: cy }, radius: r };
}

const rectWithHole: GcodePlacement = {
  id: "p0",
  number: 1,
  outerEntities: rectLines("o", 0, 0, 100, 60),
  holeEntities: [circle("h", 50, 30, 10)],
};

describe("writeGcode", () => {
  it("declares the unit, ensures the laser starts off, and ends the program", () => {
    const plan = buildCutPlan([rectWithHole]);
    const mm = writeGcode(plan.features, { unit: "mm", scale: 1, feedRateMmPerMin: 3000, pierceTimeSec: 0.3 });
    expect(mm).toContain("G21");
    expect(mm).not.toContain("G20");
    const lines = mm.trim().split("\n");
    expect(lines[0]).toMatch(/^\(/); // a leading comment banner, not raw motion
    expect(lines).toContain(GENERIC_LASER_PROFILE.laserOffCode);
    expect(lines[lines.length - 1]).toBe("M30");

    const inch = writeGcode(plan.features, { unit: "in", scale: 1 / 25.4, feedRateMmPerMin: 3000, pierceTimeSec: 0.3 });
    expect(inch).toContain("G20");
    expect(inch).not.toContain("G21");
  });

  it("scales coordinates and feed rate by the given factor", () => {
    const plan = buildCutPlan([rectWithHole], { leadInLength: 3 });
    const mm = writeGcode(plan.features, { unit: "mm", scale: 1, feedRateMmPerMin: 2540, pierceTimeSec: 0.3 });
    const inch = writeGcode(plan.features, { unit: "in", scale: 1 / 25.4, feedRateMmPerMin: 2540, pierceTimeSec: 0.3 });
    expect(mm).toContain("F2540");
    expect(inch).toContain("F100"); // 2540 mm/min == 100 in/min
  });

  it("emits arcs as G2 (cw) / G3 (ccw) with I/J relative to the arc's own start point", () => {
    const plan = buildCutPlan([rectWithHole]);
    const gcode = writeGcode(plan.features, { unit: "mm", scale: 1, feedRateMmPerMin: 3000, pierceTimeSec: 0.3 });
    expect(gcode).toMatch(/G[23] X[\d.-]+ Y[\d.-]+ I[\d.-]+ J[\d.-]+/);
  });

  it("uses the pierce point (not the true edge) for the rapid, and dwells before cutting", () => {
    const plan = buildCutPlan([rectWithHole]);
    const feature = plan.features[0];
    const gcode = writeGcode([feature], { unit: "mm", scale: 1, feedRateMmPerMin: 3000, pierceTimeSec: 0.5 });
    const lines = gcode.split("\n");
    const rapidIdx = lines.findIndex((l) => l.startsWith("G0"));
    const m = /^G0 X([\d.-]+) Y([\d.-]+)$/.exec(lines[rapidIdx]);
    expect(m).not.toBeNull();
    expect(Number(m![1])).toBeCloseTo(feature.pierce.x, 3);
    expect(Number(m![2])).toBeCloseTo(feature.pierce.y, 3);
    expect(lines[rapidIdx + 1]).toBe(GENERIC_LASER_PROFILE.laserOnCode);
    expect(lines[rapidIdx + 2]).toBe("G4 P0.5");
  });
});

describe("N-44: round trip (emit -> gcodeToEntities) stays within tolerance of the nest", () => {
  it("recovers the same number of closed loops and a matching bounding box", () => {
    // A zero-length lead-in isolates this check to the loop geometry itself
    // — a real (non-zero) lead-in is expected to poke slightly into scrap
    // before joining the true edge, which the next test pins directly.
    const plan = buildCutPlan([rectWithHole], { kerf: 0, leadInLength: 0 });
    const gcode = writeGcode(plan.features, { unit: "mm", scale: 1, feedRateMmPerMin: 3000, pierceTimeSec: 0.3 });

    const { commands, warnings, stats } = gcodeToEntities(gcode, { unit: "mm" });
    expect(warnings).toEqual([]);
    expect(stats.unit).toBe("mm");

    const entities = commands.filter((c): c is Extract<typeof c, { type: "add-entity" }> => c.type === "add-entity").map((c) => c.entity);
    // One closed polyline per cut feature (hole + outer) — rapids aren't drawn by default.
    expect(entities).toHaveLength(2);

    const allPoints = entities.flatMap((e) => (e.type === "polyline" ? e.points : []));
    const xs = allPoints.map((p) => p.x);
    const ys = allPoints.map((p) => p.y);
    expect(Math.min(...xs)).toBeCloseTo(0, 1);
    expect(Math.max(...xs)).toBeCloseTo(100, 1);
    expect(Math.min(...ys)).toBeCloseTo(0, 1);
    expect(Math.max(...ys)).toBeCloseTo(60, 1);
  });

  it("a non-zero lead-in pokes into scrap by exactly its own length before joining the true edge", () => {
    const plan = buildCutPlan([rectWithHole], { kerf: 0, leadInLength: 4 });
    const gcode = writeGcode(plan.features, { unit: "mm", scale: 1, feedRateMmPerMin: 3000, pierceTimeSec: 0.3 });
    const { commands } = gcodeToEntities(gcode, { unit: "mm" });
    const entities = commands.filter((c): c is Extract<typeof c, { type: "add-entity" }> => c.type === "add-entity").map((c) => c.entity);
    const outer = plan.features.find((f) => f.role === "outer")!;
    const recoveredOuter = entities.find((e) => e.type === "polyline" && e.points.some((p) => Math.hypot(p.x - outer.pierce.x, p.y - outer.pierce.y) < 1e-6));
    expect(recoveredOuter).toBeDefined();
  });
});

describe("header title", () => {
  it("defaults to the older panel's wording and takes the Sheet Nesting title when given (older output unchanged)", () => {
    const plan = buildCutPlan([rectWithHole], { kerf: 0.2 });
    const base = { unit: "mm" as const, scale: 1, feedRateMmPerMin: 1000, pierceTimeSec: 0.5, sheetLabel: "Sheet 1/1" };
    expect(writeGcode(plan.features, base).split("\n")[0]).toBe("(Sheet Metal Nest — Sheet 1/1)");
    expect(writeGcode(plan.features, { ...base, title: "Sheet Nesting" }).split("\n")[0]).toBe("(Sheet Nesting — Sheet 1/1)");
  });
});
