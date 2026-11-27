import { PdfBuilder, pdfTextWidth } from "@sketchor/core";
import {
  isUpsideDown, oriented, packingFootprint, placementStacks,
  type PalletPlan, type Placement,
} from "@sketchor/plugin-pallet-planning";

const MARGIN = 36;
const INK = "#162231";

function wrapText(text: string, width: number, size: number, bold: boolean): string[] {
  const lines: string[] = [];
  let remaining = text.replace(/\s+/g, " ");
  while (remaining) {
    let end = remaining.length;
    while (end > 1 && pdfTextWidth(remaining.slice(0, end), size, bold) > width) end -= 1;
    const space = remaining.lastIndexOf(" ", end);
    if (end < remaining.length && space > 0) end = space;
    lines.push(remaining.slice(0, end));
    remaining = remaining.slice(end).trimStart();
  }
  return lines;
}

export function buildPalletReportPdf(plan: PalletPlan, unit: "in" | "mm"): Uint8Array {
  const pdf = new PdfBuilder();
  const right = pdf.width - MARGIN;
  const pageWidth = right - MARGIN;
  const products = new Map(plan.products.map(row => [row.id, row]));
  const display = (mm: number) => Number((mm / (unit === "in" ? 25.4 : 1)).toFixed(3));
  const unitLabel = ({ rowId, id }: Pick<Placement, "rowId" | "id">) =>
    `${products.get(rowId)!.productId} #${id.split("/").at(-1)}`;
  const dimensions = (length: number, width: number) => `${display(length)} x ${display(width)} ${unit}`;
  const heightLabel = plan.rules.deckHeightMm ? "Loaded height" : "Stack height";
  const title = "Pallet loading report";
  const placedCount = plan.pallets.reduce((sum, pallet) => sum + pallet.placements.length, 0);
  const overview = `${plan.review === "confirmed" ? "Confirmed" : "Draft"} | ${plan.pallets.length} pallets | ${placedCount} placed | ${plan.unplaced.length} unplaced`;
  let y = MARGIN;

  function line(text: string, size = 10, bold = false) {
    for (const textLine of wrapText(text, pageWidth, size, bold)) {
      pdf.text(MARGIN, y, textLine, { size, bold, color: INK });
      y += size + 5;
    }
  }

  function page(heading?: string) {
    if (y !== MARGIN) pdf.addPage();
    y = MARGIN + 12;
    line(title, 16, true);
    line(overview);
    line(`Revision ${plan.revisionId}`, 8);
    y += 12;
    if (heading) line(heading, 13, true);
  }

  for (const [index, pallet] of plan.pallets.entries()) {
    const heading = `Pallet ${index + 1} | Job ${pallet.jobId}`;
    page(heading);
    const { lengthMm, widthMm } = pallet.base;
    const height = pallet.packedHeightMm === undefined ? "" : ` | ${heightLabel} ${display(pallet.packedHeightMm)} ${unit}`;
    line(`Base ${dimensions(lengthMm, widthMm)} | ${pallet.placements.length} units${height}`);
    const padding = plan.rules.productMarginMm ?? 0;
    const inset = plan.rules.edgeMm;
    line(`Deck inset ${display(inset)} ${unit} | Product padding ${display(padding)} ${unit} per side | Fork entry: ${plan.rules.forkEntrySide}`, 9);
    if (pallet.tag) line(`Handling: ${pallet.tag}`, 9);
    y += 9;

    const scale = Math.min(pageWidth / lengthMm, 226 / widthMm);
    const rectangle = (x: number, bottom: number, width: number, height: number) =>
      [MARGIN + x * scale, y + (widthMm - bottom - height) * scale, width * scale, height * scale] as const;
    pdf.rect(...rectangle(0, 0, lengthMm, widthMm), { stroke: INK });
    if (inset > 0 && Math.min(lengthMm, widthMm) > 2 * inset) {
      pdf.rect(...rectangle(inset, inset, lengthMm - 2 * inset, widthMm - 2 * inset), { stroke: "#637184", dash: [2, 2] });
    }
    const locations = new Map<string, { stack: number; below?: Placement }>();
    for (const [stackIndex, stack] of placementStacks(pallet.placements).entries()) {
      for (const [layerIndex, item] of stack.entries()) {
        locations.set(item.id, { stack: stackIndex + 1, below: stack[layerIndex - 1] });
      }
      const base = stack[0];
      const footprint = oriented(packingFootprint(products.get(base.rowId)!), base.rotation);
      const { xMm, yMm } = base;
      const { lengthMm: width, widthMm: depth } = footprint;
      if (padding > 0) {
        pdf.rect(...rectangle(xMm - padding, yMm - padding, width + 2 * padding, depth + 2 * padding),
          { stroke: "#2873a9", dash: [2, 2] });
      }
      const [x, top, w, h] = rectangle(xMm, yMm, width, depth);
      pdf.rect(x, top, w, h, { stroke: "#416d86", fill: "#dcecf5" });
      const label = String(stackIndex + 1);
      if (h >= 8 && w >= pdfTextWidth(label, 8, true) + 2) {
        pdf.text(x + w / 2, top + h / 2 + 3, label, { size: 8, bold: true, align: "center", color: INK });
      }
    }
    y += widthMm * scale + 16;
    line("Stack numbers match the diagram. Load from layer 1 upwards.", 9);
    line("X and Y are measured from the lower-left corner of the deck.", 9);
    y += 5;

    const columns = [MARGIN, MARGIN + 36, MARGIN + 186, MARGIN + 225, MARGIN + 345, MARGIN + 441];
    const drawRow = (cells: string[][], bold = false) => {
      for (const [i, cell] of cells.entries()) {
        cell.forEach((textLine, lineIndex) => {
          pdf.text(columns[i], y + 11 * lineIndex, textLine, { size: 9, bold, color: INK });
        });
      }
      y += 4 + 11 * (Math.max(...cells.map(cell => cell.length)) - 1);
      pdf.line({ x: MARGIN, y }, { x: right, y }, { stroke: "#c5d0db", width: 0.5 });
      y += 12;
    };
    const header = () => drawRow(["Stack", "Product unit", "Layer", "Orientation / rotation", `X / Y (${unit})`, "Directly below"].map(label => [label]), true);
    header();
    for (const item of [...pallet.placements].sort((a, b) => a.layer - b.layer)) {
      const row = products.get(item.rowId)!;
      const { stack, below } = locations.get(item.id)!;
      const orientation = isUpsideDown(row, item.layer, item.upsideDown) ? "Upside down" : "Upright";
      const values = [String(stack), unitLabel(item), String(item.layer), `${orientation} / ${item.rotation}°`,
        `${display(item.xMm)} / ${display(item.yMm)}`, below ? unitLabel(below) : "Deck"];
      const cells = values.map((value, i) => wrapText(value, (columns[i + 1] ?? right) - columns[i] - 5, 9, false));
      if (y + 11 * Math.max(...cells.map(cell => cell.length)) > pdf.height - MARGIN) {
        page(heading);
        header();
      }
      drawRow(cells);
    }
  }
  if (plan.unplaced.length > 0 || plan.pallets.length === 0) {
    page("Unplaced products");
    for (const item of plan.unplaced) {
      if (y > pdf.height - MARGIN) page("Unplaced products");
      const reason = { height: "Exceeds the loaded height limit", size: "No base fits under the configured limits", manual: "Unplaced by operator" }[item.reason];
      line(`Job ${products.get(item.rowId)!.jobId} | ${unitLabel(item)} | ${reason}`);
    }
  }
  return pdf.bytes();
}
