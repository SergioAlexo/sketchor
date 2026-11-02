import { describe, expect, it } from "vitest";
import type { CircleEntity, LineEntity, PolylineEntity } from "./entities";
import { polylineSegments } from "./entities";
import { bulgeToArc, distToSegment } from "./geometry";
import { offsetEntity, offsetThroughPoint } from "./offset";

/**
 * Offset "through point" (T-15) is how you copy a wall to wherever the next
 * feature already is without measuring; the round gap type (OFFSETGAPTYPE=1)
 * is how a clearance around a plate is cut with a rounded tool path. Failures:
 * the copy misses the point, or the outside corners get cut / left sharp.
 */

const line = (ax: number, ay: number, bx: number, by: number): LineEntity => ({ id: "l", type: "line", a: { x: ax, y: ay }, b: { x: bx, y: by } });
const rect = (w: number, h: number): PolylineEntity => ({
  id: "r",
  type: "polyline",
  points: [
    { x: 0, y: 0 },
    { x: w, y: 0 },
    { x: w, y: h },
    { x: 0, y: h },
  ],
  closed: true,
});

describe("offset through a point and the round gap type (T-15)", () => {
  it("through-point: the copy passes through the point, on its side", () => {
    const up = offsetThroughPoint(line(0, 0, 10, 0), { x: 4, y: 3 }) as LineEntity;
    expect(up.a.y).toBeCloseTo(3, 9);
    expect(up.b.y).toBeCloseTo(3, 9);
    const c: CircleEntity = { id: "c", type: "circle", center: { x: 0, y: 0 }, radius: 5 };
    expect((offsetThroughPoint(c, { x: 8, y: 0 }) as CircleEntity).radius).toBeCloseTo(8, 9);
    expect((offsetThroughPoint(c, { x: 0, y: 2 }) as CircleEntity).radius).toBeCloseTo(2, 9);
    const o = offsetThroughPoint(rect(10, 4), { x: 5, y: -2 }) as PolylineEntity;
    expect(Math.min(...o.points.map((p) => p.y))).toBeCloseTo(-2, 9);
  });

  it("through-point on the entity itself is refused", () => {
    expect(offsetThroughPoint(line(0, 0, 10, 0), { x: 4, y: 0 })).toBeNull();
  });

  it("round gap rounds the outside corners about the original vertices; extend keeps sharp ones", () => {
    const sharp = offsetEntity(rect(10, 4), 1, { x: 5, y: -3 }, "extend") as PolylineEntity;
    expect(sharp.points).toHaveLength(4);
    const round = offsetEntity(rect(10, 4), 1, { x: 5, y: -3 }, "round") as PolylineEntity;
    expect(round.closed).toBe(true);
    const arcs = polylineSegments(round).filter((s) => s.bulge);
    expect(arcs).toHaveLength(4);
    for (const s of arcs) expect(bulgeToArc(s.a, s.b, s.bulge!)!.radius).toBeCloseTo(1, 6);
    const edges: [number, number, number, number][] = [
      [0, 0, 10, 0],
      [10, 0, 10, 4],
      [10, 4, 0, 4],
      [0, 4, 0, 0],
    ];
    for (const p of round.points) {
      const d = Math.min(...edges.map(([ax, ay, bx, by]) => distToSegment(p, { x: ax, y: ay }, { x: bx, y: by })));
      expect(d).toBeGreaterThan(1 - 1e-6);
    }
  });

  it("round gap leaves an inner offset unchanged", () => {
    const a = offsetEntity(rect(10, 4), 1, { x: 5, y: 2 }, "extend") as PolylineEntity;
    const b = offsetEntity(rect(10, 4), 1, { x: 5, y: 2 }, "round") as PolylineEntity;
    expect(b.points).toEqual(a.points);
    expect(polylineSegments(b).some((s) => s.bulge)).toBe(false);
  });
});
