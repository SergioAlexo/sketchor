/** K-03: Sketch (Onshape feel) vs Drafting (AutoCAD feel). Only defaults, no separate code paths. */
export type DrawingMode = "drafting" | "sketch";

export interface ModeDefaults {
  /** AUTOCON (T-43) default. */
  autoConstrain: boolean;
  /** New dimensions are driving (true) or annotation-only (false) by default. */
  drivingDims: boolean;
}

export function modeDefaults(mode: DrawingMode): ModeDefaults {
  return mode === "sketch" ? { autoConstrain: true, drivingDims: true } : { autoConstrain: false, drivingDims: false };
}
