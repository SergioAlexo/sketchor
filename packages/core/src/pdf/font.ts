/**
 * Just enough font handling to turn text-showing operators into TEXT
 * entities: character codes → Unicode (ToUnicode CMap, else /Encoding with
 * /Differences) and glyph advance widths (/Widths, /W, /DW). No glyph outlines.
 */
import type { PdfDoc } from "./doc";
import { Lexer, PdfCmd, PdfDict, PdfName, PdfStr, PdfStream, type PdfVal } from "./objects";

export interface Glyph {
  /** Unicode text for this code ("" when unknown). */
  ch: string;
  /** Advance in text-space units per 1 pt of font size (width / 1000). */
  w: number;
  /** Single-byte code 32 — word spacing (Tw) applies. */
  space: boolean;
}

export interface PdfFont {
  /** False when the font has no usable Unicode mapping (composite font without ToUnicode). */
  readable: boolean;
  glyphs(s: Uint8Array): Glyph[];
}

const GLYPH_NAMES: Record<string, string> = {
  space: " ", exclam: "!", quotedbl: '"', numbersign: "#", dollar: "$", percent: "%", ampersand: "&", quotesingle: "'", parenleft: "(", parenright: ")", asterisk: "*", plus: "+", comma: ",", hyphen: "-", minus: "−", period: ".", slash: "/", colon: ":", semicolon: ";", less: "<", equal: "=", greater: ">", question: "?", at: "@", bracketleft: "[", backslash: "\\", bracketright: "]", asciicircum: "^", underscore: "_", grave: "`", braceleft: "{", bar: "|", braceright: "}", asciitilde: "~", zero: "0", one: "1", two: "2", three: "3", four: "4", five: "5", six: "6", seven: "7", eight: "8", nine: "9",
  bullet: "•", endash: "–", emdash: "—", quoteleft: "‘", quoteright: "’", quotedblleft: "“", quotedblright: "”", degree: "°", plusminus: "±", multiply: "×", divide: "÷", mu: "µ", Omega: "Ω", ellipsis: "…", copyright: "©", registered: "®", trademark: "™", section: "§", paragraph: "¶", Euro: "€", sterling: "£", yen: "¥", cent: "¢", diameter: "⌀", fi: "fi", fl: "fl", onehalf: "½", onequarter: "¼", threequarters: "¾", periodcentered: "·", guillemotleft: "«", guillemotright: "»", germandbls: "ß",
};

function glyphToChar(name: string): string {
  if (name.length === 1) return name;
  const g = GLYPH_NAMES[name];
  if (g !== undefined) return g;
  let m = /^uni([0-9A-Fa-f]{4})$/.exec(name);
  if (m) return String.fromCharCode(parseInt(m[1], 16));
  m = /^u([0-9A-Fa-f]{4,6})$/.exec(name);
  if (m) {
    const cp = parseInt(m[1], 16);
    return cp <= 0x10ffff ? String.fromCodePoint(cp) : "";
  }
  // Aacute, egrave, … : fall back to the base letter
  m = /^([A-Za-z])(?:acute|grave|circumflex|dieresis|tilde|ring|cedilla|caron|ogonek|macron|breve|slash)$/.exec(name);
  if (m) return m[1];
  return "";
}

function utf16be(b: Uint8Array): string {
  let s = "";
  for (let i = 0; i + 1 < b.length; i += 2) s += String.fromCharCode((b[i] << 8) | b[i + 1]);
  if (b.length === 1) s = String.fromCharCode(b[0]);
  return s;
}

/** ToUnicode CMap → code → string. */
export function parseToUnicode(data: Uint8Array, maxEntries = 200_000): Map<number, string> {
  const map = new Map<number, string>();
  const lx = new Lexer(data, 0, false);
  const toNum = (s: PdfStr): number => {
    let v = 0;
    for (const x of s.b) v = v * 256 + x;
    return v;
  };
  let guard = 0;
  for (;;) {
    const t = lx.next();
    if (t === undefined || ++guard > 4_000_000) break;
    if (!(t instanceof PdfCmd)) continue;
    if (t.c === "beginbfchar") {
      for (;;) {
        const a = lx.next();
        if (a === undefined || a instanceof PdfCmd) break;
        const b = lx.next();
        if (a instanceof PdfStr && b instanceof PdfStr && map.size < maxEntries) map.set(toNum(a), utf16be(b.b));
      }
    } else if (t.c === "beginbfrange") {
      for (;;) {
        const a = lx.next();
        if (a === undefined || a instanceof PdfCmd) break;
        const b = lx.next();
        const c = lx.next();
        if (!(a instanceof PdfStr) || !(b instanceof PdfStr)) continue;
        const lo = toNum(a);
        const hi = Math.min(toNum(b), lo + 65535);
        if (c instanceof PdfStr) {
          const base = utf16be(c.b);
          for (let k = lo; k <= hi && map.size < maxEntries; k++) {
            if (!base) break;
            map.set(k, base.slice(0, -1) + String.fromCharCode(base.charCodeAt(base.length - 1) + (k - lo)));
          }
        } else if (Array.isArray(c)) {
          for (let k = lo; k <= hi && k - lo < c.length && map.size < maxEntries; k++) {
            const e = c[k - lo];
            if (e instanceof PdfStr) map.set(k, utf16be(e.b));
          }
        }
      }
    }
  }
  return map;
}

export function loadFont(doc: PdfDoc, fd: PdfDict): PdfFont {
  const subtype = doc.name(fd.m.get("Subtype"));
  const baseFont = doc.name(fd.m.get("BaseFont")) ?? "";
  let uni: Map<number, string> | null = null;
  const tu = doc.resolve(fd.m.get("ToUnicode"));
  if (tu instanceof PdfStream) {
    const d = doc.streamData(tu);
    if (d) uni = parseToUnicode(d);
  }

  if (subtype === "Type0") {
    const desc = doc.dict(doc.array(fd.m.get("DescendantFonts"))?.[0]);
    const dw = doc.num(desc?.m.get("DW"), 1000);
    const widths = new Map<number, number>();
    const w = doc.array(desc?.m.get("W"));
    if (w) {
      for (let i = 0; i < w.length && widths.size < 100_000; ) {
        const c1 = doc.num(w[i]);
        const second = doc.resolve(w[i + 1]);
        if (Array.isArray(second)) {
          second.forEach((x, k) => widths.set(c1 + k, doc.num(x, dw)));
          i += 2;
        } else {
          const c2 = Math.min(doc.num(second), c1 + 65535);
          const ww = doc.num(w[i + 2], dw);
          for (let c = c1; c <= c2 && widths.size < 100_000; c++) widths.set(c, ww);
          i += 3;
        }
      }
    }
    const enc = doc.name(fd.m.get("Encoding")) ?? "";
    const twoByte = !/^(?:WinAnsi|MacRoman|Standard)/.test(enc);
    return {
      readable: !!uni && uni.size > 0,
      glyphs(s) {
        const out: Glyph[] = [];
        if (twoByte) {
          for (let i = 0; i + 1 < s.length; i += 2) {
            const code = (s[i] << 8) | s[i + 1];
            out.push({ ch: uni?.get(code) ?? "", w: (widths.get(code) ?? dw) / 1000, space: false });
          }
        } else for (const c of s) out.push({ ch: uni?.get(c) ?? "", w: (widths.get(c) ?? dw) / 1000, space: c === 32 });
        return out;
      },
    };
  }

  // simple fonts
  const first = doc.num(fd.m.get("FirstChar"));
  const wl = doc.nums(fd.m.get("Widths"), 1024);
  const desc = doc.dict(fd.m.get("FontDescriptor"));
  const missing = doc.num(desc?.m.get("MissingWidth"), /Courier/i.test(baseFont) ? 600 : 500);
  const diffs = new Map<number, string>();
  const encV = doc.resolve(fd.m.get("Encoding"));
  const encD = encV instanceof PdfDict ? encV : null;
  const dl = doc.array(encD?.m.get("Differences"));
  if (dl) {
    let code = 0;
    for (const x of dl.slice(0, 4096)) {
      const r = doc.resolve(x);
      if (typeof r === "number") code = r;
      else if (r instanceof PdfName) diffs.set(code++, glyphToChar(r.n));
    }
  }
  const symbolic = /Symbol|Dingbats/i.test(baseFont);
  return {
    readable: true,
    glyphs(s) {
      const out: Glyph[] = [];
      for (const c of s) {
        let ch = uni?.get(c);
        if (ch === undefined) ch = diffs.get(c);
        if (ch === undefined) ch = symbolic ? "" : c >= 32 ? String.fromCharCode(c) : "";
        const w = wl && c >= first && c - first < wl.length ? wl[c - first] : missing;
        out.push({ ch, w: w / 1000, space: c === 32 });
      }
      return out;
    },
  };
}

export type { PdfVal };
