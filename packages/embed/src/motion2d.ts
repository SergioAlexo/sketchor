/**
 * E-05, 2D: the motion a drawing makes once play is pressed. Pure, so the
 * numbers are tested without a canvas.
 *
 *  - "float": a gentle Lissajous drift of the view — at full intensity
 *    ±1.5 % translation, ±0.8° rotation and ±1 % zoom, at 0.047–0.071 Hz.
 *    The frequencies have no common period short enough to notice, so the
 *    drift never visibly loops.
 *  - pointer tilt: the canvas leans toward the cursor by up to ±6° (CSS
 *    perspective rotate), through the same springs as the 3D bias.
 *  - "draw": the drawing appears in its own draw order over ~2.5 s, eased,
 *    before handing over to the float.
 */

export interface FloatPose {
  /** Translation as a fraction of the canvas width / height. */
  dx: number;
  dy: number;
  /** Rotation in radians (screen, clockwise positive). */
  rot: number;
  /** Zoom factor (1 = the fitted view). */
  zoom: number;
}

export const FLOAT_TRANSLATE = 0.015;
export const FLOAT_ROTATE = (0.8 * Math.PI) / 180;
export const FLOAT_ZOOM = 0.01;
/** Largest lean toward the pointer, in degrees. */
export const TILT_DEG = 6;
/** How long "draw" takes to put the whole drawing on screen. */
export const DRAW_SECONDS = 2.5;

const TAU = Math.PI * 2;

/** The drift at time `t` (seconds), scaled by `intensity` (0 = the fitted view exactly). */
export function floatPose(t: number, intensity: number): FloatPose {
  const k = Math.max(0, Math.min(1, intensity));
  if (k === 0) return { dx: 0, dy: 0, rot: 0, zoom: 1 };
  return {
    dx: FLOAT_TRANSLATE * k * Math.sin(TAU * 0.061 * t),
    dy: FLOAT_TRANSLATE * k * Math.sin(TAU * 0.047 * t + 1.3),
    rot: FLOAT_ROTATE * k * Math.sin(TAU * 0.053 * t + 2.1),
    zoom: 1 + FLOAT_ZOOM * k * Math.sin(TAU * 0.071 * t + 0.4),
  };
}

/** Smoothstep-style ease in and out (0 → 1, flat at both ends). */
export function easeInOut(x: number): number {
  const c = Math.max(0, Math.min(1, x));
  return c * c * (3 - 2 * c);
}

/**
 * "draw" after `elapsed` seconds: how many of `count` entities are fully on
 * screen, and how far the next one has faded in (0…1). Done once `shown`
 * reaches `count`.
 */
export function drawReveal(elapsed: number, count: number, seconds = DRAW_SECONDS): { shown: number; partial: number; done: boolean } {
  if (count <= 0) return { shown: 0, partial: 0, done: true };
  const p = easeInOut(elapsed / seconds) * count;
  const shown = Math.min(count, Math.floor(p));
  return { shown, partial: shown < count ? p - shown : 0, done: shown >= count };
}

/** The CSS transform that leans the canvas toward a pointer bias (-1…1 each way). */
export function tiltTransform(x: number, y: number): string {
  const rx = (-y * TILT_DEG).toFixed(3);
  const ry = (x * TILT_DEG).toFixed(3);
  return `perspective(900px) rotateX(${rx}deg) rotateY(${ry}deg)`;
}
