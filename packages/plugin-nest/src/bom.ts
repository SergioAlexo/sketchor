/**
 * RN-13: parts-list (BOM) text and CSV intake. Ported from the Sheet Nesting
 * Calculator by Oleksandr Borenko.
 *
 * The text comes from a paste, a CSV export or (later) OCR, so it is messy:
 * tree-view noise before part numbers, extensions glued on, OCR-split numbers,
 * rows whose quantity could not be read. A wrong guess here nests the wrong
 * quantity of the wrong part, so the rules are conservative: a row that cannot
 * be understood is counted in `skipped`, never invented, and a missing
 * quantity stays `null` for the user to fill in. Nothing here throws.
 */

/** Material ids the BOM text can be classified into (see `catalog.ts` for the material table). */
export type BomMaterialId = "al5052" | "al6061" | "ss" | "cs";

export interface SheetRow {
  /** Cleaned part number (no extension, no icon noise). */
  num: string;
  /** Null when the quantity cell was missing or unreadable. */
  qty: number | null;
  /** Null when the material text names none of the known materials. */
  mat: BomMaterialId | null;
  /** Thickness in inches as a decimal string ("0.125"), or "". */
  thick: string;
  /** The original material text. */
  text: string;
}

export interface SheetParseResult {
  rows: SheetRow[];
  /** Table-looking rows that were not SHEET stock (tubes, hardware) and were left out. */
  skipped: number;
}

/** Guess the material from free text such as "SHEET, AL 5052 .125". Null when unsure. */
export function classifyMat(txt: string): BomMaterialId | null {
  const u = " " + String(txt ?? "").toUpperCase().replace(/[^A-Z0-9.]+/g, " ") + " ";
  const al = /\bAL(?:UMINUM|UMINIUM)? ?([5S][0O][5S]2|6[0O]6[1lI])\b/.exec(u);
  if (al) return /^[5S]/.test(al[1]) ? "al5052" : "al6061";
  if (/\b(SS|STAINLESS|INOX|304L?|316L?)\b/.test(u)) return "ss";
  if (/\b(ST|STEEL|CRS|HRS|HR|CR|HRPO|A36|MS|CS)\b/.test(u)) return "cs";
  return null;
}

/** First decimal like ".125" or "0.25" in the text, as a normalised string; "" when none. */
export function thickFrom(txt: string): string {
  const m = /(?:^|[^0-9.])(\d*\.\d+)(?![0-9])/.exec(String(txt ?? ""));
  if (!m) return "";
  const v = parseFloat(m[1]);
  return v > 0 ? String(Math.round(v * 10000) / 10000) : "";
}

const EXT_RX = /\.(sldprt|sldasm|slddrw|dxf|dwg|step|stp|ipt|iam|prt|asm)$/i;

/** Part number as shown in SolidWorks/Onshape: drops the file extension and icon / tree-view / OCR noise around it. */
export function cleanNum(raw: string): string {
  let s = String(raw ?? "").replace(/\.\s+(?=[A-Za-z]{3,8}\s*$)/, ".").trim();
  let toks = s
    .split(/\s+/)
    .map((x) => x.replace(/^[^A-Za-z0-9]+/, ""))
    .filter((x) => x !== "");
  if (toks.length > 1) {
    // a tree-view entry on the same text line: the part number is the last full number
    const full = toks.filter((x) => /\d{8}/.test(x.replace(/\.[A-Za-z].*$/, "")));
    if (full.length > 1) toks = [full[full.length - 1]];
  }
  if (toks.length > 1) {
    const core = toks.filter((x) => x.length > 2 && /\d/.test(x));
    if (core.length === 1) toks = core;
    else while (toks.length > 1 && (toks[0].length <= 2 || !/\d/.test(toks[0]))) toks.shift();
  }
  if (toks.length > 1) {
    // OCR split a long number: glue the digit-like pieces
    const bare = toks.map((x) => x.replace(/\.[A-Za-z0-9.]*[A-Za-z][A-Za-z0-9.]*$/, ""));
    if (bare.every((x) => /^[0-9OoQDcCIlSsBZ]+$/.test(x)) && bare.join("").length >= 6) toks = [bare.join("")];
  }
  s = toks.join(" ").replace(EXT_RX, "");
  const dot = s.indexOf("."); // damaged extension after the number
  if (dot >= 5) {
    const head = s.slice(0, dot);
    const tail = s.slice(dot + 1);
    if (/\d/.test(head) && /[A-Za-z]/.test(tail) && tail.length <= 12 && !/\s/.test(head)) s = head;
  }
  return s.trim();
}

/** Split one CSV line on `d`, honouring "quoted, fields" and "" escapes. */
export function splitCsvLine(ln: string, d: string): string[] {
  const f: string[] = [];
  let cur = "";
  let q = false;
  const line = String(ln ?? "");
  for (let i = 0; i < line.length; i++) {
    const c = line.charAt(i);
    if (q) {
      if (c === '"') {
        if (line.charAt(i + 1) === '"') {
          cur += '"';
          i++;
        } else q = false;
      } else cur += c;
    } else if (c === '"') q = true;
    else if (c === d) {
      f.push(cur);
      cur = "";
    } else cur += c;
  }
  f.push(cur);
  return f;
}

/** The delimiter (`,` `;` or tab) that appears at least twice on the line, or "" when it does not look like a table row. */
export function csvDelim(ln: string): string {
  let best = ",";
  let bn = 0;
  for (const d of [",", ";", "\t"]) {
    const n = String(ln ?? "").split(d).length - 1;
    if (n > bn) {
      bn = n;
      best = d;
    }
  }
  return bn >= 2 ? best : "";
}

/**
 * Parses pasted / CSV parts-list text into SHEET rows only (other stock types
 * and hardware are counted in `skipped`). Handles a CSV header
 * (Part Number, Qty, Material, any order), quoted fields, tab / comma /
 * semicolon delimiters, and plain pasted lines like `12 PN-0001 4 SHEET 0.125 AL 5052`.
 */
export function parseSheetText(text: string): SheetParseResult {
  const rows: SheetRow[] = [];
  let skipped = 0;
  const src = String(text ?? "");
  const hasItemHdr = /\bitem\b/i.test(src);
  const ci = { num: 0, qty: 1, mat: 2 };
  const csvRow = (f: string[]): boolean => {
    const num = cleanNum(String(f[ci.num] ?? "").trim());
    const qs = String(f[ci.qty] ?? "").trim();
    const mt = String(f[ci.mat] ?? "").trim();
    if (!num || !/^SHEET\b/i.test(mt)) return false;
    rows.push({ num, qty: /^\d+$/.test(qs) ? parseInt(qs, 10) : null, mat: classifyMat(mt), thick: thickFrom(mt), text: mt });
    return true;
  };
  for (const raw of src.replace(/^﻿/, "").split(/\r?\n/)) {
    const ln = raw.replace(/\t+/g, "  ").replace(/[|¦]+/g, " ").trim();
    if (!ln) continue;
    const dl = csvDelim(raw);
    if (dl) {
      const f = splitCsvLine(raw, dl);
      if (/part\s*number|^\s*item\b/i.test(f[0] + " " + (f[1] ?? "")) && /qty|quantity/i.test(raw) && /material/i.test(raw)) {
        f.forEach((h, k) => {
          const hh = h.trim().toLowerCase();
          if (/^(part\s*number|number|part|p\/n)/.test(hh)) ci.num = k;
          else if (/^(qty|quantity)/.test(hh)) ci.qty = k;
          else if (/^material/.test(hh)) ci.mat = k;
        });
        continue;
      }
      if (csvRow(f)) continue;
      if (f.length >= 3 && /^\s*\d+\s*$/.test(f[ci.qty] ?? "") && !/\bSHEET\b/i.test(raw)) {
        skipped++;
        continue;
      }
    }
    const m = /^(?:\W{0,3}\s*)?(?:(\d{1,4})\s+)?(.+?)\s+(\S{1,5})\s+(SHEET\b.*)$/i.exec(ln);
    if (m) {
      let num = cleanNum(m[2]);
      if (!m[1] && hasItemHdr && /^\d{1,4}$/.test(num.split(/\s+/)[0]) && num.indexOf(" ") > 0) num = num.replace(/^\d{1,4}\s+/, "");
      rows.push({ num, qty: /^\d+$/.test(m[3]) ? parseInt(m[3], 10) : null, mat: classifyMat(m[4]), thick: thickFrom(m[4]), text: m[4] });
    } else if (/\bSHEET\b/i.test(ln) && /\S\s+SHEET\b/i.test(ln) && !/\b(item|qty|part number|material)\b/i.test(ln)) {
      // a SHEET row whose quantity could not be read: keep it (quantity left empty) instead of dropping it silently
      const m2 = /^(.*?)\s+(SHEET\b.*)$/i.exec(ln);
      const num2 = m2 ? cleanNum(m2[1].replace(/^\W{0,3}\s*(?:\d{1,4}\s+)?(?=\S)/, "")) : "";
      if (m2 && num2) rows.push({ num: num2, qty: null, mat: classifyMat(m2[2]), thick: thickFrom(m2[2]), text: m2[2] });
    } else if (/^\W{0,3}\d{1,4}\s+\S/.test(ln) && !/\b(item|qty|part number)\b/i.test(ln)) skipped++;
  }
  return { rows, skipped };
}

/**
 * Sums rows that repeat the same part number + material + thickness
 * (case-insensitive). A row with an unknown quantity keeps the sum unknown
 * only if every repeat is unknown; known quantities add up.
 */
export function sumRepeatedRows(rows: readonly SheetRow[]): SheetRow[] {
  const out: SheetRow[] = [];
  const at = new Map<string, number>();
  for (const r of rows) {
    const key = `${r.num.toLowerCase()}|${r.mat ?? ""}|${r.thick}`;
    const i = at.get(key);
    if (i === undefined) {
      at.set(key, out.length);
      out.push({ ...r });
    } else {
      const prev = out[i];
      prev.qty = prev.qty === null && r.qty === null ? null : (prev.qty ?? 0) + (r.qty ?? 0);
    }
  }
  return out;
}

/** Lower-cased, extension-stripped, whitespace-collapsed file / part name used as a lookup key. */
export function normName(x: string): string {
  return String(x ?? "")
    .toLowerCase()
    .trim()
    .replace(/(\.(sldprt|sldasm|dxf))+$/i, "")
    .replace(/\s+/g, " ")
    .trim();
}

export interface BomQuantities {
  /** normName(part) -> total quantity. */
  map: Record<string, number>;
  /** Keys in first-seen order. */
  order: string[];
}

/**
 * Quantities from a pasted parts list: table rows (tab / double-space
 * separated: part-number cell + quantity cell), or free text of part numbers
 * with optional `x3` / count tokens. Repeated numbers are summed; assemblies
 * (.sldasm) are ignored. `filter` keeps only lines containing that text.
 */
export function parseBom(text: string, filter = ""): BomQuantities {
  const map: Record<string, number> = Object.create(null);
  const order: string[] = [];
  const filt = String(filter ?? "").trim().toLowerCase();
  const add = (key: string, qty: number): void => {
    const k = normName(key);
    if (!k || !(qty >= 1)) return;
    if (!(k in map)) {
      map[k] = 0;
      order.push(k);
    }
    map[k] += qty;
  };
  for (const ln of String(text ?? "").split(/\r?\n/)) {
    if (!ln.trim()) continue;
    if (filt && ln.toLowerCase().indexOf(filt) < 0) continue;
    const cells = (ln.indexOf("\t") >= 0 ? ln.split("\t") : ln.split(/\s{2,}/)).map((c) => c.trim()).filter((c) => c !== "");
    if (cells.length >= 2) {
      if (cells.some((c) => /^(qty\.?|quantity)$/i.test(c))) continue; // header
      let pi = cells.findIndex((c) => /\.(sldprt|sldasm|dxf)$/i.test(c));
      if (pi < 0) pi = cells.findIndex((c) => (!/^\d+$/.test(c) || c.length >= 6) && /[A-Za-z0-9]{4,}/.test(c));
      if (pi < 0 || /\.sldasm$/i.test(cells[pi])) continue;
      let qty: number | null = null;
      for (let i = pi + 1; i < cells.length; i++) {
        if (/^\d+$/.test(cells[i])) {
          qty = parseInt(cells[i], 10);
          break;
        }
      }
      add(cells[pi], qty === null ? 1 : qty);
      continue;
    }
    let last: string | null = null;
    for (const tk of ln.split(/[\s,;]+/).filter((x) => x !== "")) {
      if (/^[xX×]$/.test(tk)) continue;
      const m = /^[xX×](\d+)$/.exec(tk);
      if (m && last) {
        map[last] += parseInt(m[1], 10) - 1;
        last = null;
        continue;
      }
      if (/^\d{1,5}$/.test(tk)) {
        if (last) {
          map[last] += parseInt(tk, 10) - 1;
          last = null;
        }
        continue;
      }
      if (!/[A-Za-z0-9]{4,}/.test(tk) || /\.sldasm$/i.test(tk)) {
        last = null;
        continue;
      }
      add(tk, 1);
      last = normName(tk);
    }
  }
  return { map, order };
}
