import { type BlockDefinition, entitiesToSvgDocument, flattenInserts, modelEntities } from "@sketchor/core";
import { doc, hiddenLayerSet, useApp } from "../state/store";
import { activeSaveTarget } from "../io/drawingFile";
import { escapeHtml, printHtml } from "./printHtml";

/**
 * Prints a clean view of the current drawing via the browser's print dialog
 * (which offers "Save as PDF"). No PDF library: the drawing is the existing
 * SVG export, rendered in-page (see printHtml.ts) so the browser does the rest.
 */
export function printDrawing(): void {
  const hidden = hiddenLayerSet();
  // B-08: the browser renders the SVG, and it follows <use>, so blocks print as symbol instances (smaller sheet, same ink).
  // A hidden layer that a block body draws on can't be filtered per instance, so that case is flattened first.
  const blocks = doc.records("blocks") as BlockDefinition[];
  const bodyHidden = blocks.some((b) => b.entities.some((e) => e.layer !== undefined && e.layer !== "0" && hidden.has(e.layer)));
  const keep = blocks.length > 0 && !bodyHidden;
  const model = modelEntities(doc);
  const all = keep ? model : flattenInserts(doc, model);
  const entities = all.filter((e) => !hidden.has(e.layer ?? "0"));
  if (entities.length === 0) return;

  const svg = entitiesToSvgDocument(entities, { strokeColor: "#000000", padding: 8, unit: "none", ...(keep ? { blocks } : {}) });
  const title = activeSaveTarget()?.name ?? "Sketchor drawing";
  const unit = useApp.getState().displayUnit;

  printHtml(
    `<header><h1>${escapeHtml(title)}</h1><span class="meta">Sketchor &middot; units: ${escapeHtml(unit)}</span></header>${svg}`,
  );
}
