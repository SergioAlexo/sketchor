import { area, bounds, pointInPolygon, rotate } from "../geometry";
import { rotationCandidates } from "../rotation";
import type { StockRow } from "../stock";
import type { Point } from "../types";
import type { TrueNestPart, TrueNestPlacement, TrueNestResult, TrueNestSheet } from "../trueNest";
import { nestRaster, nestRasterSync, type RasterAsyncHooks, type RasterBest, type RasterInput, type RasterResult } from "./engine";

/**
 * Millimetre adapter for the raster engine (RN-04) - the layer that lets
 * `trueLayout.ts`, `metrics.ts` and the G-code toolpath consume raster
 * results unchanged. The engine is unit-agnostic and returns part-type
 * indices with rotate-then-translate offsets; this turns that into
 * `TrueNestPlacement`s (translation = where the *rotated part's bbox-min*
 * lands, the same convention `placementTransform` expects), picks the grid
 * cell, and rebuilds `insideOfPlacementIndex` for parts that landed in
 * another placement's hole (the raster engine fills holes automatically; the
 * toolpath still has to cut the inner part before the hole around it).
 *
 * Wrong translations here mean parts materialised somewhere other than where
 * the engine checked clearance - overlapping cuts - so `rasterNest.test.ts`
 * verifies clearance on the *adapter's* output, not just the engine's.
 *
 * Ported from the Sheet Nesting Calculator by Oleksandr Borenko (cell choice
 * and job feed).
 */

/** Accuracy presets: grid cell in mm (the reference's 0.1 / 0.05 / 0.025 in). */
export const RASTER_ACCURACY_CELL_MM = { fast: 2.5, normal: 1.25, precise: 0.6 } as const;
export type RasterAccuracy = keyof typeof RASTER_ACCURACY_CELL_MM;

export interface RasterNestPart extends TrueNestPart {
  /** Explicit rotation set, degrees. Overrides `rotation` when given (the reference's "every 90/45/30/15/10 / any 1" sets). */
  angles?: number[];
}

export interface RasterNestOptions {
  /** Gap between parts (kerf + web), mm. Default 0. */
  spacing?: number;
  /** Gap from every sheet edge, mm. Default 0. */
  edgeMargin?: number;
  /** Clamp strip along one long edge, mm. Default 0. */
  clamp?: number;
  accuracy?: RasterAccuracy;
  /** Overrides `accuracy` with an exact grid cell, mm. */
  cell?: number;
  /** Curve flattening tolerance, mm. Default 0.05. */
  arcTol?: number;
  /** Optimisation budget, ms. 0 = single pass. Default 0. */
  timeMs?: number;
  seed?: number;
  /** Unlimited sheet size to buy once the stock runs out. */
  extra?: { name?: string; width: number; height: number } | null;
  /** Test hook: cap on restarts. */
  maxIterations?: number;
}

export interface RasterNestResult extends TrueNestResult {
  /** The stock list the sheets' `stockIndex` refers to: the input stock plus the purchase size (qty null) when one was given. */
  stock: StockRow[];
  /** Per sheet: true when it is from the purchase size, not inventory. */
  purchased: boolean[];
  cellMm: number;
  iterations: number;
  ms: number;
  /** Area lower bound on the number of sheets (0 when it does not apply). */
  lbSheets: number;
  /** Notes about options the raster engine cannot honour. */
  notes: string[];
}

/** Port of the reference `chooseCell`: accuracy preset, capped at minDim/12, grown until the biggest sheet is at most 9 M cells. */
export function chooseCell(parts: Pick<TrueNestPart, "outer">[], sheets: { width: number; height: number }[], accuracy: RasterAccuracy = "normal"): number {
  let cell: number = RASTER_ACCURACY_CELL_MM[accuracy];
  let minDim = Infinity;
  for (const p of parts) {
    if (p.outer.length === 0) continue;
    const b = bounds(p.outer);
    minDim = Math.min(minDim, b.maxX - b.minX, b.maxY - b.minY);
  }
  cell = Math.min(cell, Math.max(0.25, minDim / 12));
  let maxA = 0;
  for (const s of sheets) maxA = Math.max(maxA, s.width * s.height);
  while (maxA / (cell * cell) > 9e6) cell *= 1.25;
  return Math.round(cell * 1000) / 1000;
}

interface Prepared {
  input: RasterInput;
  parts: RasterNestPart[];
  stock: StockRow[];
  nInventory: number;
  cell: number;
  notes: string[];
}

function prepare(parts: RasterNestPart[], stock: StockRow[], opts: RasterNestOptions): Prepared {
  const notes: string[] = [];
  const effective: StockRow[] = [...stock];
  const nInventory = stock.length;
  if (opts.extra) {
    effective.push({ size: { name: opts.extra.name ?? "Purchase", width: opts.extra.width, height: opts.extra.height }, qty: null });
  }
  const cell = opts.cell ?? chooseCell(parts, effective.map((s) => s.size), opts.accuracy);
  if (parts.some((p) => p.rotation.mirror)) notes.push("Mirroring is not supported by the raster engine; mirrored copies were not tried.");
  if (parts.some((p) => p.allowInHoles === false)) notes.push("The raster engine fills part holes automatically; per-part hole opt-out is ignored.");

  const input: RasterInput = {
    parts: parts.map((p) => {
      const degs = p.angles && p.angles.length > 0 ? p.angles : [...new Set(rotationCandidates({ ...p.rotation, mirror: false }, p.outer).map((c) => c.deg))];
      const net = Math.max(0, area(p.outer) - p.holes.reduce((a, h) => a + area(h), 0));
      return {
        polys: [p.outer, ...p.holes].map((poly) => poly.map((q): [number, number] => [q.x, q.y])),
        rots: degs,
        qty: p.quantity,
        area: net,
      };
    }),
    // Inventory only; the purchase size goes in `extra`. With no inventory a
    // zero-quantity stand-in keeps the engine on its multi-stock path.
    sheetTypes: nInventory > 0
      ? stock.map((s) => ({ w: s.size.width, h: s.size.height, qty: s.qty }))
      : opts.extra ? [{ w: opts.extra.width, h: opts.extra.height, qty: 0 }] : undefined,
    extra: opts.extra ? { w: opts.extra.width, h: opts.extra.height } : null,
    sheetW: 0,
    sheetH: 0,
    spacing: opts.spacing ?? 0,
    margin: opts.edgeMargin ?? 0,
    clamp: opts.clamp ?? 0,
    cell,
    arcTol: opts.arcTol ?? 0.05,
    timeMs: opts.timeMs ?? 0,
    seed: opts.seed ?? 12345,
    maxIterations: opts.maxIterations,
  };
  return { input, parts, stock: effective, nInventory, cell, notes };
}

/** Engine output (part types, rotate-then-translate) to `TrueNestPlacement`s, with hole nesting rebuilt. */
function convert(prep: Prepared, best: RasterBest, stats: { iterations: number; ms: number; lbSheets: number }): RasterNestResult {
  const { parts, stock } = prep;
  const sheets: TrueNestSheet[] = [];
  const purchased: boolean[] = [];
  const placed: TrueNestPlacement[] = [];
  /** Per placed index: the placement's outline and holes in sheet space, for the hole post-pass. */
  const world: { outer: Point[]; holes: Point[][] }[] = [];
  let placedArea = 0;

  best.sheets.forEach((sh, si) => {
    // tidx counts [inventory..., purchase size]; with no inventory the engine
    // saw a stand-in at 0 and the purchase size at 1, but `stock` has just one row.
    const isPurchase = sh.extra;
    sheets.push({ stockIndex: isPurchase ? stock.length - 1 : sh.tidx, width: sh.w, height: sh.h });
    purchased.push(isPurchase);
    for (const pl of sh.placements) {
      const part = parts[pl.t]!;
      const rotatedOuter = rotate(part.outer, pl.deg);
      const box = bounds(rotatedOuter);
      const at = (poly: Point[]) => rotate(poly, pl.deg).map((q) => ({ x: q.x + pl.tx, y: q.y + pl.ty }));
      placed.push({
        partId: part.id,
        sheet: si,
        rotationDeg: pl.deg,
        mirrored: false,
        translation: { x: pl.tx + box.minX, y: pl.ty + box.minY },
      });
      world.push({ outer: at(part.outer), holes: part.holes.map(at) });
      placedArea += Math.max(0, area(part.outer) - part.holes.reduce((a, h) => a + area(h), 0));
    }
  });

  // Hole post-pass: a placement whose outline lies inside another placement's
  // hole (same sheet) must be cut first. Pick the innermost (smallest) hole.
  placed.forEach((pl, i) => {
    let bestJ = -1;
    let bestArea = Infinity;
    for (let j = 0; j < placed.length; j++) {
      if (j === i || placed[j]!.sheet !== pl.sheet) continue;
      for (const hole of world[j]!.holes) {
        const a = area(hole);
        if (a < bestArea && world[i]!.outer.every((q) => pointInPolygon(q, hole))) {
          bestArea = a;
          bestJ = j;
        }
      }
    }
    if (bestJ >= 0) pl.insideOfPlacementIndex = bestJ;
  });

  const counts = new Map<string, number>();
  for (const t of best.unplaced) counts.set(parts[t]!.id, (counts.get(parts[t]!.id) ?? 0) + 1);
  const totalSheetArea = sheets.reduce((s, x) => s + x.width * x.height, 0);

  return {
    sheets,
    placed,
    unplaced: Array.from(counts, ([partId, count]) => ({ partId, count })),
    utilisation: totalSheetArea > 0 ? placedArea / totalSheetArea : 0,
    stock,
    purchased,
    cellMm: prep.cell,
    iterations: stats.iterations,
    ms: stats.ms,
    lbSheets: stats.lbSheets,
    notes: prep.notes,
  };
}

function statsOf(r: RasterResult) {
  return { iterations: r.iterations, ms: r.ms, lbSheets: r.lbSheets };
}

/** Synchronous raster nest in mm (tests, small jobs). Honours `timeMs`. */
export function nestRasterMm(parts: RasterNestPart[], stock: StockRow[], opts: RasterNestOptions = {}): RasterNestResult {
  const prep = prepare(parts, stock, opts);
  const r = nestRasterSync(prep.input);
  return convert(prep, r, statsOf(r));
}

export interface RasterMmHooks {
  /** Best-so-far, already converted to placements. */
  onBest?: (best: RasterNestResult, info: { iter: number; ms: number }) => void;
  onTick?: (info: { iter: number; ms: number; sheets?: number }) => void;
  isCancelled?: RasterAsyncHooks["isCancelled"];
}

/** Cooperative raster nest in mm (RN-03 + RN-04): yields to the event loop so a worker can receive cancel; a cancelled run resolves with the best layout so far. */
export async function nestRasterMmAsync(parts: RasterNestPart[], stock: StockRow[], opts: RasterNestOptions = {}, hooks: RasterMmHooks = {}): Promise<RasterNestResult> {
  const prep = prepare(parts, stock, opts);
  const r = await nestRaster(prep.input, {
    isCancelled: hooks.isCancelled,
    onTick: hooks.onTick,
    onBest: hooks.onBest ? (b, info) => hooks.onBest!(convert(prep, b, { iterations: info.iter, ms: info.ms, lbSheets: 0 }), info) : undefined,
  });
  return convert(prep, r, statsOf(r));
}
