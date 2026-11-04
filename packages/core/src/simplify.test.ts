import { describe, expect, it } from "vitest";
import type { CircleEntity, LineEntity, PolylineEntity } from "./entities";
import { polylineSegments } from "./entities";
import { bulgeToArc, dist, type Point } from "./geometry";
import {
  countSimplifiable,
  fitArcRuns,
  fitCircle,
  flattenPolylineToPoints,
  simplifyClosedRing,
  simplifyOpenRun,
  simplifyPolylineCommands,
  simplifyPolylineEntity,
} from "./simplify";

/**
 * P-03: a DXF SPLINE/ELLIPSE (tessellated on import) or an already-dense
 * LWPOLYLINE from another program routinely comes in as dozens to hundreds
 * of straight-segment vertices for a handful of real arcs — that's the
 * user-visible "too many points, and every one is a grip" complaint. These
 * tests pin the two properties that actually matter: the simplified shape
 * still traces the same curve within tolerance (never a visibly different
 * outline), and it does so with far fewer points/segments than it started
 * with.
 */

function tessellateCircle(center: Point, radius: number, n: number): Point[] {
  const pts: Point[] = [];
  for (let i = 0; i < n; i++) {
    const a = (2 * Math.PI * i) / n;
    pts.push({ x: center.x + radius * Math.cos(a), y: center.y + radius * Math.sin(a) });
  }
  return pts;
}

describe("simplifyOpenRun", () => {
  it("collapses collinear points down to just the two ends", () => {
    const points: Point[] = [
      { x: 0, y: 0 },
      { x: 1, y: 0 },
      { x: 2, y: 0 },
      { x: 3, y: 0 },
      { x: 10, y: 0 },
    ];
    const out = simplifyOpenRun(points, 0.01);
    expect(out).toEqual([{ x: 0, y: 0 }, { x: 10, y: 0 }]);
  });

  it("keeps a genuine corner (a point far from the straight line between the ends)", () => {
    const points: Point[] = [
      { x: 0, y: 0 },
      { x: 5, y: 0 },
      { x: 10, y: 5 },
    ];
    const out = simplifyOpenRun(points, 0.5);
    expect(out).toEqual(points);
  });

  it("always keeps the first and last point even for a very loose tolerance", () => {
    const points: Point[] = [
      { x: 0, y: 0 },
      { x: 1, y: 0.1 },
      { x: 2, y: -0.1 },
      { x: 10, y: 0 },
    ];
    const out = simplifyOpenRun(points, 1000);
    expect(out[0]).toEqual(points[0]);
    expect(out[out.length - 1]).toEqual(points[points.length - 1]);
  });
});

describe("simplifyClosedRing", () => {
  it("reduces a densely tessellated circle to far fewer points while staying close to the true circle", () => {
    const center = { x: 0, y: 0 };
    const radius = 50;
    const dense = tessellateCircle(center, radius, 72);
    const reduced = simplifyClosedRing(dense, 0.5);
    expect(reduced.length).toBeLessThan(dense.length);
    for (const p of reduced) {
      expect(Math.abs(dist(p, center) - radius)).toBeLessThanOrEqual(0.5 + 1e-9);
    }
  });

  it("leaves a genuine square's four corners alone", () => {
    const square: Point[] = [
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 10, y: 10 },
      { x: 0, y: 10 },
    ];
    const out = simplifyClosedRing(square, 0.1);
    expect(out).toHaveLength(4);
  });
});

describe("fitCircle", () => {
  it("recovers the exact center and radius from points on a known circle", () => {
    const center = { x: 3, y: -2 };
    const radius = 7;
    const pts = tessellateCircle(center, radius, 6);
    const fit = fitCircle(pts)!;
    expect(fit.center.x).toBeCloseTo(center.x, 6);
    expect(fit.center.y).toBeCloseTo(center.y, 6);
    expect(fit.radius).toBeCloseTo(radius, 6);
  });

  it("returns null for collinear points (no circle fits them)", () => {
    expect(fitCircle([{ x: 0, y: 0 }, { x: 1, y: 1 }, { x: 2, y: 2 }])).toBeNull();
  });

  it("returns null for fewer than 3 points", () => {
    expect(fitCircle([{ x: 0, y: 0 }, { x: 1, y: 1 }])).toBeNull();
  });
});

describe("fitArcRuns", () => {
  it("turns a tessellated semicircle back into one bulge arc, leaving an unrelated straight leg alone", () => {
    const center = { x: 0, y: 0 };
    const radius = 20;
    // A semicircle from angle 0 to PI, densely sampled, followed by one
    // straight leg back toward the start — a shape a real import would
    // produce from an arc entity plus a line.
    const arcPts: Point[] = [];
    const steps = 20;
    for (let i = 0; i <= steps; i++) {
      const a = (Math.PI * i) / steps;
      arcPts.push({ x: center.x + radius * Math.cos(a), y: center.y + radius * Math.sin(a) });
    }
    const points = [...arcPts, { x: -radius / 2, y: 0 }];
    const { points: outPoints, bulges } = fitArcRuns(points, false, 0.05);
    expect(outPoints.length).toBeLessThan(points.length);
    // The arc run collapsed to one non-zero bulge; the trailing straight
    // leg back to the last point stayed straight (bulge 0).
    expect(bulges.filter((b) => b !== 0)).toHaveLength(1);
    expect(bulges[bulges.length - 1]).toBe(0);
    // The fitted arc still passes through the true start/end of the semicircle.
    const arcSeg = polylineSegments({ id: "t", type: "polyline", points: outPoints, closed: false, bulges } as PolylineEntity).find(
      (s) => s.bulge !== 0,
    )!;
    const resolved = bulgeToArc(arcSeg.a, arcSeg.b, arcSeg.bulge)!;
    expect(resolved.radius).toBeCloseTo(radius, 1);
    expect(dist(resolved.center, center)).toBeLessThan(0.5);
  });

  it("leaves a plain rectangle's segments straight (no false arcs from 4 corner points, even though a square's corners are exactly concyclic)", () => {
    const points: Point[] = [
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 10, y: 10 },
      { x: 0, y: 10 },
    ];
    const { bulges } = fitArcRuns(points, true, 0.01);
    expect(bulges.every((b) => b === 0)).toBe(true);
  });

  it("a full closed circle: every fitted arc segment (including the one that closes back to the ring's own first point) matches the true circle", () => {
    // Regression test for two bugs found while building this: (1) a run
    // starting at index 0 was allowed to grow all the way back onto index
    // 0 again, producing a zero-length final chord; (2) a *later* run was
    // allowed to keep growing past a full lap and re-cover points already
    // claimed by an earlier run, corrupting its circle fit entirely (one
    // segment came back with a radius of ~6.5 instead of the true 30).
    const center = { x: 100, y: 50 };
    const radius = 30;
    const dense = tessellateCircle(center, radius, 72);
    const { points, bulges } = fitArcRuns(dense, true, 0.1);
    expect(points.length).toBeGreaterThan(1);
    expect(points.length).toBeLessThan(10);
    const entity = { id: "t", type: "polyline", points, closed: true, bulges } as PolylineEntity;
    for (const seg of polylineSegments(entity)) {
      const arc = bulgeToArc(seg.a, seg.b, seg.bulge);
      expect(arc).not.toBeNull();
      expect(dist(arc!.center, center)).toBeLessThan(0.1);
      expect(arc!.radius).toBeCloseTo(radius, 3);
    }
  });
});

describe("flattenPolylineToPoints", () => {
  it("tessellates a bulge segment into several points approximating the real arc", () => {
    const a = { x: 10, y: 0 };
    const b = { x: -10, y: 0 };
    const entity: PolylineEntity = { id: "p", type: "polyline", points: [a, b], closed: false, bulges: [1] }; // bulge 1 = semicircle
    const pts = flattenPolylineToPoints(entity, 0.1);
    expect(pts.length).toBeGreaterThan(4);
    expect(pts[0]).toEqual(a);
    expect(pts[pts.length - 1]).toEqual(b);
    const arc = bulgeToArc(a, b, 1)!;
    for (const p of pts) {
      expect(Math.abs(dist(p, arc.center) - arc.radius)).toBeLessThan(0.15);
    }
  });
});

describe("simplifyPolylineEntity", () => {
  it("a circle imported as a 72-point closed polyline comes back with far fewer vertices and still traces the same circle", () => {
    const center = { x: 100, y: 50 };
    const radius = 30;
    const dense: PolylineEntity = {
      id: "dense-circle",
      type: "polyline",
      name: "PL1",
      layer: "cutlines",
      points: tessellateCircle(center, radius, 72),
      closed: true,
    };
    const simplified = simplifyPolylineEntity(dense, 0.1);
    expect(simplified.points.length).toBeLessThan(10); // a circle should collapse to ~1-2 arc segments
    expect(simplified.name).toBe("PL1"); // identity/layer/name preserved
    expect(simplified.layer).toBe("cutlines");
    // Re-flatten the simplified result and check it still traces the same circle.
    const reflattened = flattenPolylineToPoints(simplified, 0.05);
    for (const p of reflattened) {
      expect(Math.abs(dist(p, center) - radius)).toBeLessThan(0.15);
    }
  });

  it("returns the same object (by reference) for a shape that's already minimal", () => {
    const square: PolylineEntity = {
      id: "sq",
      type: "polyline",
      points: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }],
      closed: true,
    };
    expect(simplifyPolylineEntity(square, 0.1)).toBe(square);
  });

  it("returns the same object for a too-short polyline instead of throwing", () => {
    const twoPoint: PolylineEntity = { id: "l", type: "polyline", points: [{ x: 0, y: 0 }, { x: 1, y: 1 }], closed: false };
    expect(simplifyPolylineEntity(twoPoint, 0.1)).toBe(twoPoint);
  });
});

describe("simplifyPolylineCommands", () => {
  it("only touches polylines that actually shrink, ignoring other entity types and already-minimal ones", () => {
    const dense: PolylineEntity = {
      id: "dense",
      type: "polyline",
      points: tessellateCircle({ x: 0, y: 0 }, 10, 72),
      closed: true,
    };
    const minimal: PolylineEntity = {
      id: "min",
      type: "polyline",
      points: [{ x: 0, y: 0 }, { x: 5, y: 0 }, { x: 5, y: 5 }],
      closed: true,
    };
    const line: LineEntity = { id: "l", type: "line", a: { x: 0, y: 0 }, b: { x: 1, y: 1 } };
    const circle: CircleEntity = { id: "c", type: "circle", center: { x: 0, y: 0 }, radius: 5 };
    const commands = simplifyPolylineCommands([dense, minimal, line, circle], 0.1);
    expect(commands.filter((c) => c.type === "delete-entities").map((c) => (c as { ids: string[] }).ids[0])).toEqual(["dense"]);
    expect(commands.filter((c) => c.type === "add-entity")).toHaveLength(1);
  });

  it("returns no commands when nothing in the selection can be simplified", () => {
    const line: LineEntity = { id: "l", type: "line", a: { x: 0, y: 0 }, b: { x: 1, y: 1 } };
    expect(simplifyPolylineCommands([line], 0.1)).toEqual([]);
  });
});

describe("countSimplifiable (P-03b import banner)", () => {
  const dense: PolylineEntity = { id: "d", type: "polyline", points: tessellateCircle({ x: 0, y: 0 }, 10, 72), closed: true };
  it("counts only dense polylines that shrink, and a looser tolerance never counts fewer", () => {
    const small: PolylineEntity = { id: "s", type: "polyline", points: [{ x: 0, y: 0 }, { x: 5, y: 0 }, { x: 5, y: 5 }], closed: true };
    const line: LineEntity = { id: "l", type: "line", a: { x: 0, y: 0 }, b: { x: 1, y: 1 } };
    expect(countSimplifiable([dense, small, line], 0.1)).toBe(1);
    expect(countSimplifiable([dense], 1)).toBeGreaterThanOrEqual(countSimplifiable([dense], 0.001));
  });
  it("is zero for an empty list or a polyline under the point threshold", () => {
    expect(countSimplifiable([], 0.1)).toBe(0);
    expect(countSimplifiable([dense], 0.1, 1000)).toBe(0);
  });
});
