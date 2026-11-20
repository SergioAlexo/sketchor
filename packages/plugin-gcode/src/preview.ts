import { curveEnd, curveLength, curveStart, entityFromPath, newEntityId, pointAt, type Curve, type Entity, type Point } from "@sketchor/core";
import type { CutFeature } from "./toolpath";

/**
 * N-43: the cut plan drawn as geometry, so the order a machine will cut a
 * sheet in can be checked before the program runs — holes before their
 * outer profile, inner parts before the hole around them, where every
 * pierce lands and how far the head travels with the beam off.
 *
 * It walks the features exactly the way `writeGcode` emits them: start at
 * `home`, rapid to each pierce, lead-in, cut the loop (or, with N-53 tabs,
 * each run with a beam-off rapid across every tab), and rapid back home at
 * the end. So what is drawn is what the program does, not a re-derivation.
 */

export const TOOLPATH_CUT_LAYER = "Toolpath Cut";
export const TOOLPATH_RAPID_LAYER = "Toolpath Rapid";
export const TOOLPATH_ORDER_LAYER = "Toolpath Order";

/** Mid-tone, so the same colours read on the dark and the light canvas. */
export const TOOLPATH_COLORS = { hole: "#58a6ff", outer: "#3fb950", rapid: "#f85149" } as const;

export interface ToolpathPreviewOptions {
  /** Where the program starts and ends. `writeGcode` homes to X0 Y0, so that is the default. */
  home?: Point;
  /** Height of the cut-order numbers, mm. Default 4. */
  labelHeight?: number;
  /** `linetypeScale` on the dashed rapids, so the dash still reads with a whole sheet in view. Default 1. */
  rapidLinetypeScale?: number;
}

export interface ToolpathPreviewStats {
  /** Closed contours cut — one per feature. */
  contours: number;
  /** Beam-on events: one per contour, plus one for every run restarted after a tab. */
  pierces: number;
  /** Length cut with the beam on, lead-ins included, mm. */
  cutLength: number;
  /** Length travelled with the beam off, the return home included, mm. */
  rapidLength: number;
}

export interface ToolpathPreview {
  /** Rapids, lead-ins + cuts and order labels, in program order, on the three toolpath layers. */
  entities: Entity[];
  stats: ToolpathPreviewStats;
}

const EPS = 1e-9;

/**
 * Label height and rapid dash scale sized to the sheet, so the preview reads
 * the same with the whole sheet in view whatever its size: DASHED is a 9 mm
 * period, which the canvas draws solid below ~6 px — a 48x96 in sheet fitted
 * to a window is ~0.45 px/mm, so at scale 1 every rapid would look like a cut.
 * Here the period is 1/60 of the sheet's long side (≈18 px at fit), never
 * below DASHED's own size.
 */
export function toolpathPreviewScale(sheetWidth: number, sheetHeight: number): { labelHeight: number; rapidLinetypeScale: number } {
  const long = Math.max(sheetWidth, sheetHeight, 1);
  return { labelHeight: Math.min(30, Math.max(3, long / 120)), rapidLinetypeScale: Math.max(1, long / (60 * 9)) };
}

function dist(a: Point, b: Point): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

/** The long side of a loop's bounding box, from each curve's ends and middle — enough to size a label, not an exact extent. */
function contourSize(loop: Curve[]): number {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const c of loop) {
    for (const p of [pointAt(c, 0), pointAt(c, 0.5), pointAt(c, 1)]) {
      minX = Math.min(minX, p.x);
      minY = Math.min(minY, p.y);
      maxX = Math.max(maxX, p.x);
      maxY = Math.max(maxY, p.y);
    }
  }
  return loop.length > 0 ? Math.max(maxX - minX, maxY - minY) : 0;
}

export function toolpathPreview(features: CutFeature[], opts: ToolpathPreviewOptions = {}): ToolpathPreview {
  const home = opts.home ?? { x: 0, y: 0 };
  const h = opts.labelHeight ?? 4;
  const rapidScale = opts.rapidLinetypeScale ?? 1;
  const entities: Entity[] = [];
  const stats: ToolpathPreviewStats = { contours: features.length, pierces: 0, cutLength: 0, rapidLength: 0 };
  let cursor = home;

  const rapid = (to: Point): void => {
    const len = dist(cursor, to);
    if (len > EPS) {
      entities.push({
        id: newEntityId(),
        type: "line",
        layer: TOOLPATH_RAPID_LAYER,
        color: TOOLPATH_COLORS.rapid,
        linetype: "DASHED",
        ...(rapidScale !== 1 ? { linetypeScale: rapidScale } : {}),
        a: cursor,
        b: to,
      });
      stats.rapidLength += len;
    }
    cursor = to;
  };

  features.forEach((f, i) => {
    const color = f.role === "hole" ? TOOLPATH_COLORS.hole : TOOLPATH_COLORS.outer;
    rapid(f.pierce);
    stats.pierces += 1;
    // A label never outgrows its own contour, or neighbouring small parts' numbers pile on top of each other at every zoom.
    const lh = Math.min(h, Math.max(h * 0.05, contourSize(f.loop) * 0.4));
    entities.push({ id: newEntityId(), type: "circle", layer: TOOLPATH_ORDER_LAYER, color, center: f.pierce, radius: lh * 0.2 });
    entities.push({ id: newEntityId(), type: "text", layer: TOOLPATH_ORDER_LAYER, at: { x: f.pierce.x + lh * 0.35, y: f.pierce.y + lh * 0.35 }, text: String(i + 1), height: lh, rotation: 0 });

    const leadIn = dist(f.pierce, f.leadIn);
    if (leadIn > EPS) {
      entities.push({ id: newEntityId(), type: "line", layer: TOOLPATH_CUT_LAYER, color, a: f.pierce, b: f.leadIn });
      stats.cutLength += leadIn;
    }
    cursor = f.leadIn;

    const runs: Curve[][] = f.runs ?? [f.loop];
    runs.forEach((run, j) => {
      if (run.length === 0) return;
      if (j > 0) {
        rapid(curveStart(run[0]));
        stats.pierces += 1;
      }
      const style: Entity = { id: "", type: "point", layer: TOOLPATH_CUT_LAYER, color, p: cursor };
      const piece = entityFromPath({ curves: run, closed: !f.runs }, style, newEntityId());
      if (piece) entities.push(piece);
      stats.cutLength += run.reduce((s, c) => s + curveLength(c), 0);
      cursor = curveEnd(run[run.length - 1]);
    });
  });

  if (features.length > 0) rapid(home);
  return { entities, stats };
}

/**
 * Estimated machine time for a cut plan, seconds: beam-on length at the feed
 * rate, a dwell per pierce, and beam-off travel at the rapid rate. Taken from
 * the same walk `toolpathPreview` makes (lead-ins, tab restarts and the trip
 * home included), so it counts exactly what the G-code will do. It leaves out
 * acceleration in corners, which makes small detailed parts take longer than
 * this - it is an estimate, labelled as one wherever it is shown.
 */
export function cutTimeSec(
  stats: Pick<ToolpathPreviewStats, "cutLength" | "pierces" | "rapidLength">,
  speeds: { feedRateMmPerMin: number; pierceTimeSec: number; rapidMmPerMin: number },
): number {
  const cut = speeds.feedRateMmPerMin > 0 ? (stats.cutLength / speeds.feedRateMmPerMin) * 60 : 0;
  const rapid = speeds.rapidMmPerMin > 0 ? (stats.rapidLength / speeds.rapidMmPerMin) * 60 : 0;
  return cut + rapid + stats.pierces * Math.max(0, speeds.pierceTimeSec);
}
