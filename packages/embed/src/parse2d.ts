/**
 * E-01: bytes → a 2D drawing, through the same core importers the app opens
 * files with (DXF/binary DXF, SVG, EPS/AI, PDF). Entities come out in mm.
 * Everything but SVG is pure and runs in the parse worker; SVG needs the
 * browser's DOMParser, which workers don't have, so parseClient.ts reads it
 * on the main thread.
 *
 * Imports core modules directly rather than the barrel, as the rest of the
 * embed does, and each importer only when its format turns up, so a page of
 * DXFs never downloads the PostScript or PDF interpreters.
 */
// The importers and the bounds below ask the entity kind registry; the core barrel registers the built-ins, a direct import must too.
import "../../core/src/kinds/builtin";
import type { BlockDefinition } from "../../core/src/blocks/types";
import type { Entity } from "../../core/src/entities";
import type { TextStyle } from "../../core/src/textStyle";
import type { DrawingFormat } from "./load";

export interface Drawing2D {
  name: string;
  /** Model space, in mm. */
  entities: Entity[];
  /** B-07: block definitions the drawing's `insert` entities name. */
  blocks: BlockDefinition[];
  /** D-01: text styles the drawing's texts name. */
  textStyles: TextStyle[];
  warnings: string[];
}

/** The largest drawing the embed draws (entities after import); past this the app is the better place to look at it. */
export const MAX_DRAWING_ENTITIES = 400_000;

export async function parseDrawing(bytes: Uint8Array, name: string, format: DrawingFormat): Promise<Drawing2D> {
  let d: Omit<Drawing2D, "name">;
  if (format === "dxf") {
    const [{ parseDxf }, { decodeDxfBytes }] = await Promise.all([import("../../core/src/dxf"), import("../../core/src/dxfText")]);
    const r = parseDxf(decodeDxfBytes(bytes));
    d = { entities: r.entities, blocks: r.blocks, textStyles: r.textStyles, warnings: r.warnings.filter((w) => !w.startsWith("unsupported entity")) };
  } else if (format === "svg") {
    const { parseSvgText } = await import("../../core/src/svg");
    const r = parseSvgText(new TextDecoder().decode(bytes), { blocks: "keep" });
    d = { entities: r.entities, blocks: r.blocks, textStyles: [], warnings: r.warnings };
  } else if (format === "pdf") {
    const { importPdf } = await import("../../core/src/pdf/index");
    const r = importPdf(bytes);
    d = { entities: r.entities, blocks: [], textStyles: [], warnings: r.warnings };
  } else {
    const { importEps } = await import("../../core/src/eps/index");
    const r = importEps(bytes);
    d = { entities: r.entities, blocks: [], textStyles: [], warnings: r.warnings };
  }
  if (d.entities.length === 0) {
    // The importers say why (a PDF-based .ai, a raster-only EPS, an unsupported DXF): that is the useful message.
    throw new Error(d.warnings[0] ?? "the drawing is empty");
  }
  if (d.entities.length > MAX_DRAWING_ENTITIES) throw new Error(`the drawing has ${d.entities.length.toLocaleString("en-US")} objects — too many for a preview`);
  return { name, ...d };
}
