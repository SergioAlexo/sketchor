/**
 * E-05: every animated quantity in the embed (turntable intensity, pointer
 * bias) is a critically damped spring, so changing a target always eases in
 * and out — pressing play ramps the motion up, pausing lets the part glide to
 * rest, and nothing ever jumps.
 *
 *   x'' = -k (x - target) - 2√k · x'
 */
export interface Spring {
  x: number;
  v: number;
  target: number;
  /** Stiffness; settle time ≈ 4.7 / √k seconds. */
  k: number;
}

/** Longest step integrated at once: a backgrounded tab returns with a huge dt. */
export const MAX_DT = 1 / 20;

export function spring(x: number, k = 64): Spring {
  return { x, v: 0, target: x, k };
}

/** Advances `s` by `dt` seconds (semi-implicit Euler, sub-stepped so a long frame stays stable). */
export function stepSpring(s: Spring, dt: number): void {
  let left = Math.min(Math.max(dt, 0), MAX_DT * 4);
  const damping = 2 * Math.sqrt(s.k);
  while (left > 0) {
    const h = Math.min(left, 1 / 120);
    const a = -s.k * (s.x - s.target) - damping * s.v;
    s.v += a * h;
    s.x += s.v * h;
    left -= h;
  }
}

export function atRest(s: Spring, eps = 1e-4): boolean {
  return Math.abs(s.x - s.target) < eps && Math.abs(s.v) < eps;
}

/** Turntable yaw speed at full intensity (≈ 12°/s). */
export const TURNTABLE_RAD_PER_S = (12 * Math.PI) / 180;
