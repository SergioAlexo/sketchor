/**
 * "One DXF = one part": a file with a bracket and its gusset must nest as one
 * unit, keep every piece's own geometry for the cut, and never let another
 * part be dropped into space one of its own pieces occupies.
 */
import { describe, expect, it } from "vitest";
import { convexHull, mergeIntoOnePart } from "./compoundPart";
import type { ExtractedPart } from "./partExtraction";

const sq = (x: number, y: number, s: number) => [{ x, y }, { x: x + s, y }, { x: x + s, y: y + s }, { x, y: y + s }];
const part = (id: string, outer: { x: number; y: number }[], holes: { x: number; y: number }[][] = []): ExtractedPart => ({
  id,
  name: id,
  outer,
  holes,
  sourceIds: [id, ...holes.map((_, i) => `${id}h${i}`)],
  outerSourceIds: [id],
  holeSourceIds: holes.map((_, i) => [`${id}h${i}`]),
  cutLength: 10,
  holeCount: holes.length,
  pierceCount: 1 + holes.length,
});

describe("mergeIntoOnePart", () => {
  it("keeps a single part unchanged apart from the name", () => {
    const p = part("a", sq(0, 0, 10));
    expect(mergeIntoOnePart([p], "file.dxf")).toEqual({ ...p, name: "file.dxf" });
    expect(mergeIntoOnePart([], "x")).toBeNull();
  });

  it("merges separate pieces into one part with the hull as its outline", () => {
    const m = mergeIntoOnePart([part("a", sq(0, 0, 10)), part("b", sq(50, 0, 10), [sq(52, 2, 2)])], "kit.dxf")!;
    expect(m.pieces).toHaveLength(2);
    expect(m.outerSourceIds).toEqual(["a", "b"]);
    expect(m.cutLength).toBe(20);
    expect(m.pierceCount).toBe(3);
    expect(m.netArea).toBe(100 + 100 - 4);
    const xs = m.outer.map((p) => p.x);
    expect(Math.min(...xs)).toBe(0);
    expect(Math.max(...xs)).toBe(60);
  });

  it("drops a hole that has another piece inside it", () => {
    const ring = part("ring", sq(0, 0, 100), [sq(10, 10, 80)]);
    const inner = part("disc", sq(40, 40, 10));
    const m = mergeIntoOnePart([ring, inner], "nested.dxf")!;
    expect(m.holes).toEqual([]);
    expect(m.pieces![0]!.holeSourceIds).toEqual([["ringh0"]]);
  });

  it("hull is convex and contains every point", () => {
    const pts = [...sq(0, 0, 10), { x: 5, y: 5 }, { x: 20, y: 3 }];
    const h = convexHull(pts);
    expect(h.some((p) => p.x === 5 && p.y === 5)).toBe(false);
    expect(h).toContainEqual({ x: 20, y: 3 });
  });
});
