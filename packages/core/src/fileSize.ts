/**
 * F-10 — size advice for large files. A pure table so every open path (Open
 * dialog, file browser, file association) words the warning the same way.
 * Thresholds are where parsing starts to take noticeable seconds in the
 * browser main thread, not hard limits — nothing is ever refused here.
 */

export type SizeClass = "ok" | "large" | "huge";

/** Bytes at which a file is "large" (warn) / "huge" (warn harder), by lowercase extension. */
const LIMITS: Record<string, [large: number, huge: number]> = {
  dxf: [25e6, 100e6],
  dwg: [25e6, 100e6],
  svg: [10e6, 50e6],
  eps: [30e6, 150e6],
  ai: [30e6, 150e6],
  stl: [50e6, 200e6],
  obj: [50e6, 200e6],
  ply: [50e6, 200e6],
  "3mf": [50e6, 200e6],
  gltf: [50e6, 200e6],
  glb: [50e6, 200e6],
  step: [60e6, 250e6],
  stp: [60e6, 250e6],
  iges: [60e6, 250e6],
  igs: [60e6, 250e6],
};

const DEFAULT_LIMITS: [number, number] = [50e6, 200e6];

const extOf = (name: string): string => name.split(/[\\/]/).pop()!.split(".").slice(1).pop()?.toLowerCase() ?? "";

export function classifySize(name: string, bytes: number): SizeClass {
  const [large, huge] = LIMITS[extOf(name)] ?? DEFAULT_LIMITS;
  return bytes >= huge ? "huge" : bytes >= large ? "large" : "ok";
}

export const formatBytes = (n: number): string =>
  n >= 1e9 ? `${(n / 1e9).toFixed(1)} GB` : n >= 1e6 ? `${(n / 1e6).toFixed(1)} MB` : n >= 1e3 ? `${Math.round(n / 1e3)} kB` : `${n} B`;

/** A one-line warning for a big file, or null when it needs none. */
export function sizeWarning(name: string, bytes: number): string | null {
  const c = classifySize(name, bytes);
  if (c === "ok") return null;
  const size = formatBytes(bytes);
  return c === "huge"
    ? `${size} is a very large file — opening may take a long time or run out of memory. Consider simplifying or splitting it first.`
    : `${size} is a large file — opening may take a while.`;
}
