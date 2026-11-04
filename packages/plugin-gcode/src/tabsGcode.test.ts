import { describe, expect, it } from "vitest";
import type { Entity } from "@sketchor/core";
import { buildCutPlan, type GcodePlacement } from "./toolpath";
import { GENERIC_LASER_PROFILE, writeGcode } from "./write";
import { gcodeToEntities } from "./parse";

/**
 * N-53 wiring: tabs split each closed contour into cut runs with the beam off
 * and a rapid across every tab. The round trip through the G-code reader is
 * the check that a tab gap really is uncut and the cut length adds up.
 */

function rect(w: number, h: number): Entity[] {
  const p = [{ x: 0, y: 0 }, { x: w, y: 0 }, { x: w, y: h }, { x: 0, y: h }];
  return [0, 1, 2, 3].map((i) => ({ id: `o${i}`, type: "line" as const, a: p[i], b: p[(i + 1) % 4] }));
}
const disc = (r: number): Entity => ({ id: "c", type: "circle", center: { x: 50, y: 50 }, radius: r });
const part = (outerEntities: Entity[]): GcodePlacement => ({ id: "p", number: 1, outerEntities, holeEntities: [] });
const WRITE = { unit: "mm" as const, scale: 1, feedRateMmPerMin: 3000, pierceTimeSec: 0.3 };
const noLead = { leadInLength: 0 };

interface Poly { pts: { x: number; y: number }[]; bulges: number[] }

function cutPaths(gcode: string): Poly[] {
  const out: Poly[] = [];
  for (const c of gcodeToEntities(gcode, { unit: "mm" }).commands) {
    if (c.type !== "add-entity" || c.entity.type !== "polyline") continue;
    const e = c.entity as unknown as { points: { x: number; y: number }[]; bulges?: number[] };
    out.push({ pts: e.points, bulges: e.bulges ?? [] });
  }
  return out;
}

function length(paths: Poly[]): number {
  let total = 0;
  for (const p of paths) {
    for (let i = 0; i + 1 < p.pts.length; i++) {
      const chord = Math.hypot(p.pts[i + 1].x - p.pts[i].x, p.pts[i + 1].y - p.pts[i].y);
      const b = Math.abs(p.bulges[i] ?? 0);
      if (b < 1e-12) total += chord;
      else {
        const theta = 4 * Math.atan(b);
        total += (chord / (2 * Math.sin(theta / 2))) * theta;
      }
    }
  }
  return total;
}

/** Each path's end to the next path's start must be a straight jump of `gap` mm (no cut move across it). The closing pair may instead meet (0) when no tab covers the loop start. */
function expectGaps(paths: Poly[], gap: number) {
  for (let i = 0; i < paths.length; i++) {
    const a = paths[i].pts[paths[i].pts.length - 1];
    const b = paths[(i + 1) % paths.length].pts[0];
    const d = Math.hypot(a.x - b.x, a.y - b.y);
    if (i === paths.length - 1) expect([0, gap].some((x) => Math.abs(d - x) < 1e-3)).toBe(true);
    else expect(d).toBeCloseTo(gap, 3);
  }
}

describe("N-53: tabs in the cut plan and G-code", () => {
  it("is byte-identical with tabs off (omitted, undefined, count 0)", () => {
    const base = writeGcode(buildCutPlan([part(rect(100, 60))]).features, WRITE);
    expect(writeGcode(buildCutPlan([part(rect(100, 60))], { tabs: { count: 0, width: 5 } }).features, WRITE)).toBe(base);
    expect(writeGcode(buildCutPlan([part(rect(100, 60))], { tabs: undefined }).features, WRITE)).toBe(base);
  });

  it("rectangle: cut length = perimeter - tab widths, gaps are uncut, beam off + rapid + on across each tab", () => {
    const plan = buildCutPlan([part(rect(100, 60))], { ...noLead, tabs: { count: 4, width: 5 } });
    expect(plan.warnings).toEqual([]);
    const gcode = writeGcode(plan.features, WRITE);
    const paths = cutPaths(gcode);
    expect(paths.length).toBe(5); // no tab covers the loop start, so the first and last runs meet there
    expect(length(paths)).toBeCloseTo(320 - 4 * 5, 3);
    expectGaps(paths, 5);
    const lines = gcode.split("\n");
    const tabRapids = lines.filter((l, i) => l.startsWith("G0 ") && lines[i - 1] === GENERIC_LASER_PROFILE.laserOffCode && lines[i + 1] === GENERIC_LASER_PROFILE.laserOnCode && lines[i + 2].startsWith("G4"));
    expect(tabRapids.length).toBe(4);
  });

  it("full circle: arcs add up to the circumference minus the tabs", () => {
    const plan = buildCutPlan([part([disc(20)])], { ...noLead, tabs: { count: 3, width: 4 } });
    const paths = cutPaths(writeGcode(plan.features, WRITE));
    expect(paths.length).toBe(4);
    expectGaps(paths, 2 * 20 * Math.sin(4 / 40)); // chord of a 4 mm arc
    expect(length(paths)).toBeCloseTo(2 * Math.PI * 20 - 3 * 4, 2);
  });

  it("contour too small for tabs: warns and cuts the plain closed loop", () => {
    const plain = writeGcode(buildCutPlan([part(rect(6, 6))]).features, WRITE);
    const plan = buildCutPlan([part(rect(6, 6))], { tabs: { count: 2, width: 20 } });
    expect(plan.warnings.length).toBeGreaterThan(0);
    expect(writeGcode(plan.features, WRITE)).toBe(plain);
  });

  it("tab wrapping over the loop start: lead-in moves to the first cut point, length and gaps still hold", () => {
    // offset 0 centres the single tab on the loop start (the lead-in point), so it wraps.
    const plan = buildCutPlan([part(rect(100, 60))], { ...noLead, tabs: { count: 1, width: 6, offset: 0 } });
    const f = plan.features[0];
    expect(f.runs!.length).toBe(1);
    const paths = cutPaths(writeGcode(plan.features, WRITE));
    expect(paths.length).toBe(1);
    expect(length(paths)).toBeCloseTo(320 - 6, 3);
    expectGaps(paths, 6);
  });

  it("lead-in stays on the first run only", () => {
    const plan = buildCutPlan([part(rect(100, 60))], { leadInLength: 3, tabs: { count: 2, width: 5 } });
    const paths = cutPaths(writeGcode(plan.features, WRITE));
    expect(paths.length).toBe(3);
    expect(length(paths)).toBeCloseTo(320 - 10 + 3, 3);
  });
});
