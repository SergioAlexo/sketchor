import { area, bounds } from "./geometry";
import { localFrame, type Gravity, type TrueNestPlacement, type TrueNestResult } from "./trueNest";
import type { StockRow } from "./stock";
import type { Point } from "./types";

/**
 * Job metrics (N-22): utilisation, scrap vs. reusable remnant, and an
 * estimated cutting time from an editable cut table. Area and perimeter are
 * rotation/translation-invariant, so utilisation and cut length only need
 * each part's own (unplaced) outline — no need to reconstruct where a part
 * actually landed on the sheet, except for the remnant strip, which does
 * care about how far up (or down, depending on `gravity`) placement reached.
 */

export interface CutTableRow {
  material: string;
  thickness: number;
  feedRateMmPerMin: number;
  pierceTimeSec: number;
  rapidMmPerMin: number;
  /** Seed rows are estimates — machine values win once a real one is entered. */
  estimated: boolean;
  densityKgPerM3?: number;
}

export interface PartGeometry {
  outer: Point[];
  holes: Point[][];
}

export interface SheetMetrics {
  sheet: number;
  sheetArea: number;
  netPartArea: number;
  utilisation: number;
  /** A clean, reusable strip past the last part — `null` if none clears `remnantMinHeight`. */
  remnant: { width: number; height: number; area: number } | null;
  trueScrapArea: number;
  cutLengthMm: number;
  pierceCount: number;
  /** `null` when no `CutTableRow` matches this sheet's stock material/thickness. */
  cuttingTimeSec: number | null;
  weightKg: number | null;
  costEstimate: number | null;
}

export interface JobMetrics {
  sheets: SheetMetrics[];
  totalUtilisation: number;
  /** `null` if any sheet has no matching cut-table row. */
  totalCuttingTimeSec: number | null;
  /** `null` if any sheet's stock row has no cost. */
  totalCost: number | null;
}

const DEFAULT_REMNANT_MIN_HEIGHT = 50; // mm

function perimeter(points: Point[]): number {
  let total = 0;
  for (let i = 0; i < points.length; i++) {
    const a = points[i];
    const b = points[(i + 1) % points.length];
    total += Math.hypot(b.x - a.x, b.y - a.y);
  }
  return total;
}

function netArea(part: PartGeometry): number {
  const holesArea = part.holes.reduce((sum, h) => sum + area(h), 0);
  return Math.max(0, area(part.outer) - holesArea);
}

/** Exported for N-40 (the G-code writer): the same material/thickness match the cutting-time estimate uses, so feed rate and pierce time never disagree between the report and the emitted program. */
export function cutTableRowFor(stockRow: StockRow | undefined, cutTable: CutTableRow[]): CutTableRow | undefined {
  if (!stockRow?.material || stockRow.thickness === undefined) return undefined;
  // Case/whitespace-insensitive material match and a small thickness
  // tolerance — a user's stock row is free-typed text and a converted unit
  // ("3.175mm" from "1/8 in"), not guaranteed to hit a cut-table row exactly.
  const material = stockRow.material.trim().toLowerCase();
  return cutTable.find(
    (r) => r.material.trim().toLowerCase() === material && Math.abs(r.thickness - stockRow.thickness!) < 0.05,
  );
}

/** A rough, placement-order nearest-hop travel estimate — a stand-in until N-40's real toolpath ordering exists. */
function rapidLengthMm(placements: TrueNestPlacement[]): number {
  let total = 0;
  let cursor: Point = { x: 0, y: 0 };
  for (const p of placements) {
    total += Math.hypot(p.translation.x - cursor.x, p.translation.y - cursor.y);
    cursor = p.translation;
  }
  return total;
}

export function computeJobMetrics(
  result: TrueNestResult,
  parts: Map<string, PartGeometry>,
  stock: StockRow[],
  cutTable: CutTableRow[],
  opts: { remnantMinHeight?: number; margin?: number; gravity?: Gravity; cut?: ReadonlyMap<string, { cutLength: number; pierceCount: number }> } = {},
): JobMetrics {
  const remnantMinHeight = opts.remnantMinHeight ?? DEFAULT_REMNANT_MIN_HEIGHT;
  const margin = opts.margin ?? 0;
  const topGravity = (opts.gravity ?? "bottom-left").startsWith("top");

  const placementsBySheet = new Map<number, TrueNestPlacement[]>();
  for (const p of result.placed) {
    const list = placementsBySheet.get(p.sheet);
    if (list) list.push(p);
    else placementsBySheet.set(p.sheet, [p]);
  }

  const sheets: SheetMetrics[] = result.sheets.map((sheet, sheetIdx) => {
    const placements = placementsBySheet.get(sheetIdx) ?? [];
    const sheetArea = sheet.width * sheet.height;

    let netPartAreaTotal = 0;
    let cutLengthMm = 0;
    let pierceCount = 0;
    // Extent placement actually reached, on the side gravity fills from —
    // the remnant is whatever clean strip is left past that.
    let reach = topGravity ? sheet.height - margin : margin;

    for (const placement of placements) {
      const geo = parts.get(placement.partId);
      if (!geo) continue;
      netPartAreaTotal += netArea(geo);
      // RN-43: exact cut length / pierces from part extraction (true arc lengths) when given, so the panel KPIs and the report agree.
      const exact = opts.cut?.get(placement.partId);
      cutLengthMm += exact ? exact.cutLength : perimeter(geo.outer) + geo.holes.reduce((sum, h) => sum + perimeter(h), 0);
      pierceCount += exact ? exact.pierceCount : 1 + geo.holes.length;

      const box = bounds(localFrame(geo.outer, placement.rotationDeg, placement.mirrored));
      if (topGravity) {
        reach = Math.min(reach, placement.translation.y);
      } else {
        reach = Math.max(reach, placement.translation.y + (box.maxY - box.minY));
      }
    }

    const remnantHeight = topGravity ? reach - margin : sheet.height - margin - reach;
    const remnant =
      remnantHeight >= remnantMinHeight
        ? { width: sheet.width - margin * 2, height: remnantHeight, area: (sheet.width - margin * 2) * remnantHeight }
        : null;
    const trueScrapArea = Math.max(0, sheetArea - netPartAreaTotal - (remnant?.area ?? 0));

    const stockRow = stock[sheet.stockIndex];
    const cutRow = cutTableRowFor(stockRow, cutTable);
    const cuttingTimeSec = cutRow
      ? (cutLengthMm / cutRow.feedRateMmPerMin) * 60 +
        pierceCount * cutRow.pierceTimeSec +
        (rapidLengthMm(placements) / cutRow.rapidMmPerMin) * 60
      : null;
    const weightKg =
      cutRow?.densityKgPerM3 !== undefined && stockRow?.thickness !== undefined
        ? ((netPartAreaTotal * stockRow.thickness) / 1e9) * cutRow.densityKgPerM3
        : null;

    return {
      sheet: sheetIdx,
      sheetArea,
      netPartArea: netPartAreaTotal,
      utilisation: sheetArea > 0 ? netPartAreaTotal / sheetArea : 0,
      remnant,
      trueScrapArea,
      cutLengthMm,
      pierceCount,
      cuttingTimeSec,
      weightKg,
      costEstimate: stockRow?.cost ?? null,
    };
  });

  const totalNet = sheets.reduce((sum, m) => sum + m.netPartArea, 0);
  const totalSheetArea = sheets.reduce((sum, m) => sum + m.sheetArea, 0);
  const totalCuttingTimeSec =
    sheets.length > 0 && sheets.every((m) => m.cuttingTimeSec !== null)
      ? sheets.reduce((sum, m) => sum + (m.cuttingTimeSec ?? 0), 0)
      : null;
  const totalCost =
    sheets.length > 0 && sheets.every((m) => m.costEstimate !== null)
      ? sheets.reduce((sum, m) => sum + (m.costEstimate ?? 0), 0)
      : null;

  return {
    sheets,
    totalUtilisation: totalSheetArea > 0 ? totalNet / totalSheetArea : 0,
    totalCuttingTimeSec,
    totalCost,
  };
}
