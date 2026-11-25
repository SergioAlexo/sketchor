import { describe, expect, it } from "vitest";
import "../../core/src/kinds/builtin";
import type { Entity } from "../../core/src/entities";
import { buildSnapIndex, layerList, measurePoints, nearestSnap } from "./measure2d";

const line = (id: string, ax: number, ay: number, bx: number, by: number, extra: Partial<Entity> = {}): Entity =>
  ({ id, type: "line", a: { x: ax, y: ay }, b: { x: bx, y: by }, ...extra }) as Entity;

describe("layerList", () => {
  it("lists used layers with counts and their usual colour, 0 first, numbers in order", () => {
    const es: Entity[] = [
      line("a", 0, 0, 1, 0, { layer: "L10" }),
      line("b", 0, 0, 1, 0, { layer: "L2", color: "#ff0000" }),
      line("c", 0, 0, 1, 0, { layer: "L2", color: "#ff0000" }),
      line("d", 0, 0, 1, 0, { layer: "L2", color: "#00ff00" }),
      line("e", 0, 0, 1, 0),
    ];
    expect(layerList(es)).toEqual([
      { name: "0", count: 1, color: null },
      { name: "L2", count: 3, color: "#ff0000" },
      { name: "L10", count: 1, color: null },
    ]);
  });
  it("is empty for no entities", () => {
    expect(layerList([])).toEqual([]);
  });
});

describe("snapping", () => {
  const es: Entity[] = [
    line("l", 0, 0, 100, 0, { layer: "A" }),
    { id: "c", type: "circle", center: { x: 50, y: 50 }, radius: 10, layer: "B" } as Entity,
  ];
  const idx = buildSnapIndex(es);

  it("finds ends, midpoints, centres and quadrants", () => {
    expect(nearestSnap(idx, { x: 1, y: 1 }, 3)).toEqual({ point: { x: 0, y: 0 }, kind: "endpoint" });
    expect(nearestSnap(idx, { x: 49, y: -1 }, 3)).toEqual({ point: { x: 50, y: 0 }, kind: "midpoint" });
    expect(nearestSnap(idx, { x: 51, y: 51 }, 3)).toEqual({ point: { x: 50, y: 50 }, kind: "center" });
    expect(nearestSnap(idx, { x: 60.5, y: 50 }, 3)?.kind).toBe("quadrant");
  });
  it("takes the nearest within reach and nothing beyond it", () => {
    expect(nearestSnap(idx, { x: 99, y: 0 }, 5)?.point).toEqual({ x: 100, y: 0 });
    expect(nearestSnap(idx, { x: 25, y: 25 }, 5)).toBeNull();
  });
  it("skips hidden layers", () => {
    expect(nearestSnap(idx, { x: 51, y: 51 }, 3, new Set(["B"]))).toBeNull();
    expect(nearestSnap(idx, { x: 1, y: 0 }, 3, new Set(["B"]))?.point).toEqual({ x: 0, y: 0 });
  });
  it("prefers an endpoint over a midpoint at the same spot", () => {
    const z = buildSnapIndex([line("z", 5, 5, 5, 5)]);
    expect(nearestSnap(z, { x: 5, y: 5 }, 1)?.kind).toBe("endpoint");
  });
  it("copes with an empty drawing", () => {
    expect(nearestSnap(buildSnapIndex([]), { x: 0, y: 0 }, 10)).toBeNull();
  });
});

describe("measurePoints", () => {
  it("reads distance, deltas and angle counter-clockwise from +X", () => {
    const m = measurePoints({ x: 0, y: 0 }, { x: 30, y: 40 });
    expect(m.rows).toEqual([
      { label: "Distance", value: "50.00 mm" },
      { label: "ΔX", value: "30.00 mm" },
      { label: "ΔY", value: "40.00 mm" },
      { label: "Angle", value: "53.13°" },
    ]);
  });
  it("keeps the angle in 0–360 and the signs of the deltas", () => {
    const m = measurePoints({ x: 10, y: 10 }, { x: 10, y: 0 });
    expect(m.rows[2].value).toBe("-10.00 mm");
    expect(m.rows[3].value).toBe("270.00°");
    expect(measurePoints({ x: 0, y: 0 }, { x: 5, y: -1e-9 }).rows[3].value).toBe("0.00°");
  });
});
