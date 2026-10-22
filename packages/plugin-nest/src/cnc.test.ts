import { describe, expect, it } from "vitest";
import { cncInfo, cncInfoForPart, cncWarnings, inscribedR } from "./cnc";
import type { Point } from "./types";

/**
 * RN-50: a router bit cannot cut a hole narrower than itself or a sharp inside
 * corner, and nothing on the machine says so. These check the geometry facts
 * as properties (rotation / winding independence, the circle's own radius)
 * rather than literals, plus the warning thresholds.
 */
const rect = (w: number, h: number, ox = 0, oy = 0): Point[] => [
  { x: ox, y: oy },
  { x: ox + w, y: oy },
  { x: ox + w, y: oy + h },
  { x: ox, y: oy + h },
];
const circle = (r: number, n = 96): Point[] => Array.from({ length: n }, (_, i) => ({ x: r * Math.cos((2 * Math.PI * i) / n), y: r * Math.sin((2 * Math.PI * i) / n) }));
const lShape: Point[] = [
  { x: 0, y: 0 },
  { x: 20, y: 0 },
  { x: 20, y: 10 },
  { x: 10, y: 10 },
  { x: 10, y: 20 },
  { x: 0, y: 20 },
];

describe("inscribedR", () => {
  it("a rectangle's is half its short side", () => {
    expect(inscribedR(rect(40, 10))).toBeCloseTo(5, 1);
  });
  it("a circle's is its radius", () => {
    expect(inscribedR(circle(7))).toBeCloseTo(7, 1);
  });
  it("never exceeds the true value, and ignores winding", () => {
    const cw = [...rect(30, 12)].reverse();
    expect(inscribedR(cw)).toBeLessThanOrEqual(6 + 1e-9);
    expect(inscribedR(cw)).toBeCloseTo(inscribedR(rect(30, 12)), 6);
  });
  it("is 0 for degenerate or non-finite input", () => {
    expect(inscribedR([])).toBe(0);
    expect(inscribedR([{ x: 0, y: 0 }, { x: 1, y: 1 }])).toBe(0);
    expect(inscribedR([{ x: 0, y: 0 }, { x: NaN, y: 1 }, { x: 1, y: 0 }])).toBe(0);
    expect(inscribedR([{ x: 0, y: 0 }, { x: 5, y: 0 }, { x: 10, y: 0 }])).toBe(0);
  });
});

describe("cncInfo", () => {
  it("a plain rectangle has no unreachable corners", () => {
    expect(cncInfo([{ points: rect(50, 20), hole: false }])).toEqual({ holes: [], corners: 0 });
  });
  it("an L-shaped outline has exactly one inside corner, whichever way it is wound", () => {
    expect(cncInfo([{ points: lShape, hole: false }]).corners).toBe(1);
    expect(cncInfo([{ points: [...lShape].reverse(), hole: false }]).corners).toBe(1);
  });
  it("a square hole's four corners are unreachable; its diameter is its side", () => {
    const info = cncInfo([
      { points: rect(50, 50), hole: false },
      { points: rect(10, 10, 20, 20), hole: true },
    ]);
    expect(info.corners).toBe(4);
    expect(info.holes).toHaveLength(1);
    expect(info.holes[0]).toBeCloseTo(10, 0);
  });
  it("a round hole's arc facets do not count as corners", () => {
    const info = cncInfo([{ points: circle(5), hole: true }]);
    expect(info.corners).toBe(0);
    expect(info.holes[0]).toBeCloseTo(10, 0);
  });
  it("never throws on empty or tiny contours", () => {
    expect(cncInfo([])).toEqual({ holes: [], corners: 0 });
    expect(cncInfo([{ points: [{ x: 0, y: 0 }], hole: true }])).toEqual({ holes: [], corners: 0 });
  });
  it("works from an extracted part's shape", () => {
    expect(cncInfoForPart({ outer: rect(50, 50), holes: [rect(10, 10, 20, 20)] }).corners).toBe(4);
  });
});

describe("cncWarnings", () => {
  const info = { holes: [3, 8, 20], corners: 2 };
  it("flags holes smaller than the bit and the corner radius", () => {
    expect(cncWarnings(info, 6)).toEqual([
      { kind: "small-holes", count: 1, smallestDiameter: 3, bitDiameter: 6 },
      { kind: "inside-corners", count: 2, cornerRadius: 3 },
    ]);
  });
  it("a hole exactly the bit's size is fine", () => {
    expect(cncWarnings({ holes: [6], corners: 0 }, 6)).toEqual([]);
  });
  it("no bit, no warnings", () => {
    expect(cncWarnings(info, 0)).toEqual([]);
    expect(cncWarnings(info, NaN)).toEqual([]);
  });
});
