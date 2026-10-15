import type { Point } from "../geometry";
import type { ArrowKind } from "./style";

/**
 * Arrow heads as geometry. `tip` is the point the arrow touches (an extension
 * line, a circle), `dir` the unit vector from the tip along the arrow's body.
 * Filled shapes go to `fills`, outlines and strokes to `lines`.
 */
export interface ArrowShape {
  lines: Point[][];
  fills: Point[][];
}

function ring(c: Point, r: number, n = 20): Point[] {
  const out: Point[] = [];
  for (let i = 0; i <= n; i++) {
    const t = (i / n) * Math.PI * 2;
    out.push({ x: c.x + Math.cos(t) * r, y: c.y + Math.sin(t) * r });
  }
  return out;
}

/** True for kinds that sit across the dimension line and so want it extended past the tip (DIMDLE). */
export function isStrokeArrow(kind: ArrowKind): boolean {
  return kind === "tick" || kind === "oblique";
}

export function arrowShape(kind: ArrowKind, tip: Point, dir: Point, size: number, angleDeg: number): ArrowShape {
  if (kind === "none" || size <= 0) return { lines: [], fills: [] };
  const n = { x: -dir.y, y: dir.x };
  const at = (along: number, side: number): Point => ({ x: tip.x + dir.x * along + n.x * side, y: tip.y + dir.y * along + n.y * side });
  const halfFor = (deg: number): number => Math.tan((Math.max(1, Math.min(120, deg)) * Math.PI) / 360) * size;
  const half = halfFor(angleDeg);
  switch (kind) {
    case "closed":
      return { lines: [], fills: [[tip, at(size, half), at(size, -half), tip]] };
    case "closedBlank":
      return { lines: [[tip, at(size, half), at(size, -half), tip]], fills: [] };
    case "closedFilled30": {
      const h = halfFor(30);
      return { lines: [], fills: [[tip, at(size, h), at(size, -h), tip]] };
    }
    case "open":
      return { lines: [[at(size, half), tip, at(size, -half)]], fills: [] };
    case "open30": {
      const h = halfFor(30);
      return { lines: [[at(size, h), tip, at(size, -h)]], fills: [] };
    }
    case "right": {
      const h = halfFor(90);
      return { lines: [[at(size, h), tip, at(size, -h)]], fills: [] };
    }
    case "tick": {
      // Architectural tick: a heavy stroke through the tip, 45 degrees to the line (a thin filled bar, so it prints heavy).
      const s = Math.SQRT1_2 * size * 0.5;
      const w = size * 0.1;
      const d = { x: dir.x + n.x, y: dir.y + n.y };
      const a = { x: tip.x + d.x * s, y: tip.y + d.y * s };
      const b = { x: tip.x - d.x * s, y: tip.y - d.y * s };
      const nn = { x: (-d.y * w) / Math.SQRT2, y: (d.x * w) / Math.SQRT2 };
      return { lines: [], fills: [[{ x: a.x + nn.x, y: a.y + nn.y }, { x: b.x + nn.x, y: b.y + nn.y }, { x: b.x - nn.x, y: b.y - nn.y }, { x: a.x - nn.x, y: a.y - nn.y }]] };
    }
    case "oblique": {
      const s = Math.SQRT1_2 * size * 0.5;
      const a = { x: tip.x + (dir.x + n.x) * s, y: tip.y + (dir.y + n.y) * s };
      const b = { x: tip.x - (dir.x + n.x) * s, y: tip.y - (dir.y + n.y) * s };
      return { lines: [[a, b]], fills: [] };
    }
    case "integral": {
      // An integral-sign stroke: a slanted line with a small hook at each end.
      const s = size * 0.5;
      const t = { x: dir.x * 0.5 + n.x * 0.866, y: dir.y * 0.5 + n.y * 0.866 };
      const a = { x: tip.x + t.x * s, y: tip.y + t.y * s };
      const b = { x: tip.x - t.x * s, y: tip.y - t.y * s };
      const hook = size * 0.18;
      return { lines: [[{ x: a.x + dir.x * hook, y: a.y + dir.y * hook }, { x: a.x - n.x * hook * 0.4, y: a.y - n.y * hook * 0.4 }, a, b, { x: b.x - n.x * hook * 0.4, y: b.y - n.y * hook * 0.4 }, { x: b.x - dir.x * hook, y: b.y - dir.y * hook }]], fills: [] };
    }
    case "datumFilled":
    case "datumBlank": {
      const h = size * 0.5;
      const tri = [tip, at(size, h), at(size, -h), tip];
      return kind === "datumFilled" ? { lines: [], fills: [tri] } : { lines: [tri], fills: [] };
    }
    case "boxFilled":
    case "boxBlank": {
      const h = size * 0.5;
      const box = [at(-h, h), at(h, h), at(h, -h), at(-h, -h), at(-h, h)];
      return kind === "boxFilled" ? { lines: [], fills: [box] } : { lines: [box], fills: [] };
    }
    case "dot":
      return { lines: [], fills: [ring(tip, size / 2, 16)] };
    case "dotSmall":
      return { lines: [], fills: [ring(tip, size / 4, 16)] };
    case "dotBlank":
      return { lines: [ring(tip, size / 2, 24)], fills: [] };
    case "origin":
      return { lines: [ring(tip, size / 2, 24), [at(0, -size / 2), at(0, size / 2)]], fills: [] };
    case "origin2":
      return { lines: [ring(tip, size / 2, 24)], fills: [ring(tip, size / 6, 12)] };
    case "bar":
      return { lines: [[at(0, -size / 2), at(0, size / 2)]], fills: [] };
  }
}
