/**
 * Raster sheet-nesting engine (RN-01) - ported from the Sheet Nesting
 * Calculator by Oleksandr Borenko (TypeScript port of its `NestEngine.nest`).
 * Shapes are rasterised onto a grid (conservatively dilated by spacing/2),
 * placed first-fit with monotone scan pointers, and - given a time budget -
 * re-run as seeded random restarts, keeping the best by (unplaced, purchased
 * sheets, sheet area, last-sheet extent).
 *
 * Why it is worth testing: it is the default nesting engine. A regression
 * here silently produces overlapping parts or wasted sheets that only show
 * up at the laser. The bit tricks (Uint32 rows, 32 pre-shifted copies, the
 * `maxRun` pre-filter, bisecting probe order) are performance-critical and
 * easy to break without changing a small test's answer, which is why
 * `engine.test.ts` also compares against the reference when it is available.
 *
 * Unit-agnostic and DOM-free: every length (polygons, sheet, spacing, margin,
 * clamp, cell, arcTol) just has to share one unit. The plugin works in mm.
 * The whole algorithm lives in one generator (`nestSteps`) that yields once
 * per restart, so the sync driver ({@link nestRasterSync}) and the
 * cooperative async one ({@link nestRaster}, RN-03) cannot drift apart.
 */

/** [x, y] pair. */
export type RPoint = readonly [number, number];

export interface RasterPart {
  /** Closed contours (outer + holes, even-odd). Winding does not matter. */
  polys: RPoint[][];
  /** Allowed rotation angles, degrees. Placement picks among these. */
  rots: number[];
  qty: number;
  /** Net area, used for ordering and the area lower bound. */
  area: number;
}

export interface RasterSheetType {
  w: number;
  h: number;
  /** Omitted/null = unlimited. */
  qty?: number | null;
}

export interface RasterInput {
  parts: RasterPart[];
  /** Stock inventory. When empty, `sheetW` x `sheetH` (unlimited) is used. */
  sheetTypes?: RasterSheetType[];
  sheetW?: number;
  sheetH?: number;
  /** Unlimited "to purchase" sheet size, used after the stock runs out. */
  extra?: { w: number; h: number } | null;
  /** Gap between parts (kerf + web). */
  spacing: number;
  /** Gap from the sheet edge. */
  margin: number;
  /** Clamp strip width along one long edge. */
  clamp?: number;
  /** Grid cell size. */
  cell: number;
  /** Curve-flattening tolerance, added to the dilation. Default 0.002. */
  arcTol?: number;
  /** Time budget for random restarts; 0 = single deterministic pass. */
  timeMs?: number;
  /** Extra cap on restarts (test hook; the reference has none). */
  maxIterations?: number;
  seed?: number;
  /** First-pass criterion: 0 bottom edge, 1 top edge, 2 centre. */
  crit?: number;
}

export interface RasterPlacement {
  /** Part type index into `parts`. */
  t: number;
  deg: number;
  /** Translation to apply to the part polygon after rotating by `deg` about the origin. */
  tx: number;
  ty: number;
}

export interface RasterSheet {
  placements: RasterPlacement[];
  /** How far along the long axis the layout reaches, from the sheet edge. */
  extentIn: number;
  w: number;
  h: number;
  /** Index into [stock..., extra]. */
  tidx: number;
  extra: boolean;
}

export interface RasterBest {
  sheets: RasterSheet[];
  /** Part-type index per unplaced instance. */
  unplaced: number[];
}

export interface RasterResult extends RasterBest {
  ms: number;
  iterations: number;
  cell: number;
  lbSheets: number;
}

export interface RasterInfo {
  iter: number;
  ms: number;
  sheets?: number;
}

export interface RasterHooks {
  onBest?: (best: RasterBest, info: RasterInfo) => void;
  onTick?: (info: RasterInfo) => void;
  shouldStop?: () => boolean;
}

interface Mask {
  w: number;
  h: number;
  nw: number;
  shifted: Uint32Array[];
  order: number[];
  mrun: Uint16Array;
  Lu: number;
  Lv: number;
  deg: number;
}

interface SheetState {
  grid: Uint32Array;
  maxRun: Uint16Array;
  ptrV: Int32Array;
  ptrU: Int32Array;
  placements: RasterPlacement[];
  extent: number;
  ctx: Ctx;
  tidx: number;
}

interface Ctx {
  W: number;
  H: number;
  U: number;
  V: number;
  inset: number;
  newSheet(): SheetState;
  tryPlace(sh: SheetState, type: number, rnd: (() => number) | null, jit: number, crit: number, angMode: number): boolean;
  placeable: boolean[];
}

interface SType {
  w: number;
  h: number;
  qty: number;
  extra: boolean;
  ctx: Ctx;
  area: number;
}

interface Attempt {
  sheets: SheetState[];
  unp: number[];
  score: number;
}

/**
 * The algorithm as a generator: runs the deterministic first passes, then
 * yields after each time-budgeted restart so a driver can slice the work.
 * Returns the final result.
 */
export function* nestSteps(inp: RasterInput, hooks: RasterHooks = {}): Generator<void, RasterResult, void> {
  const t0 = Date.now();
  const cell = inp.cell, spacing = inp.spacing, margin = inp.margin, rTol = inp.arcTol || 0.002;
  const rMask = spacing / 2 + cell * 0.70711 + rTol;
  const parts = inp.parts;
  const nT = parts.length;

  // angle tables
  const taBase: number[] = [];
  let nTA = 0;
  for (let ti0 = 0; ti0 < nT; ti0++) { taBase.push(nTA); nTA += parts[ti0]!.rots.length; }

  function makeCtx(W: number, H: number): Ctx {
    const transposed = W > H; // long axis -> grid rows (v), short axis -> bits (u)
    const shortLen = transposed ? H : W, longLen = transposed ? W : H;
    const inset = margin - spacing / 2; // inflated shapes must stay inside the sheet inset by this
    const clampW = inp.clamp || 0; // clamp strip along ONE long edge (short-axis direction)
    const insetU = inset + (transposed ? clampW : 0); // transposed: strip on the low-u side, else on the high-u side
    const U = Math.floor((shortLen - 2 * inset - clampW) / cell + 1e-9);
    const V = Math.floor((longLen - 2 * inset) / cell + 1e-9);
    const masks: (Mask | false | undefined)[][] = parts.map((p) => new Array(p.rots.length));

    // ---------- mask construction ----------
    function buildMask(type: number, ai: number): Mask | false {
      const deg = parts[type]!.rots[ai]!, rad = deg * Math.PI / 180;
      let c = Math.cos(rad), s = Math.sin(rad);
      if (Math.abs(c) < 1e-12) c = 0;
      if (Math.abs(s) < 1e-12) s = 0;
      if (Math.abs(c - 1) < 1e-12) c = 1;
      if (Math.abs(c + 1) < 1e-12) c = -1;
      if (Math.abs(s - 1) < 1e-12) s = 1;
      if (Math.abs(s + 1) < 1e-12) s = -1;
      const P: [number, number][][] = parts[type]!.polys.map((poly) =>
        poly.map((p): [number, number] => {
          const x = p[0] * c - p[1] * s, y = p[0] * s + p[1] * c;
          return transposed ? [y, x] : [x, y];
        }));
      let minU = Infinity, maxU = -Infinity, minV = Infinity, maxV = -Infinity;
      for (const poly of P) for (const p of poly) {
        if (p[0] < minU) minU = p[0];
        if (p[0] > maxU) maxU = p[0];
        if (p[1] < minV) minV = p[1];
        if (p[1] > maxV) maxV = p[1];
      }
      const padCells = Math.ceil(rMask / cell) + 1;
      const Ou = minU - padCells * cell, Ov = minV - padCells * cell;
      const Wc = Math.ceil((maxU - Ou) / cell) + padCells + 1, Hc = Math.ceil((maxV - Ov) / cell) + padCells + 1;
      const rast = new Uint8Array(Wc * Hc);

      // even-odd fill of cell centres
      const edges: [[number, number], [number, number]][] = [];
      for (const poly of P) for (let i = 0, n = poly.length; i < n; i++) edges.push([poly[i]!, poly[(i + 1) % n]!]);
      for (let j = 0; j < Hc; j++) {
        const vc = Ov + (j + 0.5) * cell, xs: number[] = [];
        for (let e = 0; e < edges.length; e++) {
          const a = edges[e]![0], b = edges[e]![1];
          if ((a[1] <= vc) !== (b[1] <= vc)) xs.push(a[0] + (vc - a[1]) * (b[0] - a[0]) / (b[1] - a[1]));
        }
        xs.sort((p, q) => p - q);
        for (let k = 0; k + 1 < xs.length; k += 2) {
          const i0 = Math.max(0, Math.ceil((xs[k]! - Ou) / cell - 0.5)), i1 = Math.min(Wc - 1, Math.floor((xs[k + 1]! - Ou) / cell - 0.5));
          for (let ii = i0; ii <= i1; ii++) rast[j * Wc + ii] = 1;
        }
      }
      // proximity to the boundary (conservative dilation by rMask)
      const r2 = rMask * rMask, maxPiece = cell * 20;
      for (let e2 = 0; e2 < edges.length; e2++) {
        const A = edges[e2]![0], B = edges[e2]![1];
        const len = Math.hypot(B[0] - A[0], B[1] - A[1]);
        const np = Math.max(1, Math.ceil(len / maxPiece));
        for (let pc = 0; pc < np; pc++) {
          const ax = A[0] + (B[0] - A[0]) * pc / np, ay = A[1] + (B[1] - A[1]) * pc / np;
          const bx = A[0] + (B[0] - A[0]) * (pc + 1) / np, by = A[1] + (B[1] - A[1]) * (pc + 1) / np;
          const ci0 = Math.max(0, Math.floor((Math.min(ax, bx) - rMask - Ou) / cell)), ci1 = Math.min(Wc - 1, Math.ceil((Math.max(ax, bx) + rMask - Ou) / cell));
          const cj0 = Math.max(0, Math.floor((Math.min(ay, by) - rMask - Ov) / cell)), cj1 = Math.min(Hc - 1, Math.ceil((Math.max(ay, by) + rMask - Ov) / cell));
          const dx = bx - ax, dy = by - ay, dd = dx * dx + dy * dy;
          for (let cj = cj0; cj <= cj1; cj++) {
            const py = Ov + (cj + 0.5) * cell;
            for (let ci = ci0; ci <= ci1; ci++) {
              if (rast[cj * Wc + ci]) continue;
              const px = Ou + (ci + 0.5) * cell;
              let tt = dd > 0 ? ((px - ax) * dx + (py - ay) * dy) / dd : 0;
              if (tt < 0) tt = 0; else if (tt > 1) tt = 1;
              const qx = ax + tt * dx - px, qy = ay + tt * dy - py;
              if (qx * qx + qy * qy <= r2) rast[cj * Wc + ci] = 1;
            }
          }
        }
      }
      // crop
      let ciMin = Wc, ciMax = -1, cjMin = Hc, cjMax = -1;
      for (let y = 0; y < Hc; y++) for (let x = 0; x < Wc; x++) if (rast[y * Wc + x]) {
        if (x < ciMin) ciMin = x;
        if (x > ciMax) ciMax = x;
        if (y < cjMin) cjMin = y;
        if (y > cjMax) cjMax = y;
      }
      if (ciMax < 0) return false;
      const w = ciMax - ciMin + 1, h = cjMax - cjMin + 1;
      if (w > U || h > V) return false;
      const wBase = (w + 31) >> 5, nw = wBase + 1;
      const base = new Uint32Array(h * wBase), mrun = new Uint16Array(h);
      for (let r = 0; r < h; r++) {
        let run = 0, best = 0;
        for (let cI = 0; cI < w; cI++) {
          if (rast[(cjMin + r) * Wc + ciMin + cI]) { base[r * wBase + (cI >> 5)]! |= (1 << (cI & 31)); run++; if (run > best) best = run; }
          else run = 0;
        }
        mrun[r] = best;
      }
      const shifted: Uint32Array[] = new Array(32);
      for (let sh = 0; sh < 32; sh++) {
        const arr = new Uint32Array(h * nw);
        for (let rr = 0; rr < h; rr++) {
          let carry = 0;
          for (let jw = 0; jw < wBase; jw++) {
            const v = base[rr * wBase + jw]!;
            arr[rr * nw + jw] = ((v << sh) | carry) >>> 0;
            carry = sh === 0 ? 0 : (v >>> (32 - sh));
          }
          arr[rr * nw + wBase] = carry >>> 0;
        }
        shifted[sh] = arr;
      }
      // probe order spreading over the mask height
      const order: number[] = [], seen = new Uint8Array(h);
      const add = (i: number) => { if (!seen[i]) { seen[i] = 1; order.push(i); } };
      add(0); add(h - 1);
      const q: [number, number][] = [[0, h - 1]];
      while (q.length) {
        const it = q.shift()!;
        if (it[1] - it[0] < 2) continue;
        const m = (it[0] + it[1]) >> 1;
        add(m);
        q.push([it[0], m], [m, it[1]]);
      }
      return { w, h, nw, shifted, order, mrun, Lu: Ou + ciMin * cell, Lv: Ov + cjMin * cell, deg };
    }
    function getMask(type: number, ai: number): Mask | false {
      let m = masks[type]![ai];
      if (m === undefined) { m = buildMask(type, ai); masks[type]![ai] = m; }
      return m;
    }

    // which part types can be placed at all
    const placeable = parts.map((p, t) => {
      for (let a = 0; a < p.rots.length; a++) if (getMask(t, a)) return true;
      return false;
    });

    // ---------- sheets ----------
    const Uw = ((U + 31) >> 5) + 2;
    function newSheet(): SheetState {
      const grid = new Uint32Array(V * Uw);
      const tail = U & 31, wi = U >> 5;
      for (let r = 0; r < V; r++) {
        const b = r * Uw;
        if (tail) grid[b + wi] = (0xFFFFFFFF << tail) >>> 0;
        for (let j = tail ? wi + 1 : wi; j < Uw; j++) grid[b + j] = 0xFFFFFFFF;
      }
      const maxRun = new Uint16Array(V);
      maxRun.fill(Math.min(U, 65535));
      return { grid, maxRun, ptrV: new Int32Array(nTA), ptrU: new Int32Array(nTA), placements: [], extent: 0, ctx: undefined as unknown as Ctx, tidx: 0 };
    }
    function recomputeRun(sh: SheetState, row: number) {
      let best = 0, run = 0;
      const b = row * Uw, g = sh.grid;
      for (let w = 0; w < Uw; w++) {
        const v = g[b + w]!;
        if (v === 0) run += 32;
        else if (v === 0xFFFFFFFF) { if (run > best) best = run; run = 0; }
        else for (let k = 0; k < 32; k++) {
          if ((v >>> k) & 1) { if (run > best) best = run; run = 0; } else run++;
        }
      }
      if (run > best) best = run;
      sh.maxRun[row] = best > 65535 ? 65535 : best;
    }
    function find(sh: SheetState, mk: Mask, ti: number): boolean {
      let gv = sh.ptrV[ti]!, gu = sh.ptrU[ti]!;
      const maxV = V - mk.h, maxU = U - mk.w;
      const grid = sh.grid, run = sh.maxRun, order = mk.order, mrun = mk.mrun, nw = mk.nw, shifted = mk.shifted, oLen = order.length;
      for (; gv <= maxV; gv++, gu = 0) {
        let pass = true;
        for (let q = 0; q < oLen; q++) { const kk = order[q]!; if (run[gv + kk]! < mrun[kk]!) { pass = false; break; } }
        if (!pass) continue;
        for (let u = gu; u <= maxU; u++) {
          const wo = u >> 5, arr = shifted[u & 31]!;
          let ok = true;
          for (let q2 = 0; q2 < oLen; q2++) {
            const k = order[q2]!, gi = (gv + k) * Uw + wo, mi = k * nw;
            for (let j = 0; j < nw; j++) { if (grid[gi + j]! & arr[mi + j]!) { ok = false; break; } }
            if (!ok) break;
          }
          if (ok) { sh.ptrV[ti] = gv; sh.ptrU[ti] = u; return true; }
        }
      }
      sh.ptrV[ti] = maxV + 1; sh.ptrU[ti] = 0;
      return false;
    }
    function put(sh: SheetState, mk: Mask, gu: number, gv: number) {
      const wo = gu >> 5, arr = mk.shifted[gu & 31]!, nw = mk.nw, g = sh.grid;
      for (let k = 0; k < mk.h; k++) {
        const gi = (gv + k) * Uw + wo, mi = k * nw;
        for (let j = 0; j < nw; j++) g[gi + j]! |= arr[mi + j]!;
        recomputeRun(sh, gv + k);
      }
    }

    // angle subset flags: multiples of 90 deg (used by some restarts when many angles are allowed)
    const sub90 = parts.map((p) => {
      const f = p.rots.map((d) => ((d % 90) + 90) % 90 === 0);
      return f.some((x) => x) ? f : f.map(() => true);
    });
    function tryPlace(sh: SheetState, type: number, rnd: (() => number) | null, jit: number, crit: number, angMode: number): boolean {
      const nA = parts[type]!.rots.length;
      let best: { mk: Mask; ti: number; gu: number; gv: number; top: number } | null = null;
      let bestKey = Infinity, bestTop = Infinity;
      const start = rnd ? Math.floor(rnd() * nA) : 0;
      for (let aa = 0; aa < nA; aa++) {
        const ai = (aa + start) % nA;
        if (angMode === 1 && !sub90[type]![ai]) continue;
        const mk = getMask(type, ai);
        if (!mk) continue;
        const ti = taBase[type]! + ai;
        const off = crit === 1 ? 0 : crit === 2 ? mk.h / 2 : mk.h;
        if (sh.ptrV[ti]! + off > bestTop + jit) continue;
        if (!find(sh, mk, ti)) continue;
        const u = sh.ptrU[ti]!, keyv = sh.ptrV[ti]! + off;
        const key = keyv + u * 1e-6 + (jit ? rnd!() * jit : 0);
        if (key < bestKey) { bestKey = key; best = { mk, ti, gu: u, gv: sh.ptrV[ti]!, top: sh.ptrV[ti]! + mk.h }; if (keyv < bestTop) bestTop = keyv; }
      }
      if (!best) return false;
      put(sh, best.mk, best.gu, best.gv);
      const tu = insetU + best.gu * cell - best.mk.Lu, tv = inset + best.gv * cell - best.mk.Lv;
      sh.placements.push({ t: type, deg: best.mk.deg, tx: transposed ? tv : tu, ty: transposed ? tu : tv });
      if (best.top > sh.extent) sh.extent = best.top;
      return true;
    }

    return { W, H, U, V, inset, newSheet, tryPlace, placeable };
  }

  // ---------- sheet types (stock list; optional unlimited "extra" type for purchase) ----------
  const types: SType[] = (inp.sheetTypes && inp.sheetTypes.length)
    ? inp.sheetTypes.map((x) => ({ w: x.w, h: x.h, qty: x.qty === undefined || x.qty === null ? Infinity : x.qty, extra: false, ctx: undefined as unknown as Ctx, area: 0 }))
    : [{ w: inp.sheetW!, h: inp.sheetH!, qty: Infinity, extra: false, ctx: undefined as unknown as Ctx, area: 0 }];
  const nStock = types.length;
  if (inp.extra) types.push({ w: inp.extra.w, h: inp.extra.h, qty: Infinity, extra: true, ctx: undefined as unknown as Ctx, area: 0 });
  for (const tp of types) { tp.ctx = makeCtx(tp.w, tp.h); tp.area = tp.w * tp.h; }
  const placeableAny = parts.map((_p, t) => types.some((tp) => tp.ctx.placeable[t]));

  const unplaced0: number[] = [], inst: number[] = [];
  parts.forEach((p, t) => {
    for (let i = 0; i < p.qty; i++) { if (placeableAny[t]) inst.push(t); else unplaced0.push(t); }
  });
  if (!inst.length) return { sheets: [], unplaced: unplaced0, ms: Date.now() - t0, iterations: 0, cell, lbSheets: 0 };

  function attempt(order: number[], rnd: (() => number) | null, jit: number, crit: number, angMode: number, torder: number[]): Attempt {
    const sheets: SheetState[] = [], used = types.map(() => 0), unp: number[] = [];
    for (let oi = 0; oi < order.length; oi++) {
      const type = order[oi]!;
      let placed = false;
      for (let si = 0; si < sheets.length && !placed; si++) placed = sheets[si]!.ctx.tryPlace(sheets[si]!, type, rnd, jit, crit, angMode);
      if (!placed) {
        for (let ki = 0; ki < torder.length && !placed; ki++) {
          const k = torder[ki]!, tp = types[k]!;
          if (used[k]! >= tp.qty || !tp.ctx.placeable[type]) continue;
          const ns = tp.ctx.newSheet();
          ns.ctx = tp.ctx; ns.tidx = k;
          if (tp.ctx.tryPlace(ns, type, rnd, jit, crit, angMode)) { sheets.push(ns); used[k]!++; placed = true; }
        }
      }
      if (!placed) unp.push(type);
    }
    let area = 0, extra = 0;
    for (const sh of sheets) { area += types[sh.tidx]!.area; if (types[sh.tidx]!.extra) extra++; }
    const last = sheets.length ? sheets[sheets.length - 1]!.extent : 0;
    return { sheets, unp, score: unp.length * 1e18 + extra * 1e15 + Math.round(area) * 1e6 + last };
  }
  function pack(res: Attempt): RasterBest {
    return {
      sheets: res.sheets.map((s) => ({
        placements: s.placements, extentIn: s.extent * cell + s.ctx.inset, w: s.ctx.W, h: s.ctx.H, tidx: s.tidx, extra: !!types[s.tidx]!.extra,
      })),
      unplaced: unplaced0.concat(res.unp),
    };
  }
  const extraIdx = nStock < types.length ? [nStock] : [];
  const stockIdx: number[] = [];
  for (let si0 = 0; si0 < nStock; si0++) stockIdx.push(si0);
  const tAsc = () => stockIdx.slice().sort((a, b) => types[a]!.area - types[b]!.area || a - b).concat(extraIdx);
  const tDesc = () => stockIdx.slice().sort((a, b) => types[b]!.area - types[a]!.area || a - b).concat(extraIdx);

  let totalNet = 0;
  for (const t of inst) totalNet += parts[t]!.area;
  const lbSheets = (nStock === 1 && !extraIdx.length) ? Math.max(1, Math.ceil(totalNet / types[0]!.area)) : 0;

  const base = inst.slice().sort((a, b) => parts[b]!.area - parts[a]!.area || a - b);
  const crit0 = inp.crit === undefined ? 0 : inp.crit;
  let best = attempt(base, null, 0, crit0, 0, tAsc());
  let iter = 1;
  if (nStock > 1) {
    const r2 = attempt(base, null, 0, crit0, 0, tDesc());
    iter++;
    if (r2.score < best.score) best = r2;
  }
  hooks.onBest?.(pack(best), { iter, ms: Date.now() - t0 });

  let seed = (inp.seed || 12345) >>> 0;
  const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
  const shuffled = () => {
    const a = stockIdx.slice();
    for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)), x = a[i]!; a[i] = a[j]!; a[j] = x; }
    return a.concat(extraIdx);
  };
  const budget = inp.timeMs || 0;
  const maxIter = inp.maxIterations ?? Infinity;
  while (budget > 0 && iter < maxIter && Date.now() - t0 < budget && (best.sheets.length > lbSheets || best.unp.length)) {
    if (hooks.shouldStop?.()) break;
    const noise = 0.05 + rnd() * 0.5;
    const ord = base.map((t) => ({ t, k: parts[t]!.area * (1 + (rnd() - 0.5) * noise) }))
      .sort((a, b) => b.k - a.k).map((o) => o.t);
    const q = rnd();
    const torder = nStock === 1 ? tAsc() : q < 0.25 ? tAsc() : q < 0.5 ? tDesc() : shuffled();
    const res = attempt(ord, rnd, rnd() * 3, Math.floor(rnd() * 3), rnd() < 0.4 ? 1 : 0, torder);
    iter++;
    if (res.score < best.score) {
      best = res;
      hooks.onBest?.(pack(best), { iter, ms: Date.now() - t0 });
    } else if (hooks.onTick && iter % 5 === 0) hooks.onTick({ iter, ms: Date.now() - t0, sheets: best.sheets.length });
    yield;
  }
  const out = pack(best);
  return { ...out, ms: Date.now() - t0, iterations: iter, cell, lbSheets };
}

/** Synchronous run to completion (tests, tiny jobs). Honours `timeMs`. */
export function nestRasterSync(inp: RasterInput, hooks: RasterHooks = {}): RasterResult {
  const g = nestSteps(inp, hooks);
  for (;;) {
    const r = g.next();
    if (r.done) return r.value;
  }
}

export interface RasterAsyncHooks {
  onBest?: (best: RasterBest, info: RasterInfo) => void;
  onTick?: (info: RasterInfo) => void;
  /** Polled between restarts; true stops and returns the best so far. */
  isCancelled?: () => boolean;
  /** How often to hand the event loop back, ms. Default 50. */
  sliceMs?: number;
}

const macrotask = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

/**
 * Cooperative run (RN-03): same algorithm, but awaits a macrotask about every
 * `sliceMs` so a plugin worker can receive a cancel message mid-search. A
 * cancelled run resolves with the best layout found so far (never rejects).
 */
export async function nestRaster(inp: RasterInput, hooks: RasterAsyncHooks = {}): Promise<RasterResult> {
  const slice = hooks.sliceMs ?? 50;
  const g = nestSteps(inp, { onBest: hooks.onBest, onTick: hooks.onTick, shouldStop: hooks.isCancelled });
  let sliceStart = Date.now();
  for (;;) {
    const r = g.next();
    if (r.done) return r.value;
    if (Date.now() - sliceStart >= slice) {
      await macrotask();
      sliceStart = Date.now();
    }
  }
}
