/**
 * E-06: the pure half of measuring in the embed's full view. The viewer does
 * the raycast and drawing; this file decides what a hit means and how the
 * numbers read, so both are tested without WebGL.
 *
 * Units: model files are millimetres (mesh formats carry no unit; glTF is
 * scaled from metres on import), so lengths read in mm, areas in mm², and
 * volumes in cm³ once they're big enough that mm³ stops being readable. The
 * embed has no material to weigh, so mass rows are dropped rather than shown
 * with a made-up density.
 */
import { measureSelection, type Formatters, type Measurement, type SelRef } from "./three/measure";
import type { Model3D } from "./three/types";
import { mm, num } from "./fmt";

export const EMBED_FORMATTERS: Formatters = {
  length: mm,
  area: (v) => `${num(v)} mm²`,
  volume: (v) => (Math.abs(v) >= 1000 ? `${num(v / 1000)} cm³` : `${num(v)} mm³`),
  mass: () => "",
};

/** The readout for a selection, minus rows the embed can't fill in (mass). */
export function measureForEmbed(model: Model3D, refs: SelRef[]): Measurement {
  const m = measureSelection(model, refs, EMBED_FORMATTERS);
  return { ...m, rows: m.rows.filter((r) => r.value !== "") };
}

/** Which part owns triangle `tri` (index into the merged index buffer / 3). Parts are in index order. */
export function partOfTriangle(model: Model3D, tri: number): number {
  const at = tri * 3;
  let lo = 0;
  let hi = model.parts.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const p = model.parts[mid];
    if (at < p.indexStart) hi = mid - 1;
    else if (at >= p.indexStart + p.indexCount) lo = mid + 1;
    else return mid;
  }
  return -1;
}

/** Positions (xyz per corner, three corners per triangle) of every triangle of `face`, for its highlight. */
export function faceTrianglePositions(model: Model3D, face: number): Float32Array {
  const start = model.faces.triStart[face];
  const count = model.faces.triCount[face];
  const out = new Float32Array(count * 9);
  for (let t = 0; t < count; t++) {
    for (let c = 0; c < 3; c++) {
      const v = model.indices[(start + t) * 3 + c];
      out.set(model.positions.subarray(v * 3, v * 3 + 3), t * 9 + c * 3);
    }
  }
  return out;
}

/**
 * The next selection after a pick: a plain click replaces it, Shift adds (or
 * removes a ref that's already in), clicking empty space clears. At most two
 * refs, because the readout measures one thing or the relation between two.
 */
export function nextSelection(current: SelRef[], picked: SelRef | null, additive: boolean): SelRef[] {
  if (!picked) return additive ? current : [];
  const same = (a: SelRef) => a.kind === picked.kind && a.index === picked.index;
  if (!additive) return current.length === 1 && same(current[0]) ? [] : [picked];
  if (current.some(same)) return current.filter((r) => !same(r));
  return [...current, picked].slice(-2);
}
