import type { Bounds3, Model3D, Vec3 } from "./types";

/**
 * Which axis a STEP file treats as "up". STEP itself doesn't say — the
 * viewer draws Z up (Onshape's convention), but SolidWorks exports Y-up, so
 * a SolidWorks assembly opens lying on its back unless the file is turned.
 *
 * The turn is applied to the *model data* (`reorientModel`), not to a
 * scene-graph matrix: picking, measuring, the selection overlays, fit and
 * the thumbnails all read positions straight off the `Model3D`, so a
 * rotated copy makes every one of them agree by construction — ΔZ in the
 * readout is then the height on screen, with nothing to keep in sync.
 */

export type UpAxis = "z" | "y";

/** How much of the file to look at: the HEADER section sits in the first few hundred bytes. */
export const HEADER_BYTES = 4096;

/**
 * Guesses the up axis from the start of a STEP file. Only the FILE_NAME
 * record's originating system / preprocessor strings are consulted — those
 * are what identify the exporter. Anything unrecognised, IGES, or
 * unparseable is Z (the viewer's own convention). Never throws.
 */
export function detectUpAxis(headerText: string): UpAxis {
  try {
    const m = /FILE_NAME\s*\(([\s\S]*?)\)\s*;/i.exec(headerText.slice(0, HEADER_BYTES));
    if (m && /SolidWorks|SwSTEP/i.test(m[1])) return "y";
  } catch {
    /* fall through */
  }
  return "z";
}

/** Reads the first {@link HEADER_BYTES} of `buffer` as text and detects. */
export function detectUpAxisFromBytes(buffer: ArrayBuffer): UpAxis {
  try {
    const head = new Uint8Array(buffer, 0, Math.min(HEADER_BYTES, buffer.byteLength));
    return detectUpAxis(new TextDecoder("latin1").decode(head));
  } catch {
    return "z";
  }
}

/**
 * Column-major Matrix4 elements (three.js order) mapping file space to
 * display space. Y-up → Z-up is +90° about X: (x, y, z) → (x, −z, y).
 */
export function upAxisMatrix(up: UpAxis): number[] {
  if (up === "z") return [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  return [1, 0, 0, 0, 0, 0, 1, 0, 0, -1, 0, 0, 0, 0, 0, 1];
}

const rotVec = (v: Vec3): Vec3 => [v[0], 0 - v[2], v[1]];

function rotArray(a: Float32Array): Float32Array {
  const out = new Float32Array(a.length);
  for (let i = 0; i + 2 < a.length; i += 3) {
    out[i] = a[i];
    out[i + 1] = 0 - a[i + 2]; // 0 - x, so a zero stays +0
    out[i + 2] = a[i + 1];
  }
  return out;
}

function rotBounds(b: Bounds3): Bounds3 {
  return { min: [b.min[0], -b.max[2], b.min[1]], max: [b.max[0], -b.min[2], b.max[1]] };
}

/**
 * The model as it should be displayed for `up`. Z returns the model itself;
 * Y returns a copy with every coordinate-bearing array turned +90° about X
 * (arrays that hold no coordinates — colours, indices, triangle tables —
 * are shared, so the copy costs only the geometry).
 */
export function reorientModel(model: Model3D, up: UpAxis): Model3D {
  if (up === "z") return model;
  return {
    ...model,
    positions: rotArray(model.positions),
    normals: rotArray(model.normals),
    edges: rotArray(model.edges),
    faces: { ...model.faces, centroid: rotArray(model.faces.centroid), normal: rotArray(model.faces.normal) },
    edgeTable: {
      ...model.edgeTable,
      a: rotArray(model.edgeTable.a),
      b: rotArray(model.edgeTable.b),
      center: rotArray(model.edgeTable.center),
      normal: rotArray(model.edgeTable.normal),
    },
    nodes: { ...model.nodes, xyz: rotArray(model.nodes.xyz) },
    parts: model.parts.map((p) => ({ ...p, centroid: rotVec(p.centroid), bounds: rotBounds(p.bounds) })),
    bounds: rotBounds(model.bounds),
  };
}

/* ---------------------- per-file override (localStorage) ---------------- */

const STORAGE_KEY = "sketchor.modelUpAxis.v1";

function loadOverrides(): Record<string, UpAxis> {
  try {
    const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}");
    return raw && typeof raw === "object" ? raw : {};
  } catch {
    return {};
  }
}

/** The user's saved choice for this file, if they ever overrode the detection. */
export function savedUpAxis(hash: string): UpAxis | null {
  const v = loadOverrides()[hash];
  return v === "z" || v === "y" ? v : null;
}

/** Remembers an override for `hash`. Storage failing is fine — the choice just doesn't persist. */
export function saveUpAxis(hash: string, up: UpAxis): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...loadOverrides(), [hash]: up }));
  } catch {
    /* storage unavailable */
  }
}
