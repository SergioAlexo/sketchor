import type { PalletOrientation } from "@sketchor/plugin-truck-nesting";

export const MAX_PRODUCTS = 1000;
export const MAX_STANDARD_BASES = 12;
export const EPS = 1e-6;

export interface Footprint {
  lengthMm: number;
  widthMm: number;
}

export interface ProductRow extends Footprint {
  id: string;
  jobId: string;
  productId: string;
  quantity: number;
  canRotate: boolean;
  measuredLengthMm?: number;
  measuredWidthMm?: number;
  stack?: {
    maxLayers: 2 | 3;
    pattern: "upright" | "alternate";
    addedHeightMm?: number;
  };
  heightMm?: number;
  weightKg?: number;
  notes?: string;
  sourceRowId?: string;
  sourceUnit?: string;
}

export interface StandardBase extends Footprint {
  name: string;
}

export interface PalletRules {
  maxLengthMm: number;
  maxWidthMm: number;
  edgeMm: number;
  gapMm: number;
  incrementMm: number;
  allowCustom: boolean;
  standardBases: StandardBase[];
  maxLayers: Layer;
  deckHeightMm?: number;
  maxLoadedHeightMm?: number;
}

export interface PalletInput {
  products: ProductRow[];
  rules: PalletRules;
}

export type Rotation = 0 | 90;
export type Layer = 1 | 2 | 3;

/** Lower-left corner of the turned footprint, in pallet-local millimetres. */
export interface Placement {
  id: string;
  rowId: string;
  xMm: number;
  yMm: number;
  rotation: Rotation;
  layer: Layer;
}

export interface PlannedPallet {
  id: string;
  jobId: string;
  base: Footprint;
  loadedFootprint: Footprint;
  baseSource: "standard" | "custom" | "manual";
  baseName?: string;
  placements: Placement[];
  truckOrientation: PalletOrientation;
  tag?: string;
  packedHeightMm?: number;
  grossWeightKg?: number;
}

export interface UnplacedProduct {
  id: string;
  rowId: string;
  reason: "size" | "height" | "manual";
}

export interface PalletResult {
  pallets: PlannedPallet[];
  unplaced: UnplacedProduct[];
}

export interface PalletPlan extends PalletInput, PalletResult {
  schemaVersion: 2;
  id: string;
  revisionId: string;
  parentRevisionId: string | null;
  review: "draft" | "confirmed";
  generation?: PalletResult & { solver: string; revisionId: string };
}

export function unitId(rowId: string, index: number): string {
  return `${rowId}/${index + 1}`;
}

export function oriented(size: Footprint, rotation: Rotation): Footprint {
  return rotation === 90
    ? { lengthMm: size.widthMm, widthMm: size.lengthMm }
    : { lengthMm: size.lengthMm, widthMm: size.widthMm };
}

/** Use the larger verified bound on each axis when measured dimensions are available. */
export function packingFootprint(row: ProductRow): Footprint {
  return {
    lengthMm: Math.max(row.lengthMm, row.measuredLengthMm ?? 0),
    widthMm: Math.max(row.widthMm, row.measuredWidthMm ?? 0),
  };
}

export function isUpsideDown(row: ProductRow, layer: Layer): boolean {
  return row.stack?.pattern === "alternate" && layer === 2;
}

export function stackHeight(row: ProductRow, layer: Layer): number | undefined {
  if (row.heightMm === undefined || layer === 1) return row.heightMm;
  const increment = row.stack?.addedHeightMm ?? (row.stack?.pattern === "alternate" ? undefined : row.heightMm);
  return increment === undefined ? undefined : row.heightMm + (layer - 1) * increment;
}

export function layerLimit(row: ProductRow, rules: PalletRules): number {
  const limit = Math.min(row.stack?.maxLayers ?? 1, rules.maxLayers);
  if (rules.maxLoadedHeightMm === undefined) return limit;
  const usable = rules.maxLoadedHeightMm - (rules.deckHeightMm ?? 0);
  for (let layer = limit; layer > 0; layer -= 1) {
    if ((stackHeight(row, layer as Layer) ?? Infinity) <= usable + EPS) return layer;
  }
  return 0;
}

export function sharesStack(a: Placement, b: Placement): boolean {
  return a.rowId === b.rowId && a.rotation === b.rotation
    && Math.abs(a.xMm - b.xMm) <= EPS && Math.abs(a.yMm - b.yMm) <= EPS;
}

export function knownLoadedHeight(
  pallet: PlannedPallet, rows: ReadonlyMap<string, ProductRow>, rules: PalletRules,
): number | undefined {
  if (rules.deckHeightMm === undefined || pallet.placements.length === 0) return undefined;
  const heights = pallet.placements.map(item => stackHeight(rows.get(item.rowId)!, item.layer));
  if (heights.some(height => height === undefined)) return undefined;
  return rules.deckHeightMm + Math.max(...heights as number[]);
}

export const REFERENCE_RULES: PalletRules = {
  maxLengthMm: 120 * 25.4,
  maxWidthMm: 96 * 25.4,
  edgeMm: 25.4,
  gapMm: 25.4,
  incrementMm: 25.4,
  allowCustom: true,
  standardBases: [],
  maxLayers: 3,
};
