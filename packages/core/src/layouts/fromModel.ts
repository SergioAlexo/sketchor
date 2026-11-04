import type { Command } from "../commands";
import { boundsOf } from "../dxf";
import type { SketchDocument } from "../document";
import type { EntityId } from "../entities";
import { kindBounds } from "../kinds/registry";
import { LAYOUTS_TABLE, modelEntities, newLayout, paperSpec, printableRectMm, uniqueLayoutName, type PaperSpec } from "./types";
import { TITLE_BLOCK_H, planTitleBlockOn } from "./titleBlock";
import { newViewport, niceScaleBelow, parseScale, type Bounds4 } from "./viewport";

/**
 * L-08: "create a layout from the model" - the fast path for someone who today just prints the model. One
 * batch (one undo step) adds the layout, an optional border + title block, and a viewport framing the model
 * extents or the selection at a standard scale ("fit") or the scale the user names.
 */

export interface LayoutFromModelOptions {
  /** Layout name; default the next free "LayoutN". A taken name is replaced by the default. */
  name?: string;
  paper?: PaperSpec;
  /** Border + title block (default true). Dropped with a warning when the sheet is too small for it. */
  titleBlock?: boolean;
  /** "fit" (default) = the largest standard scale that fits, else a `paper:model` name or ratio such as "1:50" / 0.02. */
  scale?: "fit" | string | number;
  /** Frame these entities instead of the whole model. Unknown / paper-space ids are ignored; nothing left = whole model. */
  ids?: readonly EntityId[];
}

export interface LayoutFromModelPlan {
  layoutName: string;
  commands: Command[];
  /** Paper per model unit actually used. */
  scale: number;
  /** False when the requested scale is too big for the sheet: the window is cut off at the printable area. */
  fits: boolean;
  /** The model rectangle framed. */
  bounds: Bounds4;
  warnings: string[];
}

const INSET = 5;
const GAP = 3;

/** The model rectangle to frame: the selection's bounds when it has any, else every model-space entity; null for an empty drawing. */
export function modelFrameBounds(doc: SketchDocument, ids?: readonly EntityId[]): Bounds4 | null {
  const picked = (ids ?? []).map((id) => doc.get(id)).filter((e) => !!e && !(e as { space?: string }).space);
  const entities = picked.length > 0 ? picked : modelEntities(doc);
  const b = boundsOf(entities as never[]);
  let r: Bounds4 | null = b && [b.minX, b.minY, b.maxX, b.maxY].every(Number.isFinite) ? { minX: b.minX, minY: b.minY, maxX: b.maxX, maxY: b.maxY } : null;
  if (!r) {
    // Kinds `boundsOf` does not know (insert, mtext...): ask the registry.
    for (const e of entities) {
      const k = kindBounds(e as never);
      if (!k || ![k.minX, k.minY, k.maxX, k.maxY].every(Number.isFinite)) continue;
      r = r ? { minX: Math.min(r.minX, k.minX), minY: Math.min(r.minY, k.minY), maxX: Math.max(r.maxX, k.maxX), maxY: Math.max(r.maxY, k.maxY) } : { ...k };
    }
  }
  return r;
}

/**
 * Plans the new layout. Returns null when the drawing has nothing to frame or the sheet leaves no room for a window
 * (a printable area under 20 mm). A scale text that is not a scale falls back to "fit" with a warning.
 */
export function planLayoutFromModel(doc: SketchDocument, opts: LayoutFromModelOptions = {}): LayoutFromModelPlan | null {
  const bounds = modelFrameBounds(doc, opts.ids);
  if (!bounds) return null;
  const warnings: string[] = [];
  const name = opts.name && opts.name.trim() && !doc.hasRecord(LAYOUTS_TABLE, opts.name.trim()) ? opts.name.trim() : uniqueLayoutName(doc);
  if (opts.name && opts.name.trim() && name !== opts.name.trim()) warnings.push(`Layout "${opts.name.trim()}" exists; named it ${name}`);
  const layout = newLayout(name, opts.paper ?? paperSpec("A4", "landscape"));
  const printable = printableRectMm(layout);

  const commands: Command[] = [{ type: "add-layout", layout }];
  let framed = false;
  if (opts.titleBlock !== false) {
    const tb = planTitleBlockOn(doc, layout);
    if (tb) {
      commands.push(...tb);
      framed = true;
    } else {
      warnings.push("The sheet is too small for the title block; left it out");
    }
  }
  // With a title block the border sits INSET in; the window keeps GAP clear of it and above the block.
  const edge = framed ? INSET + GAP : INSET;
  const bottom = framed ? INSET + TITLE_BLOCK_H + GAP : INSET;
  const area = { x: printable.x + edge, y: printable.y + bottom, w: printable.w - 2 * edge, h: printable.h - edge - bottom };
  if (area.w < 20 || area.h < 20) return null;

  const mw = Math.max(bounds.maxX - bounds.minX, 1e-6);
  const mh = Math.max(bounds.maxY - bounds.minY, 1e-6);
  let scale: number;
  const asked = opts.scale ?? "fit";
  if (asked === "fit") {
    scale = niceScaleBelow(Math.min(area.w / mw, area.h / mh) * 0.95);
  } else {
    const v = typeof asked === "number" ? asked : parseScale(asked);
    if (v && v > 0 && Number.isFinite(v)) scale = v;
    else {
      warnings.push(`"${String(asked)}" is not a scale; used fit`);
      scale = niceScaleBelow(Math.min(area.w / mw, area.h / mh) * 0.95);
    }
  }
  const fits = mw * scale <= area.w + 1e-9 && mh * scale <= area.h + 1e-9;
  if (!fits) warnings.push("The model is larger than the sheet at this scale; the window is cut off");
  // The window hugs the model (plus a little air) when it is smaller than the area, and is centred in it.
  const w = Math.min(area.w, mw * scale * 1.1);
  const h = Math.min(area.h, mh * scale * 1.1);
  const rect = { x: area.x + (area.w - w) / 2, y: area.y + (area.h - h) / 2, w, h };
  const center = { x: (bounds.minX + bounds.maxX) / 2, y: (bounds.minY + bounds.maxY) / 2 };
  commands.push({ type: "add-entity", entity: newViewport(rect, { center, scale }, { space: name }) });
  return { layoutName: name, commands: [{ type: "batch", commands }], scale, fits, bounds, warnings };
}
