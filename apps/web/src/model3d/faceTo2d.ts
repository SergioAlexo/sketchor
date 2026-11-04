import { flatFaceOutline, type Entity, type ProjectableEdge, type V3 } from "@sketchor/core";
import { EDGE_ARC, EDGE_CIRCLE, EDGE_LINE, NO_FACE, read3 } from "./topology";
import type { Model3D } from "./types";

/**
 * F-07, step one: "flat face outline to 2D". Reads the picked face's boundary
 * edges out of the model's topology tables and hands them to the pure
 * projection in @sketchor/core.
 */

/** The boundary edges of one face, as projectable chains. */
export function faceEdges(model: Model3D, face: number): ProjectableEdge[] {
  const t = model.edgeTable;
  const out: ProjectableEdge[] = [];
  for (let i = 0; i < t.length.length; i++) {
    if (t.faceA[i] !== face && t.faceB[i] !== face) continue;
    if (t.faceA[i] === NO_FACE && t.faceB[i] === NO_FACE) continue;
    const start = t.segStart[i];
    const count = t.segCount[i];
    const points: number[] = [];
    for (let s = 0; s < count; s++) {
      const o = (start + s) * 6;
      if (s === 0) points.push(model.edges[o], model.edges[o + 1], model.edges[o + 2]);
      points.push(model.edges[o + 3], model.edges[o + 4], model.edges[o + 5]);
    }
    const kind = t.kind[i] === EDGE_LINE ? "line" : t.kind[i] === EDGE_CIRCLE ? "circle" : t.kind[i] === EDGE_ARC ? "arc" : "curve";
    out.push({
      kind,
      points,
      center: read3(t.center, i),
      radius: t.radius[i],
      normal: read3(t.normal, i),
    });
  }
  return out;
}

export interface FaceOutline {
  entities: Entity[];
  /** Tab title. */
  name: string;
}

/** Why a face can't be flattened, or null when it can. */
export function faceOutlineBlocker(model: Model3D, face: number): string | null {
  if (face < 0 || face >= model.faces.area.length) return "No such face.";
  if (model.faces.planar[face] !== 1) return "Pick a flat face - this one is curved.";
  return null;
}

/** The 2D outline of a planar face, or null with a reason. */
export function outlineOfFace(model: Model3D, face: number): FaceOutline | { error: string } {
  const why = faceOutlineBlocker(model, face);
  if (why) return { error: why };
  const normal = read3(model.faces.normal, face) as V3;
  const centroid = read3(model.faces.centroid, face) as V3;
  const r = flatFaceOutline(normal, centroid, faceEdges(model, face));
  if (!r || r.entities.length === 0) return { error: "That face has no boundary edges to project." };
  const part = model.parts[model.faces.part[face]]?.name || model.name;
  return { entities: r.entities, name: `${part} - face ${face + 1}` };
}
