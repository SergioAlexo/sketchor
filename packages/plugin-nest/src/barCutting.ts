/**
 * NT-03: 1D cutting stock - how many bars (tube, pipe, angle, flat bar,
 * extrusion) to buy to cut a list of lengths, and which pieces come from
 * which bar.
 *
 * Every bar loses `trimStart` (the facing cut that squares the end) and
 * `tail` (what the saw vice / tube-laser chuck holds and can never be cut -
 * the drop), and every piece costs its length plus one kerf. Bars are
 * opened one at a time: for each stock length still available, the best
 * fill of the remaining pieces is found (a bounded knapsack on a fine grid,
 * so it is exact to the grid, rounded so a plan never overfills a bar), and
 * the bar with the highest utilisation wins; ties go to the shorter bar.
 * That "best bar first" greedy is run several ways - mixing all lengths,
 * and each stock length on its own (topped up from the others) - each
 * followed by a pass moving every bar onto the shortest stock that still
 * holds its cuts, and the cheapest plan is kept (least left out, then cost
 * when every length has a price, then least stock, then fewest bars).
 * Near-optimal for shop-sized jobs, instant, deterministic.
 *
 * All lengths in mm. Never throws; impossible pieces come back `unplaced`.
 */

export interface BarCutItem {
  label: string;
  length: number;
  qty: number;
}

export interface BarStock {
  length: number;
  /** null = buy as many as needed. */
  qty: number | null;
  /** Price per bar (any currency), optional. */
  cost?: number;
}

export interface BarPlanOptions {
  kerf: number;
  trimStart: number;
  tail: number;
  /** Max pieces to plan (guard). Default 20000. */
  maxPieces?: number;
}

export interface PlannedBar {
  stockLength: number;
  stockIndex: number;
  /** Piece lengths in cutting order (longest first), with labels. */
  cuts: { label: string; length: number }[];
  /** Length used by pieces + kerfs + trim. */
  used: number;
  /** What is left after the last cut (including the tail). */
  remnant: number;
}

export interface BarPlan {
  bars: PlannedBar[];
  /** Per stock length: bars used and cost. */
  byStock: { length: number; stockIndex: number; count: number; cost: number | null }[];
  totalStockLength: number;
  totalPieceLength: number;
  /** Piece length / stock length bought. */
  utilisation: number;
  unplaced: { label: string; length: number; count: number }[];
  pieces: number;
}

interface Piece {
  label: string;
  length: number;
}

/** Best subset of `types` (with counts) whose total cost fits `cap`, on a grid of `res` mm. Returns counts per type. */
function bestFill(types: { cost: number; count: number }[], cap: number, res: number): number[] {
  const C = Math.floor(cap / res + 1e-9);
  const take = types.map(() => 0);
  if (C <= 0) return take;
  // Binary-split bounded knapsack where value = weight (fill the bar as full as possible).
  const items: { type: number; k: number; w: number }[] = [];
  types.forEach((t, ti) => {
    const w = Math.ceil(t.cost / res - 1e-9);
    if (w <= 0 || w > C) return;
    let left = Math.min(t.count, Math.floor(C / w));
    for (let k = 1; left > 0; k *= 2) {
      const kk = Math.min(k, left);
      items.push({ type: ti, k: kk, w: w * kk });
      left -= kk;
    }
  });
  const reach = new Int32Array(C + 1).fill(-1); // item index that first reached this fill
  const prev = new Int32Array(C + 1).fill(-1);
  reach[0] = items.length; // sentinel: reachable
  for (let i = 0; i < items.length; i++) {
    const w = items[i]!.w;
    for (let c = C; c >= w; c--) {
      if (reach[c] === -1 && reach[c - w] !== -1 && reach[c - w] !== i) {
        // reach[c - w] !== i guards against reusing item i in this pass (we iterate c downward, so c - w was set in an earlier pass or not at all).
        reach[c] = i;
        prev[c] = c - w;
      }
    }
  }
  let best = C;
  while (best > 0 && reach[best] === -1) best--;
  for (let c = best; c > 0 && reach[c] !== items.length; c = prev[c]!) {
    const it = items[reach[c]!]!;
    take[it.type]! += it.k;
  }
  return take;
}

export function planBars(items: BarCutItem[], stock: BarStock[], opts: BarPlanOptions): BarPlan {
  const kerf = Math.max(0, opts.kerf || 0);
  const trim = Math.max(0, opts.trimStart || 0);
  const tail = Math.max(0, opts.tail || 0);
  const maxPieces = opts.maxPieces ?? 20000;
  const stocks = stock.map((s, i) => ({ ...s, i })).filter((s) => s.length > 0 && Number.isFinite(s.length));
  const usable = (L: number) => L - trim - tail;
  const longest = stocks.reduce((m, s) => Math.max(m, usable(s.length)), 0);

  // Group identical pieces (same label + length) and drop the ones no bar can hold.
  const groups = new Map<string, { label: string; length: number; count: number }>();
  let total = 0;
  const unplacedMap = new Map<string, { label: string; length: number; count: number }>();
  for (const it of items) {
    const len = Number(it.length), qty = Math.floor(Number(it.qty));
    if (!(len > 0) || !(qty > 0)) continue;
    const q = Math.min(qty, Math.max(0, maxPieces - total));
    if (q <= 0) break;
    total += q;
    const key = `${it.label}|${len}`;
    const target = len + kerf > longest + 1e-9 ? unplacedMap : groups;
    const g = target.get(key);
    if (g) g.count += q;
    else target.set(key, { label: it.label, length: len, count: q });
  }
  const baseTypes = [...groups.values()].sort((a, b) => b.length - a.length);
  type Stock = (typeof stocks)[number];

  /** Opens bars one at a time from `allowed` stock (all when null) until nothing more fits; mutates `types` counts and `left`. */
  const greedy = (types: { label: string; length: number; count: number }[], left: Map<number, number>, allowed: number | null): PlannedBar[] => {
    const out: PlannedBar[] = [];
    let remaining = types.reduce((n, t) => n + t.count, 0);
    while (remaining > 0) {
      let pick: { s: Stock; take: number[]; fill: number } | null = null;
      for (const s of stocks) {
        if ((allowed !== null && s.i !== allowed) || (left.get(s.i) ?? 0) <= 0) continue;
        const cap = usable(s.length);
        if (cap <= 0) continue;
        const res = Math.max(0.1, cap / 20000);
        const take = bestFill(types.map((t) => ({ cost: t.length + kerf, count: t.count })), cap, res);
        const fill = take.reduce((n, k, ti) => n + k * types[ti]!.length, 0);
        if (fill <= 0) continue;
        const u = fill / s.length;
        const pu = pick ? pick.fill / pick.s.length : -1;
        if (!pick || u > pu + 1e-9 || (Math.abs(u - pu) <= 1e-9 && s.length < pick.s.length)) pick = { s, take, fill };
      }
      if (!pick) break;
      const cuts: Piece[] = [];
      pick.take.forEach((k, ti) => {
        const t = types[ti]!;
        for (let j = 0; j < k; j++) cuts.push({ label: t.label, length: t.length });
        t.count -= k;
        remaining -= k;
      });
      cuts.sort((a, b) => b.length - a.length);
      const used = trim + cuts.reduce((n, c) => n + c.length + kerf, 0);
      out.push({ stockLength: pick.s.length, stockIndex: pick.s.i, cuts, used, remnant: Math.max(0, pick.s.length - used) });
      left.set(pick.s.i, (left.get(pick.s.i) ?? 0) - 1);
    }
    return out;
  };

  const allCosted = stocks.length > 0 && stocks.every((s) => s.cost !== undefined);
  /** Cheaper to buy: lower price when every length has one, else shorter. */
  const cheaper = (a: Stock, b: Stock) => (allCosted ? a.cost! < b.cost! - 1e-9 : a.length < b.length);
  /** Moves each bar onto the cheapest stock that still holds its cuts (the last bar of a plan is often mostly empty). */
  const downsize = (bars: PlannedBar[], left: Map<number, number>) => {
    for (const b of bars) {
      const cur = stocks.find((s) => s.i === b.stockIndex)!;
      const fits = stocks.filter((s) => cheaper(s, cur) && (left.get(s.i) ?? 0) > 0 && b.used + tail <= s.length + 1e-9).sort((x, y) => (cheaper(x, y) ? -1 : cheaper(y, x) ? 1 : 0))[0];
      if (!fits) continue;
      left.set(b.stockIndex, (left.get(b.stockIndex) ?? 0) + 1);
      left.set(fits.i, (left.get(fits.i) ?? 0) - 1);
      b.stockIndex = fits.i;
      b.stockLength = fits.length;
      b.remnant = Math.max(0, fits.length - b.used);
    }
  };

  // Several strategies (mixed lengths, then each length on its own topped up with the rest), keep the cheapest:
  // fewest pieces left out, then lowest cost when every bar has a price, then least stock length, then fewest bars.
  let best: { bars: PlannedBar[]; types: typeof baseTypes; score: number[] } | null = null;
  for (const strat of [null, ...stocks.map((s) => s.i)]) {
    const types = baseTypes.map((t) => ({ ...t }));
    const left = new Map<number, number>(stocks.map((s) => [s.i, s.qty ?? Infinity]));
    const bars = greedy(types, left, strat);
    if (strat !== null && types.some((t) => t.count > 0)) bars.push(...greedy(types, left, null));
    downsize(bars, left);
    const unplacedN = types.reduce((n, t) => n + t.count, 0);
    const cost = allCosted ? bars.reduce((n, b) => n + (stocks.find((x) => x.i === b.stockIndex)!.cost ?? 0), 0) : 0;
    const score = [unplacedN, cost, bars.reduce((n, b) => n + b.stockLength, 0), bars.length];
    const better = !best || score.some((v, i) => score.slice(0, i).every((w, j) => Math.abs(w - best!.score[j]!) < 1e-9) && v < best!.score[i]! - 1e-9);
    if (better) best = { bars, types, score };
  }
  const bars = best ? best.bars : [];
  for (const t of best ? best.types : baseTypes) {
    if (t.count <= 0) continue;
    const key = `${t.label}|${t.length}`;
    const g = unplacedMap.get(key);
    if (g) g.count += t.count;
    else unplacedMap.set(key, { label: t.label, length: t.length, count: t.count });
  }

  const byStockMap = new Map<number, { length: number; stockIndex: number; count: number; cost: number | null }>();
  for (const b of bars) {
    const s = stocks.find((x) => x.i === b.stockIndex)!;
    const e = byStockMap.get(b.stockIndex) ?? { length: b.stockLength, stockIndex: b.stockIndex, count: 0, cost: s.cost !== undefined ? 0 : null };
    e.count += 1;
    if (e.cost !== null && s.cost !== undefined) e.cost += s.cost;
    byStockMap.set(b.stockIndex, e);
  }
  const totalStockLength = bars.reduce((n, b) => n + b.stockLength, 0);
  const totalPieceLength = bars.reduce((n, b) => n + b.cuts.reduce((m, c) => m + c.length, 0), 0);
  return {
    bars,
    byStock: [...byStockMap.values()].sort((a, b) => a.stockIndex - b.stockIndex),
    totalStockLength,
    totalPieceLength,
    utilisation: totalStockLength > 0 ? totalPieceLength / totalStockLength : 0,
    unplaced: [...unplacedMap.values()],
    pieces: bars.reduce((n, b) => n + b.cuts.length, 0),
  };
}

/** Groups identical bars (same stock and same cuts) for a compact cut list: "3 x 6000: 1200, 1200, 800...". */
export function groupBars(bars: PlannedBar[]): { count: number; bar: PlannedBar }[] {
  const out: { key: string; count: number; bar: PlannedBar }[] = [];
  for (const b of bars) {
    const key = `${b.stockIndex}|${b.cuts.map((c) => `${c.label}:${c.length}`).join(",")}`;
    const g = out.find((x) => x.key === key);
    if (g) g.count += 1;
    else out.push({ key, count: 1, bar: b });
  }
  return out.map(({ count, bar }) => ({ count, bar }));
}

// ---------- tube laser time (NT-04) ----------

export type TubeShape = "round" | "square" | "rect" | "angle" | "channel" | "flat";

export interface TubeProfile {
  shape: TubeShape;
  /** Outside diameter (round) or width (others), mm. */
  a: number;
  /** Height (rect, channel, angle leg 2), mm; ignored for round/square. */
  b?: number;
  /** Wall thickness, mm. */
  wall: number;
}

/** The length the head travels for one square cut through the profile, mm (outside perimeter; open sections cut their developed width). */
export function tubeCutLength(p: TubeProfile): number {
  const a = Math.max(0, p.a), b = Math.max(0, p.b ?? p.a);
  switch (p.shape) {
    case "round": return Math.PI * a;
    case "square": return 4 * a;
    case "rect": return 2 * (a + b);
    case "angle": return a + b;
    case "channel": return a + 2 * b;
    case "flat": return a;
  }
}

/** Steel-ish cross-section area, mm² (for weight). */
export function tubeSectionArea(p: TubeProfile): number {
  const a = Math.max(0, p.a), b = Math.max(0, p.b ?? p.a), t = Math.min(Math.max(0, p.wall), Math.min(a, b) / 2);
  switch (p.shape) {
    case "round": return (Math.PI / 4) * (a * a - (a - 2 * t) * (a - 2 * t));
    case "square": return a * a - (a - 2 * t) * (a - 2 * t);
    case "rect": return a * b - (a - 2 * t) * (b - 2 * t);
    case "angle": return t * (a + b - t);
    case "channel": return t * (a + 2 * b - 2 * t);
    case "flat": return a * Math.max(0, p.wall);
  }
}

export interface TubeTimeInput {
  profile: TubeProfile;
  /** mm/min through the wall. */
  feedMmPerMin: number;
  pierceSec: number;
  /** Rotate/index + head move between cuts, s. */
  indexSec: number;
  /** Load a bar into the chuck, s. */
  barLoadSec: number;
  /** Unload each finished part, s. */
  partUnloadSec: number;
  /** Pierces per end cut (round 1; a square/rect is often cut face by face = 4). */
  piercesPerCut: number;
  /** Each bar gets a squaring cut before the first piece (true when the plan has a trim). */
  facingCut: boolean;
}

export interface TubeTime {
  totalSec: number;
  cutSec: number;
  pierceSec: number;
  handlingSec: number;
  cuts: number;
  cutLength: number;
}

/**
 * Tube-laser time for a bar plan: per bar one load and one facing cut, per
 * piece one separating cut (profile perimeter at the feed, `piercesPerCut`
 * pierces, one index) plus its own extra features (cut length + pierces),
 * and a part unload.
 */
export function tubeTime(plan: BarPlan, inp: TubeTimeInput, features: Map<string, { cutLength: number; pierces: number }> = new Map()): TubeTime {
  const per = tubeCutLength(inp.profile);
  const feed = inp.feedMmPerMin > 0 ? inp.feedMmPerMin / 60 : 0;
  let cuts = 0, cutLength = 0, pierces = 0, handling = 0;
  for (const bar of plan.bars) {
    handling += inp.barLoadSec;
    const ends = bar.cuts.length + (inp.facingCut ? 1 : 0);
    cuts += ends;
    cutLength += ends * per;
    pierces += ends * Math.max(1, inp.piercesPerCut);
    handling += ends * inp.indexSec;
    for (const c of bar.cuts) {
      handling += inp.partUnloadSec;
      const f = features.get(c.label);
      if (f) {
        cutLength += f.cutLength;
        pierces += f.pierces;
        handling += f.pierces * inp.indexSec;
      }
    }
  }
  const cutSec = feed > 0 ? cutLength / feed : 0;
  const pierceSec = pierces * Math.max(0, inp.pierceSec);
  return { totalSec: cutSec + pierceSec + handling, cutSec, pierceSec, handlingSec: handling, cuts, cutLength };
}
