import type { Bounds3, EdgeTable, FaceTable, MeshTopology, Model3D, ModelFormat, ModelNode, ModelPart, OcctMesh, OcctNode, OcctResult, VertexTable } from "./types";
import { extractTopology, NO_FACE } from "./topology";

/**
 * Flattens an occt-import-js result into a `Model3D`: one merged buffer set
 * with a part table, per-vertex colours baked in, and the B-rep topology
 * (faces, edges, vertices — see topology.ts) recovered and merged into
 * model-wide tables. Pure and synchronous — it runs inside the import
 * worker, right after tessellation, so the main thread never touches the
 * per-mesh JS arrays OpenCascade produces (millions of boxed numbers on a
 * big assembly).
 *
 * Tolerant by design: a mesh with a missing or truncated attribute is
 * skipped, never thrown on. A file that tessellates to nothing yields an
 * empty model with zero bounds, which the viewer knows how to show.
 */

/** Part colour when the file doesn't carry one — a neutral CAD grey. */
const DEFAULT_COLOR: [number, number, number] = [0.78, 0.79, 0.82];

const EMPTY_BOUNDS = (): Bounds3 => ({ min: [0, 0, 0], max: [0, 0, 0] });

interface PreparedMesh {
  name: string;
  positions: Float32Array;
  normals: Float32Array;
  colors: Uint8Array;
  indices: Uint32Array;
  topo: MeshTopology;
  bounds: Bounds3;
}

export function buildModel(result: OcctResult, name: string, hash: string, format: ModelFormat): Model3D {
  const source: (OcctMesh | undefined)[] = Array.isArray(result?.meshes) ? result.meshes : [];
  // Index into `source` -> index into `prepared` (skipped meshes have none),
  // so the hierarchy can still point at the parts that survived.
  const partIndexOf = new Map<number, number>();
  const prepared: PreparedMesh[] = [];
  for (let i = 0; i < source.length; i++) {
    const m = prepareMesh(source[i]);
    // Each raw mesh's own position/index/normal arrays are dead weight once
    // copied into `m` (or discarded) — on a big assembly (thousands of
    // meshes) holding both the raw and the prepared copy at once roughly
    // doubles peak memory for no reason, so drop it as we go rather than
    // waiting for `result` to go out of scope.
    source[i] = undefined;
    if (!m) continue;
    partIndexOf.set(i, prepared.length);
    prepared.push(m);
  }

  let vertexTotal = 0;
  let indexTotal = 0;
  let edgeTotal = 0;
  let faceTotal = 0;
  let edgeRefTotal = 0;
  let nodeTotal = 0;
  for (const m of prepared) {
    vertexTotal += m.positions.length / 3;
    indexTotal += m.indices.length;
    edgeTotal += m.topo.edges.length;
    faceTotal += m.topo.faceTriStart.length;
    edgeRefTotal += m.topo.edgeLength.length;
    nodeTotal += m.topo.vertices.length / 3;
  }

  const positions = new Float32Array(vertexTotal * 3);
  const normals = new Float32Array(vertexTotal * 3);
  const colors = new Uint8Array(vertexTotal * 3);
  const indices = new Uint32Array(indexTotal);
  const edges = new Float32Array(edgeTotal);
  const faceOfTriangle = new Uint32Array(indexTotal / 3);
  const edgeOfSegment = new Uint32Array(edgeTotal / 6);
  const faces = emptyFaceTable(faceTotal);
  const edgeTable = emptyEdgeTable(edgeRefTotal);
  const nodes: VertexTable = { part: new Uint32Array(nodeTotal), xyz: new Float32Array(nodeTotal * 3) };
  const parts: ModelPart[] = [];

  let v = 0;
  let ix = 0;
  let ed = 0;
  let fi = 0;
  let ei = 0;
  let ni = 0;
  prepared.forEach((m, part) => {
    const t = m.topo;
    const vertexCount = m.positions.length / 3;
    const triStart = ix / 3;
    const segStart = ed / 6;
    const faceStart = fi;
    positions.set(m.positions, v * 3);
    normals.set(m.normals, v * 3);
    colors.set(m.colors, v * 3);
    for (let k = 0; k < m.indices.length; k++) indices[ix + k] = m.indices[k] + v;
    edges.set(t.edges, ed);

    // Faces: the mesh's triangle runs shifted into the merged index buffer.
    for (let f = 0; f < t.faceTriStart.length; f++, fi++) {
      faces.part[fi] = part;
      faces.triStart[fi] = triStart + t.faceTriStart[f];
      faces.triCount[fi] = t.faceTriCount[f];
      faces.area[fi] = t.faceArea[f];
      faces.planar[fi] = t.facePlanar[f];
      copy3(faces.centroid, fi, t.faceCentroid, f);
      copy3(faces.normal, fi, t.faceNormal, f);
    }
    for (let k = 0; k < t.faceOfTriangle.length; k++) faceOfTriangle[triStart + k] = faceStart + t.faceOfTriangle[k];

    // Edges: segment runs shifted, adjacent faces re-based, and each edge's
    // length added to the perimeter of the faces it bounds.
    for (let e = 0; e < t.edgeLength.length; e++, ei++) {
      edgeTable.part[ei] = part;
      edgeTable.segStart[ei] = segStart + t.edgeSegStart[e];
      edgeTable.segCount[ei] = t.edgeSegCount[e];
      edgeTable.length[ei] = t.edgeLength[e];
      edgeTable.kind[ei] = t.edgeKind[e];
      edgeTable.radius[ei] = t.edgeRadius[e];
      copy3(edgeTable.a, ei, t.edgeA, e);
      copy3(edgeTable.b, ei, t.edgeB, e);
      copy3(edgeTable.center, ei, t.edgeCenter, e);
      copy3(edgeTable.normal, ei, t.edgeNormal, e);
      const fa = t.edgeFaceA[e];
      const fb = t.edgeFaceB[e];
      edgeTable.faceA[ei] = fa === NO_FACE ? NO_FACE : faceStart + fa;
      edgeTable.faceB[ei] = fb === NO_FACE ? NO_FACE : faceStart + fb;
      if (fa !== NO_FACE) faces.perimeter[faceStart + fa] += t.edgeLength[e];
      if (fb !== NO_FACE) faces.perimeter[faceStart + fb] += t.edgeLength[e];
      for (let k = 0; k < t.edgeSegCount[e]; k++) edgeOfSegment[segStart + t.edgeSegStart[e] + k] = ei;
    }

    const nodeStart = ni;
    for (let k = 0; k < t.vertices.length / 3; k++, ni++) {
      nodes.part[ni] = part;
      nodes.xyz[ni * 3] = t.vertices[k * 3];
      nodes.xyz[ni * 3 + 1] = t.vertices[k * 3 + 1];
      nodes.xyz[ni * 3 + 2] = t.vertices[k * 3 + 2];
    }

    parts.push({
      name: m.name,
      vertexStart: v,
      vertexCount,
      indexStart: ix,
      indexCount: m.indices.length,
      edgeStart: segStart,
      edgeCount: t.edges.length / 6,
      faceStart,
      faceCount: t.faceTriStart.length,
      edgeRefStart: ei - t.edgeLength.length,
      edgeRefCount: t.edgeLength.length,
      nodeStart,
      nodeCount: t.vertices.length / 3,
      area: t.area,
      volume: t.volume,
      centroid: t.centroid,
      bounds: m.bounds,
    });
    v += vertexCount;
    ix += m.indices.length;
    ed += t.edges.length;
  });

  return {
    name,
    hash,
    format,
    positions,
    normals,
    colors,
    indices,
    edges,
    faces,
    edgeTable,
    nodes,
    faceOfTriangle,
    edgeOfSegment,
    parts,
    tree: buildTree(result?.root, partIndexOf, parts, name),
    bounds: unionBounds(parts.map((p) => p.bounds)),
    triangleCount: indexTotal / 3,
  };
}

function copy3(target: Float32Array, ti: number, source: Float32Array, si: number): void {
  target[ti * 3] = source[si * 3];
  target[ti * 3 + 1] = source[si * 3 + 1];
  target[ti * 3 + 2] = source[si * 3 + 2];
}

function emptyFaceTable(n: number): FaceTable {
  return {
    part: new Uint32Array(n),
    triStart: new Uint32Array(n),
    triCount: new Uint32Array(n),
    area: new Float32Array(n),
    perimeter: new Float32Array(n),
    centroid: new Float32Array(n * 3),
    normal: new Float32Array(n * 3),
    planar: new Uint8Array(n),
  };
}

function emptyEdgeTable(n: number): EdgeTable {
  return {
    part: new Uint32Array(n),
    segStart: new Uint32Array(n),
    segCount: new Uint32Array(n),
    length: new Float32Array(n),
    kind: new Uint8Array(n),
    a: new Float32Array(n * 3),
    b: new Float32Array(n * 3),
    center: new Float32Array(n * 3),
    radius: new Float32Array(n),
    normal: new Float32Array(n * 3),
    faceA: new Uint32Array(n),
    faceB: new Uint32Array(n),
  };
}

/* ------------------------------- per mesh -------------------------------- */

function prepareMesh(mesh: OcctMesh | undefined): PreparedMesh | null {
  const posSrc = mesh?.attributes?.position?.array;
  const idxSrc = mesh?.index?.array;
  if (!posSrc || !idxSrc || posSrc.length < 9 || idxSrc.length < 3) return null;

  const vertexCount = Math.floor(posSrc.length / 3);
  const positions = new Float32Array(vertexCount * 3);
  for (let i = 0; i < positions.length; i++) positions[i] = +posSrc[i] || 0;

  // Drop any triangle that points outside the vertex range rather than
  // letting a corrupt index crash the GPU upload later.
  const triCount = Math.floor(idxSrc.length / 3);
  const indices = new Uint32Array(triCount * 3);
  let t = 0;
  const triKept = new Int32Array(triCount).fill(-1);
  for (let i = 0; i < triCount; i++) {
    const a = idxSrc[i * 3] | 0;
    const b = idxSrc[i * 3 + 1] | 0;
    const c = idxSrc[i * 3 + 2] | 0;
    if (a < 0 || b < 0 || c < 0 || a >= vertexCount || b >= vertexCount || c >= vertexCount) continue;
    indices[t * 3] = a;
    indices[t * 3 + 1] = b;
    indices[t * 3 + 2] = c;
    triKept[i] = t;
    t += 1;
  }
  const keptIndices = t === triCount ? indices : indices.subarray(0, t * 3);
  if (t === 0) return null;

  const normSrc = mesh.attributes?.normal?.array;
  const normals =
    normSrc && normSrc.length >= vertexCount * 3
      ? Float32Array.from({ length: vertexCount * 3 }, (_, i) => +normSrc[i] || 0)
      : computeNormals(positions, keptIndices);

  // Per-triangle B-rep face id (from the original triangle numbering), used
  // for both face colours and edge extraction.
  const faceOfTri = new Int32Array(t).fill(0);
  const faces = Array.isArray(mesh.brep_faces) ? mesh.brep_faces : [];
  for (let f = 0; f < faces.length; f++) {
    const face = faces[f];
    const first = Math.max(0, face?.first | 0);
    const last = Math.min(triCount - 1, face?.last | 0);
    for (let i = first; i <= last; i++) {
      const k = triKept[i];
      if (k >= 0) faceOfTri[k] = f;
    }
  }

  const colors = new Uint8Array(vertexCount * 3);
  const base = toRgb8(mesh.color ?? DEFAULT_COLOR);
  for (let i = 0; i < vertexCount; i++) colors.set(base, i * 3);
  // Face colours override the part colour. OpenCascade meshes each face
  // with its own vertices, so painting by triangle never bleeds across faces.
  for (let f = 0; f < faces.length; f++) {
    const fc = faces[f]?.color;
    if (!fc) continue;
    const rgb = toRgb8(fc);
    const first = Math.max(0, faces[f].first | 0);
    const last = Math.min(triCount - 1, faces[f].last | 0);
    for (let i = first; i <= last; i++) {
      const k = triKept[i];
      if (k < 0) continue;
      colors.set(rgb, keptIndices[k * 3] * 3);
      colors.set(rgb, keptIndices[k * 3 + 1] * 3);
      colors.set(rgb, keptIndices[k * 3 + 2] * 3);
    }
  }

  const bounds = boundsOf(positions);
  return {
    name: typeof mesh.name === "string" && mesh.name.trim() ? mesh.name.trim() : "Part",
    positions,
    normals,
    colors,
    indices: keptIndices,
    topo: extractTopology(positions, keptIndices, faceOfTri, Math.max(1, faces.length), bounds),
    bounds,
  };
}

function toRgb8(c: ArrayLike<number>): Uint8Array {
  const out = new Uint8Array(3);
  for (let i = 0; i < 3; i++) {
    const v = +c[i];
    out[i] = Math.max(0, Math.min(255, Math.round((Number.isFinite(v) ? v : 0.8) * 255)));
  }
  return out;
}

function computeNormals(positions: Float32Array, indices: Uint32Array): Float32Array {
  const n = new Float32Array(positions.length);
  for (let i = 0; i < indices.length; i += 3) {
    const a = indices[i] * 3;
    const b = indices[i + 1] * 3;
    const c = indices[i + 2] * 3;
    const abx = positions[b] - positions[a];
    const aby = positions[b + 1] - positions[a + 1];
    const abz = positions[b + 2] - positions[a + 2];
    const acx = positions[c] - positions[a];
    const acy = positions[c + 1] - positions[a + 1];
    const acz = positions[c + 2] - positions[a + 2];
    const nx = aby * acz - abz * acy;
    const ny = abz * acx - abx * acz;
    const nz = abx * acy - aby * acx;
    for (const k of [a, b, c]) {
      n[k] += nx;
      n[k + 1] += ny;
      n[k + 2] += nz;
    }
  }
  for (let i = 0; i < n.length; i += 3) {
    const len = Math.hypot(n[i], n[i + 1], n[i + 2]) || 1;
    n[i] /= len;
    n[i + 1] /= len;
    n[i + 2] /= len;
  }
  return n;
}

/* ------------------------------ hierarchy ------------------------------- */

const MAX_TREE_DEPTH = 64;

/**
 * The assembly tree as the file declares it, tidied: STEP wraps every part
 * in a product node of its own ("SCREW" → "SCREW"), which would make the
 * tree twice as deep as it reads, so single-part leaf nodes are hoisted into
 * their parent (the part takes the node's name when its own is generic).
 * Parts the hierarchy doesn't reference still get listed, at the root.
 */
function buildTree(
  root: OcctNode | undefined,
  partIndexOf: Map<number, number>,
  parts: { name: string }[],
  fallbackName: string,
): ModelNode {
  const visit = (node: OcctNode | undefined, depth: number): ModelNode | null => {
    if (!node || typeof node !== "object" || depth > MAX_TREE_DEPTH) return null;
    const own: number[] = [];
    for (const i of Array.isArray(node.meshes) ? node.meshes : []) {
      const p = partIndexOf.get(i | 0);
      if (p !== undefined) own.push(p);
    }
    const children: ModelNode[] = [];
    for (const c of Array.isArray(node.children) ? node.children : []) {
      const child = visit(c, depth + 1);
      if (!child || (child.parts.length === 0 && child.children.length === 0)) continue;
      if (child.children.length === 0 && child.parts.length === 1) {
        const part = parts[child.parts[0]];
        if (child.name && (part.name === "Part" || part.name === child.name)) part.name = child.name;
        own.push(child.parts[0]);
        continue;
      }
      children.push(child);
    }
    return { name: typeof node.name === "string" && node.name.trim() ? node.name.trim() : "", parts: own, children };
  };
  const tree = visit(root, 0) ?? { name: "", parts: [], children: [] };
  if (!tree.name) tree.name = fallbackName;
  const referenced = new Set<number>();
  const collect = (n: ModelNode) => {
    n.parts.forEach((p) => referenced.add(p));
    n.children.forEach(collect);
  };
  collect(tree);
  for (let i = 0; i < partIndexOf.size; i++) if (!referenced.has(i)) tree.parts.push(i);
  return tree;
}

/* -------------------------------- bounds -------------------------------- */

function boundsOf(positions: Float32Array): Bounds3 {
  if (positions.length < 3) return EMPTY_BOUNDS();
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < positions.length; i += 3) {
    for (let k = 0; k < 3; k++) {
      const v = positions[i + k];
      if (v < min[k]) min[k] = v;
      if (v > max[k]) max[k] = v;
    }
  }
  return { min, max };
}

export function unionBounds(list: Bounds3[]): Bounds3 {
  if (list.length === 0) return EMPTY_BOUNDS();
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (const b of list) {
    for (let k = 0; k < 3; k++) {
      if (b.min[k] < min[k]) min[k] = b.min[k];
      if (b.max[k] > max[k]) max[k] = b.max[k];
    }
  }
  return { min, max };
}
