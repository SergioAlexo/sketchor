import { describe, expect, it } from "vitest";
import { ForbiddenIndex, localFrame, nestTrueShape, TRUE_NEST_MAX_INSTANCES, placementTransform, type TrueNestPart } from "./trueNest";
import type { StockRow } from "./stock";
import { bounds, normalize, polygonsClash, rotate, translate, insideSheet, pointInPolygon } from "./geometry";
import type { Point } from "./types";

/**
 * N-15's invariants: no overlap and everything inside its sheet hold no
 * matter what the search placed, locked rotation is actually respected,
 * stock quantity limits are enforced, an oversized part is reported rather
 * than looping forever, and (N-12) a part flagged allowInHoles actually
 * lands inside another part's hole rather than being reported unplaced.
 */

function rect(w: number, h: number): Point[] {
  return [
    { x: 0, y: 0 },
    { x: w, y: 0 },
    { x: w, y: h },
    { x: 0, y: h },
  ];
}

function lShape(): Point[] {
  return [
    { x: 0, y: 0 },
    { x: 10, y: 0 },
    { x: 10, y: 5 },
    { x: 5, y: 5 },
    { x: 5, y: 10 },
    { x: 0, y: 10 },
  ];
}

/** Rebuilds the world-space polygon a placement describes, mirroring trueNest.ts's own localFrame(). */
function materialize(outer: Point[], placement: { rotationDeg: number; mirrored: boolean; translation: Point }): Point[] {
  const mirroredPoly = placement.mirrored ? outer.map((p) => ({ x: -p.x, y: p.y })) : outer;
  const local = normalize(rotate(mirroredPoly, placement.rotationDeg));
  return translate(local, placement.translation.x, placement.translation.y);
}

/** Small deterministic PRNG so the randomized invariant test is reproducible. */
function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe("nestTrueShape", () => {
  it("places non-overlapping shapes entirely inside their sheet (randomised rectangles + an L-shape)", () => {
    const rand = mulberry32(42);
    const parts: TrueNestPart[] = [];
    for (let i = 0; i < 8; i++) {
      const w = 10 + Math.floor(rand() * 30);
      const h = 10 + Math.floor(rand() * 30);
      parts.push({
        id: `rect-${i}`,
        name: `Rect ${i}`,
        outer: rect(w, h),
        holes: [],
        quantity: 1 + Math.floor(rand() * 2),
        rotation: { mode: "quarter" },
      });
    }
    parts.push({ id: "L", name: "L", outer: lShape(), holes: [], quantity: 2, rotation: { mode: "quarter" } });

    const stock: StockRow[] = [{ size: { name: "sheet", width: 300, height: 300 }, qty: 6 }];
    const result = nestTrueShape(parts, stock, { spacing: 1 });

    expect(result.placed.length).toBeGreaterThan(0);

    const partById = new Map(parts.map((p) => [p.id, p]));
    const bySheet = new Map<number, { partId: string; polygon: Point[] }[]>();
    for (const placement of result.placed) {
      const part = partById.get(placement.partId)!;
      const polygon = materialize(part.outer, placement);
      const sheet = result.sheets[placement.sheet];
      expect(insideSheet(polygon, sheet.width, sheet.height, 0)).toBe(true);
      const list = bySheet.get(placement.sheet) ?? [];
      list.push({ partId: placement.partId, polygon });
      bySheet.set(placement.sheet, list);
    }
    for (const items of bySheet.values()) {
      for (let i = 0; i < items.length; i++) {
        for (let j = i + 1; j < items.length; j++) {
          expect(polygonsClash(items[i].polygon, items[j].polygon, 0)).toBe(false);
        }
      }
    }
  });

  it("never rotates a locked part", () => {
    const parts: TrueNestPart[] = [
      { id: "p", name: "p", outer: rect(20, 8), holes: [], quantity: 6, rotation: { mode: "locked" } },
    ];
    const stock: StockRow[] = [{ size: { name: "sheet", width: 100, height: 100 }, qty: 3 }];
    const result = nestTrueShape(parts, stock);
    for (const placement of result.placed) {
      expect(placement.rotationDeg).toBe(0);
      expect(placement.mirrored).toBe(false);
    }
  });

  it.each([
    ["bottom-left", { x: 0, y: 0 }],
    ["bottom-right", { x: 80, y: 0 }],
    ["top-left", { x: 0, y: 80 }],
    ["top-right", { x: 80, y: 80 }],
  ] as const)("gravity %s puts the first part in that sheet corner", (gravity, expected) => {
    const parts: TrueNestPart[] = [
      { id: "p", name: "p", outer: rect(20, 20), holes: [], quantity: 1, rotation: { mode: "locked" } },
    ];
    const stock: StockRow[] = [{ size: { name: "sheet", width: 100, height: 100 }, qty: 1 }];
    const result = nestTrueShape(parts, stock, { gravity });
    expect(result.placed).toHaveLength(1);
    expect(result.placed[0].translation).toEqual(expected);
  });

  it("stops opening sheets once stock quantity is exhausted, reporting the rest unplaced", () => {
    const parts: TrueNestPart[] = [
      { id: "p", name: "p", outer: rect(80, 80), holes: [], quantity: 5, rotation: { mode: "locked" } },
    ];
    // Only 2 sheets of 100x100 exist — at most 2 of the 5 parts (one per sheet) can fit.
    const stock: StockRow[] = [{ size: { name: "sheet", width: 100, height: 100 }, qty: 2 }];
    const result = nestTrueShape(parts, stock);
    expect(result.sheets.length).toBeLessThanOrEqual(2);
    expect(result.placed.length).toBeLessThanOrEqual(2);
    const unplacedCount = result.unplaced.find((u) => u.partId === "p")?.count ?? 0;
    expect(result.placed.length + unplacedCount).toBe(5);
    expect(unplacedCount).toBeGreaterThan(0);
  });

  it("reports a part bigger than every stock row as unplaced instead of throwing", () => {
    const parts: TrueNestPart[] = [
      { id: "huge", name: "huge", outer: rect(500, 500), holes: [], quantity: 1, rotation: { mode: "locked" } },
    ];
    const stock: StockRow[] = [{ size: { name: "sheet", width: 100, height: 100 }, qty: null }];
    expect(() => nestTrueShape(parts, stock)).not.toThrow();
    const result = nestTrueShape(parts, stock);
    expect(result.placed).toHaveLength(0);
    expect(result.unplaced).toEqual([{ partId: "huge", count: 1 }]);
  });

  it("reports empty results for no parts without opening any sheet", () => {
    const stock: StockRow[] = [{ size: { name: "sheet", width: 100, height: 100 }, qty: 1 }];
    const result = nestTrueShape([], stock);
    expect(result.sheets).toHaveLength(0);
    expect(result.placed).toHaveLength(0);
    expect(result.utilisation).toBe(0);
  });

  it("placementTransform, applied to the original un-normalized outline, reproduces the exact placed polygon", () => {
    // Drawn far from the origin — the point of this test is that a part's
    // own original-drawing position must not leak into where it lands.
    const original = [
      { x: 500, y: 700 },
      { x: 540, y: 700 },
      { x: 540, y: 730 },
      { x: 500, y: 730 },
    ];
    const parts: TrueNestPart[] = [
      { id: "p", name: "p", outer: original, holes: [], quantity: 1, rotation: { mode: "quarter" } },
    ];
    const stock: StockRow[] = [{ size: { name: "sheet", width: 200, height: 200 }, qty: 1 }];
    const result = nestTrueShape(parts, stock);
    expect(result.placed).toHaveLength(1);
    const placement = result.placed[0];

    // What trueNest.ts itself placed (its internal local-frame + translation).
    const expectedPlaced = translate(
      localFrame(original, placement.rotationDeg, placement.mirrored),
      placement.translation.x,
      placement.translation.y,
    );

    // The same result, reconstructed via placementTransform applied to the
    // ORIGINAL (un-normalized) outline — the path materializeInstance takes.
    const transform = placementTransform(original, placement);
    const mirroredOriginal = transform.mirrored ? original.map((p) => ({ x: -p.x, y: p.y })) : original;
    const reconstructed = translate(rotate(mirroredOriginal, transform.rotationDeg), transform.translation.x, transform.translation.y);

    for (let i = 0; i < expectedPlaced.length; i++) {
      expect(reconstructed[i].x).toBeCloseTo(expectedPlaced[i].x, 6);
      expect(reconstructed[i].y).toBeCloseTo(expectedPlaced[i].y, 6);
    }
    // And it's actually on the sheet, not still off at (500, 700).
    const box = bounds(reconstructed);
    expect(box.minX).toBeGreaterThanOrEqual(-1e-6);
    expect(box.minY).toBeGreaterThanOrEqual(-1e-6);
  });
});

describe("nestTrueShape — N-14 spacing/candidate density (regression)", () => {
  it("packs far more than 4 identical parts onto one big sheet once spacing is set, not just the sheet's own corners", () => {
    // Before the N-14 fix, every NFP-vertex candidate touched its neighbour
    // at zero clearance and was rejected the instant spacing > 0, silently
    // capping every sheet at its own 4 corner candidates — a severe density
    // bug invisible to overlap/inside-sheet checks alone, since 4 correctly
    // non-overlapping parts still "pass" those. This pins actual packing
    // density, not just correctness of whatever got placed.
    const parts: TrueNestPart[] = [{ id: "p", name: "p", outer: rect(40, 30), holes: [], quantity: 20, rotation: { mode: "quarter" } }];
    const stock: StockRow[] = [{ size: { name: "sheet", width: 3000, height: 3000 }, qty: null }];
    const result = nestTrueShape(parts, stock, { spacing: 2, edgeMargin: 5 });
    expect(result.unplaced).toEqual([]);
    expect(result.placed).toHaveLength(20);
    expect(result.sheets.length).toBeLessThan(3); // was 5 sheets (4 per sheet) before the fix
  });

  it("still keeps the requested spacing between every pair once packing is dense", () => {
    const parts: TrueNestPart[] = [{ id: "p", name: "p", outer: rect(40, 30), holes: [], quantity: 20, rotation: { mode: "quarter" } }];
    const stock: StockRow[] = [{ size: { name: "sheet", width: 3000, height: 3000 }, qty: null }];
    const spacing = 2;
    const result = nestTrueShape(parts, stock, { spacing, edgeMargin: 5 });
    const bySheet = new Map<number, Point[][]>();
    for (const p of result.placed) {
      const poly = materialize(rect(40, 30), p);
      const list = bySheet.get(p.sheet) ?? [];
      list.push(poly);
      bySheet.set(p.sheet, list);
    }
    for (const polys of bySheet.values()) {
      for (let i = 0; i < polys.length; i++) {
        for (let j = i + 1; j < polys.length; j++) {
          // polygonsClash's third argument is the minimum gap two polygons
          // must keep — asking it to enforce slightly *more* than the
          // requested spacing must report no clash, proving the real gap is
          // at least that much (a fresh check, not the engine's own).
          expect(polygonsClash(polys[i], polys[j], spacing - 0.05)).toBe(false);
        }
      }
    }
  });
});

describe("nestTrueShape — N-14 instance ordering", () => {
  const parts: TrueNestPart[] = [
    { id: "big", name: "big", outer: rect(50, 50), holes: [], quantity: 3, rotation: { mode: "locked" } },
    { id: "small", name: "small", outer: rect(10, 10), holes: [], quantity: 3, rotation: { mode: "locked" } },
  ];
  const stock: StockRow[] = [{ size: { name: "sheet", width: 200, height: 200 }, qty: 4 }];

  it.each(["area-desc", "area-asc", "bbox-desc", 1, 42] as const)("produces a valid, non-overlapping result for order=%s", (order) => {
    const result = nestTrueShape(parts, stock, { order });
    const partById = new Map(parts.map((p) => [p.id, p]));
    const bySheet = new Map<number, Point[][]>();
    for (const p of result.placed) {
      const list = bySheet.get(p.sheet) ?? [];
      list.push(materialize(partById.get(p.partId)!.outer, p));
      bySheet.set(p.sheet, list);
    }
    for (const polys of bySheet.values()) {
      for (let i = 0; i < polys.length; i++) {
        for (let j = i + 1; j < polys.length; j++) expect(polygonsClash(polys[i], polys[j], 0)).toBe(false);
      }
    }
  });

  it("a numeric seed is deterministic — the same seed always gives the same placement", () => {
    const a = nestTrueShape(parts, stock, { order: 7 });
    const b = nestTrueShape(parts, stock, { order: 7 });
    expect(a.placed).toEqual(b.placed);
  });
});

describe("nestTrueShape — N-14 instance cap", () => {
  it("perf + cap: an adversarial single-sheet fill places exactly the cap, reports the rest, and finishes in bound", () => {
    // Everything fits on the one sheet, so every placement competes with
    // every piece already placed: the worst case for the candidate search.
    const extra = 50;
    const parts: TrueNestPart[] = [{ id: "p", name: "p", outer: rect(40, 30), holes: [], quantity: TRUE_NEST_MAX_INSTANCES + extra, rotation: { mode: "quarter" } }];
    // 5 m square holds ~18000 of these, so all of the cap competes on one sheet.
    const stock: StockRow[] = [{ size: { name: "sheet", width: 5000, height: 5000 }, qty: null }];
    const t0 = Date.now();
    const result = nestTrueShape(parts, stock, { spacing: 2, edgeMargin: 5 });
    const elapsed = Date.now() - t0;
    expect(result.placed).toHaveLength(TRUE_NEST_MAX_INSTANCES);
    expect(result.sheets).toHaveLength(1);
    expect(result.unplaced.find((u) => u.partId === "p")?.count).toBe(extra);
    // N-50: ~0.4 s at 10000 on a dev machine (the per-placement rebuild took
    // ~5 s for 2000 and would need ~2 min here; the scan before ForbiddenIndex
    // took 25-33 s for just 600). The bound leaves room for slow CI and still
    // fails loudly if the fill regresses toward quadratic.
    expect(elapsed).toBeLessThan(10000);
  }, 60000);
});

describe("ForbiddenIndex", () => {
  // The grid must answer exactly like testing every loop: a wrong "free"
  // lets two parts overlap on the sheet, a wrong "blocked" wastes material.
  it("agrees with a scan of every loop", () => {
    let seed = 1;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    const loops: { x: number; y: number }[][] = [];
    for (let i = 0; i < 80; i++) {
      const cx = rnd() * 500;
      const cy = rnd() * 400;
      const r = 5 + rnd() * 60;
      const n = 3 + Math.floor(rnd() * 6);
      loops.push(Array.from({ length: n }, (_, k) => {
        const a = (k / n) * Math.PI * 2;
        const rr = r * (0.5 + rnd() * 0.5);
        return { x: cx + Math.cos(a) * rr, y: cy + Math.sin(a) * rr };
      }));
    }
    loops.push([{ x: 0, y: 0 }, { x: 1, y: 1 }]); // degenerate: ignored by both
    const index = new ForbiddenIndex(loops);
    const points = loops.flat().concat(Array.from({ length: 3000 }, () => ({ x: rnd() * 600 - 50, y: rnd() * 500 - 50 })));
    for (const p of points) {
      expect(index.blocks(p)).toBe(loops.some((l) => l.length >= 3 && pointInPolygon(p, l)));
    }
    expect(new ForbiddenIndex([]).blocks({ x: 0, y: 0 })).toBe(false);
  });
});

describe("nestTrueShape — N-12 part-in-hole", () => {
  // A 90x90 part leaves only a 10mm-wide rim on a 100x100 sheet — too
  // narrow for a 20x20 square in any orientation, so the small part below
  // can only ever be placed successfully by actually landing in the hole.
  const bigOuter = rect(90, 90);
  const hole = [
    { x: 30, y: 30 },
    { x: 60, y: 30 },
    { x: 60, y: 60 },
    { x: 30, y: 60 },
  ]; // 30x30, area 900

  function scenario(smallAllowInHoles: boolean): { parts: TrueNestPart[]; stock: StockRow[] } {
    return {
      parts: [
        { id: "big", name: "big", outer: bigOuter, holes: [hole], quantity: 1, rotation: { mode: "locked" } },
        { id: "small", name: "small", outer: rect(20, 20), holes: [], quantity: 1, rotation: { mode: "locked" }, allowInHoles: smallAllowInHoles },
      ],
      stock: [{ size: { name: "sheet", width: 100, height: 100 }, qty: 1 }] as StockRow[],
    };
  }

  it("places an allowInHoles part inside another part's hole instead of reporting it unplaced", () => {
    const { parts, stock } = scenario(true);
    const result = nestTrueShape(parts, stock);

    expect(result.unplaced).toEqual([]);
    expect(result.placed).toHaveLength(2);
    expect(result.sheets).toHaveLength(1); // proof it didn't fall back to a second sheet

    const small = result.placed.find((p) => p.partId === "small")!;
    expect(small).toBeDefined();
    expect(small.sheet).toBe(0);
    expect(small.translation.x).toBeGreaterThanOrEqual(30 - 1e-6);
    expect(small.translation.x + 20).toBeLessThanOrEqual(60 + 1e-6);
    expect(small.translation.y).toBeGreaterThanOrEqual(30 - 1e-6);
    expect(small.translation.y + 20).toBeLessThanOrEqual(60 + 1e-6);
  });

  it("N-40: tags a hole-filling placement with the index of the part whose hole it's in", () => {
    const { parts, stock } = scenario(true);
    const result = nestTrueShape(parts, stock);

    const bigIndex = result.placed.findIndex((p) => p.partId === "big");
    const small = result.placed.find((p) => p.partId === "small")!;
    expect(result.placed[bigIndex].insideOfPlacementIndex).toBeUndefined();
    expect(small.insideOfPlacementIndex).toBe(bigIndex);
  });

  it("never places a part inside a hole unless allowInHoles is set", () => {
    const { parts, stock } = scenario(false);
    const result = nestTrueShape(parts, stock);
    const smallUnplaced = result.unplaced.find((u) => u.partId === "small")?.count ?? 0;
    expect(smallUnplaced).toBe(1);
  });

  it("minHoleArea excludes a hole below the threshold from being offered", () => {
    const { parts, stock } = scenario(true);
    const result = nestTrueShape(parts, stock, { minHoleArea: 1000 }); // hole area is 900
    const smallUnplaced = result.unplaced.find((u) => u.partId === "small")?.count ?? 0;
    expect(smallUnplaced).toBe(1);
  });

  it("places several allowInHoles instances sharing one hole without overlapping each other", () => {
    const bigger = [
      { x: 20, y: 20 },
      { x: 70, y: 20 },
      { x: 70, y: 70 },
      { x: 20, y: 70 },
    ]; // 50x50 hole
    const parts: TrueNestPart[] = [
      { id: "big", name: "big", outer: bigOuter, holes: [bigger], quantity: 1, rotation: { mode: "locked" } },
      { id: "small", name: "small", outer: rect(20, 20), holes: [], quantity: 4, rotation: { mode: "locked" }, allowInHoles: true },
    ];
    const stock: StockRow[] = [{ size: { name: "sheet", width: 100, height: 100 }, qty: 1 }];
    const result = nestTrueShape(parts, stock, { spacing: 1 });

    const smalls = result.placed.filter((p) => p.partId === "small");
    expect(smalls).toHaveLength(4); // all 4 fit: a 2x2 grid of 20x20 + 1mm spacing comfortably fits a 50x50 hole
    for (let i = 0; i < smalls.length; i++) {
      for (let j = i + 1; j < smalls.length; j++) {
        const a = translate(rect(20, 20), smalls[i].translation.x, smalls[i].translation.y);
        const b = translate(rect(20, 20), smalls[j].translation.x, smalls[j].translation.y);
        expect(polygonsClash(a, b, 0)).toBe(false);
      }
    }
  });

  it("a hole-filling part's corners stay within the hole, never spilling into the surrounding part's solid material", () => {
    const { parts, stock } = scenario(true);
    const result = nestTrueShape(parts, stock);
    const small = result.placed.find((p) => p.partId === "small")!;
    const smallPolygon = translate(rect(20, 20), small.translation.x, small.translation.y);
    for (const p of smallPolygon) {
      expect(p.x).toBeGreaterThanOrEqual(30 - 1e-6);
      expect(p.x).toBeLessThanOrEqual(60 + 1e-6);
      expect(p.y).toBeGreaterThanOrEqual(30 - 1e-6);
      expect(p.y).toBeLessThanOrEqual(60 + 1e-6);
    }
  });
});

describe("nestTrueShape — N-55 priority tiers", () => {
  it("places the high-priority part first, so it wins the only sheet even though it is smaller", () => {
    const stock: StockRow[] = [{ size: { name: "s", width: 200, height: 200 }, qty: 1 }];
    const big: TrueNestPart = { id: "big", name: "big", outer: rect(180, 180), holes: [], quantity: 1, rotation: { mode: "quarter" } };
    const urgent: TrueNestPart = { id: "urgent", name: "urgent", outer: rect(150, 150), holes: [], quantity: 1, rotation: { mode: "quarter" }, rank: -1 };
    expect(nestTrueShape([big, urgent], stock, { spacing: 1 }).placed.map((p) => p.partId)).toEqual(["urgent"]);
    expect(nestTrueShape([big, { ...urgent, rank: undefined }], stock, { spacing: 1 }).placed.map((p) => p.partId)).toEqual(["big"]);
  });
});
