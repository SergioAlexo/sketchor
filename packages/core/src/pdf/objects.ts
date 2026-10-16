/**
 * PDF object model + tokenizer/parser. One lexer serves both the file body
 * (indirect objects, `n g R` references) and content streams (operators).
 * Every loop advances or ends, nesting is capped, so hostile bytes terminate.
 */

export class PdfName {
  constructor(public readonly n: string) {}
}
export class PdfRef {
  constructor(public readonly num: number, public readonly gen: number) {}
}
export class PdfStr {
  constructor(public readonly b: Uint8Array) {}
  /** Latin-1 view (for names of things, dates, …). */
  get s(): string {
    let r = "";
    for (let i = 0; i < this.b.length; i++) r += String.fromCharCode(this.b[i]);
    return r;
  }
}
/** A content-stream operator / bare keyword. */
export class PdfCmd {
  constructor(public readonly c: string) {}
}
export class PdfDict {
  m = new Map<string, PdfVal>();
}
export class PdfStream {
  constructor(public readonly dict: PdfDict, public readonly start: number, public readonly end: number, public readonly buf: Uint8Array) {}
}
export type PdfVal = number | boolean | null | PdfName | PdfRef | PdfStr | PdfCmd | PdfDict | PdfStream | PdfVal[];

export class PdfError extends Error {
  constructor(message: string, public readonly code: "not-pdf" | "encrypted" | "corrupt" | "no-pages" | "bad-page" = "corrupt") {
    super(message);
  }
}

const WS = new Uint8Array(256);
for (const c of [0, 9, 10, 12, 13, 32]) WS[c] = 1;
const DELIM = new Uint8Array(256);
for (const c of "()<>[]{}/%") DELIM[c.charCodeAt(0)] = 1;

export const isWs = (c: number): boolean => WS[c] === 1;
const isReg = (c: number): boolean => WS[c] === 0 && DELIM[c] === 0;
const hexv = (c: number): number => (c >= 48 && c <= 57 ? c - 48 : c >= 65 && c <= 70 ? c - 55 : c >= 97 && c <= 102 ? c - 87 : -1);

const MAX_DEPTH = 64;
const MAX_ARRAY = 2_000_000;

export class Lexer {
  p: number;
  /** When true, `n g R` is read as a reference (file body); false for content streams. */
  constructor(public readonly b: Uint8Array, pos = 0, public readonly allowRefs = true, public readonly end = b.length) {
    this.p = pos;
  }

  skipWs(): void {
    const { b } = this;
    while (this.p < this.end) {
      const c = b[this.p];
      if (WS[c]) this.p++;
      else if (c === 37) {
        while (this.p < this.end && b[this.p] !== 10 && b[this.p] !== 13) this.p++;
      } else break;
    }
  }

  eof(): boolean {
    this.skipWs();
    return this.p >= this.end;
  }

  /** The next object, or `undefined` at end of data. Closers (`]`, `>>`) come back as PdfCmd. */
  next(depth = 0): PdfVal | undefined {
    this.skipWs();
    const { b } = this;
    if (this.p >= this.end) return undefined;
    const c = b[this.p];
    if (c === 47) return this.name();
    if (c === 40) return this.litString();
    if (c === 60) {
      if (b[this.p + 1] === 60) {
        this.p += 2;
        return depth >= MAX_DEPTH ? null : this.dict(depth + 1);
      }
      return this.hexString();
    }
    if (c === 62) {
      if (b[this.p + 1] === 62) {
        this.p += 2;
        return new PdfCmd(">>");
      }
      this.p++;
      return new PdfCmd(">");
    }
    if (c === 91) {
      this.p++;
      if (depth >= MAX_DEPTH) return null;
      const arr: PdfVal[] = [];
      for (;;) {
        const v = this.next(depth + 1);
        if (v === undefined) break;
        if (v instanceof PdfCmd) {
          if (v.c === "]") break;
          if (v.c === ">>") continue;
          // stray keyword inside an array: keep true/false/null handled in word(); drop others
          continue;
        }
        if (arr.length < MAX_ARRAY) arr.push(v);
      }
      return arr;
    }
    if (c === 93) {
      this.p++;
      return new PdfCmd("]");
    }
    if (c === 123 || c === 125 || c === 41) {
      this.p++;
      return new PdfCmd(String.fromCharCode(c));
    }
    return this.word();
  }

  private dict(depth: number): PdfDict {
    const d = new PdfDict();
    for (;;) {
      const k = this.next(depth);
      if (k === undefined) break;
      if (k instanceof PdfCmd) {
        if (k.c === ">>") break;
        continue;
      }
      if (!(k instanceof PdfName)) continue;
      const save = this.p;
      const v = this.next(depth);
      if (v === undefined) break;
      if (v instanceof PdfCmd) {
        if (v.c === ">>") {
          d.m.set(k.n, null);
          break;
        }
        this.p = save;
        continue;
      }
      d.m.set(k.n, v);
    }
    return d;
  }

  private name(): PdfName {
    const { b } = this;
    this.p++;
    let s = "";
    while (this.p < this.end && isReg(b[this.p])) {
      let c = b[this.p++];
      if (c === 35 && hexv(b[this.p]) >= 0 && hexv(b[this.p + 1]) >= 0) {
        c = hexv(b[this.p]) * 16 + hexv(b[this.p + 1]);
        this.p += 2;
      }
      s += String.fromCharCode(c);
    }
    return new PdfName(s);
  }

  private litString(): PdfStr {
    const { b } = this;
    this.p++;
    const out: number[] = [];
    let depth = 1;
    while (this.p < this.end) {
      let c = b[this.p++];
      if (c === 92) {
        c = b[this.p++];
        if (c === 110) out.push(10);
        else if (c === 114) out.push(13);
        else if (c === 116) out.push(9);
        else if (c === 98) out.push(8);
        else if (c === 102) out.push(12);
        else if (c === 13) {
          if (b[this.p] === 10) this.p++;
        } else if (c === 10) {
          /* line continuation */
        } else if (c >= 48 && c <= 55) {
          let v = c - 48;
          for (let i = 0; i < 2 && b[this.p] >= 48 && b[this.p] <= 55; i++) v = v * 8 + (b[this.p++] - 48);
          out.push(v & 255);
        } else if (c !== undefined) out.push(c);
      } else if (c === 40) {
        depth++;
        out.push(c);
      } else if (c === 41) {
        if (--depth === 0) break;
        out.push(c);
      } else out.push(c);
    }
    return new PdfStr(Uint8Array.from(out));
  }

  private hexString(): PdfStr {
    const { b } = this;
    this.p++;
    const out: number[] = [];
    let hi = -1;
    while (this.p < this.end) {
      const c = b[this.p++];
      if (c === 62) break;
      const v = hexv(c);
      if (v < 0) continue;
      if (hi < 0) hi = v;
      else {
        out.push(hi * 16 + v);
        hi = -1;
      }
    }
    if (hi >= 0) out.push(hi * 16);
    return new PdfStr(Uint8Array.from(out));
  }

  private word(): PdfVal {
    const { b } = this;
    const s0 = this.p;
    while (this.p < this.end && isReg(b[this.p])) this.p++;
    if (this.p === s0) {
      this.p++;
      return null;
    }
    let w = "";
    for (let i = s0; i < this.p; i++) w += String.fromCharCode(b[i]);
    const c = w.charCodeAt(0);
    if ((c >= 48 && c <= 57) || c === 43 || c === 45 || c === 46) {
      const n = parseNum(w);
      if (n !== null) {
        if (this.allowRefs && Number.isInteger(n) && n >= 0 && /^\d+$/.test(w)) {
          const save = this.p;
          const g = this.peekInt();
          if (g !== null) {
            this.skipWs();
            if (b[this.p] === 82 && (this.p + 1 >= this.end || !isReg(b[this.p + 1]))) {
              this.p++;
              return new PdfRef(n, g);
            }
          }
          this.p = save;
        }
        return n;
      }
    }
    if (w === "true") return true;
    if (w === "false") return false;
    if (w === "null") return null;
    return new PdfCmd(w);
  }

  private peekInt(): number | null {
    this.skipWs();
    const { b } = this;
    const s = this.p;
    let q = s;
    while (q < this.end && b[q] >= 48 && b[q] <= 57) q++;
    if (q === s || q - s > 6 || (q < this.end && isReg(b[q]))) return null;
    let v = 0;
    for (let i = s; i < q; i++) v = v * 10 + (b[i] - 48);
    this.p = q;
    return v;
  }
}

/** Lenient number parse: `--5`, `1.-2`, `.5`, `4.` all occur in the wild. */
export function parseNum(w: string): number | null {
  if (!/^[+-]?[\d.]/.test(w)) return null;
  let t = w;
  let neg = false;
  while (t[0] === "+" || t[0] === "-") {
    if (t[0] === "-") neg = true;
    t = t.slice(1);
  }
  const m = /^(\d*)(?:\.(\d*))?/.exec(t);
  if (!m || (m[1] === "" && !m[2])) return null;
  // anything after the number (e.g. "1.2-3") is garbage but the number is still the prefix
  const v = parseFloat(`${m[1] || "0"}.${m[2] || "0"}`);
  if (!Number.isFinite(v)) return null;
  return neg ? -v : v;
}

export const isDict = (v: PdfVal | undefined): v is PdfDict => v instanceof PdfDict;
export const isName = (v: PdfVal | undefined, n?: string): v is PdfName => v instanceof PdfName && (n === undefined || v.n === n);
