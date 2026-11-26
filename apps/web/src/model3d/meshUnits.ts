import type { Bounds3, Model3D, ModelFormat, Vec3 } from "./types";

/**
 * F-11: STL, OBJ and PLY store no unit. They are read as millimetres; when
 * that is wrong (a part drawn in inches comes in 25.4× too small) the user
 * picks the unit in the 3D view and the model is shown — and measured and
 * exported — scaled from it. The choice is remembered per file, like the up
 * axis (upAxis.ts), and like it the scaling is a view of the parsed model,
 * so the model cache keeps the file as read.
 */

export type MeshUnit = "mm" | "cm" | "m" | "in";
export const MESH_UNITS: readonly MeshUnit[] = ["mm", "cm", "m", "in"];
export const MM_PER_UNIT: Record<MeshUnit, number> = { mm: 1, cm: 10, m: 1000, in: 25.4 };
export const MESH_UNIT_LABEL: Record<MeshUnit, string> = { mm: "mm", cm: "cm", m: "m", in: "inch" };

/** Formats whose files carry no unit (3MF and glTF state theirs; STEP/IGES carry one too). */
export const isUnitless = (format: ModelFormat): boolean => format === "stl" || format === "obj" || format === "ply";

const scaleArr = (a: Float32Array, k: number): Float32Array => {
  const o = new Float32Array(a.length);
  for (let i = 0; i < a.length; i++) o[i] = a[i] * k;
  return o;
};
const scaleVec = (v: Vec3, k: number): Vec3 => [v[0] * k, v[1] * k, v[2] * k];
const scaleBounds = (b: Bounds3, k: number): Bounds3 => ({ min: scaleVec(b.min, k), max: scaleVec(b.max, k) });

/**
 * The model with every length multiplied by `k` (areas by k², volumes by k³);
 * directions, colours, indices and topology are shared. k = 1 returns the
 * model itself.
 */
export function scaleModel(model: Model3D, k: number): Model3D {
  if (k === 1 || !Number.isFinite(k) || k <= 0) return model;
  return {
    ...model,
    positions: scaleArr(model.positions, k),
    edges: scaleArr(model.edges, k),
    faces: { ...model.faces, area: scaleArr(model.faces.area, k * k), perimeter: scaleArr(model.faces.perimeter, k), centroid: scaleArr(model.faces.centroid, k) },
    edgeTable: {
      ...model.edgeTable,
      length: scaleArr(model.edgeTable.length, k),
      a: scaleArr(model.edgeTable.a, k),
      b: scaleArr(model.edgeTable.b, k),
      center: scaleArr(model.edgeTable.center, k),
      radius: scaleArr(model.edgeTable.radius, k),
    },
    nodes: { ...model.nodes, xyz: scaleArr(model.nodes.xyz, k) },
    ...(model.wires ? { wires: scaleArr(model.wires, k) } : {}),
    parts: model.parts.map((p) => ({ ...p, area: p.area * k * k, volume: p.volume * k * k * k, centroid: scaleVec(p.centroid, k), bounds: scaleBounds(p.bounds, k) })),
    bounds: scaleBounds(model.bounds, k),
  };
}

/**
 * A nudge when a unitless model read as millimetres has an implausible size —
 * smaller than 2 mm across (likely inches or metres) or bigger than 5 m
 * (likely tenths of a millimetre or microns). Null when it looks fine.
 */
export function unitHint(model: Model3D): string | null {
  if (!isUnitless(model.format)) return null;
  const b = model.bounds;
  const size = Math.max(b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2]);
  if (!Number.isFinite(size) || size <= 0) return null;
  if (size < 2) return `This ${model.format.toUpperCase()} is only ${size.toPrecision(2)} mm across. It has no units; if it was drawn in inches or metres, pick them under Units.`;
  if (size > 5000) return `This ${model.format.toUpperCase()} is ${(size / 1000).toPrecision(3)} m across. It has no units; if that's wrong, pick the right ones under Units.`;
  return null;
}

/* ---------------------- per-file choice (localStorage) ------------------- */

const STORAGE_KEY = "sketchor.modelUnits.v1";

function load(): Record<string, MeshUnit> {
  try {
    const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}");
    return raw && typeof raw === "object" ? raw : {};
  } catch {
    return {};
  }
}

export function savedMeshUnit(hash: string): MeshUnit | null {
  const v = load()[hash];
  return MESH_UNITS.includes(v) ? v : null;
}

/** Remembers the unit for `hash` (millimetres, the default, is stored as "no override"). */
export function saveMeshUnit(hash: string, unit: MeshUnit): void {
  try {
    const all = load();
    if (unit === "mm") delete all[hash];
    else all[hash] = unit;
    localStorage.setItem(STORAGE_KEY, JSON.stringify(all));
  } catch {
    /* storage unavailable: the choice just doesn't persist */
  }
}
