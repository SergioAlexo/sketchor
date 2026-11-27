import {
  EPS, packingFootprint, oriented, unitId, type LooseStack, type PalletPlan, type ProductRow,
} from "./types";
import { parsePalletInput, parsePalletPlan } from "./validate";

/** Preserve valid edits while adding a visible loose outline for each new unit. */
export function stagePalletProducts(
  raw: unknown, previous: PalletPlan | null,
  version: Pick<PalletPlan, "id" | "revisionId" | "parentRevisionId">,
): PalletPlan {
  const input = parsePalletInput(raw);
  const rows = new Map(input.products.map(row => [row.id, row]));
  const oldRows = new Map(previous?.products.map(row => [row.id, row]));
  const available = new Map(input.products.flatMap(row =>
    Array.from({ length: row.quantity }, (_, index) => [unitId(row.id, index), row] as const)));

  const sameProduct = (old: ProductRow, fresh: ProductRow) => {
    const a = packingFootprint(old);
    const b = packingFootprint(fresh);
    return old.jobId === fresh.jobId
      && Math.abs(a.lengthMm - b.lengthMm) <= EPS && Math.abs(a.widthMm - b.widthMm) <= EPS;
  };
  const pallets = previous?.pallets ?? [];
  for (const pallet of pallets) {
    for (const unit of pallet.placements) {
      const row = available.get(unit.id);
      if (!row || !sameProduct(oldRows.get(unit.rowId)!, row)) {
        throw new Error("Release the affected pallet before removing products or changing their dimensions.");
      }
      available.delete(unit.id);
    }
  }

  const looseStacks: LooseStack[] = [];
  for (const stack of previous?.looseStacks ?? []) {
    if (!stack.placements.every(unit => {
      const row = available.get(unit.id);
      return row && (stack.placements.length === 1 || sameProduct(oldRows.get(unit.rowId)!, row))
        && (unit.rotation === 0 || row.canRotate);
    })) continue;
    looseStacks.push(stack);
    for (const unit of stack.placements) available.delete(unit.id);
  }

  const gap = Math.max(75, input.rules.gapMm * 2);
  const occupiedRight = Math.max(0,
    ...pallets.map(p => (p.sceneOrigin?.x ?? 0) + p.base.lengthMm),
    ...looseStacks.map(({ origin, placements: [unit] }) =>
      origin.x + oriented(packingFootprint(rows.get(unit.rowId)!), unit.rotation).lengthMm),
  );
  const startX = occupiedRight > 0 ? occupiedRight + gap : 0;
  const widest = Math.max(0, ...Array.from(available.values(), row => packingFootprint(row).lengthMm));
  let x = startX;
  let y = 0;
  let rowHeight = 0;
  for (const [id, row] of available) {
    const size = packingFootprint(row);
    if (x > startX && x + size.lengthMm > startX + widest * 4 + gap * 3) {
      x = startX;
      y += rowHeight + gap;
      rowHeight = 0;
    }
    looseStacks.push({
      origin: { x, y },
      placements: [{ id, rowId: row.id, rotation: 0, layer: 1, xMm: 0, yMm: 0 }],
    });
    x += size.lengthMm + gap;
    rowHeight = Math.max(rowHeight, size.widthMm);
  }
  const unplaced = looseStacks.flatMap(stack => stack.placements.map(({ id, rowId }) => ({ id, rowId, reason: "manual" })));
  return parsePalletPlan({ ...input, ...version, schemaVersion: 2, review: "draft", pallets, unplaced, looseStacks });
}
