import type { Entity } from "./entities";

/**
 * Document tables (Z-02): the named, reusable things a drawing carries besides
 * its entities — layers, block definitions, dimension/text styles, linetypes,
 * custom hatch patterns, paper-space layouts, named parameters. AutoCAD's
 * model: an entity *refers* to a record by name (`layer: "WALLS"`), and the
 * record is the one place its properties live.
 *
 * Records are plain JSON (`name` plus whatever the owning feature defines), so
 * they serialise, diff and undo like everything else; later items (B-01 blocks,
 * D-03 dim styles, H-06 patterns, L-01 layouts, T-45 parameters) narrow the
 * shape of their own table. Tables change only through the
 * `put-table-record` / `delete-table-record` / `rename-table-record` commands.
 */

export type TableName =
  | "layers"
  | "blocks"
  | "dimStyles"
  | "textStyles"
  | "linetypes"
  | "hatchPatterns"
  | "layouts"
  | "params"
  | "foreign";

export const TABLE_NAMES: readonly TableName[] = [
  "layers",
  "blocks",
  "dimStyles",
  "textStyles",
  "linetypes",
  "hatchPatterns",
  "layouts",
  "params",
  "foreign",
];

/** One row of a table. `name` is its key — unique within the table, case-sensitive. */
export interface TableRecord {
  name: string;
  [field: string]: unknown;
}

/** A layer's persisted state: what the layer panel toggles, plus its defaults for an entity that doesn't set its own (Z-04). Layer colour (X-04) isn't modeled yet. */
export interface LayerRecord extends TableRecord {
  visible: boolean;
  /** Visible but untouchable — cannot be picked or edited. */
  locked?: boolean;
  /** This layer's default linetype — what an entity with no `linetype` of its own (BYLAYER) draws as. Absent = CONTINUOUS. */
  linetype?: string;
  /** This layer's default lineweight (mm) — what an entity with no `lineweight` of its own (BYLAYER) draws as. */
  lineweight?: number;
}

/**
 * Document-wide settings (the DXF header variables and "current" pointers that
 * belong to the drawing rather than to the app). Every field is optional;
 * absent means "the default". Changed through the `set-settings` command.
 */
export interface DocSettings {
  /** `$INSUNITS` code the file declares (1 in, 4 mm, …); 0/absent = unstated. */
  insUnits?: number;
  currentDimStyle?: string;
  currentTextStyle?: string;
  /** `$LTSCALE`. */
  ltscale?: number;
  /** Current annotation scale, e.g. `"1:50"` (D-08). */
  annotationScale?: string;
  /** The drawing's annotation scale list (D-08); absent = the built-in list. */
  annotationScales?: string[];
  /** AutoCAD ANNOALLVISIBLE: show annotative objects that do not support the view's scale. Absent = shown in model space, hidden in viewports. */
  annoAllVisible?: boolean;
  [key: string]: unknown;
}

/* ------------------------- references between records ------------------------ */

/**
 * Renaming a record must rewrite everything that points at it, in the same
 * undo step. Which entity field points at which table is knowledge that lives
 * with the feature that adds the field, so each registers a rewriter here;
 * `rename-table-record` runs every rewriter registered for the table.
 *
 * A rewriter returns the updated entity, or `null` when the entity does not
 * reference `from`.
 */
export type EntityRefRewriter = (entity: Entity, from: string, to: string) => Entity | null;
/** Same for one table's records pointing at another's (a layer's linetype, a dim style's text style). */
export type RecordRefRewriter = (record: TableRecord, from: string, to: string) => TableRecord | null;

const entityRewriters = new Map<string, EntityRefRewriter[]>();
const recordRewriters = new Map<string, { owner: string; fn: RecordRefRewriter }[]>();

/** Registers how entities reference records of `table`. */
export function registerEntityRefRewriter(table: string, fn: EntityRefRewriter): void {
  const list = entityRewriters.get(table) ?? [];
  list.push(fn);
  entityRewriters.set(table, list);
}

/** Registers how records of table `owner` reference records of `table`. */
export function registerRecordRefRewriter(table: string, owner: string, fn: RecordRefRewriter): void {
  const list = recordRewriters.get(table) ?? [];
  list.push({ owner, fn });
  recordRewriters.set(table, list);
}

export function entityRefRewritersFor(table: string): readonly EntityRefRewriter[] {
  return entityRewriters.get(table) ?? [];
}

export function recordRefRewritersFor(table: string): readonly { owner: string; fn: RecordRefRewriter }[] {
  return recordRewriters.get(table) ?? [];
}

// An entity's `layer` names a `layers` record (absent = the default layer "0").
registerEntityRefRewriter("layers", (entity, from, to) => (entity.layer === from ? { ...entity, layer: to } : null));

// Z-04: an entity's `linetype` names a `linetypes` record only when it's a
// custom (imported) one — a built-in name (CONTINUOUS, DASHED, ...) can't be
// renamed, so there's never a `linetypes` record for `from` to match in that
// case and this rewriter is a no-op for it.
registerEntityRefRewriter("linetypes", (entity, from, to) =>
  entity.linetype === from ? { ...entity, linetype: to } : null,
);
// A layer's own default `linetype` is the same kind of reference, one level up.
registerRecordRefRewriter("linetypes", "layers", (record, from, to) =>
  (record as LayerRecord).linetype === from ? { ...record, linetype: to } : null,
);

/* --------------------------------- migration -------------------------------- */

/** The current document format. */
export const DOCUMENT_VERSION = 3;

/**
 * What `SketchDocument.toJSON()` writes and `fromJSON` reads. v1 had only
 * `entities`; v2 added `groups` and `constraints`; v3 adds `tables` and
 * `settings`. Older files are read as-is with empty tables — nothing about
 * their entities changes.
 */
export interface DocumentJson {
  version?: number;
  entities: Entity[];
  groups?: import("./groups").Group[];
  constraints?: import("./constraints").Constraint[];
  tables?: Record<string, TableRecord[]>;
  settings?: DocSettings;
}

/** Keeps only well-formed records: an object with a non-empty string `name`, first one wins per name. */
export function sanitizeRecords(raw: unknown): TableRecord[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: TableRecord[] = [];
  for (const r of raw) {
    if (!r || typeof r !== "object" || Array.isArray(r)) continue;
    const name = (r as { name?: unknown }).name;
    if (typeof name !== "string" || name === "" || seen.has(name)) continue;
    seen.add(name);
    out.push(r as TableRecord);
  }
  return out;
}
