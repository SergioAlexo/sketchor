import { classifyMat, normName, splitCsvLine, thickFrom } from "./bom";
import { defaultRotationFor, defaultSheets, MATERIALS, thicknessesFor, type LengthField, type MaterialId, type RotationCode, type SheetSize } from "./catalog";
import { validDue, type JobGroup, type JobGroupItem } from "./nestJob";
import { parseLen, parseNum, type LengthUnit } from "./units";

/**
 * A parts list as a CSV file (or pasted CSV) for multi-material nesting:
 * one row per part, with its quantity, material and thickness, plus the
 * optional rotation, priority, due date and sheet size. Rows are grouped by
 * material + thickness, and each group is nested on its own sheets with its
 * own kerf, so one Calculate covers every thickness on the list.
 *
 * Exports differ a lot between ERPs, Excel and CAD BOMs, so the reader is
 * lenient about the layout: comma, semicolon or tab, quoted fields, Excel's
 * `sep=` line, a header in any column order (or no header: part, qty,
 * material, thickness), units in the header (`Thickness (mm)`) or in the
 * cell (`3 mm`, `1/8"`, `16 ga`), and decimal commas. It is strict about the
 * values: a quantity it cannot read is counted in `qtyMissing` and the row
 * nests once, a material it cannot place goes to the job's material and is
 * counted in `materialUnknown`, and a line without a part is `skipped`.
 * Nothing here throws.
 *
 * Why it is worth testing: a misread column nests the wrong quantity, puts
 * a 3 mm part on a 1/8" sheet, or reads "3" as three inches. The tests pin
 * the header aliases, the unit rules and the grouping.
 */

export interface CsvPartRow {
  /** Part number or drawing file name, as written (looked up as a DXF file). */
  num: string;
  /** Null when the cell was empty or unreadable. */
  qty: number | null;
  /** Null when no material column or the text names no known material. */
  material: MaterialId | null;
  /** Null when no thickness was given. `u` is "mm" or "in". */
  thickness: LengthField | null;
  rotation?: RotationCode;
  priority?: "high" | "low";
  due?: string;
  /** Sheet size for the row's group, inches (catalog unit). */
  sheet?: SheetSize;
}

export type CsvColumn = "num" | "qty" | "material" | "thickness" | "rotation" | "priority" | "due" | "sheet";

export interface CsvParseResult {
  rows: CsvPartRow[];
  /** True when a header line was recognised. */
  header: boolean;
  /** Columns found, by header name (or position, without a header). */
  columns: CsvColumn[];
  /** Lines that held no part. */
  skipped: number;
  /** Rows whose quantity could not be read (they nest once). */
  qtyMissing: number;
  /** Rows with material text that names no known material. */
  materialUnknown: number;
}

export interface CsvOptions {
  /** What a bare thickness number means when neither the header nor the cell says. */
  defaultThicknessUnit?: "mm" | "in";
}

/** Material text -> material id: Sketchor ids, common names, grades (S235, 304, 5754, 6082...). Null when unsure. */
export function classifyMaterialLoose(txt: string): MaterialId | null {
  const raw = String(txt ?? "").trim();
  if (!raw) return null;
  const lower = raw.toLowerCase();
  const direct = MATERIALS.find((m) => m.id === lower || m.fileToken.toLowerCase() === lower);
  if (direct) return direct.id;
  const fromBom = classifyMat(raw);
  if (fromBom) return fromBom;
  const u = " " + raw.toUpperCase().replace(/[^A-Z0-9.]+/g, " ") + " ";
  if (/\b(INOX|AISI ?3\d\d|SUS ?3\d\d|1\.4[0-9]{3}|STAINLESS|NIRO|V2A|V4A|430|409|201|321)\b/.test(u)) return "ss";
  if (/\b(ALU|ALUMINIUM|ALUMINUM|AL|ALMG\d?|A ?5052|A ?5083|5754|5083|5005|1050|3003|AW ?5\d{3})\b/.test(u)) {
    return /\b(6061|6082|6063|AW ?6\d{3}|ALMGSI)\b/.test(u) ? "al6061" : "al5052";
  }
  if (/\b(6061|6082|6063|AW ?6\d{3}|ALMGSI)\b/.test(u)) return "al6061";
  if (/\b(S\d{3}[A-Z0-9]*|DC0\d|DD1\d|SPCC|SPHC|SS400|Q235|Q345|MILD|CARBON|GALV|GALVANI[SZ]ED|ZINC|DX51D?|1018|1020|1045|ST ?\d{2})\b/.test(u)) return "cs";
  if (/\b(PLASTIC|ACRYLIC|PMMA|PLEXI|HDPE|PE|PP|PVC|POM|DELRIN|PC|POLYCARBONATE|ABS|NYLON|PA6?)\b/.test(u)) return "plastic";
  if (/\b(PLYWOOD|PLY|WOOD|MDF|BIRCH|HDF)\b/.test(u)) return "plywood";
  if (/\b(QUARTZ)\b/.test(u)) return "quartz";
  if (/\b(STONE|GRANITE|MARBLE)\b/.test(u)) return "stone";
  return null;
}

/** "mm" / "in" named in a header cell (`Thickness (mm)`, `Thk [in]`, `thickness, inch`), or null. */
function headerUnit(h: string): "mm" | "in" | "cm" | null {
  const m = /(?:\(|\[|,|\s)\s*(mm|cm|in|inch|inches|")\s*[)\]]?\s*$/i.exec(h);
  if (!m) return null;
  const u = m[1].toLowerCase();
  return u === "mm" ? "mm" : u === "cm" ? "cm" : "in";
}

/**
 * One thickness cell. Order: a gauge (`16 ga`, looked up in the material's
 * gauge table), a unit in the cell (`3mm`, `1/8"`, `0.125 in`), the header's
 * unit, then `defaultUnit`. Null when the cell holds no usable number.
 */
export function parseThicknessCell(cell: string, material: MaterialId | null, unitHint: "mm" | "in" | "cm" | null, defaultUnit: "mm" | "in"): LengthField | null {
  const s = String(cell ?? "").trim().toLowerCase().replace(/[”“″]/g, '"');
  if (!s) return null;
  const ga = /^#?\s*(\d{1,2})\s*(?:ga|gauge|gage|g)\b\.?$/.exec(s) ?? /^(?:ga|gauge|gage)\s*#?\s*(\d{1,2})$/.exec(s);
  if (ga) {
    const opt = thicknessesFor(material ?? "cs").find((o) => new RegExp(`\\b${ga[1]} ga\\b`).test(o.label ?? ""));
    return opt ? { v: opt.value, u: "in" } : null;
  }
  const cellUnit = /(mm|cm|in|inch|inches|")\s*$/.exec(s);
  const numPart = s.replace(/^(t|thk|s)\s*=?\s*/, "").replace(/\s*(mm|cm|in|inch|inches|")\s*$/, "").trim();
  const v = parseNum(numPart);
  if (!(v > 0) || v > 1000) return null;
  const u = cellUnit ? (cellUnit[1] === "mm" ? "mm" : cellUnit[1] === "cm" ? "cm" : "in") : (unitHint ?? defaultUnit);
  if (u === "cm") return { v: String(Math.round(v * 10 * 1e6) / 1e6), u: "mm" };
  // Keep what was typed ("1/8") so the group shows it the same way.
  return { v: u === "mm" ? String(v) : numPart.replace(",", "."), u };
}

/** "3000x1500", "1500 x 3000 mm", "60 × 120", "48x96 in" -> inches (catalog unit). Null when unreadable. */
export function parseSheetCell(cell: string, unitHint: "mm" | "in" | "cm" | null, defaultUnit: "mm" | "in"): SheetSize | null {
  const s = String(cell ?? "").trim().toLowerCase();
  const m = /^([\d.,/ ]+?)\s*(mm|cm|in|")?\s*[x×*]\s*([\d.,/ ]+?)\s*(mm|cm|in|")?$/.exec(s);
  if (!m) return null;
  const u = (m[4] ?? m[2] ?? unitHint ?? defaultUnit).replace('"', "in") as LengthUnit;
  const w = parseLen(m[1], u), h = parseLen(m[3], u);
  if (!(w > 0 && h > 0)) return null;
  const r = (x: number) => Math.round(x * 10000) / 10000;
  return { w: r(Math.min(w, h)), h: r(Math.max(w, h)) };
}

function parseRotation(cell: string): RotationCode | undefined {
  const s = String(cell ?? "").trim().toLowerCase().replace(/[°\s]/g, "");
  if (!s) return undefined;
  if (/^(none|no|n|0|locked|lock|fixed|grain|false)$/.test(s)) return "none";
  if (/^(flip|180)$/.test(s)) return "flip";
  if (/^(r?90|yes|y|true|quarter)$/.test(s)) return "r90";
  if (/^(r?45)$/.test(s)) return "r45";
  if (/^(r?30)$/.test(s)) return "r30";
  if (/^(r?15)$/.test(s)) return "r15";
  if (/^(r?10)$/.test(s)) return "r10";
  if (/^(free|any|all|1)$/.test(s)) return "free";
  return undefined;
}

function parsePriority(cell: string): "high" | "low" | undefined {
  const s = String(cell ?? "").trim().toLowerCase();
  if (/^(high|h|urgent|rush|hot|1|a)$/.test(s)) return "high";
  if (/^(low|l|3|c)$/.test(s)) return "low";
  return undefined;
}

/** YYYY-MM-DD, or DD.MM.YYYY (dots are unambiguous) -> YYYY-MM-DD; undefined otherwise. */
function parseDue(cell: string): string | undefined {
  const s = String(cell ?? "").trim();
  const iso = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/.exec(s);
  const eu = /^(\d{1,2})\.(\d{1,2})\.(\d{4})$/.exec(s);
  const p = iso ? [iso[1], iso[2], iso[3]] : eu ? [eu[3], eu[2], eu[1]] : null;
  if (!p) return undefined;
  return validDue(`${p[0]}-${p[1]!.padStart(2, "0")}-${p[2]!.padStart(2, "0")}`) ?? undefined;
}

function parseQty(cell: string): number | null {
  const s = String(cell ?? "").trim().replace(/\s*(pcs?|pieces?|ea|x|шт\.?)$/i, "").replace(/^x\s*/i, "").replace(",", ".");
  if (!/^\d+(\.0+)?$/.test(s)) return null;
  const n = Math.floor(Number(s));
  return n >= 0 && n <= 100000 ? n : null;
}

/** Header cell -> column, by name. Unit suffixes are ignored here (see `headerUnit`). */
function headerColumn(h: string): CsvColumn | null {
  const s = h
    .trim()
    .toLowerCase()
    .replace(/[([][^)\]]*[)\]]\s*$/, "")
    .replace(/,\s*(mm|cm|in|inch)\s*$/, "")
    .replace(/[_.#-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (/^(qty|q ty|quantity|qnty|qnt|count|pcs|pieces|amount|number of parts|no of parts|nr of parts|menge|anzahl|кол во|количество)$/.test(s)) return "qty";
  if (/^(thickness|thick|thk|t|gauge|gage|ga|sheet thickness|material thickness|dicke|stärke|толщина)$/.test(s)) return "thickness";
  if (/^(material|mat|grade|alloy|material grade|werkstoff|материал)$/.test(s)) return "material";
  if (/^(rotation|rotate|grain|angle|allow rotation)$/.test(s)) return "rotation";
  if (/^(priority|prio)$/.test(s)) return "priority";
  if (/^(due|due date|deadline|ship date|date)$/.test(s)) return "due";
  if (/^(sheet|sheet size|stock|stock size|plate|plate size)$/.test(s)) return "sheet";
  if (/^(file|file name|filename|drawing|drawing file|dxf|dxf file|path)$/.test(s)) return "num";
  if (/^(part|part number|part no|part nr|partnumber|part num|p n|pn|part name|name|article|article number|code|reference|ref|teil|teilenummer|деталь)$/.test(s)) return "num";
  return null;
}

/** Most frequent of `,` `;` tab on the line (at least once), else "". */
function delimOf(line: string): string {
  let best = "";
  let bn = 0;
  for (const d of ["\t", ";", ","]) {
    const n = line.split(d).length - 1;
    if (n > bn) {
      bn = n;
      best = d;
    }
  }
  return best;
}

/** Parses a CSV parts list (see the module comment). Never throws. */
export function parsePartsCsv(text: string, opts: CsvOptions = {}): CsvParseResult {
  const defaultUnit = opts.defaultThicknessUnit ?? "mm";
  const out: CsvParseResult = { rows: [], header: false, columns: [], skipped: 0, qtyMissing: 0, materialUnknown: 0 };
  const lines = String(text ?? "").replace(/^﻿/, "").split(/\r?\n/).slice(0, 100_000);
  let i = 0;
  let delim = "";
  const sep = /^\s*"?sep=(.)"?\s*$/i.exec(lines[0] ?? "");
  if (sep) {
    delim = sep[1]!;
    i = 1;
  }
  while (i < lines.length && !lines[i]!.trim()) i++;
  if (i >= lines.length) return out;
  if (!delim) delim = delimOf(lines[i]!);
  const split = (ln: string) => (delim ? splitCsvLine(ln, delim) : [ln]).map((c) => c.trim());

  // Column map: from the header, else positional.
  let cols: (CsvColumn | null)[] = [];
  let units: ("mm" | "in" | "cm" | null)[] = [];
  const first = split(lines[i]!);
  const named = first.map(headerColumn);
  if (named.includes("num") || (named.includes("qty") && named.filter((c) => c !== null).length >= 2)) {
    out.header = true;
    // The first column of a kind wins. For the part, a file-name column beats a part-number one (it is what is
    // looked up), and a part number beats a bare "name".
    const numRank = (h: string) => (/file|drawing|dxf|path/i.test(h) ? 0 : /^\s*(part\s*)?name\s*$/i.test(h) ? 2 : 1);
    let numIdx = -1;
    named.forEach((c, k) => {
      if (c === "num" && (numIdx < 0 || numRank(first[k]!) < numRank(first[numIdx]!))) numIdx = k;
    });
    const seen = new Set<CsvColumn>();
    cols = named.map((c, k) => {
      if (!c) return null;
      if (c === "num") return k === numIdx ? "num" : null;
      if (seen.has(c)) return null;
      seen.add(c);
      return c;
    });
    units = first.map(headerUnit);
    i++;
  } else {
    const order: CsvColumn[] = ["num", "qty", "material", "thickness"];
    cols = first.map((_, k) => order[k] ?? null);
    units = first.map(() => null);
  }
  out.columns = cols.filter((c): c is CsvColumn => c !== null);
  const at = (c: CsvColumn) => cols.indexOf(c);
  const ci = { num: at("num"), qty: at("qty"), material: at("material"), thickness: at("thickness"), rotation: at("rotation"), priority: at("priority"), due: at("due"), sheet: at("sheet") };

  for (; i < lines.length; i++) {
    const ln = lines[i]!;
    if (!ln.trim()) continue;
    const f = split(ln);
    const cell = (k: number) => (k >= 0 ? (f[k] ?? "") : "");
    const num = cell(ci.num).replace(/^"+|"+$/g, "").trim();
    if (!num || /^(total|sum|итого|summe)\b/i.test(num) || headerColumn(num) === "num") {
      out.skipped++;
      continue;
    }
    const matText = cell(ci.material);
    const material = classifyMaterialLoose(matText);
    if (matText && !material) out.materialUnknown++;
    let thickness = parseThicknessCell(cell(ci.thickness), material, ci.thickness >= 0 ? (units[ci.thickness] ?? null) : null, defaultUnit);
    if (!thickness && matText) {
      // No thickness column: "S235 3mm" or the BOM style "SHEET, AL 5052 .125" (decimal inches).
      const mm = /(\d+(?:[.,]\d+)?)\s*mm\b/i.exec(matText);
      const dec = thickFrom(matText);
      thickness = mm ? { v: String(parseNum(mm[1]!)), u: "mm" } : dec ? { v: dec, u: "in" } : null;
    }
    const qty = ci.qty >= 0 ? parseQty(cell(ci.qty)) : 1;
    if (qty === null) out.qtyMissing++;
    if (qty === 0) {
      out.skipped++;
      continue;
    }
    const rotation = parseRotation(cell(ci.rotation));
    const priority = parsePriority(cell(ci.priority));
    const due = parseDue(cell(ci.due));
    const sheet = ci.sheet >= 0 ? parseSheetCell(cell(ci.sheet), units[ci.sheet] ?? null, defaultUnit) : null;
    out.rows.push({
      num,
      qty,
      material,
      thickness,
      ...(rotation ? { rotation } : {}),
      ...(priority ? { priority } : {}),
      ...(due ? { due } : {}),
      ...(sheet ? { sheet } : {}),
    });
  }
  return out;
}

/** Group key part for a thickness: the value in µm, so "1/8" and "0.125" (and "3" mm and "3.0" mm) land together. */
function thicknessKey(t: LengthField | null): string {
  if (!t) return "";
  const inches = parseLen(t.v, t.u);
  return Number.isFinite(inches) ? String(Math.round(inches * 25400)) : `${t.v}${t.u}`;
}

export interface CsvGroupOptions {
  /** Material for rows without one. */
  material: MaterialId;
  /** Thickness for rows without one (null = leave the group's thickness empty). */
  thickness: LengthField | null;
  /** Sheet for a new group of `material` without a sheet column (inches); default = the catalog's first size. */
  sheetFor?: (material: MaterialId) => SheetSize;
}

/**
 * CSV rows -> groups by material + thickness, in first-seen order. Repeated
 * part numbers in a group are summed (the first row's rotation / priority /
 * due date are kept); a row without a quantity counts as 1.
 */
export function groupsFromCsvRows(rows: readonly CsvPartRow[], opts: CsvGroupOptions): JobGroup[] {
  const sheets = defaultSheets().sizes;
  const out: JobGroup[] = [];
  const byKey = new Map<string, JobGroup>();
  for (const r of rows) {
    if (!r.num) continue;
    const material = r.material ?? opts.material;
    const thickness = r.thickness ?? opts.thickness;
    const key = `${material}|${thicknessKey(thickness)}`;
    let g = byKey.get(key);
    if (!g) {
      g = {
        id: key,
        material,
        thickness: thickness?.v ?? "",
        ...(thickness?.u === "mm" ? { thicknessUnit: "mm" as const } : {}),
        sheet: r.sheet ? { ...r.sheet } : { ...(opts.sheetFor?.(material) ?? sheets[material][0]!) },
        rotation: defaultRotationFor(material),
        items: [],
      };
      byKey.set(key, g);
      out.push(g);
    }
    const qty = r.qty !== null && r.qty >= 1 ? r.qty : 1;
    const name = normName(r.num);
    const existing = g.items.find((it) => normName(it.num) === name);
    if (existing) existing.qty = Math.min(100000, existing.qty + qty);
    else {
      const item: JobGroupItem = { num: r.num, qty, ...(r.rotation ? { rotation: r.rotation } : {}), ...(r.priority ? { priority: r.priority } : {}), ...(r.due ? { due: r.due } : {}) };
      g.items.push(item);
    }
  }
  return out;
}

/** True when the text looks like a CSV parts list this reader understands (a recognised header with a part column). */
export function looksLikePartsCsv(text: string): boolean {
  const r = parsePartsCsv(String(text ?? "").split(/\r?\n/).slice(0, 3).join("\n"));
  return r.header && r.columns.includes("num");
}
