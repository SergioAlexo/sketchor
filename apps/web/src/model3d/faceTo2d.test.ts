import { describe, expect, it } from "vitest";
import { boundsOf } from "@sketchor/core";
import { buildModel } from "./buildModel";
import { faceEdges, outlineOfFace } from "./faceTo2d";
import type { OcctMesh, OcctResult } from "./types";

/**
 * The bridge from the topology tables to the pure projection. If the segment
 * walk or the edge-to-face lookup is off, a face outline silently includes a
 * neighbour's edges or misses a hole, and the laser cuts the wrong shape.
 */

/** A w x d x h box (faces: +Z, -Z, +X, -X, +Y, -Y), each face with its own vertices. */
function box(w: number, d: number, h: number): OcctMesh {
  const faces: number[][][] = [
    [[0, 0, h], [w, 0, h], [w, d, h], [0, d, h]],
    [[0, 0, 0], [0, d, 0], [w, d, 0], [w, 0, 0]],
    [[w, 0, 0], [w, d, 0], [w, d, h], [w, 0, h]],
    [[0, 0, 0], [0, 0, h], [0, d, h], [0, d, 0]],
    [[0, d, 0], [0, d, h], [w, d, h], [w, d, 0]],
    [[0, 0, 0], [w, 0, 0], [w, 0, h], [0, 0, h]],
  ];
  const position: number[] = [];
  const index: number[] = [];
  const brep_faces: OcctMesh["brep_faces"] = [];
  faces.forEach((q, f) => {
    for (const p of q) position.push(...p);
    index.push(f * 4, f * 4 + 1, f * 4 + 2, f * 4, f * 4 + 2, f * 4 + 3);
    brep_faces.push({ first: f * 2, last: f * 2 + 1, color: null });
  });
  return { name: "Box", brep_faces, attributes: { position: { array: position } }, index: { array: index } };
}

function disc(radius: number, sides = 48): OcctMesh {
  const position: number[] = [0, 0, 0];
  const index: number[] = [];
  for (let i = 0; i < sides; i++) position.push(radius * Math.cos((i / sides) * 2 * Math.PI), radius * Math.sin((i / sides) * 2 * Math.PI), 0);
  for (let i = 0; i < sides; i++) index.push(0, 1 + i, 1 + ((i + 1) % sides));
  return { name: "Disc", brep_faces: [{ first: 0, last: sides - 1, color: null }], attributes: { position: { array: position } }, index: { array: index } };
}

const model = (m: OcctMesh) => buildModel({ success: true, meshes: [m] } as OcctResult, "t.step", "h", "step");

describe("outlineOfFace", () => {
  it("a box's top face is its true width x depth rectangle at the origin", () => {
    const m = model(box(80, 30, 5));
    expect(faceEdges(m, 0)).toHaveLength(4);
    const r = outlineOfFace(m, 0);
    if ("error" in r) throw new Error(r.error);
    const b = boundsOf(r.entities)!;
    expect([b.minX, b.minY].map((v) => Math.abs(v) < 1e-4)).toEqual([true, true]);
    expect(b.maxX).toBeCloseTo(80, 3);
    expect(b.maxY).toBeCloseTo(30, 3);
    expect(r.entities).toHaveLength(1); // joined, closed
  });

  it("the side face is the other pair of dimensions", () => {
    const m = model(box(80, 30, 5));
    const r = outlineOfFace(m, 4); // +Y face: 80 x 5
    if ("error" in r) throw new Error(r.error);
    const b = boundsOf(r.entities)!;
    expect(Math.max(b.maxX, b.maxY)).toBeCloseTo(80, 3);
    expect(Math.min(b.maxX, b.maxY)).toBeCloseTo(5, 3);
  });

  it("a circular face becomes one circle of the right radius", () => {
    const m = model(disc(12.5));
    const r = outlineOfFace(m, 0);
    if ("error" in r) throw new Error(r.error);
    expect(r.entities).toHaveLength(1);
    const c = r.entities[0];
    expect(c.type === "circle" && c.radius).toBeCloseTo(12.5, 2);
  });

  it("refuses a missing face", () => {
    const m = model(box(1, 1, 1));
    expect("error" in outlineOfFace(m, 99)).toBe(true);
    expect("error" in outlineOfFace(m, -1)).toBe(true);
  });
});
