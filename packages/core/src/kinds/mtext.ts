import type { MTextEntity } from "../entities";
import { distToSegment } from "../geometry";
import type { Grip } from "../grips";
import { pointInPolygon } from "../regions";
import { layoutMText } from "../mtext/layout";
import { mapPoint, similarity } from "./affine";
import { boundsOfPoints, type Affine, type EntityKind, type KindSnap } from "./registry";

/**
 * D-04: the MTEXT kind. Geometry is the laid-out text box (like TEXT, whose
 * glyphs are not geometry either); writers with text support explode the
 * entity into TEXT runs (`mtext/explode.ts`). Grips: 0 = the insertion point,
 * 1 = the wrap-width handle on the box's right edge (only when `width > 0`).
 */
export const MTEXT_WIDTH_GRIP = 1;

export const mtextKind: EntityKind<MTextEntity> = {
  type: "mtext",
  tessellate: (e) => {
    const b = layoutMText(e).box;
    return [[...b, b[0]]];
  },
  bounds: (e) => boundsOfPoints(layoutMText(e).box),
  transform: (e, m: Affine) => {
    const s = similarity(m);
    if (!s || s.mirrored) return null;
    return { ...e, at: mapPoint(m, e.at), rotation: e.rotation + s.rotation, height: e.height * s.scale, width: e.width * s.scale };
  },
  path: () => null,
  snaps: (e): KindSnap[] => [{ point: e.at, kind: "endpoint" }],
  grips: (e) => {
    const out: Grip[] = [{ point: e.at, kind: "mid", index: 0 }];
    if (e.width > 0) {
      const b = layoutMText(e).box;
      out.push({ point: { x: (b[1].x + b[2].x) / 2, y: (b[1].y + b[2].y) / 2 }, kind: "vertex" as const, index: MTEXT_WIDTH_GRIP });
    }
    return out;
  },
  applyGrip: (e, g, to) => {
    if (g.index === 0) return { ...e, at: { x: to.x, y: to.y } };
    if (g.index !== MTEXT_WIDTH_GRIP) return e;
    // Distance of the dragged point along the text's x axis, measured from the box's left edge.
    const col = (Math.min(9, Math.max(1, Math.round(e.attachment || 1))) - 1) % 3;
    const along = (to.x - e.at.x) * Math.cos(e.rotation) + (to.y - e.at.y) * Math.sin(e.rotation);
    const w = col === 0 ? along : col === 1 ? Math.abs(along) * 2 : -along;
    return w > e.height * 0.1 ? { ...e, width: w } : e;
  },
  hitDistance: (e, p) => {
    const b = layoutMText(e).box;
    return pointInPolygon(p, b) ? 0 : Math.min(...b.map((q, i) => distToSegment(p, q, b[(i + 1) % 4])));
  },
};
