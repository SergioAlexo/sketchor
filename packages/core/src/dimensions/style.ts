import type { TableRecord } from "../tables";

/**
 * Dimension style (D-03): the DXF DIMVARS that matter, grouped like AutoCAD's
 * dialog (Lines / Symbols and arrows / Text / Fit / Primary units / Alternate
 * units / Tolerances). Every length is in drawing units (mm) at DIMSCALE 1 —
 * a dimension's own `scale` multiplies them, which is how a dimension inside
 * a scaled block insert stays proportionate. The DXF variable each field
 * stands for is named in its comment; D-10 maps them.
 *
 * Fields the layout cannot honour yet (colours, line weights, block arrow
 * heads, text style) are still stored, so a style round-trips through
 * `.sketchor` and DXF without loss.
 */

export type ArrowKind =
  | "closed"
  | "closedBlank"
  | "closedFilled30"
  | "open"
  | "open30"
  | "right"
  | "dot"
  | "dotSmall"
  | "dotBlank"
  | "tick"
  | "oblique"
  | "integral"
  | "datumFilled"
  | "datumBlank"
  | "boxFilled"
  | "boxBlank"
  | "origin"
  | "origin2"
  | "bar"
  | "none";

export const ARROW_KINDS: readonly ArrowKind[] = [
  "closed", "closedBlank", "closedFilled30", "open", "open30", "right", "dot", "dotSmall", "dotBlank", "tick",
  "oblique", "integral", "datumFilled", "datumBlank", "boxFilled", "boxBlank", "origin", "origin2", "bar", "none",
];

export type UnitFormat = "decimal" | "scientific" | "engineering" | "architectural" | "fractional";
export type AngleFormat = "degrees" | "dms" | "gradians" | "radians";
export type TolMode = "none" | "symmetric" | "deviation" | "limits" | "basic";
export type DimFamily = "angular" | "radial" | "diametric" | "ordinate";

export interface DimStyle extends TableRecord {
  /* ---- Lines ---- */
  /** DIMCLRD / DIMLWD — dimension line colour ("" = by block) and weight (mm, -1 = by layer). */
  lineColor: string;
  lineWeight: number;
  /** DIMCLRE / DIMLWE. */
  extColor: string;
  extWeight: number;
  /** DIMDLE — dimension line extension past the ticks (oblique / tick arrows). */
  lineExtend: number;
  /** DIMEXE — extension past the dimension line. */
  extExtend: number;
  /** DIMEXO — gap between the measured point and the extension line. */
  extOffset: number;
  /** DIMSD1/2, DIMSE1/2 — suppress dimension line halves / extension lines. */
  suppressLine1: boolean;
  suppressLine2: boolean;
  suppressExt1: boolean;
  suppressExt2: boolean;
  /** DIMFXLON / DIMFXL — fixed-length extension lines (0 = off). */
  extFixedLength: number;
  /** DIMDLI — spacing of baseline dimension lines. */
  baselineSpacing: number;

  /* ---- Symbols and arrows ---- */
  /** DIMBLK1/2 (DIMSAH): the arrow at each end; "" = same as `arrow`. */
  arrow: ArrowKind;
  arrow1: ArrowKind | "";
  arrow2: ArrowKind | "";
  /** DIMLDRBLK — leader arrow (radial / diametric / ordinate leaders). */
  leaderArrow: ArrowKind | "";
  /** Any block as the arrow head (DIMBLK names it); "" = use the kind above. Stored; drawn from B-xx later. */
  arrowBlock: string;
  /** DIMASZ — arrow length; arrow head full opening angle, degrees. */
  arrowSize: number;
  arrowAngle: number;
  /** DIMCEN — centre marks of radial / diametric dimensions: "mark" (cross), "line" (centre lines) or none; `centerSize` is the cross half-length. */
  centerMark: "none" | "mark" | "line";
  centerSize: number;
  /** DIMARCSYM — arc length symbol. */
  arcSymbol: "before" | "above" | "none";
  /** DIMJOGANG, degrees. */
  jogAngle: number;

  /* ---- Text ---- */
  /** DIMTXSTY — a `textStyles` record. */
  textStyle: string;
  /** DIMTXT — text height. */
  textHeight: number;
  /** DIMCLRT. */
  textColor: string;
  /** DIMTFILL / DIMTFILLCLR — background fill colour ("" = none). */
  textFill: string;
  /** DIMGAP < 0 in AutoCAD: a frame around the text. */
  textFrame: boolean;
  /** DIMGAP — clearance between text and dimension line. */
  gap: number;
  /** DIMTAD: text sits above the dimension line (true) or breaks it (false). */
  textAbove: boolean;
  /** DIMTAD 4: text sits below the line (wins over `textAbove`). */
  textBelow: boolean;
  /** DIMJUST: centred, at the first / second extension line, over the first / second. */
  textJustify: "center" | "ext1" | "ext2" | "over1" | "over2";
  /** DIMTIH/DIMTOH: text always horizontal. */
  textHorizontal: boolean;

  /* ---- Fit ---- */
  /** DIMATFIT 0..3. */
  fit: number;
  /** DIMTIX — always put the text between the extension lines. */
  textInside: boolean;
  /** DIMSOXD — suppress the dimension line when the arrows are outside. */
  suppressOutsideLine: boolean;
  /** DIMTMOVE 0 beside the line, 1 with a leader, 2 free. */
  textMove: number;
  /** DIMSCALE — overall scale of every size above. */
  scale: number;
  /** Follows the viewport / annotation scale (D-08). */
  annotative: boolean;

  /* ---- Primary units ---- */
  /** DIMLUNIT. Non-decimal formats read the measured value, times `lengthFactor`, as inches. */
  unitFormat: UnitFormat;
  /** DIMDEC; the denominator exponent (1/2^n) for architectural / fractional. */
  decimals: number;
  /** DIMRND — round to this step (0 = off). */
  round: number;
  decimalSep: string;
  /** DIMZIN: which zeros go. */
  zeroSuppress: "none" | "leading" | "trailing" | "both";
  /** DIMLFAC — measured length multiplier. */
  lengthFactor: number;
  /** DIMPOST split into prefix/suffix. */
  prefix: string;
  suffix: string;
  /** DIMAUNIT / DIMADEC. */
  angleFormat: AngleFormat;
  angleDecimals: number;
  /** Non-driving (reference) dimensions are shown in parentheses. */
  referenceParens: boolean;

  /* ---- Alternate units ---- */
  /** DIMALT, DIMALTF (alt = measured × factor), DIMALTD, DIMALTRND, DIMAPOST, DIMALTTD. */
  alt: boolean;
  altFactor: number;
  altDecimals: number;
  altRound: number;
  altPrefix: string;
  altSuffix: string;
  /** Alternate value after the primary (below it needs MTEXT stacking — D-04). */
  altPlacement: "after" | "below";

  /* ---- Tolerances ---- */
  /** DIMTOL / DIMLIM / basic. */
  tolMode: TolMode;
  /** DIMTP / DIMTM. */
  tolPlus: number;
  tolMinus: number;
  /** DIMTFAC — tolerance text height factor. */
  tolScale: number;
  /** DIMTDEC. */
  tolDecimals: number;
  /** DIMTOLJ: 0 bottom, 1 middle, 2 top. */
  tolJustify: number;

  /**
   * Child styles (AutoCAD's `STANDARD$2`): fields that differ for one family of
   * dimensions — angular, radial, diametric, ordinate. Applied over the parent
   * and under a dimension's own overrides.
   */
  children?: Partial<Record<DimFamily, Partial<DimStyle>>>;
  [extra: string]: unknown;
}

export const DEFAULT_DIM_STYLE: DimStyle = {
  name: "Standard",
  lineColor: "",
  lineWeight: -1,
  extColor: "",
  extWeight: -1,
  lineExtend: 0,
  extExtend: 1.25,
  extOffset: 0.625,
  suppressLine1: false,
  suppressLine2: false,
  suppressExt1: false,
  suppressExt2: false,
  extFixedLength: 0,
  baselineSpacing: 3.75,
  arrow: "closed",
  arrow1: "",
  arrow2: "",
  leaderArrow: "",
  arrowBlock: "",
  arrowSize: 2.5,
  arrowAngle: 20,
  centerMark: "none",
  centerSize: 2.5,
  arcSymbol: "before",
  jogAngle: 45,
  textStyle: "Standard",
  textHeight: 2.5,
  textColor: "",
  textFill: "",
  textFrame: false,
  gap: 0.625,
  textAbove: true,
  textBelow: false,
  textJustify: "center",
  textHorizontal: false,
  fit: 3,
  textInside: false,
  suppressOutsideLine: false,
  textMove: 0,
  scale: 1,
  annotative: false,
  unitFormat: "decimal",
  decimals: 2,
  round: 0,
  decimalSep: ".",
  zeroSuppress: "trailing",
  lengthFactor: 1,
  prefix: "",
  suffix: "",
  angleFormat: "degrees",
  angleDecimals: 1,
  referenceParens: false,
  alt: false,
  altFactor: 1 / 25.4,
  altDecimals: 2,
  altRound: 0,
  altPrefix: "",
  altSuffix: "",
  altPlacement: "after",
  tolMode: "none",
  tolPlus: 0,
  tolMinus: 0,
  tolScale: 1,
  tolDecimals: 2,
  tolJustify: 1,
};

/** Built-in presets, authored from the standards' proportions (not copied from any CAD product): ISO 129 (ISO-25), ASME Y14.5 (ANSI), DIN 406, JIS Z 8317, GOST 2.307, Architectural (ft-in, ticks). */
export const DIM_STYLE_PRESETS: readonly DimStyle[] = [
  { ...DEFAULT_DIM_STYLE, name: "ISO-25" },
  {
    ...DEFAULT_DIM_STYLE,
    name: "ANSI",
    textHeight: 3.5,
    arrowSize: 3,
    extOffset: 1.5,
    extExtend: 1.5,
    gap: 1,
    baselineSpacing: 6,
    textAbove: false,
    textHorizontal: true,
    zeroSuppress: "none",
  },
  {
    ...DEFAULT_DIM_STYLE,
    name: "DIN",
    textHeight: 3.5,
    arrowSize: 3.5,
    arrowAngle: 15,
    extOffset: 1,
    extExtend: 2,
    gap: 1,
    baselineSpacing: 7,
    decimalSep: ",",
    centerMark: "mark",
    centerSize: 2,
  },
  {
    ...DEFAULT_DIM_STYLE,
    name: "JIS",
    textHeight: 3.15,
    arrowSize: 3,
    arrowAngle: 15,
    extOffset: 1,
    extExtend: 2,
    gap: 1,
    baselineSpacing: 7,
    centerMark: "mark",
    centerSize: 2,
  },
  {
    ...DEFAULT_DIM_STYLE,
    name: "GOST",
    textHeight: 3.5,
    arrowSize: 3.5,
    arrowAngle: 15,
    extOffset: 0,
    extExtend: 2,
    gap: 1,
    baselineSpacing: 7,
    textAbove: true,
    decimalSep: ",",
  },
  {
    ...DEFAULT_DIM_STYLE,
    name: "Architectural",
    arrow: "tick",
    textHeight: 2.4,
    arrowSize: 2.4,
    lineExtend: 1.6,
    extOffset: 1.6,
    extExtend: 3.2,
    gap: 1.2,
    baselineSpacing: 9.5,
    textAbove: true,
    unitFormat: "architectural",
    decimals: 4,
    // Feet-inches formats read the value as inches; the drawing is in mm.
    lengthFactor: 1 / 25.4,
    zeroSuppress: "none",
  },
];

const ENUMS: Record<string, readonly string[]> = {
  arrow: ARROW_KINDS,
  arrow1: ["", ...ARROW_KINDS],
  arrow2: ["", ...ARROW_KINDS],
  leaderArrow: ["", ...ARROW_KINDS],
  centerMark: ["none", "mark", "line"],
  arcSymbol: ["before", "above", "none"],
  textJustify: ["center", "ext1", "ext2", "over1", "over2"],
  unitFormat: ["decimal", "scientific", "engineering", "architectural", "fractional"],
  angleFormat: ["degrees", "dms", "gradians", "radians"],
  altPlacement: ["after", "below"],
  tolMode: ["none", "symmetric", "deviation", "limits", "basic"],
  zeroSuppress: ["none", "leading", "trailing", "both"],
};

/** The family a dimension kind belongs to for child styles (linear / aligned / arc length / jogged take the parent). */
export function dimFamily(kind: string): DimFamily | null {
  switch (kind) {
    case "angular2l":
    case "angular3p":
      return "angular";
    case "radial":
    case "jogged":
      return "radial";
    case "diametric":
      return "diametric";
    case "ordinate":
      return "ordinate";
    default:
      return null;
  }
}

function merge(out: DimStyle, src: Record<string, unknown> | undefined): void {
  if (!src) return;
  for (const [k, v] of Object.entries(src)) {
    if (v === undefined || k === "name" || k === "children") continue;
    const def = (DEFAULT_DIM_STYLE as Record<string, unknown>)[k];
    const target = out as Record<string, unknown>;
    if (typeof def === "number") {
      if (typeof v === "number" && Number.isFinite(v)) target[k] = v;
    } else if (typeof def === "boolean") {
      if (typeof v === "boolean") target[k] = v;
    } else if (typeof def === "string") {
      if (typeof v === "string" && (!ENUMS[k] || ENUMS[k].includes(v))) target[k] = v;
    } else target[k] = v;
  }
}

/**
 * A loosely-typed table record (or nothing) as a complete {@link DimStyle}.
 * Bad numbers and unknown enum values fall back to the default. `kind` selects
 * the child style for angular / radial / diametric / ordinate dimensions.
 */
export function dimStyleOf(record: TableRecord | undefined, overrides?: Partial<DimStyle>, kind?: string): DimStyle {
  const out: DimStyle = { ...DEFAULT_DIM_STYLE };
  merge(out, record);
  const fam = kind ? dimFamily(kind) : null;
  const kids = record?.children as DimStyle["children"] | undefined;
  if (fam && kids && typeof kids === "object") merge(out, kids[fam] as Record<string, unknown> | undefined);
  merge(out, overrides);
  out.name = record?.name ?? out.name;
  if (record?.children && typeof record.children === "object") out.children = record.children as DimStyle["children"];
  if (out.textHeight <= 0) out.textHeight = DEFAULT_DIM_STYLE.textHeight;
  if (out.arrowSize < 0) out.arrowSize = 0;
  if (out.scale <= 0) out.scale = 1;
  out.decimals = Math.min(8, Math.max(0, Math.round(out.decimals)));
  out.angleDecimals = Math.min(8, Math.max(0, Math.round(out.angleDecimals)));
  out.altDecimals = Math.min(8, Math.max(0, Math.round(out.altDecimals)));
  out.tolDecimals = Math.min(8, Math.max(0, Math.round(out.tolDecimals)));
  if (out.lengthFactor === 0) out.lengthFactor = 1;
  if (out.altFactor === 0) out.altFactor = DEFAULT_DIM_STYLE.altFactor;
  if (out.round < 0) out.round = 0;
  if (out.altRound < 0) out.altRound = 0;
  return out;
}

/** The fields in which `b` differs from `a` (both complete styles), for the Compare dialog and the per-dimension override diff. */
export function diffDimStyles(a: DimStyle, b: DimStyle): { key: string; a: unknown; b: unknown }[] {
  const out: { key: string; a: unknown; b: unknown }[] = [];
  for (const key of Object.keys(DEFAULT_DIM_STYLE)) {
    if (key === "name" || key === "children") continue;
    if (a[key] !== b[key]) out.push({ key, a: a[key], b: b[key] });
  }
  return out;
}

/** The style as a plain table record: only the fields that differ from the defaults (small files), plus the name. */
export function dimStyleRecord(style: DimStyle): TableRecord {
  const rec: TableRecord = { name: style.name };
  for (const [k, v] of Object.entries(style)) {
    if (k === "name") continue;
    if (k === "children") {
      if (v && Object.keys(v as object).length) rec.children = v;
      continue;
    }
    if ((DEFAULT_DIM_STYLE as Record<string, unknown>)[k] !== v) rec[k] = v;
  }
  return rec;
}
