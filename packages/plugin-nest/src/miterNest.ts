import { planBars, type BarStock, type PlannedBar, type TubeProfile } from "./barCutting";

/**
 * NT-05: cutting stock with mitred ends - tube and bar pieces whose ends are
 * cut at an angle (a 45-degree picture-frame piece, a parallelogram brace).
 *
 * Seen from the side, with the bar along x and its depth D (the profile
 * dimension in the plane of the mitre) along y, a piece is a trapezoid: its
 * left and right ends are straight lines x = x0 + y*t, t = tan(angle). A
 * mitred end needs D*tan(angle) of bar beyond the piece's short point. Two
 * neighbours whose touching ends are parallel share one cut and waste only
 * the kerf, so how the pieces are ordered and turned decides how much bar a
 * job takes: a frame piece (\_/) followed by the same piece turned upside
 * down (/^\) nests with no wedge between them. Each piece may be turned end
 * for end and/or rolled 180 degrees about the bar axis (upside down) - what a
 * tube laser or a saw operator does with it.
 *
 * Plan: a first pass gives each piece its length at mid-depth (what it costs
 * when its neighbours share its cuts) and fills bars with the 1D planner;
 * each bar is then sequenced exactly (greedy chain over pieces and the four
 * orientations, trying each piece type first, least wedge waste wins) and
 * any piece that no longer fits moves on to the next pass. Square-ended jobs
 * skip all of this and match `planBars` exactly.
 *
 * Angles in degrees from square, |angle| < 80. Positive = the end leans in
 * towards the other end going up (long point on the bottom face), so 45 / 45
 * is a frame piece and 45 / -45 a parallelogram. `length` is long point to
 * long point. All lengths mm. Never throws.
 */

export interface MiterItem {
  label: string;
  length: number;
  qty: number;
  /** Start / end angle from square, degrees. */
  a1?: number;
  a2?: number;
}

export interface MiterPlanOptions {
  kerf: number;
  trimStart: number;
  tail: number;
  /** Profile depth in the mitre plane, mm. */
  depth: number;
  /** Allow turning pieces end for end and upside down (default true). */
  allowTurn?: boolean;
  maxPieces?: number;
}

/** A piece's side view: x of its left and right ends at the bottom (y = 0) and top (y = D) faces. */
export interface PieceShape {
  l0: number;
  l1: number;
  r0: number;
  r1: number;
}

export interface MiterBarPiece {
  label: string;
  length: number;
  a1: number;
  a2: number;
  /** Turned end for end. */
  flipped: boolean;
  /** Rolled 180 degrees about the bar axis. */
  upsideDown: boolean;
  /** Where it sits on the bar (x from the bar's start). */
  shape: PieceShape;
}

export interface MiterBar extends PlannedBar {
  pieces: MiterBarPiece[];
  /** Every cut on this bar in order, as its angle from square (degrees): facing cut, separating cuts (one where neighbours share it), last end. */
  cutAngles: number[];
}

export interface MiterPlan {
  bars: MiterBar[];
  byStock: { length: number; stockIndex: number; count: number; cost: number | null }[];
  totalStockLength: number;
  totalPieceLength: number;
  utilisation: number;
  unplaced: { label: string; length: number; count: number }[];
  pieces: number;
  /** True when some piece has a mitred end. */
  mitred: boolean;
}

const MAX_ANGLE = 80;
const clampAngle = (a: number | undefined) => (Number.isFinite(a) ? Math.max(-MAX_ANGLE, Math.min(MAX_ANGLE, a as number)) : 0);
const tanDeg = (a: number) => Math.tan((a * Math.PI) / 180);
const EPS = 1e-6;

/** The side view of a piece, left end at x >= 0 touching 0. */
export function pieceShape(length: number, a1: number, a2: number, depth: number): PieceShape {
  const t1 = tanDeg(a1), t2 = tanDeg(a2), D = Math.max(0, depth);
  // left(y) = y*t1, right(y) = c - y*t2; long point to long point = max over y of (right - left).
  const c = t1 + t2 >= 0 ? length : length + D * (t1 + t2);
  const l0 = 0, l1 = D * t1, r0 = c, r1 = c - D * t2;
  const shift = -Math.min(l0, l1);
  return { l0: l0 + shift, l1: l1 + shift, r0: r0 + shift, r1: r1 + shift };
}

const flipX = (s: PieceShape): PieceShape => ({ l0: -s.r0, l1: -s.r1, r0: -s.l0, r1: -s.l1 });
const flipY = (s: PieceShape): PieceShape => ({ l0: s.l1, l1: s.l0, r0: s.r1, r1: s.r0 });
const shifted = (s: PieceShape, dx: number): PieceShape => ({ l0: s.l0 + dx, l1: s.l1 + dx, r0: s.r0 + dx, r1: s.r1 + dx });
const normalized = (s: PieceShape) => shifted(s, -Math.min(s.l0, s.l1));

/** The distinct orientations of a piece: as drawn, end for end, upside down, both. */
export function orientations(base: PieceShape, allowTurn: boolean): { shape: PieceShape; flipped: boolean; upsideDown: boolean }[] {
  const all = [
    { shape: base, flipped: false, upsideDown: false },
    ...(allowTurn
      ? [
          { shape: normalized(flipX(base)), flipped: true, upsideDown: false },
          { shape: normalized(flipY(base)), flipped: false, upsideDown: true },
          { shape: normalized(flipY(flipX(base))), flipped: true, upsideDown: true },
        ]
      : []),
  ];
  const out: typeof all = [];
  for (const o of all) {
    if (!out.some((x) => Math.abs(x.shape.l0 - o.shape.l0) < EPS && Math.abs(x.shape.l1 - o.shape.l1) < EPS && Math.abs(x.shape.r0 - o.shape.r0) < EPS && Math.abs(x.shape.r1 - o.shape.r1) < EPS)) out.push(o);
  }
  return out;
}

const angleOf = (dx: number, depth: number) => (depth > 0 ? (Math.atan2(dx, depth) * 180) / Math.PI : 0);

interface Unit {
  label: string;
  length: number;
  a1: number;
  a2: number;
  base: PieceShape;
}

/** Lays `units` on one bar in the best order / orientation found; returns the pieces placed, the bar length used and the cuts. */
export function sequenceBar(units: readonly Unit[], opts: { kerf: number; trimStart: number; depth: number; allowTurn: boolean }): { pieces: MiterBarPiece[]; used: number; cutAngles: number[] } {
  const D = opts.depth;
  const kerfFor = (t: number) => opts.kerf * Math.sqrt(1 + t * t);
  const run = (firstType: string | null) => {
    const left = [...units];
    const pieces: MiterBarPiece[] = [];
    // The bar's own start is square: a mitred first end is cut at the trim.
    let prev: PieceShape | null = null;
    while (left.length > 0) {
      let best: { i: number; o: ReturnType<typeof orientations>[number]; s: number; waste: number } | null = null;
      for (let i = 0; i < left.length; i++) {
        const u = left[i]!;
        if (prev === null && firstType !== null && `${u.label}|${u.length}|${u.a1}|${u.a2}` !== firstType) continue;
        // Identical units give identical candidates: try only the first of each run.
        if (left.findIndex((v) => v.label === u.label && v.length === u.length && v.a1 === u.a1 && v.a2 === u.a2) !== i) continue;
        for (const o of orientations(u.base, opts.allowTurn)) {
          let s: number, waste: number;
          if (prev === null) {
            s = opts.trimStart - Math.min(o.shape.l0, o.shape.l1);
            waste = (o.shape.l0 + o.shape.l1) / 2 + s - opts.trimStart;
          } else {
            const tPrev = D > 0 ? (prev.r1 - prev.r0) / D : 0, tNext = D > 0 ? (o.shape.l1 - o.shape.l0) / D : 0;
            const g = kerfFor(Math.max(Math.abs(tPrev), Math.abs(tNext)));
            s = Math.max(prev.r0 + g - o.shape.l0, prev.r1 + g - o.shape.l1);
            waste = (o.shape.l0 + s - prev.r0 + (o.shape.l1 + s - prev.r1)) / 2;
          }
          // Least wedge waste; then a frontier that is square or easy to match (smaller slope), then longer pieces first.
          const frontier = Math.abs(o.shape.r1 - o.shape.r0);
          const score = waste + frontier * 1e-6 - u.length * 1e-9;
          if (!best || score < best.waste - 1e-9) best = { i, o, s, waste: score };
        }
      }
      if (!best) break;
      const u = left.splice(best.i, 1)[0]!;
      const shape = shifted(best.o.shape, best.s);
      pieces.push({ label: u.label, length: u.length, a1: u.a1, a2: u.a2, flipped: best.o.flipped, upsideDown: best.o.upsideDown, shape });
      prev = shape;
    }
    const used = prev ? Math.max(prev.r0, prev.r1) : opts.trimStart;
    return { pieces, used, cutAngles: cutAnglesOf(pieces, D, opts.trimStart) };
  };
  const types = [...new Set(units.map((u) => `${u.label}|${u.length}|${u.a1}|${u.a2}`))];
  let best = run(null);
  if (types.length > 1 && types.length <= 12) {
    for (const t of types) {
      const r = run(t);
      if (r.used < best.used - 1e-9) best = r;
    }
  }
  return best;
}

/** Cuts on a laid bar: the first end when it is mitred or the bar is trimmed, one per boundary (two when the ends are not parallel), the last end. */
function cutAnglesOf(pieces: readonly MiterBarPiece[], D: number, trim: number): number[] {
  const cutAngles: number[] = [];
  pieces.forEach((p, k) => {
    const leftA = angleOf(p.shape.l1 - p.shape.l0, D), rightA = angleOf(p.shape.r1 - p.shape.r0, D);
    if (k === 0) {
      if (trim > 0 || Math.abs(leftA) > EPS) cutAngles.push(Math.abs(leftA));
    } else {
      const q = pieces[k - 1]!;
      const prevA = angleOf(q.shape.r1 - q.shape.r0, D);
      if (Math.abs(prevA - leftA) > 1e-6) cutAngles.push(Math.abs(leftA));
    }
    cutAngles.push(Math.abs(rightA));
  });
  return cutAngles;
}

/** A piece's side view in a given orientation, left end touching x = 0. */
export function orientedShape(length: number, a1: number, a2: number, depth: number, flipped: boolean, upsideDown: boolean): PieceShape {
  let s = pieceShape(length, clampAngle(a1), clampAngle(a2), depth);
  if (flipped) s = flipX(s);
  if (upsideDown) s = flipY(s);
  return normalized(s);
}

/**
 * Manual bar layout (NT-06): the pieces exactly in the order and orientation
 * given, each pushed against the one before (kerf apart, measured along the
 * bar on a slanted cut), the first against the end trim. No reordering - the
 * user arranged them; `used` says whether it still fits.
 */
export function layPieces(
  list: readonly { label: string; length: number; a1: number; a2: number; flipped: boolean; upsideDown: boolean }[],
  opts: { kerf: number; trimStart: number; depth: number },
): { pieces: MiterBarPiece[]; used: number; cutAngles: number[] } {
  const D = Math.max(0, opts.depth), kerf = Math.max(0, opts.kerf), trim = Math.max(0, opts.trimStart);
  const pieces: MiterBarPiece[] = [];
  let prev: PieceShape | null = null;
  for (const it of list) {
    const o = orientedShape(it.length, it.a1, it.a2, D, it.flipped, it.upsideDown);
    let s: number;
    if (prev === null) s = trim - Math.min(o.l0, o.l1);
    else {
      const tPrev = D > 0 ? (prev.r1 - prev.r0) / D : 0, tNext = D > 0 ? (o.l1 - o.l0) / D : 0;
      const g = kerf * Math.sqrt(1 + Math.max(tPrev * tPrev, tNext * tNext));
      s = Math.max(prev.r0 + g - o.l0, prev.r1 + g - o.l1);
    }
    const shape = shifted(o, s);
    pieces.push({ label: it.label, length: it.length, a1: clampAngle(it.a1), a2: clampAngle(it.a2), flipped: it.flipped, upsideDown: it.upsideDown, shape });
    prev = shape;
  }
  return { pieces, used: prev ? Math.max(prev.r0, prev.r1) : trim, cutAngles: cutAnglesOf(pieces, D, trim) };
}

export function planMiterBars(items: MiterItem[], stock: BarStock[], opts: MiterPlanOptions): MiterPlan {
  const D = Math.max(0, opts.depth || 0);
  const allowTurn = opts.allowTurn !== false;
  const kerf = Math.max(0, opts.kerf || 0), trim = Math.max(0, opts.trimStart || 0), tail = Math.max(0, opts.tail || 0);
  const clean = items
    .map((it) => ({ label: it.label, length: Number(it.length), qty: Math.floor(Number(it.qty)), a1: clampAngle(it.a1), a2: clampAngle(it.a2) }))
    .filter((it) => it.length > 0 && it.qty > 0);
  const mitred = D > 0 && clean.some((it) => Math.abs(it.a1) > EPS || Math.abs(it.a2) > EPS);
  const sq = (len: number): PieceShape => ({ l0: 0, l1: 0, r0: len, r1: len });

  if (!mitred) {
    // Square ends: the 1D planner as is, pieces laid end to end.
    const plan = planBars(clean, stock, { kerf, trimStart: trim, tail, maxPieces: opts.maxPieces });
    const bars: MiterBar[] = plan.bars.map((b) => {
      let x = trim;
      const pieces = b.cuts.map((c) => {
        const p: MiterBarPiece = { label: c.label, length: c.length, a1: 0, a2: 0, flipped: false, upsideDown: false, shape: shifted(sq(c.length), x) };
        x += c.length + kerf;
        return p;
      });
      return { ...b, pieces, cutAngles: [...(trim > 0 ? [0] : []), ...b.cuts.map(() => 0)] };
    });
    return { ...plan, bars, mitred: false };
  }

  const maxPieces = opts.maxPieces ?? 20000;
  let pending: Unit[] = [];
  for (const it of clean) {
    const base = pieceShape(it.length, it.a1, it.a2, D);
    for (let k = 0; k < it.qty && pending.length < maxPieces; k++) pending.push({ label: it.label, length: it.length, a1: it.a1, a2: it.a2, base });
  }
  const left = new Map<number, number>(stock.map((s, i) => [i, s.qty ?? Infinity]));
  const bars: MiterBar[] = [];
  const unplaced: Unit[] = [];
  /** Length a piece costs when its neighbours share its cuts: its length at mid-depth. */
  const midLen = (u: Unit) => ((u.base.r0 + u.base.r1) - (u.base.l0 + u.base.l1)) / 2;
  const keyOf = (u: Unit) => `${u.label}|${u.length}|${u.a1}|${u.a2}`;

  for (let pass = 0; pending.length > 0 && pass < 50; pass++) {
    // 1D fill on mid-depth lengths; a piece's full length (long point) must still fit a bar.
    const byKey = new Map<string, Unit[]>();
    for (const u of pending) {
      const k = keyOf(u);
      const list = byKey.get(k) ?? [];
      list.push(u);
      byKey.set(k, list);
    }
    const typeList = [...byKey.entries()];
    const avail = stock.map((s, i) => ({ ...s, qty: left.get(i) === Infinity ? null : (left.get(i) ?? 0) }));
    const plan = planBars(
      typeList.map(([, list], ti) => ({ label: `${ti}`, length: Math.max(midLen(list[0]!), 1e-3), qty: list.length })),
      avail,
      { kerf, trimStart: trim + D * 1.5, tail, maxPieces },
    );
    const next: Unit[] = [];
    for (const u of plan.unplaced) for (let k = 0; k < u.count; k++) unplaced.push(byKey.get(typeList[Number(u.label)]![0])![0]!);
    if (plan.bars.length === 0) break; // everything left is in plan.unplaced (counted above)
    const taken = new Map<string, number>();
    for (const b of plan.bars) {
      let units = b.cuts.map((c) => {
        const k = typeList[Number(c.label)]![0];
        const n = taken.get(k) ?? 0;
        taken.set(k, n + 1);
        return byKey.get(k)![n]!;
      });
      const cap = b.stockLength - tail;
      let seq = sequenceBar(units, { kerf, trimStart: trim, depth: D, allowTurn });
      while (seq.used > cap + 1e-9 && units.length > 0) {
        // Drop the shortest piece to the next pass and lay the rest again.
        let k = 0;
        units.forEach((u, i) => {
          if (u.length < units[k]!.length) k = i;
        });
        next.push(units[k]!);
        units = units.filter((_, i) => i !== k);
        seq = units.length > 0 ? sequenceBar(units, { kerf, trimStart: trim, depth: D, allowTurn }) : { pieces: [], used: trim, cutAngles: [] };
      }
      if (seq.pieces.length === 0) continue;
      left.set(b.stockIndex, (left.get(b.stockIndex) ?? 0) - 1);
      bars.push({
        stockLength: b.stockLength,
        stockIndex: b.stockIndex,
        cuts: seq.pieces.map((p) => ({ label: p.label, length: p.length })),
        used: seq.used,
        remnant: Math.max(0, b.stockLength - seq.used),
        pieces: seq.pieces,
        cutAngles: seq.cutAngles,
      });
    }
    if (next.length >= pending.length) {
      // No progress (a piece longer than any bar once mitred): stop.
      unplaced.push(...next);
      break;
    }
    pending = next;
  }

  // Move each bar onto the shortest stock that still holds it (the last bar is often mostly empty).
  for (const b of bars) {
    const fits = stock
      .map((s, i) => ({ s, i }))
      .filter(({ s, i }) => s.length < b.stockLength && (left.get(i) ?? 0) > 0 && b.used + tail <= s.length + 1e-9)
      .sort((x, y) => x.s.length - y.s.length)[0];
    if (!fits) continue;
    left.set(b.stockIndex, (left.get(b.stockIndex) ?? 0) + 1);
    left.set(fits.i, (left.get(fits.i) ?? 0) - 1);
    b.stockIndex = fits.i;
    b.stockLength = fits.s.length;
    b.remnant = Math.max(0, fits.s.length - b.used);
  }

  const byStockMap = new Map<number, { length: number; stockIndex: number; count: number; cost: number | null }>();
  for (const b of bars) {
    const s = stock[b.stockIndex]!;
    const e = byStockMap.get(b.stockIndex) ?? { length: b.stockLength, stockIndex: b.stockIndex, count: 0, cost: s.cost !== undefined ? 0 : null };
    e.count += 1;
    if (e.cost !== null && s.cost !== undefined) e.cost += s.cost;
    byStockMap.set(b.stockIndex, e);
  }
  const unplacedMap = new Map<string, { label: string; length: number; count: number }>();
  for (const u of unplaced) {
    const k = `${u.label}|${u.length}`;
    const g = unplacedMap.get(k);
    if (g) g.count++;
    else unplacedMap.set(k, { label: u.label, length: u.length, count: 1 });
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
    pieces: bars.reduce((n, b) => n + b.pieces.length, 0),
    mitred: true,
  };
}

/** Groups identical bars (same stock, same pieces in the same order and orientation). */
export function groupMiterBars(bars: MiterBar[]): { count: number; bar: MiterBar }[] {
  const out: { key: string; count: number; bar: MiterBar }[] = [];
  for (const b of bars) {
    const key = `${b.stockIndex}|${b.pieces.map((p) => `${p.label}:${p.length}:${p.a1}:${p.a2}:${p.flipped ? 1 : 0}${p.upsideDown ? 1 : 0}`).join(",")}`;
    const g = out.find((x) => x.key === key);
    if (g) g.count += 1;
    else out.push({ key, count: 1, bar: b });
  }
  return out.map(({ count, bar }) => ({ count, bar }));
}

/**
 * Head travel for one cut through the profile at `angle` from square, mm.
 * The faces the mitre runs across get longer by 1/cos(angle); a round tube's
 * cut is an ellipse (Ramanujan's perimeter).
 */
export function miterCutLength(p: TubeProfile, angleDeg: number, across: "a" | "b" = "b"): number {
  const k = 1 / Math.cos((Math.min(Math.abs(angleDeg), MAX_ANGLE) * Math.PI) / 180);
  const a = Math.max(0, p.a), b = Math.max(0, p.b ?? p.a);
  // `slanted` = the dimension in the mitre plane (cut on the faces that stretch), `square` = the other one.
  const slanted = across === "a" ? a : b, square = across === "a" ? b : a;
  switch (p.shape) {
    case "round": {
      const r1 = a / 2, r2 = (a / 2) * k;
      const h = ((r1 - r2) * (r1 - r2)) / ((r1 + r2) * (r1 + r2));
      return Math.PI * (r1 + r2) * (1 + (3 * h) / (10 + Math.sqrt(4 - 3 * h)));
    }
    case "square":
      return 2 * a + 2 * a * k;
    case "rect":
      return 2 * square + 2 * slanted * k;
    case "angle":
      return square + slanted * k;
    case "channel":
      return across === "a" ? a * k + 2 * b : a + 2 * b * k;
    case "flat":
      return a * (across === "a" ? k : 1);
  }
}

/** The profile's depth in the mitre plane (what a mitre spans along the bar). */
export function miterDepth(p: TubeProfile, across: "a" | "b" = "b"): number {
  const a = Math.max(0, p.a), b = Math.max(0, p.b ?? p.a);
  if (p.shape === "round" || p.shape === "square") return a;
  if (p.shape === "flat") return across === "a" ? a : Math.max(0, p.wall);
  return across === "a" ? a : b;
}
