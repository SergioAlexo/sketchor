import type { Command } from "../commands";
import type { DimensionEntity, Entity } from "../entities";
import type { TableRecord } from "../tables";
import { DIM_STYLE_PRESETS, dimStyleOf, dimStyleRecord, type DimFamily, type DimStyle } from "./style";

/**
 * Pure helpers behind the dimension style manager: every edit is a new table
 * record handed to `put-table-record` (one command, so one undo step restyles
 * every dimension that uses it).
 */

export type StyleScope = "parent" | DimFamily;

/** The record with `key` set to `value` for the whole style (`parent`) or for one family's child style. */
export function withStyleField(record: TableRecord, key: string, value: unknown, scope: StyleScope = "parent"): TableRecord {
  if (scope === "parent") return dimStyleRecord(dimStyleOf({ ...record, [key]: value }, undefined));
  const kids = { ...((record.children as DimStyle["children"]) ?? {}) };
  kids[scope] = { ...(kids[scope] ?? {}), [key]: value };
  return { ...dimStyleRecord(dimStyleOf(record)), children: kids };
}

/** The record with a child-style field removed (it falls back to the parent again). */
export function withoutChildField(record: TableRecord, key: string, scope: DimFamily): TableRecord {
  const kids = { ...((record.children as DimStyle["children"]) ?? {}) };
  const fam = { ...(kids[scope] ?? {}) };
  delete fam[key];
  if (Object.keys(fam).length) kids[scope] = fam;
  else delete kids[scope];
  const base = dimStyleRecord(dimStyleOf(record));
  delete base.children;
  if (Object.keys(kids).length) base.children = kids;
  return base;
}

/** "New from…": a copy of `source` under `name` (null when the name is empty or already taken). */
export function newStyleCommand(existing: readonly TableRecord[], source: TableRecord | undefined, name: string): Command | null {
  const n = name.trim();
  if (!n || existing.some((r) => r.name === n)) return null;
  const copy = dimStyleRecord(dimStyleOf(source));
  return { type: "put-table-record", table: "dimStyles", record: { ...copy, name: n } };
}

/** Commands that bring the built-in preset `name` into a drawing (nothing when it is missing or already there). */
export function presetCommand(existing: readonly TableRecord[], name: string): Command | null {
  const preset = DIM_STYLE_PRESETS.find((p) => p.name === name);
  if (!preset || existing.some((r) => r.name === name)) return null;
  return { type: "put-table-record", table: "dimStyles", record: dimStyleRecord(preset) };
}

/** How many dimensions use `name` (the unnamed ones use "Standard"). */
export function styleUsage(entities: Iterable<Entity>, name: string): number {
  let n = 0;
  for (const e of entities) if (e.type === "dimension" && ((e as DimensionEntity).style ?? "Standard") === name) n += 1;
  return n;
}
