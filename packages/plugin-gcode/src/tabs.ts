import { curveLength, subCurve, type Curve } from "@sketchor/core";

/**
 * Micro-joints / tabs (N-53) - small uncut bridges that keep a part attached
 * to the skeleton so it cannot tip or shift while the last of its profile is
 * cut. Pure planning only: where the tabs go along a closed contour and how
 * the contour splits into cut runs and bridged spans. The toolpath builder /
 * writer decides what to do with the runs (they replace the single closed
 * loop; a tab span is simply never cut).
 *
 * Positions are arc length along the loop from its start. A tab that would
 * straddle the start is split in two ranges so every range stays inside
 * [0, perimeter].
 */

export interface TabOptions {
  /** Wanted number of tabs, spread evenly. 0 (or fewer) = no tabs. */
  count: number;
  /** Width of each uncut bridge, in the loop's units (mm). */
  width: number;
  /** Arc length of the first tab's centre. Default: half a spacing, so no tab straddles the start. */
  offset?: number;
}

export interface TabRange {
  /** Index of the tab this range belongs to (a wrapped tab has two ranges). */
  tab: number;
  start: number;
  end: number;
}

export interface TabPlan {
  perimeter: number;
  /** Tabs actually placed (may be fewer than asked). */
  count: number;
  /** Uncut ranges, ascending, non-overlapping, inside [0, perimeter]. */
  tabs: TabRange[];
  warnings: string[];
}

const EPS = 1e-9;

/** Length of a closed loop. */
export function loopLength(loop: readonly Curve[]): number {
  let l = 0;
  for (const c of loop) l += curveLength(c);
  return l;
}

/**
 * Plans tab ranges for a closed loop of the given `perimeter`. Never throws:
 * impossible requests degrade to fewer tabs or none, with a warning. A cut
 * run between two tabs is always at least one tab width long, so the count
 * is capped at floor(perimeter / (2 * width)).
 */
export function planTabs(perimeter: number, opts: TabOptions): TabPlan {
  const warnings: string[] = [];
  const none = (): TabPlan => ({ perimeter, count: 0, tabs: [], warnings });
  const { width } = opts;
  if (!Number.isFinite(perimeter) || perimeter <= EPS) {
    warnings.push("contour has no length; no tabs");
    return none();
  }
  const want = Number.isFinite(opts.count) ? Math.floor(opts.count) : 0;
  if (want <= 0) return none();
  if (!Number.isFinite(width) || width <= 0) {
    warnings.push("tab width must be positive; no tabs");
    return none();
  }
  if (width >= perimeter) {
    warnings.push(`tab width ${width} is not smaller than the contour (${perimeter.toFixed(3)}); no tabs, the part is cut free`);
    return none();
  }
  const fit = Math.floor(perimeter / (2 * width));
  if (fit < 1) {
    warnings.push(`contour (${perimeter.toFixed(3)}) is too small for a ${width} tab plus an equal cut; no tabs`);
    return none();
  }
  const count = Math.min(want, fit);
  if (count < want) warnings.push(`only ${count} of ${want} tabs fit on this contour`);
  const spacing = perimeter / count;
  const first = opts.offset !== undefined && Number.isFinite(opts.offset) ? opts.offset : spacing / 2;
  const tabs: TabRange[] = [];
  for (let i = 0; i < count; i++) {
    const centre = (((first + i * spacing) % perimeter) + perimeter) % perimeter;
    const s = centre - width / 2;
    const e = centre + width / 2;
    if (s < 0) {
      tabs.push({ tab: i, start: 0, end: e });
      tabs.push({ tab: i, start: perimeter + s, end: perimeter });
    } else if (e > perimeter) {
      tabs.push({ tab: i, start: s, end: perimeter });
      tabs.push({ tab: i, start: 0, end: e - perimeter });
    } else tabs.push({ tab: i, start: s, end: e });
  }
  tabs.sort((a, b) => a.start - b.start);
  return { perimeter, count, tabs, warnings };
}

/** The curves covering arc length [a, b] of `loop`. */
export function sliceLoop(loop: readonly Curve[], a: number, b: number): Curve[] {
  const out: Curve[] = [];
  let at = 0;
  for (const c of loop) {
    const len = curveLength(c);
    const lo = Math.max(a, at);
    const hi = Math.min(b, at + len);
    if (hi - lo > EPS && len > EPS) {
      const t0 = (lo - at) / len;
      const t1 = (hi - at) / len;
      out.push(t0 <= EPS && t1 >= 1 - EPS ? c : subCurve(c, t0, t1));
    }
    at += len;
  }
  return out;
}

export interface TabSplit {
  plan: TabPlan;
  /** Runs to cut, in loop order. With no tabs: the whole loop, as one run, `closed` true. */
  runs: Curve[][];
  /** The bridged (uncut) spans, same order as `plan.tabs`. */
  bridges: Curve[][];
  /** True when `runs[0]` is the untouched closed loop. */
  closed: boolean;
}

/** Splits a closed loop at the planned tabs. An empty/zero-length loop yields no runs. */
export function splitLoopAtTabs(loop: readonly Curve[], opts: TabOptions): TabSplit {
  const perimeter = loopLength(loop);
  const plan = planTabs(perimeter, opts);
  if (loop.length === 0 || perimeter <= EPS) return { plan, runs: [], bridges: [], closed: false };
  if (plan.tabs.length === 0) return { plan, runs: [loop.slice()], bridges: [], closed: true };
  const runs: Curve[][] = [];
  let cursor = 0;
  for (const t of plan.tabs) {
    if (t.start - cursor > EPS) runs.push(sliceLoop(loop, cursor, t.start));
    cursor = Math.max(cursor, t.end);
  }
  if (perimeter - cursor > EPS) runs.push(sliceLoop(loop, cursor, perimeter));
  // The last run and the first meet at the loop start when no tab covers it: one continuous cut.
  const firstTab = plan.tabs[0]!;
  const lastTab = plan.tabs[plan.tabs.length - 1]!;
  if (firstTab.start > EPS && lastTab.end < perimeter - EPS && runs.length > 1) {
    const last = runs.pop()!;
    runs[0] = [...last, ...runs[0]!];
  }
  const bridges = plan.tabs.map((t) => sliceLoop(loop, t.start, t.end));
  return { plan, runs, bridges, closed: false };
}
