import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { nestTrueShape, type TrueNestPart } from "./trueNest";
import type { StockRow } from "./stock";
import type { Point } from "./types";

/**
 * N-50 made the true-shape candidate search incremental (kept per sheet and
 * orientation, updated as each part lands) instead of rebuilding it for every
 * placement. It must find exactly the same placements. These results were
 * recorded from the rebuild-every-time search just before the change, over
 * mixed shapes, quarter / 45-degree / mirrored rotations, both gravities,
 * multi-stock with purchase, parts in holes and a seeded order.
 */
const golden = JSON.parse(readFileSync(new URL("./trueNestGolden.json", import.meta.url), "utf8")) as Record<string, unknown>;

const rect = (w: number, h: number): Point[] => [{ x: 0, y: 0 }, { x: w, y: 0 }, { x: w, y: h }, { x: 0, y: h }];
const L = (): Point[] => [{ x: 0, y: 0 }, { x: 60, y: 0 }, { x: 60, y: 20 }, { x: 20, y: 20 }, { x: 20, y: 50 }, { x: 0, y: 50 }];
const circle = (r: number, n = 24): Point[] => Array.from({ length: n }, (_, i) => ({ x: r + r * Math.cos((2 * Math.PI * i) / n), y: r + r * Math.sin((2 * Math.PI * i) / n) }));
const tri = (): Point[] => [{ x: 0, y: 0 }, { x: 50, y: 0 }, { x: 10, y: 35 }];

const scenarios: Record<string, () => unknown> = {
  mixed_bl: () => nestTrueShape([
    { id: "L", name: "L", outer: L(), holes: [], quantity: 25, rotation: { mode: "quarter" } },
    { id: "c", name: "c", outer: circle(14), holes: [], quantity: 30, rotation: { mode: "none" } },
    { id: "t", name: "t", outer: tri(), holes: [], quantity: 20, rotation: { mode: "any", stepDeg: 45 } },
    { id: "r", name: "r", outer: rect(80, 30), holes: [], quantity: 15, rotation: { mode: "quarter" } },
  ] as TrueNestPart[], [{ size: { name: "s", width: 500, height: 400 }, qty: null }] as StockRow[], { spacing: 2, edgeMargin: 3 }),
  mixed_tr: () => nestTrueShape([
    { id: "L", name: "L", outer: L(), holes: [], quantity: 20, rotation: { mode: "quarter", mirror: true } },
    { id: "t", name: "t", outer: tri(), holes: [], quantity: 25, rotation: { mode: "any", stepDeg: 90 } },
  ] as TrueNestPart[], [{ size: { name: "s", width: 300, height: 300 }, qty: 2 }, { size: { name: "b", width: 400, height: 250 }, qty: null }] as StockRow[], { spacing: 1, edgeMargin: 2, gravity: "top-right" }),
  holes: () => nestTrueShape([
    { id: "frame", name: "frame", outer: rect(200, 200), holes: [[{ x: 20, y: 20 }, { x: 180, y: 20 }, { x: 180, y: 180 }, { x: 20, y: 180 }]], quantity: 3, rotation: { mode: "quarter" } },
    { id: "s", name: "s", outer: rect(30, 30), holes: [], quantity: 40, rotation: { mode: "quarter" }, allowInHoles: true },
  ] as TrueNestPart[], [{ size: { name: "s", width: 450, height: 450 }, qty: null }] as StockRow[], { spacing: 2 }),
  ordered: () => nestTrueShape([
    { id: "a", name: "a", outer: rect(40, 25), holes: [], quantity: 60, rotation: { mode: "quarter" } },
    { id: "b", name: "b", outer: L(), holes: [], quantity: 15, rotation: { mode: "quarter" } },
  ] as TrueNestPart[], [{ size: { name: "s", width: 400, height: 300 }, qty: null }] as StockRow[], { spacing: 1.5, order: 11 }),
};

describe("nestTrueShape — N-50 incremental search finds the same placements as the per-placement rebuild", () => {
  for (const [name, run] of Object.entries(scenarios)) {
    it(name, () => {
      expect(JSON.parse(JSON.stringify(run()))).toEqual(golden[name]);
    });
  }
});
