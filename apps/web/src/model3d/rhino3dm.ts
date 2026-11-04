import { segmentMesh } from "@sketchor/core";
import type { OcctMesh, OcctResult } from "./types";

/**
 * F-06: Rhino `.3dm` files, read with rhino3dm (McNeel, MIT; wasm) and turned
 * into the occt-import-js result shape so `buildModel`/`topology.ts` need no
 * special case.
 *
 * - **Breps** use the render meshes Rhino stored per face, and each Brep face
 *   stays one face (exact B-rep faces, so face picking and "To 2D" work as
 *   they do for STEP). A Brep saved without render meshes cannot be shown -
 *   rhino3dm has no mesher - and is counted in the warnings.
 * - **Meshes** and **extrusions** go through `segmentMesh` (dihedral faces).
 * - Units are scaled to millimetres from the file's model unit system.
 * - Curves, points, SubD, blocks and annotations are not shown (counted).
 *
 * The rhino3dm module is passed in so this stays testable under Node and the
 * 2.5 MB wasm is only fetched when a .3dm is opened.
 */

/** The slice of rhino3dm this file uses (its own typings are partly `void`). */
/* eslint-disable @typescript-eslint/no-explicit-any */
export type Rhino = any;

const MM_PER_UNIT: Record<string, number> = {
  Angstroms: 1e-7,
  Nanometers: 1e-6,
  Microns: 1e-3,
  Millimeters: 1,
  Centimeters: 10,
  Decimeters: 100,
  Meters: 1000,
  Dekameters: 1e4,
  Hectometers: 1e5,
  Kilometers: 1e6,
  Microinches: 2.54e-5,
  Mils: 0.0254,
  Inches: 25.4,
  Feet: 304.8,
  Yards: 914.4,
  Miles: 1609344,
};

/** Millimetres per model unit of an opened file (1 when the unit is unknown or "none"). */
export function mmPerUnit(rh: Rhino, file: any): number {
  try {
    const u = file.settings().modelUnitSystem;
    const v = u?.value ?? u;
    for (const [name, mm] of Object.entries(MM_PER_UNIT)) {
      const e = rh.UnitSystem?.[name];
      if (e !== undefined && (e.value ?? e) === v) return mm;
    }
  } catch {
    /* fall through */
  }
  return 1;
}

interface Acc {
  positions: number[];
  index: number[];
  faces: { first: number; last: number; color: null }[];
}

/** Appends a Rhino mesh (triangles and quads) scaled by `k`; returns triangles added. */
function appendMesh(acc: Acc, mesh: any, k: number, reversed: boolean): number {
  const vs = mesh.vertices();
  const fs = mesh.faces();
  const vn = vs.count as number;
  const fn = fs.count as number;
  if (!(vn > 0) || !(fn > 0)) return 0;
  const base = acc.positions.length / 3;
  for (let i = 0; i < vn; i++) {
    const p = vs.get(i);
    acc.positions.push(p[0] * k, p[1] * k, p[2] * k);
  }
  let tris = 0;
  const push = (a: number, b: number, c: number) => {
    if (a >= vn || b >= vn || c >= vn) return;
    if (reversed) acc.index.push(base + a, base + c, base + b);
    else acc.index.push(base + a, base + b, base + c);
    tris += 1;
  };
  for (let i = 0; i < fn; i++) {
    const f = fs.get(i) as number[];
    push(f[0], f[1], f[2]);
    if (f[3] !== f[2]) push(f[0], f[2], f[3]);
  }
  return tris;
}

export interface RhinoImport {
  result: OcctResult;
  warnings: string[];
}

/** Reads a 3dm into an occt-style result. Throws only when the bytes are not a 3dm at all. */
export function rhinoToOcct(rh: Rhino, bytes: Uint8Array, fileName: string): RhinoImport {
  const file = rh.File3dm.fromByteArray(bytes);
  if (!file) throw new Error("not a readable 3dm file");
  const warnings: string[] = [];
  const meshes: OcctMesh[] = [];
  const skipped = new Map<string, number>();
  let noRender = 0;
  try {
    const k = mmPerUnit(rh, file);
    const objs = file.objects();
    const count = objs.count as number;
    const anyType = rh.MeshType.Any;
    for (let i = 0; i < count; i++) {
      const obj = objs.get(i);
      if (!obj) continue;
      const g = obj.geometry();
      if (!g) continue;
      const attrs = obj.attributes();
      const name = (attrs?.name as string) || `Object ${i + 1}`;
      if (attrs && attrs.visible === false) continue;
      const type = (g.objectType?.value ?? g.objectType) as number;
      const acc: Acc = { positions: [], index: [], faces: [] };
      if (type === rh.ObjectType.Brep.value) {
        const faces = g.faces();
        for (let f = 0; f < faces.count; f++) {
          const face = faces.get(f);
          const fm = face.getMesh(anyType);
          if (!fm) continue;
          const first = acc.index.length / 3;
          const n = appendMesh(acc, fm, k, face.orientationIsReversed === true);
          if (n > 0) acc.faces.push({ first, last: first + n - 1, color: null });
          fm.delete?.();
        }
        if (acc.faces.length === 0) {
          noRender += 1;
          continue;
        }
        meshes.push({
          name,
          brep_faces: acc.faces,
          attributes: { position: { array: Float32Array.from(acc.positions) } },
          index: { array: Uint32Array.from(acc.index) },
        });
        continue;
      }
      let mesh: any = null;
      if (type === rh.ObjectType.Mesh.value) mesh = g;
      else if (type === rh.ObjectType.Extrusion.value) mesh = g.getMesh(anyType);
      if (mesh) {
        if (appendMesh(acc, mesh, k, false) > 0) {
          meshes.push(
            segmentMesh({ name, positions: Float32Array.from(acc.positions), indices: Uint32Array.from(acc.index) }) as OcctMesh,
          );
        } else noRender += 1;
        continue;
      }
      const label = rh.ObjectType.values ? (Object.entries(rh.ObjectType).find(([, v]: any) => v?.value === type)?.[0] ?? `type ${type}`) : `type ${type}`;
      skipped.set(label, (skipped.get(label) ?? 0) + 1);
    }
  } finally {
    file.delete?.();
  }
  if (noRender > 0) warnings.push(`${noRender} object(s) have no render mesh saved (re-save from Rhino with render meshes) and were skipped`);
  for (const [label, n] of skipped) warnings.push(`${n} ${label} object(s) not shown (3dm curves, points, blocks and SubD are not drawn yet)`);
  const result: OcctResult = {
    success: true,
    meshes,
    root:
      meshes.length > 1
        ? { name: fileName, children: meshes.map((m, i) => ({ name: m.name, meshes: [i] })) }
        : { name: fileName, meshes: meshes.length ? [0] : [] },
  };
  return { result, warnings };
}
