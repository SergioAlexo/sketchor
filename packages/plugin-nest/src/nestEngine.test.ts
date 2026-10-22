/**
 * Both nesting engines behind one interface (RN-06). Every case runs against
 * `raster` and `true-shape` alike, so a feature (clamp strip, purchase size,
 * cancel, spacing) cannot land for one engine only. Placements are
 * re-materialised through `placementTransform` and re-checked, not trusted.
 */
import { describe, expect, it } from "vitest";
import { bounds, rotate, segmentDistance, translate } from "./geometry";
import { engineFor, NEST_ENGINES, TRUE_SHAPE_MAX_INSTANCES, type NestRequest } from "./nestEngine";
import { jobParts, parseNestJob, type NestJob } from "./nestJob";
import { placementTransform } from "./trueNest";
import type { Point } from "./types";

const rect = (w: number, h: number): Point[] => [{ x: 0, y: 0 }, { x: w, y: 0 }, { x: w, y: h }, { x: 0, y: h }];
const lshape = (s: number, t: number): Point[] => [{ x: 0, y: 0 }, { x: s, y: 0 }, { x: s, y: t }, { x: t, y: t }, { x: t, y: s }, { x: 0, y: s }];
const mm = (v: number) => ({ v: String(v), u: "mm" as const });

function request(over: Record<string, unknown> = {}, qty = { a: 6, b: 4 }): NestRequest {
  const job: NestJob = parseNestJob({
    sheetSource: "stock",
    stock: [{ size: { name: "S", width: 500, height: 300 }, qty: null }],
    params: { kerf: mm(1), web: mm(2), margin: mm(5), clamp: mm(0), bedW: mm(0), bedH: mm(0) },
    parts: [
      { key: "a", qty: qty.a, rotation: "r90" },
      { key: "b", qty: qty.b, rotation: "r90" },
    ],
    accuracy: "fast",
    timeMs: 0,
    ...over,
  });
  const geometry = new Map([
    ["a", { name: "A", outer: rect(120, 50), holes: [] }],
    ["b", { name: "B", outer: lshape(90, 30), holes: [] }],
  ]);
  return { job, parts: jobParts(job, geometry) };
}

function dist(a: Point[], b: Point[]): number {
  let m = Infinity;
  for (let i = 0; i < a.length; i++) for (let j = 0; j < b.length; j++) m = Math.min(m, segmentDistance(a[i]!, a[(i + 1) % a.length]!, b[j]!, b[(j + 1) % b.length]!));
  return m;
}

describe.each(Object.values(NEST_ENGINES))("engine $id", (engine) => {
  it("conserves counts, keeps spacing and margin", async () => {
    const req = request();
    const r = await engine.run(req);
    expect(r.placed.length + r.unplaced.reduce((n, u) => n + u.count, 0)).toBe(10);
    expect(r.unplaced).toEqual([]);
    const byKey = new Map(req.parts.map((p) => [p.id, p]));
    r.sheets.forEach((sh, si) => {
      const polys = r.placed.filter((p) => p.sheet === si).map((pl) => {
        const part = byKey.get(pl.partId)!;
        const t = placementTransform(part.outer, pl);
        return translate(rotate(part.outer, t.rotationDeg), t.translation.x, t.translation.y);
      });
      for (const poly of polys) {
        const b = bounds(poly);
        expect(b.minX).toBeGreaterThanOrEqual(5 - 1e-6);
        expect(b.minY).toBeGreaterThanOrEqual(5 - 1e-6);
        expect(b.maxX).toBeLessThanOrEqual(sh.width - 5 + 1e-6);
        expect(b.maxY).toBeLessThanOrEqual(sh.height - 5 + 1e-6);
      }
      for (let i = 0; i < polys.length; i++) for (let j = i + 1; j < polys.length; j++) expect(dist(polys[i]!, polys[j]!)).toBeGreaterThanOrEqual(3 - 1e-6);
    });
  });

  it("keeps parts out of the clamp strip", async () => {
    const req = request({ params: { kerf: mm(1), web: mm(2), margin: mm(5), clamp: mm(40), bedW: mm(0), bedH: mm(0) } });
    const r = await engine.run(req);
    const byKey = new Map(req.parts.map((p) => [p.id, p]));
    r.placed.forEach((pl) => {
      const sh = r.sheets[pl.sheet]!;
      const part = byKey.get(pl.partId)!;
      const t = placementTransform(part.outer, pl);
      const b = bounds(translate(rotate(part.outer, t.rotationDeg), t.translation.x, t.translation.y));
      if (sh.width > sh.height) expect(b.minY).toBeGreaterThanOrEqual(5 + 40 - 1e-6);
      else expect(b.maxX).toBeLessThanOrEqual(sh.width - 5 - 40 + 1e-6);
    });
    expect(r.unplaced).toEqual([]);
  });

  it("uses inventory first, then the purchase size, and flags purchased sheets", async () => {
    const req = request(
      { stock: [{ size: { name: "Small", width: 200, height: 150 }, qty: 1 }], buyExtra: true, sheet: { w: 500 / 25.4, h: 300 / 25.4 } },
      { a: 12, b: 0 },
    );
    const r = await engine.run(req);
    expect(r.unplaced).toEqual([]);
    expect(r.purchased.some(Boolean)).toBe(true);
    expect(r.purchased[0]).toBe(false);
    expect(r.sheets.filter((s) => s.stockIndex === 0)).toHaveLength(1);
    r.sheets.forEach((s, i) => {
      expect(r.stock[s.stockIndex]).toBeDefined();
      expect(r.purchased[i]).toBe(s.stockIndex === 1);
    });
  });

  it("cancel resolves with a result instead of rejecting", async () => {
    const req = request({ timeMs: 30_000, searchLevel: "thorough" });
    let n = 0;
    const r = await engine.run(req, { isCancelled: () => ++n > 2 });
    expect(r.placed.length).toBeGreaterThan(0);
  });

  it("returns every unplaceable piece as unplaced, without throwing", async () => {
    const req = request({ stock: [{ size: { name: "Tiny", width: 20, height: 20 }, qty: null }] });
    const r = await engine.run(req);
    expect(r.placed).toEqual([]);
    expect(r.unplaced.reduce((n, u) => n + u.count, 0)).toBe(10);
  });
});

describe("supports()", () => {
  it("raster flags mirror, gravity and min hole area", () => {
    const req = request({ gravity: "top-right", minHoleArea: 10, parts: [{ key: "a", qty: 1, mirror: true }] });
    const opts = NEST_ENGINES.raster.supports(req).map((u) => u.option);
    expect(opts).toEqual(expect.arrayContaining(["mirror", "gravity", "minHoleArea"]));
    expect(NEST_ENGINES.raster.supports(request())).toEqual([]);
  });
  it("true-shape reports the instance cap up front", () => {
    const req = request({}, { a: TRUE_SHAPE_MAX_INSTANCES, b: 5 });
    const u = NEST_ENGINES["true-shape"].supports(req);
    expect(u.map((x) => x.option)).toContain("quantity");
    expect(NEST_ENGINES["true-shape"].supports(request())).toEqual([]);
  });
  it("true-shape flags the 0/180 flip mode", () => {
    expect(NEST_ENGINES["true-shape"].supports(request({ parts: [{ key: "a", qty: 1, rotation: "flip" }] })).map((u) => u.option)).toContain("flip");
  });
  it("engineFor falls back to raster", () => {
    expect(engineFor("nope").id).toBe("raster");
    expect(engineFor("true-shape").id).toBe("true-shape");
  });
});
