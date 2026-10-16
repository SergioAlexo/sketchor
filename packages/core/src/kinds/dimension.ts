import type { Bounds } from "../dxf";
import type { DimensionEntity } from "../entities";
import type { Point } from "../geometry";
import { distToSegment } from "../geometry";
import { pointInPolygon } from "../regions";
import { dimTextBox, dimTextStrokes } from "../dimensions/explode";
import { activeDimHost } from "../dimensions/context";
import { layoutOf, resolveGeometry } from "../dimensions/resolve";
import { mapPoint, similarity } from "./affine";
import { boundsOfPoints, type Affine, type EntityKind, type KindSnap } from "./registry";

/**
 * D-02a: the dimension kind. Everything geometric comes from the layout
 * (`dimensions/layout.ts`) so tessellation, bounds, hit test and snaps agree
 * with what is drawn. Text is tessellated through the stroke font so exports
 * that only know polylines still show it; writers with real text support
 * explode the dimension instead (`dimensions/explode.ts`).
 */

/** Grip index offset for "move this def point" grips (index 0 is the text). */
export const DEF_POINT_GRIP = 100;

/** Index of the def point that positions the dimension line / arc / leader, per kind. */
export function locatorIndex(e: DimensionEntity): number {
  switch (e.kind) {
    case "linear":
    case "aligned":
    case "ordinate":
      return 2;
    case "angular3p":
    case "arclength":
      return 3;
    case "angular2l":
      return 4;
    case "centermark":
    case "centerline":
      return -1; // nothing to place: they follow their geometry
    default:
      return 1;
  }
}

/** D-09: the definition points that get a grip (their index in `defPoints`). Associated circle / arc dimensions only expose what the geometry does not decide. */
export function gripIndices(e: DimensionEntity): number[] {
  switch (e.kind) {
    case "centermark":
    case "centerline":
      return [];
    case "radial":
    case "diametric":
    case "arclength":
      return e.target ? [locatorIndex(e)] : e.defPoints.map((_, i) => i);
    case "jogged":
      return e.target ? [1, 2] : e.defPoints.map((_, i) => i);
    case "ordinate":
      return [1, 2]; // the feature point and the leader end; the origin is a coordinate system, not a handle
    default:
      return e.defPoints.map((_, i) => i);
  }
}

function runs(e: DimensionEntity): Point[][] {
  const l = layoutOf(e);
  const out = [...l.lines, ...l.fills];
  if (l.text) out.push(...dimTextStrokes(l.text));
  return out;
}

function textBox(e: DimensionEntity): Point[] | null {
  const l = layoutOf(e);
  return l.text && l.text.text ? dimTextBox(l.text) : null;
}

export const dimensionKind: EntityKind<DimensionEntity> = {
  type: "dimension",
  tessellate: (e) => runs(e),
  bounds: (e): Bounds | null => {
    const l = layoutOf(e);
    const pts = [...l.lines.flat(), ...l.fills.flat()];
    const box = textBox(e);
    if (box) pts.push(...box);
    return boundsOfPoints(pts);
  },
  transform: (e, m: Affine) => {
    const s = similarity(m);
    if (!s) return null;
    const rot = s.rotation;
    let axis = e.axis;
    if (e.kind === "ordinate") {
      // Ordinate reads a world axis: only a right-angle turn (or none) keeps that meaning.
      const q = (((rot / (Math.PI / 2)) % 4) + 4) % 4;
      const r = Math.round(q);
      if (Math.abs(q - r) > 1e-9) return null;
      if (r % 2 === 1) axis = e.axis === "y" ? "x" : "y";
    }
    const angular = e.kind === "angular2l" || e.kind === "angular3p";
    let angle = e.angle;
    if (e.kind === "linear") {
      const a = e.angle ?? 0;
      angle = Math.atan2(m[1] * Math.cos(a) + m[3] * Math.sin(a), m[0] * Math.cos(a) + m[2] * Math.sin(a));
    }
    return {
      ...e,
      defPoints: e.defPoints.map((p) => mapPoint(m, p)),
      ...(e.textPos ? { textPos: mapPoint(m, e.textPos) } : {}),
      ...(angle !== undefined ? { angle } : {}),
      ...(axis !== undefined ? { axis } : {}),
      scale: (e.scale ?? 1) * s.scale,
      ...(e.value !== undefined && !angular ? { value: e.value * s.scale } : {}),
    };
  },
  path: () => null,
  snaps: (e): KindSnap[] => {
    const l = layoutOf(e);
    const out: KindSnap[] = [];
    for (const run of l.lines) {
      out.push({ point: run[0], kind: "endpoint" });
      if (run.length > 1) out.push({ point: run[run.length - 1], kind: "endpoint" });
    }
    for (const f of l.fills) if (f.length > 0) out.push({ point: f[0], kind: "endpoint" });
    return out;
  },
  grips: (e) => {
    const l = layoutOf(e);
    const out = [];
    if (l.text) out.push({ point: l.text.at, kind: "mid" as const, index: 0 });
    const pts = resolveGeometry(e, (() => { const h = activeDimHost(); return h ? (id: string) => h.get(id) : undefined; })()).pts;
    for (const i of gripIndices(e)) {
      const p = pts[i] ?? e.defPoints[i];
      if (p && Number.isFinite(p.x) && Number.isFinite(p.y)) out.push({ point: p, kind: "vertex" as const, index: DEF_POINT_GRIP + i });
    }
    return out;
  },
  applyGrip: (e, g, to) => {
    if (g.index === 0) return { ...e, textPos: { x: to.x, y: to.y } };
    const i = g.index - DEF_POINT_GRIP;
    if (i < 0 || i >= e.defPoints.length) return e;
    const defPoints = e.defPoints.slice();
    defPoints[i] = { x: to.x, y: to.y };
    // A dragged point is no longer an anchor to geometry (D-09: also for extension-line origins): drop its ref so the move sticks.
    const refs = e.refs ? e.refs.map((r, k) => (k === i ? null : r)) : undefined;
    return { ...e, defPoints, ...(refs ? { refs } : {}) };
  },
  hitDistance: (e, p) => {
    const l = layoutOf(e);
    const box = textBox(e);
    if (box && pointInPolygon(p, box)) return 0;
    let best = Infinity;
    for (const run of [...l.lines, ...l.fills]) {
      for (let i = 0; i + 1 < run.length; i++) best = Math.min(best, distToSegment(p, run[i], run[i + 1]));
    }
    if (box) for (let i = 0; i < box.length; i++) best = Math.min(best, distToSegment(p, box[i], box[(i + 1) % box.length]));
    return best;
  },
};
