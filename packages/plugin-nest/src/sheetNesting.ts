import { defaultRotationFor, defaultSheets, type LengthField, type MaterialId } from "./catalog";
import type { CncInfo, CncWarning } from "./cnc";
import type { ExtractNote } from "./partExtraction";
import { lengthMm, type EngineId, type JobGroup, type NestJob } from "./nestJob";
import { groupIdenticalSheets, type SheetGroup, type SignaturePlacement } from "./sheetGroups";
import type { TrueNestSheet } from "./trueNest";
import type { RasterNestResult } from "./raster/rasterNest";
import type { SheetRow } from "./bom";
import { formatLen, parseLen, type LengthFormat } from "./units";

/**
 * Pure helpers behind the "Sheet Nesting" panel (RN-30/31/32/42): field
 * readiness (orange = missing, green = ok), BOM rows -> groups, merging the
 * results of several groups into one result the canvas/report/DXF/G-code code
 * can consume unchanged, KPIs and the stock-usage table, and the
 * `.sketchor-nest` job file. UI-free so every rule is testable.
 *
 * Why it is worth testing: `combineResults` re-indexes sheets, stock rows and
 * `insideOfPlacementIndex` - an off-by-one there puts a part on another
 * group's sheet or cuts a hole before the part inside it - and
 * `parseJobFile` reads a file a user may have edited or truncated.
 *
 * Calculator rules (BOM grouping, orange/green fields, identical sheets,
 * KPIs) follow the Sheet Nesting Calculator by Oleksandr Borenko.
 */

export const NEST_CREDIT = "Nesting engine based on the Sheet Nesting Calculator by Oleksandr Borenko";

// ---------- readiness ----------

export type FieldStatus = "ok" | "missing" | "bad";

/** Empty = missing (orange) unless optional; unparseable or negative = bad. */
export function lengthStatus(f: LengthField, optional = false): FieldStatus {
  if (f.v.trim() === "") return optional ? "ok" : "missing";
  const n = parseLen(f.v, f.u);
  return Number.isFinite(n) && n >= 0 ? "ok" : "bad";
}

export interface Readiness {
  fields: Record<string, FieldStatus>;
  /** Field ids that are not "ok". */
  problems: string[];
  canCalculate: boolean;
}

export interface ReadinessContext {
  /** Manual mode: parts with quantity > 0. */
  manualParts: number;
  /** Groups mode: number of groups and of items not resolved (missing / failed / no quantity). */
  groupCount: number;
  groupProblems: number;
}

/** The clamp strip is a laser feature; other machines cut with clamp 0. */
export function effectiveClamp(job: NestJob): LengthField {
  return job.machine === "laser" ? job.params.clamp : { v: "0", u: "mm" };
}

export function jobReadiness(job: NestJob, ctx: ReadinessContext): Readiness {
  const fields: Record<string, FieldStatus> = {};
  const p = job.params;
  fields.kerf = lengthStatus(p.kerf);
  fields.web = lengthStatus(p.web);
  fields.margin = lengthStatus(p.margin);
  fields.clamp = job.machine === "laser" ? lengthStatus(p.clamp, true) : "ok";
  fields.bedW = lengthStatus(p.bedW, true);
  fields.bedH = lengthStatus(p.bedH, true);
  if (job.mode === "manual") {
    const t = lengthStatus(job.thickness);
    fields.thickness = t === "ok" && !(lengthMm(job.thickness) > 0) ? "bad" : t;
    fields.parts = ctx.manualParts > 0 ? "ok" : "missing";
  } else {
    fields.parts = ctx.groupCount > 0 && ctx.groupProblems === 0 ? "ok" : "missing";
  }
  // groups mode: every group carries its own sheet
  fields.sheet = job.mode === "groups" ? "ok" : job.sheetSource === "stock" ? (job.stock.length > 0 && job.stock.every((s) => s.size.width > 0 && s.size.height > 0) ? "ok" : "missing") : job.sheet.w > 0 && job.sheet.h > 0 ? "ok" : "missing";
  const problems = Object.keys(fields).filter((k) => fields[k] !== "ok");
  return { fields, problems, canCalculate: problems.length === 0 };
}

/** True when the sheet fits on the machine bed in neither orientation. Unknown bed = no warning. */
export function bedWarning(sheetMm: { width: number; height: number }, bed: { width: number; height: number } | null): boolean {
  if (!bed) return false;
  const fits = (a: number, b: number) => a <= bed.width + 1e-6 && b <= bed.height + 1e-6;
  return !(fits(sheetMm.width, sheetMm.height) || fits(sheetMm.height, sheetMm.width));
}

/** The clamp strip rectangle in sheet coordinates (mm): the low-y edge of a wide sheet, the high-x edge of a tall one - where the raster and true-shape engines keep it free. */
export function clampStripRect(sheet: { width: number; height: number }, clamp: number): { x: number; y: number; w: number; h: number } | null {
  if (!(clamp > 0)) return null;
  const wide = sheet.width > sheet.height;
  if (wide) return { x: 0, y: 0, w: sheet.width, h: Math.min(clamp, sheet.height) };
  const w = Math.min(clamp, sheet.width);
  return { x: sheet.width - w, y: 0, w, h: sheet.height };
}

// ---------- formatting ----------

/** Millimetres in the job's display format. */
export function fmtMm(mm: number, unit: LengthFormat): string {
  return formatLen(mm / 25.4, unit);
}

const MM2_PER_IN2 = 25.4 * 25.4;

/** Square millimetres in the job's display format: in² for the inch formats and feet-inches, otherwise mm² / cm² / m². */
export function fmtMm2(mm2: number, unit: LengthFormat): string {
  if (!Number.isFinite(mm2)) return "";
  const r = (x: number, n: number) => String(Math.round(x * 10 ** n) / 10 ** n);
  switch (unit) {
    case "mm":
      return `${r(mm2, 0)} mm²`;
    case "cm":
      return `${r(mm2 / 100, 2)} cm²`;
    case "m":
      return `${r(mm2 / 1e6, 4)} m²`;
    default:
      return `${r(mm2 / MM2_PER_IN2, 2)} in²`;
  }
}

/** The unit a bare number means for a display format. */
export function bareUnitFor(unit: LengthFormat): LengthField["u"] {
  return unit === "mm" ? "mm" : unit === "cm" ? "cm" : unit === "m" ? "m" : "in";
}

export function describeNotes(notes: readonly ExtractNote[], unit: LengthFormat): string[] {
  const out: string[] = [];
  for (const n of notes) {
    if (n.kind === "helper") out.push(`${n.count} helper line${n.count === 1 ? "" : "s"} ignored (bend/centre)`);
    else if (n.kind === "duplicates") out.push(`${n.count} duplicate line${n.count === 1 ? "" : "s"} removed`);
    else if (n.kind === "gap-closed") out.push(`gap up to ${fmtMm(n.maxGap, unit)} closed`);
    else out.push(`${n.count} separate outer contours`);
  }
  return out;
}

export function describeCnc(warnings: readonly CncWarning[], unit: LengthFormat): string[] {
  return warnings.map((w) =>
    w.kind === "small-holes"
      ? `${w.count} hole${w.count === 1 ? "" : "s"} smaller than the bit (min ${fmtMm(w.smallestDiameter, unit)} vs ${fmtMm(w.bitDiameter, unit)})`
      : `${w.count} inside corner${w.count === 1 ? "" : "s"} the bit cannot reach (radius ${fmtMm(w.cornerRadius, unit)})`,
  );
}

export function cncInfoSummary(info: CncInfo): string {
  return `${info.holes.length} hole${info.holes.length === 1 ? "" : "s"}, ${info.corners} inside corner${info.corners === 1 ? "" : "s"}`;
}

// ---------- hints ----------

/**
 * Names the problems behind a disabled Calculate ("PN-0009: no DXF file found
 * in the folder") instead of the bare field name. Lists up to `max`, then
 * "+N more".
 */
export function problemHint(problems: readonly { name: string; reason: string }[], max = 3): string {
  const shown = problems.slice(0, max).map((p) => `${p.name}: ${p.reason}`);
  if (problems.length > max) shown.push(`+${problems.length - max} more`);
  return shown.join("; ");
}

const ENGINE_BLURB: Record<EngineId, string> = {
  raster: "Raster: the default - fast, handles any quantity and fills part holes automatically. Pick True shape for few large parts with tight kerf, or when you need exact clearance or mirroring.",
  "true-shape": "True shape: exact outlines, no grid rounding. Best for few large parts, tight kerf, exact clearance or mirroring; slower, and limited to a few hundred pieces per run.",
};

/** What the raster engine reports after a run when a part opts out of hole filling; shown before Calculate too. */
export const RASTER_HOLE_NOTE = "The raster engine fills part holes automatically; per-part hole opt-out is ignored.";

/**
 * The text under the Engine select: the selected engine's description first,
 * then every reason it cannot honour an option the job asks for (its
 * `supports()` result, plus the raster hole opt-out note that is otherwise
 * only reported after a run).
 */
export function engineHintLines(engine: EngineId, job: Pick<NestJob, "parts">, unsupported: readonly { reason: string }[]): string[] {
  const lines = [ENGINE_BLURB[engine]];
  for (const u of unsupported) if (!lines.includes(u.reason)) lines.push(u.reason);
  if (engine === "raster" && job.parts.some((p) => p.qty > 0 && !p.allowInHoles) && !lines.includes(RASTER_HOLE_NOTE)) lines.push(RASTER_HOLE_NOTE);
  return lines;
}

// ---------- groups ----------

const MAT_DEFAULT: MaterialId = "al5052";

/**
 * Groups BOM rows by material + thickness (first-seen order). Rows whose
 * material could not be classified go to `fallbackMaterial`. Each group gets
 * the material's first standard sheet and default rotation; a row with no
 * quantity counts as 1 (the panel shows it so it can be fixed). Repeated part
 * numbers inside a group are summed.
 */
export function groupsFromRows(rows: readonly SheetRow[], fallbackMaterial: MaterialId = MAT_DEFAULT): JobGroup[] {
  const sheets = defaultSheets().sizes;
  const out: JobGroup[] = [];
  for (const r of rows) {
    if (!r.num) continue;
    const material = (r.mat ?? fallbackMaterial) as MaterialId;
    const id = `${material}|${r.thick}`;
    let g = out.find((x) => x.id === id);
    if (!g) {
      g = { id, material, thickness: r.thick, sheet: { ...sheets[material][0]! }, rotation: defaultRotationFor(material), items: [] };
      out.push(g);
    }
    const qty = r.qty !== null && r.qty >= 1 ? Math.floor(r.qty) : 1;
    const existing = g.items.find((it) => it.num === r.num);
    if (existing) existing.qty += qty;
    else g.items.push({ num: r.num, qty });
  }
  return out;
}

// ---------- results ----------

export interface CombinedResult {
  result: RasterNestResult;
  /** For each sheet of the combined result, the index of the group (run) it came from. */
  sheetRun: number[];
}

/** Merges per-group results into one: sheets, stock rows and placement indices are re-based so the rest of the pipeline sees a single nest. */
export function combineResults(results: readonly RasterNestResult[]): CombinedResult {
  const out: RasterNestResult = { sheets: [], placed: [], unplaced: [], utilisation: 0, stock: [], purchased: [], cellMm: 0, iterations: 0, ms: 0, lbSheets: 0, notes: [] };
  const sheetRun: number[] = [];
  let area = 0;
  let net = 0;
  results.forEach((r, run) => {
    const sheetBase = out.sheets.length;
    const stockBase = out.stock.length;
    const placedBase = out.placed.length;
    for (const s of r.sheets) {
      out.sheets.push({ ...s, stockIndex: s.stockIndex + stockBase });
      sheetRun.push(run);
      const a = s.width * s.height;
      area += a;
    }
    net += r.utilisation * r.sheets.reduce((n, s) => n + s.width * s.height, 0);
    for (const p of r.placed) {
      out.placed.push({ ...p, sheet: p.sheet + sheetBase, ...(p.insideOfPlacementIndex !== undefined ? { insideOfPlacementIndex: p.insideOfPlacementIndex + placedBase } : {}) });
    }
    out.unplaced.push(...r.unplaced);
    out.stock.push(...r.stock);
    out.purchased.push(...r.purchased);
    out.cellMm = Math.max(out.cellMm, r.cellMm);
    out.iterations += r.iterations;
    out.ms += r.ms;
    out.lbSheets += r.lbSheets;
    for (const n of r.notes) if (!out.notes.includes(n)) out.notes.push(n);
  });
  out.utilisation = area > 0 ? net / area : 0;
  return { result: out, sheetRun };
}

/**
 * `groupIdenticalSheets` per group (run): sheets of two groups never merge,
 * even when size and layout happen to match (they are different material or
 * thickness). Result is ordered by each group's first sheet.
 */
export function groupIdenticalSheetsPerRun(
  sheets: readonly TrueNestSheet[],
  placements: readonly (SignaturePlacement & { sheet: number })[],
  sheetRun: readonly number[],
): SheetGroup[] {
  const out: SheetGroup[] = [];
  for (const run of new Set(sheetRun)) {
    const idx = sheets.map((_, i) => i).filter((i) => (sheetRun[i] ?? 0) === run);
    const local = new Map(idx.map((g, l) => [g, l]));
    const sub = placements.filter((p) => local.has(p.sheet)).map((p) => ({ ...p, sheet: local.get(p.sheet)! }));
    for (const g of groupIdenticalSheets(idx.map((i) => sheets[i]!), sub)) out.push({ ...g, indices: g.indices.map((l) => idx[l]!) });
  }
  return out.sort((a, b) => a.indices[0]! - b.indices[0]!);
}

export interface StockUsageRow {
  name: string;
  width: number;
  height: number;
  used: number;
  /** Sheets of this size that were bought (not taken from inventory). */
  purchased: number;
  /** Inventory quantity, null = unlimited / standard. */
  available: number | null;
}

/** One row per distinct stock size actually used. */
export function stockUsage(result: RasterNestResult, source: NestJob["sheetSource"]): StockUsageRow[] {
  const rows = new Map<string, StockUsageRow>();
  result.sheets.forEach((s, i) => {
    const row = result.stock[s.stockIndex];
    const key = `${s.stockIndex}`;
    let r = rows.get(key);
    if (!r) {
      r = { name: row?.size.name ?? "Sheet", width: s.width, height: s.height, used: 0, purchased: 0, available: row?.qty ?? null };
      rows.set(key, r);
    }
    r.used += 1;
    // Sheets are only bought from stock-on-hand with buy-extra; a standard sheet is unlimited, not purchased.
    if (source === "stock" && result.purchased[i]) r.purchased += 1;
  });
  return [...rows.values()];
}

export interface ResultKpis {
  sheets: number;
  toPurchase: number;
  /** True only in stock-on-hand mode: the To-purchase KPI and Buy column exist only there. */
  showPurchase: boolean;
  utilisation: number;
  placed: number;
  required: number;
  cutLengthMm: number;
  pierces: number;
  unplaced: number;
}

export function resultKpis(
  result: RasterNestResult,
  source: NestJob["sheetSource"],
  required: number,
  cut: { cutLengthMm: number; pierces: number },
): ResultKpis {
  const toPurchase = source === "stock" ? result.purchased.filter(Boolean).length : 0;
  return {
    sheets: result.sheets.length,
    toPurchase,
    showPurchase: source === "stock",
    utilisation: result.utilisation,
    placed: result.placed.length,
    required,
    cutLengthMm: cut.cutLengthMm,
    pierces: cut.pierces,
    unplaced: result.unplaced.reduce((n, u) => n + u.count, 0),
  };
}

// ---------- job file ----------

export const JOB_FILE_FORMAT = "sketchor-nest";

export interface JobFileFile {
  key: string;
  name: string;
  kind: "dxf";
  text: string;
  /** `$INSUNITS` code the user forced for this file, or null for the file's own. */
  unit: number | null;
}

export interface JobFile {
  format: typeof JOB_FILE_FORMAT;
  version: 1;
  job: unknown;
  files: JobFileFile[];
  custom?: unknown;
  bomText?: string;
}

export function serializeJobFile(job: NestJob, files: JobFileFile[], extra: { custom?: unknown; bomText?: string } = {}): string {
  const f: JobFile = { format: JOB_FILE_FORMAT, version: 1, job, files, ...(extra.custom !== undefined ? { custom: extra.custom } : {}), ...(extra.bomText ? { bomText: extra.bomText } : {}) };
  return JSON.stringify(f);
}

/** Reads a `.sketchor-nest` file; null when it is not one. Never throws. */
export function parseJobFile(text: string): JobFile | null {
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    return null;
  }
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  if (o.format !== JOB_FILE_FORMAT || !o.job || typeof o.job !== "object") return null;
  const files: JobFileFile[] = [];
  if (Array.isArray(o.files)) {
    for (const f of o.files) {
      if (!f || typeof f !== "object") continue;
      const r = f as Record<string, unknown>;
      if (typeof r.key !== "string" || typeof r.name !== "string" || typeof r.text !== "string") continue;
      files.push({ key: r.key, name: r.name, kind: "dxf", text: r.text, unit: typeof r.unit === "number" && Number.isFinite(r.unit) ? r.unit : null });
    }
  }
  return { format: JOB_FILE_FORMAT, version: 1, job: o.job, files, custom: o.custom, bomText: typeof o.bomText === "string" ? o.bomText : undefined };
}
