import { describe, expect, it } from "vitest";
import { buildModel } from "./buildModel";
import { pickEdge, pickVertex, pointToSegment2d, type Projector } from "./picking";
import { vertexPoint } from "./measure";
import type { OcctMesh, OcctResult } from "./types";

/**
 * Aiming. Everything the 3D viewer can measure has to be clickable first,
 * and a CAD user aims at a corner expecting the corner — not the edge it
 * sits on, and never the edge on the far side of the solid. The rules that
 * make that true are the aperture, the vertex-beats-edge order, and the
 * depth cutoff; the camera is the one part of them that can't be unit
 * tested, so it's handed in as a projector and everything else is.
 */

/** A unit cube with per-face vertices (what OpenCascade emits). */
function cube(): OcctMesh {
  const quads: number[][][] = [
    [[0, 0, 1], [1, 0, 1], [1, 1, 1], [0, 1, 1]],
    [[0, 0, 0], [0, 1, 0], [1, 1, 0], [1, 0, 0]],
    [[1, 0, 0], [1, 1, 0], [1, 1, 1], [1, 0, 1]],
    [[0, 0, 0], [0, 0, 1], [0, 1, 1], [0, 1, 0]],
    [[0, 1, 0], [0, 1, 1], [1, 1, 1], [1, 1, 0]],
    [[0, 0, 0], [1, 0, 0], [1, 0, 1], [0, 0, 1]],
  ];
  const position: number[] = [];
  const index: number[] = [];
  const brep_faces: OcctMesh["brep_faces"] = [];
  quads.forEach((quad, f) => {
    const base = f * 4;
    for (const [x, y, z] of quad) position.push(x, y, z);
    index.push(base, base + 1, base + 2, base, base + 2, base + 3);
    brep_faces.push({ first: f * 2, last: f * 2 + 1, color: null });
  });
  return { name: "Cube", brep_faces, attributes: { position: { array: position } }, index: { array: index } };
}

const model = buildModel({ success: true, meshes: [cube()] } as OcctResult, "t.step", "h", "step");

/**
 * A camera looking down -Y: X goes right, Z goes up, and the model's Y
 * becomes depth, so "the far side of the cube" is a real thing here.
 * 100 px per unit, origin at (50, 350).
 */
const project: Projector = (p) => ({ x: 50 + p[0] * 100, y: 350 - p[2] * 100, visible: true, depth: 10 + p[1] });

const open = { tolPx: 8, maxDepth: Infinity };

describe("vertex picking", () => {
  it("grabs the corner under the cursor and nothing else", () => {
    const i = pickVertex(model, 0, { x: 150, y: 250 }, project, open); // world (1, ?, 1)
    expect(i).not.toBeNull();
    const p = vertexPoint(model, i!);
    expect(p[0]).toBeCloseTo(1, 6);
    expect(p[2]).toBeCloseTo(1, 6);
  });

  it("returns nothing when the cursor is out in space", () => {
    expect(pickVertex(model, 0, { x: 100, y: 300 }, project, open)).toBeNull();
  });

  it("prefers the nearer of two corners that project on top of each other", () => {
    // (0,0,0) and (0,1,0) land on the same pixel; only the front one may win.
    const i = pickVertex(model, 0, { x: 50, y: 350 }, project, open);
    expect(vertexPoint(model, i!)[1]).toBeCloseTo(0, 6);
  });

  it("honours the depth cutoff, so a click can't reach through the solid", () => {
    // Nothing nearer than the front face (depth 10) plus a hair.
    const shallow = pickVertex(model, 0, { x: 50, y: 350 }, project, { tolPx: 8, maxDepth: 10.1 });
    expect(vertexPoint(model, shallow!)[1]).toBeCloseTo(0, 6);
    // With everything rejected there is no pick at all, rather than a far one.
    expect(pickVertex(model, 0, { x: 50, y: 350 }, project, { tolPx: 8, maxDepth: 9 })).toBeNull();
  });

  it("ignores a part that isn't there", () => {
    expect(pickVertex(model, 7, { x: 50, y: 350 }, project, open)).toBeNull();
  });
});

describe("edge picking", () => {
  it("grabs the edge the cursor is near, mid-span", () => {
    // Half way up the left vertical edge at x=0: well away from any corner.
    const e = pickEdge(model, 0, { x: 50, y: 300 }, project, open);
    expect(e).not.toBeNull();
    expect(model.edgeTable.length[e!]).toBeCloseTo(1, 6);
  });

  it("returns nothing when the cursor is a long way from every edge", () => {
    expect(pickEdge(model, 0, { x: 300, y: 300 }, project, open)).toBeNull();
  });

  it("is an aperture, not a nearest-edge search", () => {
    // 20 px off the silhouette: inside a generous tolerance, outside a tight one.
    expect(pickEdge(model, 0, { x: 70, y: 300 }, project, { tolPx: 30, maxDepth: Infinity })).not.toBeNull();
    expect(pickEdge(model, 0, { x: 70, y: 300 }, project, { tolPx: 4, maxDepth: Infinity })).toBeNull();
  });

  it("skips segments behind the camera rather than projecting nonsense", () => {
    const behind: Projector = (p) => ({ ...project(p), visible: false });
    expect(pickEdge(model, 0, { x: 50, y: 300 }, behind, open)).toBeNull();
  });

  it("names the whole edge, not the tessellation segment", () => {
    // Every segment of an edge resolves to the same edge id, which is what
    // makes "click anywhere along the rim" report one length.
    const a = pickEdge(model, 0, { x: 50, y: 320 }, project, open);
    const b = pickEdge(model, 0, { x: 50, y: 280 }, project, open);
    expect(a).toBe(b);
  });
});

describe("pointToSegment2d", () => {
  it("measures to the nearest point on the span, clamped to the ends", () => {
    expect(pointToSegment2d({ x: 5, y: 3 }, { x: 0, y: 0 }, { x: 10, y: 0 })).toBeCloseTo(3, 9);
    expect(pointToSegment2d({ x: -4, y: 3 }, { x: 0, y: 0 }, { x: 10, y: 0 })).toBeCloseTo(5, 9);
    expect(pointToSegment2d({ x: 14, y: 3 }, { x: 0, y: 0 }, { x: 10, y: 0 })).toBeCloseTo(5, 9);
  });

  it("treats a degenerate segment as a point instead of dividing by zero", () => {
    expect(pointToSegment2d({ x: 3, y: 4 }, { x: 0, y: 0 }, { x: 0, y: 0 })).toBeCloseTo(5, 9);
  });
});
