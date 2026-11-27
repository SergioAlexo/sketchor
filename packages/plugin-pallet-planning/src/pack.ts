import {
  EPS, knownLoadedHeight, layerLimit, oriented, packingEdge, packingFootprint, unitId, type Footprint, type Layer, type PalletPlan,
  type PalletRules, type Placement, type PlannedPallet, type ProductRow, type Rotation,
  type UnplacedProduct,
} from "./types";
import { parsePalletInput } from "./validate";

interface ProductUnit {
  ids: string[];
  row: ProductRow;
}

interface Slot extends Footprint {
  xMm: number;
  yMm: number;
}

interface BaseOption extends Footprint {
  name?: string;
  source: "custom" | "standard";
}

interface Bin {
  option: BaseOption;
  slots: Slot[];
  placements: Placement[];
  lengthUsed: number;
  widthUsed: number;
}

interface Fit {
  slot: Slot;
  index: number;
  rotation: Rotation;
  footprint: Footprint;
  reserved: Footprint;
  waste: number;
}

const area = ({ lengthMm, widthMm }: Footprint) => lengthMm * widthMm;

function baseOptions(rules: PalletRules): BaseOption[] {
  const stock: BaseOption[] = rules.standardBases
    .filter(base => base.lengthMm <= rules.maxLengthMm + EPS && base.widthMm <= rules.maxWidthMm + EPS)
    .map(base => ({ ...base, source: "standard" }));
  stock.sort((a, b) => area(a) - area(b) || a.lengthMm - b.lengthMm || a.widthMm - b.widthMm);
  if (!rules.allowCustom) return stock;
  const roundDown = (n: number) => Math.floor((n + EPS) / rules.incrementMm) * rules.incrementMm;
  return [...stock, {
    lengthMm: roundDown(rules.maxLengthMm),
    widthMm: roundDown(rules.maxWidthMm),
    source: "custom",
  }];
}

function startBin(option: BaseOption, rules: PalletRules): Bin {
  // Reserve one gap on each footprint's far sides. The extra gap at the outer
  // boundary keeps the stock edge margin independent of the inter-product gap.
  const edge = packingEdge(rules);
  const slot = {
    xMm: edge,
    yMm: edge,
    lengthMm: option.lengthMm - 2 * edge + rules.gapMm,
    widthMm: option.widthMm - 2 * edge + rules.gapMm,
  };
  return { option, slots: [slot], placements: [], lengthUsed: 0, widthUsed: 0 };
}

function findFit(bin: Bin, row: ProductRow, gapMm: number, preferTurn = false): Fit | undefined {
  let best: Fit | undefined;
  const size = packingFootprint(row);
  const rotations: Rotation[] = row.canRotate && size.lengthMm !== size.widthMm
    ? (preferTurn ? [90, 0] : [0, 90]) : [0];
  for (const rotation of rotations) {
    const footprint = oriented(size, rotation);
    const reserved = { lengthMm: footprint.lengthMm + gapMm, widthMm: footprint.widthMm + gapMm };
    for (const [index, slot] of bin.slots.entries()) {
      if (reserved.lengthMm > slot.lengthMm + EPS || reserved.widthMm > slot.widthMm + EPS) continue;
      const waste = area(slot) - area(reserved);
      if (!best || waste < best.waste - EPS) best = { slot, index, rotation, footprint, reserved, waste };
    }
  }
  return best;
}

function put(bin: Bin, unit: ProductUnit, fit: Fit, splitAlongLength: boolean): void {
  const { slot, reserved } = fit;
  const right: Slot = {
    xMm: slot.xMm + reserved.lengthMm,
    yMm: slot.yMm,
    lengthMm: slot.lengthMm - reserved.lengthMm,
    widthMm: splitAlongLength ? slot.widthMm : reserved.widthMm,
  };
  const top: Slot = {
    xMm: slot.xMm,
    yMm: slot.yMm + reserved.widthMm,
    lengthMm: splitAlongLength ? reserved.lengthMm : slot.lengthMm,
    widthMm: slot.widthMm - reserved.widthMm,
  };
  bin.slots.splice(fit.index, 1, ...[right, top].filter(s => s.lengthMm > EPS && s.widthMm > EPS));
  recordPlacement(bin, unit, fit);
}

function recordPlacement(bin: Bin, unit: ProductUnit, { slot, footprint, rotation }: Fit): void {
  unit.ids.forEach((id, index) => bin.placements.push({
    id, rowId: unit.row.id, rotation, xMm: slot.xMm, yMm: slot.yMm,
    layer: (index + 1) as Layer,
  }));
  bin.lengthUsed = Math.max(bin.lengthUsed, slot.xMm + footprint.lengthMm);
  bin.widthUsed = Math.max(bin.widthUsed, slot.yMm + footprint.widthMm);
}

/** Subtract an occupied, clearance-inclusive footprint from every free rectangle. */
function freeSlotsAfter(slots: Slot[], occupied: Slot): Slot[] {
  const free = slots.flatMap(slot => {
    const endX = slot.xMm + slot.lengthMm;
    const endY = slot.yMm + slot.widthMm;
    const left = Math.max(slot.xMm, occupied.xMm);
    const bottom = Math.max(slot.yMm, occupied.yMm);
    const right = Math.min(endX, occupied.xMm + occupied.lengthMm);
    const top = Math.min(endY, occupied.yMm + occupied.widthMm);
    if (right <= left + EPS || top <= bottom + EPS) return [slot];
    return [
      { ...slot, lengthMm: left - slot.xMm },
      { ...slot, xMm: right, lengthMm: endX - right },
      { ...slot, widthMm: bottom - slot.yMm },
      { ...slot, yMm: top, widthMm: endY - top },
    ].filter(part => part.lengthMm > EPS && part.widthMm > EPS);
  });
  return free.filter((slot, index) => !free.some((other, j) => j !== index
    && other.xMm <= slot.xMm + EPS && other.yMm <= slot.yMm + EPS
    && other.xMm + other.lengthMm >= slot.xMm + slot.lengthMm - EPS
    && other.yMm + other.widthMm >= slot.yMm + slot.widthMm - EPS
    && (j < index || other.lengthMm > slot.lengthMm + EPS || other.widthMm > slot.widthMm + EPS)));
}

function palletBin(pallet: PlannedPallet, rules: PalletRules, rows: ReadonlyMap<string, ProductRow>): Bin {
  const bin = startBin({ ...pallet.base, source: "standard" }, rules);
  const gap = rules.gapMm;
  for (const item of pallet.placements) {
    if (item.layer !== 1) continue;
    const size = oriented(packingFootprint(rows.get(item.rowId)!), item.rotation);
    bin.slots = freeSlotsAfter(bin.slots, {
      xMm: item.xMm, yMm: item.yMm, lengthMm: size.lengthMm + gap, widthMm: size.widthMm + gap,
    });
  }
  return bin;
}

export function findStackPosition(
  pallet: PlannedPallet, size: Footprint, rules: PalletRules, rows: ReadonlyMap<string, ProductRow>,
  preferred?: Pick<Placement, "xMm" | "yMm">,
): Pick<Placement, "xMm" | "yMm"> {
  const { slots } = palletBin(pallet, rules, rows);
  const length = size.lengthMm + rules.gapMm;
  const width = size.widthMm + rules.gapMm;
  if (preferred && slots.some(slot =>
    preferred.xMm >= slot.xMm - EPS && preferred.yMm >= slot.yMm - EPS
    && preferred.xMm + length <= slot.xMm + slot.lengthMm + EPS
    && preferred.yMm + width <= slot.yMm + slot.widthMm + EPS
  )) return preferred;
  const slot = slots.find(slot => length <= slot.lengthMm + EPS && width <= slot.widthMm + EPS);
  if (!slot) throw new Error("This stack does not fit in the free space on the destination pallet.");
  return { xMm: slot.xMm, yMm: slot.yMm };
}

/** Place just the selected stacks in the free space of the existing pallet base. */
export function packSelectedStacks(
  pallet: PlannedPallet, units: readonly ProductUnit[], rules: PalletRules, rows: ReadonlyMap<string, ProductRow>,
): Placement[] {
  const initial = palletBin(pallet, rules, rows);
  const gap = rules.gapMm;
  const ordered = [...units].sort((a, b) => area(packingFootprint(b.row)) - area(packingFootprint(a.row)));
  const total = units.reduce((sum, unit) => sum + unit.ids.length, 0);
  for (const preferTurn of [false, true]) {
    const bin: Bin = { ...initial, placements: [] };
    for (const unit of ordered) {
      const fit = findFit(bin, unit.row, gap, preferTurn);
      if (!fit) break;
      bin.slots = freeSlotsAfter(bin.slots, { ...fit.slot, ...fit.reserved });
      recordPlacement(bin, unit, fit);
    }
    if (bin.placements.length === total) return bin.placements;
  }
  throw new Error("The selected stacks do not fit in the free space on this pallet.");
}

/** Round the occupied extent plus the final edge clearance to a custom base size. */
export function customBaseSize(lengthUsed: number, widthUsed: number, rules: PalletRules): Footprint {
  const edge = packingEdge(rules);
  const round = (mm: number) =>
    Math.max(1, Math.ceil((mm + edge - EPS) / rules.incrementMm)) * rules.incrementMm;
  return {
    lengthMm: round(lengthUsed),
    widthMm: round(widthUsed),
  };
}

function finishBase(bin: Bin, rules: PalletRules): Footprint {
  if (bin.option.source === "standard") {
    return { lengthMm: bin.option.lengthMm, widthMm: bin.option.widthMm };
  }
  return customBaseSize(bin.lengthUsed, bin.widthUsed, rules);
}

function trial(
  units: ProductUnit[], options: BaseOption[], rules: PalletRules, splitAlongLength: boolean,
  fitsEmpty: ReadonlyMap<string, ReadonlySet<BaseOption>>,
): { bins: Bin[]; unplaced: UnplacedProduct[] } {
  const bins: Bin[] = [];
  const unplaced: UnplacedProduct[] = [];
  const preferTurn = splitAlongLength;
  for (const [index, unit] of units.entries()) {
    let placed = false;
    for (const bin of bins) {
      const fit = findFit(bin, unit.row, rules.gapMm, preferTurn);
      if (!fit) continue;
      put(bin, unit, fit, splitAlongLength);
      placed = true;
      break;
    }
    if (placed) continue;
    const allowed = fitsEmpty.get(unit.row.id);
    const option = options.find(candidate => allowed?.has(candidate));
    const bin = option && startBin(option, rules);
    const fit = bin && findFit(bin, unit.row, rules.gapMm, preferTurn && index < units.length - 1);
    if (bin && fit) {
      bins.push(bin);
      put(bin, unit, fit, splitAlongLength);
    } else {
      for (const id of unit.ids) unplaced.push({ id, rowId: unit.row.id, reason: "size" });
    }
  }
  return { bins, unplaced };
}

function packJob(units: ProductUnit[], options: BaseOption[], rules: PalletRules) {
  const stock = options.filter(option => option.source === "standard");
  const custom = options.filter(option => option.source === "custom");
  const priorities = [options, ...stock.map(option => [option, ...options.filter(other => other !== option)])];
  if (stock.length && custom.length) priorities.push([...custom, ...stock]);
  const rows = new Map(units.map(unit => [unit.row.id, unit.row]));
  const fitsEmpty = new Map([...rows.values()].map(row => [
    row.id, new Set(options.filter(option => findFit(startBin(option, rules), row, rules.gapMm))),
  ]));
  const longestSide = (row: ProductRow) => {
    const size = packingFootprint(row);
    return Math.max(size.lengthMm, size.widthMm);
  };
  const orders = [
    [...units].sort((a, b) => area(packingFootprint(b.row)) - area(packingFootprint(a.row))),
    [...units].sort((a, b) => longestSide(b.row) - longestSide(a.row)),
  ];
  let best = trial(orders[0], options, rules, false, fitsEmpty);
  let bestArea = Infinity;
  let bestCustoms = Infinity;
  for (const order of orders) {
    for (const priority of priorities) {
      for (const splitAlongLength of [false, true]) {
        const result = trial(order, priority, rules, splitAlongLength, fitsEmpty);
        const totalArea = result.bins.reduce((sum, bin) => sum + area(finishBase(bin, rules)), 0);
        const customs = result.bins.filter(bin => bin.option.source === "custom").length;
        const comparison = result.unplaced.length - best.unplaced.length
          || result.bins.length - best.bins.length
          || (Math.abs(totalArea - bestArea) > EPS ? totalArea - bestArea : 0)
          || customs - bestCustoms;
        if (comparison >= 0) continue;
        best = result;
        bestArea = totalArea;
        bestCustoms = customs;
      }
    }
  }
  return best;
}

/** Keep all base positions and fill lower layers before using a higher one. */
function balanceLayers(placements: Placement[]): Placement[] {
  if (placements.every(item => item.layer === 1)) return placements;
  const byRow = new Map<string, Placement[]>();
  for (const item of placements) {
    const row = byRow.get(item.rowId) ?? [];
    row.push(item);
    byRow.set(item.rowId, row);
  }
  return [...byRow.values()].flatMap(items => {
    const bases = items.filter(item => item.layer === 1);
    return items.map(({ id }, index) => ({
      ...bases[index % bases.length], id, layer: (Math.floor(index / bases.length) + 1) as Layer,
    }));
  });
}

export function generatePalletPlan(
  input: unknown,
  version: Pick<PalletPlan, "id" | "revisionId" | "parentRevisionId">,
): PalletPlan {
  const { products, rules } = parsePalletInput(input);
  const rows = new Map(products.map(row => [row.id, row]));
  const groups = new Map<string, ProductUnit[]>();
  const unplaced: UnplacedProduct[] = [];
  for (const row of products) {
    const limit = layerLimit(row, rules);
    const ids = Array.from({ length: row.quantity }, (_, i) => unitId(row.id, i));
    if (limit === 0) {
      for (const id of ids) unplaced.push({ id, rowId: row.id, reason: "height" });
      continue;
    }
    const group = groups.get(row.jobId) ?? [];
    for (let i = 0; i < ids.length; i += limit) group.push({ ids: ids.slice(i, i + limit), row });
    groups.set(row.jobId, group);
  }
  const options = baseOptions(rules);
  const pallets: PlannedPallet[] = [];
  for (const [jobId, units] of groups) {
    const result = packJob(units, options, rules);
    result.bins.forEach((bin, index) => {
      const base = finishBase(bin, rules);
      const pallet: PlannedPallet = {
        id: `${version.id}/${units[0].row.id}/p${index + 1}`,
        jobId, base, loadedFootprint: { ...base },
        baseSource: bin.option.source, baseName: bin.option.name,
        placements: balanceLayers(bin.placements), truckOrientation: "auto",
      };
      pallet.packedHeightMm = knownLoadedHeight(pallet, rows, rules);
      pallets.push(pallet);
    });
    unplaced.push(...result.unplaced);
  }
  return {
    schemaVersion: 2, ...version, review: "draft", products, rules, pallets, unplaced,
    generation: { solver: "guillotine-layered-v2", revisionId: version.revisionId, ...structuredClone({ pallets, unplaced }) },
  };
}
