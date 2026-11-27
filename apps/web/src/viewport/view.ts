// E-01: moved to @sketchor/core (render2d) so the embed and the app share one 2D renderer.
export { worldToScreen, screenToWorld, zoomAt, fitToBounds, gridStep, type View } from "@sketchor/core";

/** A typical 100px wheel notch zooms 10%. Smaller smooth deltas use a fraction of that step. */
export function wheelZoomFactor(deltaY: number, deltaMode: number, pageHeight: number): number {
  const pixels = deltaY * (deltaMode === 1 ? 16 : deltaMode === 2 ? pageHeight : 1);
  if (!Number.isFinite(pixels)) return 1;
  const limited = Math.max(-400, Math.min(400, pixels));
  return 1.1 ** (-limited / 100);
}
