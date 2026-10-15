import type { TableRecord } from "../tables";
import { dimStyleOf, type AngleFormat, type ArrowKind, type DimStyle, type TolMode, type UnitFormat } from "./style";

/**
 * D-10: a {@link DimStyle} as the DXF DIMSTYLE variables AutoCAD reads, and
 * back. The numeric/boolean/enum variables map one to one; what DXF cannot say
 * (child styles, arrow kinds without a standard block name, colours, text fill)
 * travels in the SKETCHOR document record (`SketchorDocData.dimStyles`), so a
 * Sketchor file loses nothing and a foreign file still gets every standard
 * variable.
 *
 * `fileUnitsPerMm` is the writer's `scale`: lengths are written in file units,
 * DIMLFAC / DIMALTF absorb the unit change so the printed number stays the same.
 */

export type DxfValue = number | string;
export type DxfPair = [code: number, value: DxfValue];

/** AutoCAD's standard arrow block names (DIMBLK). "" is the default closed filled arrow. */
const ARROW_NAMES: Partial<Record<ArrowKind, string>> = {
  closedBlank: "_CLOSEDBLANK",
  open: "_OPEN",
  open30: "_OPEN30",
  right: "_OPEN90",
  dot: "_DOT",
  dotSmall: "_DOTSMALL",
  dotBlank: "_DOTBLANK",
  tick: "_ARCHTICK",
  oblique: "_OBLIQUE",
  integral: "_INTEGRAL",
  datumFilled: "_DATUMFILLED",
  datumBlank: "_DATUMBLANK",
  boxFilled: "_BOXFILLED",
  boxBlank: "_BOXBLANK",
  origin: "_ORIGIN",
  origin2: "_ORIGIN2",
  none: "_NONE",
};
const ARROW_BY_NAME = new Map<string, ArrowKind>([...Object.entries(ARROW_NAMES).map(([k, v]) => [v!, k as ArrowKind] as const), ["_CLOSED", "closed"], ["", "closed"]]);

const ZIN: Record<DimStyle["zeroSuppress"], number> = { none: 0, leading: 4, trailing: 8, both: 12 };
const LUNIT: Record<UnitFormat, number> = { scientific: 1, decimal: 2, engineering: 3, architectural: 4, fractional: 5 };
const AUNIT: Record<AngleFormat, number> = { degrees: 0, dms: 1, gradians: 2, radians: 3 };
const JUST: DimStyle["textJustify"][] = ["center", "ext1", "ext2", "over1", "over2"];

const invert = <K extends string>(m: Record<K, number>): Map<number, K> => new Map((Object.entries(m) as [K, number][]).map(([k, v]) => [v, k]));
const ZIN_BY = invert(ZIN);
const LUNIT_BY = invert(LUNIT);
const AUNIT_BY = invert(AUNIT);

/** The style as DIMSTYLE group pairs (no name / handle groups). */
export function dimStyleToDxf(style: DimStyle, fileUnitsPerMm = 1): DxfPair[] {
  const s = fileUnitsPerMm;
  const out: DxfPair[] = [];
  const split = (a: string, b: string): string => (a || b ? `${a}<>${b}` : "");
  const post = split(style.prefix, style.suffix);
  if (post) out.push([3, post]);
  const apost = split(style.altPrefix, style.altSuffix);
  if (apost) out.push([4, apost]);
  const a1 = style.arrow1 || style.arrow;
  const a2 = style.arrow2 || style.arrow;
  if (ARROW_NAMES[style.arrow]) out.push([5, ARROW_NAMES[style.arrow]!]);
  if (ARROW_NAMES[a1]) out.push([6, ARROW_NAMES[a1]!]);
  if (ARROW_NAMES[a2]) out.push([7, ARROW_NAMES[a2]!]);
  const tickSize = style.arrow === "tick" || style.arrow === "oblique" ? style.arrowSize * s : 0;
  out.push(
    [40, style.scale],
    [41, style.arrowSize * s],
    [42, style.extOffset * s],
    [43, style.baselineSpacing * s],
    [44, style.extExtend * s],
    [45, style.round],
    [46, style.lineExtend * s],
    [47, style.tolPlus],
    [48, style.tolMinus],
    [49, style.extFixedLength * s],
    [50, (style.jogAngle * Math.PI) / 180],
    [140, style.textHeight * s],
    [141, (style.centerMark === "none" ? 0 : style.centerMark === "line" ? -1 : 1) * style.centerSize * s],
    [142, tickSize],
    [143, style.altFactor / s],
    [144, style.lengthFactor / s],
    [146, style.tolScale],
    [147, (style.textFrame ? -1 : 1) * style.gap * s],
    [148, style.altRound],
    [71, style.tolMode === "symmetric" || style.tolMode === "deviation" ? 1 : 0],
    [72, style.tolMode === "limits" ? 1 : 0],
    [73, style.textHorizontal ? 1 : 0],
    [74, style.textHorizontal ? 1 : 0],
    [75, style.suppressExt1 ? 1 : 0],
    [76, style.suppressExt2 ? 1 : 0],
    [77, style.textBelow ? 4 : style.textAbove ? 1 : 0],
    [78, ZIN[style.zeroSuppress]],
    [170, style.alt ? 1 : 0],
    [171, style.altDecimals],
    [174, style.textInside ? 1 : 0],
    [175, style.suppressOutsideLine ? 1 : 0],
    [179, style.angleDecimals],
    [271, style.decimals],
    [272, style.tolDecimals],
    [275, AUNIT[style.angleFormat]],
    [277, LUNIT[style.unitFormat]],
    [278, (style.decimalSep || ".").charCodeAt(0)],
    [279, style.textMove],
    [280, Math.max(0, JUST.indexOf(style.textJustify))],
    [281, style.suppressLine1 ? 1 : 0],
    [282, style.suppressLine2 ? 1 : 0],
    [283, style.tolJustify],
    [289, style.fit],
    [290, style.extFixedLength > 0 ? 1 : 0],
  );
  return out;
}

/**
 * DIMSTYLE group pairs as a style record. `mmPerFileUnit` converts lengths
 * back; absent variables keep the default. `tolMode` follows AutoCAD's pair
 * DIMTOL/DIMLIM (a symmetric tolerance is DIMTP = DIMTM).
 */
export function dimStyleFromDxf(name: string, pairs: readonly { code: number; value: string }[], mmPerFileUnit = 1): TableRecord {
  const k = mmPerFileUnit;
  const raw = new Map<number, string>();
  for (const p of pairs) if (!raw.has(p.code)) raw.set(p.code, p.value);
  const num = (code: number): number | undefined => {
    const v = raw.get(code);
    if (v === undefined) return undefined;
    const n = Number(v);
    return Number.isFinite(n) ? n : undefined;
  };
  const rec: Record<string, unknown> = { name };
  const set = (key: string, v: unknown) => {
    if (v !== undefined) rec[key] = v;
  };
  const len = (code: number, key: string) => {
    const v = num(code);
    if (v !== undefined) set(key, v * k);
  };
  const split = (v: string | undefined, a: string, b: string) => {
    if (v === undefined) return;
    const i = v.indexOf("<>");
    if (i < 0) rec[a] = v;
    else {
      rec[a] = v.slice(0, i);
      rec[b] = v.slice(i + 2);
    }
  };
  split(raw.get(3), "prefix", "suffix");
  split(raw.get(4), "altPrefix", "altSuffix");
  const arrowOf = (code: number): ArrowKind | undefined => {
    const v = raw.get(code);
    return v === undefined ? undefined : ARROW_BY_NAME.get(v.trim().toUpperCase());
  };
  set("arrow", arrowOf(5));
  set("arrow1", arrowOf(6) ?? undefined);
  set("arrow2", arrowOf(7) ?? undefined);
  // DIMTSZ > 0 means tick marks regardless of the block names.
  const tsz = num(142);
  if (tsz !== undefined && tsz > 0) {
    rec.arrow = rec.arrow === "oblique" ? "oblique" : "tick";
    rec.arrow1 = undefined;
    rec.arrow2 = undefined;
    set("arrowSize", tsz * k);
  }
  set("scale", num(40));
  if (!(tsz !== undefined && tsz > 0)) len(41, "arrowSize");
  len(42, "extOffset");
  len(43, "baselineSpacing");
  len(44, "extExtend");
  set("round", num(45));
  len(46, "lineExtend");
  len(49, "extFixedLength");
  if (num(290) === 0) rec.extFixedLength = 0;
  const jog = num(50);
  if (jog !== undefined) set("jogAngle", (jog * 180) / Math.PI);
  len(140, "textHeight");
  const cen = num(141);
  if (cen !== undefined) {
    set("centerMark", cen === 0 ? "none" : cen < 0 ? "line" : "mark");
    if (cen !== 0) set("centerSize", Math.abs(cen) * k);
  }
  const altf = num(143);
  if (altf !== undefined && altf !== 0) set("altFactor", altf * k);
  const lfac = num(144);
  if (lfac !== undefined && lfac !== 0) set("lengthFactor", lfac * k);
  set("tolScale", num(146));
  const gap = num(147);
  if (gap !== undefined) {
    set("gap", Math.abs(gap) * k);
    set("textFrame", gap < 0);
  }
  set("altRound", num(148));
  const tp = num(47);
  const tm = num(48);
  const tol = num(71);
  const lim = num(72);
  if (tol !== undefined || lim !== undefined) {
    let mode: TolMode = "none";
    if (lim === 1) mode = "limits";
    else if (tol === 1) mode = tp !== undefined && tm !== undefined && tp === tm ? "symmetric" : "deviation";
    set("tolMode", mode);
  }
  set("tolPlus", tp);
  set("tolMinus", tm);
  const tih = num(73);
  const toh = num(74);
  if (tih !== undefined || toh !== undefined) set("textHorizontal", tih === 1 || toh === 1);
  const flag = (code: number, key: string) => {
    const v = num(code);
    if (v !== undefined) set(key, v !== 0);
  };
  flag(75, "suppressExt1");
  flag(76, "suppressExt2");
  const tad = num(77);
  if (tad !== undefined) {
    set("textAbove", tad === 1 || tad === 2 || tad === 3);
    set("textBelow", tad === 4);
  }
  const zin = num(78);
  if (zin !== undefined) set("zeroSuppress", ZIN_BY.get(zin & 12) ?? "none");
  flag(170, "alt");
  set("altDecimals", num(171));
  flag(174, "textInside");
  flag(175, "suppressOutsideLine");
  set("angleDecimals", num(179));
  set("decimals", num(271));
  set("tolDecimals", num(272));
  const au = num(275);
  if (au !== undefined) set("angleFormat", AUNIT_BY.get(au));
  const lu = num(277);
  if (lu !== undefined) set("unitFormat", LUNIT_BY.get(lu));
  const sep = num(278);
  if (sep !== undefined && sep > 0) set("decimalSep", String.fromCharCode(sep));
  set("textMove", num(279));
  const just = num(280);
  if (just !== undefined) set("textJustify", JUST[just]);
  flag(281, "suppressLine1");
  flag(282, "suppressLine2");
  set("tolJustify", num(283));
  set("fit", num(289));
  // Keep only what the style model accepts (unknown enum values etc. fall back to defaults in dimStyleOf).
  const cleaned: Record<string, unknown> = { name };
  for (const [key, v] of Object.entries(rec)) if (v !== undefined && key !== "name") cleaned[key] = v;
  return cleaned as TableRecord;
}

/** A style fully resolved from a table record, for comparing round trips. */
export const resolvedStyle = (rec: TableRecord): DimStyle => dimStyleOf(rec);
