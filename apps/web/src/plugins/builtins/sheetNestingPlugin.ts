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
  defaultJob,
  defaultMachines,
  defaultRotationFor,
  defaultSheets,
  describeCnc,
  describeGroup,
  describeNotes,
  effectiveClamp,
  engineFor,
  extractPartsWithDiagnostics,
  fmtMm,
  groupIdenticalSheets,
  groupsFromRows,
  parseSheetText,
  resolveItem,
  sumRepeatedRows,
  type JobGroup,
  jobParamsMm,
  jobParts,
  jobReadiness,
  jobSheets,
  lengthMm,
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
  stackedSheetsDxfEntities,
  stockUsage,
  thicknessesFor,
  checkNestOverlaps,
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
import { buildCutPlan, writeGcode, type GcodePlacement } from "@sketchor/plugin-gcode";
import { entitiesToDxf, entityPoints, MM_PER_INSUNIT, parseDxf, scaleEntityKeepingInserts, textWidth, type Entity } from "@sketchor/core";
import { type DisplayUnitInfo, type PickedFolder, type PluginModule } from "@sketchor/plugin-sdk";
import { displayUnitToDxfCode, factorFromMm } from "../../units";
import { buildNestReportHtml, buildNestReportPdf, type LastNest, type LastNestPlacement } from "./nestReport";
import { SHEET_NESTING_PANEL_HTML } from "./sheetNestingPanel";

/**
 * "Sheet Nesting" (RN-30/31/32): the raster-first nesting panel, a separate
 * plugin next to the older Sheet Metal Nest (which is left as it was). The
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
/** Groups mode looks up DXF drawings only (DWG needs a conversion step; add the file in Manual mode). */
const DRAWING_EXTS = /\.dxf$/i;
const MATERIAL_NAMES: Record<string, string> = { al5052: "AL 5052", al6061: "AL 6061", ss: "Stainless", cs: "Carbon steel", plastic: "Plastic", plywood: "Plywood", stone: "Stone", quartz: "Quartz" };
const MM_PER_IN = 25.4;
const MAX_FILE_BYTES = 20_000_000;

/** Cutting-time seed table (same estimates as the Sheet Metal Nest plugin). */
const CUT_TABLE: CutTableRow[] = [
  { material: "Mild Steel", thickness: 1, feedRateMmPerMin: 6000, pierceTimeSec: 0.3, rapidMmPerMin: 15000, estimated: true, densityKgPerM3: 7850 },
  { material: "Mild Steel", thickness: 3, feedRateMmPerMin: 3500, pierceTimeSec: 0.6, rapidMmPerMin: 15000, estimated: true, densityKgPerM3: 7850 },
  { material: "Mild Steel", thickness: 6, feedRateMmPerMin: 1800, pierceTimeSec: 1.2, rapidMmPerMin: 12000, estimated: true, densityKgPerM3: 7850 },
  { material: "Stainless Steel", thickness: 3, feedRateMmPerMin: 2800, pierceTimeSec: 0.8, rapidMmPerMin: 15000, estimated: true, densityKgPerM3: 8000 },
  { material: "Aluminum", thickness: 3, feedRateMmPerMin: 4500, pierceTimeSec: 0.4, rapidMmPerMin: 15000, estimated: true, densityKgPerM3: 2700 },
];

const CUT_MATERIAL_NAME: Partial<Record<MaterialId, string>> = { al5052: "Aluminum", al6061: "Aluminum", cs: "Mild Steel", ss: "Stainless Steel" };

type Pt = { x: number; y: number };

/** User-owned catalog edits: custom sheet sizes per material and the last-used machine parameters. */
export interface Custom {
  sheets: Partial<Record<MaterialId, SheetSize[]>>;
  machines: Partial<Record<MachineId, MachineParams>>;
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

export function stableKey(sourceIds: string[]): string {
  return [...sourceIds].sort().join(",");
}

/** Builds a part record from an extracted part. */
export function recFromExtracted(
  p: { name: string; outer: Pt[]; holes: Pt[][]; outerSourceIds: string[]; holeSourceIds: string[][]; cutLength: number; pierceCount: number; holeCount: number },
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
    area: Math.max(0, polygonArea(p.outer) - holesArea),
    w: b.maxX - b.minX,
    h: b.maxY - b.minY,
    cutLength: p.cutLength,
    pierceCount: p.pierceCount,
    holeCount: p.holeCount,
    notes,
    cnc: cncInfoForPart(p),
    ...(file ? { file } : {}),
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
    base.parts = parts.map((p, i) => recFromExtracted({ ...p, name: parts.length > 1 ? `${name} (${i + 1})` : name }, `${key}#${i}`, lookup, notes, key));
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
    const custom: Custom = { sheets: {}, machines: {} };
    if (isObj(customRaw)) {
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
            custom.machines[m] = { kerf: readField(mp.kerf, d.kerf), web: readField(mp.web, d.web), margin: readField(mp.margin, d.margin), clamp: readField(mp.clamp, d.clamp), bedW: readField(mp.bedW, d.bedW), bedH: readField(mp.bedH, d.bedH) };
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

    let lastNest: LastNest | null = null;
    let lastView: ResultView | null = null;
    /** Effective stock rows (with material / thickness) of the last result, for the G-code feed-rate lookup. */
    let lastStock: StockRow[] = [];
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

    const itemStatus = (it: { num: string; qty: number }): ItemStatus => {
      if (!folder) return { ...it, state: "nofolder", per: 1, need: null };
      const r = resolveItem(it.num, it.qty, folder.files, DRAWING_EXTS);
      if (!r.file) return { ...it, state: "missing", per: 1, need: r.need };
      const f = groupFiles.get(r.file.relPath);
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

    const buildGroupRuns = (): Run[] => {
      const runs: Run[] = [];
      for (const g of job.groups) {
        const needByFile = new Map<string, number>();
        for (const it of g.items) {
          const s = itemStatus(it);
          if (s.state === "ok" && s.relPath) needByFile.set(s.relPath, (needByFile.get(s.relPath) ?? 0) + (s.need ?? it.qty));
        }
        const recs = new Map<string, PartRec>();
        const parts: JobPart[] = [];
        for (const [relPath, need] of needByFile) {
          for (const p of groupFiles.get(relPath)?.parts ?? []) {
            recs.set(p.key, p);
            parts.push({ key: p.key, sourceIds: [], name: p.name, qty: need, rotation: g.rotation, mirror: false, allowInHoles: false });
          }
        }
        const label = `${MATERIAL_NAMES[g.material] ?? g.material}${g.thickness ? ` ${g.thickness}"` : ""}`;
        runs.push({ label, job: { ...job, mode: "manual", material: g.material, thickness: { v: g.thickness, u: "in" }, sheet: g.sheet, sheetSource: "standard", stock: [], buyExtra: false, parts }, recs });
      }
      return runs;
    };

    const groupsView = () =>
      job.groups.map((g) => ({
        id: g.id,
        material: g.material,
        thickness: g.thickness,
        sheet: g.sheet,
        rotation: g.rotation,
        sheetOptions: sheetsFor(g.material).map((s) => ({ w: s.size.w, h: s.size.h, label: `${fmtMm(s.size.w * MM_PER_IN, job.outputUnit)} × ${fmtMm(s.size.h * MM_PER_IN, job.outputUnit)}` })),
        thicknessOptions: thicknessesFor(g.material).map((t) => ({ value: t.value, label: t.label ? `${t.value}" · ${t.label}` : `${t.value}"` })),
        items: g.items.map((it) => {
          const s = itemStatus(it);
          return { num: it.num, qty: it.qty, state: s.state, file: s.relPath, per: s.per, need: s.need, error: s.error };
        }),
      }));

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
    const num3 = (mm: number) => String(Math.round((bareUnitFor(job.outputUnit) === "in" ? mm / MM_PER_IN : bareUnitFor(job.outputUnit) === "cm" ? mm / 10 : bareUnitFor(job.outputUnit) === "m" ? mm / 1000 : mm) * 1000) / 1000);
    const thumbOf = (outer: Pt[]) => {
      const step = Math.max(1, Math.ceil(outer.length / 60));
      return outer.filter((_, i) => i % step === 0).map((p) => [Math.round(p.x * 100) / 100, Math.round(p.y * 100) / 100]);
    };

    const geometryMap = (recs: Map<string, PartRec>) => new Map([...recs].map(([k, r]) => [k, { id: k, name: r.name, outer: r.outer, holes: r.holes }]));

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
        unsupported,
        bedWarn,
        sheetOptions: sheetsFor(job.material).map((s) => ({ w: s.size.w, h: s.size.h, custom: s.custom, label: `${fmtMm(s.size.w * MM_PER_IN, job.outputUnit)} × ${fmtMm(s.size.h * MM_PER_IN, job.outputUnit)}` })),
        thicknessOptions: thicknessesFor(job.material).map((t) => ({ value: t.value, label: t.label ? `${t.value}" · ${t.label}` : `${t.value}"` })),
        materials: MATERIALS.map((m) => m.id),
        stockRows: job.stock.map((s) => ({ name: s.size.name, w: num3(s.size.width), h: num3(s.size.height), qty: s.qty === null ? "" : String(s.qty), thickness: s.thickness })),
        bareUnit: bareUnitFor(job.outputUnit),
        credit: NEST_CREDIT,
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
      if (patch.searchLevel === "quick" || patch.searchLevel === "normal" || patch.searchLevel === "thorough") next.searchLevel = patch.searchLevel;
      job = next;
      persistJob();
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
    void sketchor.selection.onChange(async () => {
      const selection = await sketchor.selection.read();
      if (selection.length === 0) return post({ type: "selection-hint", count: 0, openCount: 0 });
      const model = await sketchor.document.read();
      const { parts, openChains } = extractPartsWithDiagnostics([...model.entities], new Set(selection), { joinTolerance: job.joinTolerance });
      post({ type: "selection-hint", count: parts.length, openCount: openChains.length });
    });

    sketchor.commands.register("sheet-nesting.open", () => {
      void sketchor.ui.show(PANEL_HTML, { title: "Sheet Nesting", width: 380, height: 640 });
      void pushInit();
    });

    // ---------- nest ----------

    interface Run {
      label: string;
      job: NestJob;
      recs: Map<string, PartRec>;
    }

    const tagStock = (r: RasterNestResult, run: Run): RasterNestResult => {
      const material = CUT_MATERIAL_NAME[run.job.material];
      const thickness = lengthMm(run.job.thickness);
      return { ...r, stock: r.stock.map((s) => ({ ...s, ...(material ? { material } : {}), ...(thickness > 0 ? { thickness } : {}) })) };
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

    const presentResult = async (runs: Run[], result: RasterNestResult, sheetRun: number[], unsupported: { option: string; reason: string }[], stopped: boolean) => {
      const recByKey = new Map<string, PartRec>();
      const orderedMap = new Map<string, { key: string; name: string; quantity: number }>();
      runs.forEach((run) => {
        for (const jp of run.job.parts) {
          const r = run.recs.get(jp.key);
          if (!r || jp.qty <= 0) continue;
          recByKey.set(jp.key, r);
          const cur = orderedMap.get(jp.key);
          if (cur) cur.quantity += jp.qty;
          else orderedMap.set(jp.key, { key: jp.key, name: r.name, quantity: jp.qty });
        }
      });

      const placements: LastNestPlacement[] = [];
      let number = 0;
      for (let i = 0; i < result.placed.length; i++) {
        const pl = result.placed[i]!;
        const p = recByKey.get(pl.partId);
        if (!p) continue;
        const outerSource = p.outerSourceIds.map((id) => p.lookup.get(id)).filter((e): e is Entity => e !== undefined);
        if (outerSource.length === 0) continue;
        const holeSource = p.holeSourceIds.flat().map((id) => p.lookup.get(id)).filter((e): e is Entity => e !== undefined);
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
        });
      }

      const grouped = runs.length > 1;
      const sheetLabel = (sheet: TrueNestSheet, i: number): string => {
        const run = runs[sheetRun[i] ?? 0];
        return `${grouped && run ? run.label + " – " : ""}Sheet ${i + 1}/${result.sheets.length} – ${fmt(sheet.width)} × ${fmt(sheet.height)}`;
      };
      const sheetLabels = result.sheets.map((s, i) => sheetLabel(s, i));
      const groups = groupIdenticalSheets(result.sheets, result.placed);
      const clamp = runs[0] ? lengthMm(effectiveClamp(runs[0].job)) : 0;
      const layout = buildSideBySideLayout(result.sheets, placements, groups, sheetLabel, { clamp });
      await sketchor.app.openDocumentTab(`Nest – ${result.placed.length} part${result.placed.length === 1 ? "" : "s"}, ${result.sheets.length} sheet${result.sheets.length === 1 ? "" : "s"}`, layout);

      const geoMap = new Map([...recByKey].map(([k, r]) => [k, { outer: r.outer, holes: r.holes }]));
      const cutMap = new Map([...recByKey].map(([k, r]) => [k, { cutLength: r.cutLength, pierceCount: r.pierceCount }]));
      const metrics: JobMetrics = computeJobMetrics(result, geoMap, result.stock, CUT_TABLE, { gravity: job.gravity, cut: cutMap });
      const required = [...orderedMap.values()].reduce((n, o) => n + o.quantity, 0);
      const source = runs[0]?.job.sheetSource ?? job.sheetSource;
      const kpis = resultKpis(result, source, required, {
        cutLengthMm: metrics.sheets.reduce((n, s) => n + s.cutLengthMm, 0),
        pierces: metrics.sheets.reduce((n, s) => n + s.pierceCount, 0),
      });
      const usage = stockUsage(result, source);
      lastStock = result.stock;

      lastNest = {
        sheets: result.sheets,
        sheetLabels,
        placements,
        metrics,
        result,
        ordered: [...orderedMap.values()],
        unit: { perMm: unit.perMm, label: unit.label },
        footer: NEST_CREDIT,
        summary: {
          kpis,
          stock: usage.map((u) => ({ ...u, size: `${fmt(u.width)} × ${fmt(u.height)}` })),
          groups: grouped ? runs.map((r) => r.label) : [],
        },
      };

      const unplaced = result.unplaced
        .map((u) => ({ name: recByKey.get(u.partId)?.name ?? u.partId, count: u.count }))
        .filter((u) => u.count > 0);
      lastView = {
        kpis: { ...kpis, cutLength: fmt(kpis.cutLengthMm) },
        stock: usage.map((u) => ({ name: u.name, size: `${fmt(u.width)} × ${fmt(u.height)}`, used: u.used, purchased: u.purchased, available: u.available })),
        unplaced,
        notes: result.notes,
        unsupported,
        stopped,
        ms: result.ms,
        cards: groups.map((g) => {
          const first = g.indices[0]!;
          const m = metrics.sheets[first]!;
          return {
            title: g.indices.length > 1 ? describeGroup(g.indices) : `Sheet ${first + 1}`,
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
      return [{ label: "", job: { ...job, mode: "manual" }, recs }];
    };

    // ---------- export ----------

    const exportDxf = async (msg: Record<string, unknown>) => {
      const ln = lastNest;
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
        const name = sheetDxfFileName(sheetIndex);
        const res = await sketchor.ui.saveFile(name, sheetDxf(sheetIndex), filters);
        if (res.saved) notify(`Saved ${res.name ?? name}.`);
        return;
      }
      if (preset === "nest") {
        const res = await sketchor.ui.saveFile("nest-all.dxf", entitiesToDxf(stackedSheetsDxfEntities(ln.sheets, ln.sheetLabels, ln.placements), dxfUnit, dxfScale), filters);
        if (res.saved) notify(`Saved ${res.name ?? "nest-all.dxf"}.`);
        return;
      }
      if (ln.sheets.length === 1) {
        const res = await sketchor.ui.saveFile(sheetDxfFileName(0), sheetDxf(0), filters);
        if (res.saved) notify(`Saved ${res.name ?? sheetDxfFileName(0)}.`);
        return;
      }
      const zip = makeZip(ln.sheets.map((_, i) => ({ name: sheetDxfFileName(i), data: sheetDxf(i) })));
      const res = await sketchor.ui.saveFile("nest-sheets.zip", zip, [{ description: "ZIP archive", accept: { "application/zip": [".zip"] } }]);
      if (res.saved) notify(`Saved ${res.name ?? "nest-sheets.zip"} (${ln.sheets.length} sheets).`);
    };

    const exportGcode = async (msg: Record<string, unknown>) => {
      const ln = lastNest;
      if (!ln) return fail("Nothing to export - nest some parts first.");
      const sheetIndex = typeof msg.sheetIndex === "number" ? msg.sheetIndex : 0;
      if (sheetIndex < 0 || sheetIndex >= ln.sheets.length) return fail("That sheet no longer exists - nest again.");
      const gp: GcodePlacement[] = ln.placements
        .filter((p) => p.sheet === sheetIndex)
        .map((p) => ({ id: p.id, number: p.number, outerEntities: p.outerEntities, holeEntities: p.holeEntities, insideOfId: p.insideOfId }));
      const plan = buildCutPlan(gp, { kerf: jobParamsMm(job).kerf });
      for (const w of plan.warnings) notify(w, true);
      const cutRow = cutTableRowFor(lastStock[ln.sheets[sheetIndex]!.stockIndex] as StockRow | undefined, CUT_TABLE);
      if (!cutRow) notify("No cut-table match for this sheet's material/thickness - using a default feed rate; check it before running the program.", true);
      const gunit = unit.unit === "in" ? "in" : "mm";
      const gcode = writeGcode(plan.features, {
        unit: gunit,
        scale: gunit === "in" ? factorFromMm("in") : 1,
        feedRateMmPerMin: cutRow?.feedRateMmPerMin ?? 2000,
        pierceTimeSec: cutRow?.pierceTimeSec ?? 0.5,
        sheetLabel: ln.sheetLabels[sheetIndex],
      });
      const name = `nest-sheet-${sheetIndex + 1}.nc`;
      const res = await sketchor.ui.saveFile(name, gcode, [{ description: "G-code", accept: { "text/plain": [".nc", ".gcode", ".tap"] } }]);
      if (res.saved) notify(`Saved ${res.name ?? name}.`);
    };

    // ---------- messages ----------

    sketchor.ui.onMessage(async (raw) => {
      const msg = isObj(raw) ? raw : {};
      const type = msg.type;

      if (type === "ready") return void (await pushInit());

      if (type === "job-set") {
        if (isObj(msg.patch)) applyPatch(msg.patch);
        return void (await pushView());
      }

      if (type === "add-selection") {
        const [model, selection] = await Promise.all([sketchor.document.read(), sketchor.selection.read()]);
        const entities = [...model.entities];
        const { parts, openChains } = extractPartsWithDiagnostics(entities, new Set(selection), { joinTolerance: job.joinTolerance });
        if (parts.length === 0) {
          return fail(openChains.length > 0 ? `No closed shape found: ${openChains.length} shape(s) are open - close the gap in the drawing.` : "Select one or more closed shapes first.");
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
        job = { ...job, parts: next };
        persistJob();
        persistFiles();
        await pushView();
        if (added > 0) notify(`${added} part(s) added from ${incoming.length} file(s).`);
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
        lastNest = null;
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
        const parsed = parseSheetText(bomText);
        const groups = groupsFromRows(sumRepeatedRows(parsed.rows), job.material);
        if (groups.length === 0) return fail("No SHEET rows found in the list. Paste a parts list with part numbers, quantities and a material column.");
        job = { ...job, mode: "groups", groups };
        persistJob();
        await loadGroupFiles();
        await pushView();
        notify(`${groups.length} group(s), ${groups.reduce((n, g) => n + g.items.length, 0)} part number(s)${parsed.skipped ? `; ${parsed.skipped} non-sheet row(s) skipped` : ""}.`);
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

      if (type === "export-dxf") return void (await exportDxf(msg));
      if (type === "export-gcode") return void (await exportGcode(msg));

      if (type === "print") {
        if (!lastNest) return fail("Nothing to print - nest some parts first.");
        sketchor.ui.print(buildNestReportHtml(lastNest), { fileName: "nest-report", pdf: buildNestReportPdf(lastNest) });
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
        lastNest = null;
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
        post({ type: "status", status: v.status, canCalculate: v.canCalculate });
      })();
    };

    interface ResultView {
      [k: string]: unknown;
    }
  },
};

export default plugin;
