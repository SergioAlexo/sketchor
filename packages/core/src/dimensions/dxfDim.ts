import type { DimensionEntity } from "../entities";
import type { Point } from "../geometry";
import { pair } from "../dxfw/write";

/**
 * D-10: DIMENSION records. `dimensionRecordText` writes the AcDbDimension part
 * of an entity (everything after the common entity head), `dimensionFromRecord`
 * reads one back. Both work in the file's units; callers scale.
 *
 * Kinds without a DIMENSION type of their own (arc length is ARC_DIMENSION,
 * jogged is LARGE_RADIAL_DIMENSION) are not written here — {@link hasDimensionRecord}
 * is false for them and the writer explodes them into their parts.
 */

const RAD_TO_DEG = 180 / Math.PI;
const DEG_TO_RAD = Math.PI / 180;

const TYPE: Partial<Record<DimensionEntity["kind"], number>> = {
  linear: 0,
  aligned: 1,
  angular2l: 2,
  diametric: 3,
  radial: 4,
  angular3p: 5,
  ordinate: 6,
};

export function hasDimensionRecord(e: DimensionEntity): boolean {
  return TYPE[e.kind] !== undefined && e.defPoints.length >= pointsNeeded(e.kind);
}

function pointsNeeded(kind: DimensionEntity["kind"]): number {
  switch (kind) {
    case "linear":
    case "aligned":
    case "ordinate":
      return 3;
    case "angular3p":
      return 4;
    case "angular2l":
      return 5;
    default:
      return 2;
  }
}

const P = (code: number, p: Point): string => pair(code, p.x) + pair(code + 10, p.y) + pair(code + 20, 0);
const I = (code: number, v: number): string => `${code}\n${Math.round(v)}\n`;

/**
 * The DIMENSION body: block name (2), definition and text points, type flags,
 * override text, style, then the per-type subclass with its definition points.
 * `textAt` is the text's middle point (group 11), `measure` the actual value
 * (group 42; radians for angles).
 */
export function dimensionRecordText(e: DimensionEntity, o: { blockName: string; style: string; textAt: Point; measure: number }): string {
  const d = e.defPoints;
  let flags = (TYPE[e.kind] ?? 0) | 32;
  if (e.kind === "ordinate" && (e.axis ?? "x") === "x") flags |= 64;
  if (e.textPos) flags |= 128;
  // Group 10 is the definition point whose meaning depends on the type; the rest follow AutoCAD's layout per subclass.
  let first: Point;
  let sub = "";
  switch (e.kind) {
    case "linear":
    case "aligned":
      first = d[2];
      sub =
        `100\nAcDbAlignedDimension\n` +
        P(13, d[0]) +
        P(14, d[1]) +
        // Group 50 is the dimension line's direction: the rotation for linear, the p1 -> p2 direction for aligned (AutoCAD derives it; ezdxf reads it).
        pair(50, (e.kind === "linear" ? (e.angle ?? 0) : Math.atan2(d[1].y - d[0].y, d[1].x - d[0].x)) * RAD_TO_DEG) +
        (e.kind === "linear" ? `100\nAcDbRotatedDimension\n` : "");
      break;
    case "angular2l":
      first = d[3]; // 10 is the second line's end; 16 locates the arc
      sub = `100\nAcDb2LineAngularDimension\n` + P(13, d[0]) + P(14, d[1]) + P(15, d[2]) + P(16, d[4]);
      break;
    case "angular3p":
      first = d[3];
      sub = `100\nAcDb3PointAngularDimension\n` + P(13, d[1]) + P(14, d[2]) + P(15, d[0]);
      break;
    case "diametric": {
      // 15 is the far point on the circle, 10 the opposite one.
      first = { x: 2 * d[0].x - d[1].x, y: 2 * d[0].y - d[1].y };
      sub = `100\nAcDbDiametricDimension\n` + P(15, d[1]) + pair(40, 0);
      break;
    }
    case "radial":
      first = d[0];
      sub = `100\nAcDbRadialDimension\n` + P(15, d[1]) + pair(40, 0);
      break;
    default:
      // ordinate
      first = d[0];
      sub = `100\nAcDbOrdinateDimension\n` + P(13, d[1]) + P(14, d[2]);
      break;
  }
  return (
    `100\nAcDbDimension\n2\n${o.blockName}\n` +
    P(10, first) +
    P(11, o.textAt) +
    I(70, flags) +
    (e.textOverride ? `1\n${e.textOverride.replace(/[\r\n]+/g, " ")}\n` : "") +
    `3\n${o.style}\n` +
    (Number.isFinite(o.measure) ? pair(42, o.measure) : "") +
    sub
  );
}

export interface DimRecordReader {
  pairs: readonly { code: number; value: string }[];
}

/** A DIMENSION record as an entity (points in mm: `k` is mm per file unit), or null for a type this build has no entity for. `measure` is group 42 in radians / mm when present. */
export function dimensionFromRecord(rec: DimRecordReader, k: number): { entity: Omit<DimensionEntity, "id">; blockName: string; measure: number | null } | null {
  const get = (code: number): string | undefined => rec.pairs.find((p) => p.code === code)?.value;
  const num = (code: number, dflt = 0): number => {
    const v = get(code);
    const n = v === undefined ? NaN : Number(v);
    return Number.isFinite(n) ? n : dflt;
  };
  const has = (code: number): boolean => get(code) !== undefined;
  const pt = (code: number): Point => ({ x: num(code) * k, y: num(code + 10) * k });
  const type = Math.round(num(70, 0));
  const kind = (["linear", "aligned", "angular2l", "diametric", "radial", "angular3p", "ordinate"] as const)[type & 7];
  const base: Omit<DimensionEntity, "id"> = { type: "dimension", kind, defPoints: [], driving: false };
  const need = (...codes: number[]): boolean => codes.every((c) => has(c) && has(c + 10));
  switch (kind) {
    case "linear":
    case "aligned":
      if (!need(10, 13, 14)) return null;
      base.defPoints = [pt(13), pt(14), pt(10)];
      if (kind === "linear") base.angle = num(50, 0) * DEG_TO_RAD;
      break;
    case "angular2l":
      if (!need(10, 13, 14, 15, 16)) return null;
      base.defPoints = [pt(13), pt(14), pt(15), pt(10), pt(16)];
      break;
    case "angular3p":
      if (!need(10, 13, 14, 15)) return null;
      base.defPoints = [pt(15), pt(13), pt(14), pt(10)];
      break;
    case "diametric": {
      if (!need(10, 15)) return null;
      const a = pt(10);
      const b = pt(15);
      base.defPoints = [{ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, b];
      break;
    }
    case "radial":
      if (!need(10, 15)) return null;
      base.defPoints = [pt(10), pt(15)];
      break;
    case "ordinate":
      if (!need(10, 13, 14)) return null;
      base.defPoints = [pt(10), pt(13), pt(14)];
      base.axis = type & 64 ? "x" : "y";
      break;
  }
  const text = get(1);
  if (text !== undefined && text !== "") base.textOverride = text;
  const style = get(3);
  if (style) base.style = style;
  if (type & 128 && need(11)) base.textPos = pt(11);
  const m = get(42);
  const measure = m === undefined || !Number.isFinite(Number(m)) ? null : Number(m);
  return { entity: base, blockName: get(2) ?? "", measure };
}
