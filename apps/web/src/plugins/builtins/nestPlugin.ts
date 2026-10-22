import {
  area as polygonArea,
  bounds,
  buildSideBySideLayout,
  checkNestOverlaps,
  clearPreviousLayout,
  computeJobMetrics,
  makeZip,
  sheetDxfEntities,
  sheetDxfFileName,
  stackedSheetsDxfEntities,
  type DxfPreset,
  cutTableRowFor,
  extractParts,
  extractPartsWithDiagnostics,
  groupIdenticalSheets,
  materializeInstance,
  nestTrueShapeSearch,
  NEST_HOLES_LAYER,
  NEST_PARTS_LAYER,
  placementTransform,
  sheetOffsets,
  type CutTableRow,
  type Gravity,
  type JobMetrics,
  type OpenChainInfo,
  type SearchLevel,
  type StockRow,
  type TrueNestPart,
  type TrueNestSheet,
} from "@sketchor/plugin-nest";
import { buildCutPlan, writeGcode, type GcodePlacement } from "@sketchor/plugin-gcode";
import { entitiesToDxf, entityPoints, textWidth, type Entity } from "@sketchor/core";
import { type DisplayUnitInfo, type PluginModule } from "@sketchor/plugin-sdk";
import { displayUnitToDxfCode, factorFromMm } from "../../units";
import { buildNestReportHtml, buildNestReportPdf, type LastNest, type LastNestPlacement } from "./nestReport";

/**
 * First-party dogfood: sheet metal nesting. The true-shape (no-fit-polygon)
 * engine lives in `@sketchor/plugin-nest` (SDK-only, no document access);
 * this module shows the panel, tracks a *working set* of parts built up
 * from the selection across multiple "Add selection" clicks, and on
 * request nests them and applies the layout through `document.apply` as
 * one undo step. Upgrades the plugin in place (same manifest id) — the old
 * bbox engine (`nest.ts`/`nestParts()`) stays exported and untouched, just
 * no longer wired to this UI.
 */

// --- persisted state ---

export type RotationMode = "locked" | "quarter" | "any";

export interface PartSettings {
  quantity: number;
  rotationMode: RotationMode;
  /** "any" only. */
  stepDeg?: number;
  mirror: boolean;
  /** N-12: try this part inside another part's hole before the open sheet area. */
  allowInHoles: boolean;
}

/** A part in the working set: identified by its stable `sourceIds` key, not `ExtractedPart.id` (synthetic, not stable across extraction calls). */
export interface WorkingPartEntry {
  key: string;
  sourceIds: string[];
  settings: PartSettings;
}

export interface PersistedState {
  stock: StockRow[];
  workingParts: WorkingPartEntry[];
  /** Gap between parts, mm. */
  spacing: number;
  edgeMargin: number;
  /** Added into spacing at nest time. */
  kerf: number;
  gravity: Gravity;
  /** N-12: a hole smaller than this (mm², after shrinking inward by spacing) is never offered to an allowInHoles part. */
  minHoleArea: number;
  /** N-14: how long to spend trying alternate orderings for a denser packing. Default "quick" (today's single deterministic pass). */
  searchLevel: SearchLevel;
  /**
   * NF-03: how close two ends have to be (mm) for "Add selection" to treat
   * them as meeting — real DXFs routinely have a gap of a few hundredths to
   * a few tenths of a millimetre where a part "should" close. Defaults to
   * the engine's own near-exact tolerance (`undefined` — see
   * `extractPartsWithDiagnostics`'s `joinTolerance` default) so existing
   * jobs behave exactly as before until the user raises it.
   */
  joinTolerance?: number;
}

const STORAGE_KEY = "state";
/** NF-03: upper bound for the Join tolerance setting — past this a "small gap" stops being a plausible drafting error and starts silently merging unrelated shapes. */
const MAX_JOIN_TOLERANCE = 0.5;

export const SEED_STOCK: StockRow[] = [
  { size: { name: "48×96 in", width: 1219.2, height: 2438.4 }, qty: null },
  { size: { name: "60×120 in", width: 1524, height: 3048 }, qty: null },
  { size: { name: "48×120 in", width: 1219.2, height: 3048 }, qty: null },
  { size: { name: "1250×2500 mm", width: 1250, height: 2500 }, qty: null },
  { size: { name: "1500×3000 mm", width: 1500, height: 3000 }, qty: null },
];

/**
 * Seed cutting-time table — deliberately small and clearly `estimated`.
 * There's no cut-table editor in this pass; a matching row (by material name,
 * case-insensitively, and thickness within 0.05mm) just lets the Results
 * tab show a rough time instead of nothing. Real machine values are a
 * follow-up, not a guess this pass should pretend is precise.
 */
export const DEFAULT_CUT_TABLE: CutTableRow[] = [
  { material: "Mild Steel", thickness: 1, feedRateMmPerMin: 6000, pierceTimeSec: 0.3, rapidMmPerMin: 15000, estimated: true, densityKgPerM3: 7850 },
  { material: "Mild Steel", thickness: 3, feedRateMmPerMin: 3500, pierceTimeSec: 0.6, rapidMmPerMin: 15000, estimated: true, densityKgPerM3: 7850 },
  { material: "Mild Steel", thickness: 6, feedRateMmPerMin: 1800, pierceTimeSec: 1.2, rapidMmPerMin: 12000, estimated: true, densityKgPerM3: 7850 },
  { material: "Stainless Steel", thickness: 3, feedRateMmPerMin: 2800, pierceTimeSec: 0.8, rapidMmPerMin: 15000, estimated: true, densityKgPerM3: 8000 },
  { material: "Aluminum", thickness: 3, feedRateMmPerMin: 4500, pierceTimeSec: 0.4, rapidMmPerMin: 15000, estimated: true, densityKgPerM3: 2700 },
];

const ROTATION_MODES: RotationMode[] = ["locked", "quarter", "any"];
const GRAVITIES: Gravity[] = ["bottom-left", "bottom-right", "top-left", "top-right"];
const SEARCH_LEVELS: SearchLevel[] = ["quick", "normal", "thorough"];

function num(v: unknown, fallback = 0): number {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : fallback;
}
function str(v: unknown, fallback = ""): string {
  return typeof v === "string" ? v : fallback;
}

export function asStockRow(v: unknown): StockRow | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  const sizeObj = (o.size && typeof o.size === "object" ? o.size : {}) as Record<string, unknown>;
  const width = Math.max(1, num(sizeObj.width, 1));
  const height = Math.max(1, num(sizeObj.height, 1));
  const name = str(sizeObj.name) || "Sheet";
  const material = str(o.material);
  const qty = o.qty === null || o.qty === undefined || o.qty === "" ? null : Math.max(0, Math.floor(num(o.qty, 0)));
  const thickness = o.thickness === undefined || o.thickness === null || o.thickness === "" ? undefined : Math.max(0, num(o.thickness, 0));
  const cost = o.cost === undefined || o.cost === null || o.cost === "" ? undefined : Math.max(0, num(o.cost, 0));
  return { size: { name, width, height }, ...(material ? { material } : {}), ...(thickness !== undefined ? { thickness } : {}), qty, ...(cost !== undefined ? { cost } : {}) };
}

export function asPartSettings(v: unknown): PartSettings {
  const o = (v && typeof v === "object" ? v : {}) as Record<string, unknown>;
  const rotationMode = ROTATION_MODES.includes(o.rotationMode as RotationMode) ? (o.rotationMode as RotationMode) : "quarter";
  return {
    quantity: Math.max(0, Math.floor(num(o.quantity, 1))),
    rotationMode,
    stepDeg: o.stepDeg === undefined ? undefined : Math.max(1, num(o.stepDeg, 15)),
    mirror: !!o.mirror,
    allowInHoles: !!o.allowInHoles,
  };
}

function asWorkingPart(v: unknown): WorkingPartEntry | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  const key = str(o.key);
  const sourceIds = Array.isArray(o.sourceIds) ? o.sourceIds.filter((x): x is string => typeof x === "string") : [];
  if (!key || sourceIds.length === 0) return null;
  return { key, sourceIds, settings: asPartSettings(o.settings) };
}

/**
 * Unrecognized/old-shaped stored data (the previous panel's `presets`/
 * `maxSheets` model is a different data model entirely — there's no
 * meaningful field-by-field migration from a global `maxSheets` counter to
 * per-row stock quantities) is simply treated as absent: fresh seeds, empty
 * working set, never a crash.
 */
export function asState(v: unknown): PersistedState {
  const o = (v && typeof v === "object" ? v : {}) as Record<string, unknown>;
  const stock = Array.isArray(o.stock) ? o.stock.map(asStockRow).filter((s): s is StockRow => s !== null) : [];
  const workingParts = Array.isArray(o.workingParts) ? o.workingParts.map(asWorkingPart).filter((p): p is WorkingPartEntry => p !== null) : [];
  const gravity = GRAVITIES.includes(o.gravity as Gravity) ? (o.gravity as Gravity) : "bottom-left";
  const searchLevel = SEARCH_LEVELS.includes(o.searchLevel as SearchLevel) ? (o.searchLevel as SearchLevel) : "quick";
  return {
    stock: stock.length > 0 ? stock : SEED_STOCK.map((s) => ({ ...s, size: { ...s.size } })),
    workingParts,
    spacing: Math.max(0, num(o.spacing, 0)),
    edgeMargin: Math.max(0, num(o.edgeMargin, 0)),
    kerf: Math.max(0, num(o.kerf, 0)),
    gravity,
    minHoleArea: Math.max(0, num(o.minHoleArea, 0)),
    searchLevel,
    joinTolerance: o.joinTolerance === undefined || o.joinTolerance === null ? undefined : Math.max(0, Math.min(MAX_JOIN_TOLERANCE, num(o.joinTolerance, 0))),
  };
}

// --- part resolution ---

export type Point = { x: number; y: number };

export interface ResolvedPart {
  key: string;
  name: string;
  outer: Point[];
  holes: Point[][];
  sourceIds: string[];
  /** N-31: just the outer boundary's own entity ids — routes outer-profile cuts to their own DXF layer. */
  outerSourceIds: string[];
  /** Same, one array per hole, index-aligned with `holes`. */
  holeSourceIds: string[][];
  area: number;
  w: number;
  h: number;
}

export function stableKey(sourceIds: string[]): string {
  return [...sourceIds].sort().join(",");
}

/**
 * Re-derives a working-set entry's current outline from the live document —
 * geometry is never persisted, only the `sourceIds` that identify it, so an
 * edited shape is always re-read fresh. `joinTolerance` must match whatever
 * was in effect when the part was added (NF-03): a part that only closed
 * because the user raised Join tolerance would otherwise silently fail to
 * re-resolve here (and look "deleted") every time it's read back with the
 * engine's default near-exact tolerance.
 */
export function resolvePart(entities: Entity[], sourceIds: string[], joinTolerance?: number): ResolvedPart | null {
  const extracted = extractParts(entities, new Set(sourceIds), { joinTolerance });
  if (extracted.length === 0) return null;
  const part = extracted[0];
  const b = bounds(part.outer);
  return {
    key: stableKey(sourceIds),
    name: part.name,
    outer: part.outer,
    holes: part.holes,
    sourceIds: part.sourceIds,
    outerSourceIds: part.outerSourceIds,
    holeSourceIds: part.holeSourceIds,
    area: polygonArea(part.outer),
    w: b.maxX - b.minX,
    h: b.maxY - b.minY,
  };
}

const plugin: PluginModule = {
  async activate(sketchor) {
    let unit: DisplayUnitInfo = { unit: "mm", perMm: 1, label: "mm" };
    try {
      unit = await sketchor.app.displayUnit();
    } catch {
      /* mm default */
    }

    const stored = await sketchor.storage.get(STORAGE_KEY).catch(() => undefined);
    let state = asState(stored);
    // Export DXF / Print / the report all read this rather than the live
    // canvas — a manual drag needs a re-Nest to show up in an export
    // (deliberate scope: no live-canvas reconciliation this pass, unlike
    // "Check nest" which exists specifically to validate a drag in place).
    let lastNest: LastNest | null = null;
    // Set by "cancel-nest" and polled between search attempts — the panel's
    // Cancel button reaches a search already in progress this way, since
    // the "nest" handler is mid-`await` and not free to read a new message
    // any other way.
    let nestCancelRequested = false;

    const persist = async () => {
      await sketchor.storage.set(STORAGE_KEY, state).catch(() => undefined);
    };

    const pushWorkingParts = async (entitiesIn?: readonly Entity[]) => {
      const entities = entitiesIn ? [...entitiesIn] : [...(await sketchor.document.read()).entities];
      const resolved: (ResolvedPart & { settings: PartSettings })[] = [];
      const survivors: WorkingPartEntry[] = [];
      for (const entry of state.workingParts) {
        const r = resolvePart(entities, entry.sourceIds, state.joinTolerance);
        if (r) {
          resolved.push({ ...r, settings: entry.settings });
          survivors.push(entry);
        }
      }
      if (survivors.length !== state.workingParts.length) {
        state.workingParts = survivors;
        await persist();
      }
      void sketchor.ui.postMessage({
        type: "working-parts",
        parts: resolved.map((r) => ({ key: r.key, name: r.name, w: r.w, h: r.h, area: r.area, outer: r.outer, settings: r.settings })),
      });
    };

    const pushSelectionHint = async () => {
      const selection = await sketchor.selection.read();
      if (selection.length === 0) {
        void sketchor.ui.postMessage({ type: "selection-hint", count: 0, openCount: 0 });
        return;
      }
      const model = await sketchor.document.read();
      const { parts, openChains } = extractPartsWithDiagnostics([...model.entities], new Set(selection), { joinTolerance: state.joinTolerance });
      // NF-03: surface open chains even in the live hint (before the user
      // clicks Add) — "2 shapes selected, 1 doesn't close" is a much
      // earlier signal than only finding out after Add says "select closed
      // shapes first".
      void sketchor.ui.postMessage({ type: "selection-hint", count: parts.length, openCount: openChains.length });
    };

    /** NF-03: turns raw open-chain findings into one readable sentence for the panel. */
    const describeOpenChains = (openChains: OpenChainInfo[]): string => {
      const gapped = openChains.filter((c) => c.entityIds.length > 1);
      const solo = openChains.filter((c) => c.entityIds.length === 1);
      const bits: string[] = [];
      if (gapped.length > 0) {
        const worst = gapped.reduce((a, b) => (b.gap > a.gap ? b : a));
        const toDisplay = (mm: number) => mm * unit.perMm;
        bits.push(
          `${gapped.length} shape${gapped.length === 1 ? "" : "s"} almost close${gapped.length === 1 ? "s" : ""} but ${gapped.length === 1 ? "has" : "have"} a gap (largest ${toDisplay(worst.gap).toFixed(3)}${unit.label}, near ${Math.round(toDisplay(worst.start.x))},${Math.round(toDisplay(worst.start.y))})`,
        );
      }
      if (solo.length > 0) {
        bits.push(`${solo.length} shape${solo.length === 1 ? "" : "s"} ${solo.length === 1 ? "is" : "are"} open with nothing nearby to connect to`);
      }
      return bits.join("; ") + (gapped.length > 0 ? " — try raising Join tolerance in Settings, or close the gap in the drawing." : ".");
    };

    const pushInit = () => {
      void sketchor.ui.postMessage({ type: "init", state, unit });
      void pushWorkingParts();
      void pushSelectionHint();
    };

    void sketchor.app.onDisplayUnitChange((info) => {
      unit = info;
      void sketchor.ui.postMessage({ type: "unit", unit });
    });
    void sketchor.selection.onChange(() => void pushSelectionHint());

    sketchor.commands.register("nest.open", () => {
      void sketchor.ui.show(PANEL_HTML, { title: "Sheet Metal Nest", width: 380, height: 600 });
      pushInit();
    });

    sketchor.ui.onMessage(async (raw) => {
      const msg = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;

      if (msg.type === "ready") {
        pushInit();
        return;
      }

      if (msg.type === "persist") {
        // NF-01: the panel only tracks stock/spacing/settings itself — its
        // own copy of `workingParts` is whatever it last got handed (often
        // stale or empty, e.g. right after opening the panel), never
        // updated as parts are added/removed. A naive `state = asState(msg.state)`
        // here replaced the real working set with that stale copy on every
        // settings/stock edit, which looked like "adding another part
        // deletes the previous one". workingParts is only ever mutated by
        // its own dedicated handlers below (add-selection/remove-part/
        // update-part-settings), so keep the live value here regardless of
        // what the panel sent.
        const incoming = asState(msg.state);
        state = { ...incoming, workingParts: state.workingParts };
        await persist();
        return;
      }

      if (msg.type === "add-selection") {
        const [model, selection] = await Promise.all([sketchor.document.read(), sketchor.selection.read()]);
        const entities = [...model.entities];
        const { parts: extracted, openChains } = extractPartsWithDiagnostics(entities, new Set(selection), { joinTolerance: state.joinTolerance });
        if (extracted.length === 0) {
          // NF-03: say *why* — a selection with nothing but open chains
          // used to get the same flat "select closed shapes first" as an
          // empty selection, which gives no clue that the shape was almost
          // right.
          void sketchor.ui.postMessage({
            type: "error",
            message: openChains.length > 0
              ? `No closed shape found. ${describeOpenChains(openChains)}`
              : "Select one or more closed shapes first.",
          });
          return;
        }
        // NF-02: always additive — a part already in the working set (same
        // sourceIds key) is refreshed in place, everything else is appended.
        // Nothing already added is ever dropped by adding more.
        let added = 0;
        let updated = 0;
        for (const part of extracted) {
          const key = stableKey(part.sourceIds);
          const existing = state.workingParts.find((w) => w.key === key);
          if (existing) {
            existing.sourceIds = part.sourceIds;
            updated += 1;
          } else {
            state.workingParts.push({ key, sourceIds: part.sourceIds, settings: { quantity: 1, rotationMode: "quarter", mirror: false, allowInHoles: false } });
            added += 1;
          }
        }
        await persist();
        await pushWorkingParts(entities);
        const bits = [added > 0 ? `${added} added` : null, updated > 0 ? `${updated} already in the list, refreshed` : null].filter(Boolean);
        let summary = bits.join(", ") + ` — ${state.workingParts.length} part(s) in the job.`;
        // NF-03: some parts still came in fine here (extracted.length > 0,
        // or we'd have returned above) — this is the "found N, but M more
        // were this close" case, worth a heads-up without blocking the
        // parts that did work.
        if (openChains.length > 0) summary += ` Also: ${describeOpenChains(openChains)}`;
        sketchor.ui.notify(summary);
        return;
      }

      if (msg.type === "remove-part") {
        const key = str(msg.key);
        state.workingParts = state.workingParts.filter((w) => w.key !== key);
        await persist();
        await pushWorkingParts();
        return;
      }

      if (msg.type === "update-part-settings") {
        const key = str(msg.key);
        const entry = state.workingParts.find((w) => w.key === key);
        if (entry) {
          entry.settings = asPartSettings(msg.settings);
          await persist();
        }
        return;
      }

      if (msg.type === "clear") {
        const model = await sketchor.document.read();
        const commands = clearPreviousLayout(model);
        if (commands.length > 0) await sketchor.document.apply(commands);
        lastNest = null; // Export DXF/Print must not silently use a result whose canvas layout no longer exists.
        void sketchor.ui.postMessage({ type: "cleared" });
        return;
      }

      if (msg.type === "cancel-nest") {
        nestCancelRequested = true;
        return;
      }

      if (msg.type === "check-nest") {
        const model = await sketchor.document.read();
        const issues = checkNestOverlaps(model);
        void sketchor.ui.postMessage({ type: "check-result", issues });
        sketchor.ui.notify(
          issues.length > 0 ? `${issues.length} sheet(s) have overlapping parts.` : "No overlaps found.",
          { error: issues.length > 0 },
        );
        return;
      }

      if (msg.type === "nest") {
        if (state.workingParts.length === 0) {
          void sketchor.ui.postMessage({ type: "error", message: "Add one or more parts first." });
          return;
        }
        if (state.stock.length === 0) {
          void sketchor.ui.postMessage({ type: "error", message: "Add at least one stock size first." });
          return;
        }

        const model = await sketchor.document.read();
        const entities = [...model.entities];
        const entityById = new Map(entities.map((e) => [e.id, e]));

        // NF-04: resolve every entry, but name what's missing instead of a
        // blanket failure, and drop the dead entries the same way
        // pushWorkingParts() does — so a stale part doesn't keep blocking
        // Nest forever once the user has seen it.
        const withSettings: (ResolvedPart & { settings: PartSettings })[] = [];
        const missing: WorkingPartEntry[] = [];
        for (const entry of state.workingParts) {
          const r = resolvePart(entities, entry.sourceIds, state.joinTolerance);
          if (r) withSettings.push({ ...r, settings: entry.settings });
          else missing.push(entry);
        }
        if (missing.length > 0) {
          state.workingParts = state.workingParts.filter((w) => !missing.includes(w));
          await persist();
          await pushWorkingParts(entities);
        }
        if (withSettings.length === 0) {
          void sketchor.ui.postMessage({
            type: "error",
            message: missing.length > 0
              ? `${missing.length} added part(s) no longer exist on the drawing (deleted, or on another tab) and were removed from the list. Select shapes and "Add selection" again.`
              : "None of the added parts could be found — they may have been deleted.",
          });
          return;
        }

        // NF-04: a part whose bounding box can't fit on ANY stock sheet in
        // either orientation will otherwise just come back "0 placed" with
        // no explanation of why — name it up front instead.
        const oversized = withSettings.filter((p) => p.settings.quantity > 0 && p.settings.rotationMode !== "any" && !state.stock.some((s) => {
          const w = s.size.width - 2 * state.edgeMargin;
          const h = s.size.height - 2 * state.edgeMargin;
          return (p.w <= w && p.h <= h) || (p.settings.rotationMode !== "locked" && p.w <= h && p.h <= w);
        }));
        if (oversized.length > 0) {
          void sketchor.ui.postMessage({
            type: "error",
            message: `${oversized.map((p) => p.name).join(", ")} ${oversized.length === 1 ? "is" : "are"} bigger than every stock sheet (after edge margin) and can never be placed. Add a larger sheet size or check the part's rotation mode.`,
          });
          return;
        }

        const trueParts: TrueNestPart[] = withSettings
          .filter((p) => p.settings.quantity > 0)
          .map((p) => ({
            id: p.key,
            name: p.name,
            outer: p.outer,
            holes: p.holes,
            quantity: p.settings.quantity,
            rotation: { mode: p.settings.rotationMode, stepDeg: p.settings.stepDeg, mirror: p.settings.mirror },
            allowInHoles: p.settings.allowInHoles,
          }));
        if (trueParts.length === 0) {
          void sketchor.ui.postMessage({ type: "error", message: "Every part has quantity 0." });
          return;
        }

        nestCancelRequested = false;
        try {
          const { result, attempts, cancelled } = await nestTrueShapeSearch(trueParts, state.stock, {
            spacing: state.spacing + state.kerf,
            edgeMargin: state.edgeMargin,
            gravity: state.gravity,
            minHoleArea: state.minHoleArea,
            level: state.searchLevel,
            onProgress: (p) => void sketchor.ui.postMessage({ type: "nest-progress", ...p }),
            isCancelled: () => nestCancelRequested,
          });

          const geometryByKey = new Map(withSettings.map((p) => [p.key, p]));
          const placements: LastNestPlacement[] = [];
          let number = 0;
          for (let placedIdx = 0; placedIdx < result.placed.length; placedIdx++) {
            const placement = result.placed[placedIdx];
            const p = geometryByKey.get(placement.partId);
            if (!p) continue;
            const outerSource = p.outerSourceIds.map((id) => entityById.get(id)).filter((e): e is Entity => e !== undefined);
            if (outerSource.length === 0) continue;
            const holeSource = p.holeSourceIds.flat().map((id) => entityById.get(id)).filter((e): e is Entity => e !== undefined);
            const transform = placementTransform(p.outer, placement);
            // materializeInstance() preserves each source entity's own
            // .layer — stamp the real layer here, once, so every consumer
            // (canvas commands, DXF export, the PDF/print report) sees it
            // correctly without each having to re-apply the override.
            const outerEntities = materializeInstance(outerSource, transform).map((e) => ({ ...e, layer: NEST_PARTS_LAYER }));
            const holeEntities = holeSource.length > 0 ? materializeInstance(holeSource, transform).map((e) => ({ ...e, layer: NEST_HOLES_LAYER })) : [];

            const pts = outerEntities.flatMap((e) => entityPoints(e));
            const b = bounds(pts);
            const labelHeight = Math.max(1, Math.min(Math.min(b.maxX - b.minX, b.maxY - b.minY) * 0.3, 12));
            const cx = (b.minX + b.maxX) / 2;
            const cy = (b.minY + b.maxY) / 2;
            number += 1;

            const holesArea = p.holes.reduce((sum, h) => sum + polygonArea(h), 0);
            placements.push({
              sheet: placement.sheet,
              number,
              id: String(placedIdx),
              insideOfId: placement.insideOfPlacementIndex !== undefined ? String(placement.insideOfPlacementIndex) : undefined,
              outerEntities,
              holeEntities,
              label: { at: { x: cx - textWidth(String(number), labelHeight) / 2, y: cy - labelHeight / 2 }, height: labelHeight },
              partId: placement.partId,
              name: p.name,
              rotationDeg: placement.rotationDeg,
              mirrored: placement.mirrored,
              area: Math.max(0, polygonArea(p.outer) - holesArea),
            });
          }

          const toDisplay = (mm: number) => mm * unit.perMm;
          const sheetLabel = (sheet: TrueNestSheet, i: number): string => {
            const row = state.stock[sheet.stockIndex];
            const bits = [row?.material, row?.thickness !== undefined ? `${toDisplay(row.thickness).toFixed(2)}${unit.label}` : undefined].filter(Boolean);
            const dims = `${Math.round(toDisplay(sheet.width))}×${Math.round(toDisplay(sheet.height))} ${unit.label}`;
            return `Sheet ${i + 1}/${result.sheets.length} – ${dims}${bits.length ? " " + bits.join(" ") : ""}`;
          };
          const sheetLabels = result.sheets.map((s, i) => sheetLabel(s, i));

          // RN-40 (NF-07): the result opens in its own tab so the source
          // drawing stays clean; identical sheets are drawn once with "xN".
          const sheetGroups = groupIdenticalSheets(result.sheets, result.placed);
          const layoutCommands = buildSideBySideLayout(result.sheets, placements, sheetGroups, sheetLabel);
          const tabName = `Nest – ${result.placed.length} part${result.placed.length === 1 ? "" : "s"}, ${result.sheets.length} sheet${result.sheets.length === 1 ? "" : "s"}`;
          await sketchor.app.openDocumentTab(tabName, layoutCommands);

          const metricsGeoMap = new Map(withSettings.map((p) => [p.key, { outer: p.outer, holes: p.holes }]));
          const jobMetrics: JobMetrics = computeJobMetrics(result, metricsGeoMap, state.stock, DEFAULT_CUT_TABLE, { gravity: state.gravity });

          lastNest = {
            sheets: result.sheets,
            sheetLabels,
            placements,
            metrics: jobMetrics,
            result,
            ordered: withSettings.filter((p) => p.settings.quantity > 0).map((p) => ({ key: p.key, name: p.name, quantity: p.settings.quantity })),
            unit: { perMm: unit.perMm, label: unit.label },
          };

          void sketchor.ui.postMessage({ type: "result", result, metrics: jobMetrics, sheetLabels });
          const unplacedCount = result.unplaced.reduce((n, u) => n + u.count, 0);
          const searchNote = attempts > 1 ? ` (best of ${attempts} attempts${cancelled ? ", cancelled early" : ""})` : "";
          sketchor.ui.notify(
            unplacedCount > 0
              ? `Nested ${result.placed.length} on ${result.sheets.length} sheet(s) — ${unplacedCount} didn't fit${searchNote}.`
              : `Nested ${result.placed.length} part(s) on ${result.sheets.length} sheet(s), ${Math.round(result.utilisation * 100)}% used${searchNote}.`,
            { error: unplacedCount > 0 },
          );
        } catch (err) {
          // NF-04: don't just show a raw JS error — the user still has
          // parts and stock loaded, so say that plainly before whatever
          // detail the engine threw.
          const detail = err instanceof Error ? err.message : String(err);
          void sketchor.ui.postMessage({ type: "error", message: `Nesting failed: ${detail}` });
        }
        return;
      }

      if (msg.type === "export-dxf") {
        if (!lastNest) {
          void sketchor.ui.postMessage({ type: "error", message: "Nothing to export — nest some parts first." });
          return;
        }
        // sheetIndex: -1 (or absent) = all sheets (a ZIP of one DXF each; the
        // "nest" preset keeps the old single stacked file); a real index =
        // that one sheet alone, in its own local (unshifted) coordinates — a
        // file meant for one physical sheet.
        const sheetIndex = typeof msg.sheetIndex === "number" ? msg.sheetIndex : -1;
        if (sheetIndex >= lastNest.sheets.length) {
          void sketchor.ui.postMessage({ type: "error", message: "That sheet no longer exists — nest again." });
          return;
        }

        // RN-41: "cam" (CUT_OUTER / CUT_INNER, no labels, sheet-local origin)
        // is the default preset; "nest" keeps the earlier canvas-layer export.
        const preset: DxfPreset = msg.preset === "nest" ? "nest" : "cam";
        const dxfUnit = displayUnitToDxfCode(unit.unit);
        const dxfScale = factorFromMm(unit.unit);
        const sheetDxf = (i: number): string =>
          entitiesToDxf(sheetDxfEntities(lastNest!.sheets[i], i, lastNest!.sheetLabels[i], lastNest!.placements, { preset, includeSheetOutline: msg.includeSheet === true }), dxfUnit, dxfScale);

        if (sheetIndex >= 0) {
          const fileName = sheetDxfFileName(sheetIndex);
          const res = await sketchor.ui.saveFile(fileName, sheetDxf(sheetIndex), [{ description: "DXF Drawing", accept: { "application/dxf": [".dxf"] } }]);
          if (res.saved) sketchor.ui.notify(`Saved ${res.name ?? fileName}.`);
          return;
        }
        if (preset === "nest") {
          const dxf = entitiesToDxf(stackedSheetsDxfEntities(lastNest.sheets, lastNest.sheetLabels, lastNest.placements), dxfUnit, dxfScale);
          const res = await sketchor.ui.saveFile("nest-all.dxf", dxf, [{ description: "DXF Drawing", accept: { "application/dxf": [".dxf"] } }]);
          if (res.saved) sketchor.ui.notify(`Saved ${res.name ?? "nest-all.dxf"}.`);
          return;
        }
        // All sheets: one DXF per sheet, zipped (a single sheet is just the DXF).
        if (lastNest.sheets.length === 1) {
          const res = await sketchor.ui.saveFile(sheetDxfFileName(0), sheetDxf(0), [{ description: "DXF Drawing", accept: { "application/dxf": [".dxf"] } }]);
          if (res.saved) sketchor.ui.notify(`Saved ${res.name ?? sheetDxfFileName(0)}.`);
          return;
        }
        const zip = makeZip(lastNest.sheets.map((_, i) => ({ name: sheetDxfFileName(i), data: sheetDxf(i) })));
        const res = await sketchor.ui.saveFile("nest-sheets.zip", zip, [{ description: "ZIP archive", accept: { "application/zip": [".zip"] } }]);
        if (res.saved) sketchor.ui.notify(`Saved ${res.name ?? "nest-sheets.zip"} (${lastNest.sheets.length} sheets).`);
        return;
      }

      if (msg.type === "export-gcode") {
        if (!lastNest) {
          void sketchor.ui.postMessage({ type: "error", message: "Nothing to export — nest some parts first." });
          return;
        }
        // Unlike DXF, G-code is always one sheet at a time — each is its own
        // physical job run on the machine, not something to stack in one file.
        const sheetIndex = typeof msg.sheetIndex === "number" ? msg.sheetIndex : 0;
        if (sheetIndex < 0 || sheetIndex >= lastNest.sheets.length) {
          void sketchor.ui.postMessage({ type: "error", message: "That sheet no longer exists — nest again." });
          return;
        }

        const gcodePlacements: GcodePlacement[] = lastNest.placements
          .filter((p) => p.sheet === sheetIndex)
          .map((p) => ({ id: p.id, number: p.number, outerEntities: p.outerEntities, holeEntities: p.holeEntities, insideOfId: p.insideOfId }));
        const plan = buildCutPlan(gcodePlacements, { kerf: state.kerf });
        for (const warning of plan.warnings) sketchor.ui.notify(warning, { error: true });

        const stockRow = state.stock[lastNest.sheets[sheetIndex].stockIndex];
        const cutRow = cutTableRowFor(stockRow, DEFAULT_CUT_TABLE);
        if (!cutRow) {
          sketchor.ui.notify("No cut-table match for this sheet's material/thickness — using a default feed rate; check it before running the program.", { error: true });
        }
        const feedRateMmPerMin = cutRow?.feedRateMmPerMin ?? 2000;
        const pierceTimeSec = cutRow?.pierceTimeSec ?? 0.5;

        const gcodeUnit = unit.unit === "in" ? "in" : "mm";
        const gcode = writeGcode(plan.features, {
          unit: gcodeUnit,
          scale: gcodeUnit === "in" ? factorFromMm("in") : 1,
          feedRateMmPerMin,
          pierceTimeSec,
          sheetLabel: lastNest.sheetLabels[sheetIndex],
        });
        const fileName = `nest-sheet-${sheetIndex + 1}.nc`;
        const res = await sketchor.ui.saveFile(fileName, gcode, [{ description: "G-code", accept: { "text/plain": [".nc", ".gcode", ".tap"] } }]);
        if (res.saved) sketchor.ui.notify(`Saved ${res.name ?? fileName}.`);
        return;
      }

      if (msg.type === "print") {
        if (!lastNest) {
          void sketchor.ui.postMessage({ type: "error", message: "Nothing to print — nest some parts first." });
          return;
        }
        const html = buildNestReportHtml(lastNest);
        const pdf = buildNestReportPdf(lastNest);
        sketchor.ui.print(html, { fileName: "nest-report", pdf });
        return;
      }
    });
  },
};

export const PANEL_HTML = String.raw`<!doctype html>
<html>
  <head>
    <style>
      * { box-sizing: border-box; }
      body { margin: 0; padding: 12px; font: 12px system-ui, -apple-system, sans-serif; color: var(--sk-text,#dfe1e5); background: var(--sk-bg,#1e1f22); }
      h4 { margin: 14px 0 6px; font-size: 11px; text-transform: uppercase; letter-spacing: 0.04em; opacity: 0.55; }
      h4:first-child { margin-top: 0; }
      label { display: block; margin-bottom: 6px; }
      .grid2 { display: grid; grid-template-columns: 1fr 1fr; gap: 6px 8px; }
      input, select { width: 100%; margin-top: 3px; padding: 5px 6px; background: var(--sk-panel,#2b2d31); color: inherit; border: 1px solid var(--sk-border,#3a3d42); border-radius: 4px; font: inherit; }
      button { padding: 6px 10px; border: none; border-radius: 5px; background: var(--sk-accent,#4f7cff); color: #fff; font: inherit; cursor: pointer; }
      button.ghost { background: var(--sk-panel,#2b2d31); color: var(--sk-text,#dfe1e5); border: 1px solid var(--sk-border,#3a3d42); }
      button.sm { padding: 3px 7px; font-size: 11px; }
      button:disabled { opacity: 0.4; cursor: default; }
      .row { display: flex; gap: 6px; align-items: center; }
      .actions { display: flex; gap: 8px; margin: 12px 0; }
      .muted { opacity: 0.6; }
      .f { padding: 5px 7px; border-radius: 4px; background: var(--sk-panel,#2b2d31); border-left: 3px solid #6b7280; margin-top: 4px; }
      .f.error { border-left-color: var(--sk-danger,#f0616d); }
      .f.ok { border-left-color: #4f9d69; }

      .tabs { display: flex; gap: 2px; margin-bottom: 10px; border-bottom: 1px solid var(--sk-border,#3a3d42); }
      .tab-btn { flex: 1; background: none; border: none; border-radius: 0; color: var(--sk-text-dim,#9aa0a6); padding: 7px 4px; font: inherit; cursor: pointer; border-bottom: 2px solid transparent; }
      .tab-btn.active { color: var(--sk-text,#dfe1e5); border-bottom-color: var(--sk-accent,#4f7cff); }
      .tab-panel { display: none; }
      .tab-panel.active { display: block; }

      .part-row { border: 1px solid var(--sk-border,#3a3d42); border-radius: 6px; padding: 6px 8px; margin-bottom: 6px; background: var(--sk-panel,#232529); display: grid; grid-template-columns: 34px 1fr auto; gap: 8px; align-items: center; }
      .part-thumb { width: 34px; height: 34px; background: var(--sk-panel,#2b2d31); border-radius: 4px; flex: none; }
      .part-thumb svg { width: 100%; height: 100%; display: block; }
      .part-info { min-width: 0; }
      .part-name { font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .part-dim { opacity: 0.55; font-size: 11px; }
      .part-controls { display: grid; grid-template-columns: 44px 1fr auto auto auto; gap: 4px; align-items: center; }
      .part-controls input, .part-controls select { margin-top: 0; padding: 3px 4px; font-size: 11px; }
      .part-controls .icon { background: none; border: none; color: var(--sk-text-dim,#9aa0a6); cursor: pointer; padding: 2px 4px; font-size: 13px; }
      .step-row { grid-column: 1 / -1; margin-top: 3px; }

      .presets { border: 1px solid var(--sk-border,#3a3d42); border-radius: 6px; padding: 8px; background: var(--sk-panel,#232529); }
      .stock-row { display: grid; grid-template-columns: 1fr 46px 46px 1fr 40px 40px 44px 20px; gap: 4px; align-items: center; margin-bottom: 4px; }
      .stock-row input { margin-top: 0; padding: 4px; font-size: 11px; }
      .stock-head { display: grid; grid-template-columns: 1fr 46px 46px 1fr 40px 40px 44px 20px; gap: 4px; font-size: 9px; opacity: 0.5; margin-bottom: 2px; }
      .icon { background: none; border: none; color: var(--sk-text-dim,#9aa0a6); cursor: pointer; padding: 2px 3px; font-size: 12px; }

      .sheet-card { border: 1px solid var(--sk-border,#3a3d42); border-radius: 6px; padding: 8px; margin-bottom: 6px; background: var(--sk-panel,#232529); }
      .sheet-card .title { font-weight: 500; margin-bottom: 4px; }
      .sheet-card .metric { display: flex; justify-content: space-between; opacity: 0.75; font-size: 11px; }
    </style>
  </head>
  <body>
    <div class="tabs">
      <button class="tab-btn active" data-tab="parts">Parts</button>
      <button class="tab-btn" data-tab="sheets">Sheets</button>
      <button class="tab-btn" data-tab="settings">Settings</button>
      <button class="tab-btn" data-tab="results">Results</button>
    </div>

    <div class="tab-panel active" data-tab="parts">
      <div class="row" style="margin-bottom:8px">
        <button id="add-selection">+ Add selection</button>
        <span class="muted" id="selection-hint"></span>
      </div>
      <div id="parts-list"></div>
      <div class="muted" id="parts-empty">No parts added yet — select closed shapes on the canvas and click "Add selection".</div>
    </div>

    <div class="tab-panel" data-tab="sheets">
      <div class="presets">
        <div class="stock-head">
          <span>Name</span><span>W</span><span>H</span><span>Material</span><span>Thk</span><span>Qty</span><span>Cost</span><span></span>
        </div>
        <div id="stock-rows"></div>
        <button class="ghost sm" id="stock-add" style="margin-top:4px">+ New stock size</button>
      </div>
    </div>

    <div class="tab-panel" data-tab="settings">
      <div class="grid2">
        <label>Spacing (<span class="u"></span>)<input id="set-spacing" type="number" min="0" step="any" /></label>
        <label>Edge margin (<span class="u"></span>)<input id="set-margin" type="number" min="0" step="any" /></label>
        <label>Kerf (<span class="u"></span>)<input id="set-kerf" type="number" min="0" step="any" /></label>
        <label>Min hole size (<span class="u"></span>)<input id="set-minhole" type="number" min="0" step="any" title="Holes smaller than this aren't offered to in-hole parts" /></label>
        <label>Join tolerance (<span class="u"></span>)<input id="set-jointol" type="number" min="0" step="any" placeholder="exact" title="How close two ends have to be for &quot;Add selection&quot; to treat a shape as closed — raise this if real DXFs come in with small gaps. Blank = exact match only." /></label>
        <label>Gravity
          <select id="set-gravity">
            <option value="bottom-left">Bottom-left</option>
            <option value="bottom-right">Bottom-right</option>
            <option value="top-left">Top-left</option>
            <option value="top-right">Top-right</option>
          </select>
        </label>
        <label>Search
          <select id="set-search" title="Quick is one pass; Normal/Thorough spend more time trying alternate orderings for a denser packing">
            <option value="quick">Quick</option>
            <option value="normal">Normal</option>
            <option value="thorough">Thorough</option>
          </select>
        </label>
      </div>
    </div>

    <div class="tab-panel" data-tab="results">
      <div class="actions">
        <button id="nest">Nest</button>
        <button class="ghost" id="clear">Clear</button>
        <button class="ghost" id="cancel-nest" style="display:none">Cancel</button>
      </div>
      <div class="row" style="margin-bottom:8px">
        <button class="ghost sm" id="check-nest">Check nest</button>
      </div>
      <div id="summary"></div>
      <div id="sheet-cards"></div>
      <div class="row" style="margin-bottom:8px">
        <select id="dxf-sheet" style="margin-top:0"><option value="-1">All sheets</option></select>
        <button class="ghost sm" id="export-dxf">Export DXF</button>
      </div>
      <div class="row" style="margin-bottom:8px">
        <select id="gcode-sheet" style="margin-top:0"></select>
        <button class="ghost sm" id="export-gcode">Export G-code</button>
      </div>
      <div class="actions">
        <button class="ghost sm" id="print">Print report</button>
      </div>
    </div>

    <script>
      const post = (m) => parent.postMessage({ pluginMessage: m }, "*");
      const $ = (id) => document.getElementById(id);
      const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

      let unit = { unit: "mm", perMm: 1, label: "mm" };
      let state = { stock: [], workingParts: [], spacing: 0, edgeMargin: 0, kerf: 0, gravity: "bottom-left", minHoleArea: 0, searchLevel: "quick" };
      let parts = []; // working-set parts, as last pushed by the plugin: {key,name,w,h,area,outer,settings}
      let saveTimer = 0;

      const toU = (mm) => Math.round(mm * unit.perMm * 100) / 100;
      const fromU = (v) => (Number(v) || 0) / unit.perMm;

      function persist() {
        clearTimeout(saveTimer);
        saveTimer = setTimeout(() => post({ type: "persist", state }), 400);
      }

      // ---- tabs ----
      document.querySelectorAll(".tab-btn").forEach((btn) => {
        btn.addEventListener("click", () => {
          document.querySelectorAll(".tab-btn").forEach((b) => b.classList.toggle("active", b === btn));
          document.querySelectorAll(".tab-panel").forEach((p) => p.classList.toggle("active", p.dataset.tab === btn.dataset.tab));
        });
      });

      // ---- parts tab ----
      function thumbSvg(outer) {
        if (!outer || outer.length < 3) return "";
        const xs = outer.map((p) => p.x), ys = outer.map((p) => p.y);
        const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys);
        const w = Math.max(maxX - minX, 1e-6), h = Math.max(maxY - minY, 1e-6);
        const pts = outer.map((p) => (p.x - minX) + "," + (h - (p.y - minY))).join(" ");
        return "<svg viewBox='-2 -2 " + (w + 4) + " " + (h + 4) + "' preserveAspectRatio='xMidYMid meet'>" +
          "<polygon points='" + pts + "' fill='none' stroke='#8ab4f8' stroke-width='" + Math.max(w, h) / 20 + "'/></svg>";
      }

      function renderParts() {
        $("parts-empty").style.display = parts.length ? "none" : "block";
        $("parts-list").innerHTML = parts
          .map((p) => {
            const s = p.settings;
            return "<div class='part-row' data-key='" + esc(p.key) + "'>" +
              "<div class='part-thumb'>" + thumbSvg(p.outer) + "</div>" +
              "<div class='part-info'><div class='part-name'>" + esc(p.name) + "</div>" +
              "<div class='part-dim'>" + Math.round(toU(p.w)) + "×" + Math.round(toU(p.h)) + " " + esc(unit.label) + "</div></div>" +
              "<div class='part-controls'>" +
              "<input class='qty' type='number' min='0' step='1' value='" + s.quantity + "' title='Quantity'>" +
              "<select class='rot'>" +
              "<option value='locked'" + (s.rotationMode === "locked" ? " selected" : "") + ">Locked</option>" +
              "<option value='quarter'" + (s.rotationMode === "quarter" ? " selected" : "") + ">90°</option>" +
              "<option value='any'" + (s.rotationMode === "any" ? " selected" : "") + ">Any</option>" +
              "</select>" +
              "<label style='display:flex;align-items:center;gap:2px;margin:0' title='Mirror'><input class='mirror' type='checkbox'" + (s.mirror ? " checked" : "") + "> M</label>" +
              "<label style='display:flex;align-items:center;gap:2px;margin:0' title='Try inside another placed part&#39;s hole first'><input class='in-holes' type='checkbox'" + (s.allowInHoles ? " checked" : "") + "> H</label>" +
              "<button class='icon remove' title='Remove'>&#10005;</button>" +
              (s.rotationMode === "any"
                ? "<div class='step-row'><input class='step' type='number' min='1' step='1' value='" + (s.stepDeg || 15) + "' title='Step degrees'> °</div>"
                : "") +
              "</div></div>";
          })
          .join("");
        $("parts-list").querySelectorAll(".part-row").forEach((row) => {
          const key = row.dataset.key;
          const entry = parts.find((p) => p.key === key);
          const sendSettings = () => post({ type: "update-part-settings", key, settings: entry.settings });
          row.querySelector(".qty").addEventListener("input", (e) => { entry.settings.quantity = Math.max(0, Math.floor(Number(e.target.value) || 0)); sendSettings(); });
          row.querySelector(".rot").addEventListener("change", (e) => { entry.settings.rotationMode = e.target.value; sendSettings(); renderParts(); });
          row.querySelector(".mirror").addEventListener("change", (e) => { entry.settings.mirror = e.target.checked; sendSettings(); });
          row.querySelector(".in-holes").addEventListener("change", (e) => { entry.settings.allowInHoles = e.target.checked; sendSettings(); });
          const stepInput = row.querySelector(".step");
          if (stepInput) stepInput.addEventListener("input", (e) => { entry.settings.stepDeg = Math.max(1, Number(e.target.value) || 15); sendSettings(); });
          row.querySelector(".remove").addEventListener("click", () => post({ type: "remove-part", key }));
        });
      }
      $("add-selection").addEventListener("click", () => post({ type: "add-selection" }));

      // ---- sheets tab ----
      function stockRowHtml(row, i) {
        return "<div class='stock-row' data-i='" + i + "'>" +
          "<input class='st-name' value='" + esc(row.size.name) + "'>" +
          "<input class='st-w' type='number' min='0' step='any' value='" + toU(row.size.width) + "'>" +
          "<input class='st-h' type='number' min='0' step='any' value='" + toU(row.size.height) + "'>" +
          "<input class='st-mat' value='" + esc(row.material || "") + "' placeholder='—'>" +
          "<input class='st-thk' type='number' min='0' step='any' value='" + (row.thickness !== undefined ? toU(row.thickness) : "") + "' placeholder='—'>" +
          "<input class='st-qty' type='number' min='0' step='1' value='" + (row.qty === null ? "" : row.qty) + "' placeholder='∞'>" +
          "<input class='st-cost' type='number' min='0' step='any' value='" + (row.cost !== undefined ? row.cost : "") + "' placeholder='—'>" +
          "<button class='icon st-del' title='Delete'>&#10005;</button>" +
          "</div>";
      }
      function renderStock() {
        $("stock-rows").innerHTML = state.stock.map(stockRowHtml).join("");
        $("stock-rows").querySelectorAll(".stock-row").forEach((row) => {
          const i = Number(row.dataset.i);
          const r = state.stock[i];
          const upd = () => persist();
          row.querySelector(".st-name").addEventListener("input", (e) => { r.size.name = e.target.value; upd(); });
          row.querySelector(".st-w").addEventListener("input", (e) => { r.size.width = fromU(e.target.value); upd(); });
          row.querySelector(".st-h").addEventListener("input", (e) => { r.size.height = fromU(e.target.value); upd(); });
          row.querySelector(".st-mat").addEventListener("input", (e) => { r.material = e.target.value || undefined; upd(); });
          row.querySelector(".st-thk").addEventListener("input", (e) => { r.thickness = e.target.value === "" ? undefined : fromU(e.target.value); upd(); });
          row.querySelector(".st-qty").addEventListener("input", (e) => { r.qty = e.target.value === "" ? null : Math.max(0, Math.floor(Number(e.target.value) || 0)); upd(); });
          row.querySelector(".st-cost").addEventListener("input", (e) => { r.cost = e.target.value === "" ? undefined : Number(e.target.value); upd(); });
          row.querySelector(".st-del").addEventListener("click", () => { state.stock.splice(i, 1); renderStock(); persist(); });
        });
      }
      $("stock-add").addEventListener("click", () => {
        state.stock.push({ size: { name: "New sheet", width: fromU(1000), height: fromU(1000) }, qty: null });
        renderStock();
        persist();
      });

      // ---- settings tab ----
      function renderSettings() {
        document.querySelectorAll(".u").forEach((el) => (el.textContent = unit.label));
        $("set-spacing").value = toU(state.spacing);
        $("set-margin").value = toU(state.edgeMargin);
        $("set-kerf").value = toU(state.kerf);
        // Stored as an area (mm²) but shown/edited as a side length — much
        // easier to reason about ("holes under 10mm across") than mm².
        $("set-minhole").value = toU(Math.sqrt(state.minHoleArea || 0));
        // Blank means "exact match only" (the engine's own near-zero
        // default) rather than a literal 0 — an explicit 0 would reject
        // even floating-point-identical endpoints (dist < 0 is never true).
        $("set-jointol").value = state.joinTolerance == null ? "" : toU(state.joinTolerance);
        $("set-gravity").value = state.gravity;
        $("set-search").value = state.searchLevel;
      }
      $("set-spacing").addEventListener("input", () => { state.spacing = fromU($("set-spacing").value); persist(); });
      $("set-margin").addEventListener("input", () => { state.edgeMargin = fromU($("set-margin").value); persist(); });
      $("set-kerf").addEventListener("input", () => { state.kerf = fromU($("set-kerf").value); persist(); });
      $("set-minhole").addEventListener("input", () => { const side = fromU($("set-minhole").value); state.minHoleArea = Math.max(0, side * side); persist(); });
      $("set-jointol").addEventListener("input", () => {
        const raw = $("set-jointol").value;
        state.joinTolerance = raw === "" ? undefined : Math.max(0, fromU(raw));
        persist();
      });
      $("set-gravity").addEventListener("change", () => { state.gravity = $("set-gravity").value; persist(); });
      $("set-search").addEventListener("change", () => { state.searchLevel = $("set-search").value; persist(); });

      // ---- results tab ----
      function endNesting() {
        $("nest").disabled = false;
        $("cancel-nest").style.display = "none";
        $("cancel-nest").disabled = false;
        $("cancel-nest").textContent = "Cancel";
      }
      $("nest").addEventListener("click", () => {
        $("summary").innerHTML = "<div class='muted'>Nesting…</div>";
        $("sheet-cards").innerHTML = "";
        $("nest").disabled = true;
        $("cancel-nest").style.display = "";
        post({ type: "nest" });
      });
      $("cancel-nest").addEventListener("click", () => {
        $("cancel-nest").disabled = true;
        $("cancel-nest").textContent = "Cancelling…";
        post({ type: "cancel-nest" });
      });
      $("clear").addEventListener("click", () => {
        post({ type: "clear" });
        $("summary").innerHTML = "";
        $("sheet-cards").innerHTML = "";
        $("dxf-sheet").innerHTML = "<option value='-1'>All sheets</option>";
        $("gcode-sheet").innerHTML = "";
      });
      $("check-nest").addEventListener("click", () => post({ type: "check-nest" }));
      $("export-dxf").addEventListener("click", () => post({ type: "export-dxf", sheetIndex: Number($("dxf-sheet").value) }));
      $("export-gcode").addEventListener("click", () => post({ type: "export-gcode", sheetIndex: Number($("gcode-sheet").value) }));
      $("print").addEventListener("click", () => post({ type: "print" }));

      function renderResult(r, metrics, sheetLabels) {
        const unplaced = (r.unplaced || []).reduce((n, u) => n + u.count, 0);
        $("summary").innerHTML =
          "<div class='f " + (unplaced ? "error" : "ok") + "'>" + r.placed.length + " placed on " + r.sheets.length +
          " sheet(s), " + Math.round(r.utilisation * 100) + "% used" + (unplaced ? " · " + unplaced + " didn't fit" : "") + ".</div>";
        $("dxf-sheet").innerHTML =
          "<option value='-1'>All sheets</option>" +
          (sheetLabels || []).map((l, i) => "<option value='" + i + "'>" + esc(l) + "</option>").join("");
        $("gcode-sheet").innerHTML = (sheetLabels || []).map((l, i) => "<option value='" + i + "'>" + esc(l) + "</option>").join("");
        const cards = (metrics ? metrics.sheets : []).map((m, i) => {
          const label = (sheetLabels && sheetLabels[i]) || "Sheet " + (i + 1);
          const time = m.cuttingTimeSec != null ? Math.round(m.cuttingTimeSec / 6) / 10 + " min (est.)" : "—";
          const remnant = m.remnant ? Math.round(toU(m.remnant.width)) + "×" + Math.round(toU(m.remnant.height)) + " " + esc(unit.label) : "none";
          return "<div class='sheet-card'>" +
            "<div class='title'>" + esc(label) + "</div>" +
            "<div class='metric'><span>Utilisation</span><span>" + Math.round(m.utilisation * 100) + "%</span></div>" +
            "<div class='metric'><span>Reusable remnant</span><span>" + remnant + "</span></div>" +
            "<div class='metric'><span>Cutting time</span><span>" + time + "</span></div>" +
            (m.weightKg != null ? "<div class='metric'><span>Weight</span><span>" + m.weightKg.toFixed(2) + " kg</span></div>" : "") +
            (m.costEstimate != null ? "<div class='metric'><span>Sheet cost</span><span>" + m.costEstimate.toFixed(2) + "</span></div>" : "") +
            "</div>";
        }).join("");
        $("sheet-cards").innerHTML = cards;
      }

      window.addEventListener("message", (e) => {
        const m = e.data && e.data.pluginMessage;
        if (!m) return;
        if (m.type === "init") { state = m.state; unit = m.unit || unit; renderStock(); renderSettings(); return; }
        if (m.type === "unit") { unit = m.unit; renderStock(); renderSettings(); renderParts(); return; }
        if (m.type === "selection-hint") {
          // NF-03: an open shape in the current selection is worth flagging
          // before the user even clicks Add, not just after.
          const bits = [];
          if (m.count > 0) bits.push(m.count + " shape(s) selected");
          if (m.openCount > 0) bits.push(m.openCount + " open");
          $("selection-hint").textContent = bits.join(", ");
          return;
        }
        if (m.type === "working-parts") {
          parts = (m.parts || []).map((p) => ({ ...p, settings: p.settings }));
          renderParts();
          return;
        }
        if (m.type === "cleared") { $("summary").innerHTML = "<div class='f'>Cleared.</div>"; $("sheet-cards").innerHTML = ""; return; }
        if (m.type === "error") { endNesting(); $("summary").innerHTML = "<div class='f error'>" + esc(m.message) + "</div>"; return; }
        if (m.type === "nest-progress") {
          $("summary").innerHTML =
            "<div class='muted'>Attempt " + m.attempt + " — best so far: " + m.bestPlaced + " placed" +
            (m.bestUnplaced ? ", " + m.bestUnplaced + " unplaced" : "") +
            ", " + Math.round(m.bestUtilisation * 100) + "% used (" + (m.elapsedMs / 1000).toFixed(1) + "s)</div>";
          return;
        }
        if (m.type === "result") { endNesting(); renderResult(m.result, m.metrics, m.sheetLabels); return; }
        if (m.type === "check-result") {
          const issues = m.issues || [];
          $("summary").innerHTML = issues.length
            ? "<div class='f error'>Overlaps on: " + issues.map((i) => esc(i.groupName)).join(", ") + "</div>"
            : "<div class='f ok'>No overlaps found.</div>";
          return;
        }
      });

      post({ type: "ready" });
    </script>
  </body>
</html>`;

export default plugin;
