import type { Bounds } from "../dxf";
import type { Entity, InsertEntity } from "../entities";
import type { Point } from "../geometry";
import { activeBlocks } from "../blocks/context";
import { applyParamGrip, dynamicSpecOf, paramGrips } from "../blocks/dynamic";
import { evaluateInsert, getBlock } from "../blocks/evaluate";
import { fieldRevision } from "../blocks/fields";
import type { BlocksHost } from "../blocks/types";
import { boundsOfPoints, kindBounds, kindHitDistance, kindSnaps, kindTessellate, type Affine, type EntityKind, type KindSnap } from "./registry";

/**
 * B-01: an `insert` is whatever its block definition evaluates to under the
 * insert's placement. Generic code asks this kind and gets the instance's
 * contents — so bounds, hit testing, window select and export see real
 * geometry, and snaps reach inside the instance (endpoints of the block's
 * lines are snappable, as in AutoCAD). The block table comes from the active
 * document (see blocks/context.ts).
 */

interface Evaluated {
  host: BlocksHost;
  rev: number;
  fields: number;
  entities: Entity[];
}
const evaluated = new WeakMap<InsertEntity, Evaluated>();

/** The instance's world-space entities under the active document; memoised per (insert object, tables revision). */
export function insertContents(e: InsertEntity): Entity[] {
  const host = activeBlocks();
  if (!host) return [];
  const hit = evaluated.get(e);
  if (hit && hit.host === host && hit.rev === host.tablesRevision && hit.fields === fieldRevision()) return hit.entities;
  const entities = evaluateInsert(host, e);
  evaluated.set(e, { host, rev: host.tablesRevision, fields: fieldRevision(), entities });
  return entities;
}

const CROSS = 1;

/** Marker for an instance with nothing to show (missing block, empty definition): a small cross, so it can still be seen, picked and deleted. */
function marker(e: InsertEntity): Point[][] {
  const { x, y } = e.insert;
  return [
    [{ x: x - CROSS, y }, { x: x + CROSS, y }],
    [{ x, y: y - CROSS }, { x, y: y + CROSS }],
  ];
}

/** Moves the placement under `m`; null when `m` shears (a block can't follow that) or would need to remap an array. */
function transformInsert(e: InsertEntity, m: Affine): InsertEntity | null {
  const [a, b, c, d] = m;
  // New linear part = m · (rotate · scale): columns are m applied to the old axes.
  const cos = Math.cos(e.rotation);
  const sin = Math.sin(e.rotation);
  const ux = { x: a * cos * e.scale.x + c * sin * e.scale.x, y: b * cos * e.scale.x + d * sin * e.scale.x };
  const vx = { x: -a * sin * e.scale.y + c * cos * e.scale.y, y: -b * sin * e.scale.y + d * cos * e.scale.y };
  const sx = Math.hypot(ux.x, ux.y);
  if (sx < 1e-12) return null;
  const det = ux.x * vx.y - ux.y * vx.x;
  const sy = det / sx;
  // Shear: the new y axis must be perpendicular to the new x axis.
  if (Math.abs(ux.x * vx.x + ux.y * vx.y) > 1e-9 * Math.max(sx * sx, Math.abs(sy) * sx)) return null;
  // x scale stays positive; a mirror shows up as a negative y scale.
  const rotation = Math.atan2(ux.y, ux.x);
  const uniformScale = Math.hypot(a, b);
  let array = e.array;
  if (array && (array.cols > 1 || array.rows > 1)) {
    // Array offsets are measured along the rotated axes, so they travel with the geometry under a
    // rotation + uniform scale; a mirror also turns the frame over, which flips the row direction.
    if (Math.abs(det) < 1e-12 || Math.abs(Math.hypot(a, b) - Math.hypot(c, d)) > 1e-9 * uniformScale) return null;
    const flip = a * d - b * c < 0 ? -1 : 1;
    array = { ...array, colSpacing: array.colSpacing * uniformScale, rowSpacing: array.rowSpacing * uniformScale * flip };
  }
  const to: Point = { x: m[0] * e.insert.x + m[2] * e.insert.y + m[4], y: m[1] * e.insert.x + m[3] * e.insert.y + m[5] };
  return { ...e, insert: to, rotation, scale: { x: sx, y: sy }, ...(array ? { array } : {}) };
}

/** The rotation handle: out along the instance's own x axis, clear of the contents. */
function rotateGripPoint(e: InsertEntity): Point {
  const b = insertKind.bounds?.(e) ?? null;
  const reach = b ? Math.max(b.maxX - b.minX, b.maxY - b.minY) * 0.6 : 0;
  const d = Math.max(reach, 2);
  return { x: e.insert.x + Math.cos(e.rotation) * d, y: e.insert.y + Math.sin(e.rotation) * d };
}

export const insertKind: EntityKind<InsertEntity> = {
  type: "insert",
  tessellate: (e, tol) => {
    const runs = insertContents(e).flatMap((c) => kindTessellate(c, tol));
    return runs.length > 0 ? runs : marker(e);
  },
  bounds: (e): Bounds | null => {
    // Union of the contents' exact bounds (a circle's bounds are its true extent, not its polygon's).
    let out: Bounds | null = null;
    for (const c of insertContents(e)) {
      const b = kindBounds(c);
      if (!b) continue;
      out = out ? { minX: Math.min(out.minX, b.minX), minY: Math.min(out.minY, b.minY), maxX: Math.max(out.maxX, b.maxX), maxY: Math.max(out.maxY, b.maxY) } : b;
    }
    return out ?? boundsOfPoints(marker(e).flat());
  },
  transform: transformInsert,
  snaps: (e): KindSnap[] => {
    const inner = insertContents(e).flatMap((c) => kindSnaps(c));
    return [{ point: e.insert, kind: "node" }, ...inner];
  },
  grips: (e) => {
    const base = [
      { point: e.insert, kind: "insert" as const, index: 0 },
      { point: rotateGripPoint(e), kind: "rotate" as const, index: 1 },
    ];
    // B-22: a dynamic block's parameters each show a handle.
    const host = activeBlocks();
    const def = host ? getBlock(host, e.block) : undefined;
    if (!def || !dynamicSpecOf(def)) return base;
    return [...base, ...paramGrips(def, e).map((p, i) => ({ point: p.point, kind: "param" as const, index: i }))];
  },
  applyGrip: (e, g, to) => {
    if (g.kind === "param") {
      const host = activeBlocks();
      const def = host ? getBlock(host, e.block) : undefined;
      return def ? applyParamGrip(def, e, g.index, to) : e;
    }
    if (g.kind === "rotate") {
      if (Math.hypot(to.x - e.insert.x, to.y - e.insert.y) < 1e-12) return e;
      return { ...e, rotation: Math.atan2(to.y - e.insert.y, to.x - e.insert.x) };
    }
    return { ...e, insert: { x: to.x, y: to.y } };
  },
  hitDistance: (e, p) => {
    const parts = insertContents(e);
    if (parts.length === 0) return Math.min(...marker(e).map(([a, b]) => distSeg(p, a, b)));
    let best = Infinity;
    for (const c of parts) best = Math.min(best, kindHitDistance(c, p));
    return best;
  },
};

function distSeg(p: Point, a: Point, b: Point): number {
  const abx = b.x - a.x;
  const aby = b.y - a.y;
  const l = abx * abx + aby * aby;
  const t = l === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * abx + (p.y - a.y) * aby) / l));
  return Math.hypot(p.x - (a.x + t * abx), p.y - (a.y + t * aby));
}
