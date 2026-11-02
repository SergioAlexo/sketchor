import type { Command } from "../commands";
import type { SketchDocument } from "../document";
import type { EntityId } from "../entities";
import { LAYOUTS_TABLE, layoutEntities, spaceOf, withSpace, type LayoutRecord } from "./types";

/**
 * Layout commands (L-01) are macros: each expands to table / entity commands, so
 * one undo step reverts it and the inverse logic stays in the primitives (the
 * same shape as `blocks/ops.ts`). A plan returning `null` means "refused".
 */

export function planAddLayout(doc: SketchDocument, layout: LayoutRecord, index?: number): Command[] | null {
  if (!layout.name || doc.hasRecord(LAYOUTS_TABLE, layout.name)) return null;
  return [{ type: "put-table-record", table: LAYOUTS_TABLE, record: layout, ...(index !== undefined ? { index } : {}) }];
}

export function planRenameLayout(doc: SketchDocument, from: string, to: string): Command[] | null {
  if (!to || from === to || !doc.hasRecord(LAYOUTS_TABLE, from) || doc.hasRecord(LAYOUTS_TABLE, to)) return null;
  return [{ type: "rename-table-record", table: LAYOUTS_TABLE, from, to }];
}

/** Removes the layout and everything drawn on it. */
export function planDeleteLayout(doc: SketchDocument, name: string): Command[] | null {
  if (!doc.hasRecord(LAYOUTS_TABLE, name)) return null;
  const ids = layoutEntities(doc, name).map((e) => e.id);
  return [...(ids.length ? [{ type: "delete-entities", ids } as Command] : []), { type: "delete-table-record", table: LAYOUTS_TABLE, name }];
}

/** `names` is the new order; layouts it omits keep their relative order after it. */
export function planReorderLayouts(doc: SketchDocument, names: string[]): Command[] | null {
  const current = doc.records(LAYOUTS_TABLE);
  const seen = new Set<string>();
  const order: LayoutRecord[] = [];
  for (const n of names) {
    const r = doc.getRecord(LAYOUTS_TABLE, n);
    if (r && !seen.has(n)) {
      seen.add(n);
      order.push(r as LayoutRecord);
    }
  }
  for (const r of current) if (!seen.has(r.name)) order.push(r as LayoutRecord);
  if (order.every((r, i) => r.name === current[i]?.name)) return null;
  return [
    ...current.map((r) => ({ type: "delete-table-record", table: LAYOUTS_TABLE, name: r.name }) as Command),
    ...order.map((record) => ({ type: "put-table-record", table: LAYOUTS_TABLE, record }) as Command),
  ];
}

/** Moves entities between model space (`space: null`) and a layout. Their coordinates are not touched. */
export function planMoveToSpace(doc: SketchDocument, ids: EntityId[], space: string | null): Command[] | null {
  if (space !== null && !doc.hasRecord(LAYOUTS_TABLE, space)) return null;
  const out: Command[] = [];
  for (const id of ids) {
    const e = doc.get(id);
    if (!e || (spaceOf(e) ?? null) === space) continue;
    out.push({ type: "update-entity", entity: withSpace(e, space) });
  }
  return out.length ? out : null;
}
