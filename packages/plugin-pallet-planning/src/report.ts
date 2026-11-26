import {
  isUpsideDown, layerLimit, oriented, packingEdge, packingFootprint, sharesStack, unitId, type PalletPlan,
  type PalletResult, type Placement, type PlannedPallet, type ProductRow,
} from "./types";

type Assignment = { pallet: PlannedPallet; placement: Placement; supportId?: string; number: number };

function indexAssignments(layout: PalletResult) {
  const byUnit = new Map<string, Assignment>();
  const unplaced = new Map(layout.unplaced.map(item => [item.id, item.reason]));
  layout.pallets.forEach((pallet, index) => {
    for (const placement of pallet.placements) {
      const support = placement.layer > 1 && pallet.placements.find(
        candidate => candidate.layer === placement.layer - 1 && sharesStack(candidate, placement),
      );
      byUnit.set(placement.id, { pallet, placement, number: index + 1, supportId: support ? support.id : undefined });
    }
  });
  return { byUnit, unplaced };
}

const assignmentColumns = [
  "pallet_id", "pallet_number", "base_length_mm", "base_width_mm", "loaded_height_mm",
  "layer", "upside_down", "support_unit_id", "x_mm", "y_mm", "rotation_deg", "unplaced_reason",
];

function assignmentValues(input: ReturnType<typeof indexAssignments> | undefined, row: ProductRow, id: string) {
  if (!input) return assignmentColumns.map(() => undefined);
  const assignment = input.byUnit.get(id);
  if (!assignment) return [...assignmentColumns.slice(1).map(() => undefined), input.unplaced.get(id)];
  const { pallet, placement, supportId, number } = assignment;
  return [
    pallet.id, number, pallet.base.lengthMm, pallet.base.widthMm, pallet.packedHeightMm,
    placement.layer, isUpsideDown(row, placement.layer) ? "true" : "false", supportId,
    placement.xMm, placement.yMm, placement.rotation, undefined,
  ];
}

function csvCell(value: string | number | undefined): string {
  if (value === undefined) return "";
  if (typeof value === "number") return String(value);
  // Keep user-entered labels inert when the CSV is opened in a spreadsheet.
  const text = /^[\s]*[=+\-@]|^[\t\r\n]/u.test(value) ? "'" + value : value;
  return '"' + text.replaceAll('"', '""') + '"';
}

export function buildPalletReportCsv(plan: PalletPlan): string {
  const final = indexAssignments(plan);
  const generated = plan.generation && indexAssignments(plan.generation);
  const fields = [
    "report_version", "plan_id", "revision_id", "generated_revision_id", "solver", "review",
    "job_number", "product_row_id", "source_row_id", "product_id", "requested_quantity", "unit_id",
    "product_length_mm", "product_width_mm", "packing_length_mm", "packing_width_mm", "product_height_mm", "unit_weight_kg",
    "stack_pattern", "allowed_layers", "added_layer_height_mm", "max_base_length_mm", "max_base_width_mm",
    "max_loaded_height_mm", "deck_height_mm", "pallet_edge_inset_mm", "product_padding_mm",
    "edge_clearance_mm", "product_gap_mm", "custom_increment_mm", "fork_entry_side",
    "changed_since_generation",
    ...assignmentColumns.map(field => "generated_" + field),
    ...assignmentColumns.map(field => "final_" + field),
  ];
  const rows = [fields.join(",")];
  const rules = plan.rules;
  for (const row of plan.products) {
    const packed = packingFootprint(row);
    for (let i = 0; i < row.quantity; i += 1) {
      const id = unitId(row.id, i);
      const before = assignmentValues(generated, row, id);
      const after = assignmentValues(final, row, id);
      const changed = generated && before.some((value, index) => index !== 1 && value !== after[index]);
      rows.push([
        1, plan.id, plan.revisionId, plan.generation?.revisionId, plan.generation?.solver, plan.review,
        row.jobId, row.id, row.sourceRowId, row.productId, row.quantity, id,
        row.lengthMm, row.widthMm, packed.lengthMm, packed.widthMm, row.heightMm, row.weightKg,
        row.stack?.pattern, layerLimit(row, rules),
        row.stack?.addedHeightMm, rules.maxLengthMm, rules.maxWidthMm, rules.maxLoadedHeightMm, rules.deckHeightMm,
        rules.edgeMm, rules.productMarginMm, packingEdge(rules), rules.gapMm, rules.incrementMm, rules.forkEntrySide,
        changed === undefined ? undefined : String(changed), ...before, ...after,
      ].map(csvCell).join(","));
    }
  }
  return rows.join("\r\n") + "\r\n";
}

const escape = (value: string | number) => String(value).replace(/[&<>"']/g, char => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
})[char]!);

/** Standalone loading sheet. Geometry and order match the saved plan revision. */
export function buildPalletReportHtml(plan: PalletPlan, unit: "mm" | "in"): string {
  const indexed = indexAssignments(plan);
  const inset = plan.rules.edgeMm;
  const padding = plan.rules.productMarginMm ?? 0;
  const heightLabel = plan.rules.deckHeightMm ? "Loaded height" : "Stack height";
  const products = new Map(plan.products.map(row => [row.id, row]));
  const display = (mm: number) => Number((mm / (unit === "in" ? 25.4 : 1)).toFixed(3));
  const size = (length: number, width: number) => `${display(length)} × ${display(width)} ${unit}`;
  const dims = (mm: number | undefined) => mm === undefined ? "—" : `${display(mm)} ${unit}`;
  const unitNumber = (id: string) => escape(id.split("/").at(-1) ?? id);
  const palletSections = plan.pallets.map((pallet, index) => {
    const boxStyle = (x: number, y: number, length: number, width: number) =>
      `left:${100 * x / pallet.base.lengthMm}%;bottom:${100 * y / pallet.base.widthMm}%;`
      + `width:${100 * length / pallet.base.lengthMm}%;height:${100 * width / pallet.base.widthMm}%`;
    const layers = [...new Set(pallet.placements.map(item => item.layer))].sort((a, b) => a - b);
    const layerSections = layers.map(layer => {
      const items = pallet.placements.filter(item => item.layer === layer);
      const outlines: string[] = [];
      const rows: string[] = [];
      if (inset > 0 && Math.min(pallet.base.lengthMm, pallet.base.widthMm) > 2 * inset) {
        const style = boxStyle(inset, inset, pallet.base.lengthMm - 2 * inset, pallet.base.widthMm - 2 * inset);
        outlines.push(`<span class="guide" style="${style}"></span>`);
      }
      for (const item of items) {
        const product = products.get(item.rowId)!;
        const rotated = oriented(packingFootprint(product), item.rotation);
        const flipped = isUpsideDown(product, item.layer);
        const label = `${escape(product.productId)} #${unitNumber(item.id)}`;
        const support = indexed.byUnit.get(item.id)?.supportId;
        const style = boxStyle(item.xMm, item.yMm, rotated.lengthMm, rotated.widthMm);
        if (padding > 0) {
          const boundary = boxStyle(item.xMm - padding, item.yMm - padding, rotated.lengthMm + 2 * padding, rotated.widthMm + 2 * padding);
          outlines.push(`<span class="guide padding" style="${boundary}"></span>`);
        }
        outlines.push(`<span class="piece${flipped ? " inverted" : ""}" style="${style}">${label}${flipped ? " ↓" : ""}</span>`);
        rows.push(`<tr><td>${label}</td><td>${flipped ? "Upside down" : "Upright"}</td><td>${item.rotation}°</td>
<td>${display(item.xMm)} / ${display(item.yMm)}</td><td>${support ? `${escape(product.productId)} #${unitNumber(support)}` : "Deck"}</td></tr>`);
      }
      const ratio = pallet.base.lengthMm / pallet.base.widthMm;
      return `<section class="layer"><h3>Layer ${layer} · ${items.length} ${items.length === 1 ? "product" : "products"}</h3>
<div class="diagram" style="aspect-ratio:${ratio};max-width:${Math.min(520, 280 * ratio)}px">${outlines.join("")}</div>
<table><thead><tr><th>Product unit</th><th>Position</th><th>Rotation</th><th>X / Y (${unit})</th><th>Directly below</th></tr></thead>
<tbody>${rows.join("")}</tbody></table></section>`;
    });
    return `<section><h2>Pallet ${index + 1} · Job ${escape(pallet.jobId)}</h2>
<p>Base ${size(pallet.base.lengthMm, pallet.base.widthMm)} · ${heightLabel} ${dims(pallet.packedHeightMm)} · ${pallet.placements.length} units</p>
${pallet.tag ? `<p>Handling ${escape(pallet.tag)}</p>` : ""}${layerSections.join("")}</section>`;
  });
  const unplaced = plan.unplaced.map(item => {
    const product = products.get(item.rowId)!;
    return `<li>Job ${escape(product.jobId)} · ${escape(product.productId)} #${unitNumber(item.id)} · ${{
      height: "Exceeds the loaded height limit", size: "No base fits under the configured limits", manual: "Unplaced by operator",
    }[item.reason]}</li>`;
  });
  return `<!doctype html><html lang="en"><meta charset="utf-8"><title>Pallet loading report</title>
<style>
body{font:14px/1.45 system-ui,sans-serif;color:#162231;max-width:850px;margin:24px auto;padding:0 18px}
h1,h2,h3{margin:18px 0 6px}p{margin:4px 0 10px}.layer{margin:12px 0 22px}
.diagram{position:relative;width:100%;border:1px solid #415161;margin:8px 0}
.guide{position:absolute;box-sizing:border-box;border:1px dashed #637184}.padding{border-color:#2873a9}
.piece{position:absolute;box-sizing:border-box;border:1px solid #416d86;background:#dcecf5;display:grid;place-items:center;overflow:hidden;font-size:11px;text-align:center}
.inverted{background:#f7e6cc}table{width:100%;border-collapse:collapse;text-align:left}
td,th{border-bottom:1px solid #c5d0db;padding:4px 6px}thead{display:table-header-group}
@media print{body{margin:0;color:#000}.diagram{break-inside:avoid}h2,h3{break-after:avoid}.piece{print-color-adjust:exact}}
</style><body><h1>Pallet loading report</h1>
<p>${plan.review === "confirmed" ? "Confirmed" : "Draft"} · Revision ${escape(plan.revisionId)}
 · ${plan.pallets.length} ${plan.pallets.length === 1 ? "pallet" : "pallets"} · ${indexed.byUnit.size} placed · ${plan.unplaced.length} unplaced</p>
<p>Maximum base ${size(plan.rules.maxLengthMm, plan.rules.maxWidthMm)} · Maximum ${heightLabel.toLowerCase()} ${dims(plan.rules.maxLoadedHeightMm)}
 · Pallet inset ${dims(inset)} · Product padding ${dims(plan.rules.productMarginMm)} per side
 · Between products ${dims(plan.rules.gapMm)} · Up to ${plan.rules.maxLayers} layers</p>
<p>Fork entry is on the pallet's ${plan.rules.forkEntrySide} side. Load from layer 1 upwards. X and Y are measured from the lower-left deck corner.
${plan.products.some(row => row.stack) ? "Verify the configured stack pattern and support before loading." : ""}</p>
${palletSections.join("")}${unplaced.length ? `<h2>Unplaced products</h2><ul>${unplaced.join("")}</ul>` : ""}</body></html>`;
}
