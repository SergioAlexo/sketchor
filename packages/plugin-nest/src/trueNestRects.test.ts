/**
 * Why this matters: rectangles are the commonest sheet-metal job, and the
 * NFP engine used to pack 60 of 100x60 onto FOUR 600x400 sheets (17 per
 * sheet) where a plain grid needs two (30 per sheet). Candidate positions
 * were NFP vertices only, which misses "slide along an NFP edge until the
 * sheet margin" spots - every row after the first was pushed up to the next
 * vertex. Pins a grid-quality result so the candidate set cannot regress.
 */
import { describe, expect, it } from "vitest";
import { nestTrueShape } from "./trueNest";
import type { Point } from "./types";

const rect = (w: number, h: number): Point[] => [{ x: 0, y: 0 }, { x: w, y: 0 }, { x: w, y: h }, { x: 0, y: h }];
const stock = (w: number, h: number) => [{ size: { name: "S", width: w, height: h }, qty: null }];

describe("true shape on rectangles", () => {
  it("60 rects 100x60 with spacing 3 / margin 5 on 600x400 need only 2 sheets", () => {
    const r = nestTrueShape([{ id: "R", name: "R", outer: rect(100, 60), holes: [], quantity: 60, rotation: { mode: "quarter" } }],
      stock(600, 400), { spacing: 3, edgeMargin: 5 });
    expect(r.unplaced).toEqual([]);
    expect(r.sheets.length).toBe(2);
  });

  it("a full grid row fits: 5 rects of 100 + gaps of 3 across 600 with margin 5 land on one row", () => {
    const r = nestTrueShape([{ id: "R", name: "R", outer: rect(100, 60), holes: [], quantity: 5, rotation: { mode: "locked" } }],
      stock(600, 400), { spacing: 3, edgeMargin: 5 });
    expect(r.sheets.length).toBe(1);
    expect(new Set(r.placed.map((p) => p.translation.y)).size).toBe(1);
  });
});
