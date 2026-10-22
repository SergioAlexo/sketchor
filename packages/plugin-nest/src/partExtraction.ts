import { curveEnd, curveLength, curveStart, curvesToPolylines, dist, insertContents, joinEntities, pathOf, type Entity } from "@sketchor/core";
import { area as polygonArea, polygonContainsPolygon } from "./geometry";
import { DEFAULT_CHORD_TOLERANCE, flattenCircle, flattenClosedPolyline } from "./flatten";
import type { Point } from "./types";

/**
 * Part extraction with holes (N-01): turns a selection into parts a nester
 * can place, instead of the flat "closed polyline or circle only" filter
 * `nestPlugin.ts`'s `toPart()` used. A closed shape found directly inside
 * another becomes that part's hole; a shape found inside *that* hole is a
 * new, independent part (what N-12 will later try to place inside the
 * hole) rather than a "hole of a hole".
 *
 * RN-10: the contour rules below (duplicate-primitive removal, helper-line
 * filter, join vs close tolerance, multi-outer note, per-part cut length and
 * pierce count) are ported from the Sheet Nesting Calculator by Oleksandr
 * Borenko. Wrong rules here mean a laser that cuts a doubled line twice, cuts
 * a bend line as an outline, or quotes a time with the wrong pierce count.
 */

export interface ExtractedPart {
  /** Synthetic, stable for a given call — not a document entity id. */
  id: string;
  name: string;
  /** Closed outline, chord-tolerance flattened, world coordinates. */
  outer: Point[];
  /** Same, one per hole. */
  holes: Point[][];
  /** Every original entity id (outer + holes) this part was built from. */
  sourceIds: string[];
  /** Just the outer boundary's own entity ids — a subset of `sourceIds` (N-31: routes outer-profile cuts to their own DXF layer, separate from holes). */
  outerSourceIds: string[];
  /** Same, one array per hole, index-aligned with `holes`. */
  holeSourceIds: string[][];
  /** RN-10: total length to cut: outer plus every hole, exact arc lengths (not the flattened polygon). */
  cutLength: number;
  /** RN-10: number of holes in `holes`. */
  holeCount: number;
  /** RN-10: laser pierces, one per closed contour (outer + holes). */
  pierceCount: number;
}

/** RN-10: a non-fatal remark about the selection, for the panel to show as a note. */
export type ExtractNote =
  | { kind: "helper"; count: number; names: string[] }
  | { kind: "duplicates"; count: number }
  | { kind: "gap-closed"; maxGap: number }
  | { kind: "multi-outer"; count: number };

export interface ExtractOptions {
  chordTolerance?: number;
  /** Endpoints this close count as touching exactly (default 1e-6). */
  joinTolerance?: number;
  /** A chain whose free ends are within this closes anyway and reports a `gap-closed` note. Default: `joinTolerance`. */
  closeTolerance?: number;
  /** Keep construction / centre / hidden / bend-layer entities instead of dropping them as helper lines. */
  keepHelpers?: boolean;
  /** Report `multi-outer` when more than one top-level contour is found (the selection is meant to be ONE part, e.g. one file). */
  singlePart?: boolean;
}

const HELPER_LINETYPE = /center|hidden|phantom|dash|dot|border|divide/i;
const HELPER_LAYER = /bend|center|hidden|annotation|dimension|defpoints|thread|virtual|explode|break_lines|section_cutting|detail_view|construction/i;

/** Why `e` is a helper line (a layer or linetype name worth reporting), or null when it is a cut outline. */
export function helperReason(e: Entity): string | null {
  if (e.construction) return "construction";
  if (e.linetype && !/^(bylayer|continuous)$/i.test(e.linetype) && HELPER_LINETYPE.test(e.linetype)) return `LT:${e.linetype}`;
  if (e.layer && HELPER_LAYER.test(e.layer)) return e.layer;
  return null;
}

/** Geometric key of a line/arc/circle/polyline for duplicate detection, or null for other types. */
function primitiveKey(e: Entity, tol: number): string | null {
  const q = (v: number) => Math.round(v / tol);
  switch (e.type) {
    case "line": {
      let a = e.a;
      let b = e.b;
      if (a.x > b.x || (a.x === b.x && a.y > b.y)) [a, b] = [b, a];
      return `L${q(a.x)},${q(a.y)},${q(b.x)},${q(b.y)}`;
    }
    case "circle":
      return `C${q(e.center.x)},${q(e.center.y)},${q(e.radius)}`;
    case "arc":
      return `A${q(e.center.x)},${q(e.center.y)},${q(e.radius)},${Math.round(e.startAngle * 100)},${Math.round(e.endAngle * 100)},${e.ccw}`;
    case "polyline": {
      if (e.bulges?.some((b) => b)) return null; // bulge direction makes the reversed key unsafe; keep them
      const pts = e.points.map((p) => `${q(p.x)},${q(p.y)}`);
      const fwd = pts.join(";");
      const rev = [...pts].reverse().join(";");
      return `P${e.closed}${fwd < rev ? fwd : rev}`;
    }
    default:
      return null;
  }
}

function entityLength(e: Entity): number {
  const path = pathOf(e);
  return path ? path.curves.reduce((sum, c) => sum + curveLength(c), 0) : 0;
}

/**
 * NF-03: a run of selected lines/arcs/open-polylines that chained together
 * but never closed into a loop — the shape a user meant as a part boundary,
 * minus one connection. `gap` is the distance between the two free ends
 * (0 for a lone entity with no partner at all, which still counts — it just
 * never found anything else to connect to within tolerance).
 */
export interface OpenChainInfo {
  entityIds: string[];
  start: Point;
  end: Point;
  gap: number;
}

export interface ExtractResult {
  parts: ExtractedPart[];
  openChains: OpenChainInfo[];
  /** RN-10: helper lines dropped, duplicates removed, gaps closed, separate outers. */
  notes: ExtractNote[];
}

interface Region {
  points: Point[];
  area: number;
  entityIds: string[];
  name?: string;
  length: number;
}

export function extractParts(
  entities: Entity[],
  selectedIds: ReadonlySet<string>,
  opts: ExtractOptions = {},
): ExtractedPart[] {
  return extractPartsWithDiagnostics(entities, selectedIds, opts).parts;
}

/**
 * Same as {@link extractParts}, plus `openChains` — every selected boundary
 * candidate that didn't make it into a part because it never closed. Used by
 * `nestPlugin.ts`'s "Add selection" to say *why* nothing (or fewer than
 * expected) came out, instead of a flat "select closed shapes".
 */
export function extractPartsWithDiagnostics(
  entities: Entity[],
  selectedIds: ReadonlySet<string>,
  opts: ExtractOptions = {},
): ExtractResult {
  const chordTol = opts.chordTolerance ?? DEFAULT_CHORD_TOLERANCE;
  // C-08: ellipses/splines become arc-fitted polylines (0.01 mm) so they close, chain and nest like any other outline.
  // B-10: a selected block instance is one part — its evaluated geometry decides the outline, and every id found is
  // mapped back to the insert so the original (and a materialised copy) stays a single instance.
  const owner = new Map<string, string>();
  const picked = entities
    .filter((e) => selectedIds.has(e.id))
    .flatMap((e) => {
      if (e.type !== "insert") return [e];
      return insertContents(e).map((c) => {
        owner.set(c.id, e.id);
        return c;
      });
    });
  const notes: ExtractNote[] = [];
  const joinTol = opts.joinTolerance ?? 1e-6;
  const closeTol = Math.max(opts.closeTolerance ?? joinTol, joinTol);

  // RN-10: helper lines (bends, centre lines, construction) are never cut outlines.
  let candidates = picked;
  if (!opts.keepHelpers) {
    const why: Record<string, number> = {};
    candidates = picked.filter((e) => {
      const r = helperReason(e);
      if (r === null) return true;
      why[r] = (why[r] ?? 0) + 1;
      return false;
    });
    const names = Object.keys(why);
    if (names.length > 0) notes.push({ kind: "helper", count: names.reduce((n, k) => n + why[k], 0), names });
  }
  // RN-10: the same primitive drawn twice would be cut twice (and break chaining).
  const seen = new Set<string>();
  let dupes = 0;
  candidates = candidates.filter((e) => {
    const key = primitiveKey(e, Math.max(joinTol, 1e-6));
    if (key === null) return true;
    if (seen.has(key)) {
      dupes += 1;
      return false;
    }
    seen.add(key);
    return true;
  });
  if (dupes > 0) notes.push({ kind: "duplicates", count: dupes });

  const selected = curvesToPolylines(candidates, Math.min(chordTol, 0.01));
  const { regions, openChains, maxGap } = gatherRegions(selected, chordTol, joinTol, closeTol);
  if (maxGap > joinTol) notes.push({ kind: "gap-closed", maxGap });
  if (regions.length === 0) return { parts: [], openChains, notes };

  const parents = findParents(regions);
  const children = new Map<number, number[]>();
  parents.forEach((parent, i) => {
    if (parent === null) return;
    const list = children.get(parent);
    if (list) list.push(i);
    else children.set(parent, [i]);
  });

  const parts: ExtractedPart[] = [];
  let counter = 0;

  const buildPart = (outerIdx: number): void => {
    const outerRegion = regions[outerIdx];
    const outerSourceIds = [...outerRegion.entityIds];
    const sourceIds = [...outerSourceIds];
    const holes: Point[][] = [];
    const holeSourceIds: string[][] = [];
    let cutLength = outerRegion.length;
    for (const holeIdx of children.get(outerIdx) ?? []) {
      const holeRegion = regions[holeIdx];
      holes.push(holeRegion.points);
      holeSourceIds.push([...holeRegion.entityIds]);
      sourceIds.push(...holeRegion.entityIds);
      cutLength += holeRegion.length;
      for (const nestedPartIdx of children.get(holeIdx) ?? []) buildPart(nestedPartIdx);
    }
    counter += 1;
    parts.push({
      id: `part-${counter}`,
      name: outerRegion.name ?? `Part ${counter}`,
      outer: outerRegion.points,
      holes,
      sourceIds,
      outerSourceIds,
      holeSourceIds,
      cutLength,
      holeCount: holes.length,
      pierceCount: 1 + holes.length,
    });
  };

  parents.forEach((parent, i) => {
    if (parent === null) buildPart(i);
  });

  if (opts.singlePart) {
    const outers = parents.filter((p) => p === null).length;
    if (outers > 1) notes.push({ kind: "multi-outer", count: outers });
  }

  if (owner.size > 0) {
    const back = (ids: string[]) => [...new Set(ids.map((id) => owner.get(id) ?? id))];
    for (const part of parts) {
      part.outerSourceIds = back(part.outerSourceIds);
      part.holeSourceIds = part.holeSourceIds.map((h) => back(h).filter((id) => !part.outerSourceIds.includes(id)));
      part.sourceIds = back(part.sourceIds);
    }
    for (const c of openChains) c.entityIds = [...new Set(c.entityIds.map((id) => owner.get(id) ?? id))];
  }
  return { parts, openChains, notes };
}

/** Every closed loop in the selection (already-closed circles/polylines, plus open chains that close via `joinEntities`), plus every candidate boundary that stayed open (NF-03). */
function gatherRegions(entities: Entity[], chordTol: number, joinTol: number, closeTol: number): { regions: Region[]; openChains: OpenChainInfo[]; maxGap: number } {
  const lengthOf = new Map(entities.map((e) => [e.id, entityLength(e)]));
  const sumLen = (ids: string[]) => ids.reduce((n, id) => n + (lengthOf.get(id) ?? 0), 0);
  const regions: Region[] = [];
  const closedIds = new Set<string>();
  for (const e of entities) {
    if (e.type === "circle") {
      const points = flattenCircle(e.center, e.radius, chordTol);
      regions.push({ points, area: polygonArea(points), entityIds: [e.id], name: e.name, length: sumLen([e.id]) });
      closedIds.add(e.id);
    } else if (e.type === "polyline" && e.closed) {
      const points = flattenClosedPolyline(e, chordTol);
      regions.push({ points, area: polygonArea(points), entityIds: [e.id], name: e.name, length: sumLen([e.id]) });
      closedIds.add(e.id);
    }
  }

  const openChains: OpenChainInfo[] = [];
  const chainedIds = new Set<string>();
  // RN-10: chains join at the looser close tolerance; the widest joint of a closed chain is reported when it exceeds the exact join tolerance.
  let maxGap = 0;
  const byId = new Map(entities.map((e) => [e.id, e]));
  for (const chain of joinEntities(entities, closeTol)) {
    chain.replaced.forEach((id) => chainedIds.add(id));
    if (chain.polyline.closed && closeTol > joinTol) {
      maxGap = Math.max(maxGap, widestJoint(chain.replaced.map((id) => byId.get(id)).filter((e): e is Entity => !!e)));
    }
    if (!chain.polyline.closed) {
      // An open chain isn't a part/hole boundary, but it's exactly the
      // "almost closed" case NF-03 exists to name — a real gap between its
      // two free ends, at a specific, reportable location.
      const pts = chain.polyline.points;
      if (pts.length >= 2) {
        openChains.push({ entityIds: chain.replaced, start: pts[0], end: pts[pts.length - 1], gap: dist(pts[0], pts[pts.length - 1]) });
      }
      continue;
    }
    const points = flattenClosedPolyline(chain.polyline, chordTol);
    regions.push({ points, area: polygonArea(points), entityIds: chain.replaced, length: sumLen(chain.replaced) });
  }

  // joinEntities only reports chains of 2+ pieces — a selected line/arc/open
  // polyline that never found anything to connect to at all (no partner
  // within tolerance, not just "not closed yet") would otherwise disappear
  // from the diagnostics entirely.
  for (const e of entities) {
    if (closedIds.has(e.id) || chainedIds.has(e.id)) continue;
    if (e.type !== "line" && e.type !== "arc" && !(e.type === "polyline" && !e.closed)) continue;
    const path = pathOf(e);
    if (!path || path.curves.length === 0) continue;
    const start = curveStart(path.curves[0]);
    const end = curveEnd(path.curves[path.curves.length - 1]);
    openChains.push({ entityIds: [e.id], start, end, gap: dist(start, end) });
  }

  return { regions: regions.filter((r) => r.points.length >= 3 && r.area > 1e-9), openChains, maxGap };
}

/** Largest distance from a member's free end to the nearest end of another member (0 for a lone entity). */
function widestJoint(members: Entity[]): number {
  const ends: { owner: number; p: Point }[] = [];
  members.forEach((e, i) => {
    const path = pathOf(e);
    if (!path || path.curves.length === 0 || path.closed) return;
    ends.push({ owner: i, p: curveStart(path.curves[0]) }, { owner: i, p: curveEnd(path.curves[path.curves.length - 1]) });
  });
  let widest = 0;
  for (const a of ends) {
    let best = Infinity;
    for (const b of ends) if (b.owner !== a.owner) best = Math.min(best, dist(a.p, b.p));
    if (best !== Infinity) widest = Math.max(widest, best);
  }
  return widest;
}

/** Each region's immediate container — the smallest-area region that fully encloses it, or null at the top level. */
function findParents(regions: Region[]): (number | null)[] {
  return regions.map((region, i) => {
    let best: number | null = null;
    let bestArea = Infinity;
    regions.forEach((candidate, j) => {
      if (j === i || candidate.area <= region.area) return; // a container is strictly bigger
      if (candidate.area < bestArea && polygonContainsPolygon(candidate.points, region.points)) {
        best = j;
        bestArea = candidate.area;
      }
    });
    return best;
  });
}
