/**
 * A tessellated 3D model as the viewer consumes it: one merged vertex buffer
 * for the whole file plus a part table indexing into it.
 *
 * STEP/IGES files are B-rep; the OpenCascade worker (occt.worker.ts)
 * tessellates them and `buildModel` flattens the result into this shape so
 * the main thread does nothing but hand typed arrays to the GPU. Everything
 * here survives structured cloning (postMessage / IndexedDB) — that is what
 * makes the persistent model cache and the worker hand-off zero-copy.
 *
 * This is a *viewing* format, deliberately separate from the 2D document
 * model in @sketchor/core: a model tab has no entities, no command bus, and
 * nothing to save.
 */
export interface Model3D {
  /** Original filename (for the tab title). */
  name: string;
  /** SHA-256 of the source bytes — the cache key, and how re-opens are deduplicated. */
  hash: string;
  format: ModelFormat;
  /** Vertex positions, xyz triplets, in millimeters. */
  positions: Float32Array;
  /** Per-vertex unit normals, xyz triplets, parallel to `positions`. */
  normals: Float32Array;
  /** Per-vertex RGB, 0–255, parallel to `positions` (three.js reads it as a normalized attribute). */
  colors: Uint8Array;
  /** Triangle vertex indices into `positions`. */
  indices: Uint32Array;
  /**
   * B-rep edge segments as xyz pairs (two points per segment), for the dark
   * outline that makes a shaded CAD model readable. Extracted where two
   * triangles of *different* B-rep faces meet, so tangent edges draw too —
   * the convention CAD packages use.
   */
  edges: Float32Array;
  /**
   * B-rep topology recovered from the tessellation (topology.ts) — the
   * faces, edges and vertices the viewer lets you pick and measure, the
   * way Onshape does. Flat typed arrays because a big assembly has
   * hundreds of thousands of them and they all have to survive a
   * structured clone into the main thread.
   */
  faces: FaceTable;
  edgeTable: EdgeTable;
  nodes: VertexTable;
  /** Per triangle (`indices`/3): its face in `faces`. Picking a triangle picks a face. */
  faceOfTriangle: Uint32Array;
  /** Per segment in `edges`: its edge in `edgeTable`. */
  edgeOfSegment: Uint32Array;
  parts: ModelPart[];
  /** Assembly hierarchy as the file declared it; leaves reference `parts` by index. */
  tree: ModelNode;
  bounds: Bounds3;
  triangleCount: number;
  /** Up axis guessed from the STEP header (upAxis.ts); the viewer starts there unless the user overrode it for this file. Absent = Z. */
  detectedUp?: "z" | "y";
}

export type ModelFormat = "step" | "iges" | "stl" | "obj" | "ply" | "3mf" | "gltf" | "glb";

export interface ModelPart {
  name: string;
  /** Vertex range in the merged buffers (`positions`/`normals`/`colors`). */
  vertexStart: number;
  vertexCount: number;
  /** Index range in `indices` (a multiple of 3). */
  indexStart: number;
  indexCount: number;
  /** Segment range in `edges` (one segment = 6 floats). */
  edgeStart: number;
  edgeCount: number;
  /** Range in the model's `faces` table. */
  faceStart: number;
  faceCount: number;
  /** Range in the model's `edgeTable`. */
  edgeRefStart: number;
  edgeRefCount: number;
  /** Range in the model's `nodes` table. */
  nodeStart: number;
  nodeCount: number;
  /** Surface area and enclosed volume of this part's mesh (volume is meaningless for an open shell). */
  area: number;
  volume: number;
  /** Volumetric (mass) centre — not the bounding-box centre, and not a face's area-weighted centroid. */
  centroid: Vec3;
  bounds: Bounds3;
}

export type Vec3 = [number, number, number];

/** One B-rep face per entry; `triStart`/`triCount` index triangles (`indices`/3). */
export interface FaceTable {
  part: Uint32Array;
  triStart: Uint32Array;
  triCount: Uint32Array;
  area: Float32Array;
  /** Total length of the edges bounding this face. */
  perimeter: Float32Array;
  /** Area-weighted centroid, xyz triplets. */
  centroid: Float32Array;
  /** Average unit normal, xyz triplets. */
  normal: Float32Array;
  /** 1 when every triangle lies in one plane. */
  planar: Uint8Array;
}

/** One B-rep edge per entry: a chain of segments in `edges`, fitted to a line or circle where it is one. */
export interface EdgeTable {
  part: Uint32Array;
  segStart: Uint32Array;
  segCount: Uint32Array;
  length: Float32Array;
  /** EDGE_LINE / EDGE_CIRCLE / EDGE_ARC / EDGE_CURVE (topology.ts). */
  kind: Uint8Array;
  /** End points, xyz triplets (equal for a closed circle). */
  a: Float32Array;
  b: Float32Array;
  /** Circle/arc centre, radius and plane normal; zeros for other kinds. */
  center: Float32Array;
  radius: Float32Array;
  normal: Float32Array;
  /** The two faces meeting here, or NO_FACE for an open boundary. */
  faceA: Uint32Array;
  faceB: Uint32Array;
}

/** Edge end points — the model's vertices. */
export interface VertexTable {
  part: Uint32Array;
  xyz: Float32Array;
}

/** What `extractTopology` returns for one mesh, before merging into the model's tables. */
export interface MeshTopology {
  edges: Float32Array;
  edgeSegStart: Uint32Array;
  edgeSegCount: Uint32Array;
  edgeLength: Float32Array;
  edgeKind: Uint8Array;
  edgeA: Float32Array;
  edgeB: Float32Array;
  edgeCenter: Float32Array;
  edgeRadius: Float32Array;
  edgeNormal: Float32Array;
  edgeFaceA: Uint32Array;
  edgeFaceB: Uint32Array;
  vertices: Float32Array;
  faceTriStart: Uint32Array;
  faceTriCount: Uint32Array;
  faceArea: Float32Array;
  faceCentroid: Float32Array;
  faceNormal: Float32Array;
  facePlanar: Uint8Array;
  faceOfTriangle: Uint32Array;
  /** Enclosed volume and surface area of this mesh. */
  volume: number;
  area: number;
  /** Volumetric (mass) centre of this mesh. */
  centroid: Vec3;
}

export interface ModelNode {
  name: string;
  parts: number[];
  children: ModelNode[];
}

export interface Bounds3 {
  min: [number, number, number];
  max: [number, number, number];
}

/** The shape occt-import-js returns from ReadStepFile / ReadIgesFile (see its README). */
export interface OcctResult {
  success: boolean;
  root?: OcctNode;
  meshes?: OcctMesh[];
}

export interface OcctNode {
  name?: string;
  meshes?: number[];
  children?: OcctNode[];
}

export interface OcctMesh {
  name?: string;
  color?: [number, number, number];
  brep_faces?: { first: number; last: number; color?: [number, number, number] | null }[];
  attributes?: {
    position?: { array: ArrayLike<number> };
    normal?: { array: ArrayLike<number> };
  };
  index?: { array: ArrayLike<number> };
}

/** Every typed array a model owns — what the cache measures and what the worker transfers. */
export function modelArrays(m: Model3D): ArrayBufferView[] {
  return [
    m.positions,
    m.normals,
    m.colors,
    m.indices,
    m.edges,
    m.faceOfTriangle,
    m.edgeOfSegment,
    ...Object.values(m.faces),
    ...Object.values(m.edgeTable),
    ...Object.values(m.nodes),
  ];
}

/** Bytes of typed-array payload a model carries — what the cache budget counts. */
export function modelByteSize(m: Model3D): number {
  return modelArrays(m).reduce((sum, a) => sum + a.byteLength, 0);
}
