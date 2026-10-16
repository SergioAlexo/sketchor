/**
 * PDF file structure: header, cross-reference tables / streams, object
 * streams, stream filters and the page tree. Everything is lazy and cached;
 * every chain (Prev links, page-tree kids, reference chains) is cycle- and
 * depth-guarded. A damaged cross-reference triggers one linear rebuild scan.
 */
import { inflate } from "./inflate";
import { isDict, isName, isWs, Lexer, PdfCmd, PdfDict, PdfError, PdfName, PdfRef, PdfStr, PdfStream, type PdfVal } from "./objects";

type XEntry = { t: 1; off: number } | { t: 2; stm: number; idx: number };

export const MAX_STREAM_BYTES = 256 * 1024 * 1024;

export interface PageInfo {
  dict: PdfDict;
  resources: PdfDict | null;
  mediaBox: number[] | null;
  cropBox: number[] | null;
  rotate: number;
}

export class PdfDoc {
  readonly buf: Uint8Array;
  private xref = new Map<number, XEntry>();
  private cache = new Map<number, PdfVal>();
  private loading = new Set<number>();
  private objStms = new Map<number, Map<number, PdfVal>>();
  private streamCache = new Map<PdfStream, Uint8Array | null>();
  trailer = new PdfDict();
  private rebuilt = false;
  readonly version: string;

  constructor(bytes: Uint8Array) {
    let base = -1;
    const lim = Math.min(bytes.length - 4, 1024);
    for (let i = 0; i < lim; i++) {
      if (bytes[i] === 0x25 && bytes[i + 1] === 0x50 && bytes[i + 2] === 0x44 && bytes[i + 3] === 0x46 && bytes[i + 4] === 0x2d) {
        base = i;
        break;
      }
    }
    if (base < 0) throw new PdfError("not a PDF file (no %PDF- header)", "not-pdf");
    this.buf = base > 0 ? bytes.subarray(base) : bytes;
    this.version = String.fromCharCode(...this.buf.subarray(5, 8));
    try {
      this.readXrefChain();
    } catch (e) {
      if (e instanceof PdfError && e.code === "encrypted") throw e;
      this.xref.clear();
      this.rebuild();
    }
    if (!this.rootOk()) {
      this.rebuild();
    }
    if (this.trailer.m.has("Encrypt")) throw new PdfError("this PDF is password-protected / encrypted — remove the protection (print to a new PDF or decrypt it) and open it again", "encrypted");
    if (!this.rootOk()) throw new PdfError("the PDF has no readable page tree", "corrupt");
  }

  /* ------------------------------ values -------------------------------- */

  resolve(v: PdfVal | undefined): PdfVal {
    let guard = 0;
    while (v instanceof PdfRef) {
      if (++guard > 32) return null;
      v = this.getObj(v.num);
    }
    return v === undefined ? null : v;
  }
  dict(v: PdfVal | undefined): PdfDict | null {
    const r = this.resolve(v);
    if (r instanceof PdfDict) return r;
    if (r instanceof PdfStream) return r.dict;
    return null;
  }
  get(d: PdfDict | null, key: string): PdfVal {
    return d ? this.resolve(d.m.get(key)) : null;
  }
  num(v: PdfVal | undefined, dflt = 0): number {
    const r = this.resolve(v);
    return typeof r === "number" && Number.isFinite(r) ? r : dflt;
  }
  nums(v: PdfVal | undefined, max = 1 << 20): number[] | null {
    const r = this.resolve(v);
    if (!Array.isArray(r)) return null;
    const out: number[] = [];
    for (const x of r.slice(0, max)) {
      const n = this.resolve(x);
      out.push(typeof n === "number" && Number.isFinite(n) ? n : 0);
    }
    return out;
  }
  name(v: PdfVal | undefined): string | null {
    const r = this.resolve(v);
    return r instanceof PdfName ? r.n : null;
  }
  array(v: PdfVal | undefined): PdfVal[] | null {
    const r = this.resolve(v);
    return Array.isArray(r) ? r : null;
  }

  /* ------------------------------ objects ------------------------------- */

  getObj(num: number): PdfVal {
    if (this.cache.has(num)) return this.cache.get(num)!;
    if (this.loading.has(num)) return null;
    this.loading.add(num);
    let v: PdfVal = null;
    try {
      const e = this.xref.get(num);
      if (e?.t === 1) {
        const r = this.parseIndirectAt(e.off, num);
        if (r === undefined && !this.rebuilt) {
          this.rebuild();
          const e2 = this.xref.get(num);
          if (e2?.t === 1) v = this.parseIndirectAt(e2.off, num) ?? null;
          else if (e2?.t === 2) v = this.fromObjStm(e2.stm, num);
        } else v = r ?? null;
      } else if (e?.t === 2) v = this.fromObjStm(e.stm, num);
    } catch (err) {
      if (err instanceof PdfError && err.code === "encrypted") throw err;
      v = null;
    } finally {
      this.loading.delete(num);
    }
    this.cache.set(num, v);
    return v;
  }

  /** Parses `n g obj … endobj` at `off`; undefined when there is no such object header there. */
  private parseIndirectAt(off: number, want: number): PdfVal | undefined {
    if (off < 0 || off >= this.buf.length) return undefined;
    const lx = new Lexer(this.buf, off, true);
    const a = lx.next();
    const g = lx.next();
    const o = lx.next();
    if (typeof a !== "number" || typeof g !== "number" || !(o instanceof PdfCmd) || o.c !== "obj") return undefined;
    if (a !== want) return undefined;
    const v = lx.next();
    if (v === undefined) return null;
    if (v instanceof PdfCmd) return null;
    if (v instanceof PdfDict) {
      const save = lx.p;
      const kw = lx.next();
      if (kw instanceof PdfCmd && kw.c === "stream") return this.makeStream(v, lx.p);
      lx.p = save;
    }
    return v;
  }

  private makeStream(d: PdfDict, afterKw: number): PdfStream {
    const b = this.buf;
    let s = afterKw;
    if (b[s] === 13 && b[s + 1] === 10) s += 2;
    else if (b[s] === 10 || b[s] === 13) s += 1;
    else while (s < b.length && (b[s] === 32 || b[s] === 9)) s++;
    let len = -1;
    const lv = d.m.get("Length");
    const lr = typeof lv === "number" ? lv : lv instanceof PdfRef ? this.resolve(lv) : null;
    if (typeof lr === "number" && Number.isFinite(lr) && lr >= 0 && s + lr <= b.length) {
      let q = s + lr;
      while (q < b.length && isWs(b[q])) q++;
      if (matchAt(b, q, "endstream")) len = lr;
    }
    if (len < 0) {
      const e = indexOfStr(b, "endstream", s);
      let end = e < 0 ? b.length : e;
      if (end > s && b[end - 1] === 10) end--;
      if (end > s && b[end - 1] === 13) end--;
      len = Math.max(0, end - s);
    }
    return new PdfStream(d, s, s + len, b);
  }

  private fromObjStm(stmNum: number, num: number): PdfVal {
    let m = this.objStms.get(stmNum);
    if (!m) {
      m = new Map();
      this.objStms.set(stmNum, m);
      const st = this.getObj(stmNum);
      if (st instanceof PdfStream) {
        const data = this.streamData(st);
        const n = this.num(st.dict.m.get("N"));
        const first = this.num(st.dict.m.get("First"));
        if (data && n > 0 && n < 5_000_000) {
          const hl = new Lexer(data, 0, false);
          const heads: [number, number][] = [];
          for (let i = 0; i < n; i++) {
            const on = hl.next();
            const oo = hl.next();
            if (typeof on !== "number" || typeof oo !== "number") break;
            heads.push([on, oo]);
          }
          for (const [on, oo] of heads) {
            if (m.has(on)) continue;
            const ol = new Lexer(data, first + oo, true);
            const v = ol.next();
            m.set(on, v === undefined || v instanceof PdfCmd ? null : v);
          }
        }
      }
    }
    return m.get(num) ?? null;
  }

  /* ------------------------------ xref ---------------------------------- */

  private readXrefChain(): void {
    const b = this.buf;
    const tail = Math.max(0, b.length - 2048);
    const sx = lastIndexOfStr(b, "startxref", tail);
    if (sx < 0) throw new PdfError("no startxref", "corrupt");
    const lx = new Lexer(b, sx + 9, true);
    const first = lx.next();
    if (typeof first !== "number") throw new PdfError("bad startxref", "corrupt");
    const seen = new Set<number>();
    const queue = [first];
    let isFirst = true;
    while (queue.length) {
      const off = queue.shift()!;
      if (seen.has(off) || off < 0 || off >= b.length || seen.size > 4096) continue;
      seen.add(off);
      const tr = this.readXrefSection(off);
      if (isFirst) {
        this.trailer = tr;
        isFirst = false;
      } else for (const [k, v] of tr.m) if (!this.trailer.m.has(k)) this.trailer.m.set(k, v);
      const xs = tr.m.get("XRefStm");
      if (typeof xs === "number") queue.unshift(xs);
      const prev = tr.m.get("Prev");
      if (typeof prev === "number") queue.push(prev);
    }
  }

  private readXrefSection(off: number): PdfDict {
    const b = this.buf;
    const lx = new Lexer(b, off, true);
    const t = lx.next();
    if (t instanceof PdfCmd && t.c === "xref") {
      for (;;) {
        const save = lx.p;
        const a = lx.next();
        if (a instanceof PdfCmd && a.c === "trailer") break;
        const cnt = lx.next();
        if (typeof a !== "number" || typeof cnt !== "number") {
          lx.p = save;
          throw new PdfError("bad xref subsection", "corrupt");
        }
        if (cnt < 0 || cnt > 10_000_000) throw new PdfError("bad xref count", "corrupt");
        for (let i = 0; i < cnt; i++) {
          const o = lx.next();
          const g = lx.next();
          const f = lx.next();
          if (typeof o !== "number" || typeof g !== "number" || !(f instanceof PdfCmd)) throw new PdfError("bad xref entry", "corrupt");
          const n = a + i;
          if (f.c === "n" && !this.xref.has(n)) this.xref.set(n, { t: 1, off: o });
          else if (f.c === "f" && !this.xref.has(n)) this.xref.set(n, { t: 1, off: -1 });
        }
      }
      const d = lx.next();
      if (!(d instanceof PdfDict)) throw new PdfError("bad trailer", "corrupt");
      return d;
    }
    // xref stream: "n g obj << … >> stream"
    const g = lx.next();
    const o = lx.next();
    if (typeof t !== "number" || typeof g !== "number" || !(o instanceof PdfCmd) || o.c !== "obj") throw new PdfError("bad xref offset", "corrupt");
    const d = lx.next();
    const kw = lx.next();
    if (!(d instanceof PdfDict) || !(kw instanceof PdfCmd) || kw.c !== "stream") throw new PdfError("bad xref stream", "corrupt");
    const st = this.makeStream(d, lx.p);
    const data = this.streamData(st);
    const w = this.nums(d.m.get("W"));
    if (!data || !w || w.length < 3) throw new PdfError("bad xref stream", "corrupt");
    const [w0, w1, w2] = w;
    const rowLen = w0 + w1 + w2;
    if (rowLen <= 0 || w.some((x) => x < 0 || x > 8)) throw new PdfError("bad xref widths", "corrupt");
    const size = this.num(d.m.get("Size"));
    const idx = this.nums(d.m.get("Index")) ?? [0, size];
    let p = 0;
    const rd = (n: number): number => {
      let v = 0;
      for (let i = 0; i < n; i++) v = v * 256 + data[p++];
      return v;
    };
    for (let k = 0; k + 1 < idx.length; k += 2) {
      for (let i = 0; i < idx[k + 1]; i++) {
        if (p + rowLen > data.length) break;
        const type = w0 ? rd(w0) : 1;
        const f2 = rd(w1);
        const f3 = rd(w2);
        const n = idx[k] + i;
        if (this.xref.has(n)) continue;
        if (type === 1) this.xref.set(n, { t: 1, off: f2 });
        else if (type === 2) this.xref.set(n, { t: 2, stm: f2, idx: f3 });
        else if (type === 0) this.xref.set(n, { t: 1, off: -1 });
      }
    }
    return d;
  }

  private rootOk(): boolean {
    const root = this.dict(this.trailer.m.get("Root"));
    return !!root && !!this.dict(root.m.get("Pages"));
  }

  /** Linear scan for `n g obj`, trailers, xref/object streams — the repair path for broken xrefs. */
  private rebuild(): void {
    if (this.rebuilt) return;
    this.rebuilt = true;
    const b = this.buf;
    this.xref.clear();
    this.cache.clear();
    this.objStms.clear();
    this.streamCache.clear();
    const trailer = new PdfDict();
    const objStms: number[] = [];
    let catalog = -1;
    const n = b.length;
    let lineStart = 0;
    for (let i = 0; i < n; i++) {
      const c = b[i];
      if (c === 10 || c === 13) {
        lineStart = i + 1;
        continue;
      }
      if (c === 111 && b[i + 1] === 98 && b[i + 2] === 106 && (i + 3 >= n || !(b[i + 3] >= 97 && b[i + 3] <= 122))) {
        // walk back: ws+ gen ws+ num
        let q = i - 1;
        while (q >= lineStart && isWs(b[q])) q--;
        const ge = q + 1;
        while (q >= lineStart && b[q] >= 48 && b[q] <= 57) q--;
        const gs = q + 1;
        if (gs >= ge || q < lineStart || !isWs(b[q])) continue;
        while (q >= lineStart && isWs(b[q])) q--;
        const ne = q + 1;
        while (q >= lineStart && b[q] >= 48 && b[q] <= 57) q--;
        const ns = q + 1;
        if (ns >= ne) continue;
        const num = Number(String.fromCharCode(...b.subarray(ns, ne)));
        if (!Number.isFinite(num) || ne - ns > 9) continue;
        this.xref.set(num, { t: 1, off: ns });
        let win = "";
        const wend = Math.min(n, i + 400);
        for (let k = i; k < wend; k++) win += String.fromCharCode(b[k]);
        const tm = /\/Type\s*\/(XRef|ObjStm|Catalog)\b/.exec(win);
        if (tm) {
          if (tm[1] === "ObjStm") objStms.push(num);
          else if (tm[1] === "Catalog") catalog = num;
          else {
            const lx = new Lexer(b, i + 3, true);
            const d = lx.next();
            if (d instanceof PdfDict) for (const [k, v] of d.m) if (k !== "Prev" && k !== "Length" && k !== "Filter" && k !== "W" && k !== "Index" && k !== "DecodeParms") trailer.m.set(k, v);
          }
        }
        i += 2;
        continue;
      }
      if (c === 116 && matchAt(b, i, "trailer")) {
        const lx = new Lexer(b, i + 7, true);
        const d = lx.next();
        if (d instanceof PdfDict) for (const [k, v] of d.m) if (k !== "Prev") trailer.m.set(k, v);
      }
    }
    for (const sn of objStms) {
      const st = this.getObj(sn);
      if (!(st instanceof PdfStream)) continue;
      const data = this.streamData(st);
      const cnt = this.num(st.dict.m.get("N"));
      if (!data || cnt <= 0 || cnt > 5_000_000) continue;
      const hl = new Lexer(data, 0, false);
      for (let k = 0; k < cnt; k++) {
        const on = hl.next();
        const oo = hl.next();
        if (typeof on !== "number" || typeof oo !== "number") break;
        if (!this.xref.has(on)) this.xref.set(on, { t: 2, stm: sn, idx: k });
      }
    }
    if (!trailer.m.has("Root") && catalog >= 0) trailer.m.set("Root", new PdfRef(catalog, 0));
    if (!trailer.m.has("Root")) {
      // last resort: any object that is a catalog
      for (const k of this.xref.keys()) {
        const o = this.dict(this.getObj(k));
        if (o && isName(o.m.get("Type"), "Catalog")) {
          trailer.m.set("Root", new PdfRef(k, 0));
          break;
        }
      }
    }
    this.trailer = trailer;
    this.cache.clear();
  }

  /* ------------------------------ streams ------------------------------- */

  /** Decoded stream bytes, or null when a filter is unsupported (image codecs) or the data is unusable. */
  streamData(s: PdfStream): Uint8Array | null {
    if (this.streamCache.has(s)) return this.streamCache.get(s)!;
    let out: Uint8Array | null = null;
    try {
      out = this.decode(s);
    } catch (e) {
      if (e instanceof PdfError) throw e;
      out = null;
    }
    this.streamCache.set(s, out);
    return out;
  }

  /** Filter names of a stream, abbreviations expanded. */
  filtersOf(s: PdfStream): string[] {
    const f = this.resolve(s.dict.m.get("Filter") ?? s.dict.m.get("F"));
    const list = Array.isArray(f) ? f : f === null ? [] : [f];
    return list.map((x) => this.name(x) ?? "?").map((n) => ABBREV[n] ?? n);
  }

  private decode(s: PdfStream): Uint8Array | null {
    let data: Uint8Array = s.buf.subarray(s.start, s.end);
    const filters = this.filtersOf(s);
    const pr = this.resolve(s.dict.m.get("DecodeParms") ?? s.dict.m.get("DP"));
    const parms = Array.isArray(pr) ? pr.map((p) => this.dict(p)) : [this.dict(pr)];
    for (let i = 0; i < filters.length; i++) {
      const f = filters[i];
      const dp = parms[i] ?? null;
      if (f === "FlateDecode") data = this.predict(inflate(data, MAX_STREAM_BYTES), dp);
      else if (f === "LZWDecode") data = this.predict(lzw(data, this.num(dp?.m.get("EarlyChange"), 1)), dp);
      else if (f === "ASCIIHexDecode") data = asciiHex(data);
      else if (f === "ASCII85Decode") data = ascii85(data);
      else if (f === "RunLengthDecode") data = runLength(data);
      else if (f === "Crypt") continue;
      else return null; // DCT / CCITT / JBIG2 / JPX — images only
    }
    return data;
  }

  private predict(data: Uint8Array, dp: PdfDict | null): Uint8Array {
    const pred = this.num(dp?.m.get("Predictor"), 1);
    if (pred < 2) return data;
    const colors = Math.max(1, this.num(dp?.m.get("Colors"), 1));
    const bpc = Math.max(1, this.num(dp?.m.get("BitsPerComponent"), 8));
    const columns = Math.max(1, this.num(dp?.m.get("Columns"), 1));
    const bpp = Math.max(1, Math.ceil((colors * bpc) / 8));
    const rowBytes = Math.ceil((colors * bpc * columns) / 8);
    if (rowBytes > 1 << 26) return data;
    if (pred === 2) {
      if (bpc !== 8) return data;
      const out = new Uint8Array(data);
      for (let r = 0; r + rowBytes <= out.length; r += rowBytes) for (let i = bpp; i < rowBytes; i++) out[r + i] = (out[r + i] + out[r + i - bpp]) & 255;
      return out;
    }
    const rows = Math.floor(data.length / (rowBytes + 1));
    const out = new Uint8Array(rows * rowBytes);
    for (let r = 0; r < rows; r++) {
      const ft = data[r * (rowBytes + 1)];
      const src = r * (rowBytes + 1) + 1;
      const dst = r * rowBytes;
      const prev = dst - rowBytes;
      for (let i = 0; i < rowBytes; i++) {
        const x = data[src + i];
        const a = i >= bpp ? out[dst + i - bpp] : 0;
        const bb = r > 0 ? out[prev + i] : 0;
        const c = r > 0 && i >= bpp ? out[prev + i - bpp] : 0;
        let v: number;
        switch (ft) {
          case 1: v = x + a; break;
          case 2: v = x + bb; break;
          case 3: v = x + ((a + bb) >> 1); break;
          case 4: {
            const p = a + bb - c;
            const pa = Math.abs(p - a), pb = Math.abs(p - bb), pc = Math.abs(p - c);
            v = x + (pa <= pb && pa <= pc ? a : pb <= pc ? bb : c);
            break;
          }
          default: v = x;
        }
        out[dst + i] = v & 255;
      }
    }
    return out;
  }

  /* ------------------------------ pages --------------------------------- */

  /** Number of pages (the page tree's /Count, else counted). */
  pageCount(): number {
    const root = this.dict(this.trailer.m.get("Root"));
    const pages = this.dict(root?.m.get("Pages"));
    const c = this.num(pages?.m.get("Count"), -1);
    if (c >= 0 && Number.isInteger(c)) return c;
    let n = 0;
    this.walkPages(() => {
      n++;
      return false;
    });
    return n;
  }

  /** Page `index` (0-based), with inherited resources / boxes / rotation; null if out of range. */
  page(index: number): PageInfo | null {
    let i = 0;
    let found: PageInfo | null = null;
    this.walkPages((p) => {
      if (i++ === index) {
        found = p;
        return true;
      }
      return false;
    });
    return found;
  }

  private walkPages(visit: (p: PageInfo) => boolean): void {
    const root = this.dict(this.trailer.m.get("Root"));
    const top = this.dict(root?.m.get("Pages"));
    if (!top) return;
    const seen = new Set<PdfDict>();
    let budget = 200_000;
    const rec = (node: PdfDict, inh: { res: PdfDict | null; mb: number[] | null; cb: number[] | null; rot: number }, depth: number): boolean => {
      if (depth > 48 || seen.has(node) || budget-- <= 0) return false;
      seen.add(node);
      const here = {
        res: this.dict(node.m.get("Resources")) ?? inh.res,
        mb: this.nums(node.m.get("MediaBox"), 4) ?? inh.mb,
        cb: this.nums(node.m.get("CropBox"), 4) ?? inh.cb,
        rot: node.m.has("Rotate") ? this.num(node.m.get("Rotate")) : inh.rot,
      };
      const kids = this.array(node.m.get("Kids"));
      const type = this.name(node.m.get("Type"));
      if (kids && type !== "Page") {
        for (const k of kids) {
          const kd = this.dict(k);
          if (kd && rec(kd, here, depth + 1)) return true;
        }
        return false;
      }
      return visit({ dict: node, resources: here.res, mediaBox: here.mb, cropBox: here.cb, rotate: here.rot });
    };
    rec(top, { res: null, mb: null, cb: null, rot: 0 }, 0);
  }
}

const ABBREV: Record<string, string> = { Fl: "FlateDecode", LZW: "LZWDecode", AHx: "ASCIIHexDecode", A85: "ASCII85Decode", RL: "RunLengthDecode", DCT: "DCTDecode", CCF: "CCITTFaxDecode" };

/* -------------------------------- helpers -------------------------------- */

function matchAt(b: Uint8Array, at: number, s: string): boolean {
  if (at < 0 || at + s.length > b.length) return false;
  for (let i = 0; i < s.length; i++) if (b[at + i] !== s.charCodeAt(i)) return false;
  return true;
}
function indexOfStr(b: Uint8Array, s: string, from: number): number {
  const c0 = s.charCodeAt(0);
  for (let i = b.indexOf(c0, from); i >= 0; i = b.indexOf(c0, i + 1)) if (matchAt(b, i, s)) return i;
  return -1;
}
function lastIndexOfStr(b: Uint8Array, s: string, from: number): number {
  for (let i = b.length - s.length; i >= from; i--) if (matchAt(b, i, s)) return i;
  return -1;
}

function asciiHex(d: Uint8Array): Uint8Array {
  const out: number[] = [];
  let hi = -1;
  for (const c of d) {
    if (c === 62) break;
    const v = c >= 48 && c <= 57 ? c - 48 : c >= 65 && c <= 70 ? c - 55 : c >= 97 && c <= 102 ? c - 87 : -1;
    if (v < 0) continue;
    if (hi < 0) hi = v;
    else {
      out.push(hi * 16 + v);
      hi = -1;
    }
  }
  if (hi >= 0) out.push(hi * 16);
  return Uint8Array.from(out);
}

function ascii85(d: Uint8Array): Uint8Array {
  const out: number[] = [];
  const grp: number[] = [];
  const flush = (n: number) => {
    let v = 0;
    for (let i = 0; i < 5; i++) v = v * 85 + (i < n ? grp[i] : 84);
    for (let i = 0; i < n - 1; i++) out.push(Math.floor(v / 2 ** (24 - 8 * i)) & 255);
  };
  for (let i = 0; i < d.length; i++) {
    const c = d[i];
    if (c === 126) break;
    if (isWs(c)) continue;
    if (c === 122 && grp.length === 0) {
      out.push(0, 0, 0, 0);
      continue;
    }
    if (c < 33 || c > 117) continue;
    grp.push(c - 33);
    if (grp.length === 5) {
      flush(5);
      grp.length = 0;
    }
  }
  if (grp.length > 1) flush(grp.length);
  return Uint8Array.from(out);
}

function runLength(d: Uint8Array): Uint8Array {
  const out: number[] = [];
  let i = 0;
  while (i < d.length) {
    const l = d[i++];
    if (l === 128) break;
    if (l < 128) for (let k = 0; k <= l && i < d.length; k++) out.push(d[i++]);
    else {
      const v = d[i++];
      for (let k = 0; k < 257 - l; k++) out.push(v);
    }
    if (out.length > MAX_STREAM_BYTES) break;
  }
  return Uint8Array.from(out);
}

function lzw(d: Uint8Array, early: number): Uint8Array {
  const out: number[] = [];
  let table: number[][] = [];
  const reset = () => {
    table = [];
    for (let i = 0; i < 256; i++) table.push([i]);
    table.push([], []);
  };
  reset();
  let bits = 9;
  let buf = 0;
  let nb = 0;
  let prev: number[] | null = null;
  for (let i = 0; i < d.length; ) {
    while (nb < bits && i < d.length) {
      buf = (buf << 8) | d[i++];
      nb += 8;
    }
    if (nb < bits) break;
    const code = (buf >> (nb - bits)) & ((1 << bits) - 1);
    nb -= bits;
    buf &= (1 << nb) - 1;
    if (code === 256) {
      reset();
      bits = 9;
      prev = null;
      continue;
    }
    if (code === 257) break;
    let entry: number[];
    if (code < table.length) entry = table[code];
    else if (prev) entry = [...prev, prev[0]];
    else break;
    for (const x of entry) out.push(x);
    if (prev) table.push([...prev, entry[0]]);
    prev = entry;
    const sz = table.length + early;
    bits = sz >= 4096 ? 12 : sz >= 2048 ? 12 : sz >= 1024 ? 11 : sz >= 512 ? 10 : 9;
    if (out.length > MAX_STREAM_BYTES) break;
  }
  return Uint8Array.from(out);
}

export { PdfStr, isDict };
