/**
 * T-27 vertex grip menu: add/remove vertex and straight/arc conversion on a
 * polyline must keep the per-segment bulges aligned with the points (a slip
 * silently bends the wrong segment), never leave a degenerate polyline, and
 * keep the drawn curve the same when an arc segment is split.
 */
import { describe, expect, it } from "vitest";
import type { PolylineEntity } from "./entities";
import { applyGripMenuAction, DEFAULT_ARC_BULGE, gripMenuActions, polylineAddVertex, polylineRemoveVertex, polylineSetSegmentBulge } from "./gripMenu";
import { bulgeToArc } from "./geometry";

const open = (over: Partial<PolylineEntity> = {}): PolylineEntity => ({
  id: "p",
  type: "polyline",
  points: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }],
  closed: false,
  ...over,
});

describe("polylineAddVertex", () => {
  it("inserts at the chord midpoint of a straight segment and keeps later bulges on their segments", () => {
    const e = polylineAddVertex(open({ bulges: [0, 0, 0.5] }), 1)!;
    expect(e.points).toHaveLength(5);
    expect(e.points[2]).toEqual({ x: 10, y: 5 });
    // the old third segment (now the fourth) keeps its 0.5 bulge
    expect(e.bulges).toEqual([0, 0, 0, 0.5]);
  });

  it("splits an arc segment into two equal arcs through the original arc midpoint", () => {
    const e0 = open({ points: [{ x: 0, y: 0 }, { x: 10, y: 0 }], bulges: [1] }); // semicircle, radius 5, centre (5,0)
    const e = polylineAddVertex(e0, 0)!;
    expect(e.points[1].x).toBeCloseTo(5, 9);
    expect(Math.abs(e.points[1].y)).toBeCloseTo(5, 9);
    expect(e.bulges![0]).toBeCloseTo(Math.tan(Math.PI / 4 / 2), 9); // each half is a quarter turn: tan(90deg/4)
    const half = bulgeToArc(e.points[0], e.points[1], e.bulges![0])!;
    expect(half.radius).toBeCloseTo(5, 9);
    expect(half.center.x).toBeCloseTo(5, 9);
  });

  it("closing segment of a closed polyline can be split too", () => {
    const e = polylineAddVertex(open({ closed: true }), 3)!;
    expect(e.points).toHaveLength(5);
    expect(e.points[4]).toEqual({ x: 0, y: 5 });
  });

  it("is null for the last vertex of an open polyline, a bad index, or a zero-length segment", () => {
    expect(polylineAddVertex(open(), 3)).toBeNull();
    expect(polylineAddVertex(open(), -1)).toBeNull();
    expect(polylineAddVertex(open(), 1.5)).toBeNull();
    expect(polylineAddVertex(open({ points: [{ x: 1, y: 1 }, { x: 1, y: 1 }] }), 0)).toBeNull();
  });
});

describe("polylineRemoveVertex", () => {
  it("joins the neighbours with a straight segment and drops the right bulge", () => {
    const e = polylineRemoveVertex(open({ bulges: [0.3, 0.4, 0.5] }), 1)!;
    expect(e.points).toHaveLength(3);
    expect(e.points[1]).toEqual({ x: 10, y: 10 });
    expect(e.bulges).toEqual([0, 0.5]);
  });

  it("removing an end vertex just drops its segment", () => {
    expect(polylineRemoveVertex(open({ bulges: [0.3, 0.4, 0.5] }), 0)!.bulges).toEqual([0.4, 0.5]);
    expect(polylineRemoveVertex(open({ bulges: [0.3, 0.4, 0.5] }), 3)!.bulges).toEqual([0.3, 0.4]);
  });

  it("closed polylines wrap, and keep at least three vertices", () => {
    const sq = open({ closed: true, bulges: [0.1, 0.2, 0.3, 0.4] });
    const e = polylineRemoveVertex(sq, 0)!;
    expect(e.points).toHaveLength(3);
    expect(e.bulges).toEqual([0.2, 0.3, 0]);
    expect(polylineRemoveVertex(open({ closed: true, points: sq.points.slice(0, 3) }), 0)).toBeNull();
  });

  it("an open polyline keeps at least two vertices; the bulges array disappears when nothing is curved", () => {
    expect(polylineRemoveVertex(open({ points: [{ x: 0, y: 0 }, { x: 1, y: 0 }] }), 0)).toBeNull();
    expect(polylineRemoveVertex(open({ bulges: [0, 0.5, 0] }), 1)!.bulges).toBeUndefined();
  });
});

describe("polylineSetSegmentBulge", () => {
  it("turns a segment into a quarter-circle arc and back", () => {
    const arc = polylineSetSegmentBulge(open(), 0, DEFAULT_ARC_BULGE)!;
    expect(arc.bulges).toEqual([DEFAULT_ARC_BULGE, 0, 0]);
    expect(polylineSetSegmentBulge(arc, 0, 0)!.bulges).toBeUndefined();
  });
  it("rejects a missing or zero-length segment and a non-finite bulge", () => {
    expect(polylineSetSegmentBulge(open(), 3, 0.5)).toBeNull();
    expect(polylineSetSegmentBulge(open(), 0, NaN)).toBeNull();
    expect(polylineSetSegmentBulge(open({ points: [{ x: 0, y: 0 }, { x: 0, y: 0 }] }), 0, 0.5)).toBeNull();
  });
});

describe("gripMenuActions", () => {
  it("offers add / remove / arc in the middle, nothing to add or convert at an open end", () => {
    expect(gripMenuActions(open(), 1)).toEqual(["add", "remove", "arc"]);
    expect(gripMenuActions(open(), 3)).toEqual(["remove"]);
  });
  it("offers convert-to-line on a curved segment and no remove when too few vertices", () => {
    expect(gripMenuActions(open({ bulges: [0.5, 0, 0] }), 0)).toEqual(["add", "remove", "line"]);
    expect(gripMenuActions(open({ points: [{ x: 0, y: 0 }, { x: 5, y: 0 }] }), 0)).toEqual(["add", "arc"]);
  });
  it("is empty for a bad index and applyGripMenuAction mirrors the offered set", () => {
    expect(gripMenuActions(open(), 9)).toEqual([]);
    expect(applyGripMenuAction(open(), 3, "add")).toBeNull();
    expect(applyGripMenuAction(open(), 1, "arc")!.bulges![1]).toBeCloseTo(DEFAULT_ARC_BULGE, 12);
  });
});
