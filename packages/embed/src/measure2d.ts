/**
 * E-06: the pure half of the drawing full view — the layer list, snapping,
 * and the point-to-point readout — so all of it is tested without a canvas.
 * The stage does the pointer handling and drawing.
 *
 * Drawings come out of the importers in millimetres, so lengths read in mm.
 * Angles are counter-clockwise from +X, as in the app (world Y is up).
 */
import type { Entity } from "../../core/src/entities";
import { layerOf } from "../../core/src/entities";
import type { Point } from "../../core/src/geometry";
import { kindSnaps, type KindSnap } from "../../core/src/kinds/registry";
import { mm } from "./fmt";
import type { Measurement } from "./three/measure";

/* --------------------------------- layers --------------------------------- */

export interface LayerInfo {
  name: string;
  /** Top-level entities on it. */
  count: number;
  /** Its most common entity colour, or null when its entities take the default ink. */
  color: string | null;
}

/** The drawing's layers, in name order ("0" first, numbers in numeric order), from what its entities use. */
export function layerList(entities: readonly Entity[]): LayerInfo[] {
  const by = new Map<string, { count: number; colors: Map<string, number> }>();
  for (const e of entities) {
    const name = layerOf(e);
    let l = by.get(name);
    if (!l) by.set(name, (l = { count: 0, colors: new Map() }));
    l.count++;
    const c = e.color ?? "";
    l.colors.set(c, (l.colors.get(c) ?? 0) + 1);
  }
  const out: LayerInfo[] = [];
  for (const [name, l] of by) {
    let color = "";
    let best = -1;
    for (const [c, n] of l.colors) if (n > best) (best = n), (color = c);
    out.push({ name, count: l.count, color: color || null });
  }
  return out.sort((a, b) => (a.name === "0" ? -1 : b.name === "0" ? 1 : a.name.localeCompare(b.name, "en", { numeric: true, sensitivity: "base" })));
}

/* -------------------------------- snapping -------------------------------- */

export type SnapKind = KindSnap["kind"];
const KINDS: readonly SnapKind[] = ["endpoint", "midpoint", "center", "quadrant", "node"];

/** Snap points of a whole drawing, sorted by x so a lookup scans only a thin vertical strip. */
export interface SnapIndex {
  xs: Float64Array;
  ys: Float64Array;
  kinds: Uint8Array;
  /** Index into `layers`. */
  layer: Uint32Array;
  layers: string[];
}

/** Past this many snap points the rest are left out; a preview doesn't need to snap to every vertex of a huge file. */
export const MAX_SNAP_POINTS = 1_000_000;

/**
 * Collects every entity's snap points (ends, midpoints, centres, quadrants,
 * nodes — what the app's object snap offers). Inserts need their blocks, so
 * call it inside `withBlocks`.
 */
export function buildSnapIndex(entities: readonly Entity[]): SnapIndex {
  const xs: number[] = [];
  const ys: number[] = [];
  const kinds: number[] = [];
  const layerIdx: number[] = [];
  const layers: string[] = [];
  const layerId = new Map<string, number>();
  outer: for (const e of entities) {
    const name = layerOf(e);
    let li = layerId.get(name);
    if (li === undefined) {
      li = layers.length;
      layers.push(name);
      layerId.set(name, li);
    }
    let snaps: KindSnap[];
    try {
      snaps = kindSnaps(e);
    } catch {
      continue; // a malformed entity just doesn't snap
    }
    for (const s of snaps) {
      if (!Number.isFinite(s.point.x) || !Number.isFinite(s.point.y)) continue;
      if (xs.length >= MAX_SNAP_POINTS) break outer;
      xs.push(s.point.x);
      ys.push(s.point.y);
      kinds.push(Math.max(0, KINDS.indexOf(s.kind)));
      layerIdx.push(li);
    }
  }
  const order = Array.from(xs.keys()).sort((a, b) => xs[a] - xs[b]);
  const n = order.length;
  const idx: SnapIndex = { xs: new Float64Array(n), ys: new Float64Array(n), kinds: new Uint8Array(n), layer: new Uint32Array(n), layers };
  for (let i = 0; i < n; i++) {
    const j = order[i];
    idx.xs[i] = xs[j];
    idx.ys[i] = ys[j];
    idx.kinds[i] = kinds[j];
    idx.layer[i] = layerIdx[j];
  }
  return idx;
}

export interface Snap {
  point: Point;
  kind: SnapKind;
}

/** The snap point nearest `p` within `tol` (world units), skipping hidden layers; null when none is that close. */
export function nearestSnap(idx: SnapIndex, p: Point, tol: number, hidden?: ReadonlySet<string>): Snap | null {
  const { xs, ys } = idx;
  let lo = 0;
  let hi = xs.length;
  const x0 = p.x - tol;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (xs[mid] < x0) lo = mid + 1;
    else hi = mid;
  }
  let best = -1;
  let bestD = tol * tol;
  const x1 = p.x + tol;
  for (let i = lo; i < xs.length && xs[i] <= x1; i++) {
    const dx = xs[i] - p.x;
    const dy = ys[i] - p.y;
    const d = dx * dx + dy * dy;
    if (d > bestD) continue;
    if (hidden && hidden.size && hidden.has(idx.layers[idx.layer[i]])) continue;
    // Ties go to the stronger kind (an endpoint over the midpoint of a zero-length line).
    if (d < bestD || best < 0 || idx.kinds[i] < idx.kinds[best]) {
      best = i;
      bestD = d;
    }
  }
  return best < 0 ? null : { point: { x: xs[best], y: ys[best] }, kind: KINDS[idx.kinds[best]] };
}

/* --------------------------------- readout -------------------------------- */

/** Distance, the two deltas and the direction from `a` to `b`. */
export function measurePoints(a: Point, b: Point): Measurement {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  let deg = (Math.atan2(dy, dx) * 180) / Math.PI;
  if (deg < 0) deg += 360;
  // Two places, always: angles are compared by eye ("90.00°"), and a hair under 360 reads as 0.
  let angle = deg.toFixed(2);
  if (angle === "360.00" || angle === "-0.00") angle = "0.00";
  return {
    rows: [
      { label: "Distance", value: mm(Math.hypot(dx, dy)) },
      { label: "ΔX", value: mm(dx) },
      { label: "ΔY", value: mm(dy) },
      { label: "Angle", value: `${angle}°` },
    ],
    segment: null,
  };
}

/** The readout while only the first point is down and nothing is hovered yet. */
export const FIRST_POINT_PROMPT: Measurement = { rows: [{ label: "Measure", value: "click a second point" }], segment: null };
