import type { DimensionEntity } from "../entities";
import type { Point } from "../geometry";
import { arrowShape } from "./arrows";
import type { DimLayout } from "./layout";
import type { DimStyle } from "./style";

/**
 * D-05: leader / multileader / balloon layout. Pure like the rest of
 * `dimensions/`: canvas, SVG, PDF and the DXF writers all draw this one result.
 *
 * A leader is `defPoints` = [arrow tip, ...bends, attach]; extra `branches`
 * (multileader) are tip..bend runs that join the same attach point. From the
 * attach point a horizontal landing runs towards the side the line arrives
 * from, and the content (text, or a numbered balloon) sits at its end.
 */

const len = (a: Point, b: Point): number => Math.hypot(a.x - b.x, a.y - b.y);
const unit = (a: Point, b: Point): Point => {
  const l = len(a, b);
  return l < 1e-12 ? { x: 1, y: 0 } : { x: (b.x - a.x) / l, y: (b.y - a.y) / l };
};
const finite = (p: Point | undefined): boolean => !!p && Number.isFinite(p.x) && Number.isFinite(p.y);

/** Content as one plain line: MTEXT paragraph breaks become spaces and braces / simple codes are dropped. */
export function leaderPlainText(raw: string | undefined): string {
  if (!raw) return "";
  return raw
    .replace(/\\P/g, " ")
    .replace(/\\[A-Za-z][^;\\]*;/g, "")
    .replace(/\\([\\{}])/g, "$1")
    .replace(/[{}]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** Points of a run, smoothed through Catmull-Rom when `spline`. */
export function leaderRun(pts: Point[], spline: boolean): Point[] {
  if (!spline || pts.length < 3) return pts;
  const out: Point[] = [pts[0]];
  for (let i = 0; i + 1 < pts.length; i++) {
    const p0 = pts[Math.max(0, i - 1)];
    const p1 = pts[i];
    const p2 = pts[i + 1];
    const p3 = pts[Math.min(pts.length - 1, i + 2)];
    for (let s = 1; s <= 8; s++) {
      const t = s / 8;
      const t2 = t * t;
      const t3 = t2 * t;
      const f = (a: number, b: number, c: number, d: number) => 0.5 * (2 * b + (-a + c) * t + (2 * a - 5 * b + 4 * c - d) * t2 + (-a + 3 * b - 3 * c + d) * t3);
      out.push({ x: f(p0.x, p1.x, p2.x, p3.x), y: f(p0.y, p1.y, p2.y, p3.y) });
    }
  }
  return out;
}

export type BalloonShape = NonNullable<DimensionEntity["balloon"]>;

/** Closed outline of a balloon centred on `c` whose circumradius is `r`. */
export function balloonOutline(shape: BalloonShape, c: Point, r: number): Point[] {
  const ngon = (n: number, rot: number, rr: number): Point[] => {
    const out: Point[] = [];
    for (let i = 0; i <= n; i++) {
      const a = rot + (i / n) * Math.PI * 2;
      out.push({ x: c.x + rr * Math.cos(a), y: c.y + rr * Math.sin(a) });
    }
    return out;
  };
  switch (shape) {
    case "circle":
      return ngon(48, 0, r);
    case "hexagon":
      return ngon(6, 0, r);
    case "triangle":
      return ngon(3, Math.PI / 2, r * 1.9);
    case "square":
      return [{ x: c.x - r, y: c.y - r }, { x: c.x + r, y: c.y - r }, { x: c.x + r, y: c.y + r }, { x: c.x - r, y: c.y + r }, { x: c.x - r, y: c.y - r }];
  }
}

/** Which way (+1 right / -1 left) the content lies from the attach point. */
export function leaderSide(pts: Point[]): 1 | -1 {
  const n = pts.length;
  if (n < 2) return 1;
  return pts[n - 1].x - pts[n - 2].x < -1e-9 ? -1 : 1;
}

/** Highest balloon number already used in `entities` (non-numeric content ignored), for auto-numbering. */
export function nextBalloonNumber(entities: Iterable<{ type: string; balloon?: unknown; textOverride?: string }>): number {
  let max = 0;
  for (const e of entities) {
    if (e.type !== "dimension" || !e.balloon) continue;
    const n = Number(leaderPlainText(e.textOverride));
    if (Number.isInteger(n) && n > max) max = n;
  }
  return max + 1;
}

export function layoutLeader(e: DimensionEntity, st: DimStyle, k: number, pts: Point[]): DimLayout {
  const empty: DimLayout = { lines: [], fills: [], text: null, measure: NaN };
  if (pts.length < 2 || !pts.every(finite)) return empty;
  const lines: Point[][] = [];
  const fills: Point[][] = [];
  const spline = !!e.leaderSpline;
  const arrowKind = st.leaderArrow || st.arrow;
  const size = st.arrowSize * k;
  const attach = pts[pts.length - 1];
  const branches = (e.branches ?? []).filter((b) => b.length >= 1 && b.every(finite));
  const runs: Point[][] = [pts, ...branches.map((b) => [...b, attach])];
  for (const run of runs) {
    lines.push(leaderRun(run, spline));
    const a = arrowShape(arrowKind, run[0], unit(run[0], run[1]), size, st.arrowAngle);
    lines.push(...a.lines);
    fills.push(...a.fills);
  }
  const content = leaderPlainText(e.textOverride);
  const side = leaderSide(pts);
  const landing = e.landing !== undefined ? Math.max(0, e.landing) : 2 * size;
  let end = attach;
  if (landing > 0 && (content || e.balloon)) {
    end = { x: attach.x + side * landing, y: attach.y };
    lines.push([attach, end]);
  }
  if (!content) return { lines, fills, text: null, measure: 0, anchor: attach };
  const h = st.textHeight * k;
  const gap = st.gap * k;
  const w = content.length * h * 0.55;
  if (e.balloon) {
    const r = Math.max(w / 2, h / 2) + gap + h * 0.25;
    const c = { x: end.x + side * r, y: end.y };
    lines.push(balloonOutline(e.balloon, c, r));
    return { lines, fills, text: { at: c, text: content, height: h, rotation: 0, width: w }, measure: 0, anchor: attach };
  }
  const at = { x: end.x + side * (gap + w / 2), y: end.y };
  return { lines, fills, text: { at, text: content, height: h, rotation: 0, width: w }, measure: 0, anchor: attach };
}
