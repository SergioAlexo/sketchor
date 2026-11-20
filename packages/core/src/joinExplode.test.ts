import { describe, expect, it } from "vitest";
import { CommandBus } from "./commands";
import { SketchDocument } from "./document";
import type { ArcEntity, Entity, LineEntity, PolylineEntity } from "./entities";
import { polylineSegments } from "./entities";
import { bulgeToArc, dist } from "./geometry";
import { explodeCommands, explodePolyline, joinCommands, joinEntities, joinEntitiesExact, pointsAlong } from "./joinExplode";
import { splitAt } from "./intersect";
import type { SplineEntity } from "./entities";
import { nurbsEval } from "./nurbs";
import "./kinds/builtin";

/**
 * Join turns a DXF's loose lines and arcs into the one closed contour a
 * cutter, an offset or a fillet-all-corners needs; explode is how you get
 * back to editing a single edge. A chain joined in the wrong order or an
 * arc leg with a flipped bulge gives a contour that looks right and cuts
 * wrong.
 */

const line = (id: string, ax: number, ay: number, bx: number, by: number): LineEntity => ({ id, type: "line", a: { x: ax, y: ay }, b: { x: bx, y: by } });

describe("joinEntities", () => {
  it("chains lines end to end, whichever way round they were drawn, into one closed polyline", () => {
    const es: Entity[] = [line("a", 0, 0, 10, 0), line("b", 10, 10, 10, 0), line("c", 10, 10, 0, 10), line("d", 0, 0, 0, 10)];
    const chains = joinEntities(es);
    expect(chains).toHaveLength(1);
    expect(chains[0].replaced.sort()).toEqual(["a", "b", "c", "d"]);
    const pl = chains[0].polyline;
    expect(pl.closed).toBe(true);
    expect(pl.points).toHaveLength(4);
  });

  it("keeps an arc as a bulged leg, with the right side", () => {
    // Line to (10,0), then a semicircle up and back to (0,0)... via (5,5): ccw from (10,0) to (0,0).
    const arc: ArcEntity = { id: "arc", type: "arc", center: { x: 5, y: 0 }, radius: 5, startAngle: 0, endAngle: Math.PI, ccw: true };
    const chains = joinEntities([line("a", 0, 0, 10, 0), arc]);
    expect(chains).toHaveLength(1);
    const pl = chains[0].polyline;
    expect(pl.closed).toBe(true);
    const arcs = polylineSegments(pl).map((s) => bulgeToArc(s.a, s.b, s.bulge)).filter((a): a is NonNullable<typeof a> => !!a);
    expect(arcs).toHaveLength(1);
    expect(arcs[0].center.x).toBeCloseTo(5, 9);
    expect(arcs[0].center.y).toBeCloseTo(0, 9);
    // The leg passes through (5, 5), above the chord.
    const mid = arcs[0].ccw ? arcs[0].startAngle + Math.PI / 2 : arcs[0].startAngle - Math.PI / 2;
    expect(arcs[0].center.y + arcs[0].radius * Math.sin(mid)).toBeCloseTo(5, 9);
  });

  it("leaves unconnected entities and closed polylines alone", () => {
    const closed: PolylineEntity = { id: "p", type: "polyline", points: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }], closed: true };
    expect(joinEntities([line("a", 0, 0, 10, 0), line("b", 20, 0, 30, 0), closed])).toHaveLength(0);
  });

  it("joinCommands replaces the chain in one batch that undoes cleanly", () => {
    const d = new SketchDocument();
    const es = [line("a", 0, 0, 10, 0), line("b", 10, 0, 10, 10), line("z", 50, 50, 60, 60)];
    for (const e of es) d._put(e);
    const bus = new CommandBus(d);
    const commands = joinCommands(d.all());
    expect(commands.length).toBeGreaterThan(0);
    bus.execute({ type: "batch", commands });
    expect(d.all().map((e) => e.type).sort()).toEqual(["line", "polyline"]);
    bus.undo();
    expect(d.all().map((e) => e.id).sort()).toEqual(["a", "b", "z"]);
  });
});

describe("explodePolyline", () => {
  it("gives back lines and arcs that trace the same path, inheriting properties", () => {
    const pl: PolylineEntity = {
      id: "p",
      type: "polyline",
      layer: "cut",
      points: [
        { x: 0, y: 0 },
        { x: 10, y: 0 },
        { x: 10, y: 10 },
      ],
      closed: true,
      bulges: [0, 1, 0],
    };
    const parts = explodePolyline(pl);
    expect(parts.map((p) => p.type)).toEqual(["line", "arc", "line"]);
    expect(parts.every((p) => p.layer === "cut")).toBe(true);
    const arc = parts[1] as ArcEntity;
    expect(dist(arc.center, { x: 10, y: 5 })).toBeLessThan(1e-9);
    expect(explodeCommands([pl])).toHaveLength(4);
    expect(explodeCommands([line("l", 0, 0, 1, 1)])).toHaveLength(0);
  });
});

describe("pointsAlong", () => {
  it("divides a line into N equal parts and spaces points along a circle", () => {
    const pts = pointsAlong(line("l", 0, 0, 10, 0), { divisions: 4 });
    expect(pts.map((p) => p.x)).toEqual([2.5, 5, 7.5]);
    const circle: Entity = { id: "c", type: "circle", center: { x: 0, y: 0 }, radius: 10 };
    const around = pointsAlong(circle, { divisions: 4 });
    expect(around).toHaveLength(4); // a closed path includes its start
    for (const p of around) expect(Math.hypot(p.x, p.y)).toBeCloseTo(10, 9);
    const spaced = pointsAlong(line("l", 0, 0, 10, 0), { spacing: 3 });
    expect(spaced.map((p) => p.x)).toEqual([3, 6, 9]);
  });
});

describe("joinEntitiesExact (curves)", () => {
  const spline = (id: string, pts: [number, number][]): SplineEntity => ({
    id,
    type: "spline",
    degree: 3,
    controlPoints: pts.map(([x, y]) => ({ x, y })),
    knots: [0, 0, 0, 0, 1, 1, 1, 1],
    closed: false,
  });

  it("merges end-to-end splines into one spline, whichever way round the second was drawn", () => {
    const a = spline("a", [[0, 0], [1, 2], [2, 2], [3, 0]]);
    const b = spline("b", [[6, 0], [5, 2], [4, 2], [3, 0]]); // drawn towards the joint
    const chains = joinEntitiesExact([a, b]);
    expect(chains).toHaveLength(1);
    const e = chains[0].entity as SplineEntity;
    expect(e.type).toBe("spline");
    const lo = e.knots[e.degree];
    const hi = e.knots[e.controlPoints.length];
    const start = nurbsEval(e, lo).point;
    const end = nurbsEval(e, hi).point;
    expect(dist(start, { x: 0, y: 0 })).toBeLessThan(1e-9);
    expect(dist(end, { x: 6, y: 0 })).toBeLessThan(1e-9);
  });

  it("falls back to a polyline of chords when a spline meets a line", () => {
    const a = spline("a", [[0, 0], [1, 2], [2, 2], [3, 0]]);
    const chains = joinEntitiesExact([a, line("l", 3, 0, 8, 0)]);
    expect(chains).toHaveLength(1);
    expect(chains[0].entity.type).toBe("polyline");
  });

  it("the plain joinEntities still returns a polyline for curve chains", () => {
    const a = spline("a", [[0, 0], [1, 2], [2, 2], [3, 0]]);
    const chains = joinEntities([a, line("l", 3, 0, 8, 0)]);
    expect(chains[0].polyline.type).toBe("polyline");
  });
});

describe("per-entity linetype scale survives the edits that rebuild an entity", () => {
  // A dashed boundary whose scale was set so it reads at sheet size must not
  // fall back to scale 1 (and so turn solid when zoomed out) after a split,
  // an explode or a join.
  it("explode keeps it on every piece", () => {
    const pl: PolylineEntity = { id: "p", type: "polyline", points: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }], closed: false, linetype: "DASHED", linetypeScale: 8 };
    const pieces = explodePolyline(pl);
    expect(pieces.length).toBe(2);
    for (const p of pieces) expect(p).toMatchObject({ linetype: "DASHED", linetypeScale: 8 });
  });

  it("split keeps it on both halves", () => {
    const halves = splitAt({ ...line("a", 0, 0, 10, 0), linetype: "DASHED", linetypeScale: 3 }, { x: 4, y: 0 })!;
    expect(halves).toHaveLength(2);
    for (const h of halves) expect(h.linetypeScale).toBe(3);
  });

  it("join keeps a lone member's scale on the polyline it becomes", () => {
    const [chain] = joinEntities([{ ...line("a", 0, 0, 10, 0), linetypeScale: 2 }, { ...line("b", 10, 0, 10, 10), linetypeScale: 2 }]);
    expect(chain.polyline.linetypeScale).toBe(2);
  });
});
