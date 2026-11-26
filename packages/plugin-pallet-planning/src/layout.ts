import { add, polyline, text, type Command, type DisplayUnitInfo } from "@sketchor/plugin-sdk";
import { isUpsideDown, oriented, packingFootprint, type Footprint, type Layer, type PalletPlan } from "./types";

export const PALLET_PLAN_LAYER = "Pallet Plan";
export const PALLET_GUIDE_LAYER = "Pallet Plan — clearances";
export const PRODUCT_COLORS = ["#3f88aa", "#be8154", "#6e9b72", "#8e77ae", "#b99b51", "#b76e83"];

const rect = (x: number, y: number, { lengthMm, widthMm }: Footprint) =>
  [{ x, y }, { x: x + lengthMm, y }, { x: x + lengthMm, y: y + widthMm }, { x, y: y + widthMm }];

/** Make a drawing snapshot in a new tab. The panel retains the editable plan. */
export function buildPalletDrawing(plan: PalletPlan, unit: DisplayUnitInfo): Command[] {
  const commands: Command[] = [];
  const rows = new Map(plan.products.map((row, index) => [row.id, { row, color: PRODUCT_COLORS[index % PRODUCT_COLORS.length] }]));
  const value = (mm: number) => Number((mm * unit.perMm).toFixed(3));
  const views = plan.pallets.flatMap((pallet, index) => {
    const layers = [...new Set(pallet.placements.map(item => item.layer))].sort((a, b) => a - b);
    const visible: Layer[] = layers.length ? layers : [1];
    return visible.map(layer => ({ pallet, number: index + 1, layer, stacked: visible.length > 1 }));
  });
  const columns = Math.max(1, Math.ceil(Math.sqrt(views.length)));
  let x = 0;
  let y = 0;
  let rowHeight = 0;
  for (const [index, { pallet, number, layer: level, stacked }] of views.entries()) {
    const layer = PALLET_PLAN_LAYER;
    const base = pallet.base;
    const size = `${value(base.lengthMm)} × ${value(base.widthMm)} ${unit.label}`;
    const labelHeight = Math.max(10, Math.min(base.lengthMm, base.widthMm) * 0.07);
    const caption = `P${number} · ${pallet.jobId} · ${stacked ? `Layer ${level} · ` : ""}${size}`;
    const outline = polyline(rect(x, y, base), true, { layer, name: `Pallet ${pallet.id}` });
    const title = text({ x, y: y - labelHeight * 1.5 }, caption, { layer, height: labelHeight });
    const edges = [outline.id, title.id];
    commands.push(add(outline), add(title));
    const edge = plan.rules.edgeMm;
    if (edge > 0 && base.lengthMm > 2 * edge && base.widthMm > 2 * edge) {
      const inside = { lengthMm: base.lengthMm - 2 * edge, widthMm: base.widthMm - 2 * edge };
      const guide = polyline(rect(x + edge, y + edge, inside), true, {
        layer: PALLET_GUIDE_LAYER, linetype: "DASHED", construction: true, name: `Clearance ${pallet.id}`,
      });
      commands.push(add(guide));
      edges.push(guide.id);
    }
    commands.push({ type: "group-entities", groupId: `pallet-plan:${pallet.id}:${level}`, ids: edges, name: caption });
    for (const placement of pallet.placements) {
      if (placement.layer !== level) continue;
      const entry = rows.get(placement.rowId);
      if (!entry) throw new Error("A product is missing from the plan.");
      const footprint = oriented(packingFootprint(entry.row), placement.rotation);
      const px = x + placement.xMm;
      const py = y + placement.yMm;
      const box = polyline(rect(px, py, footprint), true, {
        layer, color: entry.color, fill: entry.color, name: `Product ${placement.id}`,
      });
      const unitNumber = stacked ? ` #${placement.id.split("/").at(-1)}` : "";
      const label = entry.row.productId + unitNumber + (isUpsideDown(entry.row, level) ? " ↓" : "");
      const height = Math.min(footprint.widthMm * 0.35, footprint.lengthMm * 1.25 / label.length);
      const tag = text({ x: px + footprint.lengthMm * 0.06, y: py + (footprint.widthMm - height) / 2 },
        label, { layer, color: "#101820", height });
      commands.push(add(box), add(tag), {
        type: "group-entities", groupId: `pallet-plan:${plan.id}:${placement.id}`, ids: [box.id, tag.id], name: label,
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
