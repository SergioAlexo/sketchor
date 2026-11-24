import { describe, expect, it } from "vitest";
import { applyRemnantsToStock, findRemnants, largestEmptyRect, matchingRemnants, parseRemnantLibrary, remnantStockRows, sameThickness, updateRemnantLibrary, type LibraryRemnant } from "./remnants";

/**
 * Remnants (N-52): an offcut offered to the next job must be genuinely clear
 * of every placed part, and the library must not count the same steel twice.
 */
const sq = (w: number, h: number) => [{ x: 0, y: 0 }, { x: w, y: 0 }, { x: w, y: h }, { x: 0, y: h }];
const placed = (x: number, y: number, sheet = 0) => ({ partId: "p", sheet, rotationDeg: 0, mirrored: false, translation: { x, y } });

describe("largestEmptyRect", () => {
  it("is the whole sheet when nothing is placed", () => {
    expect(largestEmptyRect(100, 50, [])).toEqual({ x0: 0, y0: 0, x1: 100, y1: 50 });
  });
  it("finds the bigger side strip", () => {
    expect(largestEmptyRect(1000, 500, [{ x0: 0, y0: 0, x1: 400, y1: 500 }])).toEqual({ x0: 400, y0: 0, x1: 1000, y1: 500 });
  });
  it("is null when fully covered, or for a degenerate sheet", () => {
    expect(largestEmptyRect(10, 10, [{ x0: 0, y0: 0, x1: 10, y1: 10 }])).toBeNull();
    expect(largestEmptyRect(0, 10, [])).toBeNull();
  });
  it("never overlaps a blocked box (randomised)", () => {
    let s = 7;
    const rnd = () => (s = (s * 16807) % 2147483647) / 2147483647;
    for (let t = 0; t < 40; t++) {
      const boxes = Array.from({ length: 12 }, () => {
        const x0 = rnd() * 900;
        const y0 = rnd() * 400;
        return { x0, y0, x1: x0 + rnd() * 150, y1: y0 + rnd() * 120 };
      });
      const r = largestEmptyRect(1000, 500, boxes);
      if (!r) continue;
      for (const b of boxes) expect(r.x1 <= b.x0 + 1e-6 || r.x0 >= b.x1 - 1e-6 || r.y1 <= b.y0 + 1e-6 || r.y0 >= b.y1 - 1e-6).toBe(true);
    }
  });
});

describe("findRemnants", () => {
  const sheets = [{ stockIndex: 0, width: 1000, height: 500 }];
  it("returns the clear block beside the parts", () => {
    const r = findRemnants({ sheets, placed: [placed(0, 0)] }, () => sq(300, 500));
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ x: 300, width: 700, height: 500 });
  });
  it("respects clearance and minimum size", () => {
    expect(findRemnants({ sheets, placed: [placed(0, 0)] }, () => sq(950, 500))).toEqual([]);
    const c = findRemnants({ sheets, placed: [placed(0, 0)] }, () => sq(300, 500), { clearance: 10 });
    expect(c[0]!.x).toBe(310);
  });
  it("uses the rotated footprint", () => {
    const r = findRemnants({ sheets, placed: [{ ...placed(0, 0), rotationDeg: 90 }] }, () => sq(300, 100));
    expect(r[0]).toBeDefined();
  });
  it("can keep several per sheet and ignores other sheets and unknown parts", () => {
    const r = findRemnants({ sheets, placed: [placed(400, 0), placed(0, 0, 1)] }, (id) => (id === "p" ? sq(100, 500) : undefined), { perSheet: 2 });
    expect(r.every((x) => x.sheet === 0)).toBe(true);
    expect(r.length).toBe(2);
  });
});

describe("applyRemnantsToStock", () => {
  const stock = [
    { size: { name: "A", width: 1000, height: 500 }, qty: 2 },
    { size: { name: "B", width: 100, height: 100 }, qty: null },
  ];
  it("consumes used sheets, drops empty rows, adds remnants", () => {
    const out = applyRemnantsToStock(stock, [{ width: 700, height: 500, material: "al", thickness: 3 }], [2, 5]);
    expect(out.map((r) => r.size.name)).toEqual(["B", "Remnant 700 x 500"]);
    expect(out[1]).toMatchObject({ qty: 1, material: "al", thickness: 3 });
    expect(out[0]!.qty).toBeNull();
  });
  it("merges identical remnants and does not mutate its input", () => {
    const once = applyRemnantsToStock([], [{ width: 700, height: 500 }]);
    const twice = applyRemnantsToStock(once, [{ width: 700.04, height: 500 }]);
    expect(twice).toHaveLength(1);
    expect(twice[0]!.qty).toBe(2);
    expect(once[0]!.qty).toBe(1);
    expect(stock[0]!.qty).toBe(2);
  });
});

describe("offcut library (N-52)", () => {
  const lib: LibraryRemnant[] = [
    { id: "r1", width: 600, height: 400, materialId: "cs", thickness: 3, qty: 2, from: "Job A", date: "2026-11-20" },
    { id: "r2", width: 1000, height: 500, materialId: "cs", thickness: 3.05, qty: 1 },
    { id: "r3", width: 800, height: 800, materialId: "ss", thickness: 3, qty: 1 },
    { id: "r4", width: 900, height: 900, materialId: "cs", thickness: 6, qty: 1 },
  ];

  it("matches material and thickness (gauge round-off allowed), largest first", () => {
    expect(matchingRemnants(lib, "cs", 3.0).map((r) => r.id)).toEqual(["r2", "r1"]);
    expect(sameThickness(3.175, 3.2)).toBe(true);
    expect(sameThickness(3, 4)).toBe(false);
  });

  it("turns offcuts into free stock rows that keep their count", () => {
    const rows = remnantStockRows(matchingRemnants(lib, "cs", 3));
    expect(rows.map((r) => [r.size.width, r.size.height, r.qty, r.cost])).toEqual([[1000, 500, 1, 0], [600, 400, 2, 0]]);
    expect(rows[1]!.size.name).toBe("Offcut 600 × 400 (Job A)");
  });

  it("takes out what a job used and adds its new offcuts, merging same-size ones", () => {
    let n = 10;
    const next = updateRemnantLibrary(lib, new Map([["r1", 1], ["r2", 1]]), [{ width: 600.3, height: 399.8, materialId: "cs", thickness: 3, }, { width: 250, height: 300, materialId: "cs", thickness: 3 }], { from: "Job B", date: "2026-11-24" }, () => `r${n++}`);
    expect(next.find((r) => r.id === "r1")!.qty).toBe(2); // 2 - 1 used + 1 new of the same size
    expect(next.some((r) => r.id === "r2")).toBe(false);
    expect(next.find((r) => r.id === "r10")).toMatchObject({ width: 250, height: 300, qty: 1, from: "Job B", date: "2026-11-24" });
    expect(lib.find((r) => r.id === "r1")!.qty).toBe(2); // pure
  });

  it("rejects malformed library entries and de-duplicates ids", () => {
    const parsed = parseRemnantLibrary([lib[0], { ...lib[0] }, { id: "x", width: -1, height: 1, materialId: "cs", thickness: 1, qty: 1 }, { id: "y", width: 1, height: 1, materialId: "C S!", thickness: 1, qty: 1 }, null]);
    expect(parsed.map((r) => r.id)).toEqual(["r1", "r1x"]);
    expect(parseRemnantLibrary("nope")).toEqual([]);
  });
});
