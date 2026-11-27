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

export function palletProductGap(product: PolylineEntity, entities: readonly Entity[]): number {
  const name = `Product padding ${product.name?.slice("Product ".length)}`;
  const outline = entities.find(entity => entity.type === "polyline" && entity.layer === "Pallet Plan — clearances"
    && entity.id.startsWith("pallet-plan-entity:") && entity.name === name);
  const reserved = outline && boundsOf([outline]);
  const actual = boundsOf([product]);
  if (!reserved || !actual) return 0;
  return Math.max(0, (reserved.maxX - reserved.minX) - (actual.maxX - actual.minX));
}

type Offset = { dx: number; dy: number };

/** Prefer facing product edges at the configured gap over ordinary vertex snaps. */
export function snapPalletGap(
  source: PolylineEntity, entities: readonly Entity[], raw: Offset, snapped: Offset, clearance: number, tolerance: number,
): Offset {
  const box = boundsOf([source]);
  if (!box || clearance <= 0) return snapped;
  const axes = {
    dx: { lower: -Infinity, upper: Infinity, nearest: 0, distance: Infinity },
    dy: { lower: -Infinity, upper: Infinity, nearest: 0, distance: Infinity },
  };
  for (const entity of entities) {
    if (entity.id === source.id || !isPalletProduct(entity)) continue;
    const target = boundsOf([entity]);
    if (!target) continue;
    const left = target.minX - (box.maxX + raw.dx);
    const right = box.minX + raw.dx - target.maxX;
    const below = target.minY - (box.maxY + raw.dy);
    const above = box.minY + raw.dy - target.maxY;
    const gapX = Math.max(left, right);
    const gapY = Math.max(below, above);
    const useX = gapX >= gapY;
    const gap = useX ? gapX : gapY;
    if (gap < -Math.min(tolerance, clearance / 4) || gap > clearance + tolerance) continue;

    const key = useX ? "dx" : "dy";
    const positive = useX ? right >= left : above >= below;
    const limit = raw[key] + (positive ? 1 : -1) * (clearance - gap);
    const axis = axes[key];
    if (positive) axis.lower = Math.max(axis.lower, limit);
    else axis.upper = Math.min(axis.upper, limit);
    const distance = Math.abs(limit - raw[key]);
    if (distance < axis.distance) {
      axis.nearest = limit;
      axis.distance = distance;
    }
  }
  const fit = (key: keyof Offset) => {
    const { lower, upper, nearest, distance } = axes[key];
    if (lower > upper || distance === Infinity) return snapped[key];
    return Math.max(lower, Math.min(nearest, upper));
  };
  return { dx: fit("dx"), dy: fit("dy") };
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
