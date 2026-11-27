import { drawEntitiesToPdf, PdfBuilder, PDF_LETTER, type Entity } from "@sketchor/core";
import { add, polyline, text, type Command } from "@sketchor/plugin-sdk";
import type { BarDrawing, CalcResult } from "@sketchor/plugin-nest";

/**
 * NT-05: the Bars / Tubes result drawn to scale - on a canvas tab and in the
 * printed report. Each bar pattern is the stock seen from the side (length
 * along x, the profile depth up), every piece as cut (a mitred piece is a
 * trapezoid, a turned one is drawn turned), the end trim and the drop shaded
 * by hatch-free outlines so it prints on any printer. One drawing per
 * pattern with "CUT xN" when several bars are cut the same way.
 */

export const BAR_LAYER = "Bar Cutting";

/** Drawn depth of a bar whose profile has no mitre depth (square-cut bars): a strip readable next to its length. */
const stripDepth = (d: BarDrawing) => (d.depth > 0 ? d.depth : Math.max(25, Math.min(80, d.stock * 0.012)));

/**
 * One bar pattern's entities with the bar's lower-left at (0, y). With
 * `tall`, the strip is drawn at least 1/28 of the bar's length high (the
 * printed page: a 2 in tube on a 20 ft bar is otherwise a hairline); the
 * slants keep their true run along the bar.
 */
export function barPatternEntities(d: BarDrawing, y: number, title: string, dropText: string, tall = false): Entity[] {
  const H = tall ? Math.max(stripDepth(d), d.stock / 28) : stripDepth(d);
  const out: Entity[] = [];
  const o = { layer: BAR_LAYER };
  const rect = (x0: number, x1: number) => polyline([{ x: x0, y }, { x: x1, y }, { x: x1, y: y + H }, { x: x0, y: y + H }], true, o);
  out.push(rect(0, d.stock));
  const th = Math.max(6, Math.min(Math.max(H * 0.45, d.stock * 0.008), 80));
  out.push(text({ x: 0, y: y + H + th * 0.6 }, title, { ...o, height: th }));
  if (d.trim > 0) out.push(rect(0, d.trim));
  for (const p of d.pieces) {
    const l1 = d.depth > 0 ? p.l1 : p.l0, r1 = d.depth > 0 ? p.r1 : p.r0;
    out.push(polyline([{ x: p.l0, y }, { x: p.r0, y }, { x: r1, y: y + H }, { x: l1, y: y + H }], true, o));
    const w = Math.min(p.r0, r1) - Math.max(p.l0, l1);
    const lh = Math.max(4, Math.min(H * 0.4, (w / Math.max(2, p.label.length + (p.turned ? 2 : 0))) * 1.4, tall ? H : 30));
    const cx = (p.l0 + p.r0 + l1 + r1) / 4;
    // "*" = turned (the cut list says how); plain ASCII so it prints in any PDF font.
    const lbl = p.label + (p.turned ? "*" : "");
    out.push(text({ x: cx - lbl.length * lh * 0.3, y: y + H / 2 - lh / 2 }, lbl, { ...o, height: lh }));
  }
  if (d.stock - d.used > 1e-6) {
    out.push(rect(d.used, d.stock));
    const dh = Math.max(4, Math.min(H * 0.35, tall ? H : 20));
    if (d.stock - d.used > dropText.length * dh * 0.7) out.push(text({ x: d.used + dh * 0.4, y: y + H / 2 - dh / 2 }, dropText, { ...o, height: dh }));
  }
  return out;
}

export interface BarLayoutMeta {
  /** "Tube" / "Bar". */
  noun: string;
}

/** Every pattern stacked downward, for a canvas tab. */
export function barLayoutCommands(res: CalcResult, meta: BarLayoutMeta): Command[] {
  const cmds: Command[] = [];
  let y = 0;
  res.bars.forEach((b, i) => {
    if (!b.draw) return;
    const H = stripDepth(b.draw);
    const th = Math.max(6, Math.min(Math.max(H * 0.45, b.draw.stock * 0.008), 80));
    const title = `${meta.noun} pattern ${i + 1}${b.count > 1 ? `  CUT ×${b.count}` : ""} - ${b.stock}${b.time ? ` - ${b.time} each` : ""}`;
    for (const e of barPatternEntities(b.draw, y, title, `drop ${b.remnant}`)) cmds.push(add(e));
    y -= H + th * 3 + 60;
  });
  return cmds;
}

const PRINT_FILLS = ["#dbe4ff", "#d3f0dc", "#fde3c4", "#ecdcf7", "#f9d9df", "#d2eff3", "#ececcf", "#f3dccd"];

/** A pattern for the printed page: light fills by label, black outlines and lettering, the drop and the trim greyed. */
export function barSvgHtml(d: BarDrawing, labels: readonly string[], dropText: string): string {
  const W = 1000, H = 64;
  // A bar arranged by hand can be overrun: scale to the pieces and show the overrun hatched red.
  const span = Math.max(d.stock, d.used + d.tail);
  const sx = W / span;
  const X = (v: number) => (v * sx).toFixed(1);
  const yb = H + 2, yt = 2;
  let g = `<rect x="0" y="2" width="${X(d.stock)}" height="${H}" fill="#ffffff" stroke="#000000" stroke-width="1.5"/>`;
  if (span > d.stock + 1e-6) g += `<rect x="${X(d.stock)}" y="2" width="${X(span - d.stock)}" height="${H}" fill="#f6c6cb" stroke="#c0392b" stroke-width="2"/>`;
  if (d.trim > 0) g += `<rect x="0" y="2" width="${X(d.trim)}" height="${H}" fill="#bbbbbb"/>`;
  if (d.stock - d.used > 1e-6) g += `<rect x="${X(d.used)}" y="2" width="${X(d.stock - d.used)}" height="${H}" fill="#eeeeee" stroke="#000000" stroke-width="1"/>`;
  for (const p of d.pieces) {
    const ci = Math.max(0, labels.indexOf(p.label)) % PRINT_FILLS.length;
    const l1 = d.depth > 0 ? p.l1 : p.l0, r1 = d.depth > 0 ? p.r1 : p.r0;
    g += `<polygon points="${X(p.l0)},${yb} ${X(p.r0)},${yb} ${X(r1)},${yt} ${X(l1)},${yt}" fill="${PRINT_FILLS[ci]}" stroke="#000000" stroke-width="1.2"/>`;
    const w = (Math.min(p.r0, r1) - Math.max(p.l0, l1)) * sx;
    const t = p.label + (p.turned ? "*" : "");
    if (w > t.length * 14 + 4) g += `<text x="${(((p.l0 + p.r0 + l1 + r1) / 4) * sx).toFixed(1)}" y="${2 + H / 2 + 9}" text-anchor="middle" font-size="26" font-weight="600" fill="#000000">${esc(t)}</text>`;
  }
  const dw = (d.stock - d.used) * sx;
  if (dw > dropText.length * 11) g += `<text x="${(X(d.used + (d.stock - d.used) / 2))}" y="${2 + H / 2 + 7}" text-anchor="middle" font-size="20" fill="#555555">${esc(dropText)}</text>`;
  return `<svg viewBox="0 0 ${W} ${H + 4}" preserveAspectRatio="none" style="width:100%;height:60px;display:block">${g}</svg>`;
}

const esc = (s: string): string => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

export interface BarReportMeta {
  title: string;
  noun: string;
  jobName?: string;
  notes?: string;
  date?: string;
}

export function buildBarReportHtml(res: CalcResult, meta: BarReportMeta): string {
  const kpis = `<table><tbody><tr>${res.summary.map(([l]) => `<th>${esc(l)}</th>`).join("")}</tr><tr>${res.summary.map(([, v]) => `<td>${esc(v)}</td>`).join("")}</tr></tbody></table>`;
  const details = (res.details ?? []).length ? `<table><tbody>${(res.details ?? []).map(([l, v]) => `<tr><th style="width:28%">${esc(l)}</th><td>${esc(v)}</td></tr>`).join("")}</tbody></table>` : "";
  const hasCost = res.buy.some((b) => b.cost);
  const buy = `<h2>Stock to get</h2><table><thead><tr><th>Length</th><th>Bars</th>${hasCost ? "<th>Cost</th>" : ""}</tr></thead><tbody>${res.buy.map((b) => `<tr><td>${esc(b.length)}</td><td><b>${b.count}</b></td>${hasCost ? `<td>${esc(b.cost)}</td>` : ""}</tr>`).join("")}</tbody></table>`;
  const patterns = res.bars
    .map((b, i) => {
      const svg = b.draw ? barSvgHtml(b.draw, res.labels ?? [], `drop ${b.remnant}`) : "";
      return `<div class="pattern"><h3>${esc(meta.noun)} pattern ${i + 1} - ${esc(b.stock)}${b.count > 1 ? ` <span class="qty">CUT ×${b.count}</span>` : ""}${b.over ? ` <span style="color:#c0392b">TOO LONG by ${esc(b.over)}</span>` : ""}</h3>${svg}<p>${esc(b.cuts)}</p>${b.draw && b.draw.pieces.some((p) => p.turned) ? '<p class="muted">* turned - see the cut list</p>' : ""}<p class="muted">Drop ${esc(b.remnant)}${b.time ? ` · ${esc(b.time)} each` : ""}</p></div>`;
    })
    .join("");
  const unplaced = res.unplaced.length ? `<p style="color:#c0392b"><b>Not placed:</b> ${res.unplaced.map(esc).join(", ")}</p>` : "";
  return `<style>
    .bar-report { font: 13px system-ui, -apple-system, sans-serif; color: #111111; }
    .bar-report table { border-collapse: collapse; width: 100%; margin: 8px 0 16px; }
    .bar-report th, .bar-report td { border: 1px solid #cccccc; padding: 4px 8px; text-align: left; font-size: 12px; }
    .bar-report th { background: #f0f0f0; }
    .bar-report .pattern { break-inside: avoid; margin: 10px 0 14px; }
    .bar-report .pattern h3 { margin: 0 0 4px; font-size: 14px; }
    .bar-report .pattern p { margin: 3px 0; }
    .bar-report .muted { color: #666666; }
    .bar-report .qty { display: inline-block; margin-left: 8px; padding: 0 8px; border: 2px solid #111111; border-radius: 4px; }
  </style>
  <div class="bar-report">
    <h1>${esc(meta.jobName ? `${meta.jobName} - ${meta.title}` : meta.title)}</h1>
    ${meta.date ? `<p class="muted">${esc(meta.date)}</p>` : ""}
    ${details}
    ${kpis}
    ${(res.warnings ?? []).map((w) => `<p style="color:#b9770e">${esc(w)}</p>`).join("")}
    ${unplaced}
    ${buy}
    <h2>Cut list</h2>
    ${patterns}
    ${meta.notes ? `<h2>Notes</h2><p>${esc(meta.notes)}</p>` : ""}
  </div>`;
}

export function buildBarReportPdf(res: CalcResult, meta: BarReportMeta): Uint8Array {
  const pdf = new PdfBuilder(PDF_LETTER);
  const margin = 36, right = pdf.width - margin, bottom = pdf.height - margin;
  let y = margin + 12;
  const need = (h: number) => {
    if (y + h > bottom) {
      pdf.addPage();
      y = margin + 12;
    }
  };
  const line = (s: string, size = 9, bold = false, color?: string) => {
    // crude wrap at ~ (width / (size*0.5)) characters
    const max = Math.max(20, Math.floor((right - margin) / (size * 0.5)));
    const words = s.split(" ");
    let cur = "";
    const flush = () => {
      need(size + 4);
      pdf.text(margin, y, cur, { size, bold, ...(color ? { color } : {}) });
      y += size + 4;
      cur = "";
    };
    for (const w of words) {
      if ((cur + " " + w).trim().length > max) flush();
      cur = (cur ? cur + " " : "") + w;
    }
    if (cur) flush();
  };
  line(meta.jobName ? `${meta.jobName} - ${meta.title}` : meta.title, 15, true);
  if (meta.date) line(meta.date, 9, false, "#666666");
  y += 4;
  for (const [l, v] of res.details ?? []) line(`${l}: ${v}`);
  y += 4;
  for (let i = 0; i < res.summary.length; i += 4) line(res.summary.slice(i, i + 4).map(([l, v]) => `${l}: ${v}`).join("   "), 10, true);
  for (const w of res.warnings ?? []) line(w, 9, false, "#b9770e");
  if (res.unplaced.length) line(`Not placed: ${res.unplaced.join(", ")}`, 9, true, "#c0392b");
  y += 6;
  line("Stock to get", 12, true);
  for (const b of res.buy) line(`${b.count} × ${b.length}${b.cost ? ` - ${b.cost}` : ""}`);
  y += 6;
  line("Cut list", 12, true);
  res.bars.forEach((b, i) => {
    need(110);
    line(`${meta.noun} pattern ${i + 1} - ${b.stock}${b.count > 1 ? `   CUT x${b.count}` : ""}${b.over ? `   TOO LONG by ${b.over}` : ""}`, 11, true, b.over ? "#c0392b" : undefined);
    if (b.draw) {
      const ents = barPatternEntities(b.draw, 0, "", `drop ${b.remnant}`, true).filter((e) => !(e.type === "text" && e.text === ""));
      const h = 40;
      drawEntitiesToPdf(pdf, ents, { x: margin, y, width: right - margin, height: h }, { strokeColor: "#000000", strokeWidth: 0.7 });
      y += h + 6;
    }
    line(b.cuts);
    line(`Drop ${b.remnant}${b.time ? ` · ${b.time} each` : ""}`, 9, false, "#666666");
    y += 6;
  });
  if (meta.notes) {
    line("Notes", 12, true);
    line(meta.notes);
  }
  return pdf.bytes();
}
