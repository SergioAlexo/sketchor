import type { ViewportEntity } from "../entities";
import { distToSegment } from "../geometry";
import type { Grip } from "../grips";
import { viewportBounds, viewportOutline } from "../layouts/viewport";
import { mapPoint } from "./affine";
import { type Affine, type EntityKind, type KindSnap } from "./registry";

/**
 * L-03: the viewport's own geometry is just its window border (rectangle or
 * clip polygon); the model shown *through* it is drawn by the renderer and
 * exporters, never part of this entity. Grips: 0-3 = the rectangle's corners
 * (resize), 4 = centre (move). A clipped window offers only the move grip.
 */
export const VIEWPORT_CENTER_GRIP = 4;

export const viewportKind: EntityKind<ViewportEntity> = {
  type: "viewport",
  tessellate: (e) => {
    const o = viewportOutline(e);
    return [[...o, o[0]]];
  },
  bounds: (e) => {
    const b = viewportBounds(e);
    return { minX: b.minX, minY: b.minY, maxX: b.maxX, maxY: b.maxY };
  },
  // Axis-aligned map only: a viewport window cannot rotate on the sheet. Scale moves/sizes the window, not what it shows.
  transform: (e, m: Affine) => {
    if (Math.abs(m[1]) > 1e-9 || Math.abs(m[2]) > 1e-9) return null;
    const sx = Math.abs(m[0]);
    const sy = Math.abs(m[3]);
    if (sx < 1e-12 || sy < 1e-12) return null;
    return {
      ...e,
      center: mapPoint(m, e.center),
      width: e.width * sx,
      height: e.height * sy,
      ...(e.clip ? { clip: e.clip.map((p) => mapPoint(m, p)) } : {}),
    };
  },
  path: () => null,
  snaps: (e): KindSnap[] => viewportOutline(e).map((point) => ({ point, kind: "endpoint" as const })),
  grips: (e) => {
    const out: Grip[] = [{ point: { ...e.center }, kind: "mid", index: VIEWPORT_CENTER_GRIP }];
    if (!e.clip) {
      const o = viewportOutline(e);
      o.forEach((point, index) => out.push({ point, kind: "vertex", index }));
    }
    return out;
  },
  applyGrip: (e, g, to) => {
    if (g.index === VIEWPORT_CENTER_GRIP) {
      const dx = to.x - e.center.x;
      const dy = to.y - e.center.y;
      return { ...e, center: { x: to.x, y: to.y }, ...(e.clip ? { clip: e.clip.map((p) => ({ x: p.x + dx, y: p.y + dy })) } : {}) };
    }
    if (e.clip || g.index < 0 || g.index > 3) return e;
    // Dragging a corner moves it while the opposite corner stays fixed.
    const o = viewportOutline(e);
    const opposite = o[(g.index + 2) % 4];
    const w = Math.abs(to.x - opposite.x);
    const h = Math.abs(to.y - opposite.y);
    if (w < 1e-6 || h < 1e-6) return e;
    return { ...e, width: w, height: h, center: { x: (to.x + opposite.x) / 2, y: (to.y + opposite.y) / 2 } };
  },
  // The window is a region: clicking its border selects it, clicking inside is how the user enters MSPACE (handled by the viewport UI), so only the border counts.
  hitDistance: (e, p) => {
    const o = viewportOutline(e);
    let d = Infinity;
    for (let i = 0; i < o.length; i++) d = Math.min(d, distToSegment(p, o[i], o[(i + 1) % o.length]));
    return d;
  },
};
