import type { Entity, InsertEntity } from "../entities";
import { dynamicSpecOf, evaluateDynamic, isDefaultValues, paramValuesKey, resolveParamValues, type ParamValues } from "./dynamic";
import type { BlockDefinition } from "./types";

/**
 * B-25: how a dynamic block leaves Sketchor as DXF. AutoCAD keeps a base
 * definition plus an anonymous `*U<n>` block per distinct state; we do the
 * same without the EvalGraph objects: the base definition is written as a
 * normal block (its spec rides the SKETCHOR record), and every instance whose
 * values differ from the defaults points at a `*U<n>` block holding exactly
 * the geometry it shows — so any reader draws the right thing — while the
 * INSERT's XDATA names the dynamic block and the values for Sketchor to re-open
 * it live. Pure: the writer just asks which name an insert uses.
 */

export interface DynamicExport {
  /** The anonymous blocks to add to the BLOCKS section (definition coordinates, same units as the inputs). */
  blocks: BlockDefinition[];
  /** What `insert` should be written as, or null for an ordinary reference. */
  stateOf(insert: InsertEntity): { name: string; params: ParamValues } | null;
}

const keyOf = (block: string, values: ParamValues): string => `${block}\u0001${paramValuesKey(values)}`;

/** Finds every non-default instance of a dynamic block in `entities` and in the bodies of `defs` (and of the states it creates). */
export function planDynamicExport(defs: readonly BlockDefinition[], entities: readonly Entity[]): DynamicExport {
  const byName = new Map(defs.map((d) => [d.name, d] as const));
  const states = new Map<string, { name: string; params: ParamValues }>();
  const blocks: BlockDefinition[] = [];

  const stateFor = (e: InsertEntity): { name: string; params: ParamValues; fresh: boolean } | null => {
    const def = byName.get(e.block);
    const spec = dynamicSpecOf(def);
    if (!def || !spec) return null;
    const params = resolveParamValues(def, spec, e.params);
    if (isDefaultValues(def, spec, params)) return null;
    const key = keyOf(e.block, params);
    const hit = states.get(key);
    if (hit) return { ...hit, fresh: false };
    const name = `*U${states.size + 1}`;
    states.set(key, { name, params });
    return { name, params, fresh: true };
  };

  const queue: (readonly Entity[])[] = [entities, ...defs.map((d) => d.entities)];
  while (queue.length > 0) {
    const list = queue.shift()!;
    for (const e of list) {
      if (e.type !== "insert") continue;
      const s = stateFor(e);
      if (!s || !s.fresh) continue;
      const def = byName.get(e.block)!;
      const body = evaluateDynamic(def, s.params);
      const { dynamic: _d, constraints: _c, preview: _p, ...rest } = def;
      void _d; void _c; void _p;
      blocks.push({ ...rest, name: s.name, entities: [...body] });
      queue.push(body);
    }
  }
  return {
    blocks,
    stateOf: (e) => {
      const def = byName.get(e.block);
      const spec = dynamicSpecOf(def);
      if (!def || !spec) return null;
      const params = resolveParamValues(def, spec, e.params);
      return states.get(keyOf(e.block, params)) ?? null;
    },
  };
}
