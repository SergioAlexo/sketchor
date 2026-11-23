/**
 * NT-03 / NT-04: the Bars and Tubes calculators behind the Sheet Nesting
 * panel. The panel sends what was typed (strings, any length format the
 * nesting fields take: 20', 240", 6 1/2, 6000 mm); these turn it into a bar
 * plan and a ready-to-render result with every length already formatted.
 * Pure, never throw: a bad row is reported, not fatal.
 */
import { groupBars, planBars, tubeCutLength, tubeSectionArea, tubeTime, type BarCutItem, type BarStock, type TubeShape } from "./barCutting";
import type { MaterialId } from "./catalog";
import { profileMotionMm, profileRowFor, type MachineProfile } from "./machineProfile";
import { fmtDuration, fmtMm } from "./sheetNesting";
import { parseLen, type LengthFormat, type LengthUnit } from "./units";

export type CalcUnit = "in" | "ft" | "mm" | "m";

export interface BarCalcInput {
  unit: CalcUnit;
  kerf: string;
  trim: string;
  tail: string;
  stock: { length: string; qty: string; cost: string }[];
  cuts: { label: string; length: string; qty: string; extraCut?: string; extraPierces?: string }[];
}

export interface TubeCalcInput extends BarCalcInput {
  shape: TubeShape;
  a: string;
  b: string;
  wall: string;
  material: MaterialId;
  /** Blank = from the machine file. Per minute, in `unit`. */
  feed: string;
  pierce: string;
  index: string;
  load: string;
  unload: string;
  piercesPerCut: string;
  profileId: string;
}

export interface CalcResult {
  error?: string;
  warnings: string[];
  summary: [string, string][];
  buy: { length: string; count: number; cost: string }[];
  bars: { count: number; stock: string; cuts: string; remnant: string; time?: string }[];
  unplaced: string[];
}

const DISPLAY: Record<CalcUnit, LengthFormat> = { in: "indec", ft: "ftin", mm: "mm", m: "m" };
const MM_PER_IN = 25.4;

export function defaultBarInput(): BarCalcInput {
  return {
    unit: "in",
    kerf: "1/8",
    trim: "1/4",
    tail: "0",
    stock: [{ length: "20'", qty: "", cost: "" }, { length: "24'", qty: "", cost: "" }],
    cuts: [{ label: "A", length: "48", qty: "6" }, { label: "B", length: "30 1/2", qty: "10" }],
  };
}

export function defaultTubeInput(): TubeCalcInput {
  return {
    ...defaultBarInput(),
    kerf: "0.01",
    trim: "0.25",
    tail: "4",
    shape: "square",
    a: "2",
    b: "",
    wall: "0.12",
    material: "cs",
    feed: "",
    pierce: "",
    index: "1.5",
    load: "45",
    unload: "4",
    piercesPerCut: "1",
    profileId: "",
  };
}

const lenMm = (s: string, unit: CalcUnit): number => {
  const inches = parseLen(s, unit as LengthUnit);
  return Number.isFinite(inches) ? inches * MM_PER_IN : NaN;
};
const numOr = (s: string | undefined, fb: number): number => {
  const v = s === undefined || s.trim() === "" ? NaN : Number(s.trim());
  return Number.isFinite(v) && v >= 0 ? v : fb;
};

interface Parsed {
  items: BarCutItem[];
  stock: BarStock[];
  kerf: number;
  trim: number;
  tail: number;
  warnings: string[];
  features: Map<string, { cutLength: number; pierces: number }>;
}

function parseCommon(inp: BarCalcInput): Parsed | { error: string } {
  const u = inp.unit;
  const warnings: string[] = [];
  const kerf = inp.kerf.trim() === "" ? 0 : lenMm(inp.kerf, u);
  const trim = inp.trim.trim() === "" ? 0 : lenMm(inp.trim, u);
  const tail = inp.tail.trim() === "" ? 0 : lenMm(inp.tail, u);
  if (![kerf, trim, tail].every((x) => Number.isFinite(x) && x >= 0)) return { error: "Kerf, end trim and tail must be lengths (0 or more)." };
  const stock: BarStock[] = [];
  inp.stock.forEach((s, i) => {
    if (s.length.trim() === "") return;
    const L = lenMm(s.length, u);
    if (!(L > 0)) return void warnings.push(`Stock row ${i + 1}: "${s.length}" is not a length - skipped.`);
    const q = s.qty.trim() === "" ? null : Math.floor(Number(s.qty));
    const cost = s.cost.trim() === "" ? undefined : Number(s.cost);
    stock.push({ length: L, qty: q !== null && Number.isFinite(q) && q >= 0 ? q : null, ...(cost !== undefined && Number.isFinite(cost) && cost >= 0 ? { cost } : {}) });
  });
  if (stock.length === 0) return { error: "Add at least one stock length." };
  const items: BarCutItem[] = [];
  const features = new Map<string, { cutLength: number; pierces: number }>();
  inp.cuts.forEach((c, i) => {
    if (c.length.trim() === "" && c.qty.trim() === "") return;
    const L = lenMm(c.length, u);
    const q = Math.floor(Number(c.qty || "1"));
    if (!(L > 0)) return void warnings.push(`Cut row ${i + 1}: "${c.length}" is not a length - skipped.`);
    if (!(q > 0)) return void warnings.push(`Cut row ${i + 1}: quantity "${c.qty}" - skipped.`);
    const label = c.label.trim() || `#${i + 1}`;
    items.push({ label, length: L, qty: q });
    const extra = c.extraCut && c.extraCut.trim() !== "" ? lenMm(c.extraCut, u) : 0;
    const ep = numOr(c.extraPierces, 0);
    if ((extra > 0 || ep > 0) && !features.has(label)) features.set(label, { cutLength: extra > 0 ? extra : 0, pierces: Math.floor(ep) });
  });
  if (items.length === 0) return { error: "Add the lengths you need to cut." };
  return { items, stock, kerf, trim, tail, warnings, features };
}

const money = (v: number | null) => (v === null ? "" : (Math.round(v * 100) / 100).toFixed(2));

function planResult(p: Parsed, unit: CalcUnit): { res: CalcResult; plan: ReturnType<typeof planBars> } {
  const f = (mm: number) => fmtMm(mm, DISPLAY[unit]);
  const plan = planBars(p.items, p.stock, { kerf: p.kerf, trimStart: p.trim, tail: p.tail });
  const totalCost = plan.byStock.every((b) => b.cost !== null) && plan.byStock.length > 0 ? plan.byStock.reduce((n, b) => n + (b.cost ?? 0), 0) : null;
  const need = p.items.reduce((n, it) => n + it.qty, 0);
  const res: CalcResult = {
    warnings: [...p.warnings],
    summary: [
      ["Bars to get", String(plan.bars.length)],
      ["Pieces", `${plan.pieces} / ${need}`],
      ["Stock length", f(plan.totalStockLength)],
      ["Yield", `${Math.round(plan.utilisation * 1000) / 10}%`],
      ["Drop (waste)", f(Math.max(0, plan.totalStockLength - plan.totalPieceLength))],
      ...(totalCost !== null ? ([["Stock cost", money(totalCost)]] as [string, string][]) : []),
    ],
    buy: plan.byStock.map((b) => ({ length: f(b.length), count: b.count, cost: money(b.cost) })),
    bars: groupBars(plan.bars).map(({ count, bar }) => {
      const runs: string[] = [];
      let i = 0;
      while (i < bar.cuts.length) {
        let j = i;
        while (j < bar.cuts.length && bar.cuts[j]!.label === bar.cuts[i]!.label && bar.cuts[j]!.length === bar.cuts[i]!.length) j++;
        runs.push(`${j - i > 1 ? `${j - i} × ` : ""}${f(bar.cuts[i]!.length)} (${bar.cuts[i]!.label})`);
        i = j;
      }
      return { count, stock: f(bar.stockLength), cuts: runs.join(", "), remnant: f(bar.remnant) };
    }),
    unplaced: plan.unplaced.map((u) => `${u.label} ${f(u.length)} × ${u.count}`),
  };
  if (plan.unplaced.length > 0) res.warnings.push("Some pieces did not fit: longer than every bar (after trim and tail), or the stock you have ran out.");
  return { res, plan };
}

export function runBarCalc(inp: BarCalcInput): CalcResult {
  const p = parseCommon(inp);
  if ("error" in p) return { error: p.error, warnings: [], summary: [], buy: [], bars: [], unplaced: [] };
  return planResult(p, inp.unit).res;
}

const DENSITY: Partial<Record<MaterialId, number>> = { cs: 7850, ss: 8000, al5052: 2680, al6061: 2700 };

export function runTubeCalc(inp: TubeCalcInput, profiles: MachineProfile[]): CalcResult {
  const p = parseCommon(inp);
  if ("error" in p) return { error: p.error, warnings: [], summary: [], buy: [], bars: [], unplaced: [] };
  const u = inp.unit;
  const a = lenMm(inp.a, u), b = inp.b.trim() === "" ? a : lenMm(inp.b, u), wall = lenMm(inp.wall, u);
  if (!(a > 0) || !(wall > 0)) return { error: "Enter the tube size and wall thickness.", warnings: [], summary: [], buy: [], bars: [], unplaced: [] };
  const profile = { shape: inp.shape, a, b, wall };
  const { res, plan } = planResult(p, u);
  const prof = profiles.find((x) => x.id === inp.profileId) ?? null;
  const row = prof ? profileRowFor(prof, inp.material, wall) : null;
  const motion = prof ? profileMotionMm(prof) : null;
  const perMinMm = (s: string) => {
    const v = lenMm(s, u);
    return v > 0 ? v : 0;
  };
  const feed = inp.feed.trim() !== "" ? perMinMm(inp.feed) : row?.feedMmPerMin ?? 0;
  const pierce = numOr(inp.pierce, row?.pierceSec ?? 0.5) + (inp.pierce.trim() === "" && motion ? motion.headLiftSec : 0);
  const load = numOr(inp.load, motion ? motion.sheetLoadSec : 45);
  if (prof && !row) res.warnings.push(`${prof.name} has no cut row for this material - enter a feed rate.`);
  else if (row && !row.exact && inp.feed.trim() === "") res.warnings.push(`${prof!.name}: no row for this exact wall - feed estimated from the nearest rows.`);
  const f = (mm: number) => fmtMm(mm, DISPLAY[u]);
  const area = tubeSectionArea(profile);
  const density = DENSITY[inp.material];
  if (density) {
    const kg = (area / 1e6) * (plan.totalStockLength / 1000) * density;
    res.summary.push(["Stock weight", u === "in" || u === "ft" ? `${Math.round(kg * 2.20462)} lb` : `${Math.round(kg)} kg`]);
  }
  res.summary.push(["Cut per end", f(tubeCutLength(profile))]);
  if (feed > 0) {
    const t = tubeTime(plan, { profile, feedMmPerMin: feed, pierceSec: pierce, indexSec: numOr(inp.index, 1.5), barLoadSec: load, partUnloadSec: numOr(inp.unload, 0), piercesPerCut: Math.max(1, Math.floor(numOr(inp.piercesPerCut, 1))), facingCut: p.trim > 0 }, p.features);
    res.summary.push(["Cut time", fmtDuration(t.totalSec)], ["Beam on", fmtDuration(t.cutSec + t.pierceSec)], ["Handling", fmtDuration(t.handlingSec)], ["Cuts", String(t.cuts)]);
    // Per grouped bar: the same model on a one-bar plan.
    const groups = groupBars(plan.bars);
    res.bars = res.bars.map((bv, i) => {
      const one = { ...plan, bars: [groups[i]!.bar] };
      const tb = tubeTime(one, { profile, feedMmPerMin: feed, pierceSec: pierce, indexSec: numOr(inp.index, 1.5), barLoadSec: load, partUnloadSec: numOr(inp.unload, 0), piercesPerCut: Math.max(1, Math.floor(numOr(inp.piercesPerCut, 1))), facingCut: p.trim > 0 }, p.features);
      return { ...bv, time: fmtDuration(tb.totalSec) };
    });
  } else {
    res.warnings.push("No feed rate - pick a machine file or enter the feed to get a cutting time.");
  }
  return res;
}

export function parseBarInput(v: unknown, d: BarCalcInput = defaultBarInput()): BarCalcInput {
  const o = (v && typeof v === "object" ? v : {}) as Record<string, unknown>;
  const s = (x: unknown, fb: string) => (typeof x === "string" ? x.slice(0, 40) : fb);
  const arr = (x: unknown) => (Array.isArray(x) ? x.slice(0, 200) : null);
  const stock = arr(o.stock)?.map((r) => { const q = (r ?? {}) as Record<string, unknown>; return { length: s(q.length, ""), qty: s(q.qty, ""), cost: s(q.cost, "") }; }) ?? d.stock;
  const cuts = arr(o.cuts)?.map((r) => { const q = (r ?? {}) as Record<string, unknown>; return { label: s(q.label, ""), length: s(q.length, ""), qty: s(q.qty, ""), extraCut: s(q.extraCut, ""), extraPierces: s(q.extraPierces, "") }; }) ?? d.cuts;
  return {
    unit: o.unit === "mm" || o.unit === "ft" || o.unit === "m" || o.unit === "in" ? o.unit : d.unit,
    kerf: s(o.kerf, d.kerf),
    trim: s(o.trim, d.trim),
    tail: s(o.tail, d.tail),
    stock,
    cuts,
  };
}

const SHAPES: TubeShape[] = ["round", "square", "rect", "angle", "channel", "flat"];
const MATS: MaterialId[] = ["al5052", "al6061", "ss", "cs", "plastic", "plywood", "stone", "quartz"];

export function parseTubeInput(v: unknown): TubeCalcInput {
  const d = defaultTubeInput();
  const o = (v && typeof v === "object" ? v : {}) as Record<string, unknown>;
  const s = (x: unknown, fb: string) => (typeof x === "string" ? x.slice(0, 40) : fb);
  return {
    ...parseBarInput(v, d),
    shape: SHAPES.includes(o.shape as TubeShape) ? (o.shape as TubeShape) : d.shape,
    a: s(o.a, d.a),
    b: s(o.b, d.b),
    wall: s(o.wall, d.wall),
    material: MATS.includes(o.material as MaterialId) ? (o.material as MaterialId) : d.material,
    feed: s(o.feed, d.feed),
    pierce: s(o.pierce, d.pierce),
    index: s(o.index, d.index),
    load: s(o.load, d.load),
    unload: s(o.unload, d.unload),
    piercesPerCut: s(o.piercesPerCut, d.piercesPerCut),
    profileId: s(o.profileId, d.profileId),
  };
}
