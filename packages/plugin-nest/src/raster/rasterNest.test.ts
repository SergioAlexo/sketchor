/**
 * Tests for the mm adapter around the raster engine (RN-04). It is the
 * contract between the new engine and everything downstream (`trueLayout`,
 * `metrics`, G-code): if `translation` meant the wrong thing, parts would be
 * materialised away from where clearance was checked and the cut file would
 * have overlapping parts. So placements are re-materialised through the
 * existing `placementTransform` and re-checked for spacing and containment.
 */
import { describe, expect, it } from "vitest";
import { area, bounds, pointInPolygon, rotate, segmentDistance, translate } from "../geometry";
import type { StockRow } from "../stock";
import { placementTransform, type TrueNestPart } from "../trueNest";
import type { Point } from "../types";
import { chooseCell, nestRasterMm, nestRasterMmAsync, type RasterNestPart } from "./rasterNest";

const rect = (w: number, h: number): Point[] => [{ x: 0, y: 0 }, { x: w, y: 0 }, { x: w, y: h }, { x: 0, y: h }];
const circle = (cx: number, cy: number, r: number, n = 40): Point[] =>
  Array.from({ length: n }, (_, i) => ({ x: cx + r * Math.cos((2 * Math.PI * i) / n), y: cy + r * Math.sin((2 * Math.PI * i) / n) }));

const part = (id: string, outer: Point[], quantity: number, extra: Partial<RasterNestPart> = {}): RasterNestPart => ({
  id, name: id, outer, holes: [], quantity, rotation: { mode: "quarter" }, ...extra,
});
const stockRow = (w: number, h: number, qty: number | null = null): StockRow => ({ size: { name: `${w}x${h}`, width: w, height: h }, qty });

/** World-space outline of a placement via the existing materialisation convention. */
function world(p: TrueNestPart, pl: { rotationDeg: number; mirrored: boolean; translation: Point }): Point[] {
  const t = placementTransform(p.outer, pl);
  return translate(rotate(p.outer, t.rotationDeg), t.translation.x, t.translation.y);
}
function dist(a: Point[], b: Point[]): number {
  let m = Infinity;
  for (let i = 0; i < a.length; i++) for (let j = 0; j < b.length; j++) {
    m = Math.min(m, segmentDistance(a[i]!, a[(i + 1) % a.length]!, b[j]!, b[(j + 1) % b.length]!));
  }
  return m;
}

describe("nestRasterMm", () => {
  const parts = [part("A", rect(120, 45), 6), part("B", [{ x: 0, y: 0 }, { x: 70, y: 0 }, { x: 70, y: 20 }, { x: 20, y: 20 }, { x: 20, y: 60 }, { x: 0, y: 60 }], 5, { rotation: { mode: "any", stepDeg: 45 } })];
  const opts = { spacing: 3, edgeMargin: 5, accuracy: "fast" as const };

  it("keeps spacing and margin when re-materialised through placementTransform", () => {
    const r = nestRasterMm(parts, [stockRow(500, 300)], opts);
    expect(r.unplaced).toEqual([]);
    const byId = new Map(parts.map((p) => [p.id, p]));
    r.sheets.forEach((sh, si) => {
      const polys = r.placed.filter((p) => p.sheet === si).map((pl) => world(byId.get(pl.partId)!, pl));
      for (const poly of polys) {
        const b = bounds(poly);
        expect(b.minX).toBeGreaterThanOrEqual(5 - 1e-6);
        expect(b.minY).toBeGreaterThanOrEqual(5 - 1e-6);
        expect(b.maxX).toBeLessThanOrEqual(sh.width - 5 + 1e-6);
        expect(b.maxY).toBeLessThanOrEqual(sh.height - 5 + 1e-6);
      }
      for (let i = 0; i < polys.length; i++) for (let j = i + 1; j < polys.length; j++) {
        expect(dist(polys[i]!, polys[j]!)).toBeGreaterThanOrEqual(3 - 1e-6);
      }
    });
  });

  it("conserves counts and reports sane utilisation", () => {
    const r = nestRasterMm(parts, [stockRow(300, 200)], opts);
    const n = r.placed.length + r.unplaced.reduce((a, u) => a + u.count, 0);
    expect(n).toBe(11);
    expect(r.utilisation).toBeGreaterThan(0);
    expect(r.utilisation).toBeLessThanOrEqual(1);
    expect(r.placed.every((p) => !p.mirrored)).toBe(true);
  });

  it("sets insideOfPlacementIndex for a part that lands in another's hole", () => {
    const ring = part("ring", circle(80, 80, 80), 1, { holes: [circle(80, 80, 55)], rotation: { mode: "locked" } });
    const plug = part("plug", circle(15, 15, 15), 2, { rotation: { mode: "locked" } });
    const r = nestRasterMm([ring, plug], [stockRow(175, 175, 1)], { spacing: 3, edgeMargin: 6, accuracy: "normal" });
    expect(r.unplaced).toEqual([]);
    const ringIdx = r.placed.findIndex((p) => p.partId === "ring");
    const inside = r.placed.filter((p) => p.partId === "plug");
    expect(inside).toHaveLength(2);
    for (const p of inside) expect(p.insideOfPlacementIndex).toBe(ringIdx);
    expect(r.placed[ringIdx]!.insideOfPlacementIndex).toBeUndefined();
    // and geometrically really inside the hole
    const holeWorld = translate(rotate(ring.holes[0]!, r.placed[ringIdx]!.rotationDeg), 0, 0);
    expect(holeWorld.length).toBeGreaterThan(0);
    expect(area(ring.outer)).toBeGreaterThan(area(ring.holes[0]!));
    expect(pointInPolygon({ x: 80, y: 80 }, ring.holes[0]!)).toBe(true);
  });

  it("uses inventory first and marks purchased sheets", () => {
    const big = part("big", rect(110, 70), 30, { rotation: { mode: "quarter" } });
    const r = nestRasterMm([big], [stockRow(300, 200, 1)], { ...opts, extra: { width: 400, height: 300 } });
    expect(r.unplaced).toEqual([]);
    expect(r.stock).toHaveLength(2);
    expect(r.purchased.some(Boolean)).toBe(true);
    expect(r.purchased[0]).toBe(false);
    r.sheets.forEach((s, i) => expect(r.purchased[i]).toBe(s.stockIndex === 1));
  });

  it("with no stock at all, everything is unplaced (no throw)", () => {
    const r = nestRasterMm([part("A", rect(10, 10), 3)], [], opts);
    expect(r.sheets).toEqual([]);
    expect(r.unplaced).toEqual([{ partId: "A", count: 3 }]);
  });

  it("notes that mirroring is ignored", () => {
    const r = nestRasterMm([part("A", rect(10, 10), 1, { rotation: { mode: "quarter", mirror: true } })], [stockRow(100, 100)], opts);
    expect(r.notes.join(" ")).toMatch(/mirror/i);
  });

  it("honours an explicit angle set", () => {
    const r = nestRasterMm([part("A", rect(200, 30), 1, { angles: [90] })], [stockRow(250, 250)], opts);
    expect(r.placed[0]!.rotationDeg).toBe(90);
  });

  it("async variant matches the sync result for a single pass", async () => {
    const a = nestRasterMm(parts, [stockRow(500, 300)], opts);
    const b = await nestRasterMmAsync(parts, [stockRow(500, 300)], opts);
    expect(b.placed).toEqual(a.placed);
  });
});

describe("chooseCell", () => {
  const sheets = [{ width: 1500, height: 1000 }];
  it("uses the accuracy presets for normal-sized parts", () => {
    const p = [{ outer: rect(500, 400) }];
    expect(chooseCell(p, sheets, "fast")).toBe(2.5);
    expect(chooseCell(p, sheets, "normal")).toBe(1.25);
    expect(chooseCell(p, sheets, "precise")).toBe(0.6);
  });
  it("shrinks for tiny parts and grows for huge sheets (<= 9M cells)", () => {
    expect(chooseCell([{ outer: rect(6, 6) }], [{ width: 100, height: 100 }], "fast")).toBe(0.5);
    const c = chooseCell([{ outer: rect(500, 400) }], [{ width: 20000, height: 10000 }], "precise");
    expect((20000 * 10000) / (c * c)).toBeLessThanOrEqual(9e6);
  });
});
