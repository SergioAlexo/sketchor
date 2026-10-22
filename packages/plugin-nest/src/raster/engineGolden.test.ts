/**
 * Golden + invariant tests for the raster engine (RN-02).
 *
 * Why it matters: the TypeScript port must keep behaving exactly like the
 * reference calculator it came from, and - independent of any reference -
 * must never emit a layout with parts closer than the requested spacing,
 * outside the margin / clamp strip, or with instances lost. A silent
 * regression here means overlapping cuts on a real sheet.
 *
 * Two layers:
 *  - Invariants: always run, over several synthetic jobs.
 *  - Golden: runs only when SKETCHOR_NEST_REFERENCE points at the reference
 *    HTML (kept outside the repo). The engine source embedded in it is
 *    evaluated and its placements compared with ours on the same jobs. A
 *    fake clock advancing one tick per Date.now() call makes the
 *    time-budgeted runs reproducible (both engines read the clock at the same
 *    points).
 */
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { nestRasterSync, type RasterInput, type RasterResult, type RPoint } from "./engine";

const rect = (w: number, h: number): RPoint[] => [[0, 0], [w, 0], [w, h], [0, h]];
const lshape = (s: number, t: number): RPoint[] => [[0, 0], [s, 0], [s, t], [t, t], [t, s], [0, s]];
const circle = (r: number, n = 48): RPoint[] =>
  Array.from({ length: n }, (_, i) => [r + r * Math.cos((2 * Math.PI * i) / n), r + r * Math.sin((2 * Math.PI * i) / n)] as RPoint);
const circleAt = (cx: number, cy: number, r: number, n = 32): RPoint[] =>
  Array.from({ length: n }, (_, i) => [cx + r * Math.cos((2 * Math.PI * i) / n), cy + r * Math.sin((2 * Math.PI * i) / n)] as RPoint);

const A4 = [0, 90, 180, 270];
const base = { spacing: 3, margin: 6, cell: 2.5, arcTol: 0.05, timeMs: 0, seed: 12345 };

interface NamedJob { name: string; inp: RasterInput }
const jobs: NamedJob[] = [
  { name: "rects", inp: { ...base, sheetW: 500, sheetH: 300, parts: [
    { polys: [rect(120, 60)], rots: [0, 90], qty: 8, area: 7200 },
    { polys: [rect(40, 40)], rots: [0], qty: 10, area: 1600 },
  ] } },
  { name: "L-shape", inp: { ...base, sheetW: 400, sheetH: 400, parts: [
    { polys: [lshape(150, 50)], rots: A4, qty: 6, area: 150 * 50 + 100 * 50 } ,
  ] } },
  { name: "ring with hole + small part", inp: { ...base, sheetW: 175, sheetH: 175, parts: [
    { polys: [circle(80), circleAt(80, 80, 55)], rots: [0], qty: 1, area: Math.PI * (80 * 80 - 55 * 55) },
    { polys: [circle(15)], rots: [0], qty: 2, area: Math.PI * 225 },
  ] } },
  { name: "mixed rotation sets", inp: { ...base, sheetW: 600, sheetH: 350, parts: [
    { polys: [lshape(90, 30)], rots: [0, 45, 90, 135, 180, 225, 270, 315], qty: 5, area: 90 * 30 + 60 * 30 },
    { polys: [rect(70, 25)], rots: [0, 15, 30, 45, 60, 75, 90], qty: 7, area: 1750 },
    { polys: [rect(33, 33)], rots: [0], qty: 6, area: 1089 },
  ] } },
  { name: "stock with qty + purchase type", inp: { ...base, sheetTypes: [{ w: 300, h: 200, qty: 1 }, { w: 250, h: 250, qty: 2 }], extra: { w: 400, h: 300 }, parts: [
    { polys: [rect(110, 70)], rots: [0, 90], qty: 40, area: 7700 },
    { polys: [rect(50, 50)], rots: [0], qty: 6, area: 2500 },
  ] } },
  { name: "clamp strip, wide sheet", inp: { ...base, sheetW: 700, sheetH: 300, clamp: 40, parts: [
    { polys: [rect(100, 100)], rots: [0, 90], qty: 9, area: 10000 },
  ] } },
  { name: "clamp strip, tall sheet", inp: { ...base, sheetW: 300, sheetH: 700, clamp: 40, parts: [
    { polys: [rect(100, 100)], rots: [0, 90], qty: 9, area: 10000 },
  ] } },
  { name: "small budget restarts", inp: { ...base, sheetW: 350, sheetH: 250, timeMs: 150, parts: [
    { polys: [lshape(100, 35)], rots: A4, qty: 7, area: 100 * 35 + 65 * 35 },
    { polys: [rect(45, 80)], rots: [0, 90], qty: 7, area: 3600 },
    { polys: [circle(22)], rots: [0], qty: 5, area: Math.PI * 484 },
  ] } },
  { name: "single-pass with budget 0", inp: { ...base, sheetW: 350, sheetH: 250, timeMs: 0, parts: [
    { polys: [rect(45, 80)], rots: [0, 90], qty: 9, area: 3600 },
  ] } },
];

// ---------- geometry helpers for the invariants ----------

function place(inp: RasterInput, r: RasterResult, sheet: number, i: number): RPoint[][] {
  const pl = r.sheets[sheet]!.placements[i]!;
  const rad = (pl.deg * Math.PI) / 180;
  const c = Math.cos(rad), s = Math.sin(rad);
  return inp.parts[pl.t]!.polys.map((poly) => poly.map((p): RPoint => [p[0] * c - p[1] * s + pl.tx, p[0] * s + p[1] * c + pl.ty]));
}

function segDist(a: RPoint, b: RPoint, c: RPoint, d: RPoint): number {
  const cross = (o: RPoint, p: RPoint, q: RPoint) => (p[0] - o[0]) * (q[1] - o[1]) - (p[1] - o[1]) * (q[0] - o[0]);
  const d1 = cross(c, d, a), d2 = cross(c, d, b), d3 = cross(a, b, c), d4 = cross(a, b, d);
  if (d1 * d2 < 0 && d3 * d4 < 0) return 0;
  const ptSeg = (p: RPoint, s: RPoint, e: RPoint) => {
    const dx = e[0] - s[0], dy = e[1] - s[1], dd = dx * dx + dy * dy;
    let t = dd > 0 ? ((p[0] - s[0]) * dx + (p[1] - s[1]) * dy) / dd : 0;
    t = Math.max(0, Math.min(1, t));
    return Math.hypot(s[0] + t * dx - p[0], s[1] + t * dy - p[1]);
  };
  return Math.min(ptSeg(a, c, d), ptSeg(b, c, d), ptSeg(c, a, b), ptSeg(d, a, b));
}

function contourDist(P: RPoint[][], Q: RPoint[][]): number {
  let m = Infinity;
  for (const p of P) for (const q of Q) for (let i = 0; i < p.length; i++) for (let j = 0; j < q.length; j++) {
    m = Math.min(m, segDist(p[i]!, p[(i + 1) % p.length]!, q[j]!, q[(j + 1) % q.length]!));
  }
  return m;
}

describe("raster engine invariants", () => {
  for (const { name, inp } of jobs) {
    it(`${name}: counts conserved, clearance >= spacing, inside margin/clamp`, () => {
      const r = nestRasterSync({ ...inp, maxIterations: 30 });
      const want = inp.parts.reduce((n, p) => n + p.qty, 0);
      const got = r.sheets.reduce((n, s) => n + s.placements.length, 0) + r.unplaced.length;
      expect(got).toBe(want);

      const eps = 1e-6;
      r.sheets.forEach((sh, si) => {
        const polys = sh.placements.map((_, i) => place(inp, r, si, i));
        const clamp = inp.clamp ?? 0;
        // clamp strip: low-y side on wide sheets, high-x side on tall ones (the engine's long axis runs along rows)
        const minX = inp.margin, maxX = sh.w - inp.margin - (sh.w > sh.h ? 0 : clamp);
        const minY = inp.margin + (sh.w > sh.h ? clamp : 0), maxY = sh.h - inp.margin;
        for (const P of polys) for (const c of P) for (const p of c) {
          expect(p[0]).toBeGreaterThanOrEqual(minX - eps);
          expect(p[0]).toBeLessThanOrEqual(maxX + eps);
          expect(p[1]).toBeGreaterThanOrEqual(minY - eps);
          expect(p[1]).toBeLessThanOrEqual(maxY + eps);
        }
        for (let i = 0; i < polys.length; i++) for (let j = i + 1; j < polys.length; j++) {
          expect(contourDist(polys[i]!, polys[j]!)).toBeGreaterThanOrEqual(inp.spacing - eps);
        }
      });
    });
  }

  it("ring + small part: a small part lands inside the ring's hole", () => {
    const inp = jobs[2]!.inp;
    const r = nestRasterSync(inp);
    const sh = r.sheets[0]!;
    const ringIdx = sh.placements.findIndex((p) => p.t === 0);
    const ring = place(inp, r, 0, ringIdx);
    const hole = ring[1]!;
    const cx = hole.reduce((a, p) => a + p[0], 0) / hole.length, cy = hole.reduce((a, p) => a + p[1], 0) / hole.length;
    const inHole = sh.placements.some((p, i) => {
      if (p.t !== 1) return false;
      const pts = place(inp, r, 0, i)[0]!;
      return pts.every((q) => Math.hypot(q[0] - cx, q[1] - cy) < 55);
    });
    expect(inHole).toBe(true);
  });

  it("uses purchased sheets only after the stock is exhausted", () => {
    const r = nestRasterSync(jobs[4]!.inp);
    const flags = r.sheets.map((s) => s.extra);
    expect(flags.some(Boolean)).toBe(true);
    expect(r.sheets.filter((s) => s.tidx === 0).length).toBeLessThanOrEqual(1);
    expect(r.sheets.filter((s) => s.tidx === 1).length).toBeLessThanOrEqual(2);
  });
});

// ---------- golden comparison against the reference ----------

const refPath = process.env.SKETCHOR_NEST_REFERENCE;

describe.skipIf(!refPath)("raster engine vs reference", () => {
  afterEach(() => vi.restoreAllMocks());

  function loadReference(): { nest(inp: unknown, hooks?: unknown): RasterResult } {
    const html = readFileSync(refPath!, "utf8");
    const open = '<script type="text/plain" id="engineSrc">';
    const a = html.indexOf(open);
    const b = html.indexOf("<\\/script>", a);
    if (a < 0 || b < 0) throw new Error("engineSrc block not found in reference");
    const src = html.slice(a + open.length, b);
    return new Function(src + "; return NestEngine;")();
  }

  function fakeClock() {
    let t = 1_000_000;
    vi.spyOn(Date, "now").mockImplementation(() => t++);
  }

  for (const { name, inp } of jobs) {
    it(`${name}: placements identical`, () => {
      const ref = loadReference();
      fakeClock();
      const expected = ref.nest(JSON.parse(JSON.stringify(inp)));
      fakeClock();
      const actual = nestRasterSync(inp);
      expect(actual.unplaced).toEqual(expected.unplaced);
      expect(actual.iterations).toBe(expected.iterations);
      expect(actual.lbSheets).toBe(expected.lbSheets);
      expect(actual.sheets.map((s) => ({ ...s, placements: s.placements }))).toEqual(expected.sheets);
    });
  }
});
