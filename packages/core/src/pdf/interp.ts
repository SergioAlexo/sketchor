/**
 * PDF content-stream interpreter (F-08): path construction and painting,
 * graphics state, colour, Form XObjects, optional-content layers and text
 * (as TEXT entities). Painting goes through the same `eps/paint.ts` the
 * PostScript importer uses, so a PDF and an EPS of the same artwork produce
 * the same entities.
 *
 * Geometry is carried in page points with Y up (the CTM already contains the
 * page-box origin shift and /Rotate); `tf` only scales to millimetres. Hostile
 * input terminates: every operator ticks an op budget, q-nesting / Form
 * recursion / marked-content nesting are capped, operand stacks are capped, and
 * non-finite or absurd coordinates are rejected.
 */
import type { Entity, TextEntity } from "../entities";
import { newEntityId } from "../entities";
import { nearestLinetype } from "../svgStyle";
import { cmykToRgb, isBlackRgb, rgbToCss, type Rgb } from "../eps/color";
import { pathSignature, pureKind, subpathToEntities, subpathsToHatch, type PSeg, type SubPath } from "../eps/paint";
import type { PdfDoc, PageInfo } from "./doc";
import { loadFont, type PdfFont } from "./font";
import { Lexer, PdfCmd, PdfDict, PdfName, PdfRef, PdfStr, PdfStream, type PdfVal } from "./objects";

const K = 25.4 / 72;
const LIMIT = 1e9;

type Mat = [number, number, number, number, number, number];
const IDENT: Mat = [1, 0, 0, 1, 0, 0];
const mmul = (m: Mat, n: Mat): Mat => [
  m[0] * n[0] + m[1] * n[2],
  m[0] * n[1] + m[1] * n[3],
  m[2] * n[0] + m[3] * n[2],
  m[2] * n[1] + m[3] * n[3],
  m[4] * n[0] + m[5] * n[2] + n[4],
  m[4] * n[1] + m[5] * n[3] + n[5],
];
const mscale = (m: Mat): number => Math.sqrt(Math.abs(m[0] * m[3] - m[1] * m[2]));
const finiteMat = (m: number[]): boolean => m.length === 6 && m.every((v) => Number.isFinite(v) && Math.abs(v) < LIMIT);

class Halt {}

interface ColorSpace {
  n: number;
  initial: Rgb;
  toRgb(c: number[]): Rgb;
  pattern?: boolean;
}

const clamp01 = (v: number): number => (Number.isFinite(v) ? (v < 0 ? 0 : v > 1 ? 1 : v) : 0);
const GRAY: ColorSpace = { n: 1, initial: [0, 0, 0], toRgb: (c) => [clamp01(c[0]), clamp01(c[0]), clamp01(c[0])] };
const RGB: ColorSpace = { n: 3, initial: [0, 0, 0], toRgb: (c) => [clamp01(c[0]), clamp01(c[1]), clamp01(c[2])] };
const CMYK: ColorSpace = { n: 4, initial: [0, 0, 0], toRgb: (c) => cmykToRgb(clamp01(c[0]), clamp01(c[1]), clamp01(c[2]), clamp01(c[3])) };
const PATTERN: ColorSpace = { n: 0, initial: [0, 0, 0], toRgb: () => [0, 0, 0], pattern: true };

interface GState {
  ctm: Mat;
  fill: Rgb;
  stroke: Rgb;
  fillCS: ColorSpace;
  strokeCS: ColorSpace;
  lw: number;
  dash: number[];
  font: PdfFont | null;
  fs: number;
  tc: number;
  tw: number;
  th: number;
  tl: number;
  rise: number;
  tr: number;
}

interface Marked {
  layer?: string;
  hidden: boolean;
}

export interface PdfInterpOptions {
  maxEntities: number;
  maxOps: number;
  maxDepth: number;
}

export interface PdfInterpResult {
  entities: Entity[];
  truncated: boolean;
  budgetHit: boolean;
  stats: Record<string, number>;
}

export class PdfInterp {
  private out: Entity[] = [];
  private truncated = false;
  private budgetHit = false;
  private ops = 0;
  private stats: Record<string, number> = {};
  private gs: GState;
  private stack: GState[] = [];
  private stackOverflow = 0;
  private path: SubPath[] = [];
  private cur: SubPath | null = null;
  private pen = { x: 0, y: 0 };
  private pendingClip = false;
  private tm: Mat = IDENT;
  private tlm: Mat = IDENT;
  private res: PdfDict | null;
  private marked: Marked[] = [];
  private activeForms = new Set<PdfStream>();
  private fonts = new Map<PdfDict, PdfFont | null>();
  private csCache = new Map<string, ColorSpace>();
  private hiddenOcgs = new Set<number>();
  private pageBox: [number, number, number, number];
  private tf = (x: number, y: number) => ({ x: x * K, y: y * K });

  constructor(private doc: PdfDoc, page: PageInfo, base: Mat, box: [number, number, number, number], private o: PdfInterpOptions) {
    this.res = page.resources;
    this.pageBox = box;
    this.gs = { ctm: base, fill: [0, 0, 0], stroke: [0, 0, 0], fillCS: GRAY, strokeCS: GRAY, lw: 1, dash: [], font: null, fs: 0, tc: 0, tw: 0, th: 1, tl: 0, rise: 0, tr: 0 };
    const root = doc.dict(doc.trailer.m.get("Root"));
    const ocp = doc.dict(root?.m.get("OCProperties"));
    const dcfg = doc.dict(ocp?.m.get("D"));
    const off = doc.array(dcfg?.m.get("OFF"));
    if (off) for (const r of off) if (r instanceof PdfRef) this.hiddenOcgs.add(r.num);
    if (doc.name(dcfg?.m.get("BaseState")) === "OFF") {
      const on = new Set<number>();
      for (const r of doc.array(dcfg?.m.get("ON")) ?? []) if (r instanceof PdfRef) on.add(r.num);
      for (const r of doc.array(ocp?.m.get("OCGs")) ?? []) if (r instanceof PdfRef && !on.has(r.num)) this.hiddenOcgs.add(r.num);
    }
  }

  private bump(k: string, n = 1): void {
    this.stats[k] = (this.stats[k] ?? 0) + n;
  }

  /** Runs the page's /Contents. */
  runPage(page: PageInfo): PdfInterpResult {
    try {
      const c = this.doc.resolve(page.dict.m.get("Contents"));
      const parts: Uint8Array[] = [];
      const add = (v: PdfVal) => {
        const s = this.doc.resolve(v);
        if (s instanceof PdfStream) {
          const d = this.doc.streamData(s);
          if (d) parts.push(d);
        }
      };
      if (Array.isArray(c)) c.slice(0, 10_000).forEach(add);
      else add(c);
      let total = 0;
      for (const p of parts) total += p.length + 1;
      const all = new Uint8Array(total);
      let o = 0;
      for (const p of parts) {
        all.set(p, o);
        o += p.length;
        all[o++] = 10;
      }
      this.run(all, 0);
    } catch (e) {
      if (!(e instanceof Halt)) throw e;
    }
    return { entities: this.out, truncated: this.truncated, budgetHit: this.budgetHit, stats: this.stats };
  }

  private add(list: Entity[]): void {
    for (const e of list) {
      if (this.out.length >= this.o.maxEntities) {
        this.truncated = true;
        throw new Halt();
      }
      this.out.push(e);
    }
  }

  /* ------------------------------- run loop ------------------------------ */

  private run(data: Uint8Array, depth: number): void {
    const lx = new Lexer(data, 0, false);
    let args: PdfVal[] = [];
    const baseStack = this.stack.length;
    const baseMarked = this.marked.length;
    for (;;) {
      const v = lx.next();
      if (v === undefined) break;
      if (v instanceof PdfCmd) {
        if (++this.ops > this.o.maxOps) {
          this.budgetHit = true;
          throw new Halt();
        }
        if (v.c === "BI") {
          this.inlineImage(lx);
          args = [];
          continue;
        }
        try {
          this.exec(v.c, args, depth);
        } catch (e) {
          if (e instanceof Halt) throw e;
          this.bump("error");
        }
        args = [];
        continue;
      }
      args.push(v);
      if (args.length > 256) args.shift();
    }
    // unbalanced q / BMC inside a stream do not leak out of it
    while (this.stack.length > baseStack) this.gs = this.stack.pop()!;
    this.marked.length = baseMarked;
  }

  private inlineImage(lx: Lexer): void {
    for (let guard = 0; guard < 4096; guard++) {
      const t = lx.next();
      if (t === undefined || (t instanceof PdfCmd && t.c === "ID")) break;
    }
    const b = lx.b;
    let p = lx.p + 1;
    for (; p < lx.end - 1; p++) {
      if (b[p] === 69 && b[p + 1] === 73 && (p + 2 >= lx.end || b[p + 2] <= 32) && (p === 0 || b[p - 1] <= 32)) {
        p += 2;
        break;
      }
    }
    lx.p = Math.min(p, lx.end);
    this.bump("images");
  }

  private n(args: PdfVal[], i: number): number {
    const v = args[i];
    return typeof v === "number" && Number.isFinite(v) ? v : NaN;
  }

  private exec(op: string, a: PdfVal[], depth: number): void {
    const gs = this.gs;
    switch (op) {
      /* ------------------------ graphics state ---------------------------- */
      case "q":
        if (this.stack.length >= 256) this.stackOverflow++;
        else this.stack.push({ ...gs, dash: gs.dash });
        return;
      case "Q":
        if (this.stackOverflow > 0) this.stackOverflow--;
        else if (this.stack.length > 0) this.gs = this.stack.pop()!;
        return;
      case "cm": {
        const m = a.slice(0, 6).map((_, i) => this.n(a, i));
        if (m.length === 6 && finiteMat(m)) {
          const c = mmul(m as Mat, gs.ctm);
          if (finiteMat(c)) gs.ctm = c;
        }
        return;
      }
      case "w": {
        const v = this.n(a, 0);
        if (v >= 0) gs.lw = v;
        return;
      }
      case "d": {
        const arr = Array.isArray(a[0]) ? a[0] : [];
        const d = arr.map((x) => (typeof x === "number" && Number.isFinite(x) ? Math.abs(x) : 0)).slice(0, 32);
        gs.dash = d.some((x) => x > 0) ? d : [];
        return;
      }
      case "gs":
        return this.extGState(a[0]);
      case "J": case "j": case "M": case "i": case "ri": case "d0": case "d1": case "BX": case "EX": case "MP": case "DP":
        return;

      /* ------------------------------ paths ------------------------------- */
      case "m": {
        const p = this.pt(a, 0);
        if (!p) return;
        this.cur = { x0: p.x, y0: p.y, segs: [], closed: false };
        this.path.push(this.cur);
        this.pen = p;
        return;
      }
      case "l": {
        const p = this.pt(a, 0);
        if (!p) return;
        this.seg({ k: "L", x: p.x, y: p.y });
        this.pen = p;
        return;
      }
      case "c": {
        const p1 = this.pt(a, 0), p2 = this.pt(a, 2), p3 = this.pt(a, 4);
        if (!p1 || !p2 || !p3) return;
        this.seg({ k: "C", x1: p1.x, y1: p1.y, x2: p2.x, y2: p2.y, x3: p3.x, y3: p3.y });
        this.pen = p3;
        return;
      }
      case "v": {
        const p2 = this.pt(a, 0), p3 = this.pt(a, 2);
        if (!p2 || !p3) return;
        this.seg({ k: "C", x1: this.pen.x, y1: this.pen.y, x2: p2.x, y2: p2.y, x3: p3.x, y3: p3.y });
        this.pen = p3;
        return;
      }
      case "y": {
        const p1 = this.pt(a, 0), p3 = this.pt(a, 2);
        if (!p1 || !p3) return;
        this.seg({ k: "C", x1: p1.x, y1: p1.y, x2: p3.x, y2: p3.y, x3: p3.x, y3: p3.y });
        this.pen = p3;
        return;
      }
      case "h":
        this.closeSub();
        return;
      case "re": {
        const x = this.n(a, 0), y = this.n(a, 1), w = this.n(a, 2), h = this.n(a, 3);
        if (![x, y, w, h].every(Number.isFinite)) return;
        const p0 = this.apply(x, y), p1 = this.apply(x + w, y), p2 = this.apply(x + w, y + h), p3 = this.apply(x, y + h);
        if (!p0 || !p1 || !p2 || !p3) return;
        this.cur = { x0: p0.x, y0: p0.y, segs: [], closed: false };
        this.path.push(this.cur);
        this.seg({ k: "L", x: p1.x, y: p1.y });
        this.seg({ k: "L", x: p2.x, y: p2.y });
        this.seg({ k: "L", x: p3.x, y: p3.y });
        this.closeSub();
        return;
      }
      case "W": case "W*":
        this.pendingClip = true;
        return;
      case "n":
        return this.paint(false, false, false, false);
      case "S":
        return this.paint(false, true, false, false);
      case "s":
        return this.paint(false, true, false, true);
      case "f": case "F":
        return this.paint(true, false, false, false);
      case "f*":
        return this.paint(true, false, true, false);
      case "B":
        return this.paint(true, true, false, false);
      case "B*":
        return this.paint(true, true, true, false);
      case "b":
        return this.paint(true, true, false, true);
      case "b*":
        return this.paint(true, true, true, true);

      /* ------------------------------ colour ------------------------------ */
      case "g": gs.fillCS = GRAY; gs.fill = GRAY.toRgb([this.n(a, 0)]); return;
      case "G": gs.strokeCS = GRAY; gs.stroke = GRAY.toRgb([this.n(a, 0)]); return;
      case "rg": gs.fillCS = RGB; gs.fill = RGB.toRgb([this.n(a, 0), this.n(a, 1), this.n(a, 2)]); return;
      case "RG": gs.strokeCS = RGB; gs.stroke = RGB.toRgb([this.n(a, 0), this.n(a, 1), this.n(a, 2)]); return;
      case "k": gs.fillCS = CMYK; gs.fill = CMYK.toRgb([this.n(a, 0), this.n(a, 1), this.n(a, 2), this.n(a, 3)]); return;
      case "K": gs.strokeCS = CMYK; gs.stroke = CMYK.toRgb([this.n(a, 0), this.n(a, 1), this.n(a, 2), this.n(a, 3)]); return;
      case "cs": case "CS": {
        const cs = this.colorSpace(a[0]);
        if (op === "cs") {
          gs.fillCS = cs;
          gs.fill = cs.initial;
        } else {
          gs.strokeCS = cs;
          gs.stroke = cs.initial;
        }
        return;
      }
      case "sc": case "scn": case "SC": case "SCN": {
        const stroke = op[0] === "S";
        const cs = stroke ? gs.strokeCS : gs.fillCS;
        if (cs.pattern || a[a.length - 1] instanceof PdfName) {
          this.bump("patterns");
          return;
        }
        const comps = a.map((x) => (typeof x === "number" ? x : 0)).slice(0, 32);
        while (comps.length < cs.n) comps.push(0);
        const rgb = cs.toRgb(comps);
        if (stroke) gs.stroke = rgb;
        else gs.fill = rgb;
        return;
      }
      case "sh":
        this.bump("shadings");
        return;

      /* ------------------------------- text ------------------------------- */
      case "BT":
        this.tm = IDENT;
        this.tlm = IDENT;
        return;
      case "ET":
        return;
      case "Tc": gs.tc = this.n(a, 0) || 0; return;
      case "Tw": gs.tw = this.n(a, 0) || 0; return;
      case "Tz": gs.th = (this.n(a, 0) || 100) / 100; return;
      case "TL": gs.tl = this.n(a, 0) || 0; return;
      case "Ts": gs.rise = this.n(a, 0) || 0; return;
      case "Tr": gs.tr = this.n(a, 0) || 0; return;
      case "Tf": {
        const name = a[0] instanceof PdfName ? a[0].n : "";
        gs.fs = this.n(a, 1) || 0;
        gs.font = this.font(name);
        return;
      }
      case "Td": case "TD": {
        const tx = this.n(a, 0), ty = this.n(a, 1);
        if (!Number.isFinite(tx) || !Number.isFinite(ty)) return;
        if (op === "TD") gs.tl = -ty;
        this.tlm = mmul([1, 0, 0, 1, tx, ty], this.tlm);
        this.tm = this.tlm;
        return;
      }
      case "Tm": {
        const m = a.slice(0, 6).map((_, i) => this.n(a, i));
        if (m.length === 6 && finiteMat(m)) {
          this.tm = m as Mat;
          this.tlm = m as Mat;
        }
        return;
      }
      case "T*":
        this.nextLine();
        return;
      case "Tj":
        if (a[0] instanceof PdfStr) this.showText([a[0]]);
        return;
      case "'":
        this.nextLine();
        if (a[0] instanceof PdfStr) this.showText([a[0]]);
        return;
      case '"':
        gs.tw = this.n(a, 0) || 0;
        gs.tc = this.n(a, 1) || 0;
        this.nextLine();
        if (a[2] instanceof PdfStr) this.showText([a[2]]);
        return;
      case "TJ":
        if (Array.isArray(a[0])) this.showText(a[0]);
        return;

      /* ----------------------- marked content / XObjects ------------------- */
      case "BMC":
        this.marked.push({ hidden: false });
        if (this.marked.length > 256) this.marked.shift();
        return;
      case "BDC": {
        const m: Marked = { hidden: false };
        if (a[0] instanceof PdfName && a[0].n === "OC") {
          const props = a[1] instanceof PdfName ? this.doc.dict(this.doc.dict(this.res?.m.get("Properties") ?? null)?.m.get(a[1].n)) : null;
          const raw = a[1] instanceof PdfName ? this.doc.dict(this.res?.m.get("Properties") ?? null)?.m.get(a[1].n) : undefined;
          const info = this.ocInfo(raw, props);
          m.layer = info.layer;
          m.hidden = info.hidden;
        }
        this.marked.push(m);
        if (this.marked.length > 256) this.marked.shift();
        return;
      }
      case "EMC":
        this.marked.pop();
        return;
      case "Do":
        if (a[0] instanceof PdfName) this.doXObject(a[0].n, depth);
        return;
      default:
        this.bump(`op:${op}`);
    }
  }

  /* -------------------------------- paths -------------------------------- */

  private apply(x: number, y: number): { x: number; y: number } | null {
    const m = this.gs.ctm;
    const px = m[0] * x + m[2] * y + m[4];
    const py = m[1] * x + m[3] * y + m[5];
    return Number.isFinite(px) && Number.isFinite(py) && Math.abs(px) < LIMIT && Math.abs(py) < LIMIT ? { x: px, y: py } : null;
  }

  private pt(a: PdfVal[], i: number): { x: number; y: number } | null {
    const x = this.n(a, i), y = this.n(a, i + 1);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
    return this.apply(x, y);
  }

  private seg(s: PSeg): void {
    if (!this.cur) {
      // a segment with no current point starts at the pen (after h) — or is dropped
      if (!this.path.length) return;
      this.cur = { x0: this.pen.x, y0: this.pen.y, segs: [], closed: false };
      this.path.push(this.cur);
    }
    if (this.cur.segs.length < 1_000_000) this.cur.segs.push(s);
  }

  private closeSub(): void {
    const c = this.cur ?? this.path[this.path.length - 1];
    if (!c) return;
    c.closed = true;
    this.pen = { x: c.x0, y: c.y0 };
    this.cur = null;
  }

  private nonEmpty(): SubPath[] {
    return this.path.filter((s) => s.segs.length > 0);
  }

  private endPath(): void {
    this.path = [];
    this.cur = null;
  }

  private inHidden(): boolean {
    return this.marked.some((m) => m.hidden);
  }

  private layer(): string | undefined {
    for (let i = this.marked.length - 1; i >= 0; i--) if (this.marked[i].layer) return this.marked[i].layer;
    return undefined;
  }

  private paint(fill: boolean, stroke: boolean, evenOdd: boolean, close: boolean): void {
    if (close) this.closeSub();
    const subs = this.nonEmpty();
    const clip = this.pendingClip;
    this.pendingClip = false;
    this.endPath();
    if (!subs.length) return;
    if (clip) this.recordClip(subs);
    if (!fill && !stroke) return;
    if (this.inHidden()) {
      this.bump("hiddenLayerShapes");
      return;
    }
    void evenOdd; // hatch islands use even-odd already
    let ents: Entity[] = [];
    if (fill) ents = this.doFill(subs);
    if (stroke) this.doStroke(subs, fill ? ents : null);
  }

  private style(rgb: Rgb): { css: string; plain: boolean } {
    return { css: rgbToCss(rgb), plain: isBlackRgb(rgb) };
  }

  private doFill(subs: SubPath[]): Entity[] {
    const { css, plain } = this.style(this.gs.fill);
    const layer = this.layer();
    const st = { ...(layer ? { layer } : {}), ...(plain ? {} : { color: css }) };
    const made: Entity[] = [];
    const pure = subs.length === 1 && this.singlePureClosed(subs[0]);
    if (pure) made.push(...subpathToEntities(subs[0], this.tf, st, true, css));
    else {
      for (const sp of subs) made.push(...subpathToEntities(sp, this.tf, st, true));
      const h = subpathsToHatch(subs, this.tf, css, layer);
      if (h) made.push(h);
    }
    this.add(made);
    return made.filter((e) => e.type !== "hatch");
  }

  private singlePureClosed(sp: SubPath): boolean {
    const kind = pureKind(sp);
    if (kind === "L") return sp.segs.length >= 2;
    if (kind === "C") {
      const l = sp.segs[sp.segs.length - 1] as Extract<PSeg, { k: "C" }>;
      return Math.hypot(l.x3 - sp.x0, l.y3 - sp.y0) < 1e-6;
    }
    return false;
  }

  private strokeStyle(): { color?: string; lineweight?: number; linetype?: string; plain: boolean; css: string } {
    const { css, plain } = this.style(this.gs.stroke);
    const sc = mscale(this.gs.ctm);
    const lwMm = this.gs.lw * sc * K;
    const lineweight = lwMm > 0.005 ? Math.round(lwMm * 1000) / 1000 : undefined;
    let linetype: string | undefined;
    if (this.gs.dash.length) {
      const d = this.gs.dash.map((v) => v * sc * K);
      if (d.some((v) => v > 0)) linetype = nearestLinetype(d.length % 2 ? [...d, ...d] : d);
    }
    return { css, plain, lineweight, linetype };
  }

  /** `restyle` = entities made by the fill half of a fill+stroke op: they take the stroke style instead of duplicating. */
  private doStroke(subs: SubPath[], restyle: Entity[] | null): void {
    const s = this.strokeStyle();
    if (restyle) {
      for (const e of restyle) {
        const r = e as Entity & { color?: string; lineweight?: number; linetype?: string };
        if (s.plain) delete r.color;
        else r.color = s.css;
        if (s.lineweight !== undefined) r.lineweight = s.lineweight;
        if (s.linetype) r.linetype = s.linetype;
      }
      return;
    }
    const layer = this.layer();
    const st = { ...(layer ? { layer } : {}), ...(s.plain ? {} : { color: s.css }), ...(s.lineweight !== undefined ? { lineweight: s.lineweight } : {}), ...(s.linetype ? { linetype: s.linetype } : {}) };
    const made: Entity[] = [];
    for (const sp of subs) made.push(...subpathToEntities(sp, this.tf, st, sp.closed));
    this.add(made);
  }

  private recordClip(subs: SubPath[]): void {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    const grow = (x: number, y: number) => {
      if (x < x0) x0 = x;
      if (y < y0) y0 = y;
      if (x > x1) x1 = x;
      if (y > y1) y1 = y;
    };
    for (const sp of subs) {
      grow(sp.x0, sp.y0);
      for (const s of sp.segs) s.k === "L" ? grow(s.x, s.y) : (grow(s.x1, s.y1), grow(s.x2, s.y2), grow(s.x3, s.y3));
    }
    const [bx0, by0, bx1, by1] = this.pageBox;
    const tol = 1;
    if (x0 > bx0 + tol || y0 > by0 + tol || x1 < bx1 - tol || y1 < by1 - tol) this.bump("croppingClips");
  }

  /* --------------------------- colour spaces ----------------------------- */

  private colorSpace(v: PdfVal | undefined, depth = 0): ColorSpace {
    if (depth > 6) return GRAY;
    if (v instanceof PdfName) {
      switch (v.n) {
        case "DeviceGray": case "G": case "CalGray": return GRAY;
        case "DeviceRGB": case "RGB": case "CalRGB": return RGB;
        case "DeviceCMYK": case "CMYK": return CMYK;
        case "Pattern": return PATTERN;
      }
      const cached = this.csCache.get(v.n);
      if (cached) return cached;
      const def = this.doc.resolve(this.doc.dict(this.res?.m.get("ColorSpace") ?? null)?.m.get(v.n));
      if (def !== null && !(def instanceof PdfName && def.n === v.n)) {
        const cs = this.colorSpace(def, depth + 1);
        this.csCache.set(v.n, cs);
        return cs;
      }
      return GRAY;
    }
    const r = this.doc.resolve(v);
    if (r instanceof PdfName) return this.colorSpace(r, depth + 1);
    if (!Array.isArray(r) || !r.length) return GRAY;
    const kind = this.doc.name(r[0]);
    switch (kind) {
      case "CalGray": return GRAY;
      case "CalRGB": case "Lab": return RGB;
      case "ICCBased": {
        const s = this.doc.resolve(r[1]);
        const n = s instanceof PdfStream ? this.doc.num(s.dict.m.get("N"), 3) : 3;
        return n === 1 ? GRAY : n === 4 ? CMYK : RGB;
      }
      case "Pattern": return PATTERN;
      case "Indexed": case "I": {
        const base = this.colorSpace(r[1], depth + 1);
        const hival = Math.max(0, Math.min(255, this.doc.num(r[2])));
        const lk = this.doc.resolve(r[3]);
        const table = lk instanceof PdfStr ? lk.b : lk instanceof PdfStream ? (this.doc.streamData(lk) ?? new Uint8Array(0)) : new Uint8Array(0);
        return {
          n: 1,
          initial: [0, 0, 0],
          toRgb: (c) => {
            const i = Math.max(0, Math.min(hival, Math.round(c[0] || 0)));
            const comps: number[] = [];
            for (let k = 0; k < base.n; k++) comps.push((table[i * base.n + k] ?? 0) / 255);
            return base.toRgb(comps);
          },
        };
      }
      case "Separation": case "DeviceN": {
        const names = kind === "Separation" ? [this.doc.name(r[1]) ?? ""] : (this.doc.array(r[1]) ?? []).map((x) => this.doc.name(x) ?? "");
        const n = Math.max(1, names.length);
        const alt = this.colorSpace(r[2], depth + 1);
        const fn = this.doc.dict(r[3]);
        const ftype = this.doc.num(fn?.m.get("FunctionType"), -1);
        const c0 = this.doc.nums(fn?.m.get("C0")) ?? [0];
        const c1 = this.doc.nums(fn?.m.get("C1")) ?? [1];
        const N = this.doc.num(fn?.m.get("N"), 1);
        const tintGray = (c: number[]): Rgb => {
          const t = clamp01(Math.max(...c.map((x) => x || 0)));
          return [1 - t, 1 - t, 1 - t];
        };
        return {
          n,
          initial: tintGray(new Array(n).fill(1)),
          toRgb: (c) => {
            if (ftype === 2 && n === 1 && c0.length === alt.n && c1.length === alt.n) {
              const t = clamp01(c[0]);
              const x = c0.map((v, i) => v + Math.pow(t, N) * (c1[i] - v));
              return alt.toRgb(x);
            }
            return tintGray(c);
          },
        };
      }
      default:
        return this.colorSpace(r[0], depth + 1);
    }
  }

  /* ----------------------------- ext gstate ------------------------------ */

  private extGState(nameV: PdfVal | undefined): void {
    if (!(nameV instanceof PdfName)) return;
    const d = this.doc.dict(this.doc.dict(this.res?.m.get("ExtGState") ?? null)?.m.get(nameV.n));
    if (!d) return;
    const lw = d.m.get("LW");
    if (lw !== undefined) {
      const v = this.doc.num(lw, -1);
      if (v >= 0) this.gs.lw = v;
    }
    const dash = this.doc.array(d.m.get("D"));
    if (dash && dash.length) {
      const arr = this.doc.nums(dash[0]) ?? [];
      const dd = arr.map(Math.abs).slice(0, 32);
      this.gs.dash = dd.some((x) => x > 0) ? dd : [];
    }
  }

  /* -------------------------------- text --------------------------------- */

  private font(name: string): PdfFont | null {
    const fd = this.doc.dict(this.doc.dict(this.res?.m.get("Font") ?? null)?.m.get(name));
    if (!fd) return null;
    if (this.fonts.has(fd)) return this.fonts.get(fd)!;
    let f: PdfFont | null = null;
    try {
      f = loadFont(this.doc, fd);
    } catch {
      f = null;
    }
    this.fonts.set(fd, f);
    return f;
  }

  private nextLine(): void {
    this.tlm = mmul([1, 0, 0, 1, 0, -this.gs.tl], this.tlm);
    this.tm = this.tlm;
  }

  private showText(items: PdfVal[]): void {
    const gs = this.gs;
    const font = gs.font;
    const start = mmul(this.tm, gs.ctm);
    const size = gs.fs * Math.hypot(start[2], start[3]) * K;
    let text = "";
    let unreadable = false;
    for (const it of items) {
      if (typeof it === "number") {
        if (!Number.isFinite(it)) continue;
        if (it <= -200 && text && !text.endsWith(" ")) text += " ";
        this.tm = mmul([1, 0, 0, 1, (-it / 1000) * gs.fs * gs.th, 0], this.tm);
      } else if (it instanceof PdfStr) {
        const glyphs = font ? font.glyphs(it.b) : [];
        if (font && !font.readable) unreadable = true;
        for (const g of glyphs) {
          text += g.ch;
          const tx = (g.w * gs.fs + gs.tc + (g.space ? gs.tw : 0)) * gs.th;
          this.tm = mmul([1, 0, 0, 1, tx, 0], this.tm);
        }
      }
    }
    if (unreadable) {
      this.bump("textNoUnicode");
      return;
    }
    if (gs.tr === 3 || gs.tr === 7) return; // invisible / clip-only
    const clean = text.replace(/[\u0000-\u0008\u000b-\u001f]/g, "").replace(/\s+$/, "");
    const trimmed = clean.replace(/^\s+/, "");
    if (!trimmed || size < 1e-4 || !Number.isFinite(size) || this.inHidden()) return;
    const origin = this.apply2(start, 0, gs.rise);
    if (!origin) return;
    const lead = clean.length - trimmed.length;
    const rot = Math.atan2(start[1], start[0]);
    const { css, plain } = this.style(gs.fill);
    const e: TextEntity = { id: newEntityId(), type: "text", at: this.tf(origin.x + Math.cos(rot) * lead * size / K * 0.5, origin.y + Math.sin(rot) * lead * size / K * 0.5), text: trimmed, height: size, rotation: Number.isFinite(rot) ? rot : 0 };
    const layer = this.layer();
    if (layer) e.layer = layer;
    if (!plain) e.color = css;
    this.add([e]);
    this.bump("texts");
  }

  private apply2(m: Mat, x: number, y: number): { x: number; y: number } | null {
    const px = m[0] * x + m[2] * y + m[4];
    const py = m[1] * x + m[3] * y + m[5];
    return Number.isFinite(px) && Number.isFinite(py) && Math.abs(px) < LIMIT && Math.abs(py) < LIMIT ? { x: px, y: py } : null;
  }

  /* ------------------------ XObjects / optional content ------------------ */

  private ocInfo(raw: PdfVal | undefined, d: PdfDict | null): { layer?: string; hidden: boolean } {
    if (!d) return { hidden: false };
    let ocg: PdfDict | null = d;
    let ref = raw instanceof PdfRef ? raw : undefined;
    if (this.doc.name(d.m.get("Type")) === "OCMD") {
      const g = d.m.get("OCGs");
      const first = Array.isArray(this.doc.resolve(g)) ? (this.doc.resolve(g) as PdfVal[])[0] : g;
      ref = first instanceof PdfRef ? first : undefined;
      ocg = this.doc.dict(first);
    }
    const nm = ocg?.m.get("Name");
    const nmv = this.doc.resolve(nm);
    let layer: string | undefined;
    if (nmv instanceof PdfStr) layer = nmv.b[0] === 0xfe && nmv.b[1] === 0xff ? Array.from(nmv.b.subarray(2)).reduce((s, _, i, arr) => (i % 2 === 0 && i + 1 < arr.length ? s + String.fromCharCode((arr[i] << 8) | arr[i + 1]) : s), "") : nmv.s;
    layer = layer?.replace(/[<>/\\":;?*|=`]/g, "_").trim().slice(0, 64) || undefined;
    return { layer, hidden: !!ref && this.hiddenOcgs.has(ref.num) };
  }

  private doXObject(name: string, depth: number): void {
    const xo = this.doc.dict(this.res?.m.get("XObject") ?? null);
    const raw = xo?.m.get(name);
    const s = this.doc.resolve(raw);
    if (!(s instanceof PdfStream)) return;
    const sub = this.doc.name(s.dict.m.get("Subtype"));
    if (sub === "Image") {
      this.bump("images");
      return;
    }
    if (sub !== "Form") return;
    if (depth >= this.o.maxDepth || this.activeForms.has(s)) {
      this.bump("formDepth");
      return;
    }
    const ocRaw = s.dict.m.get("OC");
    const oc = ocRaw !== undefined ? this.ocInfo(ocRaw, this.doc.dict(ocRaw)) : { hidden: false };
    const data = this.doc.streamData(s);
    if (!data) return;
    const m = this.doc.nums(s.dict.m.get("Matrix"), 6);
    const saved = this.gs;
    const savedRes = this.res;
    const savedPath = [this.path, this.cur, this.pendingClip] as const;
    const savedTm = [this.tm, this.tlm] as const;
    this.gs = { ...saved };
    if (m && m.length === 6 && finiteMat(m)) {
      const c = mmul(m as Mat, saved.ctm);
      if (finiteMat(c)) this.gs.ctm = c;
    }
    const fr = this.doc.dict(s.dict.m.get("Resources"));
    if (fr) this.res = fr;
    this.path = [];
    this.cur = null;
    this.pendingClip = false;
    this.marked.push({ layer: oc.layer, hidden: oc.hidden });
    this.activeForms.add(s);
    try {
      this.run(data, depth + 1);
    } finally {
      this.activeForms.delete(s);
      this.marked.pop();
      this.gs = saved;
      this.res = savedRes;
      this.path = savedPath[0];
      this.cur = savedPath[1];
      this.pendingClip = savedPath[2];
      this.tm = savedTm[0];
      this.tlm = savedTm[1];
    }
  }
}
