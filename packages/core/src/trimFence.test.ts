import { describe, expect, it } from "vitest";
import type { ArcEntity, Entity, LineEntity } from "./entities";
import { fenceCrossings, trimByFence } from "./trimFence";

/**
 * Fence trim cleans a drawing in one drag (the AutoCAD quick-trim gesture):
 * wrong behaviour is trimming against already-trimmed geometry (a neighbour
 * suddenly cut somewhere else), removing pieces the stroke never touched, or
 * leaving the entity alone when the stroke crosses two pieces of it.
 */

const ln = (id: string, ax: number, ay: number, bx: number, by: number): LineEntity => ({ id, type: "line", a: { x: ax, y: ay }, b: { x: bx, y: by } });
const xs = (es: Entity[]) =>
  es
    .filter((e): e is LineEntity => e.type === "line")
    .map((e) => [e.a.x, e.b.x].sort((a, b) => a - b))
    .sort((a, b) => a[0] - b[0]);

describe("trimByFence", () => {
  const drawing = [ln("h0", 0, 0, 30, 0), ln("h2", 0, 2, 30, 2), ln("v1", 10, -5, 10, 8), ln("v2", 20, -5, 20, 8)];

  it("a stroke across one line removes just the piece between its cutters", () => {
    const r = trimByFence(drawing, [{ x: 15, y: -1 }, { x: 15, y: 1 }])!;
    expect(r.remove).toEqual(["h0"]);
    expect(xs(r.add)).toEqual([
      [0, 10],
      [20, 30],
    ]);
  });

  it("a stroke across two lines trims both, each against the original cutters", () => {
    const r = trimByFence(drawing, [{ x: 15, y: -1 }, { x: 15, y: 3 }])!;
    expect(r.remove.sort()).toEqual(["h0", "h2"]);
    expect(xs(r.add)).toEqual([
      [0, 10],
      [0, 10],
      [20, 30],
      [20, 30],
    ]);
  });

  it("a zig-zag stroke across two pieces of the same entity trims both pieces", () => {
    const r = trimByFence(drawing, [{ x: 5, y: -1 }, { x: 5, y: 1 }, { x: 25, y: 1 }, { x: 25, y: -1 }])!;
    expect(r.remove).toContain("h0");
    // Pieces under the stroke at x=5 and x=25 go; only the middle remains.
    const h0 = r.add.filter((e) => e.id.startsWith("h0#"));
    expect(xs(h0)).toEqual([[10, 20]]);
  });

  it("a stroke that crosses nothing, or nothing cut, trims nothing", () => {
    expect(trimByFence(drawing, [{ x: 40, y: 0 }, { x: 40, y: 3 }])).toBeNull();
    expect(trimByFence([ln("solo", 0, 0, 10, 0)], [{ x: 5, y: -1 }, { x: 5, y: 1 }])).toBeNull();
    expect(trimByFence(drawing, [{ x: 1, y: 1 }])).toBeNull();
  });

  it("crossings come back in stroke order", () => {
    const pts = fenceCrossings(ln("h", 0, 0, 30, 0), [{ x: 25, y: -1 }, { x: 25, y: 1 }, { x: 5, y: 1 }, { x: 5, y: -1 }]);
    expect(pts.map((p) => p.x)).toEqual([25, 5]);
  });

  it("a circle crossed by the stroke between two cutters becomes the remaining arc", () => {
    const circle: Entity = { id: "c", type: "circle", center: { x: 0, y: 0 }, radius: 10 };
    const cutters = [ln("a", -20, 0, 20, 0), ln("b", 0, -20, 0, 20)];
    const r = trimByFence([circle, ...cutters], [{ x: 6, y: 6 }, { x: 8, y: 8 }])!;
    const arc = r.add.find((e) => e.id.startsWith("c#")) as ArcEntity;
    expect(arc.type).toBe("arc");
    expect(r.remove).toContain("c");
  });
});
