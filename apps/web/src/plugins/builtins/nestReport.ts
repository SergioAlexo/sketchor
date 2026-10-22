import { drawEntitiesToPdf, entitiesToSvgDocument, PdfBuilder, PDF_LETTER, type Entity } from "@sketchor/core";
import { text } from "@sketchor/plugin-sdk";
import { NEST_LABELS_LAYER, sheetOutlineEntities, type JobMetrics, type TrueNestResult, type TrueNestSheet } from "@sketchor/plugin-nest";

/**
 * The nest job report (N-30) — a cover summary, one page per sheet (drawing
 * + part table) and a parts ordered-vs-placed summary, as HTML (for
 * `ui.print`'s in-page preview) and PDF (the autosaved copy) built from one
 * shared data spine (`reportSpine`) so the two can't disagree — same
 * discipline as `truckNestingPlugin.ts`'s `sheetContent`/`buildPrintHtml`/
 * `buildPrintPdf`.
 */

export interface LastNestPlacement {
  sheet: number;
  /** 1-based, matches the on-drawing label. */
  number: number;
  /** Index into `TrueNestResult.placed` this came from (N-40: a stable id for G-code toolpath ordering, independent of any entries skipped here for missing geometry). */
  id: string;
  /** Another placement's `id` this one nests inside (N-12's allowInHoles) — the G-code writer cuts it first. */
  insideOfId?: string;
  /** materializeInstance() output, sheet-local (unshifted) coordinates. */
  outerEntities: Entity[];
  holeEntities: Entity[];
  label: { at: { x: number; y: number }; height: number };
  partId: string;
  name: string;
  rotationDeg: number;
  mirrored: boolean;
  /** Net area (outer − holes), mm². */
  area: number;
}

export interface LastNest {
  sheets: TrueNestSheet[];
  sheetLabels: string[];
  placements: LastNestPlacement[];
  metrics: JobMetrics;
  result: TrueNestResult;
  /** Every working-set part that had quantity > 0 when nested, for ordered-vs-placed. */
  ordered: { key: string; name: string; quantity: number }[];
  unit: { perMm: number; label: string };
  /** RN-42: a credit / footer line printed at the end of the report. */
  footer?: string;
  /** RN-42: job-level KPIs, stock usage and group names, already formatted by the caller. */
  summary?: {
    kpis: { sheets: number; toPurchase: number; showPurchase?: boolean; utilisation: number; placed: number; required: number; cutLengthMm: number; pierces: number; unplaced: number };
    stock: { name: string; size: string; used: number; purchased: number; available: number | null }[];
    groups: string[];
  };
}

function placementsOn(lastNest: LastNest, sheetIdx: number): LastNestPlacement[] {
  return lastNest.placements.filter((p) => p.sheet === sheetIdx);
}

/** A sheet's full drawing — outline, title, every placed part's real geometry and number label — built from the same `sheetOutlineEntities` the canvas layout uses, so the report page can't drift from what's on screen. */
function sheetDrawingEntities(lastNest: LastNest, sheetIdx: number): Entity[] {
  const { outline, title } = sheetOutlineEntities(lastNest.sheets[sheetIdx], lastNest.sheetLabels[sheetIdx]);
  const entities: Entity[] = [outline, title];
  for (const p of placementsOn(lastNest, sheetIdx)) {
    entities.push(...p.outerEntities, ...p.holeEntities);
    entities.push(text(p.label.at, String(p.number), { layer: NEST_LABELS_LAYER, height: p.label.height }));
  }
  return entities;
}

const toU = (mm: number, perMm: number): number => Math.round(mm * perMm * 100) / 100;

function fmtTime(sec: number | null): string {
  return sec == null ? "—" : `${Math.round(sec / 6) / 10} min (est.)`;
}

function fmtRemnant(remnant: { width: number; height: number } | null, unit: LastNest["unit"]): string {
  if (!remnant) return "none";
  return `${Math.round(toU(remnant.width, unit.perMm))}×${Math.round(toU(remnant.height, unit.perMm))} ${unit.label}`;
}

function fmtArea(mm2: number, unit: LastNest["unit"]): string {
  return `${Math.round(toU(mm2, unit.perMm * unit.perMm))} ${unit.label}²`;
}

interface ReportSpine {
  totalPlaced: number;
  totalUnplaced: number;
  sheetRows: {
    label: string;
    utilisation: number;
    remnant: { width: number; height: number } | null;
    cuttingTimeSec: number | null;
    weightKg: number | null;
    cost: number | null;
  }[];
  orderedRows: { name: string; ordered: number; placed: number; unplaced: number }[];
}

function reportSpine(lastNest: LastNest): ReportSpine {
  const { metrics, result, sheets, sheetLabels, ordered } = lastNest;
  const sheetRows = sheets.map((_sheet, i) => {
    const m = metrics.sheets[i];
    return {
      label: sheetLabels[i],
      utilisation: m.utilisation,
      remnant: m.remnant,
      cuttingTimeSec: m.cuttingTimeSec,
      weightKg: m.weightKg,
      cost: m.costEstimate,
    };
  });
  const orderedRows = ordered.map((o) => ({
    name: o.name,
    ordered: o.quantity,
    placed: result.placed.filter((p) => p.partId === o.key).length,
    unplaced: result.unplaced.find((u) => u.partId === o.key)?.count ?? 0,
  }));
  return {
    totalPlaced: result.placed.length,
    totalUnplaced: result.unplaced.reduce((n, u) => n + u.count, 0),
    sheetRows,
    orderedRows,
  };
}

/**
 * RN-42: the job-level block of the report - KPIs, stock usage, group names -
 * as plain strings shared by the HTML and PDF so the two cannot disagree.
 * Empty when the caller gave no summary (the older nest panel).
 */
export function reportSummaryLines(lastNest: LastNest): { kpis: [string, string][]; stock: string[]; groups: string } {
  const s = lastNest.summary;
  if (!s) return { kpis: [], stock: [], groups: "" };
  const k = s.kpis;
  const buy = k.showPurchase !== false; // only stock-on-hand mode buys sheets
  const kpis: [string, string][] = [
    [buy ? "Sheets" : "Sheets used", String(k.sheets)],
    ...(buy ? ([["To purchase", String(k.toPurchase)]] as [string, string][]) : []),
    ["Utilisation", `${Math.round(k.utilisation * 1000) / 10}%`],
    ["Parts placed", `${k.placed} of ${k.required}`],
    ["Cut length", `${Math.round(toU(k.cutLengthMm, lastNest.unit.perMm))} ${lastNest.unit.label}`],
    ["Pierces", String(k.pierces)],
  ];
  const stock = s.stock.map((r) => `${r.size}: ${r.used} used${buy ? `, ${r.purchased} to purchase` : ""}${r.available === null ? "" : `, ${r.available} in stock`}`);
  return { kpis, stock, groups: s.groups.join("; ") };
}

const esc = (s: string): string => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

export function buildNestReportHtml(lastNest: LastNest): string {
  const { metrics, unit } = lastNest;
  const { totalPlaced, totalUnplaced, sheetRows, orderedRows } = reportSpine(lastNest);
  const extra = reportSummaryLines(lastNest);
  const extraHtml = extra.kpis.length
    ? `<table><tbody><tr>${extra.kpis.map(([l]) => `<th>${esc(l)}</th>`).join("")}</tr><tr>${extra.kpis.map(([, v]) => `<td>${esc(v)}</td>`).join("")}</tr></tbody></table>` +
      (extra.stock.length ? `<h2>Stock usage</h2><ul>${extra.stock.map((l) => `<li>${esc(l)}</li>`).join("")}</ul>` : "") +
      (extra.groups ? `<p>Groups: ${esc(extra.groups)}</p>` : "")
    : "";

  const coverRows = sheetRows
    .map(
      (r) =>
        `<tr><td>${esc(r.label)}</td><td>${Math.round(r.utilisation * 100)}%</td><td>${esc(fmtRemnant(r.remnant, unit))}</td>` +
        `<td>${fmtTime(r.cuttingTimeSec)}</td><td>${r.weightKg != null ? r.weightKg.toFixed(2) + " kg" : "—"}</td>` +
        `<td>${r.cost != null ? r.cost.toFixed(2) : "—"}</td></tr>`,
    )
    .join("");

  const sheetsHtml = lastNest.sheets
    .map((_sheet, i) => {
      const entities = sheetDrawingEntities(lastNest, i);
      const svg = entitiesToSvgDocument(entities, { strokeColor: "#111111", unit: "none" }).replace(/<\?xml[^>]*\?>\s*/, "");
      const rows = placementsOn(lastNest, i)
        .map(
          (p) =>
            `<tr><td>${p.number}</td><td>${esc(p.name)}</td><td>${p.rotationDeg}°${p.mirrored ? " (mirrored)" : ""}</td><td>${esc(fmtArea(p.area, unit))}</td></tr>`,
        )
        .join("");
      return (
        `<div class="sheet-page"><h2>${esc(lastNest.sheetLabels[i])}</h2>${svg}` +
        `<table><thead><tr><th>#</th><th>Part</th><th>Rotation</th><th>Area</th></tr></thead><tbody>${rows}</tbody></table></div>`
      );
    })
    .join("");

  const summaryRows = orderedRows
    .map((r) => `<tr><td>${esc(r.name)}</td><td>${r.ordered}</td><td>${r.placed}</td><td>${r.unplaced}</td></tr>`)
    .join("");

  return `<style>
    .nest-report { font: 13px system-ui, -apple-system, sans-serif; color: #111111; }
    .nest-report table { border-collapse: collapse; width: 100%; margin: 8px 0 16px; }
    .nest-report th, .nest-report td { border: 1px solid #cccccc; padding: 4px 8px; text-align: left; font-size: 12px; }
    .nest-report th { background: #f0f0f0; }
    .nest-report .sheet-page { page-break-before: always; margin-top: 16px; }
    .nest-report svg { max-width: 100%; height: auto; border: 1px solid #dddddd; }
  </style>
  <div class="nest-report">
    <h1>Sheet Metal Nest Report</h1>
    <p>${totalPlaced} part(s) placed on ${lastNest.sheets.length} sheet(s)${totalUnplaced ? `, ${totalUnplaced} didn't fit` : ""}. Overall utilisation ${Math.round(metrics.totalUtilisation * 100)}%.</p>
    ${extraHtml}
    <table><thead><tr><th>Sheet</th><th>Utilisation</th><th>Reusable remnant</th><th>Cutting time</th><th>Weight</th><th>Cost</th></tr></thead><tbody>${coverRows}</tbody></table>
    ${sheetsHtml}
    <h2>Parts ordered vs. placed</h2>
    <table><thead><tr><th>Part</th><th>Ordered</th><th>Placed</th><th>Unplaced</th></tr></thead><tbody>${summaryRows}</tbody></table>
    ${lastNest.footer ? `<p style="margin-top:16px;font-size:11px;color:#666666">${esc(lastNest.footer)}</p>` : ""}
  </div>`;
}

export function buildNestReportPdf(lastNest: LastNest): Uint8Array {
  const { metrics, unit } = lastNest;
  const { totalPlaced, totalUnplaced, sheetRows, orderedRows } = reportSpine(lastNest);

  const pdf = new PdfBuilder(PDF_LETTER);
  const margin = 36;
  const right = pdf.width - margin;
  const bottom = pdf.height - margin;
  let y = margin + 12;

  // The one page-break primitive PdfBuilder has none of — every caller
  // writes its own, same as truckNestingPlugin.ts's buildPrintPdf.
  const need = (space: number, afterBreak?: () => void) => {
    if (y + space <= bottom) return;
    pdf.addPage();
    y = margin + 12;
    afterBreak?.();
  };

  pdf.text(margin, y, "Sheet Metal Nest Report", { size: 16, bold: true });
  y += 20;
  pdf.text(
    margin,
    y,
    `${totalPlaced} part(s) placed on ${lastNest.sheets.length} sheet(s)${totalUnplaced ? `, ${totalUnplaced} didn't fit` : ""}. Overall utilisation ${Math.round(metrics.totalUtilisation * 100)}%.`,
    { size: 10 },
  );
  y += 18;
  const extra = reportSummaryLines(lastNest);
  if (extra.kpis.length > 0) {
    pdf.text(margin, y, extra.kpis.map(([l, v]) => `${l}: ${v}`).join("   "), { size: 9, bold: true });
    y += 14;
    for (const line of extra.stock) {
      need(14);
      pdf.text(margin, y, `Stock - ${line}`, { size: 9 });
      y += 12;
    }
    if (extra.groups) {
      pdf.text(margin, y, `Groups: ${extra.groups}`, { size: 9 });
      y += 12;
    }
  }
  y += 8;

  const coverCols = [margin, margin + 150, margin + 250, margin + 340, margin + 420, margin + 480];
  const coverHeader = () => {
    const labels = ["Sheet", "Utilisation", "Remnant", "Cut time", "Weight", "Cost"];
    labels.forEach((l, i) => pdf.text(coverCols[i], y, l, { size: 9, bold: true }));
    y += 6;
    pdf.line({ x: margin, y }, { x: right, y }, { stroke: "#999999", width: 0.5 });
    y += 10;
  };
  coverHeader();
  for (const r of sheetRows) {
    need(14, coverHeader);
    pdf.text(coverCols[0], y, r.label, { size: 9 });
    pdf.text(coverCols[1], y, `${Math.round(r.utilisation * 100)}%`, { size: 9 });
    pdf.text(coverCols[2], y, fmtRemnant(r.remnant, unit), { size: 9 });
    pdf.text(coverCols[3], y, fmtTime(r.cuttingTimeSec), { size: 9 });
    pdf.text(coverCols[4], y, r.weightKg != null ? `${r.weightKg.toFixed(2)} kg` : "—", { size: 9 });
    pdf.text(coverCols[5], y, r.cost != null ? r.cost.toFixed(2) : "—", { size: 9 });
    y += 14;
  }

  for (let i = 0; i < lastNest.sheets.length; i++) {
    pdf.addPage();
    y = margin + 12;
    pdf.text(margin, y, lastNest.sheetLabels[i], { size: 13, bold: true });
    y += 16;

    const entities = sheetDrawingEntities(lastNest, i);
    const drawHeight = Math.min(pdf.height * 0.42, bottom - y - 100);
    if (drawHeight > 40 && entities.length > 0) {
      drawEntitiesToPdf(pdf, entities, { x: margin, y, width: right - margin, height: drawHeight }, { strokeColor: "#111111", strokeWidth: 0.4 });
      y += drawHeight + 14;
    }

    const partCols = [margin, margin + 30, margin + 220, margin + 340];
    const partHeader = () => {
      const labels = ["#", "Part", "Rotation", "Area"];
      labels.forEach((l, idx) => pdf.text(partCols[idx], y, l, { size: 9, bold: true }));
      y += 6;
      pdf.line({ x: margin, y }, { x: right, y }, { stroke: "#999999", width: 0.5 });
      y += 10;
    };
    partHeader();
    for (const p of placementsOn(lastNest, i)) {
      need(14, partHeader);
      pdf.text(partCols[0], y, String(p.number), { size: 9 });
      pdf.text(partCols[1], y, p.name, { size: 9 });
      pdf.text(partCols[2], y, `${p.rotationDeg}°${p.mirrored ? " (mirrored)" : ""}`, { size: 9 });
      pdf.text(partCols[3], y, fmtArea(p.area, unit), { size: 9 });
      y += 14;
    }
  }

  pdf.addPage();
  y = margin + 12;
  pdf.text(margin, y, "Parts ordered vs. placed", { size: 13, bold: true });
  y += 20;
  const sumCols = [margin, margin + 220, margin + 320, margin + 420];
  const sumHeader = () => {
    const labels = ["Part", "Ordered", "Placed", "Unplaced"];
    labels.forEach((l, idx) => pdf.text(sumCols[idx], y, l, { size: 9, bold: true }));
    y += 6;
    pdf.line({ x: margin, y }, { x: right, y }, { stroke: "#999999", width: 0.5 });
    y += 10;
  };
  sumHeader();
  for (const r of orderedRows) {
    need(14, sumHeader);
    pdf.text(sumCols[0], y, r.name, { size: 9 });
    pdf.text(sumCols[1], y, String(r.ordered), { size: 9 });
    pdf.text(sumCols[2], y, String(r.placed), { size: 9, color: r.placed < r.ordered ? "#c0392b" : undefined });
    pdf.text(sumCols[3], y, String(r.unplaced), { size: 9, color: r.unplaced > 0 ? "#c0392b" : undefined });
    y += 14;
  }

  if (lastNest.footer) {
    need(24);
    y += 10;
    pdf.text(margin, y, lastNest.footer, { size: 8, color: "#666666" });
  }

  return pdf.bytes();
}
