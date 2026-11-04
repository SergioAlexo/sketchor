import { describe, expect, it } from "vitest";
import rhino3dm from "rhino3dm";
import { buildModel } from "./buildModel";
import { rhinoToOcct } from "./rhino3dm";

/**
 * Real rhino3dm (the same wasm the worker loads) writes a .3dm and the
 * converter reads it back. What breaks for a user if this regresses: a part
 * arrives in the wrong size (unit scale), as one blob instead of faces
 * (no face picking, no "To 2D"), or a file with nothing drawable fails with
 * no explanation.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
// rhino3dm's own typings leave most of the API as `void`, so the tests talk to it untyped.
let rhPromise: Promise<any> | null = null;
const rh = (): Promise<any> => (rhPromise ??= rhino3dm() as Promise<any>);

/** A w x d x h box as 12 triangles. */
function boxMesh(r: any, w: number, d: number, h: number) {
  const m = new r.Mesh();
  const v = [[0, 0, 0], [w, 0, 0], [w, d, 0], [0, d, 0], [0, 0, h], [w, 0, h], [w, d, h], [0, d, h]];
  for (const p of v) m.vertices().add(p[0], p[1], p[2]);
  const q = [[0, 3, 2, 1], [4, 5, 6, 7], [0, 1, 5, 4], [1, 2, 6, 5], [2, 3, 7, 6], [3, 0, 4, 7]];
  for (const [a, b, c, e] of q) {
    m.faces().addTriFace(a, b, c);
    m.faces().addTriFace(a, c, e);
  }
  return m;
}

describe("rhinoToOcct", () => {
  it("reads a mesh object into per-face parts at true size", async () => {
    const r = await rh();
    const f = new r.File3dm();
    const at = new r.ObjectAttributes();
    at.name = "Plate";
    f.objects().addMesh(boxMesh(r, 80, 30, 5), at);
    const { result, warnings } = rhinoToOcct(r, f.toByteArray(), "plate.3dm");
    expect(warnings).toEqual([]);
    const model = buildModel(result, "plate.3dm", "h", "3dm");
    expect(model.parts[0].name).toBe("Plate");
    expect(model.faces.area.length).toBe(6);
    expect(model.bounds.max).toEqual([80, 30, 5]);
    expect(Math.abs(model.parts[0].volume)).toBeCloseTo(80 * 30 * 5, 3);
  });

  it("scales to millimetres from the file's unit system", async () => {
    const r = await rh();
    const f = new r.File3dm();
    f.settings().modelUnitSystem = r.UnitSystem.Inches;
    f.objects().addMesh(boxMesh(r, 1, 1, 1), null);
    const { result } = rhinoToOcct(r, f.toByteArray(), "u.3dm");
    const model = buildModel(result, "u.3dm", "h", "3dm");
    expect(model.bounds.max[0]).toBeCloseTo(25.4, 4);
  });

  it("skips a sphere Brep with no render mesh and says so; counts what it cannot draw", async () => {
    const r = await rh();
    const f = new r.File3dm();
    f.objects().addSphere(new r.Sphere([0, 0, 0], 5), null);
    f.objects().addCircle(new r.Circle(3), null);
    const { result, warnings } = rhinoToOcct(r, f.toByteArray(), "x.3dm");
    expect(result.meshes).toHaveLength(0);
    expect(warnings.length).toBeGreaterThan(0);
  });

  it("an empty file gives an empty result, and garbage bytes never hang", async () => {
    const r = await rh();
    const empty = rhinoToOcct(r, new r.File3dm().toByteArray(), "e.3dm");
    expect(empty.result.meshes).toHaveLength(0);
    // Garbage either throws or reads as nothing - both are handled by the worker.
    try {
      expect(rhinoToOcct(r, new Uint8Array([1, 2, 3, 4]), "bad.3dm").result.meshes).toHaveLength(0);
    } catch (e) {
      expect(e).toBeTruthy();
    }
  });

  it("keeps each Brep face as one face, flipping reversed ones (fake module: rhino3dm has no mesher to build one)", () => {
    const val = (value: number) => ({ value });
    const quad = (z: number) => ({
      vertices: () => ({ count: 4, get: (i: number) => [[0, 0, z], [10, 0, z], [10, 10, z], [0, 10, z]][i] }),
      faces: () => ({ count: 1, get: () => [0, 1, 2, 3] }),
    });
    const brep = {
      objectType: val(16),
      faces: () => ({
        count: 2,
        get: (i: number) => ({ orientationIsReversed: i === 1, getMesh: () => quad(i) }),
      }),
    };
    const fake = {
      File3dm: {
        fromByteArray: () => ({
          settings: () => ({ modelUnitSystem: val(2) }),
          objects: () => ({ count: 1, get: () => ({ geometry: () => brep, attributes: () => ({ name: "B", visible: true }) }) }),
          delete: () => undefined,
        }),
      },
      MeshType: { Any: val(4) },
      ObjectType: { Brep: val(16), Mesh: val(32), Extrusion: val(1073741824) },
      UnitSystem: { Millimeters: val(2) },
    };
    const { result } = rhinoToOcct(fake, new Uint8Array(1), "b.3dm");
    const m = result.meshes![0];
    expect(m.brep_faces).toHaveLength(2);
    expect(m.brep_faces![0]).toMatchObject({ first: 0, last: 1 });
    expect(m.brep_faces![1]).toMatchObject({ first: 2, last: 3 });
    // reversed face: winding swapped
    expect(Array.from(m.index!.array as ArrayLike<number>).slice(6, 9)).toEqual([4, 6, 5]);
  });
});
