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
 * Lead-ins are a straight line by default; `leadIn: "arc"` makes each one a
 * quarter circle that joins the path tangentially, so the head is already
 * moving along the edge when it reaches it - no dwell mark where a straight
 * perpendicular lead-in meets the part. An arc that would not stay clear of
 * its own contour (a small hole) falls back to the straight lead-in.
 *
 * Deliberately out of scope for this pass: a true global travelling-salesman order (the nearest-neighbour walk
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
  /** Length of the straight lead-in cut from the pierce point onto the true path, mm - for an arc lead-in, its radius. Default 3. */
  leadInLength?: number;
  /** Lead-in shape. Default "line" (unchanged output); "arc" = a tangent quarter circle where it fits. */
  leadIn?: "line" | "arc";
  /** Toolpath start point (machine home), mm. Default {0,0}. */
  start?: Point;
  /** N-53: evenly spaced uncut bridges on every closed contour. Default off (count 0 / omitted) - output is then unchanged. */
  tabs?: { count: number; width: number; /** Arc length of the first tab centre (default: half a spacing). */ offset?: number };
  /**
   * N-51: common-line cutting. Where a part's (kerf-compensated) outline runs
   * along an outline that is already cut - two parts nested one kerf apart -
   * that stretch is not cut again. Default off - output is then unchanged.
   */
  commonLine?: boolean | { tolerance?: number; minLength?: number };
}

export interface CutFeature {
  placementId: string;
  partNumber: number;
  role: "hole" | "outer";
  /** Where G0 ends and the pierce (laser-on + dwell) happens — off the true edge, in scrap. */
  pierce: Point;
  /** Where the lead-in cut attaches to the true path — also where the loop, cut in full, ends back up. */
  leadIn: Point;
  /** Arc lead-in: the lead-in from `pierce` to `leadIn` is this arc (a quarter circle, tangent to the path at `leadIn`). Absent = a straight line. */
  leadInArc?: { center: Point; ccw: boolean };
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
  /** N-51: length of outline left uncut because a neighbour's cut already made it, mm (0 when common-line is off). */
  commonLineMm?: number;
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

/** The loop as a fine polygon (arcs every few degrees), for the arc lead-in's clearance checks. */
function finePoints(path: Path): Point[] {
  const pts: Point[] = [];
  for (const c of path.curves) {
    const n = c.kind === "arc" ? 48 : 1;
    for (let i = 0; i < n; i++) pts.push(pointAt(c, i / n));
  }
  return pts;
}

/** Even-odd point-in-polygon. */
function insidePolygon(pts: Point[], q: Point): boolean {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const a = pts[i], b = pts[j];
    if (a.y > q.y !== b.y > q.y && q.x < ((b.x - a.x) * (q.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

/** Exact distance from `q` to the loop: segments by projection, arcs by radius when `q` is within the sweep, else the nearer end. */
function distanceToLoop(path: Path, q: Point): number {
  let best = Infinity;
  for (const c of path.curves) {
    if (c.kind === "segment") {
      const a = c.a, b = c.b;
      const dx = b.x - a.x, dy = b.y - a.y, l2 = dx * dx + dy * dy;
      const t = l2 > 0 ? Math.max(0, Math.min(1, ((q.x - a.x) * dx + (q.y - a.y) * dy) / l2)) : 0;
      best = Math.min(best, Math.hypot(q.x - (a.x + t * dx), q.y - (a.y + t * dy)));
      continue;
    }
    const ang = Math.atan2(q.y - c.center.y, q.x - c.center.x);
    const norm = (x: number) => ((x % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
    const sweep = c.full ? 2 * Math.PI : norm(c.ccw ? c.endAngle - c.startAngle : c.startAngle - c.endAngle) || 2 * Math.PI;
    const into = norm(c.ccw ? ang - c.startAngle : c.startAngle - ang);
    if (into <= sweep) best = Math.min(best, Math.abs(Math.hypot(q.x - c.center.x, q.y - c.center.y) - c.radius));
    else {
      const s0 = pointAt(c, 0), s1 = pointAt(c, 1);
      best = Math.min(best, Math.hypot(q.x - s0.x, q.y - s0.y), Math.hypot(q.x - s1.x, q.y - s1.y));
    }
  }
  return best;
}

/**
 * A quarter-circle lead-in of radius `r` ending at `at`, tangent to the cut
 * direction `t` there, bulging to the `n` (away-from-material) side: centre
 * `at + n·r`, pierce `centre − t·r`. Null if any of it would come within a
 * fraction of `r` of the contour or land on the material side - then the
 * caller keeps the straight lead-in, which needs less room.
 */
function arcLeadIn(path: Path, role: "hole" | "outer", at: Point, t: Point, n: Point, r: number): { pierce: Point; center: Point; ccw: boolean } | null {
  const center = { x: at.x + n.x * r, y: at.y + n.y * r };
  const pierce = { x: center.x - t.x * r, y: center.y - t.y * r };
  const ccw = t.x * n.y - t.y * n.x > 0;
  const poly = finePoints(path);
  // Sample the arc away from where it touches the path (the last ~20% approaches `at` by design).
  for (let i = 0; i <= 8; i++) {
    const a = (i / 8) * (Math.PI / 2) * 0.8; // 0 = pierce .. 72 degrees of the 90
    const u = { x: -t.x * Math.cos(a) - n.x * Math.sin(a), y: -t.y * Math.cos(a) - n.y * Math.sin(a) };
    const q = { x: center.x + u.x * r, y: center.y + u.y * r };
    if (insidePolygon(poly, q) !== (role === "hole")) return null;
    // Against a straight edge this sample would sit r·(1 − sin a) off the path; anything of the contour much closer (a corner, the far side of a small hole) means no room.
    if (distanceToLoop(path, q) < 0.5 * r * (1 - Math.sin(a))) return null;
  }
  return { pierce, center, ccw };
}

/** Picks the longest straight edge (falling back to the longest curve when there's none — a plain circular hole) and returns the loop re-rooted there, plus the lead-in's off-part pierce point. */
function planLeadIn(path: Path, awayFromMaterial: Point, leadInLength: number, style: "line" | "arc" = "line", role: "hole" | "outer" = "outer"): { pierce: Point; leadIn: Point; loop: Curve[]; leadInArc?: { center: Point; ccw: boolean } } {
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
  if (style === "arc" && leadInLength > 0) {
    const tl = Math.hypot(tangent.x, tangent.y) || 1;
    const arc = arcLeadIn(path, role, at, { x: tangent.x / tl, y: tangent.y / tl }, { x: outward.x / len, y: outward.y / len }, leadInLength);
    if (arc) return { pierce: arc.pierce, leadIn: at, loop, leadInArc: { center: arc.center, ccw: arc.ccw } };
  }
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
  const leadInStyle = opts.leadIn ?? "line";
  const start = opts.start ?? { x: 0, y: 0 };
  const warnings: string[] = [];
  const tabOpts = opts.tabs && opts.tabs.count > 0 ? opts.tabs : undefined;
  const common = opts.commonLine ? { tolerance: 0.05, minLength: Math.max(1, 2 * kerf), ...(typeof opts.commonLine === "object" ? opts.commonLine : {}) } : null;
  // With common-line, tabs and shared stretches are split together once the cut order is known.
  const earlyTabs = (f: CutFeature, label: string) => {
    if (!common) applyTabs(f, label);
  };

  /** N-53: a feature's tab spans, [a, b] in arc length along its loop, unrolled so a tab wrapping the loop start has b > per. */
  const tabIntervals = (f: CutFeature, label: string): Span[] => {
    if (!tabOpts) return [];
    const plan = planTabs(loopLength(f.loop), tabOpts);
    for (const w of plan.warnings) warnings.push(`${label}: ${w}`);
    if (plan.tabs.length === 0) return [];
    const per = plan.perimeter;
    const byTab = new Map<number, typeof plan.tabs>();
    for (const t of plan.tabs) byTab.set(t.tab, [...(byTab.get(t.tab) ?? []), t]);
    return [...byTab.values()].map((r): Span => {
      if (r.length === 1) return { a: r[0].start, b: r[0].end, tab: true };
      const hi = r[0].end >= per - EPS ? r[0] : r[1];
      const lo = hi === r[0] ? r[1] : r[0];
      return { a: hi.start, b: lo.end + per, tab: true };
    });
  };

  /** Splits a feature at its tabs (N-53). No tabs fit = left as the closed loop. */
  const applyTabs = (f: CutFeature, label: string): void => {
    const iv = tabIntervals(f, label);
    if (iv.length > 0) skipSpans(f, iv, label);
  };

  /**
   * Leaves the spans `iv` of a feature's loop uncut (tabs, or N-51 stretches a
   * neighbour already cut): the cut becomes runs in travel order with the head
   * lifted across each span, starting after the span nearest the original start
   * with the lead-in re-aimed there. Overlapping spans are merged.
   */
  const skipSpans = (f: CutFeature, spans: Span[], label: string): void => {
    const per = loopLength(f.loop);
    const iv = mergeSpans(spans, per);
    if (iv.length === 0) return;
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
    if (f.leadInArc) {
      // Tabs move and re-aim the lead-in; that is done for the straight one: the same length, straight out from the arc's end.
      const out = { x: f.leadInArc.center.x - f.leadIn.x, y: f.leadInArc.center.y - f.leadIn.y };
      pierce = { x: f.leadIn.x + out.x, y: f.leadIn.y + out.y };
    }
    if (distance(first, f.leadIn) > 1e-6) {
      // Re-aim the lead-in at the new start: same side of the path and same length as before.
      const t0 = tangentAt(f.loop[0], 0);
      const out = { x: pierce.x - f.leadIn.x, y: pierce.y - f.leadIn.y };
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
      if (!x.tab) continue; // a neighbour's cut is open already: the lead-in may cross it
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
    delete f.leadInArc;
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
      const { pierce, leadIn, loop, leadInArc } = planLeadIn(comp, inside, leadInLength, leadInStyle, "hole");
      const f: CutFeature = { placementId: placement.id, partNumber: placement.number, role: "hole", pierce, leadIn, loop, ...(leadInArc ? { leadInArc } : {}) };
      earlyTabs(f, `part #${placement.number}, hole`);
      features.push(f);
    }
    {
      const outside = outsideBoundsPoint(outerLoop.path);
      const { path: comp, warning } = kerfCompensate(outerLoop.path, kerf, outside);
      if (warning) warnings.push(`part #${placement.number}, outer: ${warning}`);
      const { pierce, leadIn, loop, leadInArc } = planLeadIn(comp, outside, leadInLength, leadInStyle, "outer");
      const f: CutFeature = { placementId: placement.id, partNumber: placement.number, role: "outer", pierce, leadIn, loop, ...(leadInArc ? { leadInArc } : {}) };
      earlyTabs(f, `part #${placement.number}, outer`);
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

  if (!common) return { features, warnings };

  // N-51: walk the cut order; each outer outline skips what earlier outer outlines already cut.
  let shared = 0;
  const done: { loop: Curve[]; box: Box }[] = [];
  const out: CutFeature[] = [];
  for (const f of features) {
    const label = `part #${f.partNumber}, ${f.role}`;
    const tabs = tabIntervals(f, label);
    if (f.role !== "outer") {
      if (tabs.length > 0) skipSpans(f, tabs, label);
      out.push(f);
      continue;
    }
    const box = loopBox(f.loop, common.tolerance);
    const spans = sharedSpans(f.loop, done.filter((d) => boxesTouch(d.box, box)).map((d) => d.loop), common.tolerance, common.minLength);
    const per = loopLength(f.loop);
    const merged = mergeSpans(spans, per);
    const sharedLen = merged.reduce((n, x) => n + (x.b - x.a), 0);
    done.push({ loop: f.loop, box });
    if (sharedLen >= per - 1e-6) {
      // Every edge was cut by neighbours: nothing left to cut on this outline.
      shared += per;
      continue;
    }
    shared += sharedLen;
    if (merged.length > 0 || tabs.length > 0) skipSpans(f, [...merged, ...tabs], label);
    out.push(f);
  }
  return { features: out, warnings, commonLineMm: shared };
}

/** A stretch of a loop, [a, b] in arc length from its start (b may pass the perimeter to wrap). `tab` = a bridge (the lead-in must not cross it). */
interface Span {
  a: number;
  b: number;
  tab?: boolean;
}

/** Sorted, non-overlapping spans; a span that wraps the loop start is kept unrolled. */
function mergeSpans(spans: Span[], per: number): Span[] {
  if (per <= EPS) return [];
  const norm = spans
    .filter((x) => x.b - x.a > EPS)
    .map((x) => {
      const a = ((x.a % per) + per) % per;
      return { a, b: a + Math.min(per, x.b - x.a), tab: x.tab };
    })
    .sort((x, y) => x.a - y.a);
  const out: Span[] = [];
  for (const x of norm) {
    const last = out[out.length - 1];
    if (last && x.a <= last.b + 1e-9) {
      last.b = Math.max(last.b, x.b);
      last.tab = last.tab || x.tab;
    } else out.push({ ...x });
  }
  // A last span that wraps past the start swallows the spans it reaches.
  while (out.length > 1 && out[out.length - 1]!.b - per >= out[0]!.a - 1e-9) {
    const first = out.shift()!;
    const last = out[out.length - 1]!;
    last.b = Math.max(last.b, first.b + per);
    last.tab = last.tab || first.tab;
  }
  if (out.length === 1 && out[0]!.b - out[0]!.a >= per - 1e-9) return [{ a: 0, b: per, tab: out[0]!.tab }];
  return out;
}

interface Box {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

function loopBox(loop: Curve[], pad: number): Box {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const c of loop) {
    const pts = c.kind === "segment" ? [c.a, c.b] : [curveStart(c), curveEnd(c), { x: c.center.x - c.radius, y: c.center.y - c.radius }, { x: c.center.x + c.radius, y: c.center.y + c.radius }];
    for (const p of pts) {
      if (p.x < minX) minX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.x > maxX) maxX = p.x;
      if (p.y > maxY) maxY = p.y;
    }
  }
  return { minX: minX - pad, minY: minY - pad, maxX: maxX + pad, maxY: maxY + pad };
}

const boxesTouch = (a: Box, b: Box) => a.minX <= b.maxX && b.minX <= a.maxX && a.minY <= b.maxY && b.minY <= a.maxY;

/**
 * N-51: the stretches of `loop`'s straight edges that lie on a straight edge
 * of one of `cut` (within `tol`, at least `minLen` long), as spans along `loop`.
 */
export function sharedSpans(loop: Curve[], cut: Curve[][], tol: number, minLen: number): Span[] {
  const spans: Span[] = [];
  let s0 = 0;
  for (const c of loop) {
    const len = curveLength(c);
    if (c.kind === "segment" && len >= minLen) {
      const ux = (c.b.x - c.a.x) / len, uy = (c.b.y - c.a.y) / len;
      for (const other of cut) {
        for (const d of other) {
          if (d.kind !== "segment") continue;
          // Both ends of d on c's line, and parallel (either direction).
          const off = (p: Point) => (p.x - c.a.x) * -uy + (p.y - c.a.y) * ux;
          if (Math.abs(off(d.a)) > tol || Math.abs(off(d.b)) > tol) continue;
          const t = (p: Point) => (p.x - c.a.x) * ux + (p.y - c.a.y) * uy;
          const lo = Math.max(0, Math.min(t(d.a), t(d.b))), hi = Math.min(len, Math.max(t(d.a), t(d.b)));
          if (hi - lo >= minLen) spans.push({ a: s0 + lo, b: s0 + hi });
        }
      }
    }
    s0 += len;
  }
  return spans;
}
