import { describe, expect, it } from "vitest";
import { projectView, type ProjectMesh } from "./view";
import type { ProjectableEdge, V3 } from "./outline";
import { boundsOf } from "../dxf";

/**
 * The hidden-line projection behind "view to 2D". If the z-buffer test is too
 * loose a hole that is drilled on the far side shows up on the laser drawing;
 * too tight and real edges vanish; and a circle that degrades to a polygon
 * cuts as a 32-gon.
 */

type Box = [number, number, number, number, number, number];

/** Triangles + the 12 line edges of an axis-aligned box. */
function boxParts(b: Box): { positions: number[]; indices: number[]; edges: ProjectableEdge[] } {
  const [x0, y0, z0, x1, y1, z1] = b;
  const c = (i: number): V3 => [i & 1 ? x1 : x0, i & 2 ? y1 : y0, i & 4 ? z1 : z0];
  const positions: number[] = [];
  for (let i = 0; i < 8; i++) positions.push(...c(i));
  const quads = [[0, 1, 3, 2], [4, 5, 7, 6], [0, 1, 5, 4], [2, 3, 7, 6], [0, 2, 6, 4], [1, 3, 7, 5]];
  const indices: number[] = [];
  for (const q of quads) indices.push(q[0], q[1], q[2], q[0], q[2], q[3]);
  const pairs = [[0, 1], [2, 3], [4, 5], [6, 7], [0, 2], [1, 3], [4, 6], [5, 7], [0, 4], [1, 5], [2, 6], [3, 7]];
  const edges: ProjectableEdge[] = pairs.map(([a, b2]) => ({ kind: "line", points: [...c(a), ...c(b2)] }));
  return { positions, indices, edges };
}

function merge(...parts: ReturnType<typeof boxParts>[]): { mesh: ProjectMesh; edges: ProjectableEdge[] } {
  const positions: number[] = [];
  const indices: number[] = [];
  const edges: ProjectableEdge[] = [];
  for (const p of parts) {
    const base = positions.length / 3;
    positions.push(...p.positions);
    indices.push(...p.indices.map((i) => i + base));
    edges.push(...p.edges);
  }
  return { mesh: { positions, indices }, edges };
}

const count = (r: ReturnType<typeof projectView>, type: string) => r!.entities.filter((e) => e.type === type).length;

describe("projectView", () => {
  it("an empty model and a zero direction are harmless", () => {
    expect(projectView({ positions: [], indices: [] }, [], [0, 0, 1])!.entities).toEqual([]);
    expect(projectView({ positions: [], indices: [] }, [], [0, 0, 0])).toBeNull();
  });

  it("a box from above is its rectangle; coincident top/bottom edges are drawn once", () => {
    const { mesh, edges } = merge(boxParts([0, 0, 0, 80, 30, 5]));
    const r = projectView(mesh, edges, [0, 0, 1])!;
    expect(count(r, "line")).toBe(4);
    const b = boundsOf(r.entities)!;
    expect([b.minX, b.minY]).toEqual([0, 0]);
    expect(b.maxX).toBeCloseTo(80, 3);
    expect(b.maxY).toBeCloseTo(30, 3);
  });

  it("the front view reads upright: width along X, height along Y", () => {
    const { mesh, edges } = merge(boxParts([0, 0, 0, 80, 30, 5]));
    const b = boundsOf(projectView(mesh, edges, [0, -1, 0])!.entities)!;
    expect(b.maxX).toBeCloseTo(80, 3);
    expect(b.maxY).toBeCloseTo(5, 3);
  });

  it("a step on top shows from above but is hidden from below", () => {
    const { mesh, edges } = merge(boxParts([0, 0, 0, 100, 100, 10]), boxParts([40, 40, 10, 60, 60, 20]));
    expect(count(projectView(mesh, edges, [0, 0, 1]), "line")).toBe(8);
    expect(count(projectView(mesh, edges, [0, 0, -1]), "line")).toBe(4);
  });

  it("a hole's circle stays an exact circle", () => {
    const pts: number[] = [];
    for (let i = 0; i <= 32; i++) pts.push(50 + 10 * Math.cos((i / 32) * 2 * Math.PI), 50 + 10 * Math.sin((i / 32) * 2 * Math.PI), 10);
    const hole: ProjectableEdge = { kind: "circle", points: pts, center: [50, 50, 10], radius: 10, normal: [0, 0, 1] };
    const { mesh, edges } = merge(boxParts([0, 0, 0, 100, 100, 10]));
    const r = projectView(mesh, [...edges, hole], [0, 0, 1])!;
    const circles = r.entities.filter((e) => e.type === "circle");
    expect(circles).toHaveLength(1);
    if (circles[0].type === "circle") expect(circles[0].radius).toBeCloseTo(10, 6);
  });

  it("a circle seen edge-on collapses to its diameter line", () => {
    const pts: number[] = [];
    for (let i = 0; i <= 32; i++) pts.push(10 * Math.cos((i / 32) * 2 * Math.PI), 10 * Math.sin((i / 32) * 2 * Math.PI), 0);
    const ring: ProjectableEdge = { kind: "circle", points: pts, center: [0, 0, 0], radius: 10, normal: [0, 0, 1] };
    const r = projectView({ positions: [], indices: [] }, [ring], [0, -1, 0])!;
    expect(r.entities).toHaveLength(1);
    const b = boundsOf(r.entities)!;
    expect(b.maxX - b.minX).toBeCloseTo(20, 3);
    expect(b.maxY - b.minY).toBeCloseTo(0, 6);
  });

  it("a circle half covered by a plate becomes an arc, not a polygon", () => {
    const pts: number[] = [];
    for (let i = 0; i <= 64; i++) pts.push(10 * Math.cos((i / 64) * 2 * Math.PI), 10 * Math.sin((i / 64) * 2 * Math.PI), 0);
    const ring: ProjectableEdge = { kind: "circle", points: pts, center: [0, 0, 0], radius: 10, normal: [0, 0, 1] };
    const cover = boxParts([0, -50, 5, 50, 50, 6]);
    const r = projectView({ positions: cover.positions, indices: cover.indices }, [ring], [0, 0, 1], { silhouettes: false })!;
    const arcs = r.entities.filter((e) => e.type === "arc");
    expect(arcs).toHaveLength(1);
    expect(r.entities.some((e) => e.type === "circle" || e.type === "polyline")).toBe(false);
    const a = arcs[0];
    if (a.type === "arc") {
      let sweep = a.ccw ? a.endAngle - a.startAngle : a.startAngle - a.endAngle;
      sweep = ((sweep % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
      expect(sweep).toBeGreaterThan(Math.PI - 0.15);
      expect(sweep).toBeLessThan(Math.PI + 0.15);
    }
  });

  it("an edge-on face (zero projected area) does not crash or add geometry", () => {
    const quad = { positions: [0, 0, 0, 10, 0, 0, 10, 0, 10, 0, 0, 10], indices: [0, 1, 2, 0, 2, 3] };
    const r = projectView(quad, [], [0, 0, 1])!;
    expect(r.entities).toEqual([]);
  });

  it("a cylinder seen from the side gets contour lines from its curved face", () => {
    // Cylinder axis Z, radius 10, 16 facets, one curved face (id 0).
    const positions: number[] = [];
    const indices: number[] = [];
    const normals: number[] = [];
    const N = 16;
    for (let i = 0; i < N; i++) {
      const a = (i / N) * 2 * Math.PI;
      const x = Math.cos(a), y = Math.sin(a);
      positions.push(10 * x, 10 * y, 0, 10 * x, 10 * y, 20);
      normals.push(x, y, 0, x, y, 0);
    }
    for (let i = 0; i < N; i++) {
      const a = 2 * i, b = 2 * i + 1, c = 2 * ((i + 1) % N), d = 2 * ((i + 1) % N) + 1;
      indices.push(a, c, d, a, d, b);
    }
    const mesh: ProjectMesh = {
      positions,
      indices,
      normals,
      faceOfTriangle: new Array(indices.length / 3).fill(0),
      facePlanar: [0],
    };
    const r = projectView(mesh, [], [1, 0, 0])!; // looking along X: contour at y = +-10
    const b = boundsOf(r.entities)!;
    expect(r.entities.length).toBeGreaterThan(0);
    expect(b.maxX).toBeCloseTo(20, 3);
    expect(b.maxY).toBeCloseTo(20, 3);
  });
});
