import {
  curveEnd,
  curveLength,
  curvesToPolylines,
  curveStart,
  joinEntities,
  offsetPath,
  pathOf,
  pointAt,
  sideSign,
  subCurve,
  tangentAt,
  type Curve,
  type Entity,
  type Path,
  type Point,
} from "@sketchor/core";
import { loopLength, planTabs, sliceLoop } from "./tabs";

/**
 * Toolpath planning (N-40/41) — turns a sheet's nested placements into an
 * ordered list of closed cuts a laser can actually run: holes before the
 * outer profile (so a part can't shift or fall before its own internal
 * features are cut), a part nested inside another part's hole cut
 * completely before that hole is cut (or the disc of material around it
 * comes loose first), kerf baked into the path itself (not G41/G42, so any
 * controller works), and a short lead-in that pierces off the true edge and
 * cuts onto it, rather than piercing on the line and leaving a mark.
 *
 * Deliberately out of scope for this pass: arc lead-ins (only the plan's
 * "line" option is built; a straight edge is what's picked first anyway),
 * and a true global travelling-salesman order (the nearest-neighbour walk
 * here is the same class of heuristic `nestTrueShape` itself uses — good
 * enough to not wander the sheet, not claimed optimal).
 */

export interface GcodePlacement {
  /** Stable within one `buildCutPlan` call — e.g. the index into `TrueNestResult.placed`. */
  id: string;
  /** 1-based, matches the on-drawing label — carried through for comments/traceability. */
  number: number;
  /** materializeInstance() output for the part's outer boundary, sheet-local coordinates. */
  outerEntities: Entity[];
  /** Same, for every hole together (not grouped) — `buildCutPlan` regroups them into closed loops itself. */
  holeEntities: Entity[];
  /** Another placement's `id` this one nests inside (N-12's allowInHoles) — cut this one first. */
  insideOfId?: string;
}

export interface ToolpathOptions {
  /** Total kerf width (both sides), mm. Default 0 — cut exactly on the line. */
  kerf?: number;
  /** Length of the straight lead-in cut from the pierce point onto the true path, mm. Default 3. */
  leadInLength?: number;
  /** Toolpath start point (machine home), mm. Default {0,0}. */
  start?: Point;
  /** N-53: evenly spaced uncut bridges on every closed contour. Default off (count 0 / omitted) - output is then unchanged. */
  tabs?: { count: number; width: number; /** Arc length of the first tab centre (default: half a spacing). */ offset?: number };
}

export interface CutFeature {
  placementId: string;
  partNumber: number;
  role: "hole" | "outer";
  /** Where G0 ends and the pierce (laser-on + dwell) happens — off the true edge, in scrap. */
  pierce: Point;
  /** Where the lead-in cut attaches to the true path — also where the loop, cut in full, ends back up. */
  leadIn: Point;
  /** The closed loop, kerf-compensated, reordered to start and end at `leadIn`. */
  loop: Curve[];
  /**
   * N-53: with tabs, the cut runs in travel order (laser off + rapid between them,
   * across each tab). `runs[0]` starts at `leadIn` - or, when a tab covers the loop
   * start, at the first cut point, with `pierce`/`leadIn` moved there. Absent = cut `loop` in one go.
   */
  runs?: Curve[][];
}

export interface CutPlan {
  features: CutFeature[];
  warnings: string[];
}

const EPS = 1e-9;

function isClosed(path: Path): boolean {
  if (path.curves.length === 0) return false;
  const a = curveStart(path.curves[0]);
  const b = curveEnd(path.curves[path.curves.length - 1]);
  return Math.hypot(a.x - b.x, a.y - b.y) < 1e-6;
}

/** Every entity's own curves, chained end to end into a single closed `Path` — a part's boundary is drawn as separate lines/arcs, not necessarily in travel order, so `joinEntities` (endpoint matching) does the real work; a lone already-closed entity (circle, closed polyline) just passes through `pathOf`. */
function assembleLoop(entities: Entity[]): { path: Path } | { error: string } {
  if (entities.length === 0) return { error: "empty boundary" };
  if (entities.length === 1) {
    const p = pathOf(entities[0]);
    if (!p) return { error: "boundary has no stroke" };
    if (!isClosed(p)) return { error: "boundary did not close" };
    return { path: p };
  }
  const joined = joinEntities(entities);
  const used = new Set(joined.flatMap((j) => j.replaced));
  const leftover = entities.filter((e) => !used.has(e.id));
  if (joined.length === 1 && leftover.length === 0) {
    const p = pathOf(joined[0].polyline);
    if (!p || !isClosed(p)) return { error: "boundary did not close" };
    return { path: p };
  }
  return { error: `boundary split into ${joined.length + leftover.length} disconnected piece(s)` };
}

/**
 * Splits a flat bag of hole entities (every hole's materialized geometry,
 * concatenated) back into one closed `Path` per hole. Separate holes don't
 * share endpoints, so `joinEntities`' endpoint-matching naturally keeps each
 * hole's own chain together; a hole that's a single already-closed entity
 * (a circle) is picked up from what `joinEntities` leaves unused.
 */
function assembleHoleLoops(entities: Entity[]): { loops: Path[]; warnings: string[] } {
  const loops: Path[] = [];
  const warnings: string[] = [];
  const joined = joinEntities(entities);
  const used = new Set(joined.flatMap((j) => j.replaced));
  for (const { polyline } of joined) {
    const p = pathOf(polyline);
    if (p && isClosed(p)) loops.push(p);
    else warnings.push("a hole's chained boundary did not close — skipped");
  }
  for (const e of entities) {
    if (used.has(e.id)) continue;
    const p = pathOf(e);
    if (p && isClosed(p)) loops.push(p);
    else if (p) warnings.push(`entity ${e.id} isn't part of a closed hole boundary — skipped`);
  }
  return { loops, warnings };
}

/** A handful of sample points along a loop — enough for a bounding box or a rough centroid, not a faithful tessellation. */
function samplePoints(path: Path): Point[] {
  const pts: Point[] = [];
  for (const c of path.curves) {
    pts.push(pointAt(c, 0));
    if (c.kind === "arc") pts.push(pointAt(c, 0.25), pointAt(c, 0.5), pointAt(c, 0.75));
  }
  return pts;
}

/** A point guaranteed outside the loop's own bounding box — "away from material" for an outer profile. */
function outsideBoundsPoint(path: Path): Point {
  const pts = samplePoints(path);
  const xs = pts.map((p) => p.x);
  const ys = pts.map((p) => p.y);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  const pad = Math.max(maxX - minX, maxY - minY, 1) + 10;
  return { x: maxX + pad, y: (minY + maxY) / 2 };
}

/** A rough interior point — "away from material" for a hole, since a hole's own inside is the open/removed side. Good enough for the star/convex-ish holes real parts have; not a robust point-in-any-polygon solve. */
function roughCentroid(path: Path): Point {
  const pts = samplePoints(path);
  return { x: pts.reduce((s, p) => s + p.x, 0) / pts.length, y: pts.reduce((s, p) => s + p.y, 0) / pts.length };
}

/**
 * Offsets a closed loop by half the kerf, toward whichever side `awayFromMaterial`
 * lies on — outward for an outer profile, inward for a hole. After the laser
 * removes a kerf-wide swath centred on this path, the true edge lands back on
 * the original line. Falls back to the uncompensated loop (with a warning)
 * if the offset collapses — a tiny kerf against a very small feature.
 */
function kerfCompensate(path: Path, kerf: number, awayFromMaterial: Point): { path: Path; warning?: string } {
  if (kerf <= 0) return { path };
  const sign = sideSign(path, awayFromMaterial);
  const offset = offsetPath(path, sign * (kerf / 2));
  if (!offset) return { path, warning: "kerf offset collapsed a loop smaller than the kerf — cutting on the original line instead" };
  return { path: offset };
}

/** Splits the curve at `index` at parameter `t` and rotates the loop to start (and end) there — the point where a lead-in cut attaches. */
function rerootAt(curves: Curve[], index: number, t: number): { loop: Curve[]; at: Point } {
  const c = curves[index];
  const before = subCurve(c, 0, t);
  const after = subCurve(c, t, 1);
  const loop = [after, ...curves.slice(index + 1), ...curves.slice(0, index), before].filter((cu) => curveLength(cu) > EPS);
  return { loop, at: pointAt(c, t) };
}

/** Picks the longest straight edge (falling back to the longest curve when there's none — a plain circular hole) and returns the loop re-rooted there, plus the lead-in's off-part pierce point. */
function planLeadIn(path: Path, awayFromMaterial: Point, leadInLength: number): { pierce: Point; leadIn: Point; loop: Curve[] } {
  const segments = path.curves.map((c, i) => ({ c, i })).filter((x) => x.c.kind === "segment");
  const pool = segments.length > 0 ? segments : path.curves.map((c, i) => ({ c, i }));
  const best = pool.reduce((a, b) => (curveLength(b.c) > curveLength(a.c) ? b : a));

  const { loop, at } = rerootAt(path.curves, best.i, 0.5);
  const tangent = tangentAt(loop[loop.length - 1], 1); // tangent of the (reordered) curve ending at `at`
  const left = { x: -tangent.y, y: tangent.x };
  const sign = sideSign(path, awayFromMaterial);
  const outward = sign >= 0 ? left : { x: -left.x, y: -left.y };
  const len = Math.hypot(outward.x, outward.y) || 1;
  const pierce = { x: at.x + (outward.x / len) * leadInLength, y: at.y + (outward.y / len) * leadInLength };
  return { pierce, leadIn: at, loop };
}

function distance(a: Point, b: Point): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

/**
 * Builds every part's cut features (holes then outer, each kerf-compensated
 * with a lead-in) and orders them: placements nested inside another
 * placement's hole are cut, in full, before that hole; everything else
 * (and each part's own holes) is visited by a nearest-neighbour walk from
 * `start` so the head doesn't crisscross the sheet.
 */
export function buildCutPlan(placements: GcodePlacement[], opts: ToolpathOptions = {}): CutPlan {
  const kerf = opts.kerf ?? 0;
  const leadInLength = opts.leadInLength ?? 3;
  const start = opts.start ?? { x: 0, y: 0 };
  const warnings: string[] = [];
  const tabOpts = opts.tabs && opts.tabs.count > 0 ? opts.tabs : undefined;

  /** Splits a feature at its tabs (N-53). No tabs fit = left as the closed loop. */
  const applyTabs = (f: CutFeature, label: string): void => {
    if (!tabOpts) return;
    const plan = planTabs(loopLength(f.loop), tabOpts);
    for (const w of plan.warnings) warnings.push(`${label}: ${w}`);
    if (plan.tabs.length === 0) return;
    const per = plan.perimeter;
    // One [a, b] interval per tab, unrolled so a tab wrapping the loop start has b > per.
    const byTab = new Map<number, typeof plan.tabs>();
    for (const t of plan.tabs) byTab.set(t.tab, [...(byTab.get(t.tab) ?? []), t]);
    const iv = [...byTab.values()].map((r) => {
      if (r.length === 1) return { a: r[0].start, b: r[0].end };
      const hi = r[0].end >= per - EPS ? r[0] : r[1];
      const lo = hi === r[0] ? r[1] : r[0];
      return { a: hi.start, b: lo.end + per };
    }).sort((x, y) => x.a - y.a);
    const n = iv.length;
    // Start the cut at the end of the tab nearest the original start (the lead-in's chosen edge).
    const circ = (x: number) => Math.min(((x % per) + per) % per, per - (((x % per) + per) % per));
    let k = 0;
    for (let i = 1; i < n; i++) if (circ(iv[i].b) < circ(iv[k].b)) k = i;
    const doubled = [...f.loop, ...f.loop];
    const runs: Curve[][] = [];
    for (let j = 0; j < n; j++) {
      const cur = iv[(k + j) % n];
      const nxt = iv[(k + j + 1) % n];
      const lo = ((cur.b % per) + per) % per;
      const len = (((nxt.a - cur.b) % per) + per) % per || (n === 1 ? per - (cur.b - cur.a) : 0);
      if (len > EPS) runs.push(sliceLoop(doubled, lo, lo + len));
    }
    if (runs.length === 0 || runs.some((r) => r.length === 0)) return;
    const first = curveStart(runs[0][0]);
    let pierce = f.pierce;
    if (distance(first, f.leadIn) > 1e-6) {
      // Re-aim the lead-in at the new start: same side of the path and same length as before.
      const t0 = tangentAt(f.loop[0], 0);
      const out = { x: f.pierce.x - f.leadIn.x, y: f.pierce.y - f.leadIn.y };
      const side = Math.sign(t0.x * out.y - t0.y * out.x) || 1;
      const t1 = tangentAt(runs[0][0], 0);
      const nv = { x: -t1.y * side, y: t1.x * side };
      const nlen = Math.hypot(nv.x, nv.y) || 1;
      const len = Math.hypot(out.x, out.y);
      pierce = { x: first.x + (nv.x / nlen) * len, y: first.y + (nv.y / nlen) * len };
    }
    // The lead-in line must not touch a tab (or it would cut the bridge): sample every uncut span.
    const segDist = (p: Point) => {
      const dx = first.x - pierce.x, dy = first.y - pierce.y;
      const l2 = dx * dx + dy * dy;
      const t = l2 > 0 ? Math.max(0, Math.min(1, ((p.x - pierce.x) * dx + (p.y - pierce.y) * dy) / l2)) : 0;
      return Math.hypot(p.x - (pierce.x + t * dx), p.y - (pierce.y + t * dy));
    };
    for (const x of iv) {
      const lo = ((x.a % per) + per) % per;
      for (const c of sliceLoop(doubled, lo, lo + (x.b - x.a))) {
        for (let i = 0; i <= 8; i++) {
          const pt = pointAt(c, i / 8);
          if (distance(pt, first) > 1e-6 && segDist(pt) < 1e-3) {
            warnings.push(`${label}: lead-in would cut into a tab; tabs skipped on this contour`);
            return;
          }
        }
      }
    }
    f.runs = runs;
    f.leadIn = first;
    f.pierce = pierce;
  };

  interface Built {
    id: string;
    number: number;
    insideOfId?: string;
    features: CutFeature[]; // this placement's own holes then outer, in that fixed order
  }

  const built: Built[] = [];
  for (const rawPlacement of placements) {
    // C-08: an ellipse/spline boundary is cut as lines and fitted G2/G3 arcs (0.01 mm), not thousands of G1 chords.
    const placement = {
      ...rawPlacement,
      outerEntities: curvesToPolylines(rawPlacement.outerEntities, 0.01),
      holeEntities: curvesToPolylines(rawPlacement.holeEntities, 0.01),
    };
    const outerLoop = assembleLoop(placement.outerEntities);
    if ("error" in outerLoop) {
      warnings.push(`part #${placement.number}: outer profile ${outerLoop.error} — skipped`);
      continue;
    }
    const { loops: holeLoops, warnings: holeWarnings } = assembleHoleLoops(placement.holeEntities);
    for (const w of holeWarnings) warnings.push(`part #${placement.number}: ${w}`);

    const features: CutFeature[] = [];
    for (const holePath of holeLoops) {
      const inside = roughCentroid(holePath);
      const { path: comp, warning } = kerfCompensate(holePath, kerf, inside);
      if (warning) warnings.push(`part #${placement.number}, hole: ${warning}`);
      const { pierce, leadIn, loop } = planLeadIn(comp, inside, leadInLength);
      const f: CutFeature = { placementId: placement.id, partNumber: placement.number, role: "hole", pierce, leadIn, loop };
      applyTabs(f, `part #${placement.number}, hole`);
      features.push(f);
    }
    {
      const outside = outsideBoundsPoint(outerLoop.path);
      const { path: comp, warning } = kerfCompensate(outerLoop.path, kerf, outside);
      if (warning) warnings.push(`part #${placement.number}, outer: ${warning}`);
      const { pierce, leadIn, loop } = planLeadIn(comp, outside, leadInLength);
      const f: CutFeature = { placementId: placement.id, partNumber: placement.number, role: "outer", pierce, leadIn, loop };
      applyTabs(f, `part #${placement.number}, outer`);
      features.push(f);
    }

    built.push({ id: placement.id, number: placement.number, insideOfId: placement.insideOfId, features });
  }

  // Innermost-first: a part nested in another's hole must be fully cut
  // before that hole is opened. Coarse but always correct — cut every
  // tier of nesting depth completely, deepest first, rather than trying to
  // interleave tiers for slightly less travel.
  const byId = new Map(built.map((b) => [b.id, b]));
  const depthCache = new Map<string, number>();
  const depthOf = (b: Built): number => {
    const cached = depthCache.get(b.id);
    if (cached !== undefined) return cached;
    depthCache.set(b.id, 0); // guards a cyclic reference, which should never occur
    const container = b.insideOfId ? byId.get(b.insideOfId) : undefined;
    const d = container ? depthOf(container) + 1 : 0;
    depthCache.set(b.id, d);
    return d;
  };

  const tiers = new Map<number, Built[]>();
  for (const b of built) {
    const d = depthOf(b);
    const list = tiers.get(d);
    if (list) list.push(b);
    else tiers.set(d, [b]);
  }

  const features: CutFeature[] = [];
  let cursor = start;
  for (const depth of [...tiers.keys()].sort((a, z) => z - a)) {
    const remaining = tiers.get(depth)!;
    while (remaining.length > 0) {
      let bestIdx = 0;
      let bestDist = Infinity;
      for (let i = 0; i < remaining.length; i++) {
        const anchor = remaining[i].features[0]?.pierce ?? cursor;
        const d = distance(cursor, anchor);
        if (d < bestDist) {
          bestDist = d;
          bestIdx = i;
        }
      }
      const [next] = remaining.splice(bestIdx, 1);
      // Nearest-neighbour among this part's own holes too, then the outer last.
      const holeFeatures = next.features.filter((f) => f.role === "hole");
      const outerFeature = next.features.find((f) => f.role === "outer")!;
      const pool = [...holeFeatures];
      while (pool.length > 0) {
        let hi = 0;
        let hd = Infinity;
        for (let i = 0; i < pool.length; i++) {
          const d = distance(cursor, pool[i].pierce);
          if (d < hd) {
            hd = d;
            hi = i;
          }
        }
        const [f] = pool.splice(hi, 1);
        features.push(f);
        cursor = f.leadIn;
      }
      features.push(outerFeature);
      cursor = outerFeature.leadIn;
    }
  }

  return { features, warnings };
}
