import { describe, expect, it } from "vitest";
import { boundsOf } from "../dxf";
import { flatFaceOutline, planeBasis, projectEdge, type ProjectableEdge, type V3 } from "./outline";

/**
 * "Flat face outline to DXF" is what laser shops ask a 3D viewer for. These
 * tests pin the parts that go wrong silently: a mirrored part (wrong handedness),
 * holes that lose their circle-ness, arcs that sweep the wrong way, and the
 * outline not landing at the origin.
 */

const line = (a: V3, b: V3): ProjectableEdge => ({ kind: "line", points: [...a, ...b] });

/** A 100 x 50 plate in the plane z = 5, outward normal +Z, with a 10 mm hole. */
function plate(): ProjectableEdge[] {
  const z = 5;
  return [
    line([10, 20, z], [110, 20, z]),
    line([110, 20, z], [110, 70, z]),
    line([110, 70, z], [10, 70, z]),
    line([10, 70, z], [10, 20, z]),
    { kind: "circle", points: [40, 45, z, 40, 45, z], center: [40, 45, z], radius: 5, normal: [0, 0, 1] },
  ];
}

describe("planeBasis", () => {
  it("is right-handed: u x v = n", () => {
    for (const n of [[0, 0, 1], [0, 0, -1], [1, 0, 0], [0, -1, 0], [1, 1, 1]] as V3[]) {
      const b = planeBasis(n, [0, 0, 0])!;
      const c = [b.u[1] * b.v[2] - b.u[2] * b.v[1], b.u[2] * b.v[0] - b.u[0] * b.v[2], b.u[0] * b.v[1] - b.u[1] * b.v[0]];
      const l = Math.hypot(...n);
      for (let i = 0; i < 3; i++) expect(c[i]).toBeCloseTo(n[i] / l, 9);
    }
  });
  it("rejects a zero or non-finite normal", () => {
    expect(planeBasis([0, 0, 0], [0, 0, 0])).toBeNull();
    expect(planeBasis([NaN, 0, 1], [0, 0, 0])).toBeNull();
  });
  it("ignores a hint parallel to the normal", () => {
    const b = planeBasis([0, 0, 1], [0, 0, 0], [0, 0, 3])!;
    expect(Math.hypot(...b.u)).toBeCloseTo(1, 9);
  });
});

describe("flatFaceOutline", () => {
  it("puts a plate at the origin with its true size, hole kept as a circle", () => {
    const r = flatFaceOutline([0, 0, 1], [60, 45, 5], plate())!;
    const b = boundsOf(r.entities)!;
    expect(b.minX).toBeCloseTo(0, 9);
    expect(b.minY).toBeCloseTo(0, 9);
    expect(Math.max(b.maxX - b.minX, b.maxY - b.minY)).toBeCloseTo(100, 9);
    expect(Math.min(b.maxX - b.minX, b.maxY - b.minY)).toBeCloseTo(50, 9);
    const circles = r.entities.filter((e) => e.type === "circle");
    expect(circles).toHaveLength(1);
    expect(circles[0].type === "circle" && circles[0].radius).toBeCloseTo(5, 9);
    // the four sides joined into one closed polyline
    const polys = r.entities.filter((e) => e.type === "polyline");
    expect(polys).toHaveLength(1);
    expect(polys[0].type === "polyline" && polys[0].closed).toBe(true);
  });

  it("aligns the longest edge to +X, whatever the 3D direction", () => {
    const rot = (p: V3): V3 => [-p[1], p[0], p[2]]; // quarter turn about Z
    const edges = plate().map((e) => ({ ...e, points: Array.from({ length: e.points.length / 3 }, (_, i) => rot([e.points[i * 3], e.points[i * 3 + 1], e.points[i * 3 + 2]])).flat() }));
    const r = flatFaceOutline([0, 0, 1], [0, 0, 5], edges as ProjectableEdge[])!;
    const b = boundsOf(r.entities)!;
    expect(b.maxX - b.minX).toBeCloseTo(100, 6);
  });

  it("is not mirrored: a notch on the +x side of a +Z face stays on the same side", () => {
    // Seen from +Z (outside), a point at world (+x) has larger 2D x when X is the hint.
    const r = flatFaceOutline([0, 0, 1], [0, 0, 0], [line([0, 0, 0], [10, 0, 0]), line([10, 0, 0], [10, 3, 0])], { alignTo: [1, 0, 0], join: false })!;
    const second = r.entities[1];
    expect(second.type === "line" && second.b.y).toBeCloseTo(3, 9);
    // viewed from behind, the part mirrors in X
    const f = flatFaceOutline([0, 0, 1], [0, 0, 0], [line([0, 0, 0], [10, 0, 0])], { alignTo: [1, 0, 0], flip: true, join: false })!;
    const l = f.entities[0];
    expect(l.type === "line" && Math.abs(l.a.x - l.b.x)).toBeCloseTo(10, 9);
  });

  it("keeps an arc as an arc with the right sweep direction", () => {
    // Quarter arc of radius 10 about the origin from (10,0) to (0,10), counter-clockwise seen from +Z.
    const pts: number[] = [];
    for (let i = 0; i <= 8; i++) {
      const a = (i / 8) * (Math.PI / 2);
      pts.push(10 * Math.cos(a), 10 * Math.sin(a), 0);
    }
    const arc: ProjectableEdge = { kind: "arc", points: pts, center: [0, 0, 0], radius: 10, normal: [0, 0, 1] };
    const basis = planeBasis([0, 0, 1], [0, 0, 0], [1, 0, 0])!;
    const [e] = projectEdge(basis, arc);
    expect(e.type).toBe("arc");
    if (e.type === "arc") {
      expect(e.ccw).toBe(true);
      expect(e.startAngle).toBeCloseTo(0, 9);
      expect(e.endAngle).toBeCloseTo(Math.PI / 2, 9);
    }
    // the same chain reversed sweeps clockwise from (0,10) to (10,0)
    const rev = { ...arc, points: [...pts].reverse().reduce<number[]>((acc, _v, i, a) => (i % 3 === 0 ? [...acc, a[i + 2], a[i + 1], a[i]] : acc), []) };
    const [r2] = projectEdge(basis, rev);
    expect(r2.type === "arc" && r2.ccw).toBe(false);
  });

  it("falls back to a polyline for a curve and for an edge seen edge-on", () => {
    const basis = planeBasis([0, 0, 1], [0, 0, 0], [1, 0, 0])!;
    const curve: ProjectableEdge = { kind: "curve", points: [0, 0, 0, 1, 1, 0, 2, 0, 0] };
    expect(projectEdge(basis, curve)[0].type).toBe("polyline");
    // a vertical line has zero length in the plane
    expect(projectEdge(basis, line([1, 1, 0], [1, 1, 9]))).toEqual([]);
    // a circle whose plane is tilted is not an exact circle in this view
    const tilted: ProjectableEdge = { kind: "circle", points: [1, 0, 0, 0, 1, 1, 1, 0, 0], center: [0, 0, 0], radius: 1, normal: [1, 0, 0] };
    expect(projectEdge(basis, tilted)[0].type).toBe("polyline");
  });

  it("copes with no edges and with a degenerate normal", () => {
    expect(flatFaceOutline([0, 0, 1], [0, 0, 0], [])!.entities).toEqual([]);
    expect(flatFaceOutline([0, 0, 0], [0, 0, 0], plate())).toBeNull();
    expect(projectEdge(planeBasis([0, 0, 1], [0, 0, 0])!, { kind: "line", points: [] })).toEqual([]);
  });

  it("is deterministic on the size of the result (no duplicate or lost pieces)", () => {
    const r = flatFaceOutline([0, 0, 1], [0, 0, 5], plate(), { join: false })!;
    expect(r.entities).toHaveLength(5);
  });
});
