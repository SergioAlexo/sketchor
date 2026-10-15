/**
 * Why: F-05 feeds mesh files through buildModel/topology as if they were
 * B-rep. If face segmentation and topology disagree, picking and measure on an
 * STL show the wrong faces/edges.
 */
import { describe, expect, it } from "vitest";
import { parseMesh, segmentMesh } from "@sketchor/core";
import { buildModel } from "./buildModel";
import { modelFormatOf } from "./stepImport";
import type { OcctResult } from "./types";

const OBJ = [
  "v 0 0 0", "v 2 0 0", "v 2 3 0", "v 0 3 0", "v 0 0 4", "v 2 0 4", "v 2 3 4", "v 0 3 4",
  "f 1 4 3 2", "f 5 6 7 8", "f 1 2 6 5", "f 2 3 7 6", "f 3 4 8 7", "f 4 1 5 8",
].join("\n");

describe("mesh -> Model3D", () => {
  it("maps extensions to formats", () => {
    expect(modelFormatOf("a.STL")).toBe("stl");
    expect(modelFormatOf("a.obj")).toBe("obj");
    expect(modelFormatOf("a.ply")).toBe("ply");
  });
  it("a box mesh gets 6 faces, 12 edges, correct volume", () => {
    const parsed = parseMesh("obj", new TextEncoder().encode(OBJ), "box");
    const meshes = parsed.parts.map((p) => segmentMesh(p));
    const result: OcctResult = { success: true, meshes, root: { name: "box", meshes: [0] } };
    const m = buildModel(result, "box.obj", "h", "obj");
    expect(m.faces.area.length).toBe(6);
    expect(m.edgeTable.length.length).toBe(12);
    expect(Math.abs(m.parts[0].volume)).toBeCloseTo(24, 3);
    expect(m.triangleCount).toBe(12);
  });
});
