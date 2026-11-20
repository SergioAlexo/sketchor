import { describe, expect, it } from "vitest";
import type { Entity } from "@sketchor/core";
import { classifyForView, regionWorthDrawing, SPECK_PX, viewWorldRect } from "./cull";

/**
 * Culling decides what a frame never draws. Too eager and geometry vanishes
 * from a drawing that is plainly on screen (the worst kind of bug in a CAD
 * view: it looks like data loss); too timid and a big drawing redraws every
 * entity in full on every pan and zoom frame, which is what made zooming out
 * on a large assembly crawl to a stop.
 */

const view = { scale: 2, ox: 100, oy: 300 }; // 2 px per mm, world origin at screen (100, 300)
const rect = viewWorldRect(view, 800, 600, 0);
const circle = (x: number, y: number, r: number): Entity => ({ id: "c", type: "circle", center: { x, y }, radius: r });

describe("viewWorldRect", () => {
  it("is the world area the canvas shows, grown by the pixel margin", () => {
    expect(rect).toEqual({ minX: -50, maxX: 350, minY: -150, maxY: 150 });
    const padded = viewWorldRect(view, 800, 600, 40);
    expect(padded.minX).toBe(-70);
    expect(padded.maxY).toBe(170);
  });
});

describe("classifyForView", () => {
  it("draws what is on screen, even when it only just overlaps an edge", () => {
    expect(classifyForView(circle(100, 0, 20), rect, view.scale).vis).toBe("visible");
    expect(classifyForView(circle(-60, 0, 15), rect, view.scale).vis).toBe("visible"); // centre off, rim on
  });

  it("skips what is wholly off screen", () => {
    expect(classifyForView(circle(-80, 0, 5), rect, view.scale).vis).toBe("offscreen");
    expect(classifyForView(circle(100, 400, 5), rect, view.scale).vis).toBe("offscreen");
  });

  it("never skips an infinite construction line, whose defining points can sit anywhere", () => {
    const xline: Entity = { id: "x", type: "line", a: { x: 9000, y: 9000 }, b: { x: 9001, y: 9000 }, infinite: true };
    expect(classifyForView(xline, rect, view.scale).vis).toBe("visible");
  });

  it("turns something smaller than a speck into one, at its centre", () => {
    const tiny = circle(10, 20, (SPECK_PX * 0.4) / view.scale);
    expect(classifyForView(tiny, rect, view.scale)).toEqual({ vis: "speck", at: { x: 10, y: 20 } });
    expect(classifyForView(circle(10, 20, SPECK_PX / view.scale), rect, view.scale).vis).toBe("visible");
  });
});

describe("regionWorthDrawing", () => {
  const square = (x: number, s: number) => [{ x, y: 0 }, { x: x + s, y: 0 }, { x: x + s, y: s }, { x, y: s }];
  it("fills a visible tint, and skips one off screen or too small to see", () => {
    expect(regionWorthDrawing(square(0, 10), rect, view.scale)).toBe(true);
    expect(regionWorthDrawing(square(1000, 10), rect, view.scale)).toBe(false);
    expect(regionWorthDrawing(square(0, 0.5), rect, view.scale)).toBe(false);
  });
});
