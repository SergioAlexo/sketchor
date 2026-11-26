import { describe, expect, it } from "vitest";
import { buildModel } from "./buildModel";
import { isUnitless, MM_PER_UNIT, scaleModel, unitHint } from "./meshUnits";

/**
 * Why (F-11): an STL has no unit. Reading an inch part as millimetres makes
 * it 25.4× too small, so the viewer lets the user re-read it — and then
 * every length, area and volume the viewer measures (and the export writes)
 * must scale by the right power, while directions and topology stay put.
 */
function cubeModel(size: number, format: "stl" | "3mf" = "stl") {
  const v = [[0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0], [0, 0, 1], [1, 0, 1], [1, 1, 1], [0, 1, 1]].map((p) => p.map((c) => c * size));
  const quads = [[0, 3, 2, 1], [4, 5, 6, 7], [0, 1, 5, 4], [2, 3, 7, 6], [1, 2, 6, 5], [3, 0, 4, 7]];
  const index = quads.flatMap((q) => [q[0], q[1], q[2], q[0], q[2], q[3]]);
  return buildModel({ success: true, meshes: [{ name: "c", attributes: { position: { array: v.flat() } }, index: { array: index } }], root: { name: "r", meshes: [0] } } as never, `c.${format}`, "h", format);
}

describe("scaleModel", () => {
  it("scales lengths by k, areas by k², volumes by k³, and leaves directions alone", () => {
    const m = cubeModel(1);
    const k = MM_PER_UNIT.in;
    const s = scaleModel(m, k);
    expect(s.bounds.max[0]).toBeCloseTo(25.4, 4);
    expect(s.parts[0].area).toBeCloseTo(m.parts[0].area * k * k, 3);
    expect(s.parts[0].volume).toBeCloseTo(m.parts[0].volume * k ** 3, 1);
    // The face and edge tables, where topology was extracted (worker models have it; this bare one may not).
    for (let i = 0; i < m.faces.area.length; i++) expect(s.faces.area[i]).toBeCloseTo(m.faces.area[i] * k * k, 3);
    for (let i = 0; i < m.edgeTable.length.length; i++) expect(s.edgeTable.length[i]).toBeCloseTo(m.edgeTable.length[i] * k, 4);
    expect(s.normals).toBe(m.normals);
    expect(s.indices).toBe(m.indices);
    expect(scaleModel(m, 1)).toBe(m);
  });
});

describe("unitHint", () => {
  it("nudges when a unitless model is implausibly small or large, and not otherwise", () => {
    expect(unitHint(cubeModel(1.5))).toMatch(/only 1.5 mm across.*inches or metres/);
    expect(unitHint(cubeModel(8000))).toMatch(/8.00 m across/);
    expect(unitHint(cubeModel(40))).toBeNull();
    expect(unitHint(cubeModel(1.5, "3mf"))).toBeNull(); // 3MF states its unit
  });
  it("knows which formats have no unit", () => {
    expect(["stl", "obj", "ply"].every((f) => isUnitless(f as never))).toBe(true);
    expect(["3mf", "step", "glb"].some((f) => isUnitless(f as never))).toBe(false);
  });
});
