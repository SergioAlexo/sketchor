import {
  buildNestLayout,
  clearPreviousLayout,
  DEFAULT_ANNOTATION_COLOR,
  forPaper,
  LOAD_PLAN_GUIDE_LAYER,
  LOAD_PLAN_LAYER,
  nestByOrders,
  readLivePlacements,
  setDimensionsOnLayout,
  validateNest,
  type NestResult,
  type Order,
  type Pallet,
  type PalletOrientation,
  type PalletShape,
  type TrailerProfile,
  type ValidationFinding,
} from "@sketchor/plugin-truck-nesting";
import {
  drawEntitiesToPdf,
  entitiesToSvgDocument,
  PDF_LETTER_LANDSCAPE,
  PdfBuilder,
  type DisplayUnitInfo,
  type Entity,
  type PluginModule,
} from "@sketchor/plugin-sdk";

/**
 * Order colours, deliberately *not* the app's shared entity palette.
 *
 * A load plan is read on a printed sheet on a loading dock, often
 * photocopied, and the only thing distinguishing one drop from the next is
 * its colour. The shared palette runs through neighbouring hues
 * (red-orange-yellow, teal-blue-indigo) at one lightness, which muddles
 * exactly there. This is the Okabe–Ito set — designed to stay distinct for
 * colour-blind readers and in grayscale — ordered so consecutive orders
 * alternate warm and cool, with three further distinct hues after it.
 */
const ORDER_COLORS: readonly string[] = [
  "#e69f00", // orange
  "#56b4e9", // sky blue
  "#009e73", // green
  "#f0e442", // yellow
  "#0072b2", // blue
  "#d55e00", // vermillion
  "#cc79a7", // pink
  "#8c564b", // brown
  "#6a3d9a", // purple
  "#999999", // grey
];

/**
 * First-party dogfood: the Truck Load Planner. All the nesting maths lives in
 * `@sketchor/plugin-truck-nesting` (SDK-only); this module is the sandbox glue —
 * it shows the panel, keeps the user's trailer/pallet presets and orders in
 * plugin `storage`, feeds the panel the app's display unit, and on each request
 * reads the document, solves, and applies the coloured layout through
 * `document.apply` as one undo step. It never touches `window.sketchor`.
 */

interface PalletPreset {
  name: string;
  width: number;
  length: number;
  shape: PalletShape;
}

interface PersistedState {
  presets: TrailerProfile[];
  palletPresets: PalletPreset[];
  lastPresetName: string;
  /** Which trailer/pallet preset a fresh session or a new order/pallet starts from. */
  defaultTrailerName: string;
  defaultPalletName: string;
  wallMargin: number;
  palletMargin: number;
  /** Whether the wall / pallet clearance is applied — the value is kept when off so it can be toggled back. */
  wallOn: boolean;
  palletOn: boolean;
  /** Add a W×L dimension to every drawn pallet. */
  dimensions: boolean;
  /**
   * Ink for the plan's dimensions and NOSE / DOOR labels. Defaults to a light
   * grey that reads on the dark workspace; printing inverts it (`forPaper`).
   */
  textColor: string;
  orders: Order[];
  /** Free-text label for the printed load plan — defaults to the trailer name when blank. */
  loadName: string;
  /** Free-text truck/driver info shown on the printed load plan. */
  truckInfo: string;
  /** ISO date (yyyy-mm-dd) shown on the printed load plan — defaults to today. */
  loadDate: string;
}

const STORAGE_KEY = "state";

// Standard sizes are entered in inches (630"×90" trailer, 48"×42" pallet) but
// stored in mm like everything else in the document — 1 in = 25.4 mm.
const IN = 25.4;

const SEED_PRESETS: TrailerProfile[] = [
  { name: "Standard trailer (630×90 in)", length: 630 * IN, width: 90 * IN },
  { name: "13.6 m curtainsider", length: 13620, width: 2480 },
  { name: "7.2 m rigid", length: 7200, width: 2450 },
  { name: "6.1 m box van", length: 6100, width: 2400 },
];

const STANDARD_PALLET_NAME = "Standard pallet (48×42 in)";

const SEED_PALLET_PRESETS: PalletPreset[] = [
  { name: STANDARD_PALLET_NAME, width: 48 * IN, length: 42 * IN, shape: "rect" },
  { name: "EUR pallet", width: 1200, length: 800, shape: "rect" },
  { name: "EUR-6 half", width: 800, length: 600, shape: "rect" },
  { name: "Industrial", width: 1200, length: 1000, shape: "rect" },
  { name: "Drum Ø600", width: 600, length: 600, shape: "round" },
];

function seedOrder(pallet: PalletPreset): Order {
  return {
    id: `o-${Date.now().toString(36)}`,
    jobNumber: "",
    city: "",
    state: "",
    color: ORDER_COLORS[0],
    pallets: [{ id: `p-${Date.now().toString(36)}`, name: pallet.name, width: pallet.width, length: pallet.length, shape: pallet.shape, qty: 1 }],
  };
}

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

// --- untrusted panel input ---

function num(v: unknown, fallback = 0): number {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : fallback;
}
function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}
function asShape(v: unknown): PalletShape {
  return v === "round" ? "round" : "rect";
}
function asOrientation(v: unknown): PalletOrientation {
  return v === "fixed" || v === "turned" ? v : "auto";
}

function asPallet(v: unknown): Pallet | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  return {
    id: typeof o.id === "string" ? o.id : `p-${Math.random().toString(36).slice(2)}`,
    name: str(o.name) || undefined,
    width: Math.max(0, num(o.width)),
    length: Math.max(0, num(o.length)),
    shape: asShape(o.shape),
    qty: Math.max(1, Math.floor(num(o.qty, 1))),
    tag: str(o.tag) || undefined,
    orientation: asOrientation(o.orientation),
  };
}

function asPalletPreset(v: unknown): PalletPreset | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  const name = str(o.name);
  if (!name) return null;
  return { name, width: Math.max(0, num(o.width)), length: Math.max(0, num(o.length)), shape: asShape(o.shape) };
}

function asOrder(v: unknown): Order | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  const pallets = Array.isArray(o.pallets) ? o.pallets.map(asPallet).filter((p): p is Pallet => p !== null) : [];
  return {
    id: typeof o.id === "string" ? o.id : `o-${Math.random().toString(36).slice(2)}`,
    jobNumber: str(o.jobNumber),
    city: str(o.city),
    state: str(o.state),
    color: str(o.color) || ORDER_COLORS[0],
    pallets,
  };
}

function asTrailer(v: unknown): TrailerProfile | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  const length = Math.max(1, num(o.length, 1));
  const width = Math.max(1, num(o.width, 1));
  const wallMargin = Math.max(0, num(o.wallMargin));
  return { name: str(o.name) || "Trailer", length, width, ...(wallMargin > 0 ? { wallMargin } : {}) };
}

function asState(v: unknown): PersistedState {
  const o = (v && typeof v === "object" ? v : {}) as Record<string, unknown>;
  const presets = Array.isArray(o.presets) ? o.presets.map(asTrailer).filter((t): t is TrailerProfile => t !== null) : [];
  const palletPresets = Array.isArray(o.palletPresets)
    ? o.palletPresets.map(asPalletPreset).filter((p): p is PalletPreset => p !== null)
    : [];
  const wallMargin = Math.max(0, num(o.wallMargin));
  const palletMargin = Math.max(0, num(o.palletMargin));
  const finalPresets = presets.length > 0 ? presets : [...SEED_PRESETS];
  const finalPalletPresets = palletPresets.length > 0 ? palletPresets : [...SEED_PALLET_PRESETS];
  const defaultTrailerName = str(o.defaultTrailerName);
  const defaultPalletName = str(o.defaultPalletName);
  const resolvedDefaultTrailer =
    (defaultTrailerName && finalPresets.find((p) => p.name === defaultTrailerName)?.name) || finalPresets[0].name;
  const resolvedDefaultPallet =
    (defaultPalletName && finalPalletPresets.find((p) => p.name === defaultPalletName)) || finalPalletPresets[0];
  const orders = Array.isArray(o.orders) ? o.orders.map(asOrder).filter((x): x is Order => x !== null) : [];
  return {
    presets: finalPresets,
    palletPresets: finalPalletPresets,
    lastPresetName: str(o.lastPresetName) || resolvedDefaultTrailer,
    defaultTrailerName: resolvedDefaultTrailer,
    defaultPalletName: resolvedDefaultPallet.name,
    wallMargin,
    palletMargin,
    // Older stored state has no flag — treat a non-zero margin as "on".
    wallOn: typeof o.wallOn === "boolean" ? o.wallOn : wallMargin > 0,
    palletOn: typeof o.palletOn === "boolean" ? o.palletOn : palletMargin > 0,
    dimensions: o.dimensions === true,
    textColor: /^#[0-9a-fA-F]{6}$/.test(str(o.textColor)) ? str(o.textColor) : DEFAULT_ANNOTATION_COLOR,
    orders: orders.length > 0 ? orders : [seedOrder(resolvedDefaultPallet)],
    loadName: str(o.loadName),
    truckInfo: str(o.truckInfo),
    loadDate: str(o.loadDate) || todayIso(),
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

    // The last successful solve, kept so "Print load plan" and the dimension
    // toggle don't need to re-run the solver (which would discard any pallet
    // the user has since dragged by hand).
    let lastResult: NestResult | null = null;
    let lastFindings: ValidationFinding[] = [];

    const pushInit = () => void sketchor.ui.postMessage({ type: "init", state, unit, palette: ORDER_COLORS });

    void sketchor.app.onDisplayUnitChange((info) => {
      unit = info;
      void sketchor.ui.postMessage({ type: "unit", unit });
    });

    sketchor.commands.register("truck-nesting.open", () => {
      void sketchor.ui.show(PANEL_HTML, { title: "Load Plan", width: 400, height: 640 });
      pushInit();
    });

    sketchor.ui.onMessage(async (raw) => {
      const msg = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;

      if (msg.type === "ready") {
        pushInit();
        void sketchor.ui
          .printFolder()
          .then((folder) => sketchor.ui.postMessage({ type: "folder", folder }))
          .catch(() => undefined);
        return;
      }
      if (msg.type === "persist") {
        state = asState(msg.state);
        await sketchor.storage.set(STORAGE_KEY, state).catch(() => undefined);
        return;
      }
      if (msg.type === "clear") {
        const model = await sketchor.document.read();
        const commands = clearPreviousLayout(model);
        if (commands.length > 0) await sketchor.document.apply(commands);
        void sketchor.ui.postMessage({ type: "cleared" });
        return;
      }
      if (msg.type === "nest") {
        const trailer = asTrailer(msg.trailer);
        const orders = Array.isArray(msg.orders)
          ? msg.orders.map(asOrder).filter((o): o is Order => o !== null)
          : [];
        const palletMargin = Math.max(0, num(msg.palletMargin));
        const dimensions = msg.dimensions === true;
        const annotationColor = /^#[0-9a-fA-F]{6}$/.test(str(msg.textColor))
          ? str(msg.textColor)
          : DEFAULT_ANNOTATION_COLOR;
        if (!trailer || orders.length === 0) {
          void sketchor.ui.postMessage({ type: "error", message: "Add a trailer size and at least one order." });
          return;
        }
        try {
          const result: NestResult = nestByOrders(trailer, orders, { palletMargin });
          const findings: ValidationFinding[] = validateNest(result);
          const model = await sketchor.document.read();
          await sketchor.document.apply([
            ...clearPreviousLayout(model),
            ...buildNestLayout(result, {
              dimensions,
              annotationColor,
              perMm: unit.perMm,
              unitLabel: unit.label,
              findings,
            }),
          ]);
          lastResult = result;
          lastFindings = findings;
          void sketchor.ui.postMessage({ type: "result", result, findings });
          const errors = findings.filter((f) => f.level === "error").length;
          sketchor.ui.notify(
            errors > 0
              ? `Load plan drawn — ${errors} problem${errors === 1 ? "" : "s"}, see the panel.`
              : `Load plan on "${LOAD_PLAN_LAYER}" — hide "${LOAD_PLAN_GUIDE_LAYER}" to drop the guides.`,
            { error: errors > 0 },
          );
        } catch (err) {
          void sketchor.ui.postMessage({ type: "error", message: err instanceof Error ? err.message : String(err) });
        }
        return;
      }
      if (msg.type === "toggle-dimensions") {
        // An overlay-only change — never re-runs the solver, so pallets the
        // user has manually dragged since the last Auto-nest stay put.
        const dimensions = msg.dimensions === true;
        const model = await sketchor.document.read();
        const commands = setDimensionsOnLayout(model, dimensions, {
          perMm: unit.perMm,
          unitLabel: unit.label,
          annotationColor: state.textColor,
        });
        if (commands.length > 0) await sketchor.document.apply(commands);
        return;
      }
      if (msg.type === "print") {
        if (!lastResult) {
          void sketchor.ui.postMessage({ type: "error", message: "Auto-nest a plan before printing it." });
          return;
        }
        // Read the live canvas so a pallet the user dragged by hand after
        // Auto-nest shows up in its actual spot on the print, not the stale
        // solved position.
        const model = await sketchor.document.read();
        const liveResult: NestResult = { ...lastResult, placed: readLivePlacements(model, lastResult) };
        // The drawing itself — the very entities `entitiesToDxf` writes — is
        // what gets rendered onto the sheet and into the PDF. Nothing about
        // the plan is drawn twice, so the paper and the DXF cannot disagree.
        // `forPaper` only re-inks it: the dark-workspace lettering goes black
        // and the white clearance guides drop out, everything else is the
        // drawing untouched.
        const planEntities = forPaper(model.entities.filter((e) => e.layer === LOAD_PLAN_LAYER)) as Entity[];
        const loadName = str(msg.loadName).trim() || liveResult.trailer.name;
        const truckInfo = str(msg.truckInfo).trim();
        const loadDate = str(msg.loadDate).trim();
        const sheet = { loadName, truckInfo, loadDate, perMm: unit.perMm, unitLabel: unit.label };
        const html = buildPrintHtml(planEntities, liveResult, lastFindings, sheet);
        const pdf = buildPrintPdf(planEntities, liveResult, lastFindings, sheet);
        // Name the autosaved copy after when it was actually generated plus
        // everything a dispatcher scans a folder for — the load, the states
        // it crosses and the jobs on it — so a folder of them sorts by time
        // and reads like the paperwork it replaces without opening a file.
        sketchor.ui.print(html, { fileName: autosaveFileName(loadName, liveResult), pdf });
        return;
      }
      if (msg.type === "pick-folder") {
        // Runs inside the panel's click, which is what lets the host open the
        // OS folder picker at all.
        const info = await sketchor.ui.pickPrintFolder().catch(() => null);
        if (info) void sketchor.ui.postMessage({ type: "folder", folder: info });
        return;
      }
    });
  },
};

function escapeHtml(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c] as string);
}

function fmtMm(mm: number, perMm: number, unitLabel: string): string {
  return `${Math.round(mm * perMm * 10) / 10} ${unitLabel}`;
}

/** Renders an ISO yyyy-mm-dd as a locale date without a UTC/local timezone shift. */
function fmtIsoDate(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso.trim());
  if (!m) return "";
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric", timeZone: "UTC" });
}

function jobDestination(p: { jobNumber?: string; city: string; state?: string }): string {
  const cityState = [p.city?.trim(), p.state?.trim()].filter(Boolean).join(", ");
  return [p.jobNumber?.trim(), cityState].filter(Boolean).join(" — ") || "—";
}

/**
 * The autosaved filename: when the plan was generated, the load, every
 * state/province the placed pallets cross and every job number on the
 * load — so a folder of these sorts by time and is searchable by any of
 * them without opening a file. Windows-safe (no `: / \ * ? " < > |`).
 */
export function autosaveFileName(loadName: string, result: NestResult): string {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  const generatedStamp = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}${pad(now.getMinutes())}`;
  const dedupeInOrder = (values: (string | undefined)[]) => [...new Set(values.map((v) => v?.trim()).filter((v): v is string => !!v))];
  const states = dedupeInOrder(result.placed.map((p) => p.state?.toUpperCase())).join("-");
  const jobs = dedupeInOrder(result.placed.map((p) => p.jobNumber)).join("-");
  return [generatedStamp, loadName, states, jobs].filter(Boolean).join(" — ");
}

export interface LoadSheetInfo {
  loadName: string;
  truckInfo: string;
  loadDate: string;
  perMm: number;
  unitLabel: string;
}

function groupByOrder(result: NestResult): Map<number, { dest: string; color: string; n: number }> {
  const bySeq = new Map<number, { dest: string; color: string; n: number }>();
  for (const p of result.placed) {
    const e = bySeq.get(p.orderIndex) ?? { dest: jobDestination(p), color: p.color, n: 0 };
    e.n += 1;
    bySeq.set(p.orderIndex, e);
  }
  return bySeq;
}

/**
 * The shared spine of both renderings of a load plan: the pallets in load
 * order, the per-drop legend, and whatever went wrong.
 *
 * The plan *picture* is never rebuilt here — it comes from the drawing on the
 * "Load Plan" layer, the same entity list the DXF export writes. So the sheet
 * that goes to the printer, the PDF filed in the folder and the file the shop
 * opens in CAD are three renderings of one drawing, not three drawings.
 */
function sheetContent(result: NestResult, findings: ValidationFinding[], info: LoadSheetInfo) {
  const { trailer } = result;
  const legend = [...groupByOrder(result)].sort((a, b) => a[0] - b[0]);
  const rows = result.placed.map((p, i) => ({
    n: i + 1,
    color: p.color,
    job: p.jobNumber || "—",
    where: [p.city, p.state].filter(Boolean).join(", ") || "—",
    size:
      p.shape === "round"
        ? `Ø ${fmtMm(p.width, info.perMm, info.unitLabel)}`
        : `${fmtMm(p.width, info.perMm, info.unitLabel)} × ${fmtMm(p.length, info.perMm, info.unitLabel)}`,
    tag: p.tag || "",
  }));
  const subtitle =
    `${trailer.name} · ${fmtMm(trailer.length, info.perMm, info.unitLabel)} × ${fmtMm(trailer.width, info.perMm, info.unitLabel)}` +
    ` · ${result.placed.length} pallets, ${fmtMm(result.usedLength, info.perMm, info.unitLabel)} used` +
    (info.truckInfo ? ` · ${info.truckInfo}` : "") +
    (fmtIsoDate(info.loadDate) ? ` · ${fmtIsoDate(info.loadDate)}` : "");
  const unplaced = result.unplaced.map((u) => `${u.city || "—"}: ${u.count} — ${u.reason}`);
  const problems = findings.filter((f) => f.level !== "info");
  return { legend, rows, subtitle, unplaced, problems };
}

/** Padding and line weight scaled to the drawing, so a 13 m trailer and a 6 m van print alike. */
function planScale(result: NestResult): { padding: number; strokeWidth: number } {
  const span = Math.max(result.trailer.length, result.trailer.width, 1);
  return { padding: span * 0.02, strokeWidth: span * 0.0012 };
}

/**
 * A printable load-plan report: the drawn plan, a legend mapping each drop's
 * colour to its destination, and the full pallet list.
 *
 * `entities` is the "Load Plan" layer straight out of the document — dragged
 * pallets, hand edits and all — rendered by the same exporter behind the
 * app's SVG files.
 */
export function buildPrintHtml(
  entities: readonly Entity[],
  result: NestResult,
  findings: ValidationFinding[],
  info: LoadSheetInfo,
): string {
  const { legend, rows, subtitle, unplaced, problems } = sheetContent(result, findings, info);
  const { padding, strokeWidth } = planScale(result);
  const svg = entitiesToSvgDocument([...entities], {
    padding,
    strokeWidth,
    strokeColor: "#111111",
    unit: "none", // inline in the sheet page, sized by its CSS
    // Solid: the labels the plan drew on each pallet are black or white by how
    // dark that pallet's colour is, which a washed-out fill would undo.
    fillOpacity: 1,
  }).replace(/^<\?xml[^>]*\?>\s*/, "");

  const legendHtml = legend
    .map(
      ([idx, e]) =>
        `<div class="legend-row"><span class="swatch" style="background:${escapeHtml(e.color)}"></span>#${idx + 1} ${escapeHtml(e.dest)} &middot; ${e.n} pallet${e.n === 1 ? "" : "s"}</div>`,
    )
    .join("");
  const rowsHtml = rows
    .map(
      (r) =>
        `<tr><td>${r.n}</td><td><span class="swatch" style="background:${escapeHtml(r.color)}"></span>${escapeHtml(r.job)}</td><td>${escapeHtml(r.where)}</td><td>${escapeHtml(r.size)}</td><td>${escapeHtml(r.tag)}</td></tr>`,
    )
    .join("");
  const unplacedHtml =
    unplaced.length > 0
      ? `<h2>Unplaced</h2><ul class="unplaced">${unplaced.map((u) => `<li>${escapeHtml(u)}</li>`).join("")}</ul>`
      : "";
  const findingsHtml =
    problems.length > 0
      ? `<ul class="findings">${problems.map((f) => `<li class="${f.level}">${escapeHtml(f.message)}</li>`).join("")}</ul>`
      : "";

  return `<style>
    .load-plan, .load-plan * { -webkit-print-color-adjust: exact; print-color-adjust: exact; color-adjust: exact; }
    .load-plan h1 { font-size: 16px; margin: 0 0 2px; }
    .load-plan .sub { color: #444; font: 12px system-ui, sans-serif; margin-bottom: 10px; }
    .load-plan svg { width: 100%; height: auto; max-height: 150mm; margin: 8px 0; break-inside: avoid; }
    .load-plan h2 { font-size: 12px; text-transform: uppercase; letter-spacing: .04em; margin: 14px 0 6px; break-after: avoid; }
    .load-plan thead { display: table-header-group; }
    .load-plan tr { break-inside: avoid; }
    .load-plan .legend { display: flex; flex-wrap: wrap; gap: 6px 16px; font: 12px system-ui, sans-serif; }
    .load-plan .legend-row { display: flex; align-items: center; gap: 6px; }
    .load-plan .swatch { display: inline-block; width: 11px; height: 11px; border-radius: 2px; border: 1px solid #0002; }
    .load-plan table { border-collapse: collapse; width: 100%; font: 12px system-ui, sans-serif; }
    .load-plan th, .load-plan td { border-bottom: 1px solid #ddd; padding: 4px 8px; text-align: left; }
    .load-plan th:first-child, .load-plan td:first-child { padding-left: 0; }
    .load-plan .unplaced, .load-plan .findings { font: 12px system-ui, sans-serif; padding-left: 18px; margin: 0; }
    .load-plan .findings .error { color: #b3261e; }
    .load-plan .findings .warn { color: #8a5300; }
  </style>
  <div class="load-plan">
    <h1>${escapeHtml(info.loadName)}</h1>
    <div class="sub">${escapeHtml(subtitle)}</div>
    ${svg}
    <h2>Legend — load sequence</h2>
    <div class="legend">${legendHtml}</div>
    <h2>Pallets</h2>
    <table>
      <thead><tr><th>#</th><th>Job Number</th><th>City / State</th><th>Size</th><th>Tag</th></tr></thead>
      <tbody>${rowsHtml}</tbody>
    </table>
    ${unplacedHtml}
    ${findingsHtml}
  </div>`;
}

/**
 * The same sheet as a PDF — the copy filed into the print folder.
 *
 * Landscape, because a trailer is: the plan takes the top of page one at the
 * largest scale that fits, and the pallet list flows underneath and onto as
 * many pages as it needs. Drawn from the same `entities` the HTML sheet
 * renders and the DXF export writes.
 */
export function buildPrintPdf(
  entities: readonly Entity[],
  result: NestResult,
  findings: ValidationFinding[],
  info: LoadSheetInfo,
): Uint8Array {
  const { legend, rows, subtitle, unplaced, problems } = sheetContent(result, findings, info);
  const pdf = new PdfBuilder(PDF_LETTER_LANDSCAPE);
  const margin = 36;
  const right = pdf.width - margin;
  const bottom = pdf.height - margin;
  const ink = "#111111";
  const muted = "#555555";
  let y = margin + 12;

  pdf.text(margin, y, info.loadName, { size: 15, bold: true, color: ink });
  y += 13;
  pdf.text(margin, y, subtitle, { size: 8.5, color: muted });
  y += 8;

  // The plan, as large as the page allows without crowding out the list.
  const planHeight = Math.min(pdf.height * 0.46, bottom - y - 60);
  if (planHeight > 40 && entities.length > 0) {
    drawEntitiesToPdf(
      pdf,
      [...entities],
      { x: margin, y: y + 6, width: right - margin, height: planHeight },
      // Page points, not world units: thin enough for a 48-pallet load, heavy
      // enough that each pallet's outline reads on a laser printer, and about
      // what the printed sheet's scaled stroke comes to.
      { strokeColor: ink, strokeWidth: 0.6 },
    );
    y += planHeight + 18;
  }

  const need = (space: number, afterBreak?: () => void) => {
    if (y + space <= bottom) return;
    pdf.addPage();
    y = margin + 12;
    afterBreak?.();
  };

  // --- legend, wrapped across the page width ---
  need(30);
  pdf.text(margin, y, "LEGEND — LOAD SEQUENCE", { size: 8, bold: true, color: muted });
  y += 13;
  let x = margin;
  for (const [idx, e] of legend) {
    const label = `#${idx + 1} ${e.dest} · ${e.n} pallet${e.n === 1 ? "" : "s"}`;
    const w = pdf.measure(label, 9) + 24;
    if (x + w > right) {
      x = margin;
      y += 13;
      need(13);
    }
    pdf.rect(x, y - 7, 8, 8, { fill: e.color, stroke: "#999999", width: 0.3 });
    pdf.text(x + 12, y, label, { size: 9, color: ink });
    x += w;
  }
  y += 20;

  // --- pallet list ---
  const cols = [margin, margin + 26, margin + 130, margin + 290, margin + 430];
  const headers = ["#", "JOB NUMBER", "CITY / STATE", "SIZE", "TAG"];
  const tableHeader = () => {
    headers.forEach((h, i) => pdf.text(cols[i], y, h, { size: 8, bold: true, color: muted }));
    y += 4;
    pdf.line({ x: margin, y }, { x: right, y }, { stroke: "#999999", width: 0.5 });
    y += 11;
  };
  need(46);
  pdf.text(margin, y, "PALLETS", { size: 8, bold: true, color: muted });
  y += 14;
  tableHeader();
  for (const r of rows) {
    need(16, tableHeader);
    pdf.rect(cols[1] - 11, y - 6.5, 7, 7, { fill: r.color, stroke: "#999999", width: 0.3 });
    pdf.text(cols[0], y, String(r.n), { size: 9, color: ink });
    pdf.text(cols[1], y, r.job, { size: 9, color: ink });
    pdf.text(cols[2], y, r.where, { size: 9, color: ink });
    pdf.text(cols[3], y, r.size, { size: 9, color: ink });
    // The tag is an instruction to whoever loads it ("FRAGILE", "TOP LOAD"),
    // so it carries the weight in the row.
    pdf.text(cols[4], y, r.tag, { size: 9, bold: true, color: ink });
    y += 6;
    pdf.line({ x: margin, y }, { x: right, y }, { stroke: "#dddddd", width: 0.4 });
    y += 10;
  }

  if (unplaced.length > 0) {
    need(34);
    y += 8;
    pdf.text(margin, y, "UNPLACED", { size: 8, bold: true, color: muted });
    y += 13;
    for (const u of unplaced) {
      need(13);
      pdf.text(margin, y, u, { size: 9, color: "#b3261e" });
      y += 13;
    }
  }

  if (problems.length > 0) y += 8;
  for (const f of problems) {
    need(13);
    pdf.text(margin, y, f.message, { size: 9, color: f.level === "error" ? "#b3261e" : "#8a5300" });
    y += 13;
  }

  return pdf.bytes();
}

export const PANEL_HTML = `<!doctype html>
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
      .actions { display: flex; gap: 8px; margin: 12px 0 6px; }
      .muted { opacity: 0.6; }
      .chk { display: flex; align-items: center; gap: 6px; margin: 4px 0 10px; }
      .chk input { width: auto; margin: 0; }
      .mrow { display: flex; align-items: center; gap: 6px; margin-bottom: 6px; }
      .mrow input[type="checkbox"] { width: auto; margin: 0; flex: none; }
      .mrow .mval { width: 84px; margin: 0 0 0 auto; }
      .mrow input:disabled { opacity: 0.4; }

      .order { border: 1px solid var(--sk-border,#3a3d42); border-radius: 6px; padding: 8px; margin-bottom: 8px; background: var(--sk-panel,#232529); }
      .order.drop-before { box-shadow: 0 -3px 0 var(--sk-accent,#4f7cff); }
      .order.drop-after { box-shadow: 0 3px 0 var(--sk-accent,#4f7cff); }
      .order-head { display: flex; gap: 5px; align-items: center; margin-bottom: 6px; }
      .handle { cursor: grab; opacity: 0.5; padding: 2px 3px; user-select: none; touch-action: none; }
      .move { display: flex; flex-direction: column; }
      .move button { padding: 0 3px; line-height: 10px; font-size: 9px; background: none; border: none; color: var(--sk-text-dim,#9aa0a6); cursor: pointer; }
      .dot { width: 12px; height: 12px; border-radius: 3px; flex: none; }
      /* A colour input, shrunk to a swatch — the order's colour *is* how the
         plan identifies its drop, so it is editable where it is shown. */
      input[type="color"].swatch { width: 18px; height: 18px; flex: none; margin: 0; padding: 0; border: 1px solid var(--sk-border,#3a3d42); border-radius: 3px; background: none; cursor: pointer; }
      input[type="color"].swatch::-webkit-color-swatch-wrapper { padding: 1px; }
      input[type="color"].swatch::-webkit-color-swatch { border: none; border-radius: 2px; }
      .folder { display: flex; align-items: center; gap: 6px; margin: 2px 0 6px; }
      .folder .name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; opacity: 0.7; }
      .order-head input.job { flex: 1; margin: 0; min-width: 0; }
      .seq { font-size: 10px; opacity: 0.5; flex: none; }
      .dest-line { display: flex; gap: 4px; margin: 0 0 6px; }
      .city-wrap { position: relative; flex: 2; min-width: 0; }
      .dest-line input.city { width: 100%; margin: 0; }
      .dest-line input.state { flex: 1; margin: 0; min-width: 0; text-transform: uppercase; }
      .city-suggest { position: absolute; top: 100%; left: 0; right: 0; margin-top: 2px; background: var(--sk-panel,#2b2d31); border: 1px solid var(--sk-border,#3a3d42); border-radius: 4px; max-height: 150px; overflow-y: auto; z-index: 20; }
      .city-suggest .opt { display: flex; justify-content: space-between; gap: 8px; padding: 5px 7px; cursor: pointer; }
      .city-suggest .opt.active { background: var(--sk-accent,#4f7cff); color: #fff; }
      .city-suggest .opt .st { opacity: 0.6; }
      .city-suggest .opt.active .st { opacity: 0.85; }

      .pallet { border-top: 1px solid #33353a; padding-top: 6px; margin-top: 6px; }
      .pallet:first-child { border-top: 0; margin-top: 0; padding-top: 0; }
      .p-line { display: flex; gap: 4px; align-items: center; margin-bottom: 4px; }
      .p-line input { margin-top: 0; padding: 4px; }
      .p-preset { flex: 1; min-width: 0; margin-top: 0; padding: 4px; }
      .p-num { width: 46px; text-align: center; }
      .p-tag { flex: 1 1 0; min-width: 0; }
      .p-orient { flex: 1 1 0; width: auto; min-width: 0; margin-top: 0; padding: 4px; }
      .times { opacity: 0.5; }
      .icon { background: none; border: none; color: var(--sk-text-dim,#9aa0a6); cursor: pointer; padding: 2px 3px; font-size: 12px; }
      .shape-btn { background: var(--sk-panel,#2b2d31); border: 1px solid var(--sk-border,#3a3d42); border-radius: 4px; padding: 3px; cursor: pointer; display: inline-flex; flex: none; }
      .shape-btn svg { display: block; }

      .presets { border: 1px solid var(--sk-border,#3a3d42); border-radius: 6px; padding: 8px; margin-top: 4px; background: var(--sk-panel,#232529); }
      .preset-row { display: grid; grid-template-columns: 20px 1fr 50px 50px 24px 20px; gap: 4px; align-items: center; margin-bottom: 4px; }
      .preset-default { background: none; border: none; cursor: pointer; color: #6b6e76; font-size: 14px; padding: 0; line-height: 1; }
      .preset-default.is-default { color: #e3b341; }
      .preset-row input { margin-top: 0; padding: 4px; }

      .findings { margin-top: 8px; display: flex; flex-direction: column; gap: 4px; }
      .f { padding: 5px 7px; border-radius: 4px; background: var(--sk-panel,#2b2d31); border-left: 3px solid #6b7280; }
      .f.error { border-left-color: var(--sk-danger,#f0616d); }
      .f.warn { border-left-color: #e3a008; }
      .f.info { border-left-color: #4f9d69; }
      .stop { padding: 5px 7px; border-radius: 4px; margin-top: 4px; border-left: 3px solid #6b7280; background: var(--sk-panel,#2b2d31); }
    </style>
  </head>
  <body>
    <h4>Trailer</h4>
    <label>Preset<select id="preset"></select></label>
    <div class="grid2">
      <label>Length (<span class="u"></span>)<input id="t-length" type="number" min="0" step="any" /></label>
      <label>Width (<span class="u"></span>)<input id="t-width" type="number" min="0" step="any" /></label>
    </div>
    <label class="mrow"><input type="checkbox" id="m-wall-on" /> From walls (<span class="u"></span>)<input id="m-wall" class="mval" type="number" min="0" step="any" /></label>
    <label class="mrow"><input type="checkbox" id="m-pallet-on" /> Around pallet (<span class="u"></span>)<input id="m-pallet" class="mval" type="number" min="0" step="any" /></label>
    <div class="row">
      <button class="ghost sm" id="presets-toggle">Manage sizes…</button>
    </div>
    <div class="presets" id="presets" hidden></div>

    <h4>Orders — drag <span style="opacity:.6">&#10303;</span> or use &#9650;&#9660; to set load order</h4>
    <div id="orders"></div>
    <button class="ghost sm" id="order-add">+ Add order</button>

    <label class="chk"><input type="checkbox" id="dim-each" /> Dimension every pallet on the plan</label>
    <div class="mrow">
      <input type="color" id="text-color" class="swatch" title="Colour of the dimensions and the NOSE / DOOR labels" />
      <span>Plan text colour</span>
      <button class="ghost sm" id="text-color-reset" style="margin-left:auto">Reset</button>
    </div>

    <div class="actions">
      <button id="nest">Auto-nest</button>
      <button class="ghost" id="clear">Clear layout</button>
    </div>
    <div id="results"></div>

    <h4>Print</h4>
    <div class="grid2">
      <label>Load name<input id="load-name" placeholder="e.g. Load 42" /></label>
      <label>Load date<input id="load-date" type="date" /></label>
    </div>
    <label>Truck / driver info<input id="truck-info" placeholder="Truck #, driver, plate…" /></label>
    <div class="folder" id="folder-row" hidden>
      <button class="ghost sm" id="pick-folder">Choose folder…</button>
      <span class="name" id="folder-name"></span>
    </div>
    <div class="actions">
      <button class="ghost" id="print-load" disabled>Print load plan</button>
    </div>

    <script>
      const post = (m) => parent.postMessage({ pluginMessage: m }, "*");
      const $ = (id) => document.getElementById(id);
      const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
      const RECT_SVG = '<svg width="14" height="14" viewBox="0 0 14 14"><rect x="2" y="3.5" width="10" height="7" rx="1" fill="none" stroke="#dfe1e5" stroke-width="1.4"/></svg>';
      // Orientation lock. "Auto" is the old behaviour — the nester turns a
      // pallet when that packs tighter. The other two say it can't be
      // turned, because the freight or the forklift says so.
      const ORIENT_OPTS = [
        { v: "auto", label: "Auto turn" },
        { v: "fixed", label: "Keep W×L" },
        { v: "turned", label: "Turn 90°" },
      ];
      const ROUND_SVG = '<svg width="14" height="14" viewBox="0 0 14 14"><circle cx="7" cy="7" r="4.6" fill="none" stroke="#dfe1e5" stroke-width="1.4"/></svg>';

      // A hint for the common case, not a full postal database — any city/state can still be typed freely.
      const CITY_STATE_HINTS = {
        dallas: "TX", houston: "TX", austin: "TX", "san antonio": "TX", "fort worth": "TX", "el paso": "TX",
        "los angeles": "CA", "san francisco": "CA", "san diego": "CA", sacramento: "CA", oakland: "CA", "san jose": "CA", fresno: "CA",
        "new york": "NY", buffalo: "NY", rochester: "NY", albany: "NY", syracuse: "NY",
        chicago: "IL", springfield: "IL",
        phoenix: "AZ", tucson: "AZ", mesa: "AZ",
        philadelphia: "PA", pittsburgh: "PA", allentown: "PA",
        columbus: "OH", cleveland: "OH", cincinnati: "OH", toledo: "OH",
        atlanta: "GA", savannah: "GA", augusta: "GA",
        charlotte: "NC", raleigh: "NC", greensboro: "NC", durham: "NC",
        miami: "FL", orlando: "FL", tampa: "FL", jacksonville: "FL",
        seattle: "WA", spokane: "WA", tacoma: "WA",
        denver: "CO", "colorado springs": "CO", aurora: "CO",
        boston: "MA", worcester: "MA",
        detroit: "MI", "grand rapids": "MI", lansing: "MI",
        portland: "OR", salem: "OR", eugene: "OR",
        memphis: "TN", nashville: "TN", knoxville: "TN", chattanooga: "TN",
        louisville: "KY", lexington: "KY",
        "las vegas": "NV", reno: "NV",
        indianapolis: "IN", "fort wayne": "IN",
        milwaukee: "WI", madison: "WI",
        "kansas city": "MO", "st louis": "MO", "saint louis": "MO",
        minneapolis: "MN", "saint paul": "MN", "st paul": "MN",
        "oklahoma city": "OK", tulsa: "OK",
        "salt lake city": "UT",
        albuquerque: "NM",
        baltimore: "MD",
        richmond: "VA", "virginia beach": "VA", norfolk: "VA",
        toronto: "ON", vancouver: "BC", montreal: "QC", calgary: "AB", edmonton: "AB", ottawa: "ON", winnipeg: "MB",
      };
      const CITY_NAMES = Object.keys(CITY_STATE_HINTS);
      const titleCase = (s) => s.replace(/\b\w/g, (c) => c.toUpperCase());

      let unit = { unit: "mm", perMm: 1, label: "mm" };
      let palette = ["#4f86d6"];
      const DEFAULT_TEXT_COLOR = "#e8eaed";
      let state = { presets: [], palletPresets: [], lastPresetName: "", defaultTrailerName: "", defaultPalletName: "", wallMargin: 0, palletMargin: 0, wallOn: false, palletOn: false, dimensions: false, textColor: DEFAULT_TEXT_COLOR, orders: [], loadDate: "" };
      let saveTimer = 0;
      let nested = false; // a plan is currently drawn

      const toU = (mm) => Math.round(mm * unit.perMm * 100) / 100;
      const fromU = (v) => (Number(v) || 0) / unit.perMm;
      const rid = (p) => p + "-" + Math.random().toString(36).slice(2, 8);
      const persist = () => { clearTimeout(saveTimer); saveTimer = setTimeout(() => post({ type: "persist", state }), 400); };
      const defaultPallet = () => state.palletPresets.find((p) => p.name === state.defaultPalletName) || state.palletPresets[0];
      const newPallet = () => { const d = defaultPallet(); return { id: rid("p"), name: d.name, width: d.width, length: d.length, shape: d.shape, qty: 1 }; };

      // ---- trailer ----
      const currentPreset = () => state.presets.find((p) => p.name === state.lastPresetName) || null;
      function renderTrailer() {
        document.querySelectorAll(".u").forEach((el) => (el.textContent = unit.label));
        const sel = $("preset");
        sel.innerHTML =
          state.presets.map((p) => "<option value='" + esc(p.name) + "'>" + esc(p.name) + " — " + toU(p.length) + "×" + toU(p.width) + " " + esc(unit.label) + "</option>").join("") +
          "<option value='__custom'>Custom…</option>";
        const p = currentPreset();
        sel.value = p ? p.name : "__custom";
        if (p) { $("t-length").value = toU(p.length); $("t-width").value = toU(p.width); }
        $("m-wall").value = toU(state.wallMargin);
        $("m-pallet").value = toU(state.palletMargin);
        $("m-wall-on").checked = !!state.wallOn;
        $("m-pallet-on").checked = !!state.palletOn;
        $("m-wall").disabled = !state.wallOn;
        $("m-pallet").disabled = !state.palletOn;
        $("dim-each").checked = !!state.dimensions;
        $("text-color").value = state.textColor || DEFAULT_TEXT_COLOR;
        $("load-name").value = state.loadName || "";
        $("truck-info").value = state.truckInfo || "";
        $("load-date").value = state.loadDate || new Date().toISOString().slice(0, 10);
      }
      $("text-color").addEventListener("input", () => { state.textColor = $("text-color").value; persist(); });
      $("text-color-reset").addEventListener("click", () => { state.textColor = DEFAULT_TEXT_COLOR; $("text-color").value = DEFAULT_TEXT_COLOR; persist(); });
      $("pick-folder").addEventListener("click", () => post({ type: "pick-folder" }));
      $("load-name").addEventListener("input", () => { state.loadName = $("load-name").value; persist(); });
      $("truck-info").addEventListener("input", () => { state.truckInfo = $("truck-info").value; persist(); });
      $("load-date").addEventListener("input", () => { state.loadDate = $("load-date").value; persist(); });
      $("print-load").addEventListener("click", () => {
        post({ type: "print", loadName: state.loadName, truckInfo: state.truckInfo, loadDate: state.loadDate });
      });
      $("preset").addEventListener("change", (e) => {
        if (e.target.value === "__custom") return;
        state.lastPresetName = e.target.value;
        renderTrailer();
        persist();
      });
      const onTrailerInput = () => {
        const p = currentPreset();
        if (!p || Math.abs(fromU($("t-length").value) - p.length) > 0.5 || Math.abs(fromU($("t-width").value) - p.width) > 0.5) {
          state.lastPresetName = "";
          $("preset").value = "__custom";
        }
        persist();
      };
      $("t-length").addEventListener("input", onTrailerInput);
      $("t-width").addEventListener("input", onTrailerInput);
      // Margins change the actual placement, so they only take effect on the
      // next Auto-nest — editing or toggling them must not reshuffle a drawn
      // plan out from under the user.
      $("m-wall").addEventListener("input", () => {
        state.wallMargin = fromU($("m-wall").value);
        if (!state.wallOn && state.wallMargin > 0) { state.wallOn = true; $("m-wall-on").checked = true; }
        persist();
      });
      $("m-pallet").addEventListener("input", () => {
        state.palletMargin = fromU($("m-pallet").value);
        if (!state.palletOn && state.palletMargin > 0) { state.palletOn = true; $("m-pallet-on").checked = true; }
        persist();
      });
      $("m-wall-on").addEventListener("change", () => { state.wallOn = $("m-wall-on").checked; $("m-wall").disabled = !state.wallOn; persist(); });
      $("m-pallet-on").addEventListener("change", () => { state.palletOn = $("m-pallet-on").checked; $("m-pallet").disabled = !state.palletOn; persist(); });
      // A dimension is an overlay, added/removed on the already-drawn plan —
      // never a re-nest, so every pallet (including ones dragged by hand) stays put.
      $("dim-each").addEventListener("change", () => {
        state.dimensions = $("dim-each").checked;
        persist();
        if (nested) post({ type: "toggle-dimensions", dimensions: state.dimensions });
      });
      const effWall = () => (state.wallOn ? Math.max(0, state.wallMargin) : 0);
      const effPallet = () => (state.palletOn ? Math.max(0, state.palletMargin) : 0);
      function readTrailer() {
        const p = currentPreset();
        return { name: p ? p.name : "Custom trailer", length: fromU($("t-length").value), width: fromU($("t-width").value), wallMargin: effWall() };
      }

      // ---- preset managers (trailer + pallet sizes, inline edit + delete) ----
      $("presets-toggle").addEventListener("click", () => {
        $("presets").hidden = !$("presets").hidden;
        if (!$("presets").hidden) renderPresets();
      });
      function presetRows(list, cls, hasShape, defaultName) {
        return list
          .map(
            (p, i) =>
              "<div class='preset-row' data-i='" + i + "'>" +
              "<button class='preset-default " + cls + "-setdefault" + (p.name === defaultName ? " is-default" : "") + "' title='" + (p.name === defaultName ? "Default" : "Set as default") + "'>" + (p.name === defaultName ? "&#9733;" : "&#9734;") + "</button>" +
              "<input class='" + cls + "-name' value='" + esc(p.name) + "'>" +
              "<input class='" + cls + "-a' type='number' min='0' step='any' value='" + toU(hasShape ? p.width : p.length) + "'>" +
              "<input class='" + cls + "-b' type='number' min='0' step='any' value='" + toU(hasShape ? p.length : p.width) + "'" + (hasShape && p.shape === "round" ? " disabled style='visibility:hidden'" : "") + ">" +
              (hasShape ? "<span class='shape-btn " + cls + "-shape'>" + (p.shape === "round" ? ROUND_SVG : RECT_SVG) + "</span>" : "<span></span>") +
              "<button class='icon " + cls + "-del' title='Delete'>&#10005;</button>" +
              "</div>",
          )
          .join("");
      }
      function renderPresets() {
        const box = $("presets");
        box.innerHTML =
          "<div class='muted'>Trailer sizes (L&times;W, " + esc(unit.label) + ") — &#9733; sets the default</div>" +
          presetRows(state.presets, "tp", false, state.defaultTrailerName) +
          "<button class='ghost sm' id='tp-add' style='margin:2px 0 8px'>+ New trailer</button>" +
          "<div class='muted'>Pallet sizes (W&times;L, " + esc(unit.label) + ") — &#9733; sets the default</div>" +
          presetRows(state.palletPresets, "pp", true, state.defaultPalletName) +
          "<button class='ghost sm' id='pp-add' style='margin-top:2px'>+ New pallet</button>";

        box.querySelectorAll(".preset-row").forEach((row) => {
          const i = Number(row.dataset.i);
          const isPallet = !!row.querySelector(".pp-name");
          const list = isPallet ? state.palletPresets : state.presets;
          const p = list[i];
          const nameEl = row.querySelector(isPallet ? ".pp-name" : ".tp-name");
          const aEl = row.querySelector(isPallet ? ".pp-a" : ".tp-a");
          const bEl = row.querySelector(isPallet ? ".pp-b" : ".tp-b");
          nameEl.addEventListener("input", (e) => {
            // Keep the default pointer in sync if the preset it names gets renamed.
            const key = isPallet ? "defaultPalletName" : "defaultTrailerName";
            if (state[key] === p.name) state[key] = e.target.value;
            p.name = e.target.value;
            persist();
          });
          aEl.addEventListener("input", (e) => { if (isPallet) p.width = fromU(e.target.value); else p.length = fromU(e.target.value); persist(); });
          bEl.addEventListener("input", (e) => { if (isPallet) p.length = fromU(e.target.value); else p.width = fromU(e.target.value); persist(); });
          const shapeEl = row.querySelector(".pp-shape");
          if (shapeEl) shapeEl.addEventListener("click", () => { p.shape = p.shape === "round" ? "rect" : "round"; if (p.shape === "round") p.length = p.width; renderPresets(); persist(); });
          row.querySelector(isPallet ? ".pp-setdefault" : ".tp-setdefault").addEventListener("click", () => {
            state[isPallet ? "defaultPalletName" : "defaultTrailerName"] = p.name;
            renderPresets();
            persist();
          });
          row.querySelector(isPallet ? ".pp-del" : ".tp-del").addEventListener("click", () => {
            if (list.length <= 1) return; // always keep at least one preset to default to
            list.splice(i, 1);
            const key = isPallet ? "defaultPalletName" : "defaultTrailerName";
            if (state[key] === p.name) state[key] = list[0].name;
            renderPresets();
            renderTrailer();
            persist();
          });
        });
        box.querySelector("#tp-add").addEventListener("click", () => { state.presets.push({ name: "New trailer", length: 13600, width: 2480 }); renderPresets(); renderTrailer(); persist(); });
        box.querySelector("#pp-add").addEventListener("click", () => { state.palletPresets.push({ name: "New pallet", width: 1200, length: 800, shape: "rect" }); renderPresets(); renderTrailer(); persist(); });
      }

      // ---- orders ----
      function renderOrders() {
        const host = $("orders");
        host.innerHTML = "";
        state.orders.forEach((order, oi) => {
          const card = document.createElement("div");
          card.className = "order";
          card.dataset.i = String(oi);

          const pallets = order.pallets
            .map((p, pi) => {
              const round = p.shape === "round";
              const known = state.palletPresets.some((x) => x.name === p.name);
              const opts =
                state.palletPresets.map((x) => "<option value='" + esc(x.name) + "'" + (x.name === p.name ? " selected" : "") + ">" + esc(x.name) + " — " + (x.shape === "round" ? "&#8960;" + toU(x.width) : toU(x.width) + "&times;" + toU(x.length)) + " " + esc(unit.label) + "</option>").join("") +
                "<option value='__custom'" + (known ? "" : " selected") + ">Custom size</option>";
              return (
                "<div class='pallet' data-p='" + pi + "'>" +
                "<div class='p-line'>" +
                "<select class='p-preset'>" + opts + "</select>" +
                "<span class='shape-btn ps' title='Rectangular / round'>" + (round ? ROUND_SVG : RECT_SVG) + "</span>" +
                "<input class='p-num pq' type='number' min='1' step='1' title='Quantity' value='" + (p.qty || 1) + "'>" +
                "<button class='icon dup' title='Duplicate'>&#8865;</button>" +
                "<button class='icon del' title='Delete'>&#10005;</button>" +
                "</div>" +
                "<div class='p-line'>" +
                "<input class='p-num pw' type='number' min='0' step='any' title='" + (round ? "Diameter" : "Width") + " (" + esc(unit.label) + ")' value='" + toU(p.width) + "'>" +
                (round ? "" : "<span class='times'>&times;</span><input class='p-num pl' type='number' min='0' step='any' title='Length (" + esc(unit.label) + ")' value='" + toU(p.length) + "'>") +
                "<input class='p-tag' placeholder='Tag (e.g. FRAGILE)' value='" + esc(p.tag || "") + "'>" +
                (round
                  ? ""
                  : "<select class='p-orient' title='Orientation — Auto lets the nester turn it to pack tighter; the others lock it'>" +
                    ORIENT_OPTS.map((o) => "<option value='" + o.v + "'" + ((p.orientation || "auto") === o.v ? " selected" : "") + ">" + o.label + "</option>").join("") +
                    "</select>") +
                "</div>" +
                "</div>"
              );
            })
            .join("");

          card.innerHTML =
            "<div class='order-head'>" +
            "<span class='handle' title='Drag to reorder'>&#10303;</span>" +
            "<span class='move'><button class='up' title='Move up'>&#9650;</button><button class='down' title='Move down'>&#9660;</button></span>" +
            "<input type='color' class='swatch ocolor' value='" + esc(order.color) + "' title='Colour for this drop — re-nest to redraw'>" +
            "<input class='job' placeholder='Job Number' value='" + esc(order.jobNumber || "") + "'>" +
            "<span class='seq'>#" + (oi + 1) + "</span>" +
            "<button class='icon order-del' title='Remove order'>&#10005;</button>" +
            "</div>" +
            "<div class='dest-line'>" +
            "<div class='city-wrap'>" +
            "<input class='city' placeholder='City' value='" + esc(order.city) + "' autocomplete='off'>" +
            "<div class='city-suggest' hidden></div>" +
            "</div>" +
            "<input class='state' placeholder='State' maxlength='2' value='" + esc(order.state || "") + "'>" +
            "</div>" +
            pallets +
            "<button class='ghost sm p-add' style='margin-top:6px'>+ Pallet</button>";

          host.appendChild(card);
        });
        bindOrderEvents();
      }

      function move(from, to) {
        if (to < 0 || to >= state.orders.length || from === to) return;
        const [m] = state.orders.splice(from, 1);
        state.orders.splice(to, 0, m);
        renderOrders();
        persist();
      }

      function bindOrderEvents() {
        $("orders").querySelectorAll(".order").forEach((card) => {
          const oi = Number(card.dataset.i);
          const order = state.orders[oi];
          card.querySelector(".up").disabled = oi === 0;
          card.querySelector(".down").disabled = oi === state.orders.length - 1;
          card.querySelector(".up").addEventListener("click", () => move(oi, oi - 1));
          card.querySelector(".down").addEventListener("click", () => move(oi, oi + 1));
          card.querySelector(".job").addEventListener("input", (e) => { order.jobNumber = e.target.value; persist(); });
          bindOrderColor(card, order);
          const cityEl = card.querySelector(".city");
          const stateEl = card.querySelector(".state");
          const suggestEl = card.querySelector(".city-suggest");
          let matches = [];
          let activeIdx = -1;

          function renderSuggestions() {
            if (matches.length === 0) { suggestEl.hidden = true; suggestEl.innerHTML = ""; return; }
            suggestEl.innerHTML = matches
              .map(
                (c, i) =>
                  "<div class='opt" + (i === activeIdx ? " active" : "") + "' data-city='" + esc(c) + "'>" +
                  "<span>" + esc(titleCase(c)) + "</span><span class='st'>" + esc(CITY_STATE_HINTS[c]) + "</span></div>",
              )
              .join("");
            suggestEl.hidden = false;
          }
          function updateMatches(q) {
            const query = q.trim().toLowerCase();
            matches = query ? CITY_NAMES.filter((c) => c.startsWith(query)).slice(0, 6) : [];
            activeIdx = matches.length ? 0 : -1;
            renderSuggestions();
          }
          function acceptSuggestion(city) {
            const st = CITY_STATE_HINTS[city];
            order.city = titleCase(city);
            cityEl.value = order.city;
            if (st) { order.state = st; stateEl.value = st; }
            matches = [];
            activeIdx = -1;
            renderSuggestions();
            persist();
          }

          cityEl.addEventListener("input", (e) => {
            order.city = e.target.value;
            updateMatches(e.target.value);
            persist();
          });
          cityEl.addEventListener("keydown", (e) => {
            if (matches.length === 0) return;
            if (e.key === "ArrowDown") { e.preventDefault(); activeIdx = (activeIdx + 1) % matches.length; renderSuggestions(); }
            else if (e.key === "ArrowUp") { e.preventDefault(); activeIdx = (activeIdx - 1 + matches.length) % matches.length; renderSuggestions(); }
            else if (e.key === "Enter") { e.preventDefault(); acceptSuggestion(matches[activeIdx >= 0 ? activeIdx : 0]); }
            else if (e.key === "Escape") { matches = []; activeIdx = -1; renderSuggestions(); }
          });
          cityEl.addEventListener("blur", () => {
            // A short delay lets a suggestion's mousedown (below) register before the list is torn down.
            setTimeout(() => {
              const exact = CITY_STATE_HINTS[cityEl.value.trim().toLowerCase()];
              if (exact && !order.state) { order.state = exact; stateEl.value = exact; persist(); }
              matches = [];
              activeIdx = -1;
              renderSuggestions();
            }, 150);
          });
          suggestEl.addEventListener("mousedown", (e) => {
            const opt = e.target.closest(".opt");
            if (!opt) return;
            e.preventDefault();
            acceptSuggestion(opt.dataset.city);
          });
          stateEl.addEventListener("input", (e) => { order.state = e.target.value.toUpperCase(); persist(); });
          card.querySelector(".order-del").addEventListener("click", () => { state.orders.splice(oi, 1); renderOrders(); persist(); });
          card.querySelector(".p-add").addEventListener("click", () => {
            order.pallets.push(newPallet());
            renderOrders();
            persist();
          });

          card.querySelectorAll(".pallet").forEach((row) => {
            const pi = Number(row.dataset.p);
            const p = order.pallets[pi];
            row.querySelector(".p-preset").addEventListener("change", (e) => {
              const v = e.target.value;
              const pp = state.palletPresets.find((x) => x.name === v);
              if (pp) { p.name = pp.name; p.width = pp.width; p.length = pp.length; p.shape = pp.shape; }
              else p.name = "";
              renderOrders();
              persist();
            });
            row.querySelector(".pq").addEventListener("input", (e) => { p.qty = Math.max(1, Math.floor(Number(e.target.value) || 1)); persist(); });
            row.querySelector(".pw").addEventListener("input", (e) => { p.width = fromU(e.target.value); persist(); });
            const plEl = row.querySelector(".pl");
            if (plEl) plEl.addEventListener("input", (e) => { p.length = fromU(e.target.value); persist(); });
            row.querySelector(".p-tag").addEventListener("input", (e) => { p.tag = e.target.value; persist(); });
            const orientEl = row.querySelector(".p-orient");
            if (orientEl) orientEl.addEventListener("change", (e) => { p.orientation = e.target.value; persist(); });
            row.querySelector(".ps").addEventListener("click", () => {
              p.shape = p.shape === "round" ? "rect" : "round";
              if (p.shape === "round") p.length = p.width;
              renderOrders();
              persist();
            });
            row.querySelector(".dup").addEventListener("click", () => { order.pallets.splice(pi + 1, 0, { ...p, id: rid("p") }); renderOrders(); persist(); });
            row.querySelector(".del").addEventListener("click", () => { order.pallets.splice(pi, 1); renderOrders(); persist(); });
          });

          // Pointer-drag reorder on the handle (HTML5 DnD is unreliable in the sandbox).
          const handle = card.querySelector(".handle");
          handle.addEventListener("pointerdown", (e) => {
            e.preventDefault();
            try { handle.setPointerCapture(e.pointerId); } catch (_) {}
            const cards = [...$("orders").querySelectorAll(".order")];
            const clear = () => cards.forEach((c) => c.classList.remove("drop-before", "drop-after"));
            // insertBefore is an index in 0..cards.length: where the dragged card
            // should land relative to the *current* list.
            let insertBefore = oi;
            let moved = false;
            const onMove = (ev) => {
              moved = true;
              clear();
              insertBefore = cards.length;
              for (let k = 0; k < cards.length; k++) {
                const r = cards[k].getBoundingClientRect();
                if (ev.clientY < r.top + r.height / 2) { insertBefore = k; break; }
              }
              if (insertBefore >= cards.length) cards[cards.length - 1].classList.add("drop-after");
              else cards[insertBefore].classList.add("drop-before");
            };
            const onUp = () => {
              clear();
              handle.removeEventListener("pointermove", onMove);
              handle.removeEventListener("pointerup", onUp);
              try { handle.releasePointerCapture(e.pointerId); } catch (_) {}
              if (!moved) return;
              // Remove the dragged card first, then insert — every slot at or past
              // oi shifts down by one.
              const to = insertBefore > oi ? insertBefore - 1 : insertBefore;
              move(oi, Math.max(0, Math.min(to, state.orders.length - 1)));
            };
            handle.addEventListener("pointermove", onMove);
            handle.addEventListener("pointerup", onUp);
          });
        });
      }

      // The first palette colour no drop is already wearing — counting by
      // position hands out a duplicate as soon as an order in the middle is
      // deleted, and two drops the same colour is a plan that reads wrong.
      function freeColor() {
        const used = state.orders.map((o) => o.color);
        return palette.find((c) => !used.includes(c)) || palette[state.orders.length % palette.length];
      }

      // Re-inking an order takes a re-nest to reach the drawing; the plan on
      // screen is the one that was solved, and nothing here redraws behind
      // the user's back.
      function bindOrderColor(row, order) {
        row.querySelector(".ocolor").addEventListener("input", (e) => { order.color = e.target.value; persist(); });
      }

      $("order-add").addEventListener("click", () => {
        state.orders.push({ id: rid("o"), jobNumber: "", city: "", state: "", color: freeColor(), pallets: [newPallet()] });
        renderOrders();
        persist();
      });

      function setNested(v) { nested = v; $("print-load").disabled = !v; }

      function runNest() {
        post({ type: "nest", trailer: readTrailer(), orders: state.orders, palletMargin: effPallet(), dimensions: !!state.dimensions, textColor: state.textColor || DEFAULT_TEXT_COLOR });
        $("results").innerHTML = "<div class='muted'>Nesting…</div>";
      }
      $("nest").addEventListener("click", runNest);
      $("clear").addEventListener("click", () => { setNested(false); post({ type: "clear" }); $("results").innerHTML = ""; });

      // ---- results ----
      function renderResult(m) {
        const box = $("results");
        if (m.type === "cleared") { setNested(false); box.innerHTML = "<div class='muted'>Layout cleared.</div>"; return; }
        if (m.type === "error") { box.innerHTML = "<div class='f error'>" + esc(m.message) + "</div>"; return; }
        setNested(true);
        const r = m.result;
        let html =
          "<h4>Result</h4><div class='muted'>" + r.placed.length + " placed, " + r.unplaced.length +
          " unplaced &middot; " + Math.round(toU(r.usedLength)) + " / " + Math.round(toU(r.trailer.length)) + " " + esc(unit.label) + " used</div>";
        html += "<div class='findings'>" + m.findings.map((f) => "<div class='f " + f.level + "'>" + esc(f.message) + "</div>").join("") + "</div>";
        const dest = (p) => {
          const cs = [p.city, p.state].filter(Boolean).join(", ");
          return [p.jobNumber, cs].filter(Boolean).join(" — ") || "—";
        };
        const byOrder = new Map();
        r.placed.forEach((p) => {
          const e = byOrder.get(p.orderId) || { dest: dest(p), color: p.color, index: p.orderIndex, n: 0 };
          e.n += 1;
          byOrder.set(p.orderId, e);
        });
        const seq = [...byOrder.values()].sort((a, b) => a.index - b.index);
        if (seq.length) html += "<h4>Load sequence</h4>";
        seq.forEach((o) => {
          html += "<div class='stop' style='border-left-color:" + esc(o.color) + "'>#" + (o.index + 1) + " " + esc(o.dest) + " · " + o.n + " pallet" + (o.n === 1 ? "" : "s") + "</div>";
        });
        html += "<div class='muted' style='margin-top:8px'>Use “Print load plan” below for a PDF with the plan, legend and pallet list.</div>";
        box.innerHTML = html;
      }

      window.addEventListener("message", (e) => {
        const m = e.data && e.data.pluginMessage;
        if (!m) return;
        if (m.type === "init") {
          state = m.state;
          unit = m.unit || unit;
          palette = m.palette && m.palette.length ? m.palette : palette;
          renderTrailer();
          renderOrders();
          if (!$("presets").hidden) renderPresets();
          return;
        }
        if (m.type === "folder") {
          const f = m.folder || {};
          $("folder-row").hidden = !f.supported;
          $("folder-name").textContent = f.folder
            ? (f.enabled ? "PDF filed in “" + f.folder + "”" : "Folder “" + f.folder + "” — saving is off")
            : "No folder — no PDF is kept";
          $("pick-folder").textContent = f.folder ? "Change…" : "Choose folder…";
          return;
        }
        if (m.type === "unit") {
          unit = m.unit;
          renderTrailer();
          renderOrders();
          if (!$("presets").hidden) renderPresets();
          return;
        }
        renderResult(m);
      });

      post({ type: "ready" });
    </script>
  </body>
</html>`;

export default plugin;
