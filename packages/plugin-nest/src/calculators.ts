/**
 * NT-03 / NT-04: the Bars and Tubes calculators behind the Sheet Nesting
 * panel. The panel sends what was typed (strings, any length format the
 * nesting fields take: 20', 240", 6 1/2, 6000 mm); these turn it into a bar
 * plan and a ready-to-render result with every length already formatted.
 * Pure, never throw: a bad row is reported, not fatal.
 */
import { tubeCutLength, tubeSectionArea, type BarCutItem, type BarStock, type TubeProfile, type TubeShape } from "./barCutting";
import { groupMiterBars, layPieces, miterCutLength, miterDepth, planMiterBars, type MiterBar, type MiterPlan } from "./miterNest";
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
  /** `a1` / `a2`: mitre angle at each end, degrees from square (tubes). */
  cuts: { label: string; length: string; qty: string; extraCut?: string; extraPierces?: string; a1?: string; a2?: string }[];
  /** Saw: seconds per cut and per bar loaded, for the time estimate (bars). */
  cutSec?: string;
  loadSec?: string;
  /** NT-06: the bars as arranged by hand; absent = plan them automatically. */
  manual?: ManualBars;
}

/** One bar pattern arranged by hand: cut `count` bars of `stock` mm, the pieces in this order and orientation. */
export interface ManualBarPattern {
  count: number;
  stock: number;
  pieces: { label: string; length: number; flipped: boolean; upsideDown: boolean }[];
}

export interface ManualBars {
  patterns: ManualBarPattern[];
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
  /** The face the mitres run across: "b" = height (default), "a" = width. */
  across: "a" | "b";
  /** Let the plan turn pieces end for end / upside down so mitres share cuts. */
  turn: boolean;
}

/** One bar as drawn in the preview / report: lengths in mm, pieces in the side view (x along the bar, depth up). */
export interface BarDrawing {
  stock: number;
  depth: number;
  trim: number;
  tail: number;
  used: number;
  pieces: { label: string; length: number; l0: number; l1: number; r0: number; r1: number; turned: string; flipped?: boolean; upsideDown?: boolean }[];
}

export interface CalcResult {
  error?: string;
  warnings: string[];
  summary: [string, string][];
  buy: { length: string; count: number; cost: string }[];
  bars: { count: number; stock: string; cuts: string; remnant: string; time?: string; draw?: BarDrawing; over?: string }[];
  unplaced: string[];
  /** The bar patterns of this result (mm) - what the panel starts from when the user rearranges pieces. */
  patterns?: ManualBars;
  /** Pieces ordered but on no bar (the tray), and pieces on bars beyond what was ordered. */
  toCut?: { label: string; length: number; text: string; count: number }[];
  extra?: string[];
  /** The layout was arranged by hand. */
  manual?: boolean;
  /** Stock lengths (mm) with their display text, for adding a bar by hand. */
  stockMm?: { length: number; text: string }[];
  /** Every label in first-seen order, so the preview gives each its own colour. */
  labels?: string[];
  /** Report header lines (label, value), already formatted. */
  details?: [string, string][];
  mitred?: boolean;
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
    cutSec: "",
    loadSec: "",
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
    across: "b",
    turn: true,
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
  items: (BarCutItem & { a1?: number; a2?: number })[];
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
    const ang = (v: string | undefined) => {
      const n = v === undefined || v.trim() === "" ? 0 : Number(v.replace(/°/g, "").trim());
      if (!Number.isFinite(n) || Math.abs(n) >= 80) {
        warnings.push(`Cut row ${i + 1}: angle "${v}" - use degrees from square, under 80 (0 = square).`);
        return 0;
      }
      return n;
    };
    const a1 = ang(c.a1), a2 = ang(c.a2);
    items.push({ label, length: L, qty: q, ...(a1 ? { a1 } : {}), ...(a2 ? { a2 } : {}) });
    const extra = c.extraCut && c.extraCut.trim() !== "" ? lenMm(c.extraCut, u) : 0;
    const ep = numOr(c.extraPierces, 0);
    if ((extra > 0 || ep > 0) && !features.has(label)) features.set(label, { cutLength: extra > 0 ? extra : 0, pierces: Math.floor(ep) });
  });
  if (items.length === 0) return { error: "Add the lengths you need to cut." };
  return { items, stock, kerf, trim, tail, warnings, features };
}

const money = (v: number | null) => (v === null ? "" : (Math.round(v * 100) / 100).toFixed(2));

const turnText = (flipped: boolean, upsideDown: boolean) => [flipped ? "end for end" : "", upsideDown ? "upside down" : ""].filter(Boolean).join(", ");

const sameLen = (a: number, b: number) => Math.abs(a - b) < 1e-6;

/**
 * NT-06: the bars exactly as the user arranged them - each pattern's pieces
 * laid in their order and orientation (`layPieces`), counted `count` times.
 * Pieces whose cut row is gone are dropped (warned); what was ordered but is
 * on no bar is left to cut (the tray); a bar the pieces overrun is flagged.
 */
function manualPlan(p: Parsed, manual: ManualBars, depth: number, warnings: string[]): { plan: MiterPlan; groups: { count: number; bar: MiterBar }[]; over: Map<MiterBar, number> } {
  const groups: { count: number; bar: MiterBar }[] = [];
  const over = new Map<MiterBar, number>();
  let dropped = 0;
  for (const pat of manual.patterns) {
    const count = Math.max(1, Math.floor(pat.count));
    const list = pat.pieces.flatMap((pc) => {
      const it = p.items.find((x) => x.label === pc.label && sameLen(x.length, pc.length));
      if (!it) {
        dropped++;
        return [];
      }
      return [{ label: it.label, length: it.length, a1: it.a1 ?? 0, a2: it.a2 ?? 0, flipped: !!pc.flipped, upsideDown: !!pc.upsideDown }];
    });
    const laid = layPieces(list, { kerf: p.kerf, trimStart: p.trim, depth });
    let stockIndex = p.stock.findIndex((st) => sameLen(st.length, pat.stock));
    if (stockIndex < 0) {
      warnings.push(`A bar of ${Math.round(pat.stock)} mm is no longer in the stock list - its cost is not counted.`);
      stockIndex = -1;
    }
    const bar: MiterBar = {
      stockLength: pat.stock,
      stockIndex,
      cuts: laid.pieces.map((x) => ({ label: x.label, length: x.length })),
      used: laid.used,
      remnant: Math.max(0, pat.stock - laid.used),
      pieces: laid.pieces,
      cutAngles: laid.cutAngles,
    };
    const overBy = laid.used + p.tail - pat.stock;
    if (overBy > 1e-6) over.set(bar, overBy);
    groups.push({ count, bar });
  }
  if (dropped > 0) warnings.push(`${dropped} piece(s) on the bars no longer match a row in the cut list (label or length changed) and were taken off.`);
  const bars = groups.flatMap((g) => Array.from({ length: g.count }, () => g.bar));
  const placed = new Map<string, number>();
  for (const b of bars) for (const c of b.cuts) placed.set(`${c.label}|${c.length}`, (placed.get(`${c.label}|${c.length}`) ?? 0) + 1);
  const unplaced = p.items.map((it) => ({ label: it.label, length: it.length, count: Math.max(0, it.qty - (placed.get(`${it.label}|${it.length}`) ?? 0)) })).filter((u) => u.count > 0);
  const byStockMap = new Map<number, { length: number; stockIndex: number; count: number; cost: number | null }>();
  for (const b of bars) {
    const st = b.stockIndex >= 0 ? p.stock[b.stockIndex] : undefined;
    const key = b.stockIndex >= 0 ? b.stockIndex : -1 - Math.round(b.stockLength);
    const e = byStockMap.get(key) ?? { length: b.stockLength, stockIndex: b.stockIndex, count: 0, cost: st?.cost !== undefined ? 0 : null };
    e.count += 1;
    if (e.cost !== null && st?.cost !== undefined) e.cost += st.cost;
    byStockMap.set(key, e);
  }
  for (const e of byStockMap.values()) {
    const st = e.stockIndex >= 0 ? p.stock[e.stockIndex] : undefined;
    if (st && st.qty !== null && e.count > st.qty) warnings.push(`The bars use ${e.count} of the ${Math.round(e.length)} mm length but only ${st.qty} are on hand.`);
  }
  const totalStockLength = bars.reduce((n, b) => n + b.stockLength, 0);
  const totalPieceLength = bars.reduce((n, b) => n + b.cuts.reduce((m, c) => m + c.length, 0), 0);
  return {
    plan: {
      bars,
      byStock: [...byStockMap.values()],
      totalStockLength,
      totalPieceLength,
      utilisation: totalStockLength > 0 ? totalPieceLength / totalStockLength : 0,
      unplaced,
      pieces: bars.reduce((n, b) => n + b.cuts.length, 0),
      mitred: depth > 0 && p.items.some((it) => !!it.a1 || !!it.a2),
    },
    groups,
    over,
  };
}

function planResult(p: Parsed, unit: CalcUnit, miter?: { depth: number; turn: boolean }, manual?: ManualBars): { res: CalcResult; plan: MiterPlan; groups: { count: number; bar: MiterBar }[] } {
  const f = (mm: number) => fmtMm(mm, DISPLAY[unit]);
  const extraWarn: string[] = [];
  const m = manual && manual.patterns.length > 0 ? manualPlan(p, manual, miter?.depth ?? 0, extraWarn) : null;
  const plan = m ? m.plan : planMiterBars(p.items, p.stock, { kerf: p.kerf, trimStart: p.trim, tail: p.tail, depth: miter?.depth ?? 0, allowTurn: miter?.turn ?? true });
  const totalCost = plan.byStock.every((b) => b.cost !== null) && plan.byStock.length > 0 ? plan.byStock.reduce((n, b) => n + (b.cost ?? 0), 0) : null;
  const need = p.items.reduce((n, it) => n + it.qty, 0);
  const groups = m ? m.groups : groupMiterBars(plan.bars);
  const angleOf = (label: string) => p.items.find((it) => it.label === label);
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
    bars: groups.map(({ count, bar }) => {
      const runs: string[] = [];
      let i = 0;
      const ps = bar.pieces;
      const same = (x: (typeof ps)[number], y: (typeof ps)[number]) => x.label === y.label && x.length === y.length && x.flipped === y.flipped && x.upsideDown === y.upsideDown;
      while (i < ps.length) {
        let j = i;
        while (j < ps.length && same(ps[j]!, ps[i]!)) j++;
        const it = angleOf(ps[i]!.label);
        const ang = it && (it.a1 || it.a2) ? ` ${it.a1 ?? 0}°/${it.a2 ?? 0}°` : "";
        const turned = turnText(ps[i]!.flipped, ps[i]!.upsideDown);
        runs.push(`${j - i > 1 ? `${j - i} × ` : ""}${f(ps[i]!.length)} (${ps[i]!.label}${ang}${turned ? `, ${turned}` : ""})`);
        i = j;
      }
      const overBy = m?.over.get(bar);
      return {
        count,
        stock: f(bar.stockLength),
        cuts: runs.join(", "),
        remnant: overBy ? "none" : f(bar.remnant),
        ...(overBy ? { over: f(overBy) } : {}),
        draw: {
          stock: bar.stockLength,
          depth: miter?.depth ?? 0,
          trim: p.trim,
          tail: p.tail,
          used: bar.used,
          pieces: bar.pieces.map((pc) => ({ label: pc.label, length: pc.length, l0: pc.shape.l0, l1: pc.shape.l1, r0: pc.shape.r0, r1: pc.shape.r1, turned: turnText(pc.flipped, pc.upsideDown), flipped: pc.flipped, upsideDown: pc.upsideDown })),
        },
      };
    }),
    unplaced: plan.unplaced.map((u) => `${u.label} ${f(u.length)} × ${u.count}`),
    patterns: { patterns: groups.map(({ count, bar }) => ({ count, stock: bar.stockLength, pieces: bar.pieces.map((pc) => ({ label: pc.label, length: pc.length, flipped: pc.flipped, upsideDown: pc.upsideDown })) })) },
    toCut: plan.unplaced.map((u) => ({ label: u.label, length: u.length, text: `${u.label} ${f(u.length)}`, count: u.count })),
    extra: (() => {
      const placed = new Map<string, number>();
      for (const b of plan.bars) for (const c of b.cuts) placed.set(`${c.label}|${c.length}`, (placed.get(`${c.label}|${c.length}`) ?? 0) + 1);
      return p.items.flatMap((it) => {
        const n = (placed.get(`${it.label}|${it.length}`) ?? 0) - it.qty;
        return n > 0 ? [`${it.label} ${f(it.length)} +${n}`] : [];
      });
    })(),
    manual: !!m,
    stockMm: p.stock.map((st) => ({ length: st.length, text: f(st.length) })),
    labels: [...new Set(p.items.map((it) => it.label))],
    mitred: plan.mitred,
    details: [
      ["Kerf", f(p.kerf)],
      ["End trim", f(p.trim)],
      ["Tail (drop)", f(p.tail)],
      ["Stock", p.stock.map((s) => `${f(s.length)}${s.qty !== null ? ` (${s.qty} on hand)` : ""}`).join(", ")],
    ],
  };
  res.warnings.push(...extraWarn);
  if (m) {
    const overN = [...m.over.values()].length;
    if (overN > 0) res.warnings.push(`${overN} bar pattern(s) are too long for their bar - flagged red. Move a piece off, or put it on a longer bar.`);
    if (plan.unplaced.length > 0) res.warnings.push("Some pieces are not on any bar yet - drag them from the To cut tray onto a bar.");
  } else if (plan.unplaced.length > 0) res.warnings.push("Some pieces did not fit: longer than every bar (after trim and tail), or the stock you have ran out.");
  return { res, plan, groups };
}

export function runBarCalc(inp: BarCalcInput): CalcResult {
  const p = parseCommon(inp);
  if ("error" in p) return { error: p.error, warnings: [], summary: [], buy: [], bars: [], unplaced: [] };
  const { res, plan, groups } = planResult(p, inp.unit, undefined, inp.manual);
  // Saw time: seconds per cut and per bar loaded (blank = no estimate).
  const cutSec = numOr(inp.cutSec, NaN), loadSec = numOr(inp.loadSec, 0);
  if (Number.isFinite(cutSec)) {
    const barSec = (b: MiterBar) => loadSec + b.cutAngles.length * cutSec;
    res.summary.push(["Saw time", fmtDuration(plan.bars.reduce((n, b) => n + barSec(b), 0))], ["Cuts", String(plan.bars.reduce((n, b) => n + b.cutAngles.length, 0))]);
    res.bars = res.bars.map((bv, i) => ({ ...bv, time: fmtDuration(barSec(groups[i]!.bar)) }));
    res.details!.push(["Saw time per cut", `${cutSec} s, load ${loadSec} s per bar`]);
  }
  return res;
}

const DENSITY: Partial<Record<MaterialId, number>> = { cs: 7850, ss: 8000, al5052: 2680, al6061: 2700 };

export function runTubeCalc(inp: TubeCalcInput, profiles: MachineProfile[]): CalcResult {
  const p = parseCommon(inp);
  if ("error" in p) return { error: p.error, warnings: [], summary: [], buy: [], bars: [], unplaced: [] };
  const u = inp.unit;
  const a = lenMm(inp.a, u), b = inp.b.trim() === "" ? a : lenMm(inp.b, u), wall = lenMm(inp.wall, u);
  if (!(a > 0) || !(wall > 0)) return { error: "Enter the tube size and wall thickness.", warnings: [], summary: [], buy: [], bars: [], unplaced: [] };
  const profile: TubeProfile = { shape: inp.shape, a, b, wall };
  const across = inp.across === "a" ? "a" : "b";
  const { res, plan, groups } = planResult(p, u, { depth: miterDepth(profile, across), turn: inp.turn !== false }, inp.manual);
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
  const shapeName: Record<TubeShape, string> = { round: "Round tube", square: "Square tube", rect: "Rectangular tube", angle: "Angle", channel: "Channel", flat: "Flat bar" };
  res.details!.unshift(["Profile", `${shapeName[inp.shape]} ${f(a)}${inp.shape === "rect" || inp.shape === "angle" || inp.shape === "channel" ? ` × ${f(b)}` : ""}, wall ${f(wall)}`]);
  if (plan.mitred) res.details!.push(["Mitres", `across the ${across === "a" ? "width" : "height"} (${f(miterDepth(profile, across))}); pieces ${inp.turn !== false ? "may be turned end for end / upside down to share cuts" : "kept as drawn"}`]);
  if (feed > 0) {
    const tm = { feedMmPerMin: feed, pierceSec: pierce, indexSec: numOr(inp.index, 1.5), barLoadSec: load, partUnloadSec: numOr(inp.unload, 0), piercesPerCut: Math.max(1, Math.floor(numOr(inp.piercesPerCut, 1))) };
    const t = miterTubeTime(plan.bars, profile, across, tm, p.features);
    res.summary.push(["Cut time", fmtDuration(t.totalSec)], ["Beam on", fmtDuration(t.cutSec + t.pierceSec)], ["Handling", fmtDuration(t.handlingSec)], ["Cuts", String(t.cuts)]);
    res.bars = res.bars.map((bv, i) => ({ ...bv, time: fmtDuration(miterTubeTime([groups[i]!.bar], profile, across, tm, p.features).totalSec) }));
    res.details!.push(["Tube laser", `feed ${f(feed)}/min, pierce ${Math.round(pierce * 100) / 100} s, index ${tm.indexSec} s, load ${tm.barLoadSec} s, unload ${tm.partUnloadSec} s${prof ? ` (${prof.name})` : ""}`]);
  } else {
    res.warnings.push("No feed rate - pick a machine file or enter the feed to get a cutting time.");
  }
  return res;
}

/**
 * Tube-laser time for bars with mitred ends: per bar one load; per cut
 * (`cutAngles` - shared cuts counted once) the profile's cut length at that
 * angle at the feed, the pierces and one index; per piece its extra features
 * and an unload. Square ends give the same time as `tubeTime`.
 */
export function miterTubeTime(
  bars: readonly MiterBar[],
  profile: TubeProfile,
  across: "a" | "b",
  inp: { feedMmPerMin: number; pierceSec: number; indexSec: number; barLoadSec: number; partUnloadSec: number; piercesPerCut: number },
  features: Map<string, { cutLength: number; pierces: number }> = new Map(),
): { totalSec: number; cutSec: number; pierceSec: number; handlingSec: number; cuts: number; cutLength: number } {
  const feed = inp.feedMmPerMin > 0 ? inp.feedMmPerMin / 60 : 0;
  let cuts = 0, cutLength = 0, pierces = 0, handling = 0;
  for (const bar of bars) {
    handling += inp.barLoadSec;
    for (const a of bar.cutAngles) {
      cuts++;
      cutLength += miterCutLength(profile, a, across);
      pierces += Math.max(1, inp.piercesPerCut);
      handling += inp.indexSec;
    }
    for (const c of bar.cuts) {
      handling += inp.partUnloadSec;
      const ft = features.get(c.label);
      if (ft) {
        cutLength += ft.cutLength;
        pierces += ft.pierces;
        handling += ft.pierces * inp.indexSec;
      }
    }
  }
  const cutSec = feed > 0 ? cutLength / feed : 0;
  const pierceSec = pierces * Math.max(0, inp.pierceSec);
  return { totalSec: cutSec + pierceSec + handling, cutSec, pierceSec, handlingSec: handling, cuts, cutLength };
}

/** A hand-arranged layout from the panel or storage: untrusted, so every number is checked and the size capped. */
export function parseManualBars(v: unknown): ManualBars | undefined {
  if (!v || typeof v !== "object" || !Array.isArray((v as { patterns?: unknown }).patterns)) return undefined;
  const patterns: ManualBarPattern[] = [];
  for (const raw of (v as { patterns: unknown[] }).patterns.slice(0, 500)) {
    if (!raw || typeof raw !== "object") continue;
    const r = raw as Record<string, unknown>;
    const stock = Number(r.stock), count = Math.floor(Number(r.count));
    if (!(stock > 0) || !Number.isFinite(stock) || !(count >= 1)) continue;
    const pieces = (Array.isArray(r.pieces) ? r.pieces.slice(0, 1000) : []).flatMap((q) => {
      if (!q || typeof q !== "object") return [];
      const x = q as Record<string, unknown>;
      const length = Number(x.length);
      return typeof x.label === "string" && length > 0 && Number.isFinite(length) ? [{ label: x.label.slice(0, 40), length, flipped: x.flipped === true, upsideDown: x.upsideDown === true }] : [];
    });
    patterns.push({ count: Math.min(count, 100000), stock, pieces });
  }
  return { patterns };
}

export function parseBarInput(v: unknown, d: BarCalcInput = defaultBarInput()): BarCalcInput {
  const o = (v && typeof v === "object" ? v : {}) as Record<string, unknown>;
  const s = (x: unknown, fb: string) => (typeof x === "string" ? x.slice(0, 40) : fb);
  const arr = (x: unknown) => (Array.isArray(x) ? x.slice(0, 200) : null);
  const stock = arr(o.stock)?.map((r) => { const q = (r ?? {}) as Record<string, unknown>; return { length: s(q.length, ""), qty: s(q.qty, ""), cost: s(q.cost, "") }; }) ?? d.stock;
  const cuts = arr(o.cuts)?.map((r) => { const q = (r ?? {}) as Record<string, unknown>; return { label: s(q.label, ""), length: s(q.length, ""), qty: s(q.qty, ""), extraCut: s(q.extraCut, ""), extraPierces: s(q.extraPierces, ""), a1: s(q.a1, ""), a2: s(q.a2, "") }; }) ?? d.cuts;
  return {
    unit: o.unit === "mm" || o.unit === "ft" || o.unit === "m" || o.unit === "in" ? o.unit : d.unit,
    kerf: s(o.kerf, d.kerf),
    trim: s(o.trim, d.trim),
    tail: s(o.tail, d.tail),
    stock,
    cuts,
    cutSec: s(o.cutSec, d.cutSec ?? ""),
    loadSec: s(o.loadSec, d.loadSec ?? ""),
    ...(parseManualBars(o.manual) ? { manual: parseManualBars(o.manual)! } : {}),
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
    across: o.across === "a" ? "a" : "b",
    turn: o.turn !== false,
  };
}
