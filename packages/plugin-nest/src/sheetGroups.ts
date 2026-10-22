import { translated, type Entity } from "@sketchor/core";
import { add, line, text, type Command } from "@sketchor/plugin-sdk";
import { NEST_HOLES_LAYER, NEST_LABELS_LAYER, NEST_PARTS_LAYER, NEST_SHEET_LAYER, newGroupId } from "./layout";
import { clampStripRect } from "./sheetNesting";
import { sheetOutlineEntities, type SheetPlacementEntities } from "./trueLayout";
import type { TrueNestPlacement, TrueNestSheet } from "./trueNest";

/**
 * Identical-sheet grouping and the side-by-side canvas result (RN-40 = NF-07).
 * The signature mirrors `sigOf`/`groupSheets` of the Sheet Nesting Calculator
 * by Oleksandr Borenko: sheet size plus the sorted placements, positions
 * rounded to 1e-3. Twenty identical sheets are drawn once with "x20", which
 * is also how the shop cuts them.
 *
 * Why it matters: a false match hides a differing sheet (a part cut wrong);
 * a missed match floods the canvas. The tests pin both sides of the rounding.
 */

/** The placement fields the signature reads. `TrueNestPlacement` satisfies it. */
export type SignaturePlacement = Pick<TrueNestPlacement, "partId" | "sheet" | "rotationDeg" | "translation"> & { mirrored?: boolean };

export interface SheetGroup {
  /** The first sheet of the group - the one that gets drawn. */
  sheet: TrueNestSheet;
  /** 0-based indices of every sheet with this signature, ascending. */
  indices: number[];
  signature: string;
}

const r3 = (v: number): string => String(Math.round(v * 1000) / 1000 + 0);

export function sheetSignature(sheet: Pick<TrueNestSheet, "width" | "height">, placements: SignaturePlacement[]): string {
  return (
    `${r3(sheet.width)}x${r3(sheet.height)}#` +
    placements
      .map((p) => `${p.partId}|${r3(p.rotationDeg)}|${p.mirrored ? 1 : 0}|${r3(p.translation.x)}|${r3(p.translation.y)}`)
      .sort()
      .join(";")
  );
}

/** Groups sheets with identical size and placements, in first-occurrence order. */
export function groupIdenticalSheets(sheets: TrueNestSheet[], placements: SignaturePlacement[]): SheetGroup[] {
  const bySheet: SignaturePlacement[][] = sheets.map(() => []);
  for (const p of placements) bySheet[p.sheet]?.push(p);
  const map = new Map<string, SheetGroup>();
  const list: SheetGroup[] = [];
  sheets.forEach((sheet, i) => {
    const signature = sheetSignature(sheet, bySheet[i]);
    let g = map.get(signature);
    if (!g) {
      g = { sheet, indices: [], signature };
      map.set(signature, g);
      list.push(g);
    }
    g.indices.push(i);
  });
  return list;
}

/** "Sheet 2" / "Sheets 3-7 x5" / "Sheets 1+3+4 x3" - 1-based, ranges collapsed. */
export function describeGroup(indices: number[]): string {
  if (indices.length === 0) return "";
  const n = indices.map((i) => i + 1);
  if (n.length === 1) return `Sheet ${n[0]}`;
  const contiguous = n[n.length - 1] - n[0] === n.length - 1;
  return `Sheets ${contiguous ? `${n[0]}–${n[n.length - 1]}` : n.join("+")} ×${n.length}`;
}

/**
 * RN-22: the clamp strip drawn hatched on a sheet (sheet-local mm): the strip's
 * outline plus 45-degree hatch lines clipped to it, on the sheet layer. The
 * strip is where the engines keep parts out, so the picture shows why that
 * edge is empty. Line count is capped so a huge sheet cannot flood the canvas.
 */
export function clampHatchEntities(sheet: { width: number; height: number }, clamp: number): Entity[] {
  const r = clampStripRect(sheet, clamp);
  if (!r) return [];
  const step = Math.max(15, (r.w + r.h) / 300);
  const out: Entity[] = [];
  const o = { layer: NEST_SHEET_LAYER };
  const x1 = r.x + r.w;
  const y1 = r.y + r.h;
  out.push(line({ x: r.x, y: r.y }, { x: x1, y: r.y }, o), line({ x: x1, y: r.y }, { x: x1, y: y1 }, o), line({ x: x1, y: y1 }, { x: r.x, y: y1 }, o), line({ x: r.x, y: y1 }, { x: r.x, y: r.y }, o));
  // hatch lines x - y = c, clipped to the rectangle
  for (let c = r.x - y1; c <= x1 - r.y; c += step) {
    const xa = Math.max(r.x, c + r.y);
    const xb = Math.min(x1, c + y1);
    if (xb - xa < 1e-6) continue;
    out.push(line({ x: xa, y: xa - c }, { x: xb, y: xb - c }, o));
  }
  return out;
}

/** Gap between side-by-side sheets, mm. */
const SIDE_GAP = 200;

/**
 * Draws the result for a NEW tab: one titled outline per sheet *group*, left
 * to right, on the existing four layers (sheet / parts / holes / labels).
 * `placements` are the sheet-local entities of every sheet; only each
 * group's first sheet is drawn. Each drawn sheet is one entity group.
 */
export function buildSideBySideLayout(
  sheets: TrueNestSheet[],
  placements: SheetPlacementEntities[],
  groups: SheetGroup[],
  sheetLabel: (sheet: TrueNestSheet, index: number) => string,
  opts: { clamp?: number } = {},
): Command[] {
  const commands: Command[] = [];
  let x = 0;
  for (const g of groups) {
    const first = g.indices[0];
    const sheet = sheets[first];
    const label = g.indices.length > 1 ? `${sheetLabel(sheet, first)} – ${describeGroup(g.indices)}` : sheetLabel(sheet, first);
    const ids: string[] = [];
    const push = (e: ReturnType<typeof translated>): void => {
      commands.push(add(e));
      ids.push(e.id);
    };
    const { outline, title } = sheetOutlineEntities(sheet, label);
    push(translated(outline, x, 0));
    push(translated(title, x, 0));
    for (const e of clampHatchEntities(sheet, opts.clamp ?? 0)) push(translated(e, x, 0));
    for (const p of placements.filter((p) => p.sheet === first)) {
      for (const e of p.outerEntities) push({ ...translated(e, x, 0), layer: NEST_PARTS_LAYER });
      for (const e of p.holeEntities) push({ ...translated(e, x, 0), layer: NEST_HOLES_LAYER });
      push(text({ x: p.label.at.x + x, y: p.label.at.y }, String(p.number), { layer: NEST_LABELS_LAYER, height: p.label.height }));
    }
    commands.push({ type: "group-entities", groupId: newGroupId(), ids, name: label });
    x += sheet.width + SIDE_GAP;
  }
  return commands;
}
