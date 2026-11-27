import { boundsOf, type Entity, type EntityId, type PolylineEntity } from "@sketchor/core";

function isPalletOutline(entity: Entity | undefined): entity is PolylineEntity {
  return entity?.type === "polyline" && entity.layer === "Pallet Plan"
    && entity.id.startsWith("pallet-plan-entity:");
}

export function isPalletProduct(entity: Entity | undefined): entity is PolylineEntity {
  return isPalletOutline(entity) && Boolean(entity.name?.startsWith("Product "));
}

export function isPalletDeck(entity: Entity | undefined): entity is PolylineEntity {
  return isPalletOutline(entity) && Boolean(entity.name?.startsWith("Pallet "));
}

/** Use the moved rectangle's centre so merely touching edges stays a move. */
export function palletSupportAt(
  source: PolylineEntity, entities: readonly Entity[], dx: number, dy: number,
): EntityId | undefined {
  const sourceBox = boundsOf([source]);
  if (!sourceBox) return undefined;
  const x = (sourceBox.minX + sourceBox.maxX) / 2 + dx;
  const y = (sourceBox.minY + sourceBox.maxY) / 2 + dy;
  let best: { id: EntityId; distance: number } | undefined;
  for (const entity of entities) {
    if (entity.id === source.id || !isPalletProduct(entity)) continue;
    const box = boundsOf([entity]);
    if (!box) continue;
    const insetX = (box.maxX - box.minX) * 0.1;
    const insetY = (box.maxY - box.minY) * 0.1;
    if (x < box.minX + insetX || x > box.maxX - insetX || y < box.minY + insetY || y > box.maxY - insetY) continue;
    const distance = Math.hypot(x - (box.minX + box.maxX) / 2, y - (box.minY + box.maxY) / 2);
    if (!best || distance < best.distance) best = { id: entity.id, distance };
  }
  return best?.id;
}
