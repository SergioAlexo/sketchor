import type { Entity } from "../entities";
import type { SketchDocument } from "../document";
import { registerEntityRefRewriter, type TableRecord } from "../tables";

/**
 * Paper space (plan L-01). A drawing has one implicit model space and any number
 * of named layouts (sheets) stored in the `layouts` table. An entity belongs to a
 * layout when its `space` field names one; absent = model space. (The plan
 * sketches a per-layout id list; the back-pointer is the same information with no
 * second copy to keep in step, and `layoutEntities` derives the list.)
 */

export const LAYOUTS_TABLE = "layouts";

export type PaperUnits = "mm" | "in";
export type PlotStyle = "as displayed" | "monochrome" | "grayscale";

export interface PaperSpec {
  /** A key of `PAPER_SIZES` or `"Custom"`. */
  size: string;
  /** Width/height of the sheet as printed, in `units`, orientation already applied. */
  w: number;
  h: number;
  units: PaperUnits;
  orientation: "landscape" | "portrait";
}

export interface LayoutMargins {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export interface PlotSettings {
  scaleLineweights: boolean;
  plotStyle: PlotStyle;
  center: boolean;
  plotArea: "layout" | "extents";
}

export interface LayoutRecord extends TableRecord {
  paper: PaperSpec;
  /** Unprintable border, in paper units. */
  margins: LayoutMargins;
  plotSettings: PlotSettings;
  /** Per-layout values for title-block fields (L-04), e.g. `sheet`. */
  attributes?: Record<string, string>;
}

/** Portrait sizes in mm (short side first). */
export const PAPER_SIZES: Readonly<Record<string, readonly [number, number]>> = {
  A5: [148, 210],
  A4: [210, 297],
  A3: [297, 420],
  A2: [420, 594],
  A1: [594, 841],
  A0: [841, 1189],
  Letter: [215.9, 279.4],
  Legal: [215.9, 355.6],
  "ANSI B": [279.4, 431.8],
  "ANSI C": [431.8, 558.8],
  "ANSI D": [558.8, 863.6],
  "ANSI E": [863.6, 1117.6],
};

export const PAPER_SIZE_NAMES: readonly string[] = [...Object.keys(PAPER_SIZES), "Custom"];

/** Our size key for a paper of `w` x `h` mm (either orientation), or "Custom". */
export function paperKeyFor(wMm: number, hMm: number): string {
  const [a, b] = wMm <= hMm ? [wMm, hMm] : [hMm, wMm];
  for (const [key, [s, l]] of Object.entries(PAPER_SIZES)) if (Math.abs(a - s) < 1 && Math.abs(b - l) < 1) return key;
  return "Custom";
}

export function paperSpec(size: string, orientation: "landscape" | "portrait" = "landscape", custom?: { w: number; h: number; units?: PaperUnits }): PaperSpec {
  const dims = PAPER_SIZES[size];
  if (!dims || size === "Custom") {
    const w = custom?.w ?? 297;
    const h = custom?.h ?? 210;
    return { size: "Custom", w, h, units: custom?.units ?? "mm", orientation: w >= h ? "landscape" : "portrait" };
  }
  const [short, long] = dims;
  return orientation === "landscape"
    ? { size, w: long, h: short, units: "mm", orientation }
    : { size, w: short, h: long, units: "mm", orientation };
}

/** Sheet size in mm whatever the declared units. */
export function paperSizeMm(p: PaperSpec): { w: number; h: number } {
  const k = p.units === "in" ? 25.4 : 1;
  return { w: p.w * k, h: p.h * k };
}

/** Printable area (inside the margins) in mm, origin at the sheet's lower-left corner. */
export function printableRectMm(layout: LayoutRecord): { x: number; y: number; w: number; h: number } {
  const { w, h } = paperSizeMm(layout.paper);
  const k = layout.paper.units === "in" ? 25.4 : 1;
  const m = layout.margins;
  const left = m.left * k;
  const bottom = m.bottom * k;
  return { x: left, y: bottom, w: Math.max(0, w - left - m.right * k), h: Math.max(0, h - bottom - m.top * k) };
}

export function newLayout(name: string, paper: PaperSpec = paperSpec("A4")): LayoutRecord {
  return {
    name,
    paper,
    margins: { left: 5, top: 5, right: 5, bottom: 5 },
    plotSettings: { scaleLineweights: true, plotStyle: "as displayed", center: true, plotArea: "layout" },
  };
}

/** Fills in anything a hand-edited or foreign record left out. */
export function normalizeLayout(r: TableRecord): LayoutRecord {
  const base = newLayout(r.name);
  const rec = r as Partial<LayoutRecord>;
  const p = rec.paper;
  const paper: PaperSpec =
    p && Number.isFinite(p.w) && Number.isFinite(p.h) && p.w > 0 && p.h > 0
      ? { size: p.size ?? "Custom", w: p.w, h: p.h, units: p.units === "in" ? "in" : "mm", orientation: p.w >= p.h ? "landscape" : "portrait" }
      : base.paper;
  return {
    ...r,
    name: r.name,
    paper,
    margins: { ...base.margins, ...(rec.margins ?? {}) },
    plotSettings: { ...base.plotSettings, ...(rec.plotSettings ?? {}) },
  };
}

export function layoutList(doc: SketchDocument): LayoutRecord[] {
  return doc.records(LAYOUTS_TABLE).map(normalizeLayout);
}

export function getLayout(doc: SketchDocument, name: string): LayoutRecord | undefined {
  const r = doc.getRecord(LAYOUTS_TABLE, name);
  return r ? normalizeLayout(r) : undefined;
}

/** The layout an entity lives on, or `undefined` for model space. */
export function spaceOf(e: Entity): string | undefined {
  return (e as { space?: string }).space || undefined;
}

export function inSpace(e: Entity, space: string | null | undefined): boolean {
  return (spaceOf(e) ?? null) === (space ?? null);
}

export function withSpace<T extends Entity>(e: T, space: string | null | undefined): T {
  const { space: _drop, ...rest } = e as T & { space?: string };
  return (space ? { ...rest, space } : rest) as T;
}

export function modelEntities(doc: SketchDocument): Entity[] {
  return doc.all().filter((e) => !spaceOf(e));
}

export function layoutEntities(doc: SketchDocument, layout: string): Entity[] {
  return doc.all().filter((e) => spaceOf(e) === layout);
}

/** Next free "LayoutN" name. */
export function uniqueLayoutName(doc: SketchDocument, base = "Layout"): string {
  let i = 1;
  while (doc.hasRecord(LAYOUTS_TABLE, `${base}${i}`)) i++;
  return `${base}${i}`;
}

// An entity's `space` names a `layouts` record.
registerEntityRefRewriter(LAYOUTS_TABLE, (entity, from, to) => (spaceOf(entity) === from ? ({ ...entity, space: to } as unknown as Entity) : null));
