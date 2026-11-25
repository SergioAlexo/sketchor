/**
 * Number formatting shared by the 3D and 2D readouts — its own tiny module,
 * so the drawing chunk doesn't pull in the 3D measuring code to get it.
 */

/** A readout number: fewer decimals as it grows, and never "-0". */
export function num(v: number): string {
  const a = Math.abs(v);
  const places = a >= 1000 ? 0 : a >= 100 ? 1 : a >= 1 ? 2 : 3;
  const s = v.toFixed(places);
  return s === "-0" || /^-0\.0+$/.test(s) ? s.slice(1) : s;
}

/** A length in millimetres, the unit every embed model and drawing is in. */
export const mm = (v: number): string => `${num(v)} mm`;
