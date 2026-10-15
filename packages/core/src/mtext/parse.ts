/**
 * D-04: MTEXT inline codes <-> a small run model.
 *
 * `parseMtext` reads the DXF MTEXT grammar (`\P`, `\L..\l`, `\O..\o`, `\K..\k`,
 * `\C`/`\c` colour, `\H` height, `\W` width factor, `\Q` oblique, `\T` tracking,
 * `\f`/`\F` font + bold/italic, `\S` stacked fractions, `\~`, `\U+XXXX`,
 * `%%c %%d %%p`, `{...}` scopes, `\\ \{ \}` escapes). Anything unknown is
 * dropped, never thrown. `serializeMtext` writes the model back so that
 * `parse(serialize(p))` equals `p`. `\p` paragraph properties are skipped.
 */

export interface MFmt {
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  overline?: boolean;
  strike?: boolean;
  /** CSS colour (`#rrggbb`), or `aci:N` for an AutoCAD index colour. */
  color?: string;
  /** Height as a multiple of the entity height (`\H2x;`) or absolute (`\H2.5;`). */
  heightScale?: number;
  heightAbs?: number;
  widthFactor?: number;
  /** Oblique angle in degrees. */
  oblique?: number;
  tracking?: number;
  font?: string;
}

export type MRun =
  | { kind: "text"; text: string; fmt: MFmt }
  | { kind: "stack"; top: string; bottom: string; bar: "/" | "#" | "^"; fmt: MFmt }
  | { kind: "tab"; fmt: MFmt };

export interface MParagraph {
  runs: MRun[];
}

const SYMBOLS: Record<string, string> = { c: "\u00d8", d: "\u00b0", p: "\u00b1" };

function sameFmt(a: MFmt, b: MFmt): boolean {
  const ka = Object.keys(a) as (keyof MFmt)[];
  const kb = Object.keys(b) as (keyof MFmt)[];
  return ka.length === kb.length && ka.every((k) => a[k] === b[k]);
}

/** Parses MTEXT inline codes into paragraphs of runs. Never throws. */
export function parseMtext(src: string): MParagraph[] {
  const paras: MParagraph[] = [{ runs: [] }];
  const stack: MFmt[] = [];
  let fmt: MFmt = {};
  let buf = "";
  const flush = () => {
    if (!buf) return;
    const runs = paras[paras.length - 1].runs;
    const last = runs[runs.length - 1];
    if (last && last.kind === "text" && sameFmt(last.fmt, fmt)) last.text += buf;
    else runs.push({ kind: "text", text: buf, fmt: { ...fmt } });
    buf = "";
  };
  const set = (patch: Partial<MFmt>) => {
    flush();
    fmt = { ...fmt, ...patch };
    for (const k of Object.keys(fmt) as (keyof MFmt)[]) if (fmt[k] === undefined || fmt[k] === false) delete fmt[k];
  };
  const n = src.length;
  for (let i = 0; i < n; i++) {
    const ch = src[i];
    if (ch === "{") {
      flush();
      stack.push(fmt);
    } else if (ch === "}") {
      flush();
      if (stack.length) fmt = stack.pop()!;
    } else if (ch === "%" && src[i + 1] === "%" && SYMBOLS[(src[i + 2] ?? "").toLowerCase()]) {
      buf += SYMBOLS[src[i + 2].toLowerCase()];
      i += 2;
    } else if (ch === "\\") {
      const c = src[i + 1];
      if (c === undefined) break;
      i++;
      if (c === "\\" || c === "{" || c === "}") buf += c;
      else if (c === "P") {
        flush();
        paras.push({ runs: [] });
      } else if (c === "~") buf += "\u00a0";
      else if (c === "L") set({ underline: true });
      else if (c === "l") set({ underline: false });
      else if (c === "O") set({ overline: true });
      else if (c === "o") set({ overline: false });
      else if (c === "K") set({ strike: true });
      else if (c === "k") set({ strike: false });
      else if (c === "U" && src[i + 1] === "+") {
        const m = /^\+([0-9a-fA-F]{4})/.exec(src.slice(i + 1));
        if (m) {
          buf += String.fromCharCode(parseInt(m[1], 16));
          i += 5;
        }
      } else if ("CcHWTQAfFSp".includes(c)) {
        const end = src.indexOf(";", i + 1);
        const arg = end < 0 ? src.slice(i + 1) : src.slice(i + 1, end);
        i = end < 0 ? n : end;
        const num = parseFloat(arg);
        if (c === "C" && Number.isFinite(num)) set({ color: `aci:${Math.round(num)}` });
        else if (c === "c" && Number.isFinite(num)) {
          const v = Math.round(num) >>> 0; // 0xBBGGRR
          const hex = (x: number) => x.toString(16).padStart(2, "0");
          set({ color: `#${hex(v & 255)}${hex((v >> 8) & 255)}${hex((v >> 16) & 255)}` });
        } else if (c === "H" && Number.isFinite(num) && num > 0) {
          if (/x$/i.test(arg.trim())) set({ heightScale: num, heightAbs: undefined });
          else set({ heightAbs: num, heightScale: undefined });
        } else if (c === "W" && Number.isFinite(num) && num > 0) set({ widthFactor: num });
        else if (c === "Q" && Number.isFinite(num)) set({ oblique: num });
        else if (c === "T" && Number.isFinite(num)) set({ tracking: num });
        else if (c === "f" || c === "F") {
          const parts = arg.split("|");
          const flag = (k: string) => parts.some((p) => p === `${k}1`);
          set({ font: parts[0] || undefined, bold: flag("b") || undefined, italic: flag("i") || undefined });
        } else if (c === "S") {
          const m = /^(.*?)([/#^])(.*)$/s.exec(arg.replace(/\\([/#^])/g, "\u0001$1"));
          flush();
          const run: MRun = m
            ? { kind: "stack", top: m[1].replace(/\u0001/g, ""), bottom: m[3].replace(/\u0001/g, ""), bar: m[2] as "/" | "#" | "^", fmt: { ...fmt } }
            : { kind: "text", text: arg, fmt: { ...fmt } };
          paras[paras.length - 1].runs.push(run);
        }
      }
      // else: unknown code, dropped.
    } else if (ch === "\t") {
      flush();
      paras[paras.length - 1].runs.push({ kind: "tab", fmt: { ...fmt } });
    } else if (ch === "\n") {
      // Raw newlines are not MTEXT; treat as a paragraph break so pasted text still wraps sensibly.
      flush();
      paras.push({ runs: [] });
    } else if (ch !== "\r") buf += ch;
  }
  flush();
  return paras;
}

const esc = (s: string) => s.replace(/[\\{}]/g, (c) => `\\${c}`);

function fmtPrefix(f: MFmt): string {
  let s = "";
  if (f.font !== undefined || f.bold || f.italic) s += `\\f${f.font ?? "Arial"}|b${f.bold ? 1 : 0}|i${f.italic ? 1 : 0}|c0|p0;`;
  if (f.color) {
    if (f.color.startsWith("aci:")) s += `\\C${f.color.slice(4)};`;
    else {
      const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(f.color);
      if (m) s += `\\c${parseInt(m[1], 16) + parseInt(m[2], 16) * 256 + parseInt(m[3], 16) * 65536};`;
    }
  }
  if (f.heightScale !== undefined) s += `\\H${f.heightScale}x;`;
  if (f.heightAbs !== undefined) s += `\\H${f.heightAbs};`;
  if (f.widthFactor !== undefined) s += `\\W${f.widthFactor};`;
  if (f.oblique !== undefined) s += `\\Q${f.oblique};`;
  if (f.tracking !== undefined) s += `\\T${f.tracking};`;
  if (f.underline) s += "\\L";
  if (f.overline) s += "\\O";
  if (f.strike) s += "\\K";
  return s;
}

/** Writes paragraphs of runs back as MTEXT inline codes (one `{...}` scope per formatted run). */
export function serializeMtext(paras: readonly MParagraph[]): string {
  return paras
    .map((p) =>
      p.runs
        .map((r) => {
          const pre = fmtPrefix(r.fmt);
          const body =
            r.kind === "text"
              ? esc(r.text).replace(/\u00a0/g, "\\~")
              : r.kind === "tab"
                ? "\t"
                : `\\S${esc(r.top).replace(/[/#^]/g, "\\$&")}${r.bar}${esc(r.bottom).replace(/[/#^]/g, "\\$&")};`;
          return pre ? `{${pre}${body}}` : body;
        })
        .join(""),
    )
    .join("\\P");
}

/** The visible text of MTEXT codes with paragraphs joined by `\n` (stacks as `top/bottom`). */
export function mtextPlain(src: string): string {
  return parseMtext(src)
    .map((p) => p.runs.map((r) => (r.kind === "text" ? r.text : r.kind === "tab" ? "\t" : `${r.top}${r.bar}${r.bottom}`)).join(""))
    .join("\n");
}
