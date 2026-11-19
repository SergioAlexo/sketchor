import type { Bounds3, EdgeTable, FaceTable, MeshTopology, Vec3 } from "./types";

/**
 * B-rep topology recovered from a tessellation — what makes Onshape-style
 * picking possible: faces, edges and vertices as things you can click,
 * rather than one triangle soup per part.
 *
 * OpenCascade hands us triangles tagged with the B-rep face they came from
 * (`brep_faces`). From that alone the rest follows:
 *
 * - a **face** is the run of triangles carrying one tag; its area, centroid,
 *   average normal and planarity come from those triangles;
 * - an **edge** is a chain of triangle edges shared by two *different*
 *   faces (or the open boundary of a sheet), walked end to end so one
 *   topological edge is one pickable thing with a real length — and fitted
 *   to a line or circle, so a hole's rim reports its radius the way a CAD
 *   package does;
 * - a **vertex** is where those chains end.
 *
 * Everything is emitted as flat typed arrays: a 3,000-part assembly has
 * hundreds of thousands of these, and arrays of objects would cost more to
 * structured-clone into the viewer than the geometry itself.
 */

/** `EdgeTable.kind` values. */
export const EDGE_LINE = 0;
export const EDGE_CIRCLE = 1;
export const EDGE_ARC = 2;
export const EDGE_CURVE = 3;

/** `EdgeTable.faceA/faceB` when an edge has no second face (a sheet boundary). */
export const NO_FACE = 0xffffffff;

/* ----------------------------- per-mesh build ----------------------------- */

/**
 * Faces, edges and vertices for one tessellated solid.
 *
 * `faceOfTri` is the B-rep face tag per kept triangle; `bounds` sizes the
 * weld and fit tolerances, which have to be relative — a 2 mm screw and a
 * 7 m trailer arrive in the same assembly.
 */
export function extractTopology(
  positions: Float32Array,
  indices: Uint32Array,
  faceOfTri: Int32Array,
  faceCount: number,
  bounds: Bounds3,
): MeshTopology {
  const diag = Math.hypot(bounds.max[0] - bounds.min[0], bounds.max[1] - bounds.min[1], bounds.max[2] - bounds.min[2]);
  const triCount = indices.length / 3;

  // ---- weld vertices by quantised position -------------------------------
  const vertexCount = positions.length / 3;
  const inv = 1 / (diag > 0 ? diag * 1e-6 : 1e-6);
  const weld = new Uint32Array(vertexCount);
  const byKey = new Map<string, number>();
  let welded = 0;
  for (let i = 0; i < vertexCount; i++) {
    const key = `${Math.round(positions[i * 3] * inv)},${Math.round(positions[i * 3 + 1] * inv)},${Math.round(positions[i * 3 + 2] * inv)}`;
    let id = byKey.get(key);
    if (id === undefined) {
      id = welded++;
      byKey.set(key, id);
    }
    weld[i] = id;
  }
  const rep = new Uint32Array(welded);
  for (let i = vertexCount - 1; i >= 0; i--) rep[weld[i]] = i;
  const point = (w: number): Vec3 => [positions[rep[w] * 3], positions[rep[w] * 3 + 1], positions[rep[w] * 3 + 2]];

  // ---- which faces meet along each triangle edge --------------------------
  // Two maps rather than one map of objects: this runs over every triangle
  // edge of every part in the file.
  const firstFace = new Map<number, number>();
  const secondFace = new Map<number, number>();
  const NON_MANIFOLD = -3;
  const visit = (a: number, b: number, face: number): void => {
    if (a === b) return;
    const key = a < b ? a * welded + b : b * welded + a;
    const f = firstFace.get(key);
    if (f === undefined) {
      firstFace.set(key, face);
      return;
    }
    const s = secondFace.get(key);
    if (s === undefined) secondFace.set(key, face);
    else secondFace.set(key, NON_MANIFOLD);
  };
  for (let tri = 0; tri < triCount; tri++) {
    const face = faceOfTri[tri];
    const a = weld[indices[tri * 3]];
    const b = weld[indices[tri * 3 + 1]];
    const c = weld[indices[tri * 3 + 2]];
    visit(a, b, face);
    visit(b, c, face);
    visit(c, a, face);
  }

  // ---- keep creases and boundaries, grouped by the face pair --------------
  interface Seg {
    u: number;
    v: number;
  }
  const groups = new Map<number, Seg[]>();
  const groupFaces = new Map<number, [number, number]>();
  const groupKey = (fa: number, fb: number): number => {
    const lo = Math.min(fa, fb);
    const hi = Math.max(fa, fb);
    return lo * (faceCount + 1) + hi;
  };
  for (const [key, fa] of firstFace) {
    const fb = secondFace.get(key);
    if (fb === NON_MANIFOLD) continue;
    if (fb !== undefined && fb === fa) continue; // interior to one face
    const u = Math.floor(key / welded);
    const v = key - u * welded;
    const other = fb === undefined ? faceCount : fb; // faceCount = "open boundary"
    const gk = groupKey(fa, other);
    let list = groups.get(gk);
    if (!list) {
      list = [];
      groups.set(gk, list);
      groupFaces.set(gk, [Math.min(fa, other), Math.max(fa, other)]);
    }
    list.push({ u, v });
  }

  // ---- walk each group into chains ---------------------------------------
  const segOut: number[] = [];
  const chains: {
    segStart: number;
    segCount: number;
    length: number;
    kind: number;
    a: Vec3;
    b: Vec3;
    center: Vec3;
    radius: number;
    normal: Vec3;
    faceA: number;
    faceB: number;
  }[] = [];
  const nodeIds = new Set<number>();

  for (const [gk, segs] of groups) {
    const [fa, fb] = groupFaces.get(gk)!;
    for (const path of walkChains(segs)) {
      const segStart = segOut.length / 6;
      const pts: Vec3[] = path.map(point);
      let length = 0;
      for (let i = 0; i + 1 < pts.length; i++) {
        const p = pts[i];
        const q = pts[i + 1];
        segOut.push(p[0], p[1], p[2], q[0], q[1], q[2]);
        length += distance(p, q);
      }
      const fit = fitChain(pts, diag);
      chains.push({
        segStart,
        segCount: pts.length - 1,
        length,
        kind: fit.kind,
        a: pts[0],
        b: pts[pts.length - 1],
        center: fit.center,
        radius: fit.radius,
        normal: fit.normal,
        faceA: fa,
        faceB: fb >= faceCount ? NO_FACE : fb,
      });
      nodeIds.add(path[0]);
      nodeIds.add(path[path.length - 1]);
    }
  }

  const vertices = new Float32Array(nodeIds.size * 3);
  let vi = 0;
  for (const w of nodeIds) {
    const p = point(w);
    vertices[vi * 3] = p[0];
    vertices[vi * 3 + 1] = p[1];
    vertices[vi * 3 + 2] = p[2];
    vi += 1;
  }

  const n = chains.length;
  const table = {
    edges: Float32Array.from(segOut),
    edgeSegStart: new Uint32Array(n),
    edgeSegCount: new Uint32Array(n),
    edgeLength: new Float32Array(n),
    edgeKind: new Uint8Array(n),
    edgeA: new Float32Array(n * 3),
    edgeB: new Float32Array(n * 3),
    edgeCenter: new Float32Array(n * 3),
    edgeRadius: new Float32Array(n),
    edgeNormal: new Float32Array(n * 3),
    edgeFaceA: new Uint32Array(n),
    edgeFaceB: new Uint32Array(n),
    vertices,
  };
  chains.forEach((c, i) => {
    table.edgeSegStart[i] = c.segStart;
    table.edgeSegCount[i] = c.segCount;
    table.edgeLength[i] = c.length;
    table.edgeKind[i] = c.kind;
    table.edgeRadius[i] = c.radius;
    table.edgeFaceA[i] = c.faceA;
    table.edgeFaceB[i] = c.faceB;
    write3(table.edgeA, i, c.a);
    write3(table.edgeB, i, c.b);
    write3(table.edgeCenter, i, c.center);
    write3(table.edgeNormal, i, c.normal);
  });

  return { ...table, ...faceAggregates(positions, indices, faceOfTri, faceCount, diag) };
}

function write3(target: Float32Array, i: number, v: Vec3): void {
  target[i * 3] = v[0];
  target[i * 3 + 1] = v[1];
  target[i * 3 + 2] = v[2];
}

/**
 * Orders a bag of segments into chains of welded vertex ids, each running
 * end to end (a closed chain starts and ends on the same id). Segments that
 * branch — three edges meeting at a point inside one face pair — end the
 * chain there, which is what a CAD kernel would call separate edges anyway.
 */
export function walkChains(segs: { u: number; v: number }[]): number[][] {
  const adj = new Map<number, number[]>();
  const push = (k: number, seg: number) => {
    const list = adj.get(k);
    if (list) list.push(seg);
    else adj.set(k, [seg]);
  };
  segs.forEach((s, i) => {
    push(s.u, i);
    push(s.v, i);
  });
  const used = new Uint8Array(segs.length);
  const out: number[][] = [];

  const follow = (start: number, firstSeg: number): number[] => {
    const path = [start];
    let node = start;
    let seg: number | undefined = firstSeg;
    while (seg !== undefined && !used[seg]) {
      used[seg] = 1;
      const s = segs[seg];
      node = s.u === node ? s.v : s.u;
      path.push(node);
      const next = (adj.get(node) ?? []).filter((i) => !used[i]);
      // A junction ends the chain: which way it continues is not ours to guess.
      seg = next.length === 1 ? next[0] : undefined;
    }
    return path;
  };

  // Open ends first so a chain isn't started in the middle of itself.
  for (const [node, list] of adj) {
    if (list.length !== 1) continue;
    const seg = list[0];
    if (used[seg]) continue;
    out.push(follow(node, seg));
  }
  for (let i = 0; i < segs.length; i++) {
    if (used[i]) continue;
    out.push(follow(segs[i].u, i));
  }
  return out.filter((p) => p.length >= 2);
}

/** Straight, circular or neither — with the circle's centre, radius and plane normal when it fits. */
export function fitChain(pts: Vec3[], diag: number): { kind: number; center: Vec3; radius: number; normal: Vec3 } {
  const none = { kind: EDGE_CURVE, center: [0, 0, 0] as Vec3, radius: 0, normal: [0, 0, 0] as Vec3 };
  if (pts.length < 2) return none;
  const closed = distance(pts[0], pts[pts.length - 1]) < Math.max(diag * 1e-6, 1e-9);
  const span = chainSpan(pts);
  const tol = Math.max(span * 1e-3, diag * 1e-6, 1e-9);

  // Straight: every point on the line through the ends (a closed chain never is).
  if (!closed) {
    const dir = sub(pts[pts.length - 1], pts[0]);
    const len = norm(dir);
    if (len > 1e-12) {
      const u = scale(dir, 1 / len);
      let straight = true;
      for (const p of pts) {
        if (norm(cross(sub(p, pts[0]), u)) > tol) {
          straight = false;
          break;
        }
      }
      if (straight) return { kind: EDGE_LINE, center: [0, 0, 0], radius: 0, normal: u };
    }
  }

  // Circular: fit on three spread points, then check every point.
  const i1 = Math.floor((pts.length - 1) / 3);
  const i2 = Math.floor((2 * (pts.length - 1)) / 3);
  const fit = circleThrough(pts[0], pts[i1 || 1], pts[i2 || pts.length - 1]);
  if (!fit) return none;
  for (const p of pts) {
    const d = sub(p, fit.center);
    if (Math.abs(norm(d) - fit.radius) > tol) return none;
    if (Math.abs(dot(d, fit.normal)) > tol) return none;
  }
  return { kind: closed ? EDGE_CIRCLE : EDGE_ARC, center: fit.center, radius: fit.radius, normal: fit.normal };
}

/** Circumcircle of three points in 3D, or null when they're collinear. */
export function circleThrough(a: Vec3, b: Vec3, c: Vec3): { center: Vec3; radius: number; normal: Vec3 } | null {
  const ab = sub(b, a);
  const ac = sub(c, a);
  const n = cross(ab, ac);
  const n2 = dot(n, n);
  if (n2 < 1e-24) return null;
  const term1 = scale(cross(n, ab), dot(ac, ac));
  const term2 = scale(cross(ac, n), dot(ab, ab));
  const offset = scale(add(term1, term2), 1 / (2 * n2));
  const center = add(a, offset);
  return { center, radius: norm(offset), normal: scale(n, 1 / Math.sqrt(n2)) };
}

function chainSpan(pts: Vec3[]): number {
  const min: Vec3 = [Infinity, Infinity, Infinity];
  const max: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (const p of pts) {
    for (let k = 0; k < 3; k++) {
      if (p[k] < min[k]) min[k] = p[k];
      if (p[k] > max[k]) max[k] = p[k];
    }
  }
  return Math.hypot(max[0] - min[0], max[1] - min[1], max[2] - min[2]);
}

/* ------------------------------ face tables ------------------------------ */

/**
 * Per-face area, centroid, average normal and planarity, plus the triangle
 * run each face owns. Triangles of one face are contiguous — OpenCascade
 * emits them face by face — so a face is a range, which is what makes
 * highlighting one cheap.
 */
export function faceAggregates(
  positions: Float32Array,
  indices: Uint32Array,
  faceOfTri: Int32Array,
  faceCount: number,
  diag: number,
): Pick<
  MeshTopology,
  "faceTriStart" | "faceTriCount" | "faceArea" | "faceCentroid" | "faceNormal" | "facePlanar" | "faceOfTriangle" | "volume" | "area" | "centroid"
> {
  const triCount = indices.length / 3;
  const faceOfTriangle = new Uint32Array(triCount);
  for (let t = 0; t < triCount; t++) faceOfTriangle[t] = Math.max(0, faceOfTri[t]);

  const triStart = new Uint32Array(faceCount).fill(0);
  const triCounts = new Uint32Array(faceCount);
  const area = new Float32Array(faceCount);
  const centroid = new Float32Array(faceCount * 3);
  const normal = new Float32Array(faceCount * 3);
  const planar = new Uint8Array(faceCount);
  const started = new Uint8Array(faceCount);
  let volume = 0;
  let totalArea = 0;
  // Centre of mass, by the same tetrahedron decomposition as `volume`: each
  // triangle plus the origin forms a signed tetrahedron whose own centroid
  // is the mean of its 4 vertices (the origin is 0, so 3 terms). Weighting
  // by the *signed* volume before dividing by the *signed* total is what
  // makes the origin's choice cancel out, same as it does for volume itself.
  let cmx = 0;
  let cmy = 0;
  let cmz = 0;

  for (let t = 0; t < triCount; t++) {
    const f = faceOfTriangle[t];
    if (f >= faceCount) continue;
    if (!started[f]) {
      started[f] = 1;
      triStart[f] = t;
    }
    triCounts[f] += 1;
    const ia = indices[t * 3] * 3;
    const ib = indices[t * 3 + 1] * 3;
    const ic = indices[t * 3 + 2] * 3;
    const a: Vec3 = [positions[ia], positions[ia + 1], positions[ia + 2]];
    const b: Vec3 = [positions[ib], positions[ib + 1], positions[ib + 2]];
    const c: Vec3 = [positions[ic], positions[ic + 1], positions[ic + 2]];
    const n = cross(sub(b, a), sub(c, a));
    const twiceArea = norm(n);
    const triArea = twiceArea / 2;
    area[f] += triArea;
    totalArea += triArea;
    // Signed tetrahedron volume about the origin; sums to the solid's volume for a closed shell.
    const tetVolume = dot(a, cross(b, c)) / 6;
    volume += tetVolume;
    cmx += tetVolume * ((a[0] + b[0] + c[0]) / 4);
    cmy += tetVolume * ((a[1] + b[1] + c[1]) / 4);
    cmz += tetVolume * ((a[2] + b[2] + c[2]) / 4);
    const cx = (a[0] + b[0] + c[0]) / 3;
    const cy = (a[1] + b[1] + c[1]) / 3;
    const cz = (a[2] + b[2] + c[2]) / 3;
    centroid[f * 3] += cx * triArea;
    centroid[f * 3 + 1] += cy * triArea;
    centroid[f * 3 + 2] += cz * triArea;
    normal[f * 3] += n[0];
    normal[f * 3 + 1] += n[1];
    normal[f * 3 + 2] += n[2];
  }

  for (let f = 0; f < faceCount; f++) {
    const a = area[f];
    if (a > 0) {
      centroid[f * 3] /= a;
      centroid[f * 3 + 1] /= a;
      centroid[f * 3 + 2] /= a;
    }
    const nx = normal[f * 3];
    const ny = normal[f * 3 + 1];
    const nz = normal[f * 3 + 2];
    const len = Math.hypot(nx, ny, nz);
    if (len > 0) {
      normal[f * 3] = nx / len;
      normal[f * 3 + 1] = ny / len;
      normal[f * 3 + 2] = nz / len;
    }
    // Planar when the summed normal is as long as the summed areas allow:
    // curvature cancels the sum, flatness doesn't.
    planar[f] = a > 0 && len >= 2 * a * 0.999 ? 1 : 0;
  }

  // A second pass pins planarity properly for faces whose triangles are tiny.
  for (let f = 0; f < faceCount; f++) {
    if (!planar[f] || triCounts[f] < 2) continue;
    const n: Vec3 = [normal[f * 3], normal[f * 3 + 1], normal[f * 3 + 2]];
    const c: Vec3 = [centroid[f * 3], centroid[f * 3 + 1], centroid[f * 3 + 2]];
    const tol = Math.max(diag * 1e-5, 1e-9);
    let flat = true;
    for (let t = triStart[f]; t < triStart[f] + triCounts[f] && flat; t++) {
      for (let k = 0; k < 3; k++) {
        const i = indices[t * 3 + k] * 3;
        const p: Vec3 = [positions[i], positions[i + 1], positions[i + 2]];
        if (Math.abs(dot(sub(p, c), n)) > tol) {
          flat = false;
          break;
        }
      }
    }
    planar[f] = flat ? 1 : 0;
  }

  const centroidOfMass: Vec3 = Math.abs(volume) > 1e-12 ? [cmx / volume, cmy / volume, cmz / volume] : [0, 0, 0];

  return {
    faceTriStart: triStart,
    faceTriCount: triCounts,
    faceArea: area,
    faceCentroid: centroid,
    faceNormal: normal,
    facePlanar: planar,
    faceOfTriangle,
    volume: Math.abs(volume),
    area: totalArea,
    centroid: centroidOfMass,
  };
}

/* ------------------------------ small vectors ----------------------------- */

export function sub(a: Vec3, b: Vec3): Vec3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}
export function add(a: Vec3, b: Vec3): Vec3 {
  return [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
}
export function scale(a: Vec3, k: number): Vec3 {
  return [a[0] * k, a[1] * k, a[2] * k];
}
export function dot(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}
export function cross(a: Vec3, b: Vec3): Vec3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}
export function norm(a: Vec3): number {
  return Math.hypot(a[0], a[1], a[2]);
}
export function distance(a: Vec3, b: Vec3): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}
export function normalize(a: Vec3): Vec3 {
  const l = norm(a);
  return l > 0 ? scale(a, 1 / l) : [0, 0, 0];
}

/* --------------------------- accessors on tables -------------------------- */

export function faceOf(t: FaceTable, i: number) {
  return {
    part: t.part[i],
    triStart: t.triStart[i],
    triCount: t.triCount[i],
    area: t.area[i],
    perimeter: t.perimeter[i],
    centroid: read3(t.centroid, i),
    normal: read3(t.normal, i),
    planar: t.planar[i] === 1,
  };
}

export function edgeOf(t: EdgeTable, i: number) {
  return {
    part: t.part[i],
    segStart: t.segStart[i],
    segCount: t.segCount[i],
    length: t.length[i],
    kind: t.kind[i],
    a: read3(t.a, i),
    b: read3(t.b, i),
    center: read3(t.center, i),
    radius: t.radius[i],
    normal: read3(t.normal, i),
  };
}

export function read3(arr: Float32Array, i: number): Vec3 {
  return [arr[i * 3], arr[i * 3 + 1], arr[i * 3 + 2]];
}
