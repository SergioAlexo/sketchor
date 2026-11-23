/**
 * NT-02: machine files. One file describes one real machine in the shop (a
 * fiber laser, a waterjet...): its bed, motion (rapid speed, accelerations,
 * head lift, corner slowdown, small-hole feed), sheet load time, and a cut
 * table - per material and thickness, the feed rate, pierce time and kerf
 * the operator actually runs. Sheet Nesting uses the selected file for the
 * cutting time (with `machineTimeSec`), the kerf, the bed check and the
 * G-code feed.
 *
 * Every length in a file is in the file's own `units` ("mm" or "in"; feeds
 * per minute in the same unit), as the operator types them off the machine.
 * `profileMotion` converts to mm. `parseMachineProfile` takes anything (a
 * hand-edited or foreign file) and never throws.
 */
import type { MachineId, MaterialId } from "./catalog";

export type ProfileUnits = "mm" | "in";

export interface ProfileCutRow {
  material: MaterialId;
  /** In profile units. */
  thickness: number;
  /** Per minute, profile units. */
  feed: number;
  /** Seconds. */
  pierce: number;
  /** Profile units; 0 / absent = the job's kerf. */
  kerf?: number;
  /** Free text: gas, nozzle, power... shown in the report. */
  note?: string;
}

export interface MachineProfile {
  id: string;
  name: string;
  /** "tube" = a tube laser (used by the Tubes calculator). */
  type: MachineId | "tube";
  units: ProfileUnits;
  /** Bed size, profile units; 0 = unknown. */
  bedW: number;
  bedH: number;
  /** Per minute, profile units. */
  rapid: number;
  /** Profile units per s². 0 = ignore acceleration. */
  cutAccel: number;
  rapidAccel: number;
  /** Head up + down per pierce, s. */
  headLift: number;
  /** Degrees; sharper direction changes stop the head. */
  cornerAngle: number;
  /** Profile units; contours smaller than this cut at `smallHoleFeedPct`. 0 = off. */
  smallHole: number;
  smallHoleFeedPct: number;
  /** Load + unload per sheet, minutes. */
  sheetLoadMin: number;
  rows: ProfileCutRow[];
}

const MATERIAL_IDS: MaterialId[] = ["al5052", "al6061", "ss", "cs", "plastic", "plywood", "stone", "quartz"];
const TYPES: (MachineId | "tube")[] = ["laser", "waterjet", "router", "other", "tube"];
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const n = (v: unknown, fb: number, lo = 0, hi = 1e7): number => {
  const x = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN;
  return Number.isFinite(x) && x >= lo && x <= hi ? x : fb;
};
const s = (v: unknown, fb: string, max = 80): string => (typeof v === "string" && v.trim() !== "" ? v.trim().slice(0, max) : fb);

export const MAX_PROFILE_ROWS = 400;

/** A sensible starting machine: a mid-power fiber laser in inches, rows from the built-in estimate table. Meant to be edited. */
export function newMachineProfile(id: string, name = "My laser"): MachineProfile {
  return {
    id,
    name,
    type: "laser",
    units: "in",
    bedW: 60,
    bedH: 120,
    rapid: 3000,
    cutAccel: 40,
    rapidAccel: 80,
    headLift: 0.6,
    cornerAngle: 20,
    smallHole: 0.375,
    smallHoleFeedPct: 50,
    sheetLoadMin: 5,
    rows: [
      { material: "cs", thickness: 0.06, feed: 300, pierce: 0.3, kerf: 0.008 },
      { material: "cs", thickness: 0.125, feed: 140, pierce: 0.6, kerf: 0.01 },
      { material: "cs", thickness: 0.25, feed: 70, pierce: 1.2, kerf: 0.012 },
      { material: "ss", thickness: 0.06, feed: 350, pierce: 0.3, kerf: 0.008 },
      { material: "ss", thickness: 0.125, feed: 110, pierce: 0.8, kerf: 0.01 },
      { material: "al5052", thickness: 0.063, feed: 400, pierce: 0.2, kerf: 0.008 },
      { material: "al5052", thickness: 0.125, feed: 180, pierce: 0.4, kerf: 0.01 },
    ],
  };
}

export function parseMachineProfile(v: unknown, fallbackId = "machine"): MachineProfile | null {
  if (!isObj(v)) return null;
  const d = newMachineProfile(fallbackId);
  const units: ProfileUnits = v.units === "mm" ? "mm" : v.units === "in" ? "in" : d.units;
  const rows: ProfileCutRow[] = [];
  for (const r of Array.isArray(v.rows) ? v.rows.slice(0, MAX_PROFILE_ROWS) : []) {
    if (!isObj(r) || !MATERIAL_IDS.includes(r.material as MaterialId)) continue;
    const thickness = n(r.thickness, NaN, 0, 1e4);
    const feed = n(r.feed, NaN, 0, 1e7);
    if (!(thickness > 0) || !(feed > 0)) continue;
    rows.push({
      material: r.material as MaterialId,
      thickness,
      feed,
      pierce: n(r.pierce, 0, 0, 3600),
      ...(n(r.kerf, 0, 0, 1e3) > 0 ? { kerf: n(r.kerf, 0, 0, 1e3) } : {}),
      ...(typeof r.note === "string" && r.note.trim() ? { note: r.note.trim().slice(0, 80) } : {}),
    });
  }
  return {
    id: typeof v.id === "string" && /^[a-z0-9-]{1,40}$/.test(v.id) ? v.id : fallbackId,
    name: s(v.name, d.name),
    type: TYPES.includes(v.type as MachineId) ? (v.type as MachineId | "tube") : d.type,
    units,
    bedW: n(v.bedW, 0, 0, 1e6),
    bedH: n(v.bedH, 0, 0, 1e6),
    rapid: n(v.rapid, 0, 0, 1e7),
    cutAccel: n(v.cutAccel, 0, 0, 1e6),
    rapidAccel: n(v.rapidAccel, 0, 0, 1e6),
    headLift: n(v.headLift, 0, 0, 60),
    cornerAngle: n(v.cornerAngle, 20, 0, 180),
    smallHole: n(v.smallHole, 0, 0, 1e4),
    smallHoleFeedPct: n(v.smallHoleFeedPct, 100, 1, 100),
    sheetLoadMin: n(v.sheetLoadMin, 0, 0, 600),
    rows,
  };
}

/** The `.sketchor-machine` file text. */
export function serializeMachineProfile(p: MachineProfile): string {
  return JSON.stringify({ format: "sketchor-machine", version: 1, ...p }, null, 2);
}

const MM: Record<ProfileUnits, number> = { mm: 1, in: 25.4 };

export interface ProfileMatch {
  /** All in mm / mm per min / s. */
  feedMmPerMin: number;
  pierceSec: number;
  kerfMm: number | null;
  /** The row used as is (within 0.05 mm), or false when estimated from neighbouring rows. */
  exact: boolean;
  note?: string;
}

/**
 * The cut values for `material` at `thicknessMm`: the row within 0.05 mm as
 * is; between two rows, feed interpolated on a log scale and pierce/kerf
 * linearly; outside the table, the nearest row with feed scaled down (and
 * pierce up) in proportion to thickness past the thickest. Null when the
 * material has no rows.
 */
export function profileRowFor(p: MachineProfile, material: string, thicknessMm: number): ProfileMatch | null {
  const k = MM[p.units];
  const rows = p.rows.filter((r) => r.material === material).sort((a, b) => a.thickness - b.thickness);
  if (rows.length === 0 || !(thicknessMm > 0)) return null;
  const mk = (r: ProfileCutRow, exact: boolean): ProfileMatch => ({ feedMmPerMin: r.feed * k, pierceSec: r.pierce, kerfMm: r.kerf ? r.kerf * k : null, exact, ...(r.note ? { note: r.note } : {}) });
  const exact = rows.find((r) => Math.abs(r.thickness * k - thicknessMm) <= 0.05);
  if (exact) return mk(exact, true);
  const t = thicknessMm / k;
  const first = rows[0]!, last = rows[rows.length - 1]!;
  if (t < first.thickness) return mk(first, false);
  if (t > last.thickness) {
    const f = t / last.thickness;
    return { ...mk(last, false), feedMmPerMin: (last.feed * k) / f, pierceSec: last.pierce * f };
  }
  const hiIdx = rows.findIndex((r) => r.thickness > t);
  const lo = rows[hiIdx - 1]!, hi = rows[hiIdx]!;
  const u = (t - lo.thickness) / (hi.thickness - lo.thickness);
  const lerp = (a: number, b: number) => a + (b - a) * u;
  const kerf = lo.kerf && hi.kerf ? lerp(lo.kerf, hi.kerf) * k : (lo.kerf ?? hi.kerf ?? 0) * k || null;
  return {
    feedMmPerMin: Math.exp(lerp(Math.log(lo.feed), Math.log(hi.feed))) * k,
    pierceSec: lerp(lo.pierce, hi.pierce),
    kerfMm: kerf,
    exact: false,
  };
}

/** Machine-wide motion values in mm (for `machineTimeSec`), without the per-row feed/pierce. */
export function profileMotionMm(p: MachineProfile) {
  const k = MM[p.units];
  return {
    rapidMmPerMin: p.rapid * k,
    cutAccel: p.cutAccel * k,
    rapidAccel: p.rapidAccel * k,
    headLiftSec: p.headLift,
    cornerAngleDeg: p.cornerAngle,
    smallHoleMm: p.smallHole * k,
    smallHoleFeedPct: p.smallHoleFeedPct,
    sheetLoadSec: p.sheetLoadMin * 60,
    bedMm: p.bedW > 0 && p.bedH > 0 ? { width: p.bedW * k, height: p.bedH * k } : null,
  };
}
