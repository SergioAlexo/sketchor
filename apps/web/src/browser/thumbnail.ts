import {
  SketchDocument,
  drawFitted,
  dxfToSvg,
  entitiesToSvg,
  parseDxf,
  parseSvgText,
  withBlocks,
  type BlockDefinition,
  type Entity,
  type TextStyle,
  type ThumbnailOptions,
} from "@sketchor/core";
import { allExtensions } from "../io/formats";

/**
 * True for file kinds the in-app file browser lists thumbnails for:
 * drawings (DXF/SVG/EPS/AI) and 3D models (STEP/IGES, previewed in isometric view
 * via model3d/modelThumbnail.ts). DWG is import-only and not text-readable,
 * so it's opened via the Open dialog / file association rather than browsed
 * here — see drawingFile.ts.
 */
export function isDrawingFile(name: string): boolean {
  // F-11: every 3D format the viewer opens lists too (its card renders through model3d/modelThumbnail.ts).
  return /\.(dxf|svg|eps|ai)$/i.test(name) || allExtensions((f) => f.kind === "3d").some((e) => name.toLowerCase().endsWith(`.${e}`));
}

/**
 * Either file kind as a thumbnail SVG string (core's headless, Node-safe
 * renderer): the fallback where there's no 2D canvas, and the empty frame for
 * a file that can't be read. Cards normally use {@link fileThumbnail}.
 */
export function fileToSvg(name: string, text: string, opts?: ThumbnailOptions): string {
  if (/\.dxf$/i.test(name)) return dxfToSvg(text, opts);
  try {
    const { entities } = parseSvgText(text);
    return entitiesToSvg(entities, opts);
  } catch {
    return entitiesToSvg([], opts);
  }
}

/* ------------------------ E-01: thumbnails on render2d ------------------------ */

/** What a thumbnail draws: model space plus the blocks and text styles it names. */
export interface ThumbDrawing {
  entities: Entity[];
  blocks: BlockDefinition[];
  textStyles: TextStyle[];
}

/** DXF/SVG text → a drawing for {@link drawingThumbnail}. Blocks stay blocks (inserts draw through them), so a big array of inserts isn't exploded just for a preview. */
export function fileToDrawing(name: string, text: string): ThumbDrawing {
  if (/\.dxf$/i.test(name)) {
    const r = parseDxf(text);
    return { entities: r.entities, blocks: r.blocks, textStyles: r.textStyles };
  }
  const r = parseSvgText(text, { blocks: "keep" });
  return { entities: r.entities, blocks: r.blocks, textStyles: [] };
}

export interface ThumbColors {
  /** Canvas background (theme `canvas.bg`). */
  bg: string;
  /** Default entity colour (theme `canvas.entity`). */
  ink: string;
}

/**
 * E-01: a drawing's thumbnail drawn by core `render2d` — the canvas's own
 * renderer, so a card shows the drawing's colours, linetypes, hatches, fills
 * and text the way the canvas will (the SVG path drew everything in one
 * colour and skipped most of that). Returns `<img>` markup with a PNG data
 * URL, or null where there is no 2D canvas (tests, a locked-down webview),
 * which callers answer with the SVG thumbnail. Images draw as their frame:
 * a thumbnail can't wait for a decode.
 */
export function drawingThumbnail(d: ThumbDrawing, size: number, colors: ThumbColors): string | null {
  if (typeof document === "undefined") return null;
  const dpr = Math.min(Math.max(window.devicePixelRatio || 1, 1), 2);
  const px = Math.max(1, Math.round(size * dpr));
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = px;
  let ctx: CanvasRenderingContext2D | null = null;
  try {
    ctx = canvas.getContext("2d");
  } catch {
    ctx = null;
  }
  if (!ctx) return null;
  ctx.fillStyle = colors.bg;
  ctx.fillRect(0, 0, px, px);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const host = new SketchDocument();
  for (const s of d.textStyles) host._putRecord("textStyles", s);
  for (const b of d.blocks) host._putRecord("blocks", b);
  const entities = d.entities.filter((e) => !(e.type === "line" && e.infinite));
  withBlocks(host, () =>
    drawFitted(ctx, entities, {
      width: size,
      height: size,
      padding: 0.08,
      lineWidth: size >= 64 ? 1 : 0.75,
      env: { ink: colors.ink, bg: colors.bg, textStyle: (name) => host.getRecord("textStyles", name) },
    }),
  );
  let url: string;
  try {
    url = canvas.toDataURL("image/png");
  } catch {
    return null;
  }
  return url.startsWith("data:image/png") ? `<img src="${url}" alt="" draggable="false" />` : null;
}

/** A DXF/SVG file's thumbnail markup: render2d when there's a canvas, else the SVG thumbnail. */
export function fileThumbnail(name: string, text: string, size: number, colors: ThumbColors): string {
  try {
    const img = drawingThumbnail(fileToDrawing(name, text), size, colors);
    if (img) return img;
  } catch {
    // unreadable file: fall through to the SVG path, which draws an empty frame for it
  }
  return fileToSvg(name, text, { size, background: colors.bg, stroke: colors.ink });
}

/** F-03 / E-01: EPS/AI vectors (no embedded preview) as thumbnail markup. */
export function epsThumbnail(entities: Entity[], size: number, colors: ThumbColors): string {
  const vectors = entities.filter((e) => e.type !== "image");
  return drawingThumbnail({ entities: vectors, blocks: [], textStyles: [] }, size, colors) ?? epsEntitiesToSvg(vectors, { size, background: colors.bg, stroke: colors.ink });
}

/** True for the binary PostScript formats (EPS/AI), which are read in ranges rather than as text. */
export const isEpsFile = (name: string): boolean => /\.(eps|ai)$/i.test(name);

/** F-03: thumbnail SVG for imported EPS/AI geometry (used when a file has no embedded preview). Raster entities are left out. */
export function epsEntitiesToSvg(entities: Entity[], opts?: ThumbnailOptions): string {
  return entitiesToSvg(entities.filter((e) => e.type !== "image"), opts);
}

/* --------------------------- background rendering ------------------------- */

/**
 * Thumbnail work queue.
 *
 * Reading and parsing a DXF is synchronous and can take a while on a big
 * file. Firing one off per visible card meant opening a folder of hundreds of
 * drawings saturated the main thread and froze the whole app — including the
 * drawing the user was already working on.
 *
 * Jobs are therefore run one at a time, with a yield between each so input,
 * rendering and the canvas keep getting their turn. `requestIdleCallback`
 * schedules the next job in whatever slack the browser has; where it isn't
 * available a macrotask hop gives the same ordering, just less politely.
 * Thumbnails consequently fill in progressively instead of all at once, which
 * is the intended trade.
 */
type Job = () => Promise<void> | void;

const pending: { job: Job; cancelled: boolean }[] = [];
let draining = false;

const nextIdle = (): Promise<void> =>
  new Promise((resolve) => {
    const ric = (window as unknown as { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number })
      .requestIdleCallback;
    if (ric) ric(() => resolve(), { timeout: 250 });
    else setTimeout(resolve, 0);
  });

async function drain(): Promise<void> {
  if (draining) return;
  draining = true;
  try {
    while (pending.length > 0) {
      await nextIdle();
      const entry = pending.shift();
      if (!entry || entry.cancelled) continue;
      try {
        await entry.job();
      } catch {
        // one bad file must not stall the rest of the queue
      }
    }
  } finally {
    draining = false;
  }
}

/**
 * Queues thumbnail work to run off the critical path. Returns a cancel
 * function — call it on unmount so scrolled-away cards don't keep the queue
 * busy rendering previews nobody is looking at.
 */
export function queueThumbnail(job: Job): () => void {
  const entry = { job, cancelled: false };
  pending.push(entry);
  void drain();
  return () => {
    entry.cancelled = true;
  };
}
