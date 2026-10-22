import { jobParamsMm, jobSheets, type EngineId, type NestJob } from "./nestJob";
import { nestRasterMmAsync, type RasterNestPart, type RasterNestResult } from "./raster/rasterNest";
import { LEVEL_BUDGET_MS, nestTrueShapeSearch } from "./search";
import type { StockRow } from "./stock";
import type { TrueNestPlacement, TrueNestSheet } from "./trueNest";

/**
 * One interface over both nesting engines (RN-06): "raster" (default, fast,
 * any quantity) and "true-shape" (the exact no-fit-polygon engine, kept for
 * tight kerf, exact clearance and mirroring). Both take the same
 * {@link NestJob} plus resolved part geometry and return the same result type
 * - `RasterNestResult`, a superset of `TrueNestResult` - so intake, results,
 * canvas, DXF, PDF and G-code never know which ran.
 *
 * `supports()` is how the panel greys out an option the chosen engine cannot
 * honour, with the reason, instead of silently ignoring it.
 *
 * Why it is worth testing: a feature that works for one engine only (clamp
 * strip, purchase size, cancel) is the "two engines drift apart" risk from
 * the plan; `nestEngine.test.ts` runs every case against both ids.
 */


/** What an engine run needs: the job and its parts' resolved geometry (mm), e.g. from `jobParts()`. */
export interface NestRequest {
  job: NestJob;
  parts: RasterNestPart[];
}

/** An option the job asks for that the engine will not honour. */
export interface Unsupported {
  option: "mirror" | "gravity" | "minHoleArea" | "flip" | "quantity" | "searchLevel";
  reason: string;
}

export interface EngineProgress {
  iter: number;
  ms: number;
  /** Sheets in the best layout so far, when known. */
  sheets?: number;
  /** Unplaced pieces in the best layout so far, when known. */
  unplaced?: number;
}

export interface EngineHooks {
  /** Streaming best-so-far (raster only; true-shape reports counts through onProgress). */
  onBest?: (best: RasterNestResult, info: { iter: number; ms: number }) => void;
  onProgress?: (p: EngineProgress) => void;
  /** Polled between restarts; true stops and resolves with the best so far. */
  isCancelled?: () => boolean;
}

export interface NestEngine {
  id: EngineId;
  label: string;
  supports(req: NestRequest): Unsupported[];
  run(req: NestRequest, hooks?: EngineHooks): Promise<RasterNestResult>;
}

/** The True-shape engine places at most this many pieces per run (`trueNest.ts` MAX_INSTANCES). */
export const TRUE_SHAPE_MAX_INSTANCES = 600;

const totalPieces = (parts: RasterNestPart[]) => parts.reduce((n, p) => n + Math.max(0, p.quantity), 0);

// ---------- raster ----------

export const rasterEngine: NestEngine = {
  id: "raster",
  label: "Raster",
  supports({ job, parts }) {
    const out: Unsupported[] = [];
    if (parts.some((p) => p.rotation.mirror && p.quantity > 0)) out.push({ option: "mirror", reason: "The raster engine does not mirror parts; use True shape." });
    if (job.gravity !== "bottom-left") out.push({ option: "gravity", reason: "Raster nesting always fills from the sheet's start edge; gravity is a True shape option." });
    if (job.minHoleArea > 0) out.push({ option: "minHoleArea", reason: "Raster nesting fills every hole large enough automatically; the minimum hole area is a True shape option." });
    return out;
  },
  async run({ job, parts }, hooks = {}) {
    const p = jobParamsMm(job);
    const { stock, extra } = jobSheets(job);
    return nestRasterMmAsync(
      parts,
      stock,
      { spacing: p.spacing, edgeMargin: p.margin, clamp: p.clamp, accuracy: job.accuracy, timeMs: job.timeMs, extra },
      {
        isCancelled: hooks.isCancelled,
        onBest: (best, info) => {
          hooks.onBest?.(best, info);
          hooks.onProgress?.({ iter: info.iter, ms: info.ms, sheets: best.sheets.length, unplaced: best.unplaced.reduce((n, u) => n + u.count, 0) });
        },
        onTick: (info) => hooks.onProgress?.({ iter: info.iter, ms: info.ms, sheets: info.sheets }),
      },
    );
  },
};

// ---------- true shape ----------

/** Shrinks each sheet's short side by the clamp strip. Returns the reduced rows and a way to map results back. */
function reduceForClamp(stock: StockRow[], clamp: number): StockRow[] {
  if (clamp <= 0) return stock;
  return stock.map((row) => {
    const { width, height } = row.size;
    return { ...row, size: { ...row.size, width: width > height ? width : Math.max(1, width - clamp), height: width > height ? Math.max(1, height - clamp) : height } };
  });
}

export const trueShapeEngine: NestEngine = {
  id: "true-shape",
  label: "True shape",
  supports({ job, parts }) {
    const out: Unsupported[] = [];
    if (job.parts.some((p) => p.rotation === "flip")) out.push({ option: "flip", reason: "True shape has no 0/180 only mode; those parts are kept at one orientation." });
    const n = totalPieces(parts);
    if (n > TRUE_SHAPE_MAX_INSTANCES) out.push({ option: "quantity", reason: `True shape nests at most ${TRUE_SHAPE_MAX_INSTANCES} pieces per run (${n} requested); the rest are reported unplaced.` });
    return out;
  },
  async run({ job, parts }, hooks = {}) {
    const p = jobParamsMm(job);
    const sheets = jobSheets(job);
    const inventory = sheets.stock;
    const effective: StockRow[] = sheets.extra ? [...inventory, { size: { ...sheets.extra }, qty: null }] : inventory;
    const reduced = reduceForClamp(effective, p.clamp);
    const t0 = Date.now();
    const { result, attempts } = await nestTrueShapeSearch(parts, reduced, {
      level: job.searchLevel,
      budgetMs: job.searchLevel === "quick" ? 0 : LEVEL_BUDGET_MS[job.searchLevel],
      spacing: p.spacing,
      edgeMargin: p.margin,
      gravity: job.gravity,
      minHoleArea: job.minHoleArea,
      isCancelled: hooks.isCancelled,
      onProgress: (pr) => hooks.onProgress?.({ iter: pr.attempt, ms: pr.elapsedMs, unplaced: pr.bestUnplaced }),
    });

    // Put the clamp strip back: wide sheets keep it on the low-y edge, so everything shifts up by it.
    const shiftY = (sh: TrueNestSheet) => (p.clamp > 0 && effective[sh.stockIndex]!.size.width > effective[sh.stockIndex]!.size.height ? p.clamp : 0);
    const placed: TrueNestPlacement[] = result.placed.map((pl) => {
      const dy = shiftY(result.sheets[pl.sheet]!);
      return dy ? { ...pl, translation: { x: pl.translation.x, y: pl.translation.y + dy } } : pl;
    });
    const outSheets: TrueNestSheet[] = result.sheets.map((sh) => {
      const row = effective[sh.stockIndex]!;
      // The engine may have swapped the last sheet for a smaller row; report that row's real size.
      return { stockIndex: sh.stockIndex, width: row.size.width, height: row.size.height };
    });
    const notes: string[] = [];
    if (job.accuracy !== "normal") notes.push("Accuracy does not apply to True shape (exact geometry).");
    return {
      sheets: outSheets,
      placed,
      unplaced: result.unplaced,
      utilisation: result.utilisation,
      stock: effective,
      purchased: outSheets.map((s) => !!sheets.extra && s.stockIndex === effective.length - 1),
      cellMm: 0,
      iterations: attempts,
      ms: Date.now() - t0,
      lbSheets: 0,
      notes,
    };
  },
};

export const NEST_ENGINES: Record<EngineId, NestEngine> = { raster: rasterEngine, "true-shape": trueShapeEngine };

/** The engine a job selects (unknown ids fall back to raster). */
export function engineFor(id: string): NestEngine {
  return NEST_ENGINES[id as EngineId] ?? rasterEngine;
}
