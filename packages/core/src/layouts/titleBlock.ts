import type { BlockDefinition } from "../blocks/types";
import { makeInsert } from "../blocks/ops";
import type { Command } from "../commands";
import type { SketchDocument } from "../document";
import { newEntityId, type Entity } from "../entities";
import { SHEET_SET_KEY, sheetSetAttributes } from "./fields";
import { LAYOUTS_TABLE, getLayout, printableRectMm, type LayoutRecord } from "./types";

/**
 * L-04: a built-in title block and the sheet-set helpers around it. The block is an
 * ordinary `blocks` record (edit it in the block editor, replace it with a company one);
 * its attributes are fields, so `{{sheet}}` / `{{scale}}` / `{{project}}` are live per sheet.
 * Local coordinates run left and up from the base point (the lower-right corner of the block).
 */

export const TITLE_BLOCK_NAME = "TITLEBLOCK";
const W = 180;
const H = 40;

const line = (id: string, ax: number, ay: number, bx: number, by: number): Entity => ({ id, type: "line", a: { x: ax, y: ay }, b: { x: bx, y: by } });

export function titleBlockDefinition(): BlockDefinition {
  const entities: Entity[] = [
    { id: "frame", type: "polyline", points: [{ x: -W, y: 0 }, { x: 0, y: 0 }, { x: 0, y: H }, { x: -W, y: H }], closed: true },
    line("h1", -W, 20, 0, 20),
    line("v1", -60, 0, -60, 20),
    line("v2", -30, 0, -30, 20),
    line("v3", -90, 20, -90, H),
  ];
  const attr = (tag: string, prompt: string, x: number, y: number, fieldExpr: string, height = 3.5) => ({ tag, prompt, at: { x, y }, height, rotation: 0, fieldExpr });
  return {
    name: TITLE_BLOCK_NAME,
    basePoint: { x: 0, y: 0 },
    entities,
    attributeDefs: [
      attr("TITLE", "Sheet title", -W + 3, 27, "{{title}}", 6),
      attr("PROJECT", "Project", -87, 33, "{{project}}"),
      attr("CLIENT", "Client", -87, 23.5, "{{client}}"),
      attr("DRAWN", "Drawn by", -W + 3, 10, "{{drawnby}}"),
      attr("DATE", "Date", -57, 10, "{{date}}"),
      attr("SCALE", "Scale", -27, 14, "{{scale}}"),
      attr("SHEET", "Sheet", -27, 4, "{{sheet}} / {{sheets}}"),
      attr("FILE", "File", -W + 3, 3, "{{filename}}", 2.5),
    ],
    description: "Sheet title block (fields: title, project, client, drawnby, date, scale, sheet, filename)",
    explodable: true,
    scaleUniformly: true,
  };
}

/**
 * Commands that put a title block (and a border inset by `inset` mm) on a layout: the block record
 * when the drawing has none yet, the border polyline, and the insert at the printable area's lower-right corner.
 */
export function planTitleBlock(doc: SketchDocument, layoutName: string, opts: { block?: string; border?: boolean; inset?: number } = {}): Command[] | null {
  const layout = getLayout(doc, layoutName);
  if (!layout) return null;
  const block = opts.block ?? TITLE_BLOCK_NAME;
  const out: Command[] = [];
  if (!doc.hasRecord("blocks", block)) {
    if (block !== TITLE_BLOCK_NAME) return null;
    out.push({ type: "put-table-record", table: "blocks", record: titleBlockDefinition() });
  }
  const r = printableRectMm(layout);
  const inset = opts.inset ?? 5;
  const x0 = r.x + inset;
  const y0 = r.y + inset;
  const x1 = r.x + r.w - inset;
  const y1 = r.y + r.h - inset;
  if (x1 - x0 < W || y1 - y0 < H) return null;
  if (opts.border !== false) {
    out.push({
      type: "add-entity",
      entity: { id: newEntityId(), type: "polyline", space: layoutName, points: [{ x: x0, y: y0 }, { x: x1, y: y0 }, { x: x1, y: y1 }, { x: x0, y: y1 }], closed: true } as Entity,
    });
  }
  out.push({ type: "add-entity", entity: { ...makeInsert(newEntityId(), block, { x: x1, y: y0 }), space: layoutName } as Entity });
  return out;
}

/**
 * Edits the sheet set in one step: `common` replaces the shared attributes (blank values are dropped),
 * `perLayout` merges layout-specific values over them (a layout's own title, say). Names are case-insensitive.
 */
export function planSheetSet(doc: SketchDocument, common: Record<string, string>, perLayout: Record<string, Record<string, string>> = {}): Command[] {
  const out: Command[] = [];
  const next: Record<string, string> = {};
  for (const [k, v] of Object.entries(common)) if (v.trim() !== "" && k.trim() !== "") next[k.trim().toLowerCase()] = v;
  const before = sheetSetAttributes(doc);
  if (JSON.stringify(sortKeys(before)) !== JSON.stringify(sortKeys(next))) {
    out.push({ type: "set-settings", patch: { [SHEET_SET_KEY]: Object.keys(next).length ? next : (null as unknown as undefined) } });
  }
  for (const [name, attrs] of Object.entries(perLayout)) {
    const layout: LayoutRecord | undefined = getLayout(doc, name);
    if (!layout) continue;
    const clean: Record<string, string> = {};
    for (const [k, v] of Object.entries(attrs)) if (v.trim() !== "" && k.trim() !== "") clean[k.trim().toLowerCase()] = v;
    const had = (layout.attributes as Record<string, string> | undefined) ?? {};
    if (JSON.stringify(sortKeys(had)) === JSON.stringify(sortKeys(clean))) continue;
    const { attributes: _drop, ...rest } = layout;
    out.push({ type: "put-table-record", table: LAYOUTS_TABLE, record: Object.keys(clean).length ? { ...rest, attributes: clean } : rest });
  }
  return out;
}

function sortKeys(o: Record<string, string>): [string, string][] {
  return Object.entries(o).sort(([a], [b]) => a.localeCompare(b));
}
