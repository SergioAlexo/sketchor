import type { FieldContext } from "../blocks/fields";
import type { SketchDocument } from "../document";
import type { Entity, InsertEntity, ViewportEntity } from "../entities";
import { paramEnv, PARAMS_TABLE } from "../expr";
import { LAYOUTS_TABLE, spaceOf } from "./types";
import { pointInViewport, scaleLabel, standardScaleName, viewportBounds } from "./viewport";

/**
 * L-04: what `{{layout}}`, `{{sheet}}`, `{{sheets}}`, `{{scale}}`, `{{param:NAME}}` and the sheet-set
 * attributes (`{{project}}`, `{{client}}`, `{{drawnby}}`, `{{title}}` ...) mean for an insert on a layout.
 * The block evaluator asks for this context per insert (kinds/insert.ts), so one title block definition
 * shows the right sheet number on every sheet.
 */

/** Settings key holding the sheet set's common attributes (`DocSettings.sheetSet`). */
export const SHEET_SET_KEY = "sheetSet";

/** The attributes a new sheet set offers (any other name may be added). */
export const SHEET_SET_DEFAULTS: readonly string[] = ["project", "client", "drawnby", "checkedby", "revision"];

export function sheetSetAttributes(doc: SketchDocument): Record<string, string> {
  const raw = doc.settings[SHEET_SET_KEY];
  const out: Record<string, string> = {};
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) if (typeof v === "string") out[k.toLowerCase()] = v;
  }
  return out;
}

/** The viewport whose window holds `at`, else the largest one on the layout. */
export function mainViewport(entities: Iterable<Entity>, layout: string, at?: { x: number; y: number }): ViewportEntity | null {
  let best: ViewportEntity | null = null;
  let bestArea = -1;
  for (const e of entities) {
    if (e.type !== "viewport" || e.space !== layout) continue;
    if (at && pointInViewport(e, at)) return e;
    const b = viewportBounds(e);
    const area = (b.maxX - b.minX) * (b.maxY - b.minY);
    if (area > bestArea) {
      bestArea = area;
      best = e;
    }
  }
  return best;
}

/** The field context for `insert` (null for a model-space insert, which keeps the app-wide context). */
const memo = new WeakMap<SketchDocument, { rev: number; byKey: Map<string, FieldContext> }>();

export function layoutFieldContext(doc: SketchDocument, insert: InsertEntity): FieldContext | null {
  const layout = spaceOf(insert);
  if (!layout) return null;
  // Hit tests and snapping ask many times per mouse move; the answer only changes with the document.
  let m = memo.get(doc);
  if (!m || m.rev !== doc.revision) memo.set(doc, (m = { rev: doc.revision, byKey: new Map() }));
  const key = `${layout}|${insert.insert.x}|${insert.insert.y}`;
  const cached = m.byKey.get(key);
  if (cached) return cached;
  const ctx = computeLayoutContext(doc, insert, layout);
  m.byKey.set(key, ctx);
  return ctx;
}

function computeLayoutContext(doc: SketchDocument, insert: InsertEntity, layout: string): FieldContext {
  const names = doc.records(LAYOUTS_TABLE).map((r) => r.name);
  const index = names.indexOf(layout);
  const vp = mainViewport(doc.all(), layout, insert.insert);
  const own = doc.getRecord(LAYOUTS_TABLE, layout)?.attributes;
  const custom: Record<string, string> = { ...sheetSetAttributes(doc) };
  if (own && typeof own === "object") for (const [k, v] of Object.entries(own as Record<string, unknown>)) if (typeof v === "string") custom[k.toLowerCase()] = v;
  // The sheet title defaults to the layout's name; the other well-known attributes default to blank rather than showing {{braces}}.
  for (const k of SHEET_SET_DEFAULTS) custom[k] ??= "";
  custom.title ??= layout;
  return {
    layout,
    sheet: index >= 0 ? index + 1 : 1,
    sheets: Math.max(1, names.length),
    ...(vp ? { scale: standardScaleName(vp.scale) ?? scaleLabel(vp.scale) } : {}),
    params: Object.fromEntries(paramEnv(doc.records(PARAMS_TABLE))),
    custom,
  };
}
