import { bounds } from "./geometry";
import type { StockRow } from "./stock";
import { localFrame, type TrueNestPlacement, type TrueNestResult } from "./trueNest";
import type { Point } from "./types";

/**
 * Remnant library (N-52): turn the usable offcut of each nested sheet into a
 * stock row, so the next job can cut from it instead of a fresh sheet.
 *
 * Why it is worth testing: a remnant that overlaps a placed part would be
 * sold to the next job as free material that is not there, and a library that
 * does not consume the sheets a job used would count the same steel twice.
 * The rectangle is deliberately conservative - it avoids the bounding box of
 * every placed part - so what is offered is always genuinely clear.
 */

export interface RemnantOptions {
  /** Both sides of a kept offcut must be at least this long (mm). Default 100. */
  minSide?: number;
  /** Offcuts below this area are scrap (mm^2). Default 25000 (about 158 x 158 mm). */
  minArea?: number;
  /** Clearance kept between a part and the offcut (mm). Default 0. */
  clearance?: number;
  /** Keep at most this many rectangles per sheet (greedy, largest first). Default 1. */
  perSheet?: number;
}

export interface Remnant {
  /** Sheet of the result the offcut came from. */
  sheet: number;
  /** Position on that sheet (mm). */
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface EmptyRect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** Work cap (row pairs x columns) so a sheet with thousands of parts cannot stall the worker. */
const MAX_WORK = 2e8;

/** Largest axis-aligned empty rectangle in a `width` x `height` sheet avoiding `blocked` (coordinate-compressed scan). Null if none, or if the work cap is exceeded. */
export function largestEmptyRect(width: number, height: number, blocked: EmptyRect[]): EmptyRect | null {
  if (!(width > 0 && height > 0)) return null;
  const xs = new Set<number>([0, width]);
  const ys = new Set<number>([0, height]);
  for (const b of blocked) {
    for (const x of [b.x0, b.x1]) if (x > 0 && x < width) xs.add(x);
    for (const y of [b.y0, b.y1]) if (y > 0 && y < height) ys.add(y);
  }
  const X = [...xs].sort((a, b) => a - b);
  const Y = [...ys].sort((a, b) => a - b);
  const cols = X.length - 1;
  const rows = Y.length - 1;
  if (cols < 1 || rows < 1) return null;
  if (rows * rows * cols > MAX_WORK) return null;
  const occ = new Uint8Array(rows * cols);
  const EPS = 1e-9;
  for (const b of blocked) {
    if (b.x1 <= 0 || b.y1 <= 0 || b.x0 >= width || b.y0 >= height) continue;
    for (let r = 0; r < rows; r++) {
      if (!(Y[r + 1]! > b.y0 + EPS && Y[r]! < b.y1 - EPS)) continue;
      for (let c = 0; c < cols; c++) {
        if (X[c + 1]! > b.x0 + EPS && X[c]! < b.x1 - EPS) occ[r * cols + c] = 1;
      }
    }
  }
  let best: EmptyRect | null = null;
  let bestArea = 0;
  const free = new Uint8Array(cols);
  for (let i = 0; i < rows; i++) {
    free.fill(1);
    for (let j = i; j < rows; j++) {
      let any = false;
      for (let c = 0; c < cols; c++) {
        if (occ[j * cols + c]) free[c] = 0;
        if (free[c]) any = true;
      }
      if (!any) break;
      const h = Y[j + 1]! - Y[i]!;
      let c = 0;
      while (c < cols) {
        if (!free[c]) {
          c++;
          continue;
        }
        let e = c;
        while (e < cols && free[e]) e++;
        const a = (X[e]! - X[c]!) * h;
        if (a > bestArea) {
          bestArea = a;
          best = { x0: X[c]!, y0: Y[i]!, x1: X[e]!, y1: Y[j + 1]! };
        }
        c = e;
      }
    }
  }
  return best;
}

/** Offcuts worth keeping from each sheet of a result. `geo` gives a part's outer outline by `partId`. */
export function findRemnants(
  result: Pick<TrueNestResult, "sheets" | "placed">,
  geo: (partId: string) => Point[] | undefined,
  opts: RemnantOptions = {},
): Remnant[] {
  const minSide = opts.minSide ?? 100;
  const minArea = opts.minArea ?? 25_000;
  const clearance = Math.max(0, opts.clearance ?? 0);
  const perSheet = Math.max(1, Math.floor(opts.perSheet ?? 1));
  const out: Remnant[] = [];
  result.sheets.forEach((sheet, si) => {
    const blocked: EmptyRect[] = [];
    for (const p of result.placed as TrueNestPlacement[]) {
      if (p.sheet !== si) continue;
      const outer = geo(p.partId);
      if (!outer || outer.length === 0) continue;
      const b = bounds(localFrame(outer, p.rotationDeg, p.mirrored));
      blocked.push({
        x0: p.translation.x - clearance,
        y0: p.translation.y - clearance,
        x1: p.translation.x + (b.maxX - b.minX) + clearance,
        y1: p.translation.y + (b.maxY - b.minY) + clearance,
      });
    }
    for (let k = 0; k < perSheet; k++) {
      const r = largestEmptyRect(sheet.width, sheet.height, blocked);
      if (!r) break;
      const w = r.x1 - r.x0;
      const h = r.y1 - r.y0;
      if (w < minSide || h < minSide || w * h < minArea) break;
      out.push({ sheet: si, x: r.x0, y: r.y0, width: w, height: h });
      blocked.push(r);
    }
  });
  return out;
}

const round1 = (n: number) => Math.round(n * 10) / 10;

/**
 * The stock list after a job: the inventory sheets it used are taken out
 * (`used[i]` = sheets cut from row i; unlimited rows stay unlimited) and the
 * offcuts are added as qty-1 rows, merged with an identical size/material/
 * thickness remnant already in the library. Pure: returns new rows.
 */
export function applyRemnantsToStock(
  stock: StockRow[],
  remnants: { width: number; height: number; material?: string; thickness?: number }[],
  used: number[] = [],
): StockRow[] {
  const rows: StockRow[] = stock.map((r, i) => ({
    ...r,
    size: { ...r.size },
    qty: r.qty === null ? null : Math.max(0, r.qty - (used[i] ?? 0)),
  }));
  const kept = rows.filter((r) => r.qty === null || r.qty > 0);
  for (const rem of remnants) {
    const w = round1(rem.width);
    const h = round1(rem.height);
    if (!(w > 0 && h > 0)) continue;
    const same = kept.find(
      (r) =>
        r.qty !== null &&
        round1(r.size.width) === w &&
        round1(r.size.height) === h &&
        r.material === rem.material &&
        r.thickness === rem.thickness &&
        r.size.name.startsWith("Remnant"),
    );
    if (same) same.qty = (same.qty ?? 0) + 1;
    else
      kept.push({
        size: { name: `Remnant ${w} x ${h}`, width: w, height: h },
        ...(rem.material ? { material: rem.material } : {}),
        ...(rem.thickness !== undefined ? { thickness: rem.thickness } : {}),
        qty: 1,
      });
  }
  return kept;
}
