import { entityPoints, textWidth, translated, type Entity } from "@sketchor/core";
import type { LastNestPlacement } from "./nestReport";

/**
 * Manual nesting on the layout tab. The layout draws every part as one group
 * (outline, holes and number), so the user picks a whole part up, drags it -
 * the host snaps it to the other parts and the sheet edge - and turns it with
 * the group's rotate handle (45-degree steps; Ctrl turns it freely) or the
 * panel's rotate buttons. Parts the nester could not fit, or that the user
 * deleted and asked back, wait in a "To nest" tray below the sheets.
 *
 * This module reads that drawing back:
 *  - where each part is now: the rigid move / turn / flip that carries the
 *    part as drawn onto its entities on the canvas (a least-squares fit over
 *    their anchor points), applied to the part's outline polygon;
 *  - which sheet it is on (the drawn sheet its box overlaps most; none = the
 *    tray), so a part dragged from one sheet to another, or out of the tray,
 *    moves with it;
 *  - what is wrong: parts that overlap (red), stick out of the sheet (red),
 *    sit in the edge margin or on the clamp strip, or come closer than the
 *    web gap (orange);
 *  - how many of each part are on sheets now - a drawing that stands for
 *    five identical sheets counts five - against how many were ordered, so a
 *    deleted part shows up as "one more to nest".
 *
 * Nothing here writes to the drawing: the flags are host highlight marks,
 * which never enter the undo history.
 */

type Pt = { x: number; y: number };

/** One drawn sheet (identical sheets share one drawing). */
export interface ManualSheet {
  /** The sheet that was drawn (the group's first). */
  sheet: number;
  /** Every sheet the drawing stands for. */
  indices: number[];
  outlineId: string;
  width: number;
  height: number;
  /** Edge margin, mm (parts inside it are flagged orange). */
  margin: number;
  /** The clamp strip, sheet-local, or null. */
  clampRect: { x: number; y: number; w: number; h: number } | null;
}

/** One part as drawn on the canvas. */
export interface ManualInstance {
  /** Stable for the life of the layout: the placement's id, or "t1", "t2"... for a tray part. */
  id: string;
  /** The placement as drawn: entities carry the ids that are on the canvas, in the frame given by `drawnAt`. */
  placement: LastNestPlacement;
  /** The part's outline and holes as polygons, same frame as `placement`'s entities. */
  outer: Pt[];
  holes: Pt[][];
  /** Canvas offset of that frame when drawn: the sheet's origin, or 0,0 for the tray (whose entities are already canvas coordinates). */
  drawnAt: Pt;
  /** The drawn sheet it started on, or -1 for the tray. */
  home: number;
}

export type ManualIssueKind = "overlap" | "off-sheet" | "margin" | "clamp" | "gap" | "reshaped";

export interface ManualIssue {
  instanceId: string;
  kind: ManualIssueKind;
  tone: "error" | "warn";
  /** The part's outline where it is now, canvas coordinates. */
  outline: Pt[];
  at: Pt;
  label: string;
}

export interface PartCount {
  partId: string;
  name: string;
  ordered: number;
  placed: number;
}

export interface ManualReadResult {
  /** False when no sheet of this layout is in the drawing - another tab is active, or the layout was deleted. */
  found: boolean;
  /** True when anything differs from the nest as calculated (a part moved, turned, deleted, or taken out of the tray). */
  changed: boolean;
  /** Parts that moved, turned, changed sheet or left the tray. */
  moved: number;
  /** Parts no longer on the canvas. */
  deleted: number;
  /** Every placement on every sheet, as the canvas has them now (identical sheets expanded). */
  placements: LastNestPlacement[];
  issues: ManualIssue[];
  counts: PartCount[];
  /** Per drawn sheet: how many parts it holds now. */
  perSheet: { sheet: number; parts: number }[];
  /** Instances in the tray (not on any sheet), by id. */
  inTray: string[];
}

const EPS = 1e-6;
/** Overlap below this (mm) is snapping round-off, not a clash. */
const OVERLAP_TOL = 0.01;

interface Rigid {
  /** p' = R(angle) * M(p - from) + to, M = mirror across the y axis when `mirrored`. */
  angle: number;
  mirrored: boolean;
  from: Pt;
  to: Pt;
  residual: number;
}

const applyRigid = (t: Rigid, p: Pt): Pt => {
  const x0 = (t.mirrored ? -1 : 1) * (p.x - t.from.x), y0 = p.y - t.from.y;
  const c = Math.cos(t.angle), s = Math.sin(t.angle);
  return { x: t.to.x + c * x0 - s * y0, y: t.to.y + s * x0 + c * y0 };
};

/** Points that move rigidly with an entity: a circle's quadrant points stay axis-aligned under rotation, so it contributes its centre instead. Lettering is skipped (it is re-made). */
function anchors(e: Entity): Pt[] {
  if (e.type === "text") return [];
  if (e.type === "circle") return [e.center];
  if (e.type === "arc") return [e.center, ...entityPoints(e)];
  return entityPoints(e);
}

/** Least-squares rigid fit (rotation, optional mirror, translation) of `src` onto `dst`, matched by index. */
export function fitRigid(src: readonly Pt[], dst: readonly Pt[]): Rigid {
  const n = Math.min(src.length, dst.length);
  if (n === 0) return { angle: 0, mirrored: false, from: { x: 0, y: 0 }, to: { x: 0, y: 0 }, residual: 0 };
  let sx = 0, sy = 0, dx = 0, dy = 0;
  for (let i = 0; i < n; i++) {
    sx += src[i]!.x; sy += src[i]!.y; dx += dst[i]!.x; dy += dst[i]!.y;
  }
  const from = { x: sx / n, y: sy / n }, to = { x: dx / n, y: dy / n };
  const solve = (mirrored: boolean): Rigid => {
    let a = 0, b = 0;
    for (let i = 0; i < n; i++) {
      const px = (mirrored ? -1 : 1) * (src[i]!.x - from.x), py = src[i]!.y - from.y;
      const qx = dst[i]!.x - to.x, qy = dst[i]!.y - to.y;
      a += px * qx + py * qy;
      b += px * qy - py * qx;
    }
    const angle = Math.abs(a) < EPS && Math.abs(b) < EPS ? 0 : Math.atan2(b, a);
    const t: Rigid = { angle, mirrored, from, to, residual: 0 };
    let r = 0;
    for (let i = 0; i < n; i++) {
      const q = applyRigid(t, src[i]!);
      r = Math.max(r, Math.hypot(q.x - dst[i]!.x, q.y - dst[i]!.y));
    }
    t.residual = r;
    return t;
  };
  const plain = solve(false);
  if (plain.residual < 1e-4 || n < 3) return plain;
  const flipped = solve(true);
  return flipped.residual < plain.residual - 1e-6 ? flipped : plain;
}

const bboxOf = (pts: readonly Pt[]) => {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of pts) {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }
  return { minX, minY, maxX, maxY };
};

function pointInPoly(p: Pt, poly: readonly Pt[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i]!, b = poly[j]!;
    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

function segDist(a: Pt, b: Pt, c: Pt, d: Pt): number {
  const ptSeg = (p: Pt, s: Pt, e: Pt) => {
    const vx = e.x - s.x, vy = e.y - s.y, l2 = vx * vx + vy * vy;
    const t = l2 > 0 ? Math.max(0, Math.min(1, ((p.x - s.x) * vx + (p.y - s.y) * vy) / l2)) : 0;
    return Math.hypot(p.x - (s.x + t * vx), p.y - (s.y + t * vy));
  };
  const cross = (o: Pt, p: Pt, q: Pt) => (p.x - o.x) * (q.y - o.y) - (p.y - o.y) * (q.x - o.x);
  const d1 = cross(c, d, a), d2 = cross(c, d, b), d3 = cross(a, b, c), d4 = cross(a, b, d);
  if (((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))) return 0;
  return Math.min(ptSeg(a, c, d), ptSeg(b, c, d), ptSeg(c, a, b), ptSeg(d, a, b));
}

/** Smallest distance between two polygon boundaries (0 when the edges cross). */
function boundaryDistance(a: readonly Pt[], b: readonly Pt[], stopBelow: number): number {
  let best = Infinity;
  for (let i = 0; i < a.length; i++) {
    const a1 = a[i]!, a2 = a[(i + 1) % a.length]!;
    for (let j = 0; j < b.length; j++) {
      const d = segDist(a1, a2, b[j]!, b[(j + 1) % b.length]!);
      if (d < best) {
        best = d;
        if (best < stopBelow) return best;
      }
    }
  }
  return best;
}

/** A point well inside the polygon (not on its edge): the box centre if inside, else the first edge midpoint nudged inwards. */
function innerPoint(poly: readonly Pt[]): Pt {
  const b = bboxOf(poly);
  const c = { x: (b.minX + b.maxX) / 2, y: (b.minY + b.maxY) / 2 };
  if (pointInPoly(c, poly)) return c;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i]!, q = poly[(i + 1) % poly.length]!;
    const m = { x: (a.x + q.x) / 2, y: (a.y + q.y) / 2 };
    const nx = -(q.y - a.y), ny = q.x - a.x, l = Math.hypot(nx, ny) || 1;
    for (const sgn of [1, -1]) {
      const p = { x: m.x + (sgn * nx * 1e-3) / l, y: m.y + (sgn * ny * 1e-3) / l };
      if (pointInPoly(p, poly)) return p;
    }
  }
  return poly[0] ?? c;
}

interface Shape {
  outer: Pt[];
  holes: Pt[][];
  box: ReturnType<typeof bboxOf>;
}

/**
 * How two parts relate: "overlap" when their material overlaps (one inside a
 * hole of the other is fine), "gap" when they come closer than `gap`, null
 * when they are clear.
 */
export function shapeClash(a: Shape, b: Shape, gap: number): "overlap" | "gap" | null {
  const reach = Math.max(gap, OVERLAP_TOL);
  if (a.box.maxX + reach < b.box.minX || b.box.maxX + reach < a.box.minX || a.box.maxY + reach < b.box.minY || b.box.maxY + reach < a.box.minY) return null;
  const inHoleOf = (inner: Shape, outer: Shape): Pt[] | null => {
    const p = innerPoint(inner.outer);
    return outer.holes.find((h) => pointInPoly(p, h)) ?? null;
  };
  // Material of one inside the other's outline - unless it sits in one of its holes.
  for (const [x, y] of [[a, b], [b, a]] as const) {
    if (pointInPoly(innerPoint(x.outer), y.outer)) {
      const hole = inHoleOf(x, y);
      if (!hole) return "overlap";
      const d = boundaryDistance(x.outer, hole, OVERLAP_TOL);
      if (d < OVERLAP_TOL) return "overlap";
      return gap > 0 && d < gap - 1e-6 ? "gap" : null;
    }
  }
  const d = boundaryDistance(a.outer, b.outer, OVERLAP_TOL);
  if (d < OVERLAP_TOL) {
    // Edges touching (a snapped, shared edge) is not an overlap; edges crossing is. Test a little inside each along the contact.
    return crosses(a.outer, b.outer) ? "overlap" : gap > 0 ? "gap" : null;
  }
  return gap > 0 && d < gap - 1e-6 ? "gap" : null;
}

/** Proper crossing of two boundaries (touching or shared edges do not count), or a vertex strictly inside the other polygon. */
function crosses(a: readonly Pt[], b: readonly Pt[]): boolean {
  const cross = (o: Pt, p: Pt, q: Pt) => (p.x - o.x) * (q.y - o.y) - (p.y - o.y) * (q.x - o.x);
  const tol = 1e-7;
  for (let i = 0; i < a.length; i++) {
    const a1 = a[i]!, a2 = a[(i + 1) % a.length]!;
    for (let j = 0; j < b.length; j++) {
      const b1 = b[j]!, b2 = b[(j + 1) % b.length]!;
      const scale = Math.max(1, Math.hypot(a2.x - a1.x, a2.y - a1.y) * Math.hypot(b2.x - b1.x, b2.y - b1.y));
      const d1 = cross(b1, b2, a1) / scale, d2 = cross(b1, b2, a2) / scale, d3 = cross(a1, a2, b1) / scale, d4 = cross(a1, a2, b2) / scale;
      if (((d1 > tol && d2 < -tol) || (d1 < -tol && d2 > tol)) && ((d3 > tol && d4 < -tol) || (d3 < -tol && d4 > tol))) return true;
    }
  }
  // A vertex well inside the other (the case of a part laid exactly over another, edges coincident).
  const deep = (p: readonly Pt[], q: readonly Pt[]) => {
    const c = innerPoint(p);
    return pointInPoly(c, q) && boundaryDistance([c, c, c], q, OVERLAP_TOL) > OVERLAP_TOL;
  };
  return deep(a, b) || deep(b, a);
}

function rectContains(r: { x: number; y: number; w: number; h: number }, box: ReturnType<typeof bboxOf>, tol = 1e-6): boolean {
  return box.minX >= r.x - tol && box.minY >= r.y - tol && box.maxX <= r.x + r.w + tol && box.maxY <= r.y + r.h + tol;
}
function rectsOverlap(r: { x: number; y: number; w: number; h: number }, box: ReturnType<typeof bboxOf>, tol = 1e-6): boolean {
  return box.maxX > r.x + tol && box.minX < r.x + r.w - tol && box.maxY > r.y + tol && box.minY < r.y + r.h - tol;
}

/** "Part 3 - Bracket overlaps #5" and friends; short, the host caps a label at 40 characters. */
const ISSUE_TEXT: Record<ManualIssueKind, string> = {
  overlap: "overlaps",
  "off-sheet": "off the sheet",
  margin: "in the edge margin",
  clamp: "on the clamp strip",
  gap: "closer than the web gap",
  reshaped: "shape was edited",
};

/**
 * Reads the layout back from the drawing. `ordered` is how many of each part
 * the job asks for (by part id), for the to-nest / extra counts.
 */
export function readManualNest(
  instances: readonly ManualInstance[],
  sheets: readonly ManualSheet[],
  doc: ReadonlyMap<string, Entity>,
  opts: { gap: number; ordered: ReadonlyMap<string, { name: string; qty: number }> },
): ManualReadResult {
  const origins = new Map<number, Pt>();
  for (const s of sheets) {
    const o = doc.get(s.outlineId);
    if (!o) continue;
    const b = bboxOf(entityPoints(o));
    if (Number.isFinite(b.minX)) origins.set(s.sheet, { x: b.minX, y: b.minY });
  }
  const found = origins.size > 0;
  const issues: ManualIssue[] = [];
  let moved = 0, deleted = 0;

  interface Now {
    inst: ManualInstance;
    sheet: ManualSheet | null;
    /** Canvas coordinates. */
    canvas: Shape;
    entities: { outer: Entity[]; holes: Entity[] };
    fit: Rigid;
    /** Moved, turned or flipped by hand, or taken to another sheet / the tray. */
    moved: boolean;
  }
  const now: Now[] = [];
  for (const inst of instances) {
    const outerE = inst.placement.outerEntities.map((e) => doc.get(e.id));
    const holeE = inst.placement.holeEntities.map((e) => doc.get(e.id));
    if (outerE.length === 0 || outerE.some((e) => !e) || holeE.some((e) => !e)) {
      deleted++;
      continue;
    }
    const drawn = [...inst.placement.outerEntities, ...inst.placement.holeEntities].map((e) => translated(e, inst.drawnAt.x, inst.drawnAt.y));
    const cur = [...outerE, ...holeE] as Entity[];
    const src: Pt[] = [], dst: Pt[] = [];
    drawn.forEach((e, i) => {
      const a = anchors(e), b = anchors(cur[i]!);
      if (a.length !== b.length) return;
      src.push(...a);
      dst.push(...b);
    });
    const fit = fitRigid(src, dst);
    const shift = (p: Pt) => applyRigid(fit, { x: p.x + inst.drawnAt.x, y: p.y + inst.drawnAt.y });
    const outer = inst.outer.map(shift);
    const canvas: Shape = { outer, holes: inst.holes.map((h) => h.map(shift)), box: bboxOf(outer) };
    // The sheet the part's box overlaps most; none = the tray.
    let best: ManualSheet | null = null, bestArea = 0;
    for (const s of sheets) {
      const o = origins.get(s.sheet);
      if (!o) continue;
      const w = Math.min(canvas.box.maxX, o.x + s.width) - Math.max(canvas.box.minX, o.x);
      const h = Math.min(canvas.box.maxY, o.y + s.height) - Math.max(canvas.box.minY, o.y);
      if (w > EPS && h > EPS && w * h > bestArea) {
        bestArea = w * h;
        best = s;
      }
    }
    const n: Now = { inst, sheet: best, canvas, entities: { outer: outerE as Entity[], holes: holeE as Entity[] }, fit, moved: false };
    n.moved = best === null ? inst.home !== -1 : best.sheet !== inst.home || !sameSpot(n, origins.get(best.sheet)!);
    if (n.moved) moved++;
    now.push(n);
    const scale = Math.max(1, n.canvas.box.maxX - n.canvas.box.minX, n.canvas.box.maxY - n.canvas.box.minY);
    if (fit.residual > Math.max(0.05, scale * 1e-4)) {
      issues.push({ instanceId: inst.id, kind: "reshaped", tone: "warn", outline: outer, at: { x: canvas.box.minX, y: canvas.box.maxY }, label: `#${inst.placement.number} ${ISSUE_TEXT.reshaped}` });
    }
  }

  // Issues per drawn sheet: overlaps / web gap between parts, edges, margin, clamp.
  for (const s of sheets) {
    const o = origins.get(s.sheet);
    if (!o) continue;
    const on = now.filter((n) => n.sheet === s).sort((a, b) => a.canvas.box.minX - b.canvas.box.minX);
    const sheetRect = { x: o.x, y: o.y, w: s.width, h: s.height };
    const flagged = new Set<string>();
    const flag = (n: Now, kind: ManualIssueKind, tone: "error" | "warn", extra = "") => {
      const key = `${n.inst.id}|${kind}`;
      if (flagged.has(key)) return;
      flagged.add(key);
      issues.push({ instanceId: n.inst.id, kind, tone, outline: n.canvas.outer, at: { x: n.canvas.box.minX, y: n.canvas.box.maxY }, label: `#${n.inst.placement.number} ${ISSUE_TEXT[kind]}${extra}` });
    };
    // The soft (orange) rules flag only parts placed by hand: the engines keep them already, give or take their own rounding.
    for (const n of on) {
      if (!rectContains(sheetRect, n.canvas.box)) flag(n, "off-sheet", "error");
      else if (n.moved && s.margin > 0 && !rectContains({ x: o.x + s.margin, y: o.y + s.margin, w: s.width - 2 * s.margin, h: s.height - 2 * s.margin }, n.canvas.box)) flag(n, "margin", "warn");
      if (n.moved && s.clampRect && rectsOverlap({ x: o.x + s.clampRect.x, y: o.y + s.clampRect.y, w: s.clampRect.w, h: s.clampRect.h }, n.canvas.box)) flag(n, "clamp", "warn");
    }
    const reach = Math.max(opts.gap, OVERLAP_TOL);
    for (let i = 0; i < on.length; i++) {
      const a = on[i]!;
      for (let j = i + 1; j < on.length; j++) {
        const b = on[j]!;
        if (b.canvas.box.minX > a.canvas.box.maxX + reach) break;
        const c = shapeClash(a.canvas, b.canvas, opts.gap);
        if (c === "overlap") {
          flag(a, "overlap", "error", ` #${b.inst.placement.number}`);
          flag(b, "overlap", "error", ` #${a.inst.placement.number}`);
        } else if (c === "gap" && (a.moved || b.moved)) {
          flag(a, "gap", "warn");
          flag(b, "gap", "warn");
        }
      }
    }
  }
  // An overlap outranks the softer flags on the same part: keep one mark per part, the worst.
  const rank: Record<ManualIssueKind, number> = { overlap: 0, "off-sheet": 1, clamp: 2, margin: 3, gap: 4, reshaped: 5 };
  const worst = new Map<string, ManualIssue>();
  for (const i of issues) {
    const cur = worst.get(i.instanceId);
    if (!cur || rank[i.kind] < rank[cur.kind]) worst.set(i.instanceId, i);
  }

  // The placements as the canvas has them, every sheet of a group getting the drawing's parts.
  const placements: LastNestPlacement[] = [];
  const placedByPart = new Map<string, number>();
  const perSheet: { sheet: number; parts: number }[] = [];
  const inTray: string[] = [];
  for (const n of now) if (!n.sheet) inTray.push(n.inst.id);
  for (const s of sheets) {
    const o = origins.get(s.sheet);
    const on = o ? now.filter((n) => n.sheet === s) : [];
    perSheet.push({ sheet: s.sheet, parts: on.length });
    for (const n of on) {
      const p = n.inst.placement;
      const local = (e: Entity, like: Entity) => ({ ...translated(e, -o!.x, -o!.y), layer: like.layer });
      const outer = n.entities.outer.map((e, i) => local(e, p.outerEntities[i]!));
      const holes = n.entities.holes.map((e, i) => local(e, p.holeEntities[i]!));
      const box = bboxOf(n.canvas.outer);
      const h = p.label.height;
      const cx = (box.minX + box.maxX) / 2 - o!.x, cy = (box.minY + box.maxY) / 2 - o!.y;
      const turn = (n.fit.angle * 180) / Math.PI;
      // Placement = mirror then rotate; a new flip composes as R(turn) M R(rot) M0 = R(turn - rot) (M M0).
      const mirrored = n.fit.mirrored ? !p.mirrored : p.mirrored;
      const rot = n.fit.mirrored ? turn - p.rotationDeg : p.rotationDeg + turn;
      const rotationDeg = Math.round((((rot % 360) + 360) % 360) * 100) / 100 % 360;
      s.indices.forEach((sheetIndex, k) => {
        placements.push({
          ...p,
          sheet: sheetIndex,
          id: k === 0 ? p.id : `${p.id}~${k}`,
          insideOfId: p.insideOfId && k > 0 ? `${p.insideOfId}~${k}` : p.insideOfId,
          outerEntities: outer.map((e) => (k === 0 ? e : { ...e, id: `${e.id}~${k}` })),
          holeEntities: holes.map((e) => (k === 0 ? e : { ...e, id: `${e.id}~${k}` })),
          label: { at: { x: cx - textWidth(String(p.number), h) / 2, y: cy - h / 2 }, height: h },
          rotationDeg,
          mirrored,
        });
      });
      placedByPart.set(p.partId, (placedByPart.get(p.partId) ?? 0) + s.indices.length);
    }
  }
  placements.sort((a, b) => a.sheet - b.sheet || a.number - b.number);

  const counts: PartCount[] = [...opts.ordered].map(([partId, o]) => ({ partId, name: o.name, ordered: o.qty, placed: placedByPart.get(partId) ?? 0 }));
  return {
    found,
    changed: moved > 0 || deleted > 0,
    moved,
    deleted,
    placements,
    issues: [...worst.values()],
    counts,
    perSheet,
    inTray,
  };

  function sameSpot(n: Now, origin: Pt): boolean {
    // Unmoved = the fit is the identity once the sheet's own move is taken out.
    const home = sheets.find((s) => s.sheet === n.inst.home);
    if (!home) return false;
    const drawnOrigin = n.inst.drawnAt;
    const t = n.fit;
    if (t.mirrored || Math.abs(Math.sin(t.angle)) > 1e-9 || Math.cos(t.angle) < 0) return false;
    const shiftX = t.to.x - t.from.x, shiftY = t.to.y - t.from.y;
    return Math.abs(shiftX - (origin.x - drawnOrigin.x)) < 1e-6 && Math.abs(shiftY - (origin.y - drawnOrigin.y)) < 1e-6;
  }
}

/**
 * Where the tray goes and where each part in it sits: rows below the sheets'
 * lettering, left to right, wrapping at `width`. Returns each item's offset
 * (to add to its geometry drawn at the origin) and the tray's top-left.
 */
export function trayPositions(sizes: readonly { w: number; h: number }[], top: number, width: number, gap: number): { offsets: Pt[]; at: Pt; bottom: number } {
  const offsets: Pt[] = [];
  let x = 0, rowTop = top, rowH = 0;
  for (const s of sizes) {
    if (x > 0 && x + s.w > width) {
      x = 0;
      rowTop -= rowH + gap;
      rowH = 0;
    }
    offsets.push({ x, y: rowTop - s.h });
    x += s.w + gap;
    rowH = Math.max(rowH, s.h);
  }
  return { offsets, at: { x: 0, y: top }, bottom: rowTop - rowH };
}

/** The highlight marks for a read: each flagged part tinted red (or orange), labelled. */
export function issueMarks(issues: readonly ManualIssue[]): { at: Pt; label: string; outline: Pt[]; tone: "error" | "warn" }[] {
  return issues.map((i) => ({ at: i.at, label: i.label, outline: simplifyOutline(i.outline), tone: i.tone }));
}

/** Keeps an outline under the host's per-mark point cap. */
function simplifyOutline(pts: readonly Pt[], max = 1500): Pt[] {
  if (pts.length <= max) return [...pts];
  const step = pts.length / max;
  const out: Pt[] = [];
  for (let i = 0; i < max; i++) out.push(pts[Math.floor(i * step)]!);
  return out;
}
