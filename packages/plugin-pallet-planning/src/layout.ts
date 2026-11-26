import { add, polyline, text, type Command, type DisplayUnitInfo, type DocumentReadModel, type Entity } from "@sketchor/plugin-sdk";
import { oriented, packingFootprint, placementStacks, type Footprint, type PalletPlan } from "./types";

export const PALLET_PLAN_LAYER = "Pallet Plan";
export const PALLET_GUIDE_LAYER = "Pallet Plan — clearances";
export const PRODUCT_COLORS = ["#3f88aa", "#be8154", "#6e9b72", "#8e77ae", "#b99b51", "#b76e83"];
const ENTITY_PREFIX = "pallet-plan-entity:";
const GROUP_PREFIX = "pallet-plan:";

const owned = <T extends Entity>(entity: T): T => ({ ...entity, id: ENTITY_PREFIX + entity.id });

export function clearPalletDrawing(model: DocumentReadModel): Command[] {
  const groups = model.groups.filter(group => group.id.startsWith(GROUP_PREFIX));
  const oldMembers = new Set(groups.flatMap(group => group.members));
  const ids = model.entities.filter(entity => entity.id.startsWith(ENTITY_PREFIX)
    || (oldMembers.has(entity.id) && (entity.layer === PALLET_PLAN_LAYER || entity.layer === PALLET_GUIDE_LAYER)))
    .map(entity => entity.id);
  const commands: Command[] = groups.map(group => ({ type: "ungroup", groupId: group.id }));
  if (ids.length) commands.push({ type: "delete-entities", ids });
  return commands;
}

const rect = (x: number, y: number, { lengthMm, widthMm }: Footprint) =>
  [{ x, y }, { x: x + lengthMm, y }, { x: x + lengthMm, y: y + widthMm }, { x, y: y + widthMm }];

/** Draw the current plan as ordinary Sketchor geometry. */
export function buildPalletDrawing(plan: PalletPlan, unit: DisplayUnitInfo): Command[] {
  const commands: Command[] = [];
  const rows = new Map(plan.products.map((row, index) => [row.id, { row, color: PRODUCT_COLORS[index % PRODUCT_COLORS.length] }]));
  const value = (mm: number) => Number((mm * unit.perMm).toFixed(3));
  const columns = Math.max(1, Math.ceil(Math.sqrt(plan.pallets.length)));
  let x = 0;
  let y = 0;
  let rowHeight = 0;
  for (const [index, pallet] of plan.pallets.entries()) {
    const layer = PALLET_PLAN_LAYER;
    const base = pallet.base;
    const size = `${value(base.lengthMm)} × ${value(base.widthMm)} ${unit.label}`;
    const labelHeight = Math.max(10, Math.min(base.lengthMm, base.widthMm) * 0.07);
    const caption = `P${index + 1} · ${pallet.jobId} · ${size}`;
    const outline = owned(polyline(rect(x, y, base), true, { layer, name: `Pallet ${pallet.id}` }));
    const title = owned(text({ x, y: y - labelHeight * 1.5 }, caption, { layer, height: labelHeight }));
    const edges = [outline.id, title.id];
    commands.push(add(outline), add(title));
    const edge = plan.rules.edgeMm;
    if (edge > 0 && base.lengthMm > 2 * edge && base.widthMm > 2 * edge) {
      const inside = { lengthMm: base.lengthMm - 2 * edge, widthMm: base.widthMm - 2 * edge };
      const guide = owned(polyline(rect(x + edge, y + edge, inside), true, {
        layer: PALLET_GUIDE_LAYER, linetype: "DASHED", construction: true, name: `Clearance ${pallet.id}`,
      }));
      commands.push(add(guide));
      edges.push(guide.id);
    }
    commands.push({ type: "group-entities", groupId: GROUP_PREFIX + pallet.id, ids: edges, name: caption });
    const stacks = placementStacks(pallet.placements);
    const stacked = stacks.some(stack => stack.length > 1);
    for (const stack of stacks) {
      const [placement] = stack;
      const entry = rows.get(placement.rowId);
      if (!entry) throw new Error("A product is missing from the plan.");
      const footprint = oriented(packingFootprint(entry.row), placement.rotation);
      const px = x + placement.xMm;
      const py = y + placement.yMm;
      const box = owned(polyline(rect(px, py, footprint), true, {
        layer, color: entry.color, fill: entry.color, name: `Product ${placement.id}`,
      }));
      const ids = [box.id];
      commands.push(add(box));
      const padding = plan.rules.productMarginMm ?? 0;
      if (padding > 0) {
        const padded = { lengthMm: footprint.lengthMm + 2 * padding, widthMm: footprint.widthMm + 2 * padding };
        const guide = owned(polyline(rect(px - padding, py - padding, padded), true, {
          layer: PALLET_GUIDE_LAYER, color: entry.color, linetype: "DASHED", construction: true,
          name: `Product padding ${placement.id}`,
        }));
        commands.push(add(guide));
        ids.push(guide.id);
      }
      const label = stacked
        ? stack.map(item => `${entry.row.productId} #${item.id.split("/").at(-1)}`).join(" / ")
        : entry.row.productId;
      const height = Math.min(footprint.widthMm * 0.35, footprint.lengthMm * 1.25 / label.length);
      const tag = owned(text({ x: px + footprint.lengthMm * 0.06, y: py + (footprint.widthMm - height) / 2 },
        label, { layer, color: "#101820", height }));
      commands.push(add(tag), {
        type: "group-entities", groupId: `${GROUP_PREFIX}${plan.id}:${placement.id}`, ids: [...ids, tag.id], name: label,
      });
    }
    x += Math.max(base.lengthMm, caption.length * labelHeight * 0.56) + 150;
    rowHeight = Math.max(rowHeight, base.widthMm + labelHeight * 2);
    if ((index + 1) % columns === 0) {
      x = 0;
      y += rowHeight + 150;
      rowHeight = 0;
    }
  }
  return commands;
}
