import { ARROW_KINDS, DEFAULT_DIM_STYLE } from "./style";

/**
 * The style manager's form, as data: one entry per DimStyle field, grouped
 * into AutoCAD's tabs. The dialog renders from this and a test pins that every
 * field of {@link DEFAULT_DIM_STYLE} has an entry, so a variable added to the
 * style cannot silently stay invisible in the UI.
 */

export type DimStyleTab = "Lines" | "Arrows" | "Text" | "Fit" | "Units" | "Alternate" | "Tolerances";
export const DIM_STYLE_TABS: readonly DimStyleTab[] = ["Lines", "Arrows", "Text", "Fit", "Units", "Alternate", "Tolerances"];

export type DimStyleField = {
  key: string;
  label: string;
  tab: DimStyleTab;
  /** DXF variable it stands for, for the tooltip. */
  dxf?: string;
} & ({ type: "number"; min?: number; max?: number; step?: number } | { type: "boolean" } | { type: "text" } | { type: "enum"; options: readonly string[] });

const num = (key: string, label: string, tab: DimStyleTab, dxf?: string, extra: { min?: number; max?: number; step?: number } = {}): DimStyleField => ({ key, label, tab, dxf, type: "number", ...extra });
const bool = (key: string, label: string, tab: DimStyleTab, dxf?: string): DimStyleField => ({ key, label, tab, dxf, type: "boolean" });
const txt = (key: string, label: string, tab: DimStyleTab, dxf?: string): DimStyleField => ({ key, label, tab, dxf, type: "text" });
const en = (key: string, label: string, tab: DimStyleTab, options: readonly string[], dxf?: string): DimStyleField => ({ key, label, tab, dxf, type: "enum", options });

export const DIM_STYLE_FIELDS: readonly DimStyleField[] = [
  txt("lineColor", "Dimension line colour", "Lines", "DIMCLRD"),
  num("lineWeight", "Dimension line weight (mm, -1 = by layer)", "Lines", "DIMLWD", { min: -1, step: 0.05 }),
  txt("extColor", "Extension line colour", "Lines", "DIMCLRE"),
  num("extWeight", "Extension line weight (mm, -1 = by layer)", "Lines", "DIMLWE", { min: -1, step: 0.05 }),
  num("lineExtend", "Extend dimension line past ticks", "Lines", "DIMDLE", { min: 0, step: 0.1 }),
  num("baselineSpacing", "Baseline spacing", "Lines", "DIMDLI", { min: 0, step: 0.1 }),
  num("extExtend", "Extend extension line past dimension line", "Lines", "DIMEXE", { min: 0, step: 0.1 }),
  num("extOffset", "Offset from origin", "Lines", "DIMEXO", { min: 0, step: 0.1 }),
  bool("suppressLine1", "Suppress dimension line 1", "Lines", "DIMSD1"),
  bool("suppressLine2", "Suppress dimension line 2", "Lines", "DIMSD2"),
  bool("suppressExt1", "Suppress extension line 1", "Lines", "DIMSE1"),
  bool("suppressExt2", "Suppress extension line 2", "Lines", "DIMSE2"),
  num("extFixedLength", "Fixed-length extension lines (0 = off)", "Lines", "DIMFXL", { min: 0, step: 0.1 }),

  en("arrow", "Arrowheads", "Arrows", ARROW_KINDS, "DIMBLK"),
  en("arrow1", "First arrowhead (blank = same)", "Arrows", ["", ...ARROW_KINDS], "DIMBLK1"),
  en("arrow2", "Second arrowhead (blank = same)", "Arrows", ["", ...ARROW_KINDS], "DIMBLK2"),
  en("leaderArrow", "Leader arrowhead (blank = same)", "Arrows", ["", ...ARROW_KINDS], "DIMLDRBLK"),
  txt("arrowBlock", "Custom arrowhead block", "Arrows", "DIMBLK"),
  num("arrowSize", "Arrow size", "Arrows", "DIMASZ", { min: 0, step: 0.1 }),
  num("arrowAngle", "Arrow opening angle (degrees)", "Arrows", undefined, { min: 1, max: 120, step: 1 }),
  en("centerMark", "Centre marks", "Arrows", ["none", "mark", "line"], "DIMCEN"),
  num("centerSize", "Centre mark size", "Arrows", "DIMCEN", { min: 0, step: 0.1 }),
  en("arcSymbol", "Arc length symbol", "Arrows", ["before", "above", "none"], "DIMARCSYM"),
  num("jogAngle", "Radius jog angle (degrees)", "Arrows", "DIMJOGANG", { min: 5, max: 90, step: 1 }),

  txt("textStyle", "Text style", "Text", "DIMTXSTY"),
  num("textHeight", "Text height", "Text", "DIMTXT", { min: 0.01, step: 0.1 }),
  txt("textColor", "Text colour", "Text", "DIMCLRT"),
  txt("textFill", "Text background fill colour", "Text", "DIMTFILL"),
  bool("textFrame", "Frame around text", "Text", "DIMGAP"),
  num("gap", "Offset from dimension line", "Text", "DIMGAP", { min: 0, step: 0.1 }),
  bool("textAbove", "Text above the dimension line", "Text", "DIMTAD"),
  bool("textBelow", "Text below the dimension line", "Text", "DIMTAD"),
  en("textJustify", "Horizontal position", "Text", ["center", "ext1", "ext2", "over1", "over2"], "DIMJUST"),
  bool("textHorizontal", "Text always horizontal", "Text", "DIMTIH / DIMTOH"),

  num("fit", "Fit method (0-3)", "Fit", "DIMATFIT", { min: 0, max: 3, step: 1 }),
  bool("textInside", "Always keep text between extension lines", "Fit", "DIMTIX"),
  bool("suppressOutsideLine", "Suppress arrows outside extension lines", "Fit", "DIMSOXD"),
  num("textMove", "Text placement when moved (0 beside, 1 leader, 2 free)", "Fit", "DIMTMOVE", { min: 0, max: 2, step: 1 }),
  num("scale", "Overall scale", "Fit", "DIMSCALE", { min: 0.001, step: 0.1 }),
  bool("annotative", "Annotative", "Fit"),

  en("unitFormat", "Unit format", "Units", ["decimal", "scientific", "engineering", "architectural", "fractional"], "DIMLUNIT"),
  num("decimals", "Precision (decimals, or 1/2^n)", "Units", "DIMDEC", { min: 0, max: 8, step: 1 }),
  num("round", "Round off to", "Units", "DIMRND", { min: 0, step: 0.01 }),
  txt("decimalSep", "Decimal separator", "Units", "DIMDSEP"),
  en("zeroSuppress", "Zero suppression", "Units", ["none", "leading", "trailing", "both"], "DIMZIN"),
  num("lengthFactor", "Measurement scale factor", "Units", "DIMLFAC", { step: 0.001 }),
  txt("prefix", "Prefix", "Units", "DIMPOST"),
  txt("suffix", "Suffix", "Units", "DIMPOST"),
  en("angleFormat", "Angle format", "Units", ["degrees", "dms", "gradians", "radians"], "DIMAUNIT"),
  num("angleDecimals", "Angle precision", "Units", "DIMADEC", { min: 0, max: 8, step: 1 }),
  bool("referenceParens", "Reference dimensions in parentheses", "Units"),

  bool("alt", "Show alternate units", "Alternate", "DIMALT"),
  num("altFactor", "Multiplier for alternate units", "Alternate", "DIMALTF", { step: 0.001 }),
  num("altDecimals", "Precision", "Alternate", "DIMALTD", { min: 0, max: 8, step: 1 }),
  num("altRound", "Round off to", "Alternate", "DIMALTRND", { min: 0, step: 0.01 }),
  txt("altPrefix", "Prefix", "Alternate", "DIMAPOST"),
  txt("altSuffix", "Suffix", "Alternate", "DIMAPOST"),
  en("altPlacement", "Placement", "Alternate", ["after", "below"], "DIMAPOST"),

  en("tolMode", "Method", "Tolerances", ["none", "symmetric", "deviation", "limits", "basic"], "DIMTOL / DIMLIM"),
  num("tolPlus", "Upper value", "Tolerances", "DIMTP", { step: 0.01 }),
  num("tolMinus", "Lower value", "Tolerances", "DIMTM", { step: 0.01 }),
  num("tolDecimals", "Precision", "Tolerances", "DIMTDEC", { min: 0, max: 8, step: 1 }),
  num("tolScale", "Scaling for height", "Tolerances", "DIMTFAC", { min: 0.1, step: 0.1 }),
  num("tolJustify", "Vertical position (0 bottom, 1 middle, 2 top)", "Tolerances", "DIMTOLJ", { min: 0, max: 2, step: 1 }),
];

/** Style fields with no form entry (the name is edited elsewhere; child styles have their own scope selector). */
export const NON_FORM_KEYS: readonly string[] = ["name", "children"];

/** Keys of the default style the form does not cover — empty when the form is complete. */
export function missingFormFields(): string[] {
  const have = new Set(DIM_STYLE_FIELDS.map((f) => f.key));
  return Object.keys(DEFAULT_DIM_STYLE).filter((k) => !NON_FORM_KEYS.includes(k) && !have.has(k));
}
