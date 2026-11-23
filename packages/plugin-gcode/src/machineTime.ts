import { curveEnd, curveLength, curveStart, pointAt, type Curve, type Point } from "@sketchor/core";
import type { CutFeature } from "./toolpath";

/**
 * NT-02: cutting time from a machine file - the same walk `toolpathPreview`
 * and `writeGcode` make (home -> each pierce -> lead-in -> loop or tab runs
 * -> home), but with the things that make a real machine slower than
 * "length / feed":
 *
 * - acceleration: every stroke starts and ends at rest, so it costs
 *   `v / a` extra (or `2 * sqrt(L / a)` when it is too short to reach `v`);
 * - corners sharper than `cornerAngleDeg` stop the head (a new stroke);
 *   gentler ones and tangent arcs carry the speed through;
 * - an arc can't be cut faster than its centripetal limit `sqrt(a * r)`,
 *   which is what makes small holes slow;
 * - contours smaller than `smallHoleMm` are cut at `smallHoleFeedPct` of
 *   the feed (what lasers do on purpose for round small holes);
 * - every pierce costs the pierce dwell plus the head lift / lower time;
 * - rapids accelerate too (`rapidAccel`).
 *
 * Per-sheet load/unload time is the caller's to add: it is a sheet fact,
 * not a toolpath one.
 */
export interface MachineMotion {
  feedMmPerMin: number;
  rapidMmPerMin: number;
  pierceSec: number;
  /** Cutting acceleration, mm/s². 0 = ignore acceleration. */
  cutAccel: number;
  /** Rapid acceleration, mm/s². 0 = ignore. */
  rapidAccel: number;
  /** Head up + down time per pierce, s (approach, height sensing, retract). */
  headLiftSec: number;
  /** Direction changes above this stop the head. Default 20°. */
  cornerAngleDeg?: number;
  /** Contours whose larger side is under this (mm) cut at `smallHoleFeedPct`. 0 = off. */
  smallHoleMm?: number;
  smallHoleFeedPct?: number;
  home?: Point;
}

export interface MachineTimeBreakdown {
  totalSec: number;
  cutSec: number;
  rapidSec: number;
  pierceSec: number;
  liftSec: number;
  cutLength: number;
  rapidLength: number;
  pierces: number;
}

const EPS = 1e-9;
const dist = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y);

/** Seconds to move `len` mm starting and ending at rest, top speed `v` mm/s, acceleration `a` mm/s². */
export function strokeTime(len: number, v: number, a: number): number {
  if (!(len > EPS) || !(v > 0)) return 0;
  if (!(a > 0)) return len / v;
  if (len >= (v * v) / a) return len / v + v / a;
  return 2 * Math.sqrt(len / a);
}

function tangent(c: Curve, t: number): Point {
  const d = 1e-4;
  const p = pointAt(c, Math.max(0, t - d)), q = pointAt(c, Math.min(1, t + d));
  const l = dist(p, q) || 1;
  return { x: (q.x - p.x) / l, y: (q.y - p.y) / l };
}

function contourSize(loop: Curve[]): number {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const c of loop) {
    for (let i = 0; i <= 4; i++) {
      const p = pointAt(c, i / 4);
      minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x);
      minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y);
    }
  }
  return Number.isFinite(minX) ? Math.max(maxX - minX, maxY - minY) : 0;
}

export function machineTimeSec(features: CutFeature[], m: MachineMotion): MachineTimeBreakdown {
  const out: MachineTimeBreakdown = { totalSec: 0, cutSec: 0, rapidSec: 0, pierceSec: 0, liftSec: 0, cutLength: 0, rapidLength: 0, pierces: 0 };
  const feed = Math.max(0, m.feedMmPerMin) / 60;
  const rapid = Math.max(0, m.rapidMmPerMin) / 60;
  const cosCorner = Math.cos(((m.cornerAngleDeg ?? 20) * Math.PI) / 180);
  let cursor = m.home ?? { x: 0, y: 0 };

  const rapidTo = (to: Point) => {
    const len = dist(cursor, to);
    if (len > EPS) {
      out.rapidLength += len;
      out.rapidSec += strokeTime(len, rapid, m.rapidAccel);
    }
    cursor = to;
  };
  const pierce = () => {
    out.pierces += 1;
    out.pierceSec += Math.max(0, m.pierceSec);
    out.liftSec += Math.max(0, m.headLiftSec);
  };
  /** Cuts a chain of curves at `v` mm/s, stopping at sharp corners. */
  const cutChain = (curves: Curve[], v: number) => {
    let strokeLen = 0, strokeFlat = 0, strokeTop = 0;
    const flush = () => {
      if (strokeLen > EPS) {
        // Cruise time at each curve's own limit, plus one accel/decel ramp at the stroke's top speed (or the short-stroke time if that is longer).
        const ramp = m.cutAccel > 0 ? strokeTop / m.cutAccel : 0;
        out.cutSec += Math.max(strokeFlat + ramp, m.cutAccel > 0 ? 2 * Math.sqrt(strokeLen / m.cutAccel) : 0);
      }
      strokeLen = 0; strokeFlat = 0; strokeTop = 0;
    };
    curves.forEach((c, i) => {
      const len = curveLength(c);
      if (!(len > EPS)) return;
      if (i > 0) {
        const a = tangent(curves[i - 1]!, 1), b = tangent(c, 0);
        if (a.x * b.x + a.y * b.y < cosCorner) flush();
      }
      let vc = v;
      if (c.kind === "arc" && m.cutAccel > 0) vc = Math.min(vc, Math.sqrt(m.cutAccel * c.radius));
      if (!(vc > 0)) return;
      strokeLen += len;
      strokeFlat += len / vc;
      strokeTop = Math.max(strokeTop, vc);
      out.cutLength += len;
    });
    flush();
  };

  for (const f of features) {
    rapidTo(f.pierce);
    pierce();
    const size = contourSize(f.loop);
    const slow = m.smallHoleMm && m.smallHoleMm > 0 && size > 0 && size < m.smallHoleMm ? Math.max(1, Math.min(100, m.smallHoleFeedPct ?? 100)) / 100 : 1;
    const v = feed * slow;
    const leadIn = dist(f.pierce, f.leadIn);
    const runs: Curve[][] = f.runs ?? [f.loop];
    // The lead-in runs straight into the loop when it is tangent (arc lead-in); a straight one meets it at a corner, which cutChain detects.
    const leadCurve: Curve[] = leadIn > EPS ? [{ kind: "segment", a: f.pierce, b: f.leadIn }] : [];
    runs.forEach((run, j) => {
      if (run.length === 0) return;
      if (j > 0) {
        rapidTo(curveStart(run[0]!));
        pierce();
        cutChain(run, v);
      } else {
        cutChain(f.leadInArc ? run : [...leadCurve, ...run], v);
        if (f.leadInArc && leadIn > EPS) {
          // A tangent arc lead-in: about a quarter circle of radius ~ the lead-in chord / sqrt(2).
          const r = leadIn / Math.SQRT2;
          const len = (Math.PI / 2) * r;
          out.cutLength += len;
          const va = m.cutAccel > 0 ? Math.min(v, Math.sqrt(m.cutAccel * r)) : v;
          out.cutSec += va > 0 ? len / va : 0;
        }
      }
      cursor = curveEnd(run[run.length - 1]!);
    });
  }
  if (features.length > 0) rapidTo(m.home ?? { x: 0, y: 0 });
  out.totalSec = out.cutSec + out.rapidSec + out.pierceSec + out.liftSec;
  return out;
}
