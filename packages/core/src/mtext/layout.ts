import { rotatePoint, type Point } from "../geometry";
import { textWidth } from "../entities";
import type { MTextEntity } from "../entities";
import { parseMtext, type MFmt, type MParagraph } from "./parse";

/**
 * D-04: word-wrap layout of an MTEXT entity. Pure; text is measured by a
 * pluggable {@link MTextMetrics} (default: the stroke-font estimate used for
 * TEXT boxes, so node tests and exports agree; the canvas may install a real
 * font measure with {@link setMTextMetrics}).
 */

export type MTextMetrics = (text: string, height: number, fmt: MFmt) => number;

const defaultMetrics: MTextMetrics = (text, height, fmt) =>
  textWidth(text, height) * (fmt.bold ? 1.06 : 1) * (fmt.widthFactor ?? 1) + (fmt.tracking ? (fmt.tracking - 1) * 0.1 * height * text.length : 0);
let metrics: MTextMetrics = defaultMetrics;

/** Installs a different text measure (null restores the stroke-font default). */
export function setMTextMetrics(m: MTextMetrics | null): void {
  metrics = m ?? defaultMetrics;
}

/** One drawn piece of text: baseline-left anchor in world space. */
export interface MTextGlyphRun {
  text: string;
  at: Point;
  height: number;
  rotation: number;
  bold: boolean;
  italic: boolean;
  /** `#rrggbb` or `aci:N`; absent = the entity colour. */
  color?: string;
  font?: string;
  widthFactor?: number;
}

export interface MTextLayout {
  runs: MTextGlyphRun[];
  /** Underline / overline / strike / fraction-bar segments, world space. */
  lines: Point[][];
  /** The text box (rotated), counter-clockwise from bottom-left. */
  box: Point[];
  /** Box size in local units. */
  width: number;
  height: number;
}

/** AutoCAD's single line spacing: 5/3 of the text height. */
export const LINE_PITCH = 5 / 3;

interface Piece {
  text: string;
  fmt: MFmt;
  h: number;
  w: number;
  stack?: { top: string; bottom: string; bar: string; sh: number; tw: number; bw: number };
  space: boolean;
}

const heightOf = (f: MFmt, base: number) => f.heightAbs ?? base * (f.heightScale ?? 1);

function piecesOf(para: MParagraph, base: number): Piece[] {
  const out: Piece[] = [];
  for (const r of para.runs) {
    const h = heightOf(r.fmt, base);
    if (r.kind === "tab") out.push({ text: "    ", fmt: r.fmt, h, w: metrics("    ", h, r.fmt), space: true });
    else if (r.kind === "stack") {
      const sh = h * 0.7;
      const tw = metrics(r.top, sh, r.fmt);
      const bw = metrics(r.bottom, sh, r.fmt);
      out.push({ text: "", fmt: r.fmt, h, w: Math.max(tw, bw) + h * 0.1, stack: { top: r.top, bottom: r.bottom, bar: r.bar, sh, tw, bw }, space: false });
    } else {
      // Words and blanks separately so wrapping can break between them.
      for (const part of r.text.split(/( +)/)) {
        if (part === "") continue;
        out.push({ text: part, fmt: r.fmt, h, w: metrics(part, h, r.fmt), space: /^ +$/.test(part) });
      }
    }
  }
  return out;
}

/** Lays an MTEXT entity out. `width` 0 = no wrapping. */
export function layoutMText(e: MTextEntity): MTextLayout {
  const base = e.height > 0 ? e.height : 1;
  const wrap = e.width > 0 ? e.width : Infinity;
  const spacing = e.lineSpacing && e.lineSpacing > 0 ? e.lineSpacing : 1;
  const lines: { items: Piece[]; w: number; h: number }[] = [];
  for (const para of parseMtext(e.text)) {
    let cur: Piece[] = [];
    let w = 0;
    const push = () => {
      while (cur.length && cur[cur.length - 1].space) w -= cur.pop()!.w; // trailing blanks do not count
      lines.push({ items: cur, w: Math.max(0, w), h: cur.reduce((m, p) => Math.max(m, p.h), cur.length ? 0 : base) });
      cur = [];
      w = 0;
    };
    for (const p of piecesOf(para, base)) {
      if (w + p.w > wrap && cur.length && !p.space) push();
      if (p.space && cur.length === 0 && lines.length > 0 && w === 0 && Number.isFinite(wrap)) continue; // no leading blanks after a wrap
      cur.push(p);
      w += p.w;
    }
    push();
  }
  const natural = lines.reduce((m, l) => Math.max(m, l.w), 0);
  const boxW = e.width > 0 ? e.width : natural;
  const baselines: number[] = [];
  let y = 0;
  lines.forEach((l, i) => {
    y += i === 0 ? l.h : LINE_PITCH * Math.max(l.h, lines[i - 1].h) * spacing;
    baselines.push(y);
  });
  const lastH = lines.length ? lines[lines.length - 1].h : base;
  const boxH = y + lastH * 0.25;
  const att = Math.min(9, Math.max(1, Math.round(e.attachment || 1)));
  const col = (att - 1) % 3; // 0 left, 1 centre, 2 right
  const row = Math.floor((att - 1) / 3); // 0 top, 1 middle, 2 bottom
  const left = col === 0 ? 0 : col === 1 ? -boxW / 2 : -boxW;
  const top = row === 0 ? 0 : row === 1 ? boxH / 2 : boxH;

  const to = (lx: number, ly: number): Point => rotatePoint({ x: e.at.x + lx, y: e.at.y + ly }, e.at, e.rotation);
  const run = (text: string, lx: number, ly: number, h: number, f: MFmt): MTextGlyphRun => ({
    text,
    at: to(lx, ly),
    height: h,
    rotation: e.rotation,
    bold: !!f.bold,
    italic: !!f.italic || (f.oblique !== undefined && f.oblique > 0),
    ...(f.color ? { color: f.color } : {}),
    ...(f.font ? { font: f.font } : {}),
    ...(f.widthFactor ? { widthFactor: f.widthFactor } : {}),
  });
  const runs: MTextGlyphRun[] = [];
  const segs: Point[][] = [];
  lines.forEach((l, i) => {
    const by = top - baselines[i];
    let x = left + (col === 0 ? 0 : col === 1 ? (boxW - l.w) / 2 : boxW - l.w);
    for (const p of l.items) {
      const f = p.fmt;
      if (p.stack) {
        const s = p.stack;
        const cx = x + p.w / 2;
        const gap = p.h * 0.05;
        if (s.bar === "^") {
          runs.push(run(s.top, cx - s.tw / 2, by + p.h * 0.3, s.sh, f));
          runs.push(run(s.bottom, cx - s.bw / 2, by - p.h * 0.3, s.sh, f));
        } else {
          runs.push(run(s.top, cx - s.tw / 2, by + p.h * 0.35 + gap, s.sh, f));
          runs.push(run(s.bottom, cx - s.bw / 2, by - s.sh * 0.95 - gap, s.sh, f));
          const barY = by + p.h * 0.3;
          segs.push([to(x, barY), to(x + p.w, barY)]);
        }
      } else {
        if (!p.space) runs.push(run(p.text, x, by, p.h, f));
        if (f.underline) segs.push([to(x, by - p.h * 0.15), to(x + p.w, by - p.h * 0.15)]);
        if (f.overline) segs.push([to(x, by + p.h * 1.1), to(x + p.w, by + p.h * 1.1)]);
        if (f.strike) segs.push([to(x, by + p.h * 0.35), to(x + p.w, by + p.h * 0.35)]);
      }
      x += p.w;
    }
  });
  const box = [to(left, top - boxH), to(left + boxW, top - boxH), to(left + boxW, top), to(left, top)];
  return { runs, lines: segs, box, width: boxW, height: boxH };
}
