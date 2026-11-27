import type { Order } from "@sketchor/plugin-truck-nesting";
import { parsePalletPlan } from "./validate";

export type PalletStop = Omit<Order, "pallets">;

/** Map in dispatch load order. Each job needs exactly one explicit stop mapping. */
export function toTruckOrders(rawPlan: unknown, stops: readonly PalletStop[]): Order[] {
  const plan = parsePalletPlan(rawPlan);
  if (plan.review !== "confirmed") throw new Error("Confirm the pallet plan before preparing truck orders.");
  const ids = new Set<string>();
  const byJob = new Map<string, Order>();
  const orders: Order[] = [];
  for (const stop of stops) {
    if (!stop.id || !stop.jobNumber || ids.has(stop.id) || byJob.has(stop.jobNumber)) {
      throw new Error("Truck stops need unique IDs and one mapping per job.");
    }
    const order: Order = { ...stop, pallets: [] };
    orders.push(order);
    byJob.set(stop.jobNumber, order);
    ids.add(stop.id);
  }
  for (const pallet of plan.pallets) {
    const order = byJob.get(pallet.jobId);
    if (!order) throw new Error(`Assign job ${pallet.jobId} to a truck stop first.`);
    order.pallets.push({
      id: pallet.id,
      name: pallet.baseName || pallet.id,
      length: pallet.loadedFootprint.lengthMm,
      width: pallet.loadedFootprint.widthMm,
      qty: 1,
      shape: "rect",
      tag: pallet.tag ?? "Fork entry on the length side",
      orientation: pallet.truckOrientation,
    });
  }
  return orders.filter(order => order.pallets.length);
}
