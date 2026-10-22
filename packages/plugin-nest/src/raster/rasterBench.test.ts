/**
 * Raster vs True-shape (NFP) benchmark (RN-05).
 *
 * Why it matters: the panel offers two engines, and its one-line hint on
 * which to pick has to come from measurements, not belief. Set
 * `SKETCHOR_NEST_BENCH=1` to print the comparison table (sheets, utilisation,
 * time) - the numbers are recorded in docs/raster-nesting-plan.md. The
 * always-on test only checks that both engines place a small job completely,
 * so the harness itself cannot rot.
 */
import { describe, expect, it } from "vitest";
import type { StockRow } from "../stock";
import { nestTrueShapeSearch } from "../search";
import type { TrueNestPart } from "../trueNest";
import type { Point } from "../types";
import { nestRasterMm } from "./rasterNest";

const rect = (w: number, h: number): Point[] => [{ x: 0, y: 0 }, { x: w, y: 0 }, { x: w, y: h }, { x: 0, y: h }];
const lshape = (s: number, t: number): Point[] => [{ x: 0, y: 0 }, { x: s, y: 0 }, { x: s, y: t }, { x: t, y: t }, { x: t, y: s }, { x: 0, y: s }];
const circle = (cx: number, cy: number, r: number, n = 36): Point[] =>
  Array.from({ length: n }, (_, i) => ({ x: cx + r * Math.cos((2 * Math.PI * i) / n), y: cy + r * Math.sin((2 * Math.PI * i) / n) }));
const part = (id: string, outer: Point[], quantity: number, holes: Point[][] = [], mode: "locked" | "quarter" = "quarter"): TrueNestPart =>
  ({ id, name: id, outer, holes, quantity, rotation: { mode } });
const stock = (w: number, h: number): StockRow[] => [{ size: { name: "S", width: w, height: h }, qty: null }];

interface BenchJob { name: string; parts: TrueNestPart[]; stock: StockRow[] }
const JOBS: BenchJob[] = [
  { name: "60 rects 100x60, 600x400", parts: [part("R", rect(100, 60), 60)], stock: stock(600, 400) },
  { name: "few large parts (14 L 400/150, 1500x1000)", parts: [part("L", lshape(400, 150), 14)], stock: stock(1500, 1000) },
  { name: "mixed rect+L+disc (3 sizes, 2000x1000)", parts: [part("A", rect(220, 140), 24), part("B", lshape(160, 50), 30), part("C", circle(40, 40, 40), 42)], stock: stock(2000, 1000) },
  { name: "ring+plugs (hole filling, 1500x1000)", parts: [part("ring", circle(200, 200, 200), 6, [circle(200, 200, 150)], "locked"), part("plug", circle(40, 40, 40), 36, [], "locked")], stock: stock(1500, 1000) },
  { name: "150 small tags 60x25, 400x300", parts: [part("T", rect(60, 25), 150)], stock: stock(400, 300) },
  { name: "600 identical 80x40, 1500x1000 (NFP cap)", parts: [part("X", rect(80, 40), 600)], stock: stock(1500, 1000) },
];

interface Row { sheets: number; util: number; unplaced: number; ms: number }
const OPTS = { spacing: 3, edgeMargin: 5 };

function netArea(parts: TrueNestPart[], ids: Map<string, number>): number {
  let a = 0;
  for (const p of parts) {
    const poly = (q: Point[]) => Math.abs(q.reduce((s, c, i) => { const n = q[(i + 1) % q.length]!; return s + c.x * n.y - n.x * c.y; }, 0)) / 2;
    a += (poly(p.outer) - p.holes.reduce((s, h) => s + poly(h), 0)) * (ids.get(p.id) ?? 0);
  }
  return a;
}

function summarise(job: BenchJob, placed: { partId: string }[], sheets: { width: number; height: number }[], unplaced: number, ms: number): Row {
  const counts = new Map<string, number>();
  for (const p of placed) counts.set(p.partId, (counts.get(p.partId) ?? 0) + 1);
  const sheetArea = sheets.reduce((s, x) => s + x.width * x.height, 0);
  return { sheets: sheets.length, util: sheetArea > 0 ? netArea(job.parts, counts) / sheetArea : 0, unplaced, ms };
}

async function runNfp(job: BenchJob, level: "quick" | "normal"): Promise<Row> {
  const t0 = Date.now();
  const { result } = await nestTrueShapeSearch(job.parts, job.stock, { ...OPTS, level });
  return summarise(job, result.placed, result.sheets, result.unplaced.reduce((n, u) => n + u.count, 0), Date.now() - t0);
}
function runRaster(job: BenchJob, timeMs: number): Row {
  const t0 = Date.now();
  const r = nestRasterMm(job.parts, job.stock, { ...OPTS, accuracy: "normal", timeMs });
  return summarise(job, r.placed, r.sheets, r.unplaced.reduce((n, u) => n + u.count, 0), Date.now() - t0);
}

describe("raster vs true-shape harness", () => {
  it("both engines place a small job completely", async () => {
    const job: BenchJob = { name: "tiny", parts: [part("R", rect(100, 60), 6)], stock: stock(500, 300) };
    expect((await runNfp(job, "quick")).unplaced).toBe(0);
    expect(runRaster(job, 0).unplaced).toBe(0);
  });
});

describe.skipIf(!process.env.SKETCHOR_NEST_BENCH)("raster vs true-shape benchmark", () => {
  it("prints the comparison table", async () => {
    const fmt = (r: Row) => `${String(r.sheets).padStart(2)} sh  ${(r.util * 100).toFixed(1).padStart(5)}%  ${String(r.unplaced).padStart(3)} unpl  ${String(r.ms).padStart(6)} ms`;
    const lines: string[] = [];
    for (const job of JOBS) {
      lines.push(job.name);
      lines.push(`  NFP quick     ${fmt(await runNfp(job, "quick"))}`);
      lines.push(`  raster 1-pass ${fmt(runRaster(job, 0))}`);
      lines.push(`  NFP normal    ${fmt(await runNfp(job, "normal"))}`);
      lines.push(`  raster 3 s    ${fmt(runRaster(job, 3000))}`);
    }
    console.log("\n" + lines.join("\n"));
  }, 600_000);
});
