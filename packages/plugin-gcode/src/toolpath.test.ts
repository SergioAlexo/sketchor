import { describe, expect, it } from "vitest";
import type { Entity } from "@sketchor/core";
import { buildCutPlan, type GcodePlacement } from "./toolpath";

/**
 * A cut plan drives an actual laser: cutting a part's outer profile before
 * its holes lets the part fall free before the holes are done, and cutting
 * a container's hole before a part nested inside it lets that whole disc
 * come loose (and shift) before the nested part is finished. Both are real
 * scrapped-part failure modes, not cosmetic — these pin the ordering rules
 * that prevent them, plus the kerf/lead-in geometry every feature carries.
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

function bboxOf(pts: { x: number; y: number }[]) {
  const xs = pts.map((p) => p.x);
  const ys = pts.map((p) => p.y);
  return { minX: Math.min(...xs), maxX: Math.max(...xs), minY: Math.min(...ys), maxY: Math.max(...ys) };
}

function loopPoints(loop: ReturnType<typeof buildCutPlan>["features"][number]["loop"]) {
  const pts: { x: number; y: number }[] = [];
  for (const c of loop) {
    if (c.kind === "segment") pts.push(c.a, c.b);
    else pts.push({ x: c.center.x - c.radius, y: c.center.y }, { x: c.center.x + c.radius, y: c.center.y }, { x: c.center.x, y: c.center.y - c.radius }, { x: c.center.x, y: c.center.y + c.radius });
  }
  return pts;
}

describe("buildCutPlan — ordering", () => {
  it("cuts a part's holes before its outer profile", () => {
    const placement: GcodePlacement = {
      id: "p0",
      number: 1,
      outerEntities: rectLines("o", 0, 0, 100, 100),
      holeEntities: [circle("h", 50, 50, 10)],
    };
    const plan = buildCutPlan([placement]);
    expect(plan.warnings).toEqual([]);
    expect(plan.features.map((f) => f.role)).toEqual(["hole", "outer"]);
  });

  it("assembles a boundary drawn as separate line/arc entities via endpoint matching, not just single closed entities", () => {
    // The outer above is 4 separate lines; if they hadn't chained into one
    // closed loop, buildCutPlan would report a warning and skip the part.
    const placement: GcodePlacement = {
      id: "p0",
      number: 1,
      outerEntities: rectLines("o", 0, 0, 40, 20),
      holeEntities: [],
    };
    const plan = buildCutPlan([placement]);
    expect(plan.warnings).toEqual([]);
    expect(plan.features).toHaveLength(1);
    expect(plan.features[0].role).toBe("outer");
  });

  it("cuts a part nested in another part's hole (N-12) completely before that hole is opened", () => {
    const container: GcodePlacement = {
      id: "big",
      number: 1,
      outerEntities: rectLines("o", 0, 0, 90, 90),
      holeEntities: [circle("h", 45, 45, 15)],
    };
    const nested: GcodePlacement = {
      id: "small",
      number: 2,
      outerEntities: rectLines("s", 40, 40, 10, 10),
      holeEntities: [],
      insideOfId: "big",
    };
    const plan = buildCutPlan([container, nested]);
    const nestedOuterIdx = plan.features.findIndex((f) => f.placementId === "small" && f.role === "outer");
    const containerHoleIdx = plan.features.findIndex((f) => f.placementId === "big" && f.role === "hole");
    expect(nestedOuterIdx).toBeGreaterThanOrEqual(0);
    expect(containerHoleIdx).toBeGreaterThanOrEqual(0);
    expect(nestedOuterIdx).toBeLessThan(containerHoleIdx);
  });

  it("visits parts nearest-neighbour from the given start point rather than in input order", () => {
    const far: GcodePlacement = { id: "far", number: 1, outerEntities: rectLines("f", 500, 500, 10, 10), holeEntities: [] };
    const near: GcodePlacement = { id: "near", number: 2, outerEntities: rectLines("n", 0, 0, 10, 10), holeEntities: [] };
    const plan = buildCutPlan([far, near], { start: { x: 0, y: 0 } });
    expect(plan.features[0].placementId).toBe("near");
    expect(plan.features[1].placementId).toBe("far");
  });

  it("reports and skips a part whose outer boundary never closes, instead of throwing", () => {
    const openChain: GcodePlacement = {
      id: "broken",
      number: 1,
      outerEntities: [line("a", { x: 0, y: 0 }, { x: 10, y: 0 }), line("b", { x: 20, y: 0 }, { x: 20, y: 10 })], // gap between them
      holeEntities: [],
    };
    const plan = buildCutPlan([openChain]);
    expect(plan.features).toEqual([]);
    expect(plan.warnings.length).toBeGreaterThan(0);
  });
});

describe("buildCutPlan — kerf compensation", () => {
  it("expands the outer profile outward and shrinks a hole inward by half the kerf", () => {
    const placement: GcodePlacement = {
      id: "p0",
      number: 1,
      outerEntities: rectLines("o", 0, 0, 100, 100),
      holeEntities: [circle("h", 50, 50, 10)],
    };
    const uncompensated = buildCutPlan([placement], { kerf: 0 });
    const compensated = buildCutPlan([placement], { kerf: 2 }); // kerf/2 = 1mm each way

    const outerBefore = bboxOf(loopPoints(uncompensated.features.find((f) => f.role === "outer")!.loop));
    const outerAfter = bboxOf(loopPoints(compensated.features.find((f) => f.role === "outer")!.loop));
    expect(outerAfter.minX).toBeCloseTo(outerBefore.minX - 1, 3);
    expect(outerAfter.maxX).toBeCloseTo(outerBefore.maxX + 1, 3);
    expect(outerAfter.minY).toBeCloseTo(outerBefore.minY - 1, 3);
    expect(outerAfter.maxY).toBeCloseTo(outerBefore.maxY + 1, 3);

    const holeBefore = bboxOf(loopPoints(uncompensated.features.find((f) => f.role === "hole")!.loop));
    const holeAfter = bboxOf(loopPoints(compensated.features.find((f) => f.role === "hole")!.loop));
    expect(holeAfter.maxX - holeAfter.minX).toBeCloseTo(holeBefore.maxX - holeBefore.minX - 2, 3);
  });
});

describe("buildCutPlan — lead-in", () => {
  it("pierces off the true edge and cuts a lead-in onto it, on the longest straight edge", () => {
    // A long, thin rectangle: the pierce/lead-in should sit on one of the
    // two long edges (y = 0 or y = 10), not a short end.
    const placement: GcodePlacement = {
      id: "p0",
      number: 1,
      outerEntities: rectLines("o", 0, 0, 100, 10),
      holeEntities: [],
    };
    const plan = buildCutPlan([placement], { leadInLength: 5 });
    const feature = plan.features[0];
    expect(feature.leadIn.y === 0 || feature.leadIn.y === 10).toBe(true);
    // The pierce point is off the part, further from the sheet's own
    // interior than the point it leads into.
    const pierceOutside = feature.pierce.y < 0 || feature.pierce.y > 10;
    expect(pierceOutside).toBe(true);
    expect(Math.hypot(feature.pierce.x - feature.leadIn.x, feature.pierce.y - feature.leadIn.y)).toBeCloseTo(5, 6);
  });

  it("pierces into the open interior (not into surrounding material) for a circular hole with no straight edge", () => {
    const placement: GcodePlacement = {
      id: "p0",
      number: 1,
      outerEntities: rectLines("o", 0, 0, 100, 100),
      holeEntities: [circle("h", 50, 50, 10)],
    };
    const plan = buildCutPlan([placement], { leadInLength: 2 });
    const hole = plan.features.find((f) => f.role === "hole")!;
    const distFromCenter = Math.hypot(hole.pierce.x - 50, hole.pierce.y - 50);
    // Pierces inward (toward the hole's own centre), i.e. within the circle,
    // never out into the surrounding solid part.
    expect(distFromCenter).toBeLessThan(10);
  });
});

describe("buildCutPlan — C-08 ellipses", () => {
  it("cuts an elliptical hole as a closed loop of few lines and arcs", () => {
    const hole: Entity = { id: "h", type: "ellipse", center: { x: 50, y: 50 }, majorAxis: { x: 10, y: 0 }, ratio: 0.5, start: 0, end: Math.PI * 2 };
    const plan = buildCutPlan([{ id: "p", number: 1, outerEntities: rectLines("o", 0, 0, 100, 100), holeEntities: [hole] }]);
    expect(plan.warnings).toEqual([]);
    const holeFeature = plan.features.find((f) => f.role === "hole")!;
    expect(holeFeature.loop.length).toBeGreaterThan(2);
    expect(holeFeature.loop.length).toBeLessThan(150);
  });
});

describe("buildCutPlan — arc lead-ins", () => {
  const plate: GcodePlacement = { id: "p0", number: 1, outerEntities: rectLines("o", 0, 0, 100, 60), holeEntities: [circle("h", 50, 30, 10)] };
  const arcPoints = (f: ReturnType<typeof buildCutPlan>["features"][number]) => {
    const c = f.leadInArc!.center;
    const r = Math.hypot(f.pierce.x - c.x, f.pierce.y - c.y);
    const a0 = Math.atan2(f.pierce.y - c.y, f.pierce.x - c.x), a1 = Math.atan2(f.leadIn.y - c.y, f.leadIn.x - c.x);
    let sweep = f.leadInArc!.ccw ? a1 - a0 : a0 - a1;
    while (sweep <= 0) sweep += 2 * Math.PI;
    return { r, sweep, pts: Array.from({ length: 9 }, (_, i) => { const a = a0 + (f.leadInArc!.ccw ? 1 : -1) * sweep * (i / 8); return { x: c.x + r * Math.cos(a), y: c.y + r * Math.sin(a) }; }) };
  };

  it("is off by default: the straight lead-in output is unchanged", () => {
    expect(buildCutPlan([plate], { leadInLength: 3 }).features.every((f) => f.leadInArc === undefined)).toBe(true);
  });

  it("outer profile: a quarter circle of the lead-in radius, wholly in scrap, tangent to the edge where it joins", () => {
    const outer = buildCutPlan([plate], { leadInLength: 4, leadIn: "arc" }).features.find((f) => f.role === "outer")!;
    expect(outer.leadInArc).toBeDefined();
    const { r, sweep, pts } = arcPoints(outer);
    expect(r).toBeCloseTo(4, 9);
    expect(sweep).toBeCloseTo(Math.PI / 2, 9);
    // every point but the join is outside the part
    for (const p of pts.slice(0, -1)) expect(p.x < 0 || p.x > 100 || p.y < 0 || p.y > 60).toBe(true);
    // tangent at the join: the radius there is perpendicular to the edge's direction of cut
    const c = outer.leadInArc!.center;
    const first = outer.loop[0]!;
    const end = first.kind === "segment" ? first.b : first.center;
    const dir = { x: end.x - outer.leadIn.x, y: end.y - outer.leadIn.y };
    expect(Math.abs((c.x - outer.leadIn.x) * dir.x + (c.y - outer.leadIn.y) * dir.y)).toBeLessThan(1e-6);
  });

  it("a hole with room gets its arc inside the hole; a hole too small for it keeps the straight lead-in", () => {
    const hole = buildCutPlan([plate], { leadInLength: 3, leadIn: "arc" }).features.find((f) => f.role === "hole")!;
    expect(hole.leadInArc).toBeDefined();
    for (const p of arcPoints(hole).pts.slice(0, -1)) expect(Math.hypot(p.x - 50, p.y - 30)).toBeLessThan(10);
    const tiny = buildCutPlan([{ ...plate, holeEntities: [circle("t", 50, 30, 2)] }], { leadInLength: 3, leadIn: "arc" }).features.find((f) => f.role === "hole")!;
    expect(tiny.leadInArc).toBeUndefined();
  });

  it("with tabs the lead-in goes back to a straight one (re-aimed and checked against the tabs)", () => {
    const plan = buildCutPlan([plate], { leadInLength: 3, leadIn: "arc", tabs: { count: 3, width: 4 } });
    const outer = plan.features.find((f) => f.role === "outer")!;
    expect(outer.runs).toBeDefined();
    expect(outer.leadInArc).toBeUndefined();
    expect(Math.hypot(outer.pierce.x - outer.leadIn.x, outer.pierce.y - outer.leadIn.y)).toBeCloseTo(3, 6);
  });
});
