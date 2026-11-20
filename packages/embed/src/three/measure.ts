import { EDGE_ARC, EDGE_CIRCLE, EDGE_CURVE, EDGE_LINE, cross, distance, dot, norm, normalize, read3, sub } from "./topology";
import type { Model3D, Vec3 } from "./types";

/**
 * What the corner readout says about a selection — Onshape's measure box:
 * click one thing and it tells you its length, radius or area; click two
 * and it tells you the distance and, where it means something, the angle.
 *
 * Pure: the viewer hands in the model, the picked references and the
 * formatters (so the numbers land in the tab's display unit), and gets
 * back label/value rows.
 */

export type SelRef =
  | { kind: "vertex"; index: number }
  | { kind: "edge"; index: number }
  | { kind: "face"; index: number }
  | { kind: "part"; index: number };

export interface MeasureRow {
  label: string;
  value: string;
  /** Set when the figure is derived rather than exact (a tessellated curve, a non-planar face). */
  approx?: boolean;
}

/**
 * The two points a measurement is actually taken between — what the
 * viewer draws the dimension line and the ΔX/ΔY/ΔZ legs from. A number
 * with no line to it is a number the user has to take on trust: "23 in"
 * between two planes says nothing about *where* those 23 inches were
 * measured.
 */
export interface MeasureSegment {
  from: Vec3;
  to: Vec3;
  /** The ends are sampled (a tessellated curve, a non-planar face) rather than exact. */
  approx?: boolean;
}

export interface Measurement {
  rows: MeasureRow[];
  /** Null for a measurement that isn't a distance (an area, an angle between planes, a part summary). */
  segment: MeasureSegment | null;
}

export interface Formatters {
  length(worldValue: number): string;
  area(worldValueSquared: number): string;
  volume(worldValueCubed: number): string;
  /** Takes the same raw enclosed volume `volume` does — density and the display unit are both baked in by the caller, same as the others. */
  mass(worldValueCubed: number): string;
}

const deg = (rad: number) => `${round(((rad * 180) / Math.PI), 2)}°`;

function round(v: number, places = 3): number {
  const f = 10 ** places;
  const r = Math.round(v * f) / f;
  return Object.is(r, -0) ? 0 : r;
}

export function sameRef(a: SelRef, b: SelRef): boolean {
  return a.kind === b.kind && a.index === b.index;
}

/** Which part a reference belongs to (for the readout's title and for hiding). */
export function partOf(model: Model3D, ref: SelRef): number {
  switch (ref.kind) {
    case "part":
      return ref.index;
    case "face":
      return model.faces.part[ref.index] ?? 0;
    case "edge":
      return model.edgeTable.part[ref.index] ?? 0;
    case "vertex":
      return model.nodes.part[ref.index] ?? 0;
  }
}

export function refLabel(model: Model3D, ref: SelRef): string {
  switch (ref.kind) {
    case "part":
      return model.parts[ref.index]?.name ?? "Part";
    case "face":
      return model.faces.planar[ref.index] ? "Plane" : "Face";
    case "edge": {
      const k = model.edgeTable.kind[ref.index];
      return k === EDGE_CIRCLE ? "Circle" : k === EDGE_ARC ? "Arc" : k === EDGE_LINE ? "Line" : "Edge";
    }
    case "vertex":
      return "Vertex";
  }
}

/* -------------------------------- geometry -------------------------------- */

/** The points of an edge's polyline (one per segment plus the last end). */
export function edgePoints(model: Model3D, edge: number): Vec3[] {
  const start = model.edgeTable.segStart[edge];
  const count = model.edgeTable.segCount[edge];
  const out: Vec3[] = [];
  for (let i = 0; i < count; i++) {
    const o = (start + i) * 6;
    if (i === 0) out.push([model.edges[o], model.edges[o + 1], model.edges[o + 2]]);
    out.push([model.edges[o + 3], model.edges[o + 4], model.edges[o + 5]]);
  }
  return out;
}

export function vertexPoint(model: Model3D, index: number): Vec3 {
  return read3(model.nodes.xyz, index);
}

function pointToSegment(p: Vec3, a: Vec3, b: Vec3): number {
  const ab = sub(b, a);
  const len2 = dot(ab, ab);
  if (len2 < 1e-18) return distance(p, a);
  let t = dot(sub(p, a), ab) / len2;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return distance(p, [a[0] + ab[0] * t, a[1] + ab[1] * t, a[2] + ab[2] * t]);
}

export function pointToPolyline(p: Vec3, pts: Vec3[]): number {
  return closestOnPolyline(p, pts).d;
}

/** The point on a segment nearest `p`. */
export function closestOnSegment(p: Vec3, a: Vec3, b: Vec3): Vec3 {
  const ab = sub(b, a);
  const len2 = dot(ab, ab);
  if (len2 < 1e-18) return a;
  let t = dot(sub(p, a), ab) / len2;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return [a[0] + ab[0] * t, a[1] + ab[1] * t, a[2] + ab[2] * t];
}

/** The point on a polyline nearest `p`, with the distance to it. */
export function closestOnPolyline(p: Vec3, pts: Vec3[]): { at: Vec3; d: number } {
  if (pts.length === 0) return { at: p, d: 0 };
  if (pts.length === 1) return { at: pts[0], d: distance(p, pts[0]) };
  let best: { at: Vec3; d: number } | null = null;
  for (let i = 0; i + 1 < pts.length; i++) {
    const at = closestOnSegment(p, pts[i], pts[i + 1]);
    const d = distance(p, at);
    if (!best || d < best.d) best = { at, d };
  }
  return best!;
}

/** Shortest distance between two line segments (exact, including parallel and touching cases). */
export function segmentToSegment(p1: Vec3, q1: Vec3, p2: Vec3, q2: Vec3): number {
  return closestSegmentToSegment(p1, q1, p2, q2).d;
}

/** The nearest pair of points on two segments, and the distance between them. */
export function closestSegmentToSegment(p1: Vec3, q1: Vec3, p2: Vec3, q2: Vec3): { a: Vec3; b: Vec3; d: number } {
  const d1 = sub(q1, p1);
  const d2 = sub(q2, p2);
  const r = sub(p1, p2);
  const a = dot(d1, d1);
  const e = dot(d2, d2);
  const f = dot(d2, r);
  let s = 0;
  let t = 0;
  if (a < 1e-18 && e < 1e-18) return { a: p1, b: p2, d: distance(p1, p2) };
  if (a < 1e-18) {
    t = clamp01(f / e);
  } else {
    const c = dot(d1, r);
    if (e < 1e-18) {
      s = clamp01(-c / a);
    } else {
      const b = dot(d1, d2);
      const denom = a * e - b * b;
      s = denom > 1e-18 ? clamp01((b * f - c * e) / denom) : 0;
      t = (b * s + f) / e;
      if (t < 0) {
        t = 0;
        s = clamp01(-c / a);
      } else if (t > 1) {
        t = 1;
        s = clamp01((b - c) / a);
      }
    }
  }
  const c1: Vec3 = [p1[0] + d1[0] * s, p1[1] + d1[1] * s, p1[2] + d1[2] * s];
  const c2: Vec3 = [p2[0] + d2[0] * t, p2[1] + d2[1] * t, p2[2] + d2[2] * t];
  return { a: c1, b: c2, d: distance(c1, c2) };
}

export function polylineToPolyline(a: Vec3[], b: Vec3[]): number {
  return closestPolylineToPolyline(a, b).d;
}

/** The nearest pair of points on two polylines, and the distance between them. */
export function closestPolylineToPolyline(a: Vec3[], b: Vec3[]): { a: Vec3; b: Vec3; d: number } {
  let best: { a: Vec3; b: Vec3; d: number } | null = null;
  for (let i = 0; i + 1 < a.length; i++) {
    for (let j = 0; j + 1 < b.length; j++) {
      const hit = closestSegmentToSegment(a[i], a[i + 1], b[j], b[j + 1]);
      if (!best || hit.d < best.d) best = hit;
    }
  }
  if (best) return best;
  // Degenerate input (a one-point "polyline"): fall back to the points themselves.
  return { a: a[0] ?? [0, 0, 0], b: b[0] ?? [0, 0, 0], d: distance(a[0] ?? [0, 0, 0], b[0] ?? [0, 0, 0]) };
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/** Acute angle (radians) between two directions, sign-independent — an edge has no preferred way round. */
export function acuteAngle(u: Vec3, v: Vec3): number {
  const c = Math.abs(dot(normalize(u), normalize(v)));
  return Math.acos(Math.min(1, Math.max(0, c)));
}

/** Direction of a straight edge (its chord, which for EDGE_LINE is the edge). */
export function edgeDirection(model: Model3D, edge: number): Vec3 {
  return sub(read3(model.edgeTable.b, edge), read3(model.edgeTable.a, edge));
}

/** Every distinct vertex position of a face's triangles (capped — a face can carry thousands). */
function faceSamplePoints(model: Model3D, face: number, cap = 600): Vec3[] {
  const start = model.faces.triStart[face];
  const count = model.faces.triCount[face];
  const step = Math.max(1, Math.floor(count / cap));
  const out: Vec3[] = [];
  for (let t = 0; t < count; t += step) {
    for (let k = 0; k < 3; k++) {
      const vi = model.indices[(start + t) * 3 + k] * 3;
      out.push([model.positions[vi], model.positions[vi + 1], model.positions[vi + 2]]);
    }
  }
  return out;
}

/** Radius a face turns out to have when circular edges bound it (a cylinder, a hole), else null. */
export function faceRadius(model: Model3D, face: number): number | null {
  const part = model.faces.part[face];
  const p = model.parts[part];
  if (!p) return null;
  let radius: number | null = null;
  for (let e = p.edgeRefStart; e < p.edgeRefStart + p.edgeRefCount; e++) {
    if (model.edgeTable.faceA[e] !== face && model.edgeTable.faceB[e] !== face) continue;
    const kind = model.edgeTable.kind[e];
    if (kind !== EDGE_CIRCLE && kind !== EDGE_ARC) continue;
    const r = model.edgeTable.radius[e];
    if (radius === null) radius = r;
    else if (Math.abs(radius - r) > Math.max(r, radius) * 1e-3) return null;
  }
  return radius;
}

/* ------------------------------ the readout ------------------------------ */

export function measureSelection(model: Model3D, refs: SelRef[], fmt: Formatters): Measurement {
  if (refs.length === 0) return { rows: [], segment: null };
  if (refs.length === 1) return measureOne(model, refs[0], fmt);
  const pair = measurePair(model, refs[refs.length - 2], refs[refs.length - 1], fmt);
  const rows = pair.rows;
  // Totals make a multi-select worth something even when the pair says
  // little — except a face pair, which already reports its combined area.
  if (refs.length > 2 && refs.every((r) => r.kind === "face")) {
    const total = refs.reduce((a, r) => a + model.faces.area[r.index], 0);
    rows.push({ label: `Total area (${refs.length})`, value: fmt.area(total) });
  }
  if (refs.every((r) => r.kind === "edge")) {
    const total = refs.reduce((a, r) => a + model.edgeTable.length[r.index], 0);
    rows.push({ label: `Total length (${refs.length})`, value: fmt.length(total) });
  }
  if (refs.length > 2 && refs.every((r) => r.kind === "part")) {
    const { area, volume } = sumParts(model, refs.map((r) => r.index));
    rows.push(
      { label: `Total surface area (${refs.length})`, value: fmt.area(area) },
      { label: `Total volume (${refs.length})`, value: fmt.volume(volume), approx: true },
      { label: `Total mass (${refs.length})`, value: fmt.mass(volume), approx: true },
    );
  }
  return { rows, segment: pair.segment };
}

/** Combined surface area and volume of a set of whole parts — what "how much material is this subassembly" means. */
function sumParts(model: Model3D, indices: number[]): { area: number; volume: number } {
  let area = 0;
  let volume = 0;
  for (const i of indices) {
    const p = model.parts[i];
    if (!p) continue;
    area += p.area;
    volume += p.volume;
  }
  return { area, volume };
}

/**
 * The ΔX / ΔY / ΔZ row for a measured span, and the row order the readout
 * uses: the straight-line distance first, then how it breaks down along
 * the axes. Both come from the same two points the dimension line is
 * drawn between, so the picture and the numbers can't disagree.
 */
function deltaRow(segment: MeasureSegment, fmt: Formatters): MeasureRow {
  const [ax, ay, az] = segment.from;
  const [bx, by, bz] = segment.to;
  return {
    label: "ΔX ΔY ΔZ",
    value: `${fmt.length(bx - ax)}, ${fmt.length(by - ay)}, ${fmt.length(bz - az)}`,
    approx: segment.approx,
  };
}

/** A distance measurement: the span, its length, and the deltas along it. */
function spanRows(label: string, segment: MeasureSegment, fmt: Formatters, extra: MeasureRow[] = []): Measurement {
  return {
    rows: [
      { label, value: fmt.length(distance(segment.from, segment.to)), approx: segment.approx },
      ...extra,
      deltaRow(segment, fmt),
    ],
    segment,
  };
}

function measureOne(model: Model3D, ref: SelRef, fmt: Formatters): Measurement {
  switch (ref.kind) {
    case "vertex": {
      const p = vertexPoint(model, ref.index);
      return {
        rows: [
          { label: "X", value: fmt.length(p[0]) },
          { label: "Y", value: fmt.length(p[1]) },
          { label: "Z", value: fmt.length(p[2]) },
        ],
        segment: null,
      };
    }
    case "edge": {
      const t = model.edgeTable;
      const kind = t.kind[ref.index];
      const rows: MeasureRow[] = [];
      if (kind === EDGE_CIRCLE || kind === EDGE_ARC) {
        rows.push({ label: "Diameter", value: fmt.length(t.radius[ref.index] * 2) });
        rows.push({ label: "Radius", value: fmt.length(t.radius[ref.index]) });
        if (kind === EDGE_ARC && t.radius[ref.index] > 0) {
          rows.push({ label: "Angle", value: deg(t.length[ref.index] / t.radius[ref.index]) });
        }
        const c = read3(t.center, ref.index);
        rows.push({ label: "Center", value: `${fmt.length(c[0])}, ${fmt.length(c[1])}, ${fmt.length(c[2])}` });
      }
      rows.push({ label: "Length", value: fmt.length(t.length[ref.index]), approx: kind === EDGE_CURVE });
      const a = read3(t.a, ref.index);
      const b = read3(t.b, ref.index);
      // A straight edge measures itself: the dimension line runs along it,
      // and the deltas are its span. A circle shows its radius instead —
      // a line from the centre out to where the rim starts.
      if (kind === EDGE_LINE) {
        const segment: MeasureSegment = { from: a, to: b };
        rows.push(deltaRow(segment, fmt));
        return { rows, segment };
      }
      if (kind === EDGE_CIRCLE || kind === EDGE_ARC) {
        return { rows, segment: { from: read3(t.center, ref.index), to: a } };
      }
      return { rows, segment: null };
    }
    case "face": {
      const rows: MeasureRow[] = [{ label: "Area", value: fmt.area(model.faces.area[ref.index]), approx: !model.faces.planar[ref.index] }];
      rows.push({ label: "Perimeter", value: fmt.length(model.faces.perimeter[ref.index]) });
      const r = faceRadius(model, ref.index);
      if (r !== null && !model.faces.planar[ref.index]) {
        rows.push({ label: "Diameter", value: fmt.length(r * 2) });
        rows.push({ label: "Radius", value: fmt.length(r) });
      }
      if (model.faces.planar[ref.index]) {
        const n = read3(model.faces.normal, ref.index);
        rows.push({ label: "Normal", value: `${round(n[0])}, ${round(n[1])}, ${round(n[2])}` });
      }
      return { rows, segment: null };
    }
    case "part": {
      const p = model.parts[ref.index];
      if (!p) return { rows: [], segment: null };
      const size = [0, 1, 2].map((k) => p.bounds.max[k] - p.bounds.min[k]);
      return {
        rows: [
          { label: "Size", value: size.map((v) => fmt.length(v)).join(" × ") },
          { label: "Surface area", value: fmt.area(p.area) },
          { label: "Volume", value: fmt.volume(p.volume), approx: true },
          { label: "Mass", value: fmt.mass(p.volume), approx: true },
          {
            label: "Center of mass",
            value: `${fmt.length(p.centroid[0])}, ${fmt.length(p.centroid[1])}, ${fmt.length(p.centroid[2])}`,
            approx: true,
          },
          { label: "Faces / edges", value: `${p.faceCount} / ${p.edgeRefCount}` },
        ],
        segment: null,
      };
    }
  }
}

function measurePair(model: Model3D, a: SelRef, b: SelRef, fmt: Formatters): Measurement {
  const kinds = [a.kind, b.kind].sort().join("+");

  if (kinds === "vertex+vertex") {
    const from = vertexPoint(model, (a as Extract<SelRef, { kind: "vertex" }>).index);
    const to = vertexPoint(model, (b as Extract<SelRef, { kind: "vertex" }>).index);
    return spanRows("Distance", { from, to }, fmt);
  }

  if (kinds === "edge+vertex") {
    const v = (a.kind === "vertex" ? a : b) as Extract<SelRef, { kind: "vertex" }>;
    const e = (a.kind === "edge" ? a : b) as Extract<SelRef, { kind: "edge" }>;
    const p = vertexPoint(model, v.index);
    const near = closestOnPolyline(p, edgePoints(model, e.index));
    return spanRows("Distance", { from: p, to: near.at, approx: model.edgeTable.kind[e.index] === EDGE_CURVE }, fmt);
  }

  if (kinds === "face+vertex") {
    const v = (a.kind === "vertex" ? a : b) as Extract<SelRef, { kind: "vertex" }>;
    const f = (a.kind === "face" ? a : b) as Extract<SelRef, { kind: "face" }>;
    const p = vertexPoint(model, v.index);
    return faceSpan(model, f.index, [p], fmt);
  }

  if (kinds === "edge+edge") {
    const ea = a as Extract<SelRef, { kind: "edge" }>;
    const eb = b as Extract<SelRef, { kind: "edge" }>;
    const ka = model.edgeTable.kind[ea.index];
    const kb = model.edgeTable.kind[eb.index];
    const extra: MeasureRow[] = [];
    if (ka === EDGE_LINE && kb === EDGE_LINE) {
      const angle = acuteAngle(edgeDirection(model, ea.index), edgeDirection(model, eb.index));
      extra.push({ label: "Angle", value: deg(angle) });
    }
    if ((ka === EDGE_CIRCLE || ka === EDGE_ARC) && (kb === EDGE_CIRCLE || kb === EDGE_ARC)) {
      const ca = read3(model.edgeTable.center, ea.index);
      const cb = read3(model.edgeTable.center, eb.index);
      extra.push({ label: "Centre distance", value: fmt.length(distance(ca, cb)) });
    }
    const near = closestPolylineToPolyline(edgePoints(model, ea.index), edgePoints(model, eb.index));
    const approx = ka === EDGE_CURVE || kb === EDGE_CURVE;
    return spanRows("Distance", { from: near.a, to: near.b, approx }, fmt, extra);
  }

  if (kinds === "edge+face") {
    const e = (a.kind === "edge" ? a : b) as Extract<SelRef, { kind: "edge" }>;
    const f = (a.kind === "face" ? a : b) as Extract<SelRef, { kind: "face" }>;
    const extra: MeasureRow[] = [];
    if (model.faces.planar[f.index] && model.edgeTable.kind[e.index] === EDGE_LINE) {
      const n = read3(model.faces.normal, f.index);
      const angle = Math.PI / 2 - acuteAngle(edgeDirection(model, e.index), n);
      extra.push({ label: "Angle", value: deg(Math.abs(angle)) });
    }
    return faceSpan(model, f.index, edgePoints(model, e.index), fmt, extra);
  }

  if (kinds === "face+face") {
    const fa = a as Extract<SelRef, { kind: "face" }>;
    const fb = b as Extract<SelRef, { kind: "face" }>;
    const area: MeasureRow = { label: "Total area", value: fmt.area(model.faces.area[fa.index] + model.faces.area[fb.index]) };
    if (model.faces.planar[fa.index] && model.faces.planar[fb.index]) {
      const na = read3(model.faces.normal, fa.index);
      const nb = read3(model.faces.normal, fb.index);
      const parallel = norm(cross(normalize(na), normalize(nb))) < 1e-3;
      const ca = read3(model.faces.centroid, fa.index);
      if (parallel) {
        // Parallel planes: measure straight along the normal, from one
        // face's centroid to the point opposite it on the other. That is
        // the 23 in a user means by "how far apart are these two faces".
        const n = normalize(na);
        const cb = read3(model.faces.centroid, fb.index);
        const gap = dot(sub(cb, ca), n);
        const to: Vec3 = [ca[0] + n[0] * gap, ca[1] + n[1] * gap, ca[2] + n[2] * gap];
        const measured = spanRows("Distance", { from: ca, to }, fmt);
        return { rows: [...measured.rows, area], segment: measured.segment };
      }
      const angle = acuteAngle(na, nb);
      return { rows: [{ label: "Angle", value: deg(angle) }, area], segment: null };
    }
    const measured = faceSpan(model, fb.index, faceSamplePoints(model, fa.index), fmt);
    return { rows: [...measured.rows, area], segment: measured.segment };
  }

  if (kinds === "part+part") {
    const pa = a as Extract<SelRef, { kind: "part" }>;
    const pb = b as Extract<SelRef, { kind: "part" }>;
    const { area, volume } = sumParts(model, [pa.index, pb.index]);
    return {
      rows: [
        { label: "Total surface area", value: fmt.area(area) },
        { label: "Total volume", value: fmt.volume(volume), approx: true },
        { label: "Total mass", value: fmt.mass(volume), approx: true },
      ],
      segment: null,
    };
  }

  // Anything involving a whole part: report both, nothing clever.
  return {
    rows: [
      { label: refLabel(model, a), value: summary(model, a, fmt) },
      { label: refLabel(model, b), value: summary(model, b, fmt) },
    ],
    segment: null,
  };
}

/**
 * The span from a set of points to a face: exact and perpendicular for a
 * planar face (the foot of the perpendicular is where the line lands),
 * nearest-sample otherwise.
 */
function faceSpan(model: Model3D, face: number, points: Vec3[], fmt: Formatters, extra: MeasureRow[] = []): Measurement {
  if (model.faces.planar[face]) {
    const n = normalize(read3(model.faces.normal, face));
    const c = read3(model.faces.centroid, face);
    let best: { from: Vec3; to: Vec3; d: number } | null = null;
    for (const p of points) {
      const gap = dot(sub(p, c), n);
      const to: Vec3 = [p[0] - n[0] * gap, p[1] - n[1] * gap, p[2] - n[2] * gap];
      const d = Math.abs(gap);
      if (!best || d < best.d) best = { from: p, to, d };
    }
    if (!best) return { rows: extra, segment: null };
    return spanRows("Distance to plane", { from: best.from, to: best.to }, fmt, extra);
  }
  const samples = faceSamplePoints(model, face);
  let best: { from: Vec3; to: Vec3; d: number } | null = null;
  for (const p of points) {
    for (const q of samples) {
      const d = distance(p, q);
      if (!best || d < best.d) best = { from: p, to: q, d };
    }
  }
  if (!best) return { rows: extra, segment: null };
  return spanRows("Distance", { from: best.from, to: best.to, approx: true }, fmt, extra);
}

function summary(model: Model3D, ref: SelRef, fmt: Formatters): string {
  switch (ref.kind) {
    case "vertex": {
      const p = vertexPoint(model, ref.index);
      return `${fmt.length(p[0])}, ${fmt.length(p[1])}, ${fmt.length(p[2])}`;
    }
    case "edge":
      return fmt.length(model.edgeTable.length[ref.index]);
    case "face":
      return fmt.area(model.faces.area[ref.index]);
    case "part":
      return model.parts[ref.index]?.name ?? "";
  }
}
