import { EPS, sharesStack, type PalletPlan, type Placement, type PlannedPallet } from "./types";
import { footprint, labelText, parsePalletPlan, parsePlacement, record, truckOrientation } from "./validate";

function findPallet(plan: PalletPlan, value: unknown): PlannedPallet {
  const pallet = plan.pallets.find(p => p.id === value);
  if (!pallet) throw new Error("Select a pallet first.");
  return pallet;
}

function detachUnit(plan: PalletPlan, id: unknown): Pick<Placement, "id" | "rowId"> {
  for (const pallet of plan.pallets) {
    const index = pallet.placements.findIndex(p => p.id === id);
    if (index >= 0) return pallet.placements.splice(index, 1)[0];
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
      pallet.placements.push(parsePlacement({
        ...unit, xMm: action.xMm, yMm: action.yMm, rotation: action.rotation, layer: action.layer,
      }));
      break;
    }
    case "move-stack": {
      const pallet = findPallet(next, action.palletId);
      const selected = pallet.placements.find(item => item.id === action.unitId);
      if (!selected) throw new Error("Select a product unit first.");
      pallet.placements = pallet.placements.map(item => sharesStack(item, selected)
        ? parsePlacement({ ...item, xMm: action.xMm, yMm: action.yMm }) : item);
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
      if (base.lengthMm <= base.widthMm + EPS) throw new Error("Pallet length must be greater than its width.");
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
