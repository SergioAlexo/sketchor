/**
 * RN-23: length input and output for the nesting job, in inches internally.
 * Ported from the Sheet Nesting Calculator by Oleksandr Borenko.
 *
 * Shops type sheet sizes as `1 3/16`, `4' 6 1/2"`, `1200 mm` and expect them
 * back the same way; a misparsed fraction is a sheet or kerf that is silently
 * wrong. Everything here returns NaN (or a string) instead of throwing.
 *
 * Self-contained on purpose: the command line's `parseLength`
 * (`apps/web/src/tools/typedInput.ts`) understands ft-in and suffixes but not
 * fractions, returns millimetres and lives in the web app, which this package
 * cannot import. Adding fractions there is a separate, optional follow-up.
 */

export type LengthUnit = "in" | "ft" | "mm" | "cm" | "m";

/** Inches per unit. */
export const INCHES_PER: Record<LengthUnit, number> = { in: 1, ft: 12, mm: 1 / 25.4, cm: 1 / 2.54, m: 1 / 0.0254 };

/** Output modes: fractional inches, decimal inches, feet-inches, mm, cm, m. */
export type LengthFormat = "in" | "indec" | "ftin" | "mm" | "cm" | "m";

function fracToNum(x: string): number {
  if (x.indexOf("/") >= 0) {
    const p = x.split("/");
    if (p.length !== 2 || !/^\d+$/.test(p[0]) || !/^\d+$/.test(p[1])) return NaN;
    const d = Number(p[1]);
    return d > 0 ? Number(p[0]) / d : NaN;
  }
  return /^\d+(\.\d+)?$/.test(x) ? Number(x) : NaN;
}

/**
 * A plain non-negative number: `12`, `12.5`, `12,5`, `3/16`, `1 3/16`, `1-3/16`.
 * NaN for anything else (negative, empty, two fractions, garbage).
 */
export function parseNum(s: unknown): number {
  const str = String(s ?? "").trim().replace(",", ".");
  if (str === "" || str.charAt(0) === "-") return NaN;
  const parts = str.replace(/-/g, " ").replace(/\s+/g, " ").trim().split(" ");
  if (parts.length === 1) return fracToNum(parts[0]);
  if (parts.length === 2 && /^\d+$/.test(parts[0]) && parts[1].indexOf("/") >= 0) return Number(parts[0]) + fracToNum(parts[1]);
  return NaN;
}

const FACTOR_SUFFIX = /\s*(mm|cm|m|in|ft)$/;

/**
 * A length in inches. `unit` is what a bare number means. Accepts fractions
 * (`1 3/16`), feet-inches (`4' 6 1/2"`, `4'-6`, `4'`, `4 ft 6`), and explicit
 * suffixes that override `unit` (`25.4mm`, `2 ft`, `3/4"`). NaN when unparseable.
 */
export function parseLen(s: unknown, unit: LengthUnit = "in"): number {
  const str = String(s ?? "")
    .trim()
    .toLowerCase()
    .replace(/[”“″]/g, '"')
    .replace(/[′’‘]/g, "'");
  if (str === "") return NaN;
  let v: number;
  // feet [inches]: 4' 6 1/2" | 4'-6 | 4' | 4ft 6in
  const ftin = /^(\d+(?:[.,]\d+)?)\s*(?:'|ft)\s*-?\s*(.*)$/.exec(str);
  if (ftin) {
    const rest = ftin[2].replace(/"$|\s*in$/, "").trim();
    const inches = rest === "" ? 0 : parseNum(rest);
    v = parseNum(ftin[1]) * 12 + inches;
  } else if (str.endsWith('"')) {
    v = parseNum(str.slice(0, -1));
  } else {
    const suf = FACTOR_SUFFIX.exec(str);
    if (suf) v = parseNum(str.slice(0, suf.index)) * INCHES_PER[suf[1] as LengthUnit];
    else v = parseNum(str) * (INCHES_PER[unit] ?? 1);
  }
  return Number.isFinite(v) ? Math.round(v * 1e9) / 1e9 : NaN;
}

function dec(x: number, n: number, comma: boolean): string {
  const k = 10 ** n;
  const s = String(Math.round(x * k) / k);
  return comma ? s.replace(".", ",") : s;
}

/** Inches as the nearest 1/32 fraction (`1 3/16`) when within 0.0006 of one, otherwise 3-decimal decimal. */
export function fmtIn(x: number, comma = false): string {
  if (!Number.isFinite(x)) return "";
  const r = Math.round(x * 32) / 32;
  if (Math.abs(x - r) < 0.0006) {
    const w = Math.floor(r + 1e-9);
    let n = Math.round((r - w) * 32);
    let d = 32;
    while (n > 0 && n % 2 === 0) {
      n /= 2;
      d /= 2;
    }
    return n === 0 ? String(w) : w > 0 ? `${w} ${n}/${d}` : `${n}/${d}`;
  }
  return dec(x, 3, comma);
}

/** Formats a length given in inches in the chosen mode. `comma` uses a decimal comma. Returns "" for non-finite input. */
export function formatLen(x: number, mode: LengthFormat, comma = false): string {
  if (!Number.isFinite(x)) return "";
  switch (mode) {
    case "in":
      return fmtIn(x, comma) + '"';
    case "indec":
      return dec(x, 3, comma) + '"';
    case "ftin": {
      const r = Math.round(x * 32) / 32;
      const v = Math.abs(x - r) < 0.0006 ? r : x;
      const ft = Math.floor(v / 12 + 1e-9);
      const rem = v - ft * 12;
      if (ft === 0) return fmtIn(rem, comma) + '"';
      return rem < 0.0006 ? `${ft}'` : `${ft}' ${fmtIn(rem, comma)}"`;
    }
    case "mm":
      return dec(x * 25.4, 1, comma) + " mm";
    case "cm":
      return dec(x * 2.54, 2, comma) + " cm";
    default:
      return dec(x * 0.0254, 3, comma) + " m";
  }
}
