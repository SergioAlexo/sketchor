import {
  area as polygonArea,
  bareUnitFor,
  bedWarning,
  bounds,
  buildSideBySideLayout,
  cncInfoForPart,
  cncWarnings,
  combineResults,
  computeJobMetrics,
  cutTableRowFor,
  cutRowForThickness,
  resolveCutSpeeds,
  type CutSpeeds,
  defaultJob,
  defaultMachines,
  defaultRotationFor,
  defaultSheets,
  describeCnc,
  describeGroup,
  describeNotes,
  effectiveClamp,
  engineFor,
  engineHintLines,
  extractPartsWithDiagnostics,
  mergeIntoOnePart,
  newMachineProfile,
  parseMachineProfile,
  serializeMachineProfile,
  profileRowFor,
  profileMotionMm,
  type MachineProfile,
  runBarCalc,
  runTubeCalc,
  parseBarInput,
  parseTubeInput,
  FALLBACK_RAPID_MM_PER_MIN,
  type PartPiece,
  openChainMarks,
  type OpenChainInfo,
  fmtDuration,
  fmtMm,
  fmtMm2,
  fmtSpeed,
  groupIdenticalSheetsPerRun,
  problemHint,
  groupsFromRows,
  parseSheetText,
  AMADA_PRESETS,
  amadaPreset,
  machineFromPreset,
  parsePartsCsv,
  groupsFromCsvRows,
  groupThickness,
  groupRunJob,
  resolveItem,
  sumRepeatedRows,
  type JobGroup,
  jobParamsMm,
  jobParts,
  jobReadiness,
  jobSheets,
  lengthMm,
  validDue,
  makeZip,
  materializeInstance,
  MACHINES,
  MATERIALS,
  NEST_CREDIT,
  NEST_HOLES_LAYER,
  NEST_PARTS_LAYER,
  parseJobFile,
  parseLen,
  parseNestJob,
  placementTransform,
  resultKpis,
  serializeJobFile,
  sheetDxfEntities,
  sheetDxfFileName,
  sheetOutlineEntities,
  stackedSheetsDxfEntities,
  stockUsage,
  findRemnants,
  applyRemnantsToStock,
  matchingRemnants,
  parseRemnantLibrary,
  remnantStockRows,
  updateRemnantLibrary,
  sameThickness,
  type LibraryRemnant,
  type Remnant,
  thicknessesFor,
  checkNestOverlaps,
  clampStripRect,
  sheetTitleHeight,
  type CncInfo,
  type CutTableRow,
  type DxfPreset,
  type ExtractNote,
  type JobFileFile,
  type JobMetrics,
  type JobPart,
  type LengthField,
  type MachineId,
  type MachineParams,
  type MaterialId,
  type NestJob,
  type RasterNestPart,
  type RasterNestResult,
  type RotationCode,
  type SheetSize,
  type StockRow,
  type TrueNestSheet,
} from "@sketchor/plugin-nest";
import { BUILTIN_POSTS, DEFAULT_POST_ID, buildCutPlan, builtinPost, isCustomPostId, parseCustomPosts, postProfileFromSpec, removeCustomPost, resolvePost, cutTimeSec, machineTimeSec, toolpathPreview, toolpathPreviewScale, upsertCustomPost, writeGcode, type GcodePlacement, type PostProfileSpec } from "@sketchor/plugin-gcode";

/** N-53: tab width used when a job asks for tabs but never set one. */
const DEFAULT_TAB_WIDTH_MM = 3;
import { entitiesToDxf, entityPoints, MM_PER_INSUNIT, parseDxf, scaleEntityKeepingInserts, textWidth, type Entity } from "@sketchor/core";
import { add, type DisplayUnitInfo, type PickedFolder, type PluginModule } from "@sketchor/plugin-sdk";
import { displayUnitToDxfCode, factorFromMm } from "../../units";
import { buildNestReportHtml, buildNestReportPdf, reportFileName, reportWithJob, type LastNest, type LastNestPlacement } from "./nestReport";
import { SHEET_NESTING_PANEL_HTML } from "./sheetNestingPanel";
import { barLayoutCommands, buildBarReportHtml, buildBarReportPdf } from "./barReport";
import { issueMarks, readManualNest, trayPositions, type ManualInstance, type ManualReadResult, type ManualSheet } from "./nestManual";

/**
 * "Sheet Nesting" (RN-30/31/32): the raster-first nesting panel, a separate
 * plugin (it replaced the older Sheet Metal Nest panel, now removed). The
 * state is one `NestJob`; Nest runs `engineFor(job.engine)` - the raster
 * engine by default, the exact "True shape" engine on request - streams the
 * best layout so far, and lands the result in a new canvas tab, the report,
 * DXF/ZIP and G-code. The panel is dumb: this module owns the job, validates
 * every field (orange = missing, green = ok) and sends a ready-to-render view
 * with lengths already formatted in the job's display unit.
 *
 * Nesting engine based on the Sheet Nesting Calculator by Oleksandr Borenko.
 */

export const PANEL_HTML = SHEET_NESTING_PANEL_HTML;

const KEY_JOB = "job";
const KEY_CUSTOM = "custom";
const KEY_FILES = "files";
const KEY_BOM = "bom";
const KEY_PROFILES = "machineProfiles";
const KEY_BARCALC = "barCalc";
const KEY_TUBECALC = "tubeCalc";
const KEY_REMNANTS = "remnantLibrary";
const MAX_PROFILES = 50;
/** Groups mode looks up DXF drawings only (DWG needs a conversion step; add the file in Manual mode). */
const DRAWING_EXTS = /\.dxf$/i;
const MATERIAL_NAMES: Record<string, string> = { al5052: "AL 5052", al6061: "AL 6061", ss: "Stainless", cs: "Carbon steel", plastic: "Plastic", plywood: "Plywood", stone: "Stone", quartz: "Quartz" };
const MM_PER_IN = 25.4;
const MAX_FILE_BYTES = 20_000_000;

/** Cutting-time seed table (laser estimates; a machine file or the panel's speeds win). */
const CUT_TABLE: CutTableRow[] = [
  { material: "Mild Steel", thickness: 1, feedRateMmPerMin: 6000, pierceTimeSec: 0.3, rapidMmPerMin: 15000, estimated: true, densityKgPerM3: 7850 },
  { material: "Mild Steel", thickness: 3, feedRateMmPerMin: 3500, pierceTimeSec: 0.6, rapidMmPerMin: 15000, estimated: true, densityKgPerM3: 7850 },
  { material: "Mild Steel", thickness: 6, feedRateMmPerMin: 1800, pierceTimeSec: 1.2, rapidMmPerMin: 12000, estimated: true, densityKgPerM3: 7850 },
  { material: "Mild Steel", thickness: 10, feedRateMmPerMin: 1000, pierceTimeSec: 2.5, rapidMmPerMin: 12000, estimated: true, densityKgPerM3: 7850 },
  { material: "Stainless Steel", thickness: 1, feedRateMmPerMin: 9000, pierceTimeSec: 0.3, rapidMmPerMin: 15000, estimated: true, densityKgPerM3: 8000 },
  { material: "Stainless Steel", thickness: 3, feedRateMmPerMin: 2800, pierceTimeSec: 0.8, rapidMmPerMin: 15000, estimated: true, densityKgPerM3: 8000 },
  { material: "Stainless Steel", thickness: 6, feedRateMmPerMin: 1000, pierceTimeSec: 1.8, rapidMmPerMin: 12000, estimated: true, densityKgPerM3: 8000 },
  { material: "Aluminum", thickness: 1, feedRateMmPerMin: 10000, pierceTimeSec: 0.2, rapidMmPerMin: 15000, estimated: true, densityKgPerM3: 2700 },
  { material: "Aluminum", thickness: 3, feedRateMmPerMin: 4500, pierceTimeSec: 0.4, rapidMmPerMin: 15000, estimated: true, densityKgPerM3: 2700 },
  { material: "Aluminum", thickness: 6, feedRateMmPerMin: 1500, pierceTimeSec: 1.2, rapidMmPerMin: 12000, estimated: true, densityKgPerM3: 2700 },
];

const CUT_MATERIAL_NAME: Partial<Record<MaterialId, string>> = { al5052: "Aluminum", al6061: "Aluminum", cs: "Mild Steel", ss: "Stainless Steel" };

type Pt = { x: number; y: number };

/** User-owned catalog edits: custom sheet sizes per material, the last-used machine parameters, and the user's own G-code post-processors (N-42). */
export interface Custom {
  sheets: Partial<Record<MaterialId, SheetSize[]>>;
  machines: Partial<Record<MachineId, MachineParams>>;
  posts: PostProfileSpec[];
}

/** A part ready to nest: geometry plus the entities its output is materialised from. */
export interface PartRec {
  key: string;
  name: string;
  outer: Pt[];
  holes: Pt[][];
  outerSourceIds: string[];
  holeSourceIds: string[][];
  lookup: Map<string, Entity>;
  area: number;
  w: number;
  h: number;
  cutLength: number;
  pierceCount: number;
  holeCount: number;
  notes: ExtractNote[];
  cnc: CncInfo;
  file?: string;
  /** NT-01: a file's separate outlines kept together as one part; each piece is cut as its own contour. */
  pieces?: PartPiece[];
}

/** One imported drawing file (manual "Add files" or a BOM item in groups mode). */
export interface FileRec {
  key: string;
  name: string;
  text: string;
  /** `$INSUNITS` code forced by the user, or null for the file's own. */
  unit: number | null;
  /** Unit that was actually used, as an `$INSUNITS` code (0 = none / mm as written). */
  usedUnit: number;
  unitGuessed: boolean;
  parts: PartRec[];
  warnings: string[];
  error?: string;
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const str = (v: unknown, fb = ""): string => (typeof v === "string" ? v : fb);
const num = (v: unknown, fb = 0): number => {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN;
  return Number.isFinite(n) ? n : fb;
};
const LENGTH_UNITS = ["in", "ft", "mm", "cm", "m"] as const;
const readField = (v: unknown, fb: LengthField): LengthField =>
  isObj(v) ? { v: typeof v.v === "string" ? v.v : typeof v.v === "number" ? String(v.v) : fb.v, u: (LENGTH_UNITS as readonly string[]).includes(str(v.u)) ? (v.u as LengthField["u"]) : fb.u } : fb;

/** A blank machine-speed field: the cutting-time estimate uses the built-in table instead. */
const NO_SPEED: LengthField = { v: "", u: "in" };

export function stableKey(sourceIds: string[]): string {
  return [...sourceIds].sort().join(",");
}

/** Builds a part record from an extracted part. */
export function recFromExtracted(
  p: { name: string; outer: Pt[]; holes: Pt[][]; outerSourceIds: string[]; holeSourceIds: string[][]; cutLength: number; pierceCount: number; holeCount: number; pieces?: PartPiece[]; netArea?: number },
  key: string,
  lookup: Map<string, Entity>,
  notes: ExtractNote[],
  file?: string,
): PartRec {
  const b = bounds(p.outer);
  const holesArea = p.holes.reduce((s, h) => s + polygonArea(h), 0);
  return {
    key,
    name: p.name,
    outer: p.outer,
    holes: p.holes,
    outerSourceIds: p.outerSourceIds,
    holeSourceIds: p.holeSourceIds,
    lookup,
    area: p.netArea ?? Math.max(0, polygonArea(p.outer) - holesArea),
    w: b.maxX - b.minX,
    h: b.maxY - b.minY,
    cutLength: p.cutLength,
    pierceCount: p.pierceCount,
    holeCount: p.holeCount,
    notes,
    cnc: cncInfoForPart(p),
    ...(file ? { file } : {}),
    ...(p.pieces && p.pieces.length > 1 ? { pieces: p.pieces } : {}),
  };
}

/** Parses one drawing file's text into parts. Never throws. `unit` forces the file's units ($INSUNITS code). */
export function loadDxfFile(key: string, name: string, text: string, unit: number | null, joinTolerance?: number): FileRec {
  const base: FileRec = { key, name, text, unit, usedUnit: 0, unitGuessed: false, parts: [], warnings: [] };
  try {
    const r = parseDxf(text, { blocks: "explode" });
    const detected = r.unitSource === "none" ? 1 : (MM_PER_INSUNIT[r.insUnits] ?? 1);
    const forced = unit !== null ? (MM_PER_INSUNIT[unit] ?? 1) : detected;
    const k = forced / detected;
    const entities = k !== 1 ? r.entities.map((e) => scaleEntityKeepingInserts(e, k)) : r.entities;
    base.usedUnit = unit ?? (r.unitSource === "none" ? 0 : r.insUnits);
    base.unitGuessed = unit === null && r.unitSource !== "insunits" && r.unitSource !== "measurement";
    base.warnings = r.warnings.slice(0, 5);
    const lookup = new Map(entities.map((e) => [e.id, e]));
    const { parts, openChains, notes } = extractPartsWithDiagnostics(entities, new Set(entities.map((e) => e.id)), { joinTolerance, singlePart: true });
    if (parts.length === 0) {
      base.error = openChains.length > 0 ? `${openChains.length} open shape(s) - no closed outline found` : "no closed shape found";
      return base;
    }
    // NT-01: one file is one part - separate outlines stay together, positioned as drawn.
    const merged = mergeIntoOnePart(parts, name)!;
    base.parts = [recFromExtracted(merged, `${key}#0`, lookup, notes.filter((n) => n.kind !== "multi-outer"), key)];
    if (parts.length > 1) base.warnings.push(`${parts.length} separate pieces - nested together as one part`);
    if (openChains.length > 0) base.warnings.push(`${openChains.length} open shape(s) ignored`);
    return base;
  } catch (err) {
    base.error = err instanceof Error ? err.message : String(err);
    return base;
  }
}

/**
 * Snapshots a canvas part: its outline and hole entities (exact lines, arcs,
 * bulges) are written to a DXF text and re-read as a drawing file, so the job
 * carries the geometry itself. That keeps the part valid whichever tab is
 * active, survives save/reopen (files are persisted and saved with the job),
 * and feeds DXF export and cut length from the same prims as the canvas.
 */
export function snapshotCanvasPart(
  part: { name: string; outerSourceIds: string[]; holeSourceIds: string[][] },
  lookup: ReadonlyMap<string, Entity>,
  fileKey: string,
  joinTolerance?: number,
): FileRec {
  const ids = [...part.outerSourceIds, ...part.holeSourceIds.flat()];
  const entities = ids.map((id) => lookup.get(id)).filter((e): e is Entity => e !== undefined);
  return loadDxfFile(fileKey, part.name, entitiesToDxf(entities, 4, 1), null, joinTolerance);
}

/** Manual nesting: at most this many parts are drawn in the "To nest" tray at once (the rest can be added from the panel). */
const MAX_TRAY = 200;
/** Gap between parts in the tray, mm. */
const TRAY_GAP = 40;

/** Mirror, rotate (degrees) then translate - the placement transform, applied to a polygon. */
function xformPts(pts: readonly Pt[], t: { rotationDeg: number; mirrored?: boolean; translation: Pt }): Pt[] {
  const a = (t.rotationDeg * Math.PI) / 180, c = Math.cos(a), s = Math.sin(a);
  return pts.map((p) => {
    const x = t.mirrored ? -p.x : p.x;
    return { x: c * x - s * p.y + t.translation.x, y: s * x + c * p.y + t.translation.y };
  });
}

function trayTitle(total: number, drawn: number): string {
  return `To nest: ${total} part${total === 1 ? "" : "s"} - drag onto a sheet${drawn < total ? ` (${drawn} shown)` : ""}`;
}

/**
 * One part waiting in the tray, unrotated, its box's lower-left at `at`
 * (canvas coordinates - the tray is not on a sheet).
 */
export function trayItem(rec: PartRec, id: string, number: number, at: Pt, ordered?: { name: string; priority?: "high" | "low"; due?: string }): ManualInstance {
  const t0 = placementTransform(rec.outer, { rotationDeg: 0, mirrored: false, translation: at });
  const ents = (ids: string[]) => ids.map((x) => rec.lookup.get(x)).filter((e): e is Entity => e !== undefined);
  const pieceSrc = (rec.pieces ?? [{ outerSourceIds: rec.outerSourceIds, holeSourceIds: rec.holeSourceIds }]).map((pc) => ({ outer: ents(pc.outerSourceIds), holes: ents(pc.holeSourceIds.flat()) }));
  const outerSource = pieceSrc.flatMap((pc) => pc.outer);
  const holeSource = pieceSrc.flatMap((pc) => pc.holes);
  const outerEntities = materializeInstance(outerSource, t0).map((e) => ({ ...e, layer: NEST_PARTS_LAYER }));
  const holeEntities = holeSource.length > 0 ? materializeInstance(holeSource, t0).map((e) => ({ ...e, layer: NEST_HOLES_LAYER })) : [];
  const outer = xformPts(rec.outer, t0);
  const b = bounds(outer);
  const labelHeight = Math.max(1, Math.min(Math.min(b.maxX - b.minX, b.maxY - b.minY) * 0.3, 12));
  const placement: LastNestPlacement = {
    sheet: -1,
    number,
    id,
    outerEntities,
    holeEntities,
    label: { at: { x: (b.minX + b.maxX) / 2 - textWidth(String(number), labelHeight) / 2, y: (b.minY + b.maxY) / 2 - labelHeight / 2 }, height: labelHeight },
    partId: rec.key,
    name: rec.name,
    rotationDeg: 0,
    mirrored: false,
    area: rec.area,
    ...(rec.pieces ? { pieces: pieceSrc.map((pc) => ({ outer: pc.outer.length, holes: pc.holes.length })) } : {}),
    ...(ordered?.priority ? { priority: ordered.priority } : {}),
    ...(ordered?.due ? { due: ordered.due } : {}),
  };
  return { id, placement, outer, holes: rec.holes.map((h) => xformPts(h, t0)), drawnAt: { x: 0, y: 0 }, home: -1 };
}

const plugin: PluginModule = {
  async activate(sketchor) {
    let unit: DisplayUnitInfo = { unit: "mm", perMm: 1, label: "mm" };
    try {
      unit = await sketchor.app.displayUnit();
    } catch {
      /* mm default */
    }

    let job: NestJob = parseNestJob(await sketchor.storage.get(KEY_JOB).catch(() => undefined));
    const customRaw = await sketchor.storage.get(KEY_CUSTOM).catch(() => undefined);
    const custom: Custom = { sheets: {}, machines: {}, posts: [] };
    if (isObj(customRaw)) {
      // Untrusted on the way back in (storage can be edited outside the app): re-validated like a fresh edit.
      custom.posts = parseCustomPosts(customRaw.posts);
      if (isObj(customRaw.sheets)) {
        for (const m of MATERIALS) {
          const list = (customRaw.sheets as Record<string, unknown>)[m.id];
          if (Array.isArray(list)) custom.sheets[m.id] = list.filter(isObj).map((s) => ({ w: num(s.w), h: num(s.h) })).filter((s) => s.w > 0 && s.h > 0);
        }
      }
      if (isObj(customRaw.machines)) {
        for (const m of MACHINES) {
          const mp = (customRaw.machines as Record<string, unknown>)[m];
          if (isObj(mp)) {
            const d = defaultMachines().machines[m];
            custom.machines[m] = { kerf: readField(mp.kerf, d.kerf), web: readField(mp.web, d.web), margin: readField(mp.margin, d.margin), clamp: readField(mp.clamp, d.clamp), bedW: readField(mp.bedW, d.bedW), bedH: readField(mp.bedH, d.bedH), ...(isObj(mp.feed) ? { feed: readField(mp.feed, NO_SPEED) } : {}), ...(isObj(mp.rapid) ? { rapid: readField(mp.rapid, NO_SPEED) } : {}), ...(typeof mp.pierce === "string" ? { pierce: mp.pierce.slice(0, 20) } : {}) };
          }
        }
      }
    }

    // Drawing files added with "Add files": text is persisted, geometry is re-derived.
    const files = new Map<string, FileRec>();
    const filesRaw = await sketchor.storage.get(KEY_FILES).catch(() => undefined);
    for (const f of Array.isArray(filesRaw) ? filesRaw : []) {
      if (isObj(f) && typeof f.key === "string" && typeof f.text === "string") {
        files.set(f.key, loadDxfFile(f.key, str(f.name, "part.dxf"), f.text, typeof f.unit === "number" ? f.unit : null, job.joinTolerance));
      }
    }

    // NT-02: the shop's machine files; NT-03/04: the calculators' last input.
    let profiles: MachineProfile[] = [];
    const profilesRaw = await sketchor.storage.get(KEY_PROFILES).catch(() => undefined);
    for (const raw of Array.isArray(profilesRaw) ? profilesRaw.slice(0, MAX_PROFILES) : []) {
      const pr = parseMachineProfile(raw, `m${profiles.length + 1}`);
      if (pr && !profiles.some((x) => x.id === pr.id)) profiles.push(pr);
    }
    let barInput = parseBarInput(await sketchor.storage.get(KEY_BARCALC).catch(() => undefined));
    let tubeInput = parseTubeInput(await sketchor.storage.get(KEY_TUBECALC).catch(() => undefined));
    const persistProfiles = () => void sketchor.storage.set(KEY_PROFILES, profiles).catch(() => undefined);
    // N-52: the offcut library, kept across jobs.
    let library: LibraryRemnant[] = parseRemnantLibrary(await sketchor.storage.get(KEY_REMNANTS).catch(() => undefined));
    const persistLibrary = () => void sketchor.storage.set(KEY_REMNANTS, library).catch(() => undefined);
    const newRemnantId = () => {
      for (let i = library.length + 1; ; i++) if (!library.some((x) => x.id === `r${i}`)) return `r${i}`;
    };
    /** Offcuts used by the last result, by library id. */
    let lastRemnantUse = new Map<string, number>();
    const newProfileId = () => {
      for (let i = profiles.length + 1; ; i++) if (!profiles.some((x) => x.id === `m${i}`)) return `m${i}`;
    };

    let lastNest: LastNest | null = null;
    /**
     * Manual nesting: every part drawn on the layout tab (sheets and the "To
     * nest" tray), the drawn sheets, and what the job ordered - so a read of
     * the canvas knows what moved, what overlaps and what is still to nest.
     */
    let manual: {
      instances: ManualInstance[];
      sheets: ManualSheet[];
      ordered: Map<string, { name: string; qty: number }>;
      recs: Map<string, PartRec>;
      nextNumber: number;
      nextTray: number;
      trayTop: number;
      trayWidth: number;
      trayTitled: boolean;
      labelHeight: number;
    } | null = null;
    let lastManual: ManualReadResult | null = null;
    let lastView: ResultView | null = null;
    /** Effective stock rows (with material / thickness) of the last result, for the G-code feed-rate lookup. */
    let lastStock: StockRow[] = [];
    /** N-52: offcuts of the last result and the inventory rows it consumed, until saved (or the next run). */
    let lastRemnants: { rem: Remnant; material?: string; materialId?: string; thickness?: number }[] = [];
    let lastUsed: number[] = [];
    /**
     * Multi-material results: per sheet, the kerf its group was nested with
     * (G-code offsets the path by it) and the group's file-name tag; plus the
     * smallest part gap of any group, for the layout checks. Empty / null for
     * a single-material result, which follows the job's current kerf.
     */
    let lastSheetKerf: number[] = [];
    let lastSheetTag: string[] = [];
    let lastGap: number | null = null;
    let cancelRequested = false;
    let running = false;
    let fileCounter = files.size;
    const lastLayoutHint = { bedWarn: false };

    // ---------- groups mode (RN-31) ----------

    let bomText = str(await sketchor.storage.get(KEY_BOM).catch(() => undefined));
    let folder: PickedFolder | null = null; // a folder grant lasts the session only
    const groupFiles = new Map<string, FileRec>(); // by relPath, loaded from the folder

    interface ItemStatus {
      num: string;
      qty: number;
      state: "nofolder" | "missing" | "failed" | "loading" | "ok";
      relPath?: string;
      per: number;
      need: number | null;
      error?: string;
    }

    /**
     * Drawings added with "Add drawings" / "Add files" as lookup entries, so a
     * list can be nested without a folder: `added/<file key>/<name>.dxf`.
     */
    const addedLookup = (): { relPath: string }[] =>
      [...files.values()].filter((f) => !f.error && f.parts.length > 0).map((f) => ({ relPath: `added/${f.key}/${f.name.replace(/[\\/]/g, "_")}${/\.dxf$/i.test(f.name) ? "" : ".dxf"}` }));
    /** The parsed drawing behind a resolved lookup path (folder file or added drawing). */
    const groupFileFor = (relPath: string): FileRec | undefined => (relPath.startsWith("added/") ? files.get(relPath.split("/")[1] ?? "") : groupFiles.get(relPath));
    /** Folder first (the shop's drawing library), then the drawings added to this job. */
    const resolveGroupItem = (it: { num: string; qty: number }) => {
      const inFolder = folder ? resolveItem(it.num, it.qty, folder.files, DRAWING_EXTS) : null;
      if (inFolder?.file) return inFolder;
      const added = addedLookup();
      return added.length > 0 ? resolveItem(it.num, it.qty, added, DRAWING_EXTS) : inFolder;
    };

    const itemStatus = (it: { num: string; qty: number }): ItemStatus => {
      const r = resolveGroupItem(it);
      if (!r) return { ...it, state: "nofolder", per: 1, need: null };
      if (!r.file) return { ...it, state: "missing", per: 1, need: r.need };
      const f = groupFileFor(r.file.relPath);
      if (!f) return { ...it, state: "loading", relPath: r.file.relPath, per: r.per, need: r.need };
      if (f.error) return { ...it, state: "failed", relPath: r.file.relPath, per: r.per, need: r.need, error: f.error };
      return { ...it, state: "ok", relPath: r.file.relPath, per: r.per, need: r.need };
    };

    /** Reads and parses every file the BOM items resolve to (once each). */
    const loadGroupFiles = async () => {
      if (!folder) return;
      const wanted = new Set<string>();
      for (const g of job.groups) for (const it of g.items) {
        const r = resolveItem(it.num, it.qty, folder.files, DRAWING_EXTS);
        if (r.file && !groupFiles.has(r.file.relPath)) wanted.add(r.file.relPath);
      }
      for (const relPath of wanted) {
        const name = relPath.split("/").pop() ?? relPath;
        try {
          const text = (await sketchor.ui.readPickedFile(relPath, "text")) as string;
          groupFiles.set(relPath, text.length > MAX_FILE_BYTES ? { ...loadDxfFile(relPath, name, "", null), error: "file too large" } : loadDxfFile(relPath, name, text, null, job.joinTolerance));
        } catch (err) {
          groupFiles.set(relPath, { key: relPath, name, text: "", unit: null, usedUnit: 0, unitGuessed: false, parts: [], warnings: [], error: err instanceof Error ? err.message : "could not read the file" });
        }
      }
    };

    const groupProblemCount = () => job.groups.reduce((n, g) => n + (g.items.length === 0 ? 1 : g.items.filter((it) => itemStatus(it).state !== "ok").length), 0);

    /**
     * Names what blocks Calculate on the parts: "PN-0009: no DXF file found in
     * the folder" (up to 3, then "+N more"), rather than the bare field name.
     * Empty when nothing is wrong with the parts.
     */
    const partsProblem = (recs: Map<string, PartRec>): string => {
      if (job.mode === "groups") {
        if (job.groups.length === 0) return "no groups yet - load a CSV or paste a parts list and click Groups from the list";
        if (!folder && addedLookup().length === 0) return "no drawings - choose a folder or add the DXF files";
        const probs: { name: string; reason: string }[] = [];
        for (const g of job.groups) {
          if (g.items.length === 0) probs.push({ name: groupLabel(g), reason: "group has no parts" });
          for (const it of g.items) {
            const st = itemStatus(it);
            if (st.state === "missing") probs.push({ name: it.num, reason: folder ? "no DXF file found in the folder or the added drawings" : "no added drawing has that name - add it or choose a folder" });
            else if (st.state === "failed") probs.push({ name: it.num, reason: st.error ?? "the drawing could not be read" });
          }
        }
        return problemHint(probs);
      }
      const probs = job.parts.filter((x) => !recs.has(x.key)).map((x) => ({ name: x.name ?? x.key, reason: "drawing no longer found - add it again" }));
      if (probs.length > 0) return problemHint(probs);
      if (job.parts.length === 0) return "no parts added";
      return job.parts.some((x) => x.qty > 0) ? "" : "every quantity is 0";
    };

    /** "Carbon steel 3 mm", "AL 5052 1/8\"" - a group's name in the panel, the report and file names. */
    const groupLabel = (g: JobGroup): string => {
      const t = g.thickness.trim();
      return `${MATERIAL_NAMES[g.material] ?? g.material}${t ? (g.thicknessUnit === "mm" ? ` ${t} mm` : ` ${t}"`) : ""}`;
    };

    /** A kerf in mm as a field in the machine file's unit (what applyProfile writes too). */
    const kerfField = (mm: number, u: "mm" | "in"): LengthField => (u === "in" ? { v: String(Math.round((mm / MM_PER_IN) * 10000) / 10000), u: "in" } : { v: String(Math.round(mm * 1000) / 1000), u: "mm" });

    /** The machine file's cut row for a group's material and thickness, when a sheet machine file is selected. */
    const groupProfileRow = (g: JobGroup) => {
      const prof = activeProfile();
      const t = lengthMm(groupThickness(g));
      return prof && t > 0 ? { prof, row: profileRowFor(prof, g.material, t) } : null;
    };

    /** Kerf the machine file gives a group (null = none: the job's kerf applies). */
    const profileKerfFor = (g: JobGroup): LengthField | null => {
      const m = groupProfileRow(g);
      return m?.row?.kerfMm ? kerfField(m.row.kerfMm, m.prof.units) : null;
    };

    const buildGroupRuns = (): Run[] => {
      const runs: Run[] = [];
      for (const g of job.groups) {
        // Items resolving to the same drawing are summed; the first item's rotation / priority / due date apply.
        const byFile = new Map<string, { need: number; item: (typeof g.items)[number] }>();
        for (const it of g.items) {
          const s = itemStatus(it);
          if (s.state !== "ok" || !s.relPath) continue;
          const cur = byFile.get(s.relPath);
          if (cur) cur.need += s.need ?? it.qty;
          else byFile.set(s.relPath, { need: s.need ?? it.qty, item: it });
        }
        const recs = new Map<string, PartRec>();
        const parts: JobPart[] = [];
        for (const [relPath, { need, item }] of byFile) {
          for (const p of groupFileFor(relPath)?.parts ?? []) {
            // The same drawing can sit in two groups (two thicknesses of one part): each run keeps its own key.
            const key = `${g.id}::${p.key}`;
            recs.set(key, { ...p, key });
            parts.push({
              key,
              sourceIds: [],
              name: p.name,
              qty: need,
              rotation: item.rotation ?? g.rotation,
              mirror: false,
              allowInHoles: false,
              ...(item.priority ? { priority: item.priority } : {}),
              ...(item.due ? { due: item.due } : {}),
            });
          }
        }
        runs.push({ label: groupLabel(g), job: groupRunJob(job, g, parts, profileKerfFor(g)), recs });
      }
      return runs;
    };

    const groupsView = () =>
      job.groups.map((g) => {
        const run = groupRunJob(job, g, [], profileKerfFor(g));
        const kerfMm = jobParamsMm(run).kerf;
        const m = groupProfileRow(g);
        const kerfFrom = g.kerf && g.kerf.v.trim() !== "" ? "group" : profileKerfFor(g) ? "machine" : "job";
        const machineHint = m
          ? m.row
            ? `${m.prof.name}: ${m.row.exact ? "cut row" : "estimated from the nearest rows"} - feed ${fmtSpeed(m.row.feedMmPerMin, job.outputUnit)}, pierce ${Math.round(m.row.pierceSec * 100) / 100} s${m.row.note ? ` (${m.row.note})` : ""}`
            : `${m.prof.name} has no cut row for ${MATERIAL_NAMES[g.material] ?? g.material} - the job's kerf and speeds apply.`
          : "";
        return {
        id: g.id,
        label: groupLabel(g),
        material: g.material,
        thickness: g.thickness,
        thicknessUnit: g.thicknessUnit ?? "in",
        kerf: g.kerf?.v ?? "",
        kerfUnit: g.kerf?.u ?? bareUnitFor(job.outputUnit),
        kerfAuto: fmtFine(kerfMm),
        kerfFrom,
        machineHint,
        sheet: g.sheet,
        rotation: g.rotation,
        // A size from the CSV's sheet column may not be in the catalog: list it first so the select shows what will be cut.
        sheetOptions: [...(sheetsFor(g.material).some((s) => sameSheet(s.size, g.sheet)) ? [] : [{ size: g.sheet, fromList: true }]), ...sheetsFor(g.material)].map((s) => ({
          w: s.size.w,
          h: s.size.h,
          label: `${fmtMm(s.size.w * MM_PER_IN, job.outputUnit)} × ${fmtMm(s.size.h * MM_PER_IN, job.outputUnit)}${"fromList" in s ? " (from the list)" : ""}`,
        })),
        thicknessOptions: thicknessesFor(g.material).map((t) => ({ value: t.value, label: t.label ? `${t.value}" · ${t.label}` : `${t.value}"` })),
        items: g.items.map((it) => {
          const s = itemStatus(it);
          const file = s.relPath?.startsWith("added/") ? `added: ${s.relPath.split("/").slice(2).join("/")}` : s.relPath;
          return { num: it.num, qty: it.qty, state: s.state, file, per: s.per, need: s.need, error: s.error, rotation: it.rotation ?? "", priority: it.priority ?? "", due: it.due ?? "" };
        }),
        };
      });

    const persistJob = () => void sketchor.storage.set(KEY_JOB, job).catch(() => undefined);
    const persistCustom = () => void sketchor.storage.set(KEY_CUSTOM, custom).catch(() => undefined);
    const persistFiles = () =>
      void sketchor.storage
        .set(KEY_FILES, [...files.values()].map((f): JobFileFile => ({ key: f.key, name: f.name, kind: "dxf", text: f.text, unit: f.unit })))
        .catch(() => undefined);
    const post = (m: Record<string, unknown>) => void sketchor.ui.postMessage(m);
    const notify = (message: string, error = false) => sketchor.ui.notify(message, { error });
    const fail = (message: string) => post({ type: "error", message });

    // ---------- catalog helpers ----------

    const sheetsFor = (material: MaterialId): { size: SheetSize; custom: boolean }[] => [
      ...defaultSheets().sizes[material].map((size) => ({ size, custom: false })),
      ...(custom.sheets[material] ?? []).map((size) => ({ size, custom: true })),
    ];
    const sameSheet = (a: SheetSize, b: SheetSize) => Math.abs(a.w - b.w) < 1e-6 && Math.abs(a.h - b.h) < 1e-6;

    // ---------- part resolution ----------

    const fileRecFor = (key: string): { rec: PartRec; file: FileRec } | null => {
      const hash = key.lastIndexOf("#");
      const f = files.get(hash > 0 ? key.slice(0, hash) : key);
      const rec = f?.parts.find((p) => p.key === key);
      return f && rec ? { rec, file: f } : null;
    };

    /**
     * Resolves every manual-mode part from its snapshot (never from the active
     * document); `missing` lists parts with no geometry (jobs saved before
     * snapshots existed). `sourceIds` is only the "refresh from drawing" link.
     */
    const resolveParts = async (): Promise<{ recs: Map<string, PartRec>; missing: JobPart[] }> => {
      const recs = new Map<string, PartRec>();
      const missing: JobPart[] = [];
      for (const p of job.parts) {
        const rec = fileRecFor(p.key)?.rec ?? null;
        if (rec) recs.set(p.key, rec);
        else missing.push(p);
      }
      return { recs, missing };
    };

    // ---------- view ----------

    const fmt = (mm: number) => fmtMm(mm, job.outputUnit);
    /** Kerf-sized lengths: `fmt` rounds mm to 0.1, which would show a 0.15 mm kerf as 0.2. */
    const fmtFine = (mm: number) => (["mm", "cm", "m"].includes(bareUnitFor(job.outputUnit)) ? `${Math.round(mm * 1000) / 1000} mm` : `${Math.round((mm / MM_PER_IN) * 10000) / 10000}"`);
    const num3 = (mm: number) => String(Math.round((bareUnitFor(job.outputUnit) === "in" ? mm / MM_PER_IN : bareUnitFor(job.outputUnit) === "cm" ? mm / 10 : bareUnitFor(job.outputUnit) === "m" ? mm / 1000 : mm) * 1000) / 1000);
    const thumbOf = (outer: Pt[]) => {
      const step = Math.max(1, Math.ceil(outer.length / 60));
      return outer.filter((_, i) => i % step === 0).map((p) => [Math.round(p.x * 100) / 100, Math.round(p.y * 100) / 100]);
    };

    const geometryMap = (recs: Map<string, PartRec>) => new Map([...recs].map(([k, r]) => [k, { id: k, name: r.name, outer: r.outer, holes: r.holes }]));

    /** A sheet's cutting speeds: its stock row's material / thickness against the cut table, with the machine's own values over that. */
    /** NT-02: the selected sheet machine file (a tube laser file is for the Tubes calculator only). */
    const activeProfile = (): MachineProfile | null => profiles.find((x) => x.id === job.profileId && x.type !== "tube") ?? null;
    const speedsForStock = (row: StockRow | undefined): CutSpeeds | null => {
      const prof = activeProfile();
      const m = prof && row?.materialId && row.thickness ? profileRowFor(prof, row.materialId, row.thickness) : null;
      if (prof && m) return { feedRateMmPerMin: m.feedMmPerMin, pierceTimeSec: m.pierceSec, rapidMmPerMin: profileMotionMm(prof).rapidMmPerMin || FALLBACK_RAPID_MM_PER_MIN, source: "profile" };
      return resolveCutSpeeds(job.machine, job.params, cutTableRowFor(row, CUT_TABLE));
    };
    /**
     * One sheet's machine time. With a machine file: acceleration, corner
     * stops, small-hole feed, head lift and the sheet load/unload time
     * (`machineTimeSec`); without one, length / feed + pierces + rapids.
     */
    const sheetTimeSec = (placements: LastNestPlacement[], i: number, row: StockRow | undefined): number | null => {
      const speeds = speedsForStock(row);
      if (!speeds) return null;
      const features = sheetCutPlan(placements, i).features;
      const prof = speeds.source === "profile" ? activeProfile() : null;
      if (!prof) return cutTimeSec(toolpathPreview(features).stats, speeds);
      const mo = profileMotionMm(prof);
      return machineTimeSec(features, { feedMmPerMin: speeds.feedRateMmPerMin, rapidMmPerMin: speeds.rapidMmPerMin, pierceSec: speeds.pierceTimeSec, cutAccel: mo.cutAccel, rapidAccel: mo.rapidAccel, headLiftSec: mo.headLiftSec, cornerAngleDeg: mo.cornerAngleDeg, smallHoleMm: mo.smallHoleMm, smallHoleFeedPct: mo.smallHoleFeedPct }).totalSec + mo.sheetLoadSec;
    };

    /** The built-in estimate for the job as set up now, shown greyed in the blank speed fields so the user sees what "blank" means. */
    const speedAutoView = () => {
      const prof = activeProfile();
      const pm = prof ? profileRowFor(prof, job.material, lengthMm(job.thickness)) : null;
      if (prof && pm) return { feedMm: pm.feedMmPerMin, rapidMm: profileMotionMm(prof).rapidMmPerMin, pierce: String(Math.round(pm.pierceSec * 100) / 100), profile: `${prof.name}: ${pm.exact ? "cut row" : "estimated from the nearest rows"}${pm.note ? " (" + pm.note + ")" : ""} - the machine file sets the cutting time.` };
      if (prof) return { feedMm: 0, rapidMm: 0, pierce: "", none: `${prof.name} has no cut row for this material - add one under Machines, or enter the feed rate here.` };
      const material = CUT_MATERIAL_NAME[job.material];
      const row = material ? cutRowForThickness(material, lengthMm(job.thickness), CUT_TABLE) : undefined;
      const auto = resolveCutSpeeds(job.machine, { ...job.params, feed: undefined, rapid: undefined, pierce: undefined }, row);
      return auto
        ? { feedMm: auto.feedRateMmPerMin, rapidMm: auto.rapidMmPerMin, pierce: String(Math.round(auto.pierceTimeSec * 100) / 100) }
        : { feedMm: 0, rapidMm: 0, pierce: "", none: job.machine === "laser" ? "No built-in speeds for this material - enter your machine's feed rate for a cutting time." : "Enter your machine's feed rate for a cutting time." };
    };

    /** Report header row: the speeds the cutting time was worked out from (single-material jobs; groups mixes materials). */
    const speedDetails = (result: RasterNestResult, grouped: boolean): [string, string][] => {
      if (grouped || result.sheets.length === 0) return [];
      const speeds = speedsForStock(result.stock[result.sheets[0]!.stockIndex]);
      if (!speeds) return [["Cut speeds", "not set - enter the machine's feed rate for a cutting time"]];
      const u = job.outputUnit;
      const prof = speeds.source === "profile" ? activeProfile() : null;
      return [["Cut speeds", `feed ${fmtSpeed(speeds.feedRateMmPerMin, u)}, pierce ${Math.round(speeds.pierceTimeSec * 100) / 100} s, rapid ${fmtSpeed(speeds.rapidMmPerMin, u)} (${prof ? `machine file "${prof.name}" - acceleration, head lift and sheet loading included` : speeds.source === "machine" ? "machine values" : "built-in estimate"})`]];
    };

    const buildView = async (): Promise<Record<string, unknown>> => {
      const { recs, missing } = await resolveParts();
      const p = jobParamsMm(job);
      const manualParts = job.parts.filter((x) => x.qty > 0 && recs.has(x.key)).length;
      const ready = jobReadiness(job, { manualParts, groupCount: job.groups.length, groupProblems: groupProblemCount() });
      const sheetMm = job.sheetSource === "stock" ? (job.stock[0]?.size ?? { width: 0, height: 0 }) : { width: job.sheet.w * MM_PER_IN, height: job.sheet.h * MM_PER_IN };
      const bedWarn = job.sheetSource === "standard" && bedWarning(sheetMm, p.bed);
      lastLayoutHint.bedWarn = bedWarn;
      const engine = engineFor(job.engine);
      const nestParts: RasterNestPart[] = jobParts(job, geometryMap(recs));
      const unsupported = engine.supports({ job, parts: nestParts });
      const bit = job.machine === "router" ? p.kerf : 0;
      const sx = sheetMm.width - 2 * p.margin, sy = sheetMm.height - 2 * p.margin;
      const partsView = job.parts.map((jp) => {
        const r = recs.get(jp.key);
        const f = r?.file ? files.get(r.file) : fileRecFor(jp.key)?.file;
        if (!r) return { key: jp.key, name: jp.name ?? jp.key, missing: true, qty: jp.qty, rotation: jp.rotation, mirror: jp.mirror, allowInHoles: jp.allowInHoles };
        const notes = [...describeNotes(r.notes, job.outputUnit), ...(f?.warnings ?? [])];
        if (f?.unitGuessed) notes.push("units guessed - check the unit");
        const warns = describeCnc(cncWarnings(r.cnc, bit), job.outputUnit);
        if (sx > 0 && sy > 0 && jp.rotation === "none" && (r.w > sx || r.h > sy)) warns.push("larger than the sheet");
        else if (sx > 0 && sy > 0 && Math.min(r.w, r.h) > Math.min(sx, sy) + 1e-6) warns.push("larger than the sheet");
        return {
          key: jp.key,
          name: r.name,
          size: `${fmt(r.w)} × ${fmt(r.h)}`,
          holes: r.holeCount,
          notes,
          warns,
          qty: jp.qty,
          rotation: jp.rotation,
          mirror: jp.mirror,
          allowInHoles: jp.allowInHoles,
          priority: jp.priority ?? "normal",
          due: jp.due ?? "",
          thumb: thumbOf(r.outer),
          file: f ? { key: f.key, unit: f.unit, usedUnit: f.usedUnit } : undefined,
        };
      });
      return {
        job,
        status: ready.fields,
        canCalculate: ready.canCalculate && !running,
        running,
        missing: missing.length,
        parts: partsView,
        groups: groupsView(),
        bomText,
        folder: folder ? { name: folder.name, count: folder.files.length, truncated: !!folder.truncated } : null,
        addedDrawings: job.mode === "groups" ? addedLookup().length : 0,
        amadaPresets: AMADA_PRESETS.map((p) => ({ id: p.id, model: p.model, sheet: `${fmt(p.sheet.w)} × ${fmt(p.sheet.h)}` })),
        unsupported,
        engineHint: engineHintLines(job.engine, job, unsupported),
        partsProblem: partsProblem(recs),
        bedWarn,
        sheetOptions: sheetsFor(job.material).map((s) => ({ w: s.size.w, h: s.size.h, custom: s.custom, label: `${fmtMm(s.size.w * MM_PER_IN, job.outputUnit)} × ${fmtMm(s.size.h * MM_PER_IN, job.outputUnit)}` })),
        thicknessOptions: thicknessesFor(job.material).map((t) => ({ value: t.value, label: t.label ? `${t.value}" · ${t.label}` : `${t.value}"` })),
        materials: MATERIALS.map((m) => m.id),
        posts: [...BUILTIN_POSTS, ...custom.posts].map((p) => ({ id: p.id, name: p.name, custom: isCustomPostId(p.id) })),
        postId: resolvePost(job.postId, custom.posts).id,
        speedAuto: speedAutoView(),
        postSpec: resolvePost(job.postId, custom.posts),
        stockRows: job.stock.map((s) => ({ name: s.size.name, w: num3(s.size.width), h: num3(s.size.height), qty: s.qty === null ? "" : String(s.qty), thickness: s.thickness })),
        // N-52: the offcut library, matching ones (this job's material and thickness) first.
        library: (() => {
          const t = lengthMm(job.thickness);
          const match = (r: LibraryRemnant) => r.materialId === job.material && t > 0 && sameThickness(r.thickness, t);
          return [...library]
            .sort((a, b) => Number(match(b)) - Number(match(a)) || a.materialId.localeCompare(b.materialId) || a.thickness - b.thickness || b.width * b.height - a.width * a.height)
            .map((r) => ({ id: r.id, size: `${fmt(r.width)} × ${fmt(r.height)}`, material: MATERIAL_NAMES[r.materialId] ?? r.materialId, thickness: fmt(r.thickness), qty: r.qty, from: r.from ?? "", date: r.date ?? "", match: match(r) }));
        })(),
        bareUnit: bareUnitFor(job.outputUnit),
        credit: NEST_CREDIT,
        profiles,
        profileId: activeProfile()?.id ?? "",
        barInput,
        tubeInput,
      };
    };

    const pushView = async () => post({ type: "view", ...(await buildView()) });

    // ---------- job edits ----------

    const applyPatch = (patch: Record<string, unknown>) => {
      const next: NestJob = { ...job };
      if (patch.engine === "raster" || patch.engine === "true-shape") next.engine = patch.engine;
      if (patch.mode === "manual" || patch.mode === "groups") next.mode = patch.mode;
      if (typeof patch.material === "string" && MATERIALS.some((m) => m.id === patch.material)) {
        next.material = patch.material as MaterialId;
        if (!sheetsFor(next.material).some((s) => sameSheet(s.size, next.sheet))) next.sheet = { ...sheetsFor(next.material)[0]!.size };
      }
      if (patch.thickness !== undefined) next.thickness = readField(patch.thickness, job.thickness);
      if (typeof patch.machine === "string" && (MACHINES as readonly string[]).includes(patch.machine) && patch.machine !== job.machine) {
        custom.machines[job.machine] = job.params;
        next.machine = patch.machine as MachineId;
        next.params = custom.machines[next.machine] ?? defaultMachines().machines[next.machine];
        persistCustom();
      }
      if (isObj(patch.params)) {
        const p = { ...next.params };
        for (const k of ["kerf", "web", "margin", "clamp", "bedW", "bedH"] as const) if (patch.params[k] !== undefined) p[k] = readField(patch.params[k], p[k]);
        for (const k of ["feed", "rapid"] as const) if (patch.params[k] !== undefined) p[k] = readField(patch.params[k], p[k] ?? NO_SPEED);
        if (typeof patch.params.pierce === "string") p.pierce = patch.params.pierce.slice(0, 20);
        next.params = p;
        custom.machines[next.machine] = p;
        persistCustom();
      }
      if (patch.sheetSource === "standard" || patch.sheetSource === "stock") {
        next.sheetSource = patch.sheetSource;
        if (patch.sheetSource === "stock" && next.stock.length === 0) {
          next.stock = [{ size: { name: "Sheet", width: next.sheet.w * MM_PER_IN, height: next.sheet.h * MM_PER_IN }, qty: 1 }];
        }
      }
      if (isObj(patch.sheet) && num(patch.sheet.w) > 0 && num(patch.sheet.h) > 0) next.sheet = { w: num(patch.sheet.w), h: num(patch.sheet.h) };
      if (typeof patch.buyExtra === "boolean") next.buyExtra = patch.buyExtra;
      if (patch.accuracy === "fast" || patch.accuracy === "normal" || patch.accuracy === "precise") next.accuracy = patch.accuracy;
      if (patch.timeMs !== undefined) next.timeMs = Math.max(0, Math.min(3_600_000, num(patch.timeMs, job.timeMs)));
      if (typeof patch.outputUnit === "string" && ["in", "indec", "ftin", "mm", "cm", "m"].includes(patch.outputUnit)) next.outputUnit = patch.outputUnit as NestJob["outputUnit"];
      if (patch.gravity === "bottom-left" || patch.gravity === "bottom-right" || patch.gravity === "top-left" || patch.gravity === "top-right") next.gravity = patch.gravity;
      if (patch.minHoleSide !== undefined) next.minHoleArea = Math.max(0, num(patch.minHoleSide)) ** 2;
      if (patch.tabCount !== undefined) { const n = Math.max(0, Math.min(99, Math.floor(num(patch.tabCount)))); if (n >= 1) next.tabCount = n; else delete next.tabCount; }
      if (patch.tabWidth !== undefined) { const w = Math.max(0, Math.min(1000, num(patch.tabWidth))); if (w > 0) next.tabWidth = w; else delete next.tabWidth; }
      if (patch.searchLevel === "quick" || patch.searchLevel === "normal" || patch.searchLevel === "thorough") next.searchLevel = patch.searchLevel;
      if (patch.useRemnants === true) next.useRemnants = true;
      else if (patch.useRemnants === false) delete next.useRemnants;
      if (patch.commonLine === true) next.commonLine = true;
      else if (patch.commonLine === false) delete next.commonLine;
      if (patch.leadIn === "arc") next.leadIn = "arc";
      else if (patch.leadIn === "line") delete next.leadIn;
      if (typeof patch.postId === "string" && (builtinPost(patch.postId) || custom.posts.some((p) => p.id === patch.postId))) {
        if (patch.postId === DEFAULT_POST_ID) delete next.postId;
        else next.postId = patch.postId;
      }
      if (typeof patch.profileId === "string") {
        if (patch.profileId === "") delete next.profileId;
        else if (profiles.some((x) => x.id === patch.profileId && x.type !== "tube")) next.profileId = patch.profileId;
      }
      // NT-02: a machine file fills the machine, bed and kerf (for the material and thickness) so the nest spaces parts the way that machine cuts.
      if (next.profileId && (patch.profileId !== undefined || patch.material !== undefined || patch.thickness !== undefined)) applyProfile(next);
      job = next;
      persistJob();
    };

    /** Copies the machine file's type, bed and the matching row's kerf onto the job's cutting parameters (the user can still edit them after). */
    const applyProfile = (next: NestJob) => {
      const prof = profiles.find((x) => x.id === next.profileId);
      if (!prof || prof.type === "tube") return;
      if (prof.type !== next.machine) {
        custom.machines[next.machine] = next.params;
        next.machine = prof.type;
        next.params = custom.machines[next.machine] ?? defaultMachines().machines[next.machine];
      }
      const u = prof.units;
      const p = { ...next.params };
      if (prof.bedW > 0 && prof.bedH > 0) {
        p.bedW = { v: String(prof.bedW), u };
        p.bedH = { v: String(prof.bedH), u };
      }
      const row = profileRowFor(prof, next.material, lengthMm(next.thickness));
      if (row?.kerfMm) p.kerf = u === "in" ? { v: String(Math.round((row.kerfMm / MM_PER_IN) * 10000) / 10000), u: "in" } : { v: String(Math.round(row.kerfMm * 1000) / 1000), u: "mm" };
      // The machine file owns the speeds now; blank fields show its values in grey.
      delete p.feed;
      delete p.rapid;
      delete p.pierce;
      next.params = p;
      custom.machines[next.machine] = p;
      persistCustom();
    };

    // ---------- init ----------

    const pushInit = async () => {
      post({ type: "init", unit });
      await pushView();
      if (lastView) post({ type: "result", ...lastView });
    };

    void sketchor.app.onDisplayUnitChange((info) => {
      unit = info;
    });
    // NF-03b: mark where a selected outline fails to close (the host only shows them while this panel is open).
    const markOpenEnds = (openChains: OpenChainInfo[]) => {
      // The host keeps one set of marks per plugin: on the nest layout tab those are the manual-nesting flags.
      if (openChains.length === 0 && manualShown) return;
      void sketchor.ui.highlight(openChainMarks(openChains, (mm) => fmtMm(mm, job.outputUnit))).catch(() => undefined);
    };
    void sketchor.selection.onChange(async () => {
      const selection = await sketchor.selection.read();
      if (selection.length === 0) {
        markOpenEnds([]);
        return post({ type: "selection-hint", count: 0, openCount: 0 });
      }
      const model = await sketchor.document.read();
      const { parts, openChains } = extractPartsWithDiagnostics([...model.entities], new Set(selection), { joinTolerance: job.joinTolerance });
      markOpenEnds(openChains);
      post({ type: "selection-hint", count: parts.length, openCount: openChains.length });
    });

    sketchor.commands.register("sheet-nesting.open", () => {
      void sketchor.ui.show(PANEL_HTML, { title: "Sheet Nesting", width: 380, height: 640 });
      void pushInit();
    });

    // ---------- nest ----------

    /** "Carbon steel 3 mm" -> "Carbon-steel-3mm": a group's name as a file / folder name. */
    const fileTag = (label: string): string =>
      label
        .replace(/"/g, "in")
        .replace(/(\d) mm\b/g, "$1mm")
        .replace(/[^\w.-]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 60) || "group";
    /** A sheet's export file name, prefixed with its group in a multi-material result. */
    const taggedName = (sheetIndex: number, name: string): string => (lastSheetTag[sheetIndex] ? `${lastSheetTag[sheetIndex]}_${name}` : name);

    interface Run {
      label: string;
      job: NestJob;
      recs: Map<string, PartRec>;
      /** N-52: library offcuts put ahead of the job's stock (stock rows 0..n-1), by id. */
      remnantIds?: string[];
    }

    const tagStock = (r: RasterNestResult, run: Run): RasterNestResult => {
      const material = CUT_MATERIAL_NAME[run.job.material];
      const thickness = lengthMm(run.job.thickness);
      return { ...r, stock: r.stock.map((s) => ({ ...s, materialId: run.job.material, ...(material ? { material } : {}), ...(thickness > 0 ? { thickness } : {}) })) };
    };

    const runNest = async (runs: Run[]) => {
      running = true;
      cancelRequested = false;
      void pushView();
      const results: RasterNestResult[] = [];
      const unsupportedAll: { option: string; reason: string }[] = [];
      try {
        for (let ri = 0; ri < runs.length; ri++) {
          if (cancelRequested && ri > 0) break;
          const run = runs[ri]!;
          const engine = engineFor(run.job.engine);
          const parts = jobParts(run.job, geometryMap(run.recs));
          if (parts.length === 0) continue;
          for (const u of engine.supports({ job: run.job, parts })) if (!unsupportedAll.some((x) => x.option === u.option)) unsupportedAll.push(u);
          const result = await engine.run(
            { job: { ...run.job, params: { ...run.job.params, clamp: effectiveClamp(run.job) } }, parts },
            {
              isCancelled: () => cancelRequested,
              onProgress: (pr) => post({ type: "nest-progress", run: ri + 1, runs: runs.length, label: run.label, iter: pr.iter, ms: pr.ms, sheets: pr.sheets, unplaced: pr.unplaced }),
            },
          );
          results.push(tagStock(result, run));
        }
        if (results.length === 0) {
          fail("Nothing to nest - every part has quantity 0.");
          return;
        }
        const { result, sheetRun } = combineResults(results);
        await presentResult(runs, result, sheetRun, unsupportedAll, cancelRequested);
      } catch (err) {
        fail(`Nesting failed: ${err instanceof Error ? err.message : String(err)}`);
      } finally {
        running = false;
        void pushView();
      }
    };

    /** The report's job header: material, thickness as entered, machine, engine, cutting parameters and sheet source. Groups mode carries material / thickness per group instead. */
    const reportDetails = (grouped: boolean): [string, string][] => {
      const field = (f: LengthField) => (f.v.trim() === "" ? "-" : `${f.v} ${f.u}`);
      const rows: [string, string][] = [];
      if (!grouped) {
        rows.push(["Material", MATERIAL_NAMES[job.material] ?? job.material]);
        rows.push(["Thickness", field(job.thickness)]);
      }
      rows.push(["Machine", { laser: "Laser", waterjet: "Waterjet", router: "CNC router", other: "Other" }[job.machine] ?? job.machine]);
      rows.push(["Engine", job.engine === "raster" ? "Raster" : "True shape"]);
      rows.push([job.machine === "router" ? "Bit diameter (kerf)" : "Kerf", grouped ? "per group - see each group's heading" : field(job.params.kerf)]);
      rows.push(["Web (gap)", field(job.params.web)]);
      rows.push(["Edge margin", field(job.params.margin)]);
      if (job.machine === "laser") rows.push(["Clamp strip", field(job.params.clamp)]);
      rows.push([
        "Sheet source",
        grouped
          ? "Standard sheet per group"
          : job.sheetSource === "stock"
            ? `Stock on hand (${job.stock.map((r) => `${r.size.name} ${fmt(r.size.width)} × ${fmt(r.size.height)}${r.qty === null ? "" : ` x${r.qty}`}`).join(", ")})`
            : `Standard sheet ${fmt(job.sheet.w * MM_PER_IN)} × ${fmt(job.sheet.h * MM_PER_IN)}`,
      ]);
      return rows;
    };

    const presentResult = async (runs: Run[], result: RasterNestResult, sheetRun: number[], unsupported: { option: string; reason: string }[], stopped: boolean) => {
      const recByKey = new Map<string, PartRec>();
      const orderedMap = new Map<string, { key: string; name: string; quantity: number; priority?: "high" | "low"; due?: string }>();
      runs.forEach((run) => {
        for (const jp of run.job.parts) {
          const r = run.recs.get(jp.key);
          if (!r || jp.qty <= 0) continue;
          recByKey.set(jp.key, r);
          const cur = orderedMap.get(jp.key);
          if (cur) cur.quantity += jp.qty;
          else orderedMap.set(jp.key, { key: jp.key, name: r.name, quantity: jp.qty, ...(jp.priority ? { priority: jp.priority } : {}), ...(jp.due ? { due: jp.due } : {}) });
        }
      });

      const placements: LastNestPlacement[] = [];
      let number = 0;
      for (let i = 0; i < result.placed.length; i++) {
        const pl = result.placed[i]!;
        const p = recByKey.get(pl.partId);
        if (!p) continue;
        const ents = (ids: string[]) => ids.map((id) => p.lookup.get(id)).filter((e): e is Entity => e !== undefined);
        // NT-01: a compound part lists its pieces in order, so the cut plan can cut each one as its own contour.
        const pieceSrc = (p.pieces ?? [{ outerSourceIds: p.outerSourceIds, holeSourceIds: p.holeSourceIds }]).map((pc) => ({ outer: ents(pc.outerSourceIds), holes: ents(pc.holeSourceIds.flat()) }));
        const outerSource = pieceSrc.flatMap((pc) => pc.outer);
        if (outerSource.length === 0) continue;
        const holeSource = pieceSrc.flatMap((pc) => pc.holes);
        const transform = placementTransform(p.outer, pl);
        const outerEntities = materializeInstance(outerSource, transform).map((e) => ({ ...e, layer: NEST_PARTS_LAYER }));
        const holeEntities = holeSource.length > 0 ? materializeInstance(holeSource, transform).map((e) => ({ ...e, layer: NEST_HOLES_LAYER })) : [];
        const b = bounds(outerEntities.flatMap((e) => entityPoints(e)));
        const labelHeight = Math.max(1, Math.min(Math.min(b.maxX - b.minX, b.maxY - b.minY) * 0.3, 12));
        number += 1;
        placements.push({
          sheet: pl.sheet,
          number,
          id: String(i),
          insideOfId: pl.insideOfPlacementIndex !== undefined ? String(pl.insideOfPlacementIndex) : undefined,
          outerEntities,
          holeEntities,
          label: { at: { x: (b.minX + b.maxX) / 2 - textWidth(String(number), labelHeight) / 2, y: (b.minY + b.maxY) / 2 - labelHeight / 2 }, height: labelHeight },
          partId: pl.partId,
          name: p.name,
          rotationDeg: pl.rotationDeg,
          mirrored: pl.mirrored,
          area: p.area,
          ...(p.pieces ? { pieces: pieceSrc.map((pc) => ({ outer: pc.outer.length, holes: pc.holes.length })) } : {}),
          ...(orderedMap.get(pl.partId)?.priority ? { priority: orderedMap.get(pl.partId)!.priority } : {}),
          ...(orderedMap.get(pl.partId)?.due ? { due: orderedMap.get(pl.partId)!.due } : {}),
        });
      }

      const grouped = job.mode === "groups" && runs.length > 0;
      lastSheetKerf = grouped ? result.sheets.map((_, i) => jobParamsMm(runs[sheetRun[i] ?? 0]!.job).kerf) : [];
      lastSheetTag = grouped ? result.sheets.map((_, i) => fileTag(runs[sheetRun[i] ?? 0]!.label)) : [];
      lastGap = grouped ? Math.min(...runs.map((r) => jobParamsMm(r.job).spacing)) : null;
      const sheetLabel = (sheet: TrueNestSheet, i: number): string => {
        const run = runs[sheetRun[i] ?? 0];
        return `Sheet ${i + 1}/${result.sheets.length}${grouped && run ? " – " + run.label : ""} – ${fmt(sheet.width)} × ${fmt(sheet.height)}`;
      };
      const sheetLabels = result.sheets.map((s, i) => sheetLabel(s, i));
      const groups = groupIdenticalSheetsPerRun(result.sheets, result.placed, sheetRun);
      const clamp = runs[0] ? lengthMm(effectiveClamp(runs[0].job)) : 0;
      const outlineAt = new Map<number, { id: string; origin: { x: number; y: number } }>();
      // Manual nesting: parts the nester could not fit wait in a tray below the sheets, ready to drag onto one.
      const titleH = result.sheets[0] ? sheetTitleHeight(result.sheets[0]) : 10;
      const layoutWidth = groups.reduce((w, g) => w + result.sheets[g.indices[0]!]!.width, 0) + Math.max(0, groups.length - 1) * 200;
      const trayTop = -(titleH * 8 + 80);
      const trayWidth = Math.max(1500, layoutWidth);
      let nextNumber = placements.reduce((n, p) => Math.max(n, p.number), 0) + 1;
      const trayWanted: { rec: PartRec; key: string }[] = [];
      for (const u of result.unplaced) {
        const rec = recByKey.get(u.partId);
        for (let k = 0; rec && k < u.count && trayWanted.length < MAX_TRAY; k++) trayWanted.push({ rec, key: u.partId });
      }
      const trayCount = result.unplaced.reduce((n, u) => n + u.count, 0);
      const trayPlan = trayPositions(trayWanted.map((t) => ({ w: t.rec.w, h: t.rec.h })), trayTop, trayWidth, TRAY_GAP);
      const tray = trayWanted.map((t, k) => trayItem(t.rec, String(`t${k + 1}`), nextNumber + k, trayPlan.offsets[k]!, orderedMap.get(t.key)));
      nextNumber += tray.length;
      const layout = buildSideBySideLayout(result.sheets, placements, groups, sheetLabel, {
        clamp,
        onSheet: (i, id, origin) => outlineAt.set(i, { id, origin }),
        partGroups: true,
        qtyBadge: true,
        ...(tray.length > 0 ? { tray: { title: trayTitle(trayCount, tray.length), items: tray.map((t) => t.placement), at: trayPlan.at } } : {}),
      });
      const margin = runs[0] ? jobParamsMm(runs[0].job).margin : 0;
      const drawnSheets: ManualSheet[] = groups.flatMap((g) => {
        const o = outlineAt.get(g.indices[0]!);
        const sh = result.sheets[g.indices[0]!]!;
        return o ? [{ sheet: g.indices[0]!, indices: g.indices, outlineId: o.id, width: sh.width, height: sh.height, margin, clampRect: clampStripRect(sh, clamp) }] : [];
      });
      const instances: ManualInstance[] = [];
      for (const ms of drawnSheets) {
        const origin = outlineAt.get(ms.sheet)!.origin;
        for (const p of placements) {
          if (p.sheet !== ms.sheet) continue;
          const pl = result.placed[Number(p.id)]!;
          const rec = recByKey.get(p.partId)!;
          const t = placementTransform(rec.outer, pl);
          instances.push({ id: p.id, placement: p, outer: xformPts(rec.outer, t), holes: rec.holes.map((h) => xformPts(h, t)), drawnAt: origin, home: ms.sheet });
        }
      }
      for (const t of tray) instances.push(t);
      manual = {
        instances,
        sheets: drawnSheets,
        ordered: new Map([...orderedMap].map(([k, o]) => [k, { name: o.name, qty: o.quantity }])),
        recs: recByKey,
        nextNumber,
        nextTray: tray.length + 1,
        trayTop: trayPlan.bottom - TRAY_GAP,
        trayWidth,
        trayTitled: tray.length > 0,
        labelHeight: titleH,
      };
      lastManual = null;
      await sketchor.app.openDocumentTab(`Nest – ${result.placed.length} part${result.placed.length === 1 ? "" : "s"}, ${result.sheets.length} sheet${result.sheets.length === 1 ? "" : "s"}`, layout);

      const geoMap = new Map([...recByKey].map(([k, r]) => [k, { outer: r.outer, holes: r.holes, ...(r.pieces ? { netArea: r.area } : {}) }]));
      const cutMap = new Map([...recByKey].map(([k, r]) => [k, { cutLength: r.cutLength, pierceCount: r.pierceCount }]));
      const metrics: JobMetrics = computeJobMetrics(result, geoMap, result.stock, CUT_TABLE, { gravity: job.gravity, cut: cutMap });
      // Cutting time from the real cut plan (lead-ins, tab restarts, the actual rapids) at the machine's speeds - the same walk the G-code makes.
      let commonSaved = 0;
      result.sheets.forEach((sh, i) => {
        metrics.sheets[i]!.cuttingTimeSec = sheetTimeSec(placements, i, result.stock[sh.stockIndex]);
        // N-51: a shared edge is cut once - the cut length counts it once too.
        if (job.commonLine) {
          const saved = sheetCutPlan(placements, i).commonLineMm ?? 0;
          commonSaved += saved;
          metrics.sheets[i]!.cutLengthMm = Math.max(0, metrics.sheets[i]!.cutLengthMm - saved);
        }
      });
      metrics.totalCuttingTimeSec = metrics.sheets.length > 0 && metrics.sheets.every((m) => m.cuttingTimeSec !== null) ? metrics.sheets.reduce((n, m) => n + (m.cuttingTimeSec ?? 0), 0) : null;
      const required = [...orderedMap.values()].reduce((n, o) => n + o.quantity, 0);
      const source = runs[0]?.job.sheetSource ?? job.sheetSource;
      const kpis = resultKpis(result, source, required, {
        cutLengthMm: metrics.sheets.reduce((n, s) => n + s.cutLengthMm, 0),
        pierces: metrics.sheets.reduce((n, s) => n + s.pierceCount, 0),
      });
      const usage = stockUsage(result, source);
      lastStock = result.stock;
      lastRemnants = findRemnants(result, (id) => recByKey.get(id)?.outer, { clearance: 2 }).map((rem) => {
        const row = result.stock[result.sheets[rem.sheet]!.stockIndex];
        return { rem, material: row?.material, materialId: row?.materialId, thickness: row?.thickness };
      });
      // N-52: offcuts the nest cut from (stock rows ahead of the job's own), and the job's own inventory sheets it used.
      const offcutIds = runs.length === 1 ? (runs[0]!.remnantIds ?? []) : [];
      lastRemnantUse = new Map();
      lastUsed = [];
      if (source === "stock" && runs.length === 1) {
        result.sheets.forEach((sh, i) => {
          if (sh.stockIndex < offcutIds.length) {
            const id = offcutIds[sh.stockIndex]!;
            lastRemnantUse.set(id, (lastRemnantUse.get(id) ?? 0) + 1);
          } else if (!result.purchased[i] && job.sheetSource === "stock") {
            const k = sh.stockIndex - offcutIds.length;
            lastUsed[k] = (lastUsed[k] ?? 0) + 1;
          }
        });
      }

      lastNest = {
        sheets: result.sheets,
        sheetLabels,
        placements,
        metrics,
        result,
        ordered: [...orderedMap.values()],
        unit: { perMm: unit.perMm, label: unit.label },
        footer: NEST_CREDIT,
        title: "Sheet Nesting Report",
        format: { len: fmt, area: (mm2) => fmtMm2(mm2, job.outputUnit) },
        fitPage: true,
        sheetGroups: groups.map((g) => g.indices),
        details: [...reportDetails(grouped), ...speedDetails(result, grouped), ...(job.commonLine ? ([["Common-line cutting", `on - ${fmt(commonSaved)} of edges shared by neighbouring parts are cut once (parts spaced one kerf apart)`]] as [string, string][]) : [])],
        groupSections: grouped
          ? runs.map((run, ri) => ({
              title: `${run.label} - sheet ${fmt(run.job.sheet.w * MM_PER_IN)} × ${fmt(run.job.sheet.h * MM_PER_IN)} - kerf ${fmtFine(jobParamsMm(run.job).kerf)}`,
              sheets: sheetLabels.filter((_, i) => (sheetRun[i] ?? 0) === ri),
              parts: run.job.parts
                .filter((jp) => jp.qty > 0 && run.recs.has(jp.key))
                .map((jp) => {
                  const placedN = result.placed.filter((pl) => pl.partId === jp.key && (sheetRun[pl.sheet] ?? 0) === ri).length;
                  return { name: run.recs.get(jp.key)!.name, ordered: jp.qty, placed: placedN, unplaced: Math.max(0, jp.qty - placedN) };
                }),
            }))
          : undefined,
        summary: {
          kpis: { ...kpis, cuttingTimeSec: metrics.totalCuttingTimeSec },
          stock: usage.map((u) => ({ ...u, size: `${fmt(u.width)} × ${fmt(u.height)}` })),
          groups: grouped ? runs.map((r) => r.label) : [],
        },
      };

      const unplaced = result.unplaced
        .map((u) => ({ name: recByKey.get(u.partId)?.name ?? u.partId, count: u.count }))
        .filter((u) => u.count > 0);
      lastView = {
        kpis: { ...kpis, cutLength: fmt(kpis.cutLengthMm), cutTime: metrics.totalCuttingTimeSec !== null ? fmtDuration(metrics.totalCuttingTimeSec) : "" },
        stock: usage.map((u) => ({ name: u.name, size: `${fmt(u.width)} × ${fmt(u.height)}`, used: u.used, purchased: u.purchased, available: u.available })),
        unplaced,
        remnants: lastRemnants.map((r) => ({ sheet: r.rem.sheet + 1, size: `${fmt(r.rem.width)} × ${fmt(r.rem.height)}` })),
        offcutsUsed: [...lastRemnantUse].map(([id, n]) => {
          const r = library.find((x) => x.id === id);
          return { n, size: r ? `${fmt(r.width)} × ${fmt(r.height)}` : id };
        }),
        notes: result.notes,
        unsupported,
        stopped,
        ms: result.ms,
        cards: groups.map((g) => {
          const first = g.indices[0]!;
          const m = metrics.sheets[first]!;
          return {
            title: g.indices.length > 1 ? describeGroup(g.indices).replace(/ ×\d+$/, "") : `Sheet ${first + 1}`,
            size: `${fmt(g.sheet.width)} × ${fmt(g.sheet.height)}`,
            group: grouped ? (runs[sheetRun[first] ?? 0]?.label ?? "") : "",
            count: g.indices.length,
            index: first,
            parts: placements.filter((p) => p.sheet === first).length,
            utilisation: m.utilisation,
          };
        }),
        sheetLabels,
      };
      post({ type: "result", ...lastView });
      void checkManual();
      notify(
        kpis.unplaced > 0
          ? `Nested ${kpis.placed} on ${kpis.sheets} sheet(s) - ${kpis.unplaced} did not fit.`
          : `Nested ${kpis.placed} part(s) on ${kpis.sheets} sheet(s), ${Math.round(kpis.utilisation * 100)}% used${stopped ? " (stopped early)" : ""}.`,
        kpis.unplaced > 0,
      );
    };

    const buildManualRuns = async (): Promise<Run[] | null> => {
      const { recs, missing } = await resolveParts();
      if (missing.length > 0) {
        job = { ...job, parts: job.parts.filter((p) => !missing.includes(p)) };
        persistJob();
        void pushView();
        if (recs.size === 0) {
          fail(`${missing.length} part(s) no longer exist on the drawing (deleted, or on another tab) and were removed. Select shapes and "Add selection" again.`);
          return null;
        }
        notify(`${missing.length} part(s) no longer exist and were dropped from the list.`, true);
      }
      // N-52: matching offcuts go first in the stock; the job's own sheets (or the standard size, unlimited) after them.
      const offcuts = job.useRemnants ? matchingRemnants(library, job.material, lengthMm(job.thickness)) : [];
      if (offcuts.length > 0) {
        const rows = remnantStockRows(offcuts, fmt);
        const runJob: NestJob = job.sheetSource === "stock" && job.stock.length > 0 ? { ...job, mode: "manual", stock: [...rows, ...job.stock] } : { ...job, mode: "manual", sheetSource: "stock", stock: rows, buyExtra: true };
        return [{ label: "", job: runJob, recs, remnantIds: offcuts.map((o) => o.id) }];
      }
      return [{ label: "", job: { ...job, mode: "manual" }, recs }];
    };

    // ---------- export ----------

    /**
     * NF-08: the last nest with every part where it now is on the layout tab,
     * so the report, DXF, G-code and toolpath show and cut what the user sees
     * after dragging or rotating parts. Cutting times are worked out again for
     * the moved parts. The active tab must be the nest layout; otherwise (or
     * with nothing moved) this is the nest as calculated.
     */
    const currentNest = async (): Promise<LastNest | null> => {
      const ln = lastNest;
      if (!ln || !manual) return ln;
      const model = await sketchor.document.read();
      const r = readNow(model.entities);
      if (!r.found) {
        notify("The nest layout tab isn't the active tab - using the nest as calculated. Switch to it to include parts you moved there.");
        return ln;
      }
      const red = r.issues.filter((i) => i.tone === "error").length;
      if (red > 0) notify(`${red} part${red === 1 ? " is" : "s are"} flagged red on the layout (overlapping or off the sheet) - fix ${red === 1 ? "it" : "them"} before cutting.`, true);
      if (!r.changed) return ln;
      notify(`Using the layout as edited on the canvas (${r.moved} moved${r.deleted ? `, ${r.deleted} removed` : ""}).`);
      const placements = r.placements;
      const cutOf = (p: LastNestPlacement) => manual?.recs.get(p.partId);
      const sheets = ln.metrics.sheets.map((m, i) => {
        const on = placements.filter((p) => p.sheet === i);
        const net = on.reduce((n, p) => n + p.area, 0);
        return {
          ...m,
          netPartArea: net,
          utilisation: m.sheetArea > 0 ? net / m.sheetArea : 0,
          cutLengthMm: Math.max(0, on.reduce((n, p) => n + (cutOf(p)?.cutLength ?? 0), 0) - (job.commonLine ? (sheetCutPlan(placements, i).commonLineMm ?? 0) : 0)),
          pierceCount: on.reduce((n, p) => n + (cutOf(p)?.pierceCount ?? 0), 0),
          cuttingTimeSec: sheetTimeSec(placements, i, lastStock[ln.sheets[i]!.stockIndex] as StockRow | undefined),
        };
      });
      const total = sheets.length > 0 && sheets.every((m) => m.cuttingTimeSec !== null) ? sheets.reduce((n, m) => n + (m.cuttingTimeSec ?? 0), 0) : null;
      const area = sheets.reduce((n, m) => n + m.sheetArea, 0);
      const util = area > 0 ? sheets.reduce((n, m) => n + m.netPartArea, 0) / area : 0;
      const required = r.counts.reduce((n, c) => n + c.ordered, 0);
      const placed = placements.length;
      return {
        ...ln,
        placements,
        countFromPlacements: true,
        metrics: { ...ln.metrics, sheets, totalUtilisation: util, totalCuttingTimeSec: total },
        summary: ln.summary
          ? {
              ...ln.summary,
              kpis: {
                ...ln.summary.kpis,
                cuttingTimeSec: total,
                utilisation: util,
                placed,
                unplaced: Math.max(0, required - placed),
                cutLengthMm: sheets.reduce((n, m) => n + m.cutLengthMm, 0),
                pierces: sheets.reduce((n, m) => n + m.pierceCount, 0),
              },
            }
          : ln.summary,
      };
    };

    /** Reads the layout tab back (see nestManual.ts). */
    const readNow = (entities: readonly Entity[]): ManualReadResult => {
      const m = manual!;
      const doc = new Map(entities.map((e) => [e.id, e] as const));
      return readManualNest(m.instances, m.sheets, doc, { gap: lastGap ?? jobParamsMm(job).spacing, ordered: m.ordered });
    };

    /**
     * Manual nesting, live: after every edit on the layout tab, flag parts
     * that overlap or stick off the sheet (red) or sit in the margin, on the
     * clamp strip or closer than the web gap (orange), and tell the panel what
     * is still to nest. The flags are host highlights - never undo steps.
     */
    let manualTimer: ReturnType<typeof setTimeout> | null = null;
    let manualShown = false;
    const checkManual = async (entities?: readonly Entity[]) => {
      if (!manual) return;
      const ents = entities ?? (await sketchor.document.read()).entities;
      if (!manual) return;
      const r = readNow(ents);
      if (!r.found) return; // another tab: leave the marks with the layout tab
      lastManual = r;
      manualShown = r.issues.length > 0;
      void sketchor.ui.highlight(issueMarks(r.issues)).catch(() => undefined);
      post({ type: "manual", ...manualView(r) });
    };
    const manualView = (r: ManualReadResult) => ({
      moved: r.moved,
      deleted: r.deleted,
      red: r.issues.filter((i) => i.tone === "error").length,
      orange: r.issues.filter((i) => i.tone === "warn").length,
      issues: r.issues.slice(0, 8).map((i) => ({ label: i.label, tone: i.tone })),
      more: Math.max(0, r.issues.length - 8),
      tray: r.inTray.length,
      placed: r.counts.reduce((n, c) => n + Math.min(c.placed, c.ordered), 0),
      required: r.counts.reduce((n, c) => n + c.ordered, 0),
      toNest: r.counts.filter((c) => c.placed < c.ordered).map((c) => ({ key: c.partId, name: c.name, n: c.ordered - c.placed, waiting: r.inTray.filter((id) => manual?.instances.find((x) => x.id === id)?.placement.partId === c.partId).length })),
      extra: r.counts.filter((c) => c.placed > c.ordered).map((c) => ({ name: c.name, n: c.placed - c.ordered })),
      sheets: r.perSheet.map((p) => ({ sheet: p.sheet + 1, parts: p.parts, qty: manual?.sheets.find((x) => x.sheet === p.sheet)?.indices.length ?? 1 })),
    });
    void sketchor.document.onChange((model) => {
      if (!manual) return;
      if (manualTimer) clearTimeout(manualTimer);
      manualTimer = setTimeout(() => {
        manualTimer = null;
        void checkManual(model.entities);
      }, 120);
    });

    /** The selected parts on the layout tab (whole part groups), turned by `deg` about each part's own centre. */
    const rotateSelected = async (deg: number) => {
      if (!manual) return fail("Nest first - the rotate buttons turn parts on the nest layout tab.");
      const model = await sketchor.document.read();
      const sel = new Set(await sketchor.selection.read());
      const known = new Set(manual.instances.flatMap((i) => [...i.placement.outerEntities, ...i.placement.holeEntities].map((e) => e.id)));
      const byId = new Map(model.entities.map((e) => [e.id, e] as const));
      const picked = model.groups.filter((g) => g.members.some((m) => sel.has(m)) && g.members.some((m) => known.has(m)));
      if (picked.length === 0) return fail("Select a part on the nest layout first (click it - the whole part is picked up), then rotate.");
      const commands = picked.map((g) => {
        const pts = g.members.flatMap((m) => {
          const e = byId.get(m);
          return e && known.has(m) ? entityPoints(e) : [];
        });
        const b = bounds(pts);
        return { type: "transform-entities" as const, ids: [...g.members], pivot: { x: (b.minX + b.maxX) / 2, y: (b.minY + b.maxY) / 2 }, rotation: (deg * Math.PI) / 180 };
      });
      await sketchor.document.apply(commands);
    };

    /** Draws `count` more of a part in the tray, below what is there, so it can be dragged onto a sheet. */
    const addToTray = async (key: string, count: number) => {
      const m = manual;
      if (!m) return fail("Nest first - the tray is on the nest layout tab.");
      const rec = m.recs.get(key);
      if (!rec) return fail("That part is not in this nest.");
      const model = await sketchor.document.read();
      if (!readNow(model.entities).found) return fail("Switch to the nest layout tab first - the parts are added to its tray.");
      const n = Math.max(1, Math.min(MAX_TRAY, Math.floor(count)));
      const plan = trayPositions(Array.from({ length: n }, () => ({ w: rec.w, h: rec.h })), m.trayTop, m.trayWidth, TRAY_GAP);
      const ordered = m.ordered.get(key);
      const items = plan.offsets.map((o) => trayItem(rec, `t${m.nextTray++}`, m.nextNumber++, o, ordered ? { name: ordered.name } : undefined));
      const cmds = buildSideBySideLayout([], [], [], () => "", { tray: { title: m.trayTitled ? "" : "To nest - drag onto a sheet", items: items.map((t) => t.placement), at: plan.at } });
      // buildSideBySideLayout puts the tray title first; leave it out once the tray already has one.
      const commands = m.trayTitled ? cmds.slice(1) : cmds;
      m.trayTitled = true;
      m.trayTop = plan.bottom - TRAY_GAP;
      m.instances.push(...items);
      await sketchor.document.apply(commands);
      notify(`${n} × ${rec.name} added to the tray below the sheets - drag ${n === 1 ? "it" : "them"} onto a sheet.`);
    };

    const exportDxf = async (msg: Record<string, unknown>) => {
      const ln = await currentNest();
      if (!ln) return fail("Nothing to export - nest some parts first.");
      const sheetIndex = typeof msg.sheetIndex === "number" ? msg.sheetIndex : -1;
      if (sheetIndex >= ln.sheets.length) return fail("That sheet no longer exists - nest again.");
      const preset: DxfPreset = msg.preset === "nest" ? "nest" : "cam";
      const dxfUnit = displayUnitToDxfCode(unit.unit);
      const dxfScale = factorFromMm(unit.unit);
      const sheetDxf = (i: number): string =>
        entitiesToDxf(sheetDxfEntities(ln.sheets[i]!, i, ln.sheetLabels[i]!, ln.placements, { preset, includeSheetOutline: msg.includeSheet === true }), dxfUnit, dxfScale);
      const filters = [{ description: "DXF Drawing", accept: { "application/dxf": [".dxf"] } }];
      if (sheetIndex >= 0) {
        const name = taggedName(sheetIndex, sheetDxfFileName(sheetIndex));
        const res = await sketchor.ui.saveFile(name, sheetDxf(sheetIndex), filters);
        if (res.saved) notify(`Saved ${res.name ?? name}.`);
        return;
      }
      if (preset === "nest") {
        const res = await sketchor.ui.saveFile("nest-all.dxf", entitiesToDxf(stackedSheetsDxfEntities(ln.sheets, ln.sheetLabels, ln.placements), dxfUnit, dxfScale), filters);
        if (res.saved) notify(`Saved ${res.name ?? "nest-all.dxf"}.`);
        return;
      }
      // "All as ZIP" always makes a .zip, even for one sheet; a single DXF is the per-sheet button.
      // Multi-material: one folder per material + thickness, the way the sheets go to the machine.
      const zip = makeZip(ln.sheets.map((_, i) => ({ name: lastSheetTag[i] ? `${lastSheetTag[i]}/${sheetDxfFileName(i)}` : sheetDxfFileName(i), data: sheetDxf(i) })));
      const res = await sketchor.ui.saveFile("nest-sheets.zip", zip, [{ description: "ZIP archive", accept: { "application/zip": [".zip"] } }]);
      if (res.saved) notify(`Saved ${res.name ?? "nest-sheets.zip"} (${ln.sheets.length} sheets).`);
    };

    /** One sheet's cut plan — the G-code export and the toolpath preview must agree, so both build it here. */
    const sheetCutPlan = (placements: LastNestPlacement[], sheetIndex: number) => {
      const gp: GcodePlacement[] = placements
        .filter((p) => p.sheet === sheetIndex)
        .flatMap((p): GcodePlacement[] => {
          if (!p.pieces || p.pieces.length < 2) return [{ id: p.id, number: p.number, outerEntities: p.outerEntities, holeEntities: p.holeEntities, insideOfId: p.insideOfId }];
          // NT-01: each piece of a compound part is its own closed outer contour.
          let o = 0, h = 0;
          return p.pieces.map((pc, k) => {
            const out = { id: k === 0 ? p.id : `${p.id}.${k}`, number: p.number, outerEntities: p.outerEntities.slice(o, o + pc.outer), holeEntities: p.holeEntities.slice(h, h + pc.holes), insideOfId: p.insideOfId };
            o += pc.outer;
            h += pc.holes;
            return out;
          });
        });
      return buildCutPlan(gp, { kerf: lastSheetKerf[sheetIndex] ?? jobParamsMm(job).kerf, tabs: job.tabCount ? { count: job.tabCount, width: job.tabWidth ?? DEFAULT_TAB_WIDTH_MM } : undefined, leadIn: job.leadIn ?? "line", ...(job.commonLine ? { commonLine: true } : {}) });
    };

    /** N-43: one sheet's cut order, pierces and dashed rapids, in a tab of its own so the result drawing is never touched. */
    const previewToolpath = async (msg: Record<string, unknown>) => {
      const ln = await currentNest();
      if (!ln) return fail("Nothing to preview - nest some parts first.");
      const sheetIndex = typeof msg.sheetIndex === "number" ? msg.sheetIndex : 0;
      if (sheetIndex < 0 || sheetIndex >= ln.sheets.length) return fail("That sheet no longer exists - nest again.");
      const plan = sheetCutPlan(ln.placements, sheetIndex);
      for (const w of plan.warnings) notify(w, true);
      const sheet = ln.sheets[sheetIndex]!;
      const label = ln.sheetLabels[sheetIndex]!;
      const { outline, title } = sheetOutlineEntities(sheet, label);
      const { entities, stats } = toolpathPreview(plan.features, toolpathPreviewScale(sheet.width, sheet.height));
      await sketchor.app.openDocumentTab(`Toolpath – ${label}`, [outline, title, ...entities].map((e) => add(e)));
      const fmt = (mm: number) => fmtMm(mm, job.outputUnit);
      notify(`${label}: ${stats.contours} cut${stats.contours === 1 ? "" : "s"}, ${stats.pierces} pierce${stats.pierces === 1 ? "" : "s"} - ${fmt(stats.cutLength)} cut, ${fmt(stats.rapidLength)} of rapids.`);
    };

    const exportGcode = async (msg: Record<string, unknown>) => {
      const ln = await currentNest();
      if (!ln) return fail("Nothing to export - nest some parts first.");
      const sheetIndex = typeof msg.sheetIndex === "number" ? msg.sheetIndex : 0;
      if (sheetIndex < 0 || sheetIndex >= ln.sheets.length) return fail("That sheet no longer exists - nest again.");
      const plan = sheetCutPlan(ln.placements, sheetIndex);
      for (const w of plan.warnings) notify(w, true);
      const speeds = speedsForStock(lastStock[ln.sheets[sheetIndex]!.stockIndex] as StockRow | undefined);
      if (!speeds) notify("No feed rate for this sheet's material/thickness - using a default; enter your machine's feed rate under Cutting parameters before running the program.", true);
      const gunit = unit.unit === "in" ? "in" : "mm";
      const gcode = writeGcode(plan.features, {
        unit: gunit,
        scale: gunit === "in" ? factorFromMm("in") : 1,
        feedRateMmPerMin: speeds?.feedRateMmPerMin ?? 2000,
        pierceTimeSec: speeds?.pierceTimeSec ?? 0.5,
        sheetLabel: ln.sheetLabels[sheetIndex],
        title: "Sheet Nesting",
        // N-42: the job's post-processor; an unknown id (an older job, a removed profile) falls back to the default.
        profile: postProfileFromSpec(resolvePost(job.postId, custom.posts)),
      });
      const name = taggedName(sheetIndex, `nest-sheet-${sheetIndex + 1}.nc`);
      const res = await sketchor.ui.saveFile(name, gcode, [{ description: "G-code", accept: { "text/plain": [".nc", ".gcode", ".tap"] } }]);
      if (res.saved) notify(`Saved ${res.name ?? name}.`);
    };

    // ---------- messages ----------

    sketchor.ui.onMessage(async (raw) => {
      const msg = isObj(raw) ? raw : {};
      const type = msg.type;

      if (type === "ready") {
        await pushInit();
        // NF-08: the autosave folder the Load Planner also uses.
        void sketchor.ui.printFolder().then((folder) => sketchor.ui.postMessage({ type: "print-folder", folder })).catch(() => undefined);
        return;
      }
      if (type === "pick-print-folder") {
        // Runs inside the panel's click, which is what lets the host open the OS folder picker.
        const info = await sketchor.ui.pickPrintFolder().catch(() => null);
        if (info) void sketchor.ui.postMessage({ type: "print-folder", folder: info });
        return;
      }

      if (type === "job-set") {
        if (isObj(msg.patch)) applyPatch(msg.patch);
        return void (await pushView());
      }

      if (type === "add-selection") {
        const [model, selection] = await Promise.all([sketchor.document.read(), sketchor.selection.read()]);
        const entities = [...model.entities];
        const { parts, openChains } = extractPartsWithDiagnostics(entities, new Set(selection), { joinTolerance: job.joinTolerance });
        markOpenEnds(openChains);
        if (parts.length === 0) {
          return fail(openChains.length > 0 ? `No closed shape found: ${openChains.length} shape(s) are open - the gaps are marked on the drawing.` : "Select one or more closed shapes first.");
        }
        let added = 0;
        const next = [...job.parts];
        const lookup = new Map(entities.map((e) => [e.id, e]));
        for (const part of parts) {
          const link = stableKey(part.sourceIds);
          const existing = next.find((x) => x.sourceIds.length > 0 && stableKey(x.sourceIds) === link);
          // Re-adding a part refreshes its snapshot in place (keeps qty / rotation).
          const fileKey = existing ? existing.key.slice(0, Math.max(0, existing.key.lastIndexOf("#"))) || existing.key : `cv${Date.now().toString(36)}${++fileCounter}`;
          const rec = snapshotCanvasPart(part, lookup, fileKey, job.joinTolerance);
          if (rec.error || rec.parts.length === 0) continue;
          files.set(fileKey, rec);
          if (!existing) {
            next.push({ key: rec.parts[0]!.key, sourceIds: part.sourceIds, name: part.name, qty: 1, rotation: defaultRotationFor(job.material), mirror: false, allowInHoles: false });
            added += 1;
          }
        }
        job = { ...job, parts: next };
        persistJob();
        persistFiles();
        await pushView();
        notify(`${added} added, ${parts.length - added} already in the list - ${job.parts.length} part(s) in the job.${openChains.length > 0 ? ` ${openChains.length} open shape(s) skipped.` : ""}`);
        return;
      }

      if (type === "part-set") {
        const key = str(msg.key);
        const patch = isObj(msg.patch) ? msg.patch : {};
        job = {
          ...job,
          parts: job.parts.map((p) =>
            p.key !== key
              ? p
              : {
                  ...p,
                  ...(patch.qty !== undefined ? { qty: Math.max(0, Math.min(100000, Math.floor(num(patch.qty, p.qty)))) } : {}),
                  ...(typeof patch.rotation === "string" && ["none", "flip", "r90", "r45", "r30", "r15", "r10", "free"].includes(patch.rotation) ? { rotation: patch.rotation as RotationCode } : {}),
                  ...(typeof patch.mirror === "boolean" ? { mirror: patch.mirror } : {}),
                  ...(typeof patch.allowInHoles === "boolean" ? { allowInHoles: patch.allowInHoles } : {}),
                },
          ).map((p) => {
            if (p.key !== key) return p;
            // N-55: "normal" / an empty date clear the field.
            const next = { ...p };
            if (patch.priority === "high" || patch.priority === "low") next.priority = patch.priority;
            else if (patch.priority !== undefined) delete next.priority;
            if (patch.due !== undefined) {
              const d = validDue(patch.due);
              if (d) next.due = d;
              else delete next.due;
            }
            return next;
          },
          ),
        };
        persistJob();
        return void (msg.refresh === false ? pushStatusOnly() : await pushView());
      }

      if (type === "remove-part") {
        const key = str(msg.key);
        job = { ...job, parts: job.parts.filter((p) => p.key !== key) };
        persistJob();
        return void (await pushView());
      }

      if (type === "stock-set") {
        const unitName = bareUnitFor(job.outputUnit);
        const rows: StockRow[] = [];
        for (const r of Array.isArray(msg.rows) ? msg.rows : []) {
          if (!isObj(r)) continue;
          const w = parseLen(r.w, unitName) * MM_PER_IN;
          const h = parseLen(r.h, unitName) * MM_PER_IN;
          const qty = str(r.qty).trim() === "" ? null : Math.max(0, Math.floor(num(r.qty, 0)));
          rows.push({ size: { name: str(r.name) || "Sheet", width: Number.isFinite(w) && w > 0 ? w : 0, height: Number.isFinite(h) && h > 0 ? h : 0 }, qty });
        }
        job = { ...job, stock: rows.filter((r) => r.size.width > 0 && r.size.height > 0) };
        persistJob();
        return void (msg.refresh === false ? undefined : await pushView());
      }

      if (type === "custom-sheet") {
        const unitName = bareUnitFor(job.outputUnit);
        const w = parseLen(msg.w, unitName), h = parseLen(msg.h, unitName);
        if (!(w > 0 && h > 0)) return fail("Enter a valid sheet width and height.");
        const list = custom.sheets[job.material] ?? [];
        if (!sheetsFor(job.material).some((s) => sameSheet(s.size, { w, h }))) list.push({ w, h });
        custom.sheets[job.material] = list;
        persistCustom();
        job = { ...job, sheet: { w, h } };
        persistJob();
        return void (await pushView());
      }

      if (type === "remove-custom-sheet") {
        const list = custom.sheets[job.material] ?? [];
        custom.sheets[job.material] = list.filter((s) => !sameSheet(s, job.sheet));
        persistCustom();
        job = { ...job, sheet: { ...sheetsFor(job.material)[0]!.size } };
        persistJob();
        return void (await pushView());
      }

      if (type === "add-files") {
        const incoming = Array.isArray(msg.files) ? msg.files : [];
        const problems: string[] = [];
        let added = 0;
        const next = [...job.parts];
        for (const f of incoming) {
          if (!isObj(f)) continue;
          const name = str(f.name, "part");
          let text = typeof f.text === "string" ? f.text : "";
          if (/\.svg$/i.test(name)) {
            problems.push(`${name}: SVG cannot be read inside the plugin sandbox yet - open it in a tab and use Add selection`);
            continue;
          }
          if (/\.dwg$/i.test(name)) {
            try {
              const mod = await import("../../browser/dwgImport");
              const converted = f.bytes instanceof ArrayBuffer ? await mod.dwgToDxfText(f.bytes) : null;
              if (!converted) throw new Error("unreadable DWG");
              text = converted;
            } catch (err) {
              problems.push(`${name}: ${err instanceof Error ? err.message : "DWG could not be read"}`);
              continue;
            }
          }
          if (!text || text.length > MAX_FILE_BYTES) {
            problems.push(`${name}: empty or too large`);
            continue;
          }
          fileCounter += 1;
          const key = `file${Date.now().toString(36)}${fileCounter}`;
          const rec = loadDxfFile(key, name.replace(/\.(dwg)$/i, ".dxf"), text, null, job.joinTolerance);
          if (rec.error) {
            problems.push(`${name}: ${rec.error}`);
            continue;
          }
          files.set(key, rec);
          for (const p of rec.parts) {
            next.push({ key: p.key, sourceIds: [], name: p.name, qty: 1, rotation: defaultRotationFor(job.material), mirror: false, allowInHoles: false });
            added += 1;
          }
        }
        // Groups mode: the files are drawings for the list's part numbers, not parts of their own.
        if (msg.forGroups !== true) job = { ...job, parts: next };
        persistJob();
        persistFiles();
        await pushView();
        if (added > 0) notify(msg.forGroups === true ? `${added} drawing(s) added - list items with the same name use them.` : `${added} part(s) added from ${incoming.length} file(s).`);
        if (problems.length > 0) fail(problems.join("\n"));
        return;
      }

      if (type === "file-unit") {
        const f = files.get(str(msg.key));
        if (!f) return;
        const code = msg.unit === null || msg.unit === "" ? null : num(msg.unit, NaN);
        const redo = loadDxfFile(f.key, f.name, f.text, code !== null && MM_PER_INSUNIT[code] ? code : null, job.joinTolerance);
        if (!redo.error) files.set(f.key, redo);
        persistFiles();
        return void (await pushView());
      }

      if (type === "clear") {
        job = { ...job, parts: [], groups: [] };
        files.clear();
        lastSheetKerf = [];
        lastSheetTag = [];
        lastGap = null;
        lastNest = null;
        manual = null;
        lastManual = null;
        lastView = null;
        persistJob();
        persistFiles();
        post({ type: "cleared" });
        return void (await pushView());
      }

      if (type === "cancel-nest") {
        cancelRequested = true;
        return;
      }

      if (type === "nest") {
        if (running) return;
        if (job.mode === "groups") {
          await loadGroupFiles();
          const ready = jobReadiness(job, { manualParts: 0, groupCount: job.groups.length, groupProblems: groupProblemCount() });
          if (!ready.canCalculate) {
            await pushView();
            return fail(job.groups.length === 0 ? "Make groups from the parts list first." : "Some parts have no usable drawing file (shown in red) - fix or remove them first.");
          }
          return void (await runNest(buildGroupRuns()));
        }
        const runs = await buildManualRuns();
        if (!runs) return;
        const ready = jobReadiness(job, { manualParts: runs[0]!.recs.size, groupCount: 0, groupProblems: 0 });
        if (!ready.canCalculate) return fail("Fill in the highlighted fields first.");
        return void (await runNest(runs));
      }

      if (type === "bom-text") {
        bomText = str(msg.text).slice(0, 2_000_000);
        void sketchor.storage.set(KEY_BOM, bomText).catch(() => undefined);
        if (msg.refresh !== false) await pushView();
        return;
      }

      if (type === "pick-folder") {
        const picked = await sketchor.ui.pickFolder().catch(() => null);
        if (!picked) return;
        folder = picked;
        groupFiles.clear();
        await loadGroupFiles();
        await pushView();
        notify(`Folder "${picked.name}": ${picked.files.length} file(s)${picked.truncated ? " (listing truncated)" : ""}.`, !!picked.truncated);
        return;
      }

      if (type === "make-groups") {
        if (typeof msg.text === "string") {
          bomText = msg.text.slice(0, 2_000_000);
          void sketchor.storage.set(KEY_BOM, bomText).catch(() => undefined);
        }
        // A CAD BOM whose material cells say "SHEET ..." keeps its old reading (it also drops tubes and hardware);
        // anything else is read as a CSV parts list with material and thickness columns.
        const parsed = parseSheetText(bomText);
        let groups = groupsFromRows(sumRepeatedRows(parsed.rows), job.material);
        let summary = parsed.skipped ? `; ${parsed.skipped} non-sheet row(s) skipped` : "";
        if (groups.length === 0) {
          const metric = ["mm", "cm", "m"].includes(bareUnitFor(job.outputUnit));
          const csv = parsePartsCsv(bomText, { defaultThicknessUnit: metric ? "mm" : "in" });
          const fallbackT = lengthMm(job.thickness) > 0 ? (["mm", "cm", "m"].includes(job.thickness.u) ? { v: String(Math.round(lengthMm(job.thickness) * 1000) / 1000), u: "mm" as const } : job.thickness.u === "in" ? job.thickness : { v: String(Math.round((lengthMm(job.thickness) / MM_PER_IN) * 10000) / 10000), u: "in" as const }) : null;
          groups = groupsFromCsvRows(csv.rows, { material: job.material, thickness: fallbackT, sheetFor: (m) => (m === job.material ? { ...job.sheet } : { ...sheetsFor(m)[0]!.size }) });
          const notes: string[] = [];
          if (csv.qtyMissing) notes.push(`${csv.qtyMissing} row(s) without a quantity nest once`);
          if (csv.materialUnknown) notes.push(`${csv.materialUnknown} unknown material(s) set to ${MATERIAL_NAMES[job.material] ?? job.material}`);
          if (csv.columns.includes("thickness") || csv.rows.some((r) => r.thickness)) notes.push(`bare thickness numbers read as ${metric ? "mm" : "inches"}`);
          else notes.push(`no thickness column - ${fallbackT ? `using ${fallbackT.v} ${fallbackT.u}` : "set each group's thickness"}`);
          summary = notes.length ? `; ${notes.join("; ")}` : "";
        }
        if (groups.length === 0) return fail("No parts found in the list. Use a CSV with a header such as Part, Qty, Material, Thickness (or paste a CAD parts list with a SHEET material column).");
        job = { ...job, mode: "groups", groups };
        persistJob();
        await loadGroupFiles();
        await pushView();
        notify(`${groups.length} group(s) (${groups.map(groupLabel).join(", ")}), ${groups.reduce((n, g) => n + g.items.length, 0)} part number(s)${summary}.`);
        return;
      }

      if (type === "group-set") {
        const id = str(msg.id);
        const patch = isObj(msg.patch) ? msg.patch : {};
        job = {
          ...job,
          groups: job.groups.map((g): JobGroup => {
            if (g.id !== id) return g;
            const next = { ...g };
            if (typeof patch.material === "string" && MATERIALS.some((m) => m.id === patch.material)) {
              next.material = patch.material as MaterialId;
              next.sheet = { ...sheetsFor(next.material)[0]!.size };
              next.rotation = defaultRotationFor(next.material);
            }
            if (typeof patch.thickness === "string") next.thickness = patch.thickness;
            if (patch.thicknessUnit === "mm") next.thicknessUnit = "mm";
            else if (patch.thicknessUnit === "in") delete next.thicknessUnit;
            if (typeof patch.kerf === "string") {
              const v = patch.kerf.trim().slice(0, 20);
              if (v === "") delete next.kerf;
              else next.kerf = { v, u: bareUnitFor(job.outputUnit) };
            }
            if (isObj(patch.sheet) && num(patch.sheet.w) > 0 && num(patch.sheet.h) > 0) next.sheet = { w: num(patch.sheet.w), h: num(patch.sheet.h) };
            if (typeof patch.rotation === "string" && ["none", "flip", "r90", "r45", "r30", "r15", "r10", "free"].includes(patch.rotation)) next.rotation = patch.rotation as RotationCode;
            return next;
          }),
        };
        persistJob();
        return void (msg.refresh === false ? undefined : await pushView());
      }

      if (type === "item-set") {
        const gid = str(msg.gid), numStr = str(msg.num);
        job = { ...job, groups: job.groups.map((g) => (g.id !== gid ? g : { ...g, items: g.items.map((it) => (it.num === numStr ? { ...it, qty: Math.max(1, Math.min(100000, Math.floor(num(msg.qty, it.qty)))) } : it)) })) };
        persistJob();
        return void (msg.refresh === false ? pushStatusOnly() : await pushView());
      }

      if (type === "item-remove") {
        const gid = str(msg.gid), numStr = str(msg.num);
        job = { ...job, groups: job.groups.map((g) => (g.id !== gid ? g : { ...g, items: g.items.filter((it) => it.num !== numStr) })).filter((g) => g.items.length > 0) };
        persistJob();
        return void (await pushView());
      }

      if (type === "check-nest") {
        const model = await sketchor.document.read();
        const issues = checkNestOverlaps(model);
        post({ type: "check-result", issues });
        notify(issues.length > 0 ? `${issues.length} sheet(s) have overlapping parts.` : "No overlaps found.", issues.length > 0);
        return;
      }

      // N-52: after cutting - the offcuts used come out of the library, the new ones go in, and the job's own inventory sheets used are taken off its stock.
      if (type === "save-remnants") {
        if (lastRemnants.length === 0 && lastRemnantUse.size === 0 && !lastUsed.some((n) => n > 0)) return fail("Nothing to update - the last result made no usable offcuts and used none.");
        const added = lastRemnants.map((r) => ({ width: r.rem.width, height: r.rem.height, materialId: r.materialId ?? job.material, thickness: r.thickness ?? lengthMm(job.thickness) }));
        const usedN = [...lastRemnantUse.values()].reduce((n, k) => n + k, 0);
        library = updateRemnantLibrary(library, lastRemnantUse, added, { from: (typeof msg.jobName === "string" && msg.jobName.trim()) || "Nest", date: new Date().toISOString().slice(0, 10) }, newRemnantId);
        persistLibrary();
        if (lastUsed.some((n) => n > 0)) {
          job = { ...job, stock: applyRemnantsToStock(job.stock, [], lastUsed) };
          persistJob();
        }
        const n = added.length;
        lastRemnants = [];
        lastUsed = [];
        lastRemnantUse = new Map();
        if (lastView) lastView = { ...lastView, remnants: [], offcutsUsed: [], libraryUpdated: true };
        await pushView();
        if (lastView) post({ type: "result", ...lastView });
        notify(`Offcut library updated: ${n} new offcut${n === 1 ? "" : "s"} added${usedN ? `, ${usedN} used taken out` : ""}.${job.useRemnants ? "" : ' Tick "Cut from matching offcuts first" to use them in the next job.'}`);
        return;
      }
      if (type === "lib-set" || type === "lib-delete") {
        const r = library.find((x) => x.id === str(msg.id));
        if (!r) return;
        if (type === "lib-delete") library = library.filter((x) => x !== r);
        else {
          const q = Math.floor(num(msg.qty, r.qty));
          if (q <= 0) library = library.filter((x) => x !== r);
          else r.qty = Math.min(9999, q);
        }
        persistLibrary();
        return void (await pushView());
      }
      if (type === "lib-add") {
        const bu = bareUnitFor(job.outputUnit);
        const toMm = (v: unknown) => parseLen(str(v), bu) * MM_PER_IN;
        const w = toMm(msg.w), h = toMm(msg.h), t = toMm(msg.thickness);
        const q = Math.max(1, Math.floor(num(msg.qty, 1)));
        const materialId = MATERIALS.some((m) => m.id === msg.material) ? (msg.material as string) : job.material;
        if (!(w > 0 && h > 0)) return fail("Enter the offcut's width and height.");
        if (!(t > 0)) return fail("Enter the offcut's thickness.");
        library = [...parseRemnantLibrary([...library, { id: newRemnantId(), width: w, height: h, materialId, thickness: t, qty: q, from: "by hand", date: new Date().toISOString().slice(0, 10) }])];
        persistLibrary();
        return void (await pushView());
      }

      if (type === "export-dxf") return void (await exportDxf(msg));
      if (type === "export-gcode") return void (await exportGcode(msg));
      if (type === "preview-toolpath") return void (await previewToolpath(msg));
      if (type === "post-save") {
        // N-42: the panel's profile editor. A built-in is saved as a custom copy; the user's own is replaced.
        const r = upsertCustomPost(custom.posts, msg.spec);
        if (!r.ok) return fail(`Post-processor not saved: ${r.errors.join("; ")}.`);
        custom.posts = r.list;
        persistCustom();
        job = r.id === DEFAULT_POST_ID ? job : { ...job, postId: r.id };
        persistJob();
        post({ type: "post-saved" });
        await pushView();
        return notify(`Saved post-processor "${custom.posts.find((p) => p.id === r.id)?.name ?? r.id}".`);
      }
      if (type === "post-delete") {
        const id = typeof msg.id === "string" ? msg.id : "";
        if (!isCustomPostId(id)) return fail("Only your own post-processors can be deleted.");
        custom.posts = removeCustomPost(custom.posts, id);
        persistCustom();
        if (job.postId === id) {
          const { postId: _gone, ...rest } = job;
          job = rest;
          persistJob();
        }
        await pushView();
        return notify("Post-processor deleted.");
      }

      // ---------- NT-02: machine files ----------
      if (type === "profile-new") {
        if (profiles.length >= MAX_PROFILES) return fail(`Up to ${MAX_PROFILES} machine files.`);
        const preset = typeof msg.preset === "string" ? amadaPreset(msg.preset) : undefined;
        if (preset) {
          const id = newProfileId();
          profiles = [...profiles, machineFromPreset(preset, id)];
          persistProfiles();
          await pushView();
          notify(`Added "${preset.profile.name}". Its cut table is a typical starting point, not Amada's data - check it against your machine's cutting conditions.`);
          return void post({ type: "profile-created", id });
        }
        const from = profiles.find((x) => x.id === str(msg.copyOf));
        const id = newProfileId();
        const pr: MachineProfile = from ? { ...from, id, name: `${from.name} (copy)`, rows: from.rows.map((r) => ({ ...r })) } : newMachineProfile(id, msg.kind === "tube" ? "Tube laser" : "My laser");
        if (!from && msg.kind === "tube") {
          pr.type = "tube";
          pr.bedW = 0;
          pr.bedH = 0;
          pr.sheetLoadMin = 0.75;
        }
        profiles = [...profiles, pr];
        persistProfiles();
        await pushView();
        return void post({ type: "profile-created", id });
      }
      if (type === "profile-save") {
        const id = isObj(msg.profile) ? str(msg.profile.id) : "";
        const pr = parseMachineProfile(msg.profile, id || newProfileId());
        if (!pr) return fail("That machine file could not be read.");
        const i = profiles.findIndex((x) => x.id === pr.id);
        profiles = i >= 0 ? profiles.map((x, k) => (k === i ? pr : x)) : [...profiles, pr].slice(0, MAX_PROFILES);
        persistProfiles();
        if (job.profileId === pr.id) {
          const next = { ...job };
          if (pr.type === "tube") delete next.profileId;
          else applyProfile(next);
          job = next;
          persistJob();
        }
        if (msg.refresh === false) return;
        return void (await pushView());
      }
      if (type === "profile-delete") {
        const id = str(msg.id);
        profiles = profiles.filter((x) => x.id !== id);
        persistProfiles();
        if (job.profileId === id) {
          const { profileId: _drop, ...rest } = job;
          job = rest;
          persistJob();
        }
        if (tubeInput.profileId === id) tubeInput = { ...tubeInput, profileId: "" };
        return void (await pushView());
      }
      if (type === "profile-import") {
        let raw: unknown = null;
        try {
          raw = JSON.parse(str(msg.text));
        } catch {
          return fail("That is not a machine file (.sketchor-machine).");
        }
        const list = Array.isArray(raw) ? raw : [raw];
        let added = 0;
        for (const r of list) {
          if (profiles.length >= MAX_PROFILES) break;
          const pr = parseMachineProfile(r, newProfileId());
          if (!pr) continue;
          if (profiles.some((x) => x.id === pr.id)) pr.id = newProfileId();
          profiles = [...profiles, pr];
          added++;
        }
        if (added === 0) return fail("No machine could be read from that file.");
        persistProfiles();
        await pushView();
        return notify(`Imported ${added} machine file${added === 1 ? "" : "s"}.`);
      }
      if (type === "profile-export") {
        const pr = profiles.find((x) => x.id === str(msg.id));
        if (!pr) return;
        const name = `${pr.name.replace(/[^\w.-]+/g, "-").replace(/^-+|-+$/g, "") || "machine"}.sketchor-machine`;
        const res = await sketchor.ui.saveFile(name, serializeMachineProfile(pr), [{ description: "Sketchor machine file", accept: { "application/json": [".sketchor-machine"] } }]);
        if (res.saved) notify(`Saved ${res.name ?? name}.`);
        return;
      }

      // ---------- NT-03 / NT-04: calculators ----------
      // NT-05: the Bars / Tubes plan drawn to scale on a canvas tab, or printed with its time estimate.
      if (type === "calc-draw" || type === "calc-print") {
        const tube = msg.kind === "tube";
        if (tube) tubeInput = parseTubeInput(msg.input);
        else barInput = parseBarInput(msg.input);
        const res = tube ? runTubeCalc(tubeInput, profiles) : runBarCalc(barInput);
        if (res.error) return fail(res.error);
        if (res.bars.length === 0) return fail("Nothing to draw - no bar holds any of the pieces.");
        const noun = tube ? "Tube" : "Bar";
        if (type === "calc-draw") {
          const n = res.bars.reduce((k, b) => k + b.count, 0);
          await sketchor.app.openDocumentTab(`${tube ? "Tubes" : "Bars"} – ${n} bar${n === 1 ? "" : "s"}, ${res.bars.length} pattern${res.bars.length === 1 ? "" : "s"}`, barLayoutCommands(res, { noun }));
          return;
        }
        const jobName = typeof msg.jobName === "string" ? msg.jobName.slice(0, 120) : "";
        const meta = { title: tube ? "Tube Cutting Report" : "Bar Cutting Report", noun, jobName, notes: typeof msg.notes === "string" ? msg.notes.slice(0, 2000) : "", date: new Date().toLocaleString() };
        sketchor.ui.print(buildBarReportHtml(res, meta), { fileName: `${tube ? "tube" : "bar"}-cutting${jobName ? `-${jobName.replace(/[^\w-]+/g, "_").slice(0, 40)}` : ""}`, pdf: buildBarReportPdf(res, meta) });
        return;
      }

      if (type === "bar-calc") {
        barInput = parseBarInput(msg.input);
        void sketchor.storage.set(KEY_BARCALC, barInput).catch(() => undefined);
        return void post({ type: "bar-result", result: runBarCalc(barInput) });
      }
      if (type === "tube-calc") {
        tubeInput = parseTubeInput(msg.input);
        void sketchor.storage.set(KEY_TUBECALC, tubeInput).catch(() => undefined);
        return void post({ type: "tube-result", result: runTubeCalc(tubeInput, profiles) });
      }

      if (type === "rotate-selected") return void (await rotateSelected(num(msg.deg, 0)));
      if (type === "tray-add") return void (await addToTray(str(msg.key), num(msg.count, 1)));
      if (type === "manual-check") return void (await checkManual());

      if (type === "print") {
        const ln = await currentNest();
        if (!ln) return fail("Nothing to print - nest some parts first.");
        const jobName = typeof msg.jobName === "string" ? msg.jobName : "";
        const report = reportWithJob(ln, jobName, typeof msg.notes === "string" ? msg.notes : "");
        sketchor.ui.print(buildNestReportHtml(report), { fileName: reportFileName(jobName), pdf: buildNestReportPdf(report) });
        return;
      }

      if (type === "save-job") {
        const fileList: JobFileFile[] = [...files.values()].map((f) => ({ key: f.key, name: f.name, kind: "dxf", text: f.text, unit: f.unit }));
        const res = await sketchor.ui.saveFile("nest-job.sketchor-nest", serializeJobFile(job, fileList, { custom }), [{ description: "Sketchor nest job", accept: { "application/json": [".sketchor-nest"] } }]);
        if (res.saved) notify(`Saved ${res.name ?? "nest-job.sketchor-nest"}.`);
        return;
      }

      if (type === "open-job") {
        const jf = parseJobFile(str(msg.text));
        if (!jf) return fail("That is not a Sketchor nest job file.");
        job = parseNestJob(jf.job);
        files.clear();
        for (const f of jf.files) files.set(f.key, loadDxfFile(f.key, f.name, f.text, f.unit, job.joinTolerance));
        lastSheetKerf = [];
        lastSheetTag = [];
        lastGap = null;
        lastNest = null;
        manual = null;
        lastManual = null;
        lastView = null;
        persistJob();
        persistFiles();
        post({ type: "cleared" });
        await pushView();
        notify(`Opened job: ${job.parts.length} part(s).`);
        return;
      }
    });

    /** Light refresh after a qty edit: readiness only, so the panel does not re-render the row being typed in. */
    const pushStatusOnly = () => {
      void (async () => {
        const v = await buildView();
        post({ type: "status", status: v.status, canCalculate: v.canCalculate, partsProblem: v.partsProblem });
      })();
    };

    interface ResultView {
      [k: string]: unknown;
    }
  },
};

export default plugin;
