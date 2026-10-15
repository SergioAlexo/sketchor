import type { DimensionEntity } from "../entities";
import type { DimStyle } from "./style";

/** Number to text under a style's decimals / zero suppression / separator. */
export function formatNumber(v: number, decimals: number, zero: DimStyle["zeroSuppress"], sep: string): string {
  let s = Math.abs(v) < 0.5 * Math.pow(10, -decimals) ? (0).toFixed(decimals) : v.toFixed(decimals);
  if (zero === "trailing" || zero === "both") {
    if (s.includes(".")) s = s.replace(/0+$/, "").replace(/\.$/, "");
  }
  if (zero === "leading" || zero === "both") s = s.replace(/^(-?)0(?=\.)/, "$1");
  return s.replace(".", sep);
}

/** DIMRND: round `v` to the nearest multiple of `step` (0 = no rounding). */
export function roundToStep(v: number, step: number): number {
  return step > 0 ? Math.round(v / step) * step : v;
}

const gcd = (a: number, b: number): number => (b === 0 ? a : gcd(b, a % b));

/** Whole inches plus a reduced fraction at 1/2^exp, as [whole, numerator, denominator]. */
function inchParts(inches: number, exp: number): [number, number, number] {
  const den = Math.pow(2, Math.max(0, Math.min(8, exp)));
  const units = Math.round(inches * den);
  const whole = Math.floor(units / den);
  let num = units - whole * den;
  let d = den;
  if (num > 0) {
    const g = gcd(num, d);
    num /= g;
    d /= g;
  } else d = 1;
  return [whole, num, d];
}

/** A length under the style's unit format (decimal, scientific, engineering, architectural, fractional). `v` is in drawing units, before `lengthFactor`. */
export function formatLength(v: number, st: DimStyle): string {
  let x = roundToStep(v * st.lengthFactor, st.round);
  const neg = x < 0;
  x = Math.abs(x);
  const sign = neg && x > 1e-12 ? "-" : "";
  const zs = st.zeroSuppress;
  switch (st.unitFormat) {
    case "scientific":
      return sign + x.toExponential(st.decimals).replace("e+", "E+").replace("e-", "E-").replace(".", st.decimalSep);
    case "engineering": {
      const feet = Math.floor(x / 12 + 1e-12);
      const inches = x - feet * 12;
      const body = formatNumber(inches, st.decimals, zs === "trailing" || zs === "both" ? "trailing" : "none", st.decimalSep);
      return sign + (feet > 0 || zs === "none" || zs === "trailing" ? `${feet}'-` : "") + `${body}"`;
    }
    case "architectural":
    case "fractional": {
      const [whole, num, den] = inchParts(x, st.decimals);
      const frac = num > 0 ? `${num}/${den}` : "";
      if (st.unitFormat === "fractional") return sign + [whole > 0 || !frac ? String(whole) : "", frac].filter(Boolean).join(" ");
      const feet = Math.floor(whole / 12);
      const inch = whole % 12;
      const inchText = [inch > 0 || !frac ? String(inch) : "", frac].filter(Boolean).join(" ");
      return sign + (feet > 0 || zs === "none" ? `${feet}'-` : "") + `${inchText}"`;
    }
    default:
      return sign + formatNumber(x, st.decimals, zs, st.decimalSep);
  }
}

/** Angle in radians under DIMAUNIT / DIMADEC. */
export function formatAngle(rad: number, st: DimStyle): string {
  const deg = (rad * 180) / Math.PI;
  switch (st.angleFormat) {
    case "dms": {
      let d = Math.floor(Math.abs(deg) + 1e-9);
      let m = Math.floor((Math.abs(deg) - d) * 60 + 1e-9);
      let s = ((Math.abs(deg) - d) * 60 - m) * 60;
      const sd = Math.min(st.angleDecimals, 4);
      if (Number(s.toFixed(sd)) >= 60) {
        s = 0;
        m += 1;
      }
      if (m >= 60) {
        m -= 60;
        d += 1;
      }
      const sec = s > 1e-9 || sd > 0 ? formatNumber(s, sd, "trailing", st.decimalSep) : "0";
      return `${deg < 0 ? "-" : ""}${d}°${m ? `${m}'` : sec !== "0" ? "0'" : ""}${sec !== "0" ? `${sec}"` : ""}`;
    }
    case "gradians":
      return formatNumber((deg * 10) / 9, st.angleDecimals, st.zeroSuppress, st.decimalSep) + "g";
    case "radians":
      return formatNumber(rad, st.angleDecimals, st.zeroSuppress, st.decimalSep) + "r";
    default:
      return formatNumber(deg, st.angleDecimals, st.zeroSuppress, st.decimalSep) + "°";
  }
}

function toleranceText(st: DimStyle, primary: string): string {
  const t = (n: number): string => formatNumber(n, st.tolDecimals, st.zeroSuppress === "none" ? "none" : "trailing", st.decimalSep);
  switch (st.tolMode) {
    case "symmetric":
      return `${primary} ±${t(Math.abs(st.tolPlus))}`;
    case "deviation":
      return `${primary} +${t(Math.abs(st.tolPlus))}/-${t(Math.abs(st.tolMinus))}`;
    default:
      return primary;
  }
}

/** The auto text of a measured value (before any override): "R", diameter and arc symbols, degrees, prefix/suffix, alternate units, tolerance. */
export function measuredText(e: Pick<DimensionEntity, "kind">, st: DimStyle, measure: number): string {
  if (!Number.isFinite(measure)) return "";
  switch (e.kind) {
    case "angular2l":
    case "angular3p":
      return formatAngle(measure, st);
    default: {
      const body = formatLength(measure, st);
      const lead = e.kind === "radial" || e.kind === "jogged" ? "R" : e.kind === "diametric" ? "⌀" : e.kind === "arclength" ? (st.arcSymbol === "none" ? "" : "⌒") : "";
      let out: string;
      if (st.tolMode === "limits") {
        const lim = (d: number): string => st.prefix + lead + formatLength(measure + d / st.lengthFactor, st) + st.suffix;
        out = `${lim(Math.abs(st.tolPlus))} / ${lim(-Math.abs(st.tolMinus))}`;
      } else out = toleranceText(st, st.prefix + lead + body + st.suffix);
      if (st.alt) {
        const alt = roundToStep(measure * st.altFactor, st.altRound);
        out += ` [${st.altPrefix}${formatNumber(alt, st.altDecimals, st.zeroSuppress, st.decimalSep)}${st.altSuffix}]`;
      }
      return out;
    }
  }
}

/** Final dimension text: the override (with `<>` standing for the measurement) or the measurement; reference dimensions in parentheses. */
export function formatDimText(e: DimensionEntity, st: DimStyle, measure: number): string {
  const auto = measuredText(e, st, measure);
  let out = auto;
  if (e.textOverride !== undefined && e.textOverride !== "") out = e.textOverride.includes("<>") ? e.textOverride.split("<>").join(auto) : e.textOverride;
  return e.driving === false && st.referenceParens ? `(${out})` : out;
}
