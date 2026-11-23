import type { Bounds } from "./geometry";

/**
 * A job's available stock (N-13) — sizes to draw sheets from, each with its
 * own material, thickness, and how many are on hand.
 */
export interface StockRow {
  size: { name: string; width: number; height: number };
  material?: string;
  /** NT-02: the job's material id (al5052, cs...), for the machine-file lookup. */
  materialId?: string;
  thickness?: number;
  /** Sheets available; `null` = unlimited. */
  qty: number | null;
  cost?: number;
}

/**
 * Which stock row to open the next sheet from: the first row (in list order)
 * with remaining quantity — "open the next from inventory" taken literally,
 * not size-optimized. `used[i]` is how many sheets have already been opened
 * from row `i`; the caller owns that array, so a dry-run check never mutates
 * `stock` itself.
 */
export function openNextStock(stock: StockRow[], used: number[]): { index: number; row: StockRow } | null {
  for (let i = 0; i < stock.length; i++) {
    const row = stock[i];
    if (row.qty === null || (used[i] ?? 0) < row.qty) return { index: i, row };
  }
  return null;
}

/**
 * After nesting, the last sheet often only needed a fraction of the stock
 * size it was opened from — this finds the smallest available row (by area)
 * that `lastSheetBounds` (plus `margin` on every side) still fits inside, or
 * `null` if nothing smaller fits. `currentStockIndex` is the row the last
 * sheet is *currently* charged against: its quantity is treated as one
 * short (the slot about to be freed), so re-picking the same row — or
 * another row with exactly one spare slot — is not wrongly ruled out.
 */
export function shrinkLastSheet(
  stock: StockRow[],
  used: number[],
  currentStockIndex: number,
  lastSheetBounds: Bounds,
  margin: number,
): number | null {
  const neededW = lastSheetBounds.maxX - lastSheetBounds.minX + margin * 2;
  const neededH = lastSheetBounds.maxY - lastSheetBounds.minY + margin * 2;
  let bestIndex: number | null = null;
  let bestArea = Infinity;
  for (let i = 0; i < stock.length; i++) {
    const row = stock[i];
    const effectiveUsed = (used[i] ?? 0) - (i === currentStockIndex ? 1 : 0);
    if (row.qty !== null && effectiveUsed >= row.qty) continue;
    if (row.size.width < neededW || row.size.height < neededH) continue;
    const area = row.size.width * row.size.height;
    if (area < bestArea) {
      bestArea = area;
      bestIndex = i;
    }
  }
  return bestIndex;
}
