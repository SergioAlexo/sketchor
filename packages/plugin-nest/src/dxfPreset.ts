import { translated, type Entity } from "@sketchor/core";
import { text } from "@sketchor/plugin-sdk";
import { NEST_LABELS_LAYER } from "./layout";
import { sheetOffsets, sheetOutlineEntities, type SheetPlacementEntities } from "./trueLayout";
import type { TrueNestSheet } from "./trueNest";

/**
 * Layer-name presets for the nest DXF export (RN-41). "cam" is the default:
 * the layout the shop's CAM expects, taken from the Sheet Nesting Calculator
 * by Oleksandr Borenko - outer contours on CUT_OUTER, holes on CUT_INNER, an
 * optional SHEET outline, no labels, origin at the sheet's lower-left, and the
 * original arcs/bulges (the entities are the materialized source geometry,
 * never a flattened polygon). "nest" is the earlier export that mirrors the
 * canvas layers, titles and part numbers.
 *
 * Why it matters: CAM software picks cut order and tool compensation from the
 * layer name, so a mislabelled hole is a part cut at the wrong offset.
 */

export type DxfPreset = "cam" | "nest";
export const CAM_OUTER_LAYER = "CUT_OUTER";
export const CAM_INNER_LAYER = "CUT_INNER";
export const CAM_SHEET_LAYER = "SHEET";

export interface DxfPresetOptions {
  preset?: DxfPreset;
  /** CAM preset: draw the sheet rectangle on the SHEET layer. Default false. */
  includeSheetOutline?: boolean;
}

/**
 * Entities of ONE sheet in sheet-local coordinates (lower-left = origin).
 * `placements` may contain other sheets' entries; they are filtered here.
 */
export function sheetDxfEntities(
  sheet: TrueNestSheet,
  sheetIndex: number,
  sheetLabel: string,
  placements: SheetPlacementEntities[],
  opts: DxfPresetOptions = {},
): Entity[] {
  const preset = opts.preset ?? "cam";
  const mine = placements.filter((p) => p.sheet === sheetIndex);
  const out: Entity[] = [];
  const { outline, title } = sheetOutlineEntities(sheet, sheetLabel);
  if (preset === "nest") {
    out.push(outline, title);
    for (const p of mine) out.push(...p.outerEntities, ...p.holeEntities, text(p.label.at, String(p.number), { layer: NEST_LABELS_LAYER, height: p.label.height }));
    return out;
  }
  if (opts.includeSheetOutline) out.push({ ...outline, layer: CAM_SHEET_LAYER });
  for (const p of mine) {
    out.push(...p.outerEntities.map((e) => ({ ...e, layer: CAM_OUTER_LAYER })), ...p.holeEntities.map((e) => ({ ...e, layer: CAM_INNER_LAYER })));
  }
  return out;
}

/** The "nest" preset's single stacked file: every sheet shifted exactly like the canvas. */
export function stackedSheetsDxfEntities(sheets: TrueNestSheet[], sheetLabels: string[], placements: SheetPlacementEntities[]): Entity[] {
  const offsets = sheetOffsets(sheets);
  return sheets.flatMap((sheet, i) => sheetDxfEntities(sheet, i, sheetLabels[i], placements, { preset: "nest" }).map((e) => translated(e, 0, offsets[i])));
}

/** `nest-sheet-03.dxf` - zero-padded so a ZIP lists in sheet order. */
export function sheetDxfFileName(sheetIndex: number): string {
  return `nest-sheet-${String(sheetIndex + 1).padStart(2, "0")}.dxf`;
}
