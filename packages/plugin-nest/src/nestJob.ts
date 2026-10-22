import {
  defaultMachines,
  defaultRotationFor,
  defaultSheets,
  MACHINES,
  MATERIALS,
  rotationAngles,
  ROTATION_STEP_DEG,
  type LengthField,
  type MachineId,
  type MachineParams,
  type MaterialId,
  type RotationCode,
  type SheetSize,
} from "./catalog";
import type { PartRotationSpec } from "./rotation";
import type { StockRow } from "./stock";
import type { Gravity, TrueNestPart } from "./trueNest";
import type { SearchLevel } from "./search";
import type { LengthFormat } from "./units";
import { parseLen } from "./units";
import type { RasterAccuracy, RasterNestPart } from "./raster/rasterNest";
import type { Point } from "./types";

/**
 * The nesting job model (RN-20): everything a run needs, in one plain
 * serialisable value shared by both engines, the panel and "Save job". The
 * shape follows the reference calculator's setup (material, sheet, thickness,
 * machine, cutting parameters, per-part rotation, accuracy, time budget) with
 * lengths kept as typed `LengthField`s so what the user typed is what comes
 * back. Catalog values stay in inches (estimates); this module converts to mm
 * for the engines.
 *
 * Why it is worth testing: a job comes from persisted plugin storage, which
 * may be empty, from an older version, or hand-edited. `parseNestJob` must
 * always return a usable job and `jobFromLegacyState` must carry a user's
 * stock rows and per-part settings over from the pre-RN panel instead of
 * dropping them - silently losing someone's stock list is the failure to
 * guard against.
 */

export type EngineId = "raster" | "true-shape";
export type SheetSource = "standard" | "stock";
export type JobMode = "manual" | "groups";

export interface JobPart {
  /** Stable key of the part (its sorted source entity ids, or a file name). */
  key: string;
  /** Source entity ids in the document, when the part came from the canvas. */
  sourceIds: string[];
  name?: string;
  qty: number;
  rotation: RotationCode;
  /** True shape only; the raster engine ignores it. */
  mirror: boolean;
  /** True shape only: raster fills holes automatically. */
  allowInHoles: boolean;
}

/** A BOM item in groups mode, before its file is resolved. */
export interface JobGroupItem {
  num: string;
  qty: number;
}

/** Groups mode: parts of one material + thickness, nested together. */
export interface JobGroup {
  id: string;
  material: MaterialId;
  /** Inches as typed ("1/8"). */
  thickness: string;
  sheet: SheetSize;
  rotation: RotationCode;
  items: JobGroupItem[];
}

export interface NestJob {
  version: 1;
  engine: EngineId;
  mode: JobMode;
  material: MaterialId;
  thickness: LengthField;
  machine: MachineId;
  /** Cutting parameters of the chosen machine (a copy the user may edit). */
  params: MachineParams;
  sheetSource: SheetSource;
  /** The standard sheet to cut from (inches, from the catalog or custom). */
  sheet: SheetSize;
  /** With `sheetSource: "stock"`: inventory in mm. */
  stock: StockRow[];
  /** With stock: also allow buying more of `sheet` once the stock runs out. */
  buyExtra: boolean;
  parts: JobPart[];
  groups: JobGroup[];
  accuracy: RasterAccuracy;
  /** Optimisation budget, ms (0 = first result). */
  timeMs: number;
  outputUnit: LengthFormat;
  // True-shape options carried over from the pre-RN panel.
  gravity: Gravity;
  minHoleArea: number;
  searchLevel: SearchLevel;
  joinTolerance?: number;
}

const GRAVITIES: Gravity[] = ["bottom-left", "bottom-right", "top-left", "top-right"];
const SEARCH_LEVELS: SearchLevel[] = ["quick", "normal", "thorough"];
const ACCURACIES: RasterAccuracy[] = ["fast", "normal", "precise"];
const OUTPUT_UNITS: LengthFormat[] = ["in", "indec", "ftin", "mm", "cm", "m"];
const ROTATION_CODES: RotationCode[] = ["none", "flip", "r90", "r45", "r30", "r15", "r10", "free"];
const UNITS = ["in", "ft", "mm", "cm", "m"] as const;
const MM_PER_IN = 25.4;
const MAX_QTY = 100000;

/** Default job: raster engine, aluminium on a laser, first standard sheet. */
export function defaultJob(): NestJob {
  const material: MaterialId = "al5052";
  const machine: MachineId = "laser";
  return {
    version: 1,
    engine: "raster",
    mode: "manual",
    material,
    thickness: { v: "1/8", u: "in" },
    machine,
    params: defaultMachines().machines[machine],
    sheetSource: "standard",
    sheet: { ...defaultSheets().sizes[material][0]! },
    stock: [],
    buyExtra: false,
    parts: [],
    groups: [],
    accuracy: "normal",
    timeMs: 10_000,
    outputUnit: "in",
    gravity: "bottom-left",
    minHoleArea: 0,
    searchLevel: "quick",
  };
}

// ---------- tolerant readers ----------

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
function num(v: unknown, fallback: number): number {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN;
  return Number.isFinite(n) ? n : fallback;
}
const str = (v: unknown, fallback = ""): string => (typeof v === "string" ? v : fallback);
function oneOf<T extends string>(v: unknown, list: readonly T[], fallback: T): T {
  return list.includes(v as T) ? (v as T) : fallback;
}

function readLength(v: unknown, fallback: LengthField): LengthField {
  if (!isObj(v)) return { ...fallback };
  const u = oneOf(v.u, UNITS, fallback.u);
  const raw = typeof v.v === "number" && Number.isFinite(v.v) ? String(v.v) : str(v.v, fallback.v);
  return { v: raw, u };
}

function readSheet(v: unknown, fallback: SheetSize): SheetSize {
  if (!isObj(v)) return { ...fallback };
  const w = num(v.w, fallback.w), h = num(v.h, fallback.h);
  return w > 0 && h > 0 ? { w, h } : { ...fallback };
}

function readParams(v: unknown, fallback: MachineParams): MachineParams {
  const o = isObj(v) ? v : {};
  return {
    kerf: readLength(o.kerf, fallback.kerf),
    web: readLength(o.web, fallback.web),
    margin: readLength(o.margin, fallback.margin),
    clamp: readLength(o.clamp, fallback.clamp),
    bedW: readLength(o.bedW, fallback.bedW),
    bedH: readLength(o.bedH, fallback.bedH),
  };
}

function readStockRow(v: unknown): StockRow | null {
  if (!isObj(v)) return null;
  const size = isObj(v.size) ? v.size : {};
  const width = num(size.width, 0), height = num(size.height, 0);
  if (!(width > 0 && height > 0)) return null;
  const qty = v.qty === null || v.qty === undefined || v.qty === "" ? null : Math.max(0, Math.floor(num(v.qty, 0)));
  const thickness = v.thickness === undefined || v.thickness === null || v.thickness === "" ? undefined : Math.max(0, num(v.thickness, 0));
  const cost = v.cost === undefined || v.cost === null || v.cost === "" ? undefined : Math.max(0, num(v.cost, 0));
  const material = str(v.material);
  return {
    size: { name: str(size.name) || "Sheet", width, height },
    ...(material ? { material } : {}),
    ...(thickness !== undefined ? { thickness } : {}),
    qty,
    ...(cost !== undefined ? { cost } : {}),
  };
}

function readPart(v: unknown, material: string): JobPart | null {
  if (!isObj(v)) return null;
  const key = str(v.key);
  if (!key) return null;
  return {
    key,
    sourceIds: Array.isArray(v.sourceIds) ? v.sourceIds.filter((x): x is string => typeof x === "string") : [],
    ...(typeof v.name === "string" ? { name: v.name } : {}),
    qty: Math.max(0, Math.min(MAX_QTY, Math.floor(num(v.qty, 1)))),
    rotation: oneOf(v.rotation, ROTATION_CODES, defaultRotationFor(material)),
    mirror: !!v.mirror,
    allowInHoles: !!v.allowInHoles,
  };
}

function readGroup(v: unknown): JobGroup | null {
  if (!isObj(v)) return null;
  const material = oneOf(v.material, MATERIALS.map((m) => m.id), "al5052");
  const items = Array.isArray(v.items)
    ? v.items
        .map((it): JobGroupItem | null => (isObj(it) && str(it.num) ? { num: str(it.num), qty: Math.max(1, Math.min(MAX_QTY, Math.floor(num(it.qty, 1)))) } : null))
        .filter((x): x is JobGroupItem => x !== null)
    : [];
  return {
    id: str(v.id) || material,
    material,
    thickness: str(v.thickness),
    sheet: readSheet(v.sheet, defaultSheets().sizes[material][0]!),
    rotation: oneOf(v.rotation, ROTATION_CODES, defaultRotationFor(material)),
    items,
  };
}

/** Reads any stored value into a valid job. Never throws; unknown or malformed fields fall back to defaults. */
export function parseNestJob(v: unknown): NestJob {
  const d = defaultJob();
  if (!isObj(v)) return d;
  const material = oneOf(v.material, MATERIALS.map((m) => m.id), d.material);
  const machine = oneOf(v.machine, MACHINES, d.machine);
  const sheetFallback = defaultSheets().sizes[material][0] ?? d.sheet;
  const stock = Array.isArray(v.stock) ? v.stock.map(readStockRow).filter((s): s is StockRow => s !== null) : [];
  const sheetSource = oneOf(v.sheetSource, ["standard", "stock"] as const, d.sheetSource);
  return {
    version: 1,
    engine: oneOf(v.engine, ["raster", "true-shape"] as const, d.engine),
    mode: oneOf(v.mode, ["manual", "groups"] as const, d.mode),
    material,
    thickness: readLength(v.thickness, d.thickness),
    machine,
    params: readParams(v.params, defaultMachines().machines[machine]),
    // A "stock" job with no usable rows cannot run: fall back to the standard sheet.
    sheetSource: sheetSource === "stock" && stock.length === 0 ? "standard" : sheetSource,
    sheet: readSheet(v.sheet, sheetFallback),
    stock,
    buyExtra: !!v.buyExtra,
    parts: Array.isArray(v.parts) ? v.parts.map((p) => readPart(p, material)).filter((p): p is JobPart => p !== null) : [],
    groups: Array.isArray(v.groups) ? v.groups.map(readGroup).filter((g): g is JobGroup => g !== null) : [],
    accuracy: oneOf(v.accuracy, ACCURACIES, d.accuracy),
    timeMs: Math.max(0, Math.min(3_600_000, num(v.timeMs, d.timeMs))),
    outputUnit: oneOf(v.outputUnit, OUTPUT_UNITS, d.outputUnit),
    gravity: oneOf(v.gravity, GRAVITIES, d.gravity),
    minHoleArea: Math.max(0, num(v.minHoleArea, 0)),
    searchLevel: oneOf(v.searchLevel, SEARCH_LEVELS, d.searchLevel),
    ...(v.joinTolerance === undefined || v.joinTolerance === null ? {} : { joinTolerance: Math.max(0, Math.min(0.5, num(v.joinTolerance, 0))) }),
  };
}

// ---------- migration from the pre-RN panel ----------

/** The rotation code closest to a legacy per-part setting. */
export function rotationCodeFromLegacy(mode: unknown, stepDeg: unknown): RotationCode {
  if (mode === "locked") return "none";
  if (mode === "any") {
    const step = num(stepDeg, 15);
    // Finest code whose step is not finer than requested, else the finest available.
    const coarse = (["r90", "r45", "r30", "r15", "r10", "free"] as const).find((c) => ROTATION_STEP_DEG[c] <= step);
    return coarse ?? "free";
  }
  return "r90";
}

/**
 * Carries the old `nestPlugin.ts` PersistedState (mm stock rows, working
 * parts with per-part settings, spacing/kerf/margin, true-shape options) into
 * a job. The migrated job keeps the **true-shape** engine - it is what that
 * user's results came from - and every length is stored in mm, so nothing
 * changes numerically: old kerf and old spacing become kerf and web.
 */
export function jobFromLegacyState(v: unknown): NestJob {
  const o = isObj(v) ? v : {};
  const d = defaultJob();
  const stock = Array.isArray(o.stock) ? o.stock.map(readStockRow).filter((s): s is StockRow => s !== null) : [];
  const withThickness = stock.find((s) => s.thickness !== undefined);
  const mm = (x: unknown): LengthField => ({ v: String(Math.max(0, num(x, 0))), u: "mm" });
  const parts: JobPart[] = [];
  for (const p of Array.isArray(o.workingParts) ? o.workingParts : []) {
    if (!isObj(p)) continue;
    const key = str(p.key);
    const sourceIds = Array.isArray(p.sourceIds) ? p.sourceIds.filter((x): x is string => typeof x === "string") : [];
    if (!key || sourceIds.length === 0) continue;
    const s = isObj(p.settings) ? p.settings : {};
    parts.push({
      key,
      sourceIds,
      qty: Math.max(0, Math.min(MAX_QTY, Math.floor(num(s.quantity, 1)))),
      rotation: rotationCodeFromLegacy(s.rotationMode ?? "quarter", s.stepDeg),
      mirror: !!s.mirror,
      allowInHoles: !!s.allowInHoles,
    });
  }
  return parseNestJob({
    ...d,
    engine: "true-shape",
    machine: "other",
    params: { kerf: mm(o.kerf), web: mm(o.spacing), margin: mm(o.edgeMargin), clamp: mm(0), bedW: { v: "", u: "mm" }, bedH: { v: "", u: "mm" } },
    sheetSource: stock.length > 0 ? "stock" : "standard",
    stock,
    thickness: withThickness ? { v: String(withThickness.thickness), u: "mm" } : d.thickness,
    outputUnit: "mm",
    parts,
    gravity: o.gravity,
    minHoleArea: o.minHoleArea,
    searchLevel: o.searchLevel,
    joinTolerance: o.joinTolerance,
  });
}

// ---------- job -> engine inputs (mm) ----------

/** A length field in mm; 0 when empty or unparseable. */
export function lengthMm(f: LengthField): number {
  const inches = parseLen(f.v, f.u);
  return Number.isFinite(inches) ? inches * MM_PER_IN : 0;
}

export interface JobParamsMm {
  kerf: number;
  web: number;
  /** Gap between parts: kerf + web. */
  spacing: number;
  margin: number;
  clamp: number;
  /** Machine bed, mm; null when unknown. */
  bed: { width: number; height: number } | null;
  thickness: number;
}

export function jobParamsMm(job: NestJob): JobParamsMm {
  const p = job.params;
  const kerf = lengthMm(p.kerf), web = lengthMm(p.web);
  const bw = lengthMm(p.bedW), bh = lengthMm(p.bedH);
  return {
    kerf,
    web,
    spacing: kerf + web,
    margin: lengthMm(p.margin),
    clamp: lengthMm(p.clamp),
    bed: bw > 0 && bh > 0 ? { width: bw, height: bh } : null,
    thickness: lengthMm(job.thickness),
  };
}

const sheetRowMm = (s: SheetSize, name?: string): StockRow => ({
  size: { name: name ?? `${s.w}x${s.h} in`, width: s.w * MM_PER_IN, height: s.h * MM_PER_IN },
  qty: null,
});

/** Inventory and purchase size in mm for the engines. Standard source = the chosen sheet, unlimited. */
export function jobSheets(job: NestJob): { stock: StockRow[]; extra: { name: string; width: number; height: number } | null } {
  if (job.sheetSource === "stock" && job.stock.length > 0) {
    const row = sheetRowMm(job.sheet);
    return { stock: job.stock, extra: job.buyExtra ? { name: row.size.name, width: row.size.width, height: row.size.height } : null };
  }
  return { stock: [sheetRowMm(job.sheet)], extra: null };
}

/** Rotation code -> the True-shape engine's spec. `flip` has no equivalent there (it becomes locked and `supports` says so). */
export function rotationSpecFor(code: RotationCode, mirror = false): PartRotationSpec {
  if (code === "none" || code === "flip") return { mode: "locked", mirror };
  if (code === "r90") return { mode: "quarter", mirror };
  return { mode: "any", stepDeg: ROTATION_STEP_DEG[code], mirror };
}

export interface JobPartGeometry {
  id?: string;
  name: string;
  outer: Point[];
  holes: Point[][];
}

/** Job parts joined with their resolved geometry (looked up by `key`); parts without geometry are skipped. */
export function jobParts(job: NestJob, geometry: ReadonlyMap<string, JobPartGeometry>): RasterNestPart[] {
  const out: RasterNestPart[] = [];
  for (const p of job.parts) {
    const g = geometry.get(p.key);
    if (!g || p.qty <= 0) continue;
    const base: TrueNestPart = {
      id: g.id ?? p.key,
      name: p.name ?? g.name,
      outer: g.outer,
      holes: g.holes,
      quantity: p.qty,
      rotation: rotationSpecFor(p.rotation, p.mirror),
      allowInHoles: p.allowInHoles,
    };
    out.push({ ...base, angles: rotationAngles(p.rotation) });
  }
  return out;
}
