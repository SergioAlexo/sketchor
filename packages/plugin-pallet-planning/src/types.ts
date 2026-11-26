import type { PalletOrientation } from "@sketchor/plugin-truck-nesting";

export const MAX_PRODUCTS = 1000;
export const MAX_STANDARD_BASES = 12;
export const EPS = 1e-6;
export const FORK_ENTRY_SIDE = "length";

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
    maxLayers: Exclude<Layer, 1>;
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
  productMarginMm?: number;
  gapMm: number;
  incrementMm: number;
  allowCustom: boolean;
  standardBases: StandardBase[];
  maxLayers: Layer;
  forkEntrySide: typeof FORK_ENTRY_SIDE;
  deckHeightMm?: number;
  maxLoadedHeightMm?: number;
}

export interface PalletInput {
  products: ProductRow[];
  rules: PalletRules;
}

export type Rotation = 0 | 90;
export type Layer = 1 | 2 | 3 | 4;

/** Lower-left corner of the turned footprint, in pallet-local millimetres. */
export interface Placement {
  id: string;
  rowId: string;
  xMm: number;
  yMm: number;
  rotation: Rotation;
  layer: Layer;
  supportId?: string;
  upsideDown?: boolean;
}

export interface PlannedPallet {
  id: string;
  jobId: string;
  base: Footprint;
  loadedFootprint: Footprint;
  /** Lower-left corner on the 2D drawing when a pallet was built there. */
  sceneOrigin?: { x: number; y: number };
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

/** Product origins are inset by the deck margin and the product's own padding. */
export function packingEdge(rules: PalletRules): number {
  return rules.edgeMm + (rules.productMarginMm ?? 0);
}

export function isUpsideDown(row: ProductRow, layer: Layer, override?: boolean): boolean {
  return override ?? (row.stack?.pattern === "alternate" && layer % 2 === 0);
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

export function supportsPlacement(below: Placement, above: Placement): boolean {
  return below.layer === above.layer - 1
    && (above.supportId === undefined ? sharesStack(below, above) : below.id === above.supportId);
}

/** Group aligned product units in loading order for a single top-down view. */
export function placementStacks(placements: readonly Placement[]): Placement[][] {
  const stacks: Placement[][] = [];
  for (const item of [...placements].sort((a, b) => a.layer - b.layer)) {
    const stack = item.layer > 1 ? stacks.find(items => {
      const below = items[items.length - 1];
      return supportsPlacement(below, item);
    }) : undefined;
    if (stack) stack.push(item);
    else stacks.push([item]);
  }
  return stacks;
}

export function knownLoadedHeight(
  pallet: PlannedPallet, rows: ReadonlyMap<string, ProductRow>, rules: PalletRules,
): number | undefined {
  if (pallet.placements.length === 0) return undefined;
  let tallest = 0;
  for (const stack of placementStacks(pallet.placements)) {
    let height = 0;
    for (const [index, item] of stack.entries()) {
      const row = rows.get(item.rowId)!;
      const below = stack[index - 1];
      const sameProduct = below?.rowId === item.rowId;
      const nested = sameProduct && (isUpsideDown(row, item.layer, item.upsideDown)
        || isUpsideDown(row, below.layer, below.upsideDown));
      const added = sameProduct ? row.stack?.addedHeightMm ?? (nested ? undefined : row.heightMm) : row.heightMm;
      if (added === undefined) return undefined;
      height += added;
    }
    tallest = Math.max(tallest, height);
  }
  return (rules.deckHeightMm ?? 0) + tallest;
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
  forkEntrySide: FORK_ENTRY_SIDE,
};

export const DEFAULT_PALLET_RULES: PalletRules = {
  ...REFERENCE_RULES,
  edgeMm: 0.5 * 25.4,
  productMarginMm: 25.4,
  gapMm: 2 * 25.4,
};
