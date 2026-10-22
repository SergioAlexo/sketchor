/**
 * RN-21: material, thickness, sheet-size and machine tables as plain data.
 * Ported from the Sheet Nesting Calculator by Oleksandr Borenko.
 *
 * Every number here is a typical shop starting point, NOT a measured or
 * guaranteed value: kerf, web, margin and clamp depend on the actual machine,
 * nozzle, bit and material. Each table carries `estimate: true` so the UI can
 * label it "estimate - set your machine's values", and user edits are meant
 * to persist and win over these defaults. Lengths are inches (`unit: "in"`);
 * `value` strings are what a user would type (`"1/8"`, `"0.125"`) and parse
 * with `parseLen`.
 */

export type MaterialId = "al5052" | "al6061" | "ss" | "cs" | "plastic" | "plywood" | "stone" | "quartz";
export type MachineId = "laser" | "waterjet" | "router" | "other";

/** A length typed by a user, with the unit it is in. */
export interface LengthField {
  v: string;
  u: "in" | "ft" | "mm" | "cm" | "m";
}

export interface MaterialInfo {
  id: MaterialId;
  /** File-name token used by shops for this material (DXF names, layer prefixes). */
  fileToken: string;
}

export const MATERIALS: readonly MaterialInfo[] = [
  { id: "al5052", fileToken: "AL5052" },
  { id: "al6061", fileToken: "AL6061" },
  { id: "ss", fileToken: "STAINLESS" },
  { id: "cs", fileToken: "CARBON-STEEL" },
  { id: "plastic", fileToken: "plastic" },
  { id: "plywood", fileToken: "plywood" },
  { id: "stone", fileToken: "stone" },
  { id: "quartz", fileToken: "quartz" },
];

export function materialFileToken(id: string): string {
  return MATERIALS.find((m) => m.id === id)?.fileToken ?? id;
}

export interface SheetSize {
  w: number;
  h: number;
}

/** Standard sheet sizes per material, inches. */
export interface SheetCatalog {
  unit: "in";
  estimate: true;
  sizes: Record<MaterialId, SheetSize[]>;
}

const METAL_SHEETS: SheetSize[] = [
  { w: 60, h: 120 },
  { w: 60, h: 144 },
  { w: 48, h: 96 },
  { w: 48, h: 120 },
];

/** A fresh copy each call, so callers can add / remove custom sizes without touching the defaults. */
export function defaultSheets(): SheetCatalog {
  const copy = (l: SheetSize[]) => l.map((s) => ({ ...s }));
  return {
    unit: "in",
    estimate: true,
    sizes: {
      al5052: copy(METAL_SHEETS),
      al6061: copy(METAL_SHEETS),
      ss: copy(METAL_SHEETS),
      cs: copy(METAL_SHEETS),
      plastic: [
        { w: 48, h: 96 },
        { w: 48, h: 120 },
        { w: 60, h: 120 },
      ],
      plywood: [{ w: 48, h: 96 }],
      stone: [{ w: 30, h: 144 }],
      quartz: [
        { w: 63, h: 126 },
        { w: 65, h: 130 },
      ],
    },
  };
}

export interface ThicknessOption {
  /** What to type / store: a decimal or fraction in inches ("1/8"). */
  value: string;
  /** Decimal inches. */
  inches: number;
  /** Extra caption, e.g. "11 ga" or "0.125". */
  label?: string;
}

const t = (value: string, inches: number, label?: string): ThicknessOption => ({ value, inches, label });
const FRACTIONAL_TAIL: ThicknessOption[] = [
  t("3/16", 0.1875, "0.188"),
  t("1/4", 0.25, "0.250"),
  t("5/16", 0.3125, "0.313"),
  t("3/8", 0.375, "0.375"),
  t("1/2", 0.5, "0.500"),
  t("5/8", 0.625, "0.625"),
  t("3/4", 0.75, "0.750"),
];

const TH_AL: ThicknessOption[] = [
  t("0.025", 0.025),
  t("0.032", 0.032),
  t("0.040", 0.04),
  t("0.050", 0.05),
  t("1/16", 0.0625, "0.063"),
  t("0.080", 0.08),
  t("0.090", 0.09),
  t("0.100", 0.1),
  t("1/8", 0.125, "0.125"),
  t("0.160", 0.16),
  ...FRACTIONAL_TAIL,
];
const TH_SS: ThicknessOption[] = [
  t("0.025", 0.025, "24 ga"),
  t("0.031", 0.031, "22 ga"),
  t("0.037", 0.037, "20 ga"),
  t("0.050", 0.05, "18 ga"),
  t("0.062", 0.062, "16 ga"),
  t("0.078", 0.078, "14 ga"),
  t("0.109", 0.109, "12 ga"),
  t("1/8", 0.125, "11 ga · 0.125"),
  t("0.141", 0.141, "10 ga"),
  ...FRACTIONAL_TAIL,
];
const TH_CS: ThicknessOption[] = [
  t("0.0239", 0.0239, "24 ga"),
  t("0.0299", 0.0299, "22 ga"),
  t("0.0359", 0.0359, "20 ga"),
  t("0.0478", 0.0478, "18 ga"),
  t("0.0598", 0.0598, "16 ga"),
  t("0.0747", 0.0747, "14 ga"),
  t("0.1046", 0.1046, "12 ga"),
  t("0.1196", 0.1196, "11 ga"),
  t("0.1345", 0.1345, "10 ga"),
  t("0.1793", 0.1793, "7 ga"),
  ...FRACTIONAL_TAIL,
];
const TH_PLASTIC: ThicknessOption[] = [t("0.030", 0.03), t("1/16", 0.0625, "0.063"), t("3/32", 0.09375, "0.094"), t("1/8", 0.125, "0.125"), ...FRACTIONAL_TAIL];
const TH_STONE: ThicknessOption[] = [t("3/8", 0.375, "0.375"), t("1/2", 0.5, "0.500"), t("3/4", 0.75, "0.750")];
const TH_PLYWOOD: ThicknessOption[] = [t("1/8", 0.125, "0.125"), t("1/4", 0.25, "0.250"), t("3/8", 0.375, "0.375"), t("1/2", 0.5, "0.500"), t("5/8", 0.625, "0.625"), t("3/4", 0.75, "0.750")];

/** Standard thicknesses (inches) and gauge captions per material. Treat as estimates: gauge tables differ by mill and standard. */
export const THICKNESSES: { unit: "in"; estimate: true; byMaterial: Record<MaterialId, readonly ThicknessOption[]> } = {
  unit: "in",
  estimate: true,
  byMaterial: { al5052: TH_AL, al6061: TH_AL, ss: TH_SS, cs: TH_CS, plastic: TH_PLASTIC, plywood: TH_PLYWOOD, stone: TH_STONE, quartz: TH_STONE },
};

/** Fallback list for a material with no table of its own. */
export const THICKNESS_ANY: readonly ThicknessOption[] = [t("1/16", 0.0625, "0.063"), t("1/8", 0.125, "0.125"), ...FRACTIONAL_TAIL.filter((o) => o.value !== "5/16")];

export function thicknessesFor(material: string): readonly ThicknessOption[] {
  return THICKNESSES.byMaterial[material as MaterialId] ?? THICKNESS_ANY;
}

export const MACHINES: readonly MachineId[] = ["laser", "waterjet", "router", "other"];

export interface MachineParams {
  /** Cut width removed (laser kerf, waterjet stream, router bit diameter). */
  kerf: LengthField;
  /** Minimum material left between parts. */
  web: LengthField;
  /** Unused border around the sheet edge. */
  margin: LengthField;
  /** Clamp strip depth along one long edge. */
  clamp: LengthField;
  /** Bed size; empty string = unknown / unlimited. */
  bedW: LengthField;
  bedH: LengthField;
}

const lf = (v: string): LengthField => ({ v, u: "in" });

/** Per-machine starting values. Marked as estimates: the user should enter their machine's real numbers. */
export function defaultMachines(): { estimate: true; machines: Record<MachineId, MachineParams> } {
  return {
    estimate: true,
    machines: {
      laser: { kerf: lf("0.012"), web: lf("1/8"), margin: lf("1/4"), clamp: lf("3"), bedW: lf("60"), bedH: lf("120") },
      waterjet: { kerf: lf("0.04"), web: lf("1/4"), margin: lf("1/2"), clamp: lf("3"), bedW: lf("60"), bedH: lf("144") },
      router: { kerf: lf("1/4"), web: lf("1/8"), margin: lf("1/2"), clamp: lf("0"), bedW: lf("60"), bedH: lf("120") },
      other: { kerf: lf("0.04"), web: lf("1/4"), margin: lf("1/4"), clamp: lf("3"), bedW: lf(""), bedH: lf("") },
    },
  };
}

/** Rotation step codes: the allowed part angles on the sheet. */
export type RotationCode = "none" | "flip" | "r90" | "r45" | "r30" | "r15" | "r10" | "free";

export const ROTATION_STEP_DEG: Record<Exclude<RotationCode, "none" | "flip">, number> = { r90: 90, r45: 45, r30: 30, r15: 15, r10: 10, free: 1 };

/** The angles (degrees, ascending from 0) a rotation code allows. `none` = [0], `flip` = [0, 180]; unknown codes fall back to 90-degree steps. */
export function rotationAngles(code: string): number[] {
  if (code === "none") return [0];
  if (code === "flip") return [0, 180];
  const step = (ROTATION_STEP_DEG as Record<string, number>)[code] ?? 90;
  const out: number[] = [];
  for (let d = 0; d < 360; d += step) out.push(d);
  return out;
}

/** Stone and quartz have grain / pattern, so default to no rotation; everything else rotates in quarter turns. */
export function defaultRotationFor(material: string): RotationCode {
  return material === "stone" || material === "quartz" ? "none" : "r90";
}

/** Fine-ness of the raster used by the nester, as cell size in inches per accuracy setting. */
export const ACCURACY_CELL_IN = { fast: 0.1, normal: 0.05, precise: 0.025 } as const;
