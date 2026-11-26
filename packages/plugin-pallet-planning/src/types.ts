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
}

export interface PalletInput {
  products: ProductRow[];
  rules: PalletRules;
}

export type Rotation = 0 | 90;

/** Lower-left corner of the turned footprint, in pallet-local millimetres. */
export interface Placement {
  id: string;
  rowId: string;
  xMm: number;
  yMm: number;
  rotation: Rotation;
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
  reason: "size" | "manual";
}

export interface PalletPlan extends PalletInput {
  schemaVersion: 1;
  id: string;
  revisionId: string;
  parentRevisionId: string | null;
  review: "draft" | "confirmed";
  pallets: PlannedPallet[];
  unplaced: UnplacedProduct[];
}

export function unitId(rowId: string, index: number): string {
  return `${rowId}/${index + 1}`;
}

export function oriented(size: Footprint, rotation: Rotation): Footprint {
  return rotation === 90
    ? { lengthMm: size.widthMm, widthMm: size.lengthMm }
    : { lengthMm: size.lengthMm, widthMm: size.widthMm };
}

export const REFERENCE_RULES: PalletRules = {
  maxLengthMm: 120 * 25.4,
  maxWidthMm: 96 * 25.4,
  edgeMm: 25.4,
  gapMm: 25.4,
  incrementMm: 25.4,
  allowCustom: true,
  standardBases: [],
};
