import { EPS, oriented, packingFootprint, placementStacks, type Footprint, type PalletPlan, type Placement, type PlannedPallet } from "./types";
import { footprint, labelText, parsePalletPlan, parsePlacement, record, truckOrientation } from "./validate";

function findPallet(plan: PalletPlan, value: unknown): PlannedPallet {
  const pallet = plan.pallets.find(p => p.id === value);
  if (!pallet) throw new Error("Select a pallet first.");
  return pallet;
}

function detachUnit(plan: PalletPlan, id: unknown): Pick<Placement, "id" | "rowId"> {
  for (const pallet of plan.pallets) {
    const index = pallet.placements.findIndex(p => p.id === id);
    if (index >= 0) {
      pallet.packedHeightMm = undefined;
      return pallet.placements.splice(index, 1)[0];
    }
  }
  const index = plan.unplaced.findIndex(p => p.id === id);
  if (index < 0) throw new Error("Select a product unit first.");
  return plan.unplaced.splice(index, 1)[0];
}

/** Edits are atomic. Invalid changes leave the prior revision untouched. */
export function editPalletPlan(plan: PalletPlan, raw: unknown, revisionId: string): PalletPlan {
  const action = record(raw, "Pallet edit");
  const next = structuredClone(plan);
  next.parentRevisionId = plan.revisionId;
  next.revisionId = revisionId;
  next.review = "draft";
  switch (action.type) {
    case "place": {
      const pallet = findPallet(next, action.palletId);
      const unit = detachUnit(next, action.unitId);
      pallet.packedHeightMm = undefined;
      pallet.placements.push(parsePlacement({
        ...unit, xMm: action.xMm, yMm: action.yMm, rotation: action.rotation, layer: action.layer,
      }));
      break;
    }
    case "move-stack": {
      const pallet = findPallet(next, action.palletId);
      const stack = placementStacks(pallet.placements).find(items => items.some(item => item.id === action.unitId));
      if (!stack) throw new Error("Select a product unit first.");
      const origin = stack.find(item => item.id === action.unitId)!;
      const target = parsePlacement({ ...origin, xMm: action.xMm, yMm: action.yMm });
      const moving = new Set(stack);
      pallet.placements = pallet.placements.map(item => moving.has(item)
        ? parsePlacement({
          ...item, xMm: target.xMm + (item.xMm - origin.xMm), yMm: target.yMm + (item.yMm - origin.yMm),
        }) : item);
      break;
    }
    case "assemble-stack": {
      const pallet = findPallet(next, action.palletId);
      if (!Array.isArray(action.units) || action.units.length < 1 || action.units.length > next.rules.maxLayers) {
        throw new Error(`Choose 1 to ${next.rules.maxLayers} units in loading order.`);
      }
      pallet.packedHeightMm = undefined;
      const rows = new Map(next.products.map(row => [row.id, row]));
      const used = new Set<string>();
      let previous: (Placement & Footprint) | undefined;
      for (const [index, rawUnit] of action.units.entries()) {
        const entry = record(rawUnit, "Stack unit");
        const unitId = labelText(entry.unitId, "Product unit ID", 256);
        if (used.has(unitId)) throw new Error("Choose a different product unit for each layer.");
        used.add(unitId);
        const unit = detachUnit(next, unitId);
        const row = rows.get(unit.rowId)!;
        const item = parsePlacement({
          ...unit, rotation: entry.rotation, upsideDown: entry.upsideDown, layer: index + 1,
          supportId: previous?.id, xMm: action.xMm, yMm: action.yMm,
        });
        const size = oriented(packingFootprint(row), item.rotation);
        if (previous) {
          if (size.lengthMm > previous.lengthMm + EPS || size.widthMm > previous.widthMm + EPS) {
            throw new Error(`${row.productId} on layer ${item.layer} overhangs the product below.`);
          }
          item.xMm = previous.xMm + (previous.lengthMm - size.lengthMm) / 2;
          item.yMm = previous.yMm + (previous.widthMm - size.widthMm) / 2;
        }
        pallet.placements.push(item);
        previous = { ...item, ...size };
      }
      break;
    }
    case "unplace": {
      const { id, rowId } = detachUnit(next, action.unitId);
      next.unplaced.push({ id, rowId, reason: "manual" });
      break;
    }
    case "resize": {
      const pallet = findPallet(next, action.palletId);
      const size = footprint(action.base, "Pallet base");
      Object.assign(pallet, { base: size, loadedFootprint: { ...size }, baseSource: "manual", baseName: undefined });
      break;
    }
    case "handling": {
      const pallet = findPallet(next, action.palletId);
      pallet.truckOrientation = truckOrientation(action.truckOrientation);
      pallet.tag = action.tag === "" ? undefined : labelText(action.tag, "Handling tag");
      break;
    }
    case "add-pallet": {
      const base = footprint(action.base, "Pallet base");
      next.pallets.push({
        id: `${plan.id}/manual/${revisionId}`,
        jobId: labelText(action.jobId, "Pallet job"),
        base, loadedFootprint: { ...base }, baseSource: "manual",
        placements: [], truckOrientation: "auto",
      });
      break;
    }
    case "remove-pallet": {
      const pallet = findPallet(next, action.palletId);
      if (pallet.placements.length) throw new Error("Move or unplace the products before removing their pallet.");
      next.pallets = next.pallets.filter(p => p !== pallet);
      break;
    }
    case "confirm":
      next.review = "confirmed";
      break;
    default:
      throw new Error("Unknown pallet edit.");
  }
  return parsePalletPlan(next);
}
