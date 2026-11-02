import type { Entity, EntityId, InsertEntity, PolylineEntity } from "../entities";
import type { Point } from "../geometry";
import { kindTessellate, kindTransform, type Affine } from "../kinds/registry";
import { dynamicSpecOf, insertBody, paramValuesKey, resolveParamValues } from "./dynamic";
import { expandFields, fieldRevision } from "./fields";
import { MAX_BLOCK_DEPTH, type AttributeDef, type BlockDefinition, type BlocksHost } from "./types";

/**
 * Block evaluation (B-01): an `insert` is drawn by running its definition's
 * entities through translate(insert) · rotate · scale · translate(-basePoint).
 * Pure functions of a document's `blocks` table — nothing here mutates.
 */

/** The definition a name refers to, or undefined. */
export function getBlock(host: BlocksHost, name: string): BlockDefinition | undefined {
  return host.getRecord("blocks", name) as BlockDefinition | undefined;
}

/** The affine map one placement of `insert` applies to definition coordinates (array offset `ox`,`oy` along the insert's rotated axes). */
export function insertMatrix(insert: Pick<InsertEntity, "insert" | "scale" | "rotation">, basePoint: Point, ox = 0, oy = 0): Affine {
  const cos = Math.cos(insert.rotation);
  const sin = Math.sin(insert.rotation);
  const a = cos * insert.scale.x;
  const b = sin * insert.scale.x;
  const c = -sin * insert.scale.y;
  const d = cos * insert.scale.y;
  const tx = insert.insert.x + ox * cos - oy * sin;
  const ty = insert.insert.y + ox * sin + oy * cos;
  return [a, b, c, d, tx - (a * basePoint.x + c * basePoint.y), ty - (b * basePoint.x + d * basePoint.y)];
}

export const mapPoint = (m: Affine, p: Point): Point => ({ x: m[0] * p.x + m[2] * p.y + m[4], y: m[1] * p.x + m[3] * p.y + m[5] });

/** The entity under `m`, whatever that takes: a circle/arc under uneven scale becomes an ellipse, anything else unrepresentable falls back to its outline. */
export function applyAffine(e: Entity, m: Affine): Entity {
  const t = kindTransform(e, m);
  if (t) {
    // A placed copy's dimension keeps its def points: ids it referenced inside the definition mean nothing out here.
    if (t.type === "dimension") {
      const { refs: _r, target: _t, targets: _ts, ...rest } = t;
      return rest;
    }
    return t;
  }
  if (e.type === "circle" || e.type === "arc") {
    const full = e.type === "circle";
    const ccw = full ? true : e.ccw;
    let start = full ? 0 : ccw ? e.startAngle : e.endAngle;
    let end = full ? Math.PI * 2 : ccw ? e.endAngle : e.startAngle;
    if (!full) {
      end = start + (((end - start) % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2);
      if (end - start < 1e-12) end = start + Math.PI * 2;
    }
    const { id, name, layer, color, linetype, lineweight, construction } = e;
    const ell: Entity = {
      id,
      type: "ellipse",
      ...(name !== undefined ? { name } : {}),
      ...(layer !== undefined ? { layer } : {}),
      ...(color !== undefined ? { color } : {}),
      ...(linetype !== undefined ? { linetype } : {}),
      ...(lineweight !== undefined ? { lineweight } : {}),
      ...(construction !== undefined ? { construction } : {}),
      center: e.center,
      majorAxis: { x: e.radius, y: 0 },
      ratio: 1,
      start,
      end,
    };
    const out = kindTransform(ell, m);
    if (out) return out;
  }
  if (e.type === "text" || e.type === "image") {
    const rot = Math.atan2(m[1], m[0]);
    const k = Math.hypot(m[2], m[3]);
    if (e.type === "text") return { ...e, at: mapPoint(m, e.at), rotation: e.rotation + rot, height: e.height * k };
    return { ...e, insert: mapPoint(m, e.insert), rotation: e.rotation + rot, width: e.width * Math.hypot(m[0], m[1]), height: e.height * k };
  }
  // Last resort: the outline as polylines (hatch fills and the like are lost).
  const runs = kindTessellate(e, 0.01).filter((r) => r.length >= 2);
  if (runs.length === 0) return e;
  const run = runs[0];
  const closed = runs.length === 1 && run.length > 2 && Math.hypot(run[0].x - run[run.length - 1].x, run[0].y - run[run.length - 1].y) < 1e-9;
  const pts = (closed ? run.slice(0, -1) : run).map((p) => mapPoint(m, p));
  const poly: PolylineEntity = {
    id: e.id,
    type: "polyline",
    ...(e.layer !== undefined ? { layer: e.layer } : {}),
    ...(e.color !== undefined ? { color: e.color } : {}),
    ...(e.linetype !== undefined ? { linetype: e.linetype } : {}),
    points: pts,
    closed,
  };
  return poly;
}

/** Layer "0" / BYBLOCK properties of a definition entity take the insert's values. */
function inherit(e: Entity, insert: InsertEntity): Entity {
  let out = e;
  if ((e.layer === undefined || e.layer === "0") && insert.layer !== undefined && insert.layer !== "0") out = { ...out, layer: insert.layer };
  if (e.color === "BYBLOCK") {
    const { color: _c, ...rest } = out as Entity & { color?: string };
    out = (insert.color !== undefined ? { ...rest, color: insert.color } : rest) as Entity;
  }
  if (e.linetype === "BYBLOCK") {
    const { linetype: _l, ...rest } = out as Entity & { linetype?: string };
    out = (insert.linetype !== undefined ? { ...rest, linetype: insert.linetype } : rest) as Entity;
  }
  return out;
}

interface BodyCache {
  rev: number;
  fields: number;
  /** name → definition body with nested inserts expanded, in definition (local) coordinates. */
  bodies: Map<string, Entity[]>;
}
const caches = new WeakMap<BlocksHost, BodyCache>();

function bodyCache(host: BlocksHost): BodyCache {
  let c = caches.get(host);
  if (!c || c.rev !== host.tablesRevision || c.fields !== fieldRevision()) {
    c = { rev: host.tablesRevision, fields: fieldRevision(), bodies: new Map() };
    caches.set(host, c);
  }
  return c;
}

/**
 * Names `entities` (a candidate body for `name`) would make `name` reach
 * through nested inserts — true when `name` ends up inside itself, or the
 * nesting is deeper than {@link MAX_BLOCK_DEPTH}.
 */
export function blockWouldCycle(host: BlocksHost, name: string, entities: readonly Entity[]): boolean {
  const walk = (list: readonly Entity[], stack: string[]): boolean => {
    for (const e of list) {
      if (e.type !== "insert") continue;
      if (e.block === name || stack.includes(e.block)) return true;
      if (stack.length + 1 >= MAX_BLOCK_DEPTH) return true;
      const def = getBlock(host, e.block);
      if (def && walk(def.entities, [...stack, e.block])) return true;
    }
    return false;
  };
  return walk(entities, []);
}

/** Every block (transitively) referenced from `entities`. */
export function referencedBlocks(host: BlocksHost, entities: readonly Entity[]): Set<string> {
  const seen = new Set<string>();
  const walk = (list: readonly Entity[]): void => {
    for (const e of list) {
      if (e.type !== "insert" || seen.has(e.block)) continue;
      seen.add(e.block);
      const def = getBlock(host, e.block);
      if (def) walk(def.entities);
    }
  };
  walk(entities);
  return seen;
}

function placements(insert: InsertEntity, base: Point): { key: string; m: Affine }[] {
  const arr = insert.array;
  const cols = Math.max(1, Math.round(arr?.cols ?? 1));
  const rows = Math.max(1, Math.round(arr?.rows ?? 1));
  const out: { key: string; m: Affine }[] = [];
  for (let c = 0; c < cols; c++) {
    for (let r = 0; r < rows; r++) {
      out.push({ key: cols * rows > 1 ? `${c}.${r}` : "0", m: insertMatrix(insert, base, c * (arr?.colSpacing ?? 0), r * (arr?.rowSpacing ?? 0)) });
    }
  }
  return out;
}

function expandBody(host: BlocksHost, name: string, stack: readonly string[], insert?: Pick<InsertEntity, "params">): Entity[] {
  const def = getBlock(host, name);
  if (!def || stack.includes(name) || stack.length >= MAX_BLOCK_DEPTH) return [];
  const cache = bodyCache(host);
  // A dynamic block's body depends on the instance's values (B-20): memoise per value set.
  const spec = dynamicSpecOf(def);
  const cacheKey = spec ? `${name}|${paramValuesKey(resolveParamValues(def, spec, insert?.params))}` : name;
  // Only a top-level expansion is memoised: a body expanded mid-cycle was cut short and must not be reused.
  if (stack.length === 0) {
    const hit = cache.bodies.get(cacheKey);
    if (hit) return hit;
  }
  const out: Entity[] = [];
  for (const e of insertBody(def, insert ?? {})) {
    if (e.type === "insert") out.push(...evaluateWith(host, e, [...stack, name]));
    else out.push(e);
  }
  if (stack.length === 0) cache.bodies.set(cacheKey, out);
  return out;
}

function evaluateWith(host: BlocksHost, insert: InsertEntity, stack: readonly string[]): Entity[] {
  const def = getBlock(host, insert.block);
  if (!def) return [];
  const body = expandBody(host, insert.block, stack, insert);
  const out: Entity[] = [];
  for (const { key, m } of placements(insert, def.basePoint)) {
    for (const e of body) {
      const placed = applyAffine(inherit(e, insert), m);
      out.push({ ...placed, id: `${insert.id}:${key}:${e.id}` });
    }
  }
  // Visible attribute values are part of what the instance shows (B-05).
  let n = 0;
  out.push(...attributeTexts(host, insert, () => `${insert.id}:attr:${n++}`));
  return out;
}

/**
 * The entities one insert stands for, in world coordinates, with stable ids
 * (`<insertId>:<array cell>:<definition entity id>`). A missing or cyclic
 * block evaluates to nothing; nesting stops at {@link MAX_BLOCK_DEPTH}.
 */
export function evaluateInsert(host: BlocksHost, insert: InsertEntity): Entity[] {
  return evaluateWith(host, insert, []);
}

/** What an attribute shows: the instance's value (constant attributes always use the default), else the field expression, else the default; fields expanded. */
export function attributeValue(a: AttributeDef, insert: Pick<InsertEntity, "attributes">): string {
  const raw = a.flags?.constant ? (a.default ?? "") : (insert.attributes[a.tag] ?? a.fieldExpr ?? a.default ?? "");
  return expandFields(raw);
}

/** The world position of an attribute definition's text for the first array cell (or each cell). */
export function attributeTexts(host: BlocksHost, insert: InsertEntity, newId: () => EntityId): Entity[] {
  const def = getBlock(host, insert.block);
  if (!def) return [];
  const out: Entity[] = [];
  for (const { m } of placements(insert, def.basePoint)) {
    for (const a of def.attributeDefs as AttributeDef[]) {
      if (a.flags?.invisible) continue;
      const text = attributeValue(a, insert);
      if (text === "") continue;
      const rot = Math.atan2(m[1], m[0]);
      out.push({
        id: newId(),
        type: "text",
        ...(insert.layer !== undefined ? { layer: insert.layer } : {}),
        at: mapPoint(m, a.at),
        text,
        height: a.height * Math.hypot(m[2], m[3]),
        rotation: a.rotation + rot,
      });
    }
  }
  return out;
}
/** `entities` with every insert replaced by what it evaluates to (nested ones included) — what exporters that don't write blocks (yet: B-08) draw. */
export function flattenInserts(host: BlocksHost, entities: readonly Entity[]): Entity[] {
  const out: Entity[] = [];
  for (const e of entities) {
    if (e.type === "insert") out.push(...evaluateInsert(host, e));
    else out.push(e);
  }
  return out;
}
