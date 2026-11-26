import { describe, expect, it } from "vitest";
import { parse3mf, parseStl } from "@sketchor/core";
import { buildModel } from "./buildModel";
import { exportBytes, exportFileName, exportProblems, modelToMeshParts } from "./exportMesh";

/**
 * Why (F-11): the 3D view exports what is on screen. Hidden parts must stay
 * out, each part's indices must be rebased onto its own vertices, and the
 * viewer's stand-in grey must not be written as if the file had coloured
 * the part.
 */

/** A closed tetrahedron at x offset `dx`, wound outward. */
function tet(dx: number) {
  const v = [[0, 0, 0], [10, 0, 0], [0, 10, 0], [0, 0, 10]].map((p) => [p[0] + dx, p[1], p[2]]);
  return { position: v.flat(), index: [0, 2, 1, 0, 1, 3, 0, 3, 2, 1, 2, 3] };
}
function model() {
  const a = tet(0), b = tet(30);
  return buildModel(
    {
      success: true,
      meshes: [
        { name: "Plain", attributes: { position: { array: a.position } }, index: { array: a.index } },
        { name: "Red", color: [1, 0, 0], attributes: { position: { array: b.position } }, index: { array: b.index } },
      ],
      root: { name: "asm", children: [{ name: "Plain", meshes: [0] }, { name: "Red", meshes: [1] }] },
    } as never,
    "bracket.step",
    "hash",
    "step",
  );
}

describe("modelToMeshParts", () => {
  it("exports the visible parts, rebased, with the file's colours only", () => {
    const m = model();
    const parts = modelToMeshParts(m, new Set());
    expect(parts.map((p) => p.name)).toEqual(["Plain", "Red"]);
    for (const p of parts) expect(Math.max(...p.indices)).toBeLessThan(p.positions.length / 3);
    expect(parts[0].colors).toBeUndefined(); // the viewer's grey isn't the part's colour
    expect(Array.from(parts[1].colors!.subarray(0, 3))).toEqual([255, 0, 0]);
    expect(modelToMeshParts(m, new Set([0])).map((p) => p.name)).toEqual(["Red"]);
  });

  it("writes a 3MF and an STL that read back at the same size, without warnings for closed parts", async () => {
    const m = model();
    const parts = modelToMeshParts(m, new Set());
    expect(exportProblems(parts)).toEqual([]);
    const back = (await parse3mf(await exportBytes(m, parts, "3mf", "mm"))).parts;
    expect(back.map((p) => p.name)).toEqual(["Plain", "Red"]);
    const maxX = (ps: { positions: Float32Array }[]) => Math.max(...ps.flatMap((p) => Array.from(p.positions.filter((_, i) => i % 3 === 0))));
    expect(maxX(back)).toBeCloseTo(40, 4);
    const inch = parseStl(await exportBytes(m, parts, "stl", "in")).parts;
    expect(maxX(inch)).toBeCloseTo(40 / 25.4, 5);
    expect(inch[0].colors).toBeDefined(); // binary STL carries the red part's facet colour
  });

  it("names the file after the model and reports open parts", () => {
    const m = model();
    expect(exportFileName(m, "3mf")).toBe("bracket.3mf");
    expect(exportFileName(m, "stl-ascii")).toBe("bracket.stl");
    const open = modelToMeshParts(m, new Set()).map((p) => ({ ...p, indices: p.indices.slice(3) }));
    expect(exportProblems(open)[0]).toMatch(/^Plain: not closed/);
  });
});

describe("repairParts", () => {
  it("repairs an open part for export and names what it did", async () => {
    const { repairParts } = await import("./exportMesh");
    const m = model();
    const open = modelToMeshParts(m, new Set()).map((p) => ({ ...p, indices: p.indices.slice(3) }));
    const r = repairParts(open);
    expect(exportProblems(r.parts)).toEqual([]);
    expect(r.summary[0]).toBe("Plain: filled 1 hole");
  });
});
