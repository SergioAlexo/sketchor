import type { Entity, EntityId } from "./entities";
import type { Point } from "./geometry";
import { closestParam, exactPathOf, intersectCurves, trimAt, type XCurve } from "./intersect";

/**
 * Trim by fence (T-16, AutoCAD quick-trim drag): the user drags a stroke
 * across the pieces to remove and every piece it crosses goes, each judged
 * against the *original* drawing as cutting edges (so trimming one line
 * never changes where its neighbours are cut).
 *
 * A fence crossing is a point; `trimAt` already removes the piece of one
 * entity between the cuts around a point, so the fence is that applied at
 * every crossing, in order along the stroke, to whichever piece of the
 * entity now holds the point. A crossing that falls in a piece already
 * removed, or on an entity nothing cuts, is skipped.
 */

export interface FenceTrim {
  /** Originals that were trimmed (to delete). */
  remove: EntityId[];
  /** Their replacements — placeholder ids `<original>#n`; the caller re-ids. Empty = pieces all trimmed away. */
  add: Entity[];
}

const seg = (a: Point, b: Point): XCurve => ({ kind: "segment", a, b });

/** Where the stroke crosses an entity, in stroke order. */
export function fenceCrossings(entity: Entity, fence: readonly Point[]): Point[] {
  const path = exactPathOf(entity);
  if (!path) return [];
  const out: Point[] = [];
  for (let i = 0; i + 1 < fence.length; i++) {
    const f = seg(fence[i], fence[i + 1]);
    if (fence[i].x === fence[i + 1].x && fence[i].y === fence[i + 1].y) continue;
    const here: { point: Point; t: number }[] = [];
    for (const c of path.curves) for (const h of intersectCurves(c, f)) here.push({ point: h.point, t: h.t2 });
    here.sort((a, b) => a.t - b.t);
    for (const h of here) out.push(h.point);
  }
  return out;
}

/** Distance from a point to the nearest curve of an entity's path. */
function distanceToEntity(e: Entity, p: Point): number {
  const path = exactPathOf(e);
  if (!path) return Infinity;
  let d = Infinity;
  for (const c of path.curves) d = Math.min(d, closestParam(c, p).distance);
  return d;
}

/**
 * Trims every entity the `fence` stroke crosses. `entities` is the whole
 * visible drawing (cutting edges and candidates alike). Null when the
 * stroke trimmed nothing.
 */
export function trimByFence(entities: readonly Entity[], fence: readonly Point[], tol = 1e-6): FenceTrim | null {
  if (fence.length < 2) return null;
  const remove: EntityId[] = [];
  const add: Entity[] = [];
  const all = [...entities];
  for (const target of entities) {
    const crossings = fenceCrossings(target, fence);
    if (crossings.length === 0) continue;
    const cutters = all.filter((e) => e.id !== target.id);
    let pieces: Entity[] = [target];
    let changed = false;
    let n = 0;
    for (const q of crossings) {
      let bi = -1;
      let bd = Infinity;
      pieces.forEach((p, i) => {
        const d = distanceToEntity(p, q);
        if (d < bd) {
          bd = d;
          bi = i;
        }
      });
      if (bi < 0 || bd > Math.max(tol, 1e-6)) continue;
      const piece = pieces[bi];
      const result = trimAt(piece, cutters, q);
      if (!result) continue;
      const fresh = result.pieces.map((p) => ({ ...p, id: `${target.id}#${n++}` }) as Entity);
      pieces = [...pieces.slice(0, bi), ...fresh, ...pieces.slice(bi + 1)];
      changed = true;
    }
    if (!changed) continue;
    remove.push(target.id);
    add.push(...pieces);
  }
  return remove.length > 0 ? { remove, add } : null;
}
