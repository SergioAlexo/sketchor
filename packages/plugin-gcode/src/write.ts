import { curveEnd, curveStart } from "@sketchor/core";
import type { CutFeature } from "./toolpath";

/**
 * G-code emission (N-42/43) — turns a `CutPlan` into text a controller can
 * run. Only a "generic" post exists so far (plain G0/G1/G2/G3, G20/G21,
 * M3/M5): the plan's own LinuxCNC/Mach3/4 profiles are a follow-up once a
 * real machine is validating output against this one. No Z axis is ever
 * emitted — 2D sheet cutting controls the beam with M3/M5, not a plunge,
 * and staying Z-less is what makes one post work across laser/plasma/
 * waterjet controllers that disagree about everything else.
 */

export interface PostProfile {
  name: string;
  laserOnCode: string;
  laserOffCode: string;
  /** The dwell command for a pierce of `sec` seconds. */
  pierceDwell(sec: number): string;
  comment(text: string): string;
}

export const GENERIC_LASER_PROFILE: PostProfile = {
  name: "Generic laser",
  laserOnCode: "M3",
  laserOffCode: "M5",
  pierceDwell: (sec) => `G4 P${round(sec, 3)}`,
  comment: (text) => `(${text})`,
};

export interface GcodeWriteOptions {
  unit: "mm" | "in";
  /** Multiplies a millimetre value to get the output unit — e.g. `1` for mm, `1/25.4` for inches. */
  scale: number;
  feedRateMmPerMin: number;
  pierceTimeSec: number;
  sheetLabel?: string;
  /** Header comment title. Default "Sheet Metal Nest" (the older nest panel); Sheet Nesting passes its own name. */
  title?: string;
  profile?: PostProfile;
  /** Decimal places for coordinates. Default 4. */
  decimals?: number;
}

function round(n: number, places: number): number {
  const f = 10 ** places;
  const r = Math.round(n * f) / f;
  return Object.is(r, -0) ? 0 : r;
}

export function writeGcode(features: CutFeature[], opts: GcodeWriteOptions): string {
  const profile = opts.profile ?? GENERIC_LASER_PROFILE;
  const decimals = opts.decimals ?? 4;
  const scale = opts.scale;
  const feed = round(opts.feedRateMmPerMin * scale, decimals);

  const fmt = (n: number) => round(n * scale, decimals).toFixed(decimals);
  const lines: string[] = [];

  lines.push(profile.comment(`${opts.title ?? "Sheet Metal Nest"}${opts.sheetLabel ? ` — ${opts.sheetLabel}` : ""}`));
  lines.push(profile.comment(`Post: ${profile.name}`));
  lines.push("G90");
  lines.push(opts.unit === "in" ? "G20" : "G21");
  lines.push(profile.laserOffCode);

  for (const feature of features) {
    lines.push(profile.comment(`Part ${feature.partNumber} — ${feature.role}`));
    lines.push(`G0 X${fmt(feature.pierce.x)} Y${fmt(feature.pierce.y)}`);
    lines.push(profile.laserOnCode);
    lines.push(profile.pierceDwell(opts.pierceTimeSec));
    lines.push(`G1 X${fmt(feature.leadIn.x)} Y${fmt(feature.leadIn.y)} F${feed}`);
    for (const curve of feature.loop) {
      if (curve.kind === "segment") {
        const end = curveEnd(curve);
        lines.push(`G1 X${fmt(end.x)} Y${fmt(end.y)}`);
        continue;
      }
      const start = curveStart(curve);
      const end = curveEnd(curve);
      lines.push(`${curve.ccw ? "G3" : "G2"} X${fmt(end.x)} Y${fmt(end.y)} I${fmt(curve.center.x - start.x)} J${fmt(curve.center.y - start.y)}`);
    }
    lines.push(profile.laserOffCode);
  }

  lines.push("G0 X0 Y0");
  lines.push("M30");
  return lines.join("\n") + "\n";
}
