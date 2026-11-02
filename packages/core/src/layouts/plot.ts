import { withBlocks } from "../blocks/context";
import type { SketchDocument } from "../document";
import type { Entity, ViewportEntity } from "../entities";
import { drawEntitiesToPdf } from "../entitiesPdf";
import { layerList, resolveLineweight, resolveLinetype } from "../layerTable";
import { layerOf } from "../entities";
import { insertContents } from "../kinds/insert";
import { kindBounds } from "../kinds/registry";
import { PdfBuilder, type PdfPageSize, type PdfPoint } from "../pdf";
import { getLayout, modelEntities, paperSizeMm, layoutEntities, type LayoutRecord, type PlotStyle } from "./types";
import { viewportOutline, viewportShowsLayer } from "./viewport";

/**
 * L-06: plots layouts to PDF. A sheet is printed 1:1 (paper mm -> points), every viewport is a clipped
 * window onto the model drawn at the viewport's scale, and "publish" is simply several layouts as the
 * pages of one file (each page its own paper size). Pure and synchronous: the web app only decides what to
 * do with the bytes (autosave folder, print preview).
 */

const PT_PER_MM = 72 / 25.4;

export interface PlotOptions {
  /** Layers not to print (default: the layers the drawing has switched off). */
  hiddenLayers?: ReadonlySet<string>;
  /** Overrides every layout's own plot style. */
  plotStyle?: PlotStyle;
}

/** The ink for `color` under a plot style: monochrome is black, grayscale keeps luminance, as displayed is untouched. */
export function plotColor(color: string | undefined, style: PlotStyle): string | undefined {
  if (style === "monochrome") return "#000000";
  if (style === "grayscale" && color) {
    const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(color.trim());
    if (!m) return color;
    const hex = m[1].length === 3 ? m[1].replace(/./g, (c) => c + c) : m[1];
    const [r, g, b] = [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16));
    const y = Math.round(0.299 * r + 0.587 * g + 0.114 * b);
    return `#${y.toString(16).padStart(2, "0").repeat(3)}`;
  }
  return color;
}

export function layoutPageSize(layout: LayoutRecord): PdfPageSize {
  const { w, h } = paperSizeMm(layout.paper);
  return { width: w * PT_PER_MM, height: h * PT_PER_MM };
}

/** Inserts become the entities they stand for (under their own layout's field context); BYLAYER linetype is made explicit; the plot style inks colour. */
function prepare(doc: SketchDocument, entities: readonly Entity[], style: PlotStyle, tint?: (layer: string) => string | undefined): Entity[] {
  const out: Entity[] = [];
  const push = (e: Entity, insertLayer?: string) => {
    const lt = resolveLinetype(doc, e);
    const color = tint?.(insertLayer ?? layerOf(e)) ?? e.color;
    const inked = plotColor(color, style);
    out.push({ ...e, ...(lt !== "CONTINUOUS" && !e.linetype ? { linetype: lt } : {}), ...(inked ? { color: inked } : {}) } as Entity);
  };
  for (const e of entities) {
    if (e.type === "insert") for (const c of insertContents(e)) push(c, layerOf(e) === "0" ? undefined : layerOf(e));
    else push(e);
  }
  return out;
}

/** Draws one layout onto the page in progress. */
export function drawLayoutPage(pdf: PdfBuilder, doc: SketchDocument, layout: LayoutRecord, opts: PlotOptions = {}): void {
  const style = opts.plotStyle ?? layout.plotSettings.plotStyle;
  const hidden = opts.hiddenLayers ?? new Set(layerList(doc).filter((l) => !l.visible).map((l) => l.name));
  const H = pdf.height;
  const k = PT_PER_MM;
  const trueWeights = layout.plotSettings.scaleLineweights;
  const widthOf = (e: Entity): number | undefined => {
    if (!trueWeights) return undefined;
    const mm = resolveLineweight(doc, e);
    return mm === undefined ? undefined : Math.max(0.1, mm * k);
  };
  const common = { strokeColor: plotColor("#000000", style) ?? "#000000", strokeWidth: 0.5, widthOf };

  const model = modelEntities(doc).filter((e) => !hidden.has(layerOf(e)));
  const paper = layoutEntities(doc, layout.name).filter((e) => !hidden.has(layerOf(e)));
  const viewports = paper.filter((e): e is ViewportEntity => e.type === "viewport");

  // Windows first, so the sheet's own annotation and the frame print on top of the model.
  for (const vp of viewports) {
    const s = vp.scale;
    const bb = (() => {
      const o = viewportOutline(vp);
      return { minX: Math.min(...o.map((p) => p.x)), maxX: Math.max(...o.map((p) => p.x)), minY: Math.min(...o.map((p) => p.y)), maxY: Math.max(...o.map((p) => p.y)) };
    })();
    // The model rectangle the window shows, for culling.
    const mMinX = (bb.minX - vp.center.x) / s + vp.viewCenter.x;
    const mMaxX = (bb.maxX - vp.center.x) / s + vp.viewCenter.x;
    const mMinY = (bb.minY - vp.center.y) / s + vp.viewCenter.y;
    const mMaxY = (bb.maxY - vp.center.y) / s + vp.viewCenter.y;
    const shown = model.filter((e) => {
      if (!viewportShowsLayer(vp, layerOf(e))) return false;
      const b = kindBounds(e);
      return !b || !(b.maxX < mMinX || b.minX > mMaxX || b.maxY < mMinY || b.minY > mMaxY);
    });
    const colorOf = (layer: string) => vp.layerOverrides?.[layer]?.color;
    const entities = prepare(doc, shown, style, colorOf).map((e) => {
      const over = vp.layerOverrides?.[layerOf(e)];
      return over?.linetype ? ({ ...e, linetype: over.linetype } as Entity) : e;
    });
    const clip: PdfPoint[] = viewportOutline(vp).map((p) => ({ x: p.x * k, y: H - p.y * k }));
    pdf.beginClip(clip);
    drawEntitiesToPdf(pdf, entities, { x: 0, y: 0, width: 0, height: 0 }, { ...common, fixed: { scale: s * k, ox: (vp.center.x - vp.viewCenter.x * s) * k, oy: H + (vp.viewCenter.y * s - vp.center.y) * k } });
    pdf.endClip();
  }

  drawEntitiesToPdf(pdf, prepare(doc, paper, style), { x: 0, y: 0, width: 0, height: 0 }, { ...common, fixed: { scale: k, ox: 0, oy: H } });
}

/**
 * One PDF with a page per named layout, in the order given (unknown names are skipped). Returns null when
 * nothing was left to print.
 */
export function plotLayoutsToPdf(doc: SketchDocument, names: readonly string[], opts: PlotOptions = {}): Uint8Array | null {
  const layouts = names.map((n) => getLayout(doc, n)).filter((l): l is LayoutRecord => !!l);
  if (layouts.length === 0) return null;
  return withBlocks(doc, () => {
    const pdf = new PdfBuilder(layoutPageSize(layouts[0]));
    layouts.forEach((layout, i) => {
      if (i > 0) pdf.addPage(layoutPageSize(layout));
      drawLayoutPage(pdf, doc, layout, opts);
    });
    return pdf.bytes();
  });
}
