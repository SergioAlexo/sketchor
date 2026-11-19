import { describe, expect, it } from "vitest";
import { buildModel } from "./buildModel";
import type { OcctMesh, OcctResult } from "./types";

/**
 * buildModel is what turns OpenCascade's per-mesh output into the single
 * merged buffer the viewer draws and the cache stores. If it regresses, a
 * user sees a model with the wrong parts highlighted (offsets), missing or
 * spurious outline edges, mis-coloured faces, or — worst — a crash on a
 * corrupt file, since it runs on whatever a STEP importer hands it.
 */

/** A unit cube as occt-import-js would tessellate it: 6 faces, each with its own 4 vertices. */
function cube(offset = 0, name = "Cube", color?: [number, number, number]): OcctMesh {
  const faces: number[][][] = [
    // +Z
    [[0, 0, 1], [1, 0, 1], [1, 1, 1], [0, 1, 1]],
    // -Z
    [[0, 0, 0], [0, 1, 0], [1, 1, 0], [1, 0, 0]],
    // +X
    [[1, 0, 0], [1, 1, 0], [1, 1, 1], [1, 0, 1]],
    // -X
    [[0, 0, 0], [0, 0, 1], [0, 1, 1], [0, 1, 0]],
    // +Y
    [[0, 1, 0], [0, 1, 1], [1, 1, 1], [1, 1, 0]],
    // -Y
    [[0, 0, 0], [1, 0, 0], [1, 0, 1], [0, 0, 1]],
  ];
  const position: number[] = [];
  const index: number[] = [];
  const brep_faces: OcctMesh["brep_faces"] = [];
  faces.forEach((quad, f) => {
    const base = f * 4;
    for (const [x, y, z] of quad) position.push(x + offset, y, z);
    index.push(base, base + 1, base + 2, base, base + 2, base + 3);
    brep_faces.push({ first: f * 2, last: f * 2 + 1, color: null });
  });
  return { name, ...(color ? { color } : {}), brep_faces, attributes: { position: { array: position } }, index: { array: index } };
}

function result(meshes: OcctMesh[], root?: OcctResult["root"]): OcctResult {
  return { success: true, meshes, root: root ?? { name: "root", meshes: meshes.map((_, i) => i), children: [] } };
}

describe("buildModel merging", () => {
  it("concatenates meshes into one buffer with part ranges that index back into it", () => {
    const m = buildModel(result([cube(0, "A"), cube(5, "B")]), "two.step", "h", "step");
    expect(m.parts.map((p) => p.name)).toEqual(["A", "B"]);
    expect(m.positions.length).toBe(2 * 24 * 3);
    expect(m.indices.length).toBe(2 * 36);
    expect(m.triangleCount).toBe(24);
    const b = m.parts[1];
    expect(b.vertexStart).toBe(24);
    expect(b.indexStart).toBe(36);
    // Every index of part B lands inside part B's vertex range — the
    // property that keeps selection and picking on the right part.
    for (let i = b.indexStart; i < b.indexStart + b.indexCount; i++) {
      expect(m.indices[i]).toBeGreaterThanOrEqual(b.vertexStart);
      expect(m.indices[i]).toBeLessThan(b.vertexStart + b.vertexCount);
    }
    expect(m.bounds).toEqual({ min: [0, 0, 0], max: [6, 1, 1] });
    expect(b.bounds).toEqual({ min: [5, 0, 0], max: [6, 1, 1] });
  });

  it("computes unit normals when the importer gives none", () => {
    const m = buildModel(result([cube()]), "c.step", "h", "step");
    for (let i = 0; i < m.normals.length; i += 3) {
      expect(Math.hypot(m.normals[i], m.normals[i + 1], m.normals[i + 2])).toBeCloseTo(1, 6);
    }
    // The +Z face's vertices (the first four) face +Z.
    for (let v = 0; v < 4; v++) expect(m.normals[v * 3 + 2]).toBeCloseTo(1, 6);
  });

  it("bakes part colour per vertex, with face colours overriding it", () => {
    const mesh = cube(0, "C", [1, 0, 0]);
    mesh.brep_faces![0].color = [0, 0, 1];
    const m = buildModel(result([mesh]), "c.step", "h", "step");
    // Face 0 (+Z) is blue…
    expect(Array.from(m.colors.subarray(0, 3))).toEqual([0, 0, 255]);
    // …the rest of the part is red.
    expect(Array.from(m.colors.subarray(4 * 3, 4 * 3 + 3))).toEqual([255, 0, 0]);
  });
});

describe("B-rep edge extraction", () => {
  it("draws exactly the 12 edges of a cube — where faces meet, not across each face's diagonal", () => {
    const m = buildModel(result([cube()]), "c.step", "h", "step");
    expect(m.edges.length / 6).toBe(12);
    expect(m.parts[0].edgeCount).toBe(12);
    // Every segment has unit length: a cube edge, never a √2 diagonal.
    for (let i = 0; i < m.edges.length; i += 6) {
      const len = Math.hypot(m.edges[i + 3] - m.edges[i], m.edges[i + 4] - m.edges[i + 1], m.edges[i + 5] - m.edges[i + 2]);
      expect(len).toBeCloseTo(1, 6);
    }
  });

  it("draws the open boundary of a sheet body", () => {
    // A single square face: 4 boundary edges, no interior diagonal.
    const sheet: OcctMesh = {
      name: "Sheet",
      brep_faces: [{ first: 0, last: 1, color: null }],
      attributes: { position: { array: [0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0] } },
      index: { array: [0, 1, 2, 0, 2, 3] },
    };
    const m = buildModel(result([sheet]), "s.step", "h", "step");
    expect(m.edges.length / 6).toBe(4);
  });

  it("without face info, only open boundaries are edges (a closed body gets none)", () => {
    const mesh = cube();
    delete mesh.brep_faces;
    const m = buildModel(result([mesh]), "c.step", "h", "step");
    expect(m.edges.length).toBe(0);
  });
});

describe("assembly tree", () => {
  it("hoists STEP's one-part product wrappers and keeps the better name", () => {
    const meshes = [cube(0, "Part"), cube(3, "Part"), cube(6, "BOLT")];
    const root = {
      name: "ASM",
      meshes: [],
      children: [
        { name: "BRACKET", meshes: [0], children: [] },
        {
          name: "SUB",
          meshes: [],
          children: [
            { name: "PLATE", meshes: [1], children: [] },
            { name: "BOLT", meshes: [2], children: [] },
          ],
        },
      ],
    };
    const m = buildModel(result(meshes, root), "a.step", "h", "step");
    expect(m.tree.name).toBe("ASM");
    expect(m.tree.parts).toEqual([0]);
    expect(m.parts[0].name).toBe("BRACKET");
    expect(m.tree.children.map((c) => c.name)).toEqual(["SUB"]);
    expect(m.tree.children[0].parts).toEqual([1, 2]);
    expect(m.parts[1].name).toBe("PLATE");
    expect(m.parts[2].name).toBe("BOLT");
  });

  it("lists parts the hierarchy never references, at the root", () => {
    const m = buildModel(result([cube(0, "A"), cube(3, "B")], { name: "R", meshes: [0], children: [] }), "a.step", "h", "step");
    expect([...m.tree.parts].sort()).toEqual([0, 1]);
  });

  it("does not recurse forever on a cyclic hierarchy", () => {
    const node: { name: string; meshes: number[]; children: unknown[] } = { name: "loop", meshes: [0], children: [] };
    node.children.push(node);
    const m = buildModel(result([cube()], node as OcctResult["root"]), "a.step", "h", "step");
    expect(m.parts).toHaveLength(1);
  });
});

describe("malformed importer output", () => {
  it("returns an empty model for a failed or empty result rather than throwing", () => {
    for (const r of [
      { success: false } as OcctResult,
      { success: true, meshes: [] },
      {} as OcctResult,
      { success: true, meshes: [{}] as OcctMesh[] },
    ]) {
      const m = buildModel(r, "x.step", "h", "step");
      expect(m.parts).toHaveLength(0);
      expect(m.triangleCount).toBe(0);
      expect(m.bounds).toEqual({ min: [0, 0, 0], max: [0, 0, 0] });
    }
  });

  it("drops triangles whose indices point outside the vertex array", () => {
    const mesh = cube();
    const idx = mesh.index!.array as number[];
    idx[0] = 999; // corrupt the first triangle
    idx[4] = -1; // and the second
    const m = buildModel(result([mesh]), "c.step", "h", "step");
    expect(m.triangleCount).toBe(10);
    for (const i of m.indices) expect(i).toBeLessThan(24);
  });

  it("tolerates truncated or non-numeric attribute arrays", () => {
    const mesh = cube();
    (mesh.attributes!.position!.array as number[]).length = 7; // not a multiple of 3, too short for the index
    expect(() => buildModel(result([mesh]), "c.step", "h", "step")).not.toThrow();
    const weird: OcctMesh = {
      attributes: { position: { array: ["a", null, undefined, 1, 2, 3, 4, 5, 6] as unknown as number[] } },
      index: { array: [0, 1, 2] },
    };
    const m = buildModel(result([weird]), "w.step", "h", "step");
    expect(m.parts).toHaveLength(1);
    expect(Number.isNaN(m.positions[0])).toBe(false);
  });
});
