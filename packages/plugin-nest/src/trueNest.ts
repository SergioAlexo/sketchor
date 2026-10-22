import { area, bounds, insideSheet, isCCW, normalize, pointInOrOnPolygon, pointInPolygon, polygonContainsPolygon, polygonsClash, rotate, translate, type Bounds } from "./geometry";
import { innerFit, NfpCache, nfpKey } from "./nfp";
import { offsetPolygon } from "./polygonOps";
import { rotationCandidates, type PartRotationSpec } from "./rotation";
import { shrinkLastSheet, type StockRow } from "./stock";
import type { Point } from "./types";

/**
 * True-shape (no-fit-polygon) nesting (N-10) — places parts by their real
 * outline instead of `nest.ts`'s bounding box, with per-part rotation
 * (N-11) and a multi-sheet stock inventory (N-13). A separate engine
 * alongside `nestParts()`, which stays exactly as it is; this one consumes
 * `partExtraction.ts`'s richer parts and doesn't touch the old bbox path.
 */

export interface TrueNestPart {
  id: string;
  name: string;
  /** Closed outline, world-scale mm. */
  outer: Point[];
  /** This part's own holes — become candidate free regions for other parts once this part is placed (N-12), if it has any. */
  holes: Point[][];
  quantity: number;
  rotation: PartRotationSpec;
  /** N-12: try this part inside an already-placed part's hole before the open sheet area. */
  allowInHoles?: boolean;
}

/** Which sheet corner placement gravitates toward. Default "bottom-left". */
export type Gravity = "bottom-left" | "bottom-right" | "top-left" | "top-right";

export interface TrueNestOptions {
  /** Gap kept clear between parts, mm. Default 0. */
  spacing?: number;
  /** Gap kept clear from every sheet edge, mm. Default 0. */
  edgeMargin?: number;
  gravity?: Gravity;
  /** N-12: a hole smaller than this (after shrinking inward by `spacing`) is never offered to `allowInHoles` parts. Default 0 (no filter). */
  minHoleArea?: number;
  /**
   * N-14: the sequence instances are greedily placed in. Default
   * `"area-desc"` (largest first, unchanged from before this option
   * existed) — `nestTrueShapeSearch` tries the others (and seeded shuffles,
   * via a number) to search for a denser packing within a time budget.
   */
  order?: "area-desc" | "area-asc" | "bbox-desc" | number;
}

export interface TrueNestPlacement {
  partId: string;
  /** Which sheet (0-based). */
  sheet: number;
  rotationDeg: number;
  mirrored: boolean;
  /** Where the rotated part's own bbox-min corner lands in sheet space. */
  translation: Point;
  /**
   * N-40: set when this placement landed inside another placement's hole
   * (an `allowInHoles` part) — the index into this result's own `placed`
   * array of the part whose hole it's in. A toolpath must cut this part
   * completely before cutting that hole, or the disc of material around it
   * comes free (and can shift or fall) before its own profile is cut.
   */
  insideOfPlacementIndex?: number;
}

export interface TrueNestSheet {
  /** Which `stock` row this sheet was opened from. */
  stockIndex: number;
  width: number;
  height: number;
}

export interface TrueNestResult {
  sheets: TrueNestSheet[];
  placed: TrueNestPlacement[];
  /** `partId → count` that wouldn't fit anywhere in the stock. */
  unplaced: { partId: string; count: number }[];
  utilisation: number;
}

interface SheetItem {
  /** NFP cache key for this instance's own (part, rotation, mirror). */
  key: string;
  /** Rotated + bbox-normalized outline. */
  local: Point[];
  translation: Point;
  placedPolygon: Point[];
}

/** A hole, already in sheet coordinates and shrunk inward by spacing — a free region `allowInHoles` parts can be placed within (N-12). */
interface HoleRegion {
  /** Which sheet this hole (and therefore anything placed inside it) is on. */
  sheet: number;
  polygon: Point[];
  area: number;
  /** Index into `placed` of the part this hole belongs to (N-40 toolpath ordering). */
  containerPlacementIndex: number;
}

/** Rotates/mirrors/translates a polygon the same rigid way {@link placementTransform}'s result carries original geometry — used to bring a part's *hole* (still in the part's own original coordinate frame) into sheet space alongside its outer. */
function transformPolygon(poly: Point[], transform: { rotationDeg: number; mirrored: boolean; translation: Point }): Point[] {
  const mirroredPoly = transform.mirrored ? poly.map((p) => ({ x: -p.x, y: p.y })) : poly;
  return translate(rotate(mirroredPoly, transform.rotationDeg), transform.translation.x, transform.translation.y);
}

/** A part's outline rotated (and mirrored) then bbox-normalized to the origin — the frame NFPs are cached and placed in. */
export function localFrame(outer: Point[], deg: number, mirrored: boolean): Point[] {
  const mirroredPoly = mirrored ? outer.map((p) => ({ x: -p.x, y: p.y })) : outer;
  return normalize(rotate(mirroredPoly, deg));
}

/** Sorts candidates toward the chosen corner first — the only thing "gravity direction" changes; the feasible region itself is unaffected. */
function gravityComparator(gravity: Gravity): (a: Point, b: Point) => number {
  const ySign = gravity.startsWith("top") ? -1 : 1;
  const xSign = gravity.endsWith("right") ? -1 : 1;
  return (a, b) => ySign * (a.y - b.y) || xSign * (a.x - b.x);
}

/**
 * The rigid transform (rotate/mirror about the origin, then translate) that
 * carries a part's *original, un-normalized* outline to where a placement
 * put it. `TrueNestPlacement.translation` positions the placement search's
 * local frame — the rotated outline re-normalized so its own bbox-min sits
 * at the origin — not the original polygon directly, so materializing a
 * placement onto real (un-flattened) source entities needs this adjustment:
 * `translation` minus the rotated original's own bbox-min. Feed the result
 * straight into `materializeInstance` (`materialize.ts`)'s `InstanceTransform`.
 */
export function placementTransform(
  outer: Point[],
  placement: { rotationDeg: number; mirrored: boolean; translation: Point },
): { rotationDeg: number; mirrored: boolean; translation: Point } {
  const mirroredPoly = placement.mirrored ? outer.map((p) => ({ x: -p.x, y: p.y })) : outer;
  const box = bounds(rotate(mirroredPoly, placement.rotationDeg));
  return {
    rotationDeg: placement.rotationDeg,
    mirrored: placement.mirrored,
    translation: { x: placement.translation.x - box.minX, y: placement.translation.y - box.minY },
  };
}

/**
 * Hard cap so a pathological quantity can't hang the plugin worker (mirrors
 * `nest.ts`'s own guard, raised: N-14's perf test measured this engine's
 * per-candidate NFP checks scale roughly cubically with how many instances
 * end up sharing one sheet — the pathological case is one huge quantity
 * that all fits on a single large sheet, not spread across many. 600 was
 * chosen because that adversarial case measured ~9s on a dev machine at
 * this size; the perf test pins a generous bound above that for slower CI.
 */
const MAX_INSTANCES = 600;

/** Deterministic Mulberry32 shuffle — `order: <seed>` uses this to give `nestTrueShapeSearch` reproducible alternate orderings to try. */
function seededShuffle<T>(items: T[], seed: number): T[] {
  let s = (seed >>> 0) || 1;
  const next = () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(next() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/**
 * Where an NFP loop's edges cross the four lines bounding the feasible
 * reference-point rectangle. NFP *vertices* alone miss the spots a part
 * should slide to along an NFP edge until it meets the sheet edge: for a
 * rectangle at the origin the right-neighbour position (x just past it, y at
 * the bottom margin) lies mid-edge, not on a vertex, so every row after the
 * first got pushed up to the next NFP corner (17 of 30 rectangles per sheet).
 */
function boundaryCrossings(loop: Point[], minX: number, maxX: number, minY: number, maxY: number): Point[] {
  const out: Point[] = [];
  for (let i = 0; i < loop.length; i++) {
    const a = loop[i];
    const b = loop[(i + 1) % loop.length];
    for (const x of [minX, maxX]) {
      if ((a.x - x) * (b.x - x) < 0) out.push({ x, y: a.y + ((b.y - a.y) * (x - a.x)) / (b.x - a.x) });
    }
    for (const y of [minY, maxY]) {
      if ((a.y - y) * (b.y - y) < 0) out.push({ x: a.x + ((b.x - a.x) * (y - a.y)) / (b.y - a.y), y });
    }
  }
  return out;
}

export function nestTrueShape(parts: TrueNestPart[], stock: StockRow[], opts: TrueNestOptions = {}): TrueNestResult {
  const spacing = opts.spacing ?? 0;
  const margin = opts.edgeMargin ?? 0;
  const compareCandidates = gravityComparator(opts.gravity ?? "bottom-left");

  const unplacedCounts = new Map<string, number>();
  const addUnplaced = (partId: string) => unplacedCounts.set(partId, (unplacedCounts.get(partId) ?? 0) + 1);

  let instances: { part: TrueNestPart; area: number }[] = [];
  for (const part of parts) {
    const partArea = area(part.outer);
    for (let i = 0; i < part.quantity; i++) {
      if (instances.length >= MAX_INSTANCES) {
        addUnplaced(part.id);
        continue;
      }
      instances.push({ part, area: partArea });
    }
  }

  const order = opts.order ?? "area-desc";
  if (typeof order === "number") {
    instances = seededShuffle(instances, order);
  } else if (order === "area-asc") {
    instances.sort((a, b) => a.area - b.area);
  } else if (order === "bbox-desc") {
    const bboxArea = (p: TrueNestPart) => {
      const b = bounds(p.outer);
      return (b.maxX - b.minX) * (b.maxY - b.minY);
    };
    instances.sort((a, b) => bboxArea(b.part) - bboxArea(a.part));
  } else {
    instances.sort((a, b) => b.area - a.area);
  }

  const minHoleArea = opts.minHoleArea ?? 0;

  const stockUsed: number[] = stock.map(() => 0);
  const sheets: TrueNestSheet[] = [];
  const sheetItems: SheetItem[][] = [];
  // Parallel arrays — holeItems[i] is what's been placed inside holeRegions[i] so far.
  const holeRegions: HoleRegion[] = [];
  const holeItems: SheetItem[][] = [];
  const placed: TrueNestPlacement[] = [];
  const nfpCache = new NfpCache();
  let placedArea = 0;

  /** Tries every rotation candidate on one already-open sheet; returns the first accepted placement, or null. */
  function tryPlaceOnSheet(sheetIdx: number, part: TrueNestPart): { deg: number; mirrored: boolean; translation: Point; local: Point[] } | null {
    const sheet = sheets[sheetIdx];
    const placedHere = sheetItems[sheetIdx];

    for (const { deg, mirrored } of rotationCandidates(part.rotation, part.outer)) {
      const local = localFrame(part.outer, deg, mirrored);
      const box = bounds(local);
      const w = box.maxX - box.minX;
      const h = box.maxY - box.minY;
      const minX = margin;
      const minY = margin;
      const maxX = sheet.width - margin - w;
      const maxY = sheet.height - margin - h;
      if (maxX < minX - 1e-9 || maxY < minY - 1e-9) continue; // this rotation can't fit this sheet at all

      const orbitingKey = nfpKey(part.id, deg, mirrored);
      const candidates: Point[] = [
        { x: minX, y: minY },
        { x: maxX, y: minY },
        { x: maxX, y: maxY },
        { x: minX, y: maxY },
      ];
      const forbidden: Point[][] = [];
      for (const other of placedHere) {
        for (const loop of nfpCache.get(other.key, other.local, orbitingKey, local, spacing)) {
          const translated = loop.map((p) => ({ x: p.x + other.translation.x, y: p.y + other.translation.y }));
          forbidden.push(translated);
          candidates.push(...translated);
          candidates.push(...boundaryCrossings(translated, minX, maxX, minY, maxY));
        }
      }

      const valid = candidates.filter((p) => {
        if (p.x < minX - 1e-6 || p.x > maxX + 1e-6 || p.y < minY - 1e-6 || p.y > maxY + 1e-6) return false;
        return !forbidden.some((loop) => loop.length >= 3 && pointInPolygon(p, loop));
      });
      valid.sort(compareCandidates);

      for (const candidate of valid) {
        const placedPolygon = translate(local, candidate.x, candidate.y);
        // Safety net: NFP placement should already guarantee this, but never
        // emit an overlap even if a concave-shape edge case slips through.
        if (placedHere.some((other) => polygonsClash(placedPolygon, other.placedPolygon, spacing))) continue;
        if (!insideSheet(placedPolygon, sheet.width, sheet.height, margin)) continue;
        return { deg, mirrored, translation: candidate, local };
      }
    }
    return null;
  }

  function commitPlacement(sheetIdx: number, part: TrueNestPart, result: { deg: number; mirrored: boolean; translation: Point; local: Point[] }): void {
    sheetItems[sheetIdx].push({
      key: nfpKey(part.id, result.deg, result.mirrored),
      local: result.local,
      translation: result.translation,
      placedPolygon: translate(result.local, result.translation.x, result.translation.y),
    });
    placed.push({ partId: part.id, sheet: sheetIdx, rotationDeg: result.deg, mirrored: result.mirrored, translation: result.translation });
  }

  /** After a part with holes lands on a sheet (N-12): each hole, brought into sheet space and shrunk inward by spacing, becomes a free region `allowInHoles` parts can be tried in. Only for ordinary sheet placements — a part placed inside a hole doesn't itself offer its own holes as further nested regions. */
  function registerHoles(
    sheetIdx: number,
    part: TrueNestPart,
    result: { deg: number; mirrored: boolean; translation: Point; local: Point[] },
    containerPlacementIndex: number,
  ): void {
    if (part.holes.length === 0) return;
    const transform = placementTransform(part.outer, { rotationDeg: result.deg, mirrored: result.mirrored, translation: result.translation });
    for (const hole of part.holes) {
      const sheetHole = transformPolygon(hole, transform);
      // offsetPolygon's inward/outward sense follows the input's own winding
      // — force CCW first so a negative delta reliably shrinks, regardless
      // of which way the original entity happened to be drawn.
      const ccwHole = isCCW(sheetHole) ? sheetHole : [...sheetHole].reverse();
      const shrunk = spacing > 0 ? offsetPolygon(ccwHole, -spacing) : [ccwHole];
      for (const loop of shrunk) {
        if (loop.length < 3) continue;
        const loopArea = area(loop);
        if (loopArea < minHoleArea) continue;
        holeRegions.push({ sheet: sheetIdx, polygon: loop, area: loopArea, containerPlacementIndex });
        holeItems.push([]);
      }
    }
  }

  /** Tries every rotation candidate inside one available hole; returns the first accepted placement, or null. Mirrors `tryPlaceOnSheet`, but the boundary is an arbitrary polygon (`innerFit`) instead of a rectangle. */
  function tryPlaceInHole(holeIdx: number, part: TrueNestPart): { deg: number; mirrored: boolean; translation: Point; local: Point[] } | null {
    const hole = holeRegions[holeIdx];
    const placedHere = holeItems[holeIdx];

    for (const { deg, mirrored } of rotationCandidates(part.rotation, part.outer)) {
      const local = localFrame(part.outer, deg, mirrored);
      const fitLoops = innerFit(hole.polygon, local);
      if (fitLoops.length === 0) continue;

      const orbitingKey = nfpKey(part.id, deg, mirrored);
      const candidates: Point[] = fitLoops.flat();
      const forbidden: Point[][] = [];
      for (const other of placedHere) {
        for (const loop of nfpCache.get(other.key, other.local, orbitingKey, local, spacing)) {
          const translated = loop.map((p) => ({ x: p.x + other.translation.x, y: p.y + other.translation.y }));
          forbidden.push(translated);
          candidates.push(...translated);
        }
      }

      const valid = candidates.filter((p) => {
        if (!fitLoops.some((loop) => loop.length >= 3 && pointInOrOnPolygon(p, loop))) return false;
        return !forbidden.some((loop) => loop.length >= 3 && pointInPolygon(p, loop));
      });
      valid.sort(compareCandidates);

      for (const candidate of valid) {
        const placedPolygon = translate(local, candidate.x, candidate.y);
        // Safety net — doubly load-bearing here: innerFit's reversed-winding
        // technique can emit a spurious loop when the part doesn't actually
        // fit (no clean "no solution" case), so real containment against
        // the hole's own boundary is the only thing that can be trusted.
        if (!polygonContainsPolygon(hole.polygon, placedPolygon)) continue;
        if (placedHere.some((other) => polygonsClash(placedPolygon, other.placedPolygon, spacing))) continue;
        return { deg, mirrored, translation: candidate, local };
      }
    }
    return null;
  }

  function commitInHole(holeIdx: number, part: TrueNestPart, result: { deg: number; mirrored: boolean; translation: Point; local: Point[] }): void {
    holeItems[holeIdx].push({
      key: nfpKey(part.id, result.deg, result.mirrored),
      local: result.local,
      translation: result.translation,
      placedPolygon: translate(result.local, result.translation.x, result.translation.y),
    });
    placed.push({
      partId: part.id,
      sheet: holeRegions[holeIdx].sheet,
      rotationDeg: result.deg,
      mirrored: result.mirrored,
      translation: result.translation,
      insideOfPlacementIndex: holeRegions[holeIdx].containerPlacementIndex,
    });
  }

  for (const instance of instances) {
    const part = instance.part;
    let done = false;

    // N-12: an allowInHoles part tries every hole already opened up by an
    // earlier (bigger) placement before touching open sheet area at all.
    if (part.allowInHoles) {
      for (let holeIdx = 0; holeIdx < holeRegions.length && !done; holeIdx++) {
        const result = tryPlaceInHole(holeIdx, part);
        if (result) {
          commitInHole(holeIdx, part, result);
          placedArea += instance.area;
          done = true;
        }
      }
      if (done) continue;
    }

    for (let sheetIdx = 0; sheetIdx < sheets.length && !done; sheetIdx++) {
      const result = tryPlaceOnSheet(sheetIdx, part);
      if (result) {
        commitPlacement(sheetIdx, part, result);
        registerHoles(sheetIdx, part, result, placed.length - 1);
        placedArea += instance.area;
        done = true;
      }
    }
    if (done) continue;

    // Try opening a fresh sheet from stock — not just the first row with
    // room, but every row in order, since a part might not fit the first
    // available size but would fit a later, larger one.
    let opened = false;
    for (let i = 0; i < stock.length; i++) {
      const row = stock[i];
      if (row.qty !== null && stockUsed[i] >= row.qty) continue;
      const sheetIdx = sheets.length;
      sheets.push({ stockIndex: i, width: row.size.width, height: row.size.height });
      sheetItems.push([]);
      const result = tryPlaceOnSheet(sheetIdx, part);
      if (result) {
        commitPlacement(sheetIdx, part, result);
        registerHoles(sheetIdx, part, result, placed.length - 1);
        placedArea += instance.area;
        stockUsed[i] += 1;
        opened = true;
        break;
      }
      sheets.pop();
      sheetItems.pop();
    }
    if (!opened) addUnplaced(part.id);
  }

  // Post-pass (N-13): the last sheet often only needed a fraction of the
  // stock size it was opened from — swap it for the smallest size that
  // still fits everything actually placed on it. Only sheetItems needs
  // checking here, not holeItems too — anything placed inside a hole is by
  // construction nested inside the footprint of the part that hole belongs
  // to, which is already one of these sheetItems, so it can never extend
  // the sheet's used bounds beyond what sheetItems alone already covers.
  if (sheets.length > 0) {
    const lastIdx = sheets.length - 1;
    const lastItems = sheetItems[lastIdx];
    if (lastItems.length > 0) {
      const lastBounds: Bounds = bounds(lastItems.flatMap((item) => item.placedPolygon));
      const smaller = shrinkLastSheet(stock, stockUsed, sheets[lastIdx].stockIndex, lastBounds, margin);
      if (smaller !== null && smaller !== sheets[lastIdx].stockIndex) {
        stockUsed[sheets[lastIdx].stockIndex] -= 1;
        stockUsed[smaller] += 1;
        sheets[lastIdx] = { stockIndex: smaller, width: stock[smaller].size.width, height: stock[smaller].size.height };
      }
    }
  }

  const totalSheetArea = sheets.reduce((sum, s) => sum + s.width * s.height, 0);
  const unplaced = Array.from(unplacedCounts, ([partId, count]) => ({ partId, count }));

  return {
    sheets,
    placed,
    unplaced,
    utilisation: totalSheetArea > 0 ? placedArea / totalSheetArea : 0,
  };
}
