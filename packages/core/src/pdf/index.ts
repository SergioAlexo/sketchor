/**
 * PDF vector import entry point (F-08). `importPdf(bytes, {page})` reads one
 * page's vector content — paths, Form XObjects, optional-content layers and
 * text — into Sketchor entities in millimetres, page lower-left at the origin.
 * Never throws on bad input: failures come back as `error` (with the same text
 * in `warnings`) so callers can show one message.
 */
import type { Entity } from "../entities";
import { PdfDoc } from "./doc";
import { PdfError } from "./objects";
import { PdfInterp } from "./interp";

export { PdfError } from "./objects";

export interface PdfImportOptions {
  /** 1-based page number (default 1). */
  page?: number;
  maxEntities?: number;
  maxOps?: number;
  /** Form XObject nesting limit. */
  maxDepth?: number;
}

export interface PdfImportResult {
  entities: Entity[];
  warnings: string[];
  /** Total pages in the document (0 when it could not be read). */
  pageCount: number;
  /** The page that was read (1-based). */
  page: number;
  /** Visible page size in millimetres (after /Rotate). */
  pageSize: { width: number; height: number } | null;
  /** Set when nothing could be imported (encrypted, not a PDF, …). */
  error?: string;
}

const K = 25.4 / 72;

const fail = (message: string, page: number, pageCount = 0): PdfImportResult => ({ entities: [], warnings: [message], pageCount, page, pageSize: null, error: message });

export function importPdf(bytes: Uint8Array, opts: PdfImportOptions = {}): PdfImportResult {
  const pageNo = Math.max(1, Math.floor(opts.page ?? 1) || 1);
  let doc: PdfDoc;
  try {
    doc = new PdfDoc(bytes);
  } catch (e) {
    return fail(e instanceof PdfError ? e.message : "the PDF could not be read (damaged file)", pageNo);
  }
  try {
    const pageCount = doc.pageCount();
    if (pageCount <= 0 && !doc.page(0)) return fail("the PDF has no pages", pageNo);
    const page = doc.page(pageNo - 1);
    if (!page) return fail(`the PDF has ${pageCount} page${pageCount === 1 ? "" : "s"} — page ${pageNo} does not exist`, pageNo, pageCount);

    // visible box = CropBox ∩ MediaBox (defaults to US Letter if the file gives neither)
    const norm = (b: number[] | null): [number, number, number, number] | null => (b && b.length === 4 ? [Math.min(b[0], b[2]), Math.min(b[1], b[3]), Math.max(b[0], b[2]), Math.max(b[1], b[3])] : null);
    const mb = norm(page.mediaBox) ?? [0, 0, 612, 792];
    const cb = norm(page.cropBox);
    let box = mb;
    if (cb) {
      const i: [number, number, number, number] = [Math.max(mb[0], cb[0]), Math.max(mb[1], cb[1]), Math.min(mb[2], cb[2]), Math.min(mb[3], cb[3])];
      if (i[2] > i[0] && i[3] > i[1]) box = i;
    }
    const w = box[2] - box[0];
    const h = box[3] - box[1];
    const warnings: string[] = [];
    if (!(w > 0 && h > 0 && w < 1e7 && h < 1e7)) return fail("the PDF page has an invalid size", pageNo, pageCount);
    const rot = ((Math.round(page.rotate / 90) * 90) % 360 + 360) % 360;
    // user space → page space (points, origin bottom-left of the visible box, /Rotate applied)
    const t: [number, number, number, number, number, number] = [1, 0, 0, 1, -box[0], -box[1]];
    const R = rot === 90 ? [0, -1, 1, 0, 0, w] : rot === 180 ? [-1, 0, 0, -1, w, h] : rot === 270 ? [0, 1, -1, 0, h, 0] : [1, 0, 0, 1, 0, 0];
    const base: [number, number, number, number, number, number] = [
      t[0] * R[0] + t[1] * R[2],
      t[0] * R[1] + t[1] * R[3],
      t[2] * R[0] + t[3] * R[2],
      t[2] * R[1] + t[3] * R[3],
      t[4] * R[0] + t[5] * R[2] + R[4],
      t[4] * R[1] + t[5] * R[3] + R[5],
    ];
    const pw = rot === 90 || rot === 270 ? h : w;
    const ph = rot === 90 || rot === 270 ? w : h;

    const interp = new PdfInterp(doc, page, base, [0, 0, pw, ph], { maxEntities: opts.maxEntities ?? 400_000, maxOps: opts.maxOps ?? 20_000_000, maxDepth: opts.maxDepth ?? 12 });
    const r = interp.runPage(page);
    const s = r.stats;
    const plural = (n: number, w1: string) => `${n} ${w1}${n === 1 ? "" : "s"}`;
    if (s.images) warnings.push(`${plural(s.images, "raster image")} skipped (only vector content is imported)`);
    if (s.shadings) warnings.push(`${plural(s.shadings, "gradient/shading")} skipped`);
    if (s.patterns) warnings.push(`${plural(s.patterns, "pattern fill")} drawn in the previous colour`);
    if (s.croppingClips) warnings.push(`${plural(s.croppingClips, "clipping path")} ignored (shapes are not cropped)`);
    if (s.textNoUnicode) warnings.push(`${plural(s.textNoUnicode, "text run")} skipped — the font has no Unicode mapping`);
    if (s.hiddenLayerShapes) warnings.push(`${plural(s.hiddenLayerShapes, "shape")} on hidden layers skipped`);
    if (s.formDepth) warnings.push("nested form XObjects were too deep (or recursive) — some content skipped");
    const unknown = Object.entries(s).filter(([k]) => k.startsWith("op:"));
    if (unknown.length) warnings.push(`PDF operators not supported (ignored): ${unknown.slice(0, 8).map(([k, n]) => `${k.slice(3)} ×${n}`).join(", ")}`);
    if (r.truncated) warnings.push("the page is very large — import stopped at the entity limit");
    if (r.budgetHit) warnings.push("the page content was too complex to finish — import stopped early");
    if (pageCount > 1 && pageNo === 1) warnings.unshift(`this PDF has ${pageCount} pages — only page 1 was imported`);
    else if (pageCount > 1) warnings.unshift(`imported page ${pageNo} of ${pageCount}`);
    if (!r.entities.length) warnings.push("no vector geometry found on this page (it may be a scanned image)");
    return { entities: r.entities, warnings, pageCount, page: pageNo, pageSize: { width: pw * K, height: ph * K } };
  } catch (e) {
    if (e instanceof PdfError) return fail(e.message, pageNo);
    return fail("the PDF could not be read (damaged or unsupported file)", pageNo);
  }
}
