import type { MaterialId } from "./catalog";
import type { MachineProfile, ProfileCutRow } from "./machineProfile";

/**
 * Amada fiber laser starting points for the Machines tab (NT-02 machine
 * files). Each preset is a normal mm `MachineProfile`: the bed is the
 * model's X/Y travel, and the cut table holds feed, pierce, kerf and assist
 * gas per material and thickness. Sheet Nesting reads it like any other
 * machine file: the kerf for the job's (or each group's) material and
 * thickness sets the part spacing, and the feed and pierce set the cutting
 * time and the G-code feed.
 *
 * The numbers are typical starting values for a fiber resonator of that
 * power class. They are NOT Amada's cutting-condition data and are not
 * guaranteed for any machine. Nozzle, lens, focus, gas purity and the
 * condition library on the control (AMNC) all change them, so the panel adds
 * a preset as an editable copy, labelled "estimate", for the shop to correct
 * against its own conditions.
 *
 * Why it is worth testing: a preset with a missing or zero feed gives no
 * cutting time, and a preset `parseMachineProfile` would reject or trim
 * (more rows than it keeps, a note over 80 characters) is silently changed
 * the first time the user saves it. The tests run every preset through the
 * parser and check that it comes back unchanged.
 */

/** [thickness mm, feed mm/min, pierce s, kerf mm, assist gas] */
type Row = readonly [number, number, number, number, string];

const rows = (material: MaterialId, list: readonly Row[]): ProfileCutRow[] =>
  list.map(([thickness, feed, pierce, kerf, gas]) => ({ material, thickness, feed, pierce, kerf, note: `${gas} - estimate` }));

// ---------- cut tables by power class ----------

const CS_3KW: Row[] = [
  [1, 28000, 0.1, 0.1, "N2/air"],
  [2, 12000, 0.2, 0.12, "N2/air"],
  [3, 5000, 0.3, 0.15, "air"],
  [4, 3200, 0.5, 0.25, "O2"],
  [5, 2800, 0.6, 0.28, "O2"],
  [6, 2400, 0.8, 0.3, "O2"],
  [8, 1800, 1.2, 0.35, "O2"],
  [10, 1300, 1.8, 0.4, "O2"],
  [12, 1000, 2.5, 0.45, "O2"],
  [16, 750, 3.5, 0.5, "O2"],
  [20, 550, 5, 0.55, "O2"],
];
const SS_3KW: Row[] = [
  [1, 30000, 0.1, 0.1, "N2"],
  [2, 12000, 0.2, 0.12, "N2"],
  [3, 6000, 0.3, 0.15, "N2"],
  [4, 3500, 0.5, 0.18, "N2"],
  [5, 2300, 0.7, 0.2, "N2"],
  [6, 1600, 0.9, 0.22, "N2"],
  [8, 900, 1.5, 0.25, "N2"],
  [10, 500, 2.2, 0.3, "N2"],
  [12, 300, 3, 0.32, "N2"],
];
const AL_3KW: Row[] = [
  [1, 28000, 0.1, 0.1, "N2"],
  [2, 12000, 0.2, 0.12, "N2"],
  [3, 5500, 0.3, 0.15, "N2"],
  [4, 3000, 0.5, 0.18, "N2"],
  [5, 2000, 0.7, 0.2, "N2"],
  [6, 1300, 0.9, 0.22, "N2"],
  [8, 700, 1.5, 0.25, "N2"],
  [10, 400, 2.2, 0.3, "N2"],
];

const CS_6KW: Row[] = [
  [1, 40000, 0.1, 0.1, "N2/air"],
  [2, 22000, 0.2, 0.12, "N2/air"],
  [3, 12000, 0.3, 0.15, "air"],
  [4, 4000, 0.5, 0.25, "O2"],
  [5, 3500, 0.7, 0.28, "O2"],
  [6, 3000, 0.8, 0.3, "O2"],
  [8, 2300, 1.2, 0.35, "O2"],
  [10, 1800, 1.8, 0.4, "O2"],
  [12, 1500, 2.5, 0.45, "O2"],
  [16, 1000, 3.5, 0.5, "O2"],
  [20, 800, 5, 0.55, "O2"],
  [25, 600, 7, 0.6, "O2"],
];
const SS_6KW: Row[] = [
  [1, 40000, 0.1, 0.1, "N2"],
  [2, 22000, 0.2, 0.12, "N2"],
  [3, 13000, 0.3, 0.15, "N2"],
  [4, 8000, 0.5, 0.18, "N2"],
  [5, 5500, 0.7, 0.2, "N2"],
  [6, 4000, 0.9, 0.22, "N2"],
  [8, 2200, 1.5, 0.25, "N2"],
  [10, 1300, 2.2, 0.3, "N2"],
  [12, 900, 3, 0.32, "N2"],
  [16, 500, 5, 0.35, "N2"],
  [20, 300, 7, 0.4, "N2"],
];
const AL_6KW: Row[] = [
  [1, 40000, 0.1, 0.1, "N2"],
  [2, 22000, 0.2, 0.12, "N2"],
  [3, 12000, 0.3, 0.15, "N2"],
  [4, 7000, 0.5, 0.18, "N2"],
  [5, 5000, 0.7, 0.2, "N2"],
  [6, 3500, 0.9, 0.22, "N2"],
  [8, 2000, 1.5, 0.25, "N2"],
  [10, 1200, 2.2, 0.3, "N2"],
  [12, 800, 3, 0.32, "N2"],
  [16, 450, 5, 0.35, "N2"],
  [20, 250, 7, 0.4, "N2"],
];

const CS_9KW: Row[] = [
  [1, 45000, 0.1, 0.1, "N2/air"],
  [2, 30000, 0.2, 0.12, "N2/air"],
  [3, 18000, 0.3, 0.15, "air"],
  [4, 12000, 0.4, 0.18, "air"],
  [5, 8000, 0.5, 0.2, "air"],
  [6, 5500, 0.6, 0.22, "air"],
  [8, 2500, 1, 0.35, "O2"],
  [10, 2000, 1.5, 0.4, "O2"],
  [12, 1700, 2, 0.45, "O2"],
  [16, 1200, 3, 0.5, "O2"],
  [20, 900, 4.5, 0.55, "O2"],
  [25, 700, 6, 0.6, "O2"],
];
const SS_9KW: Row[] = [
  [1, 45000, 0.1, 0.1, "N2"],
  [2, 30000, 0.2, 0.12, "N2"],
  [3, 20000, 0.3, 0.15, "N2"],
  [4, 13000, 0.4, 0.18, "N2"],
  [5, 9000, 0.6, 0.2, "N2"],
  [6, 7000, 0.8, 0.22, "N2"],
  [8, 4000, 1.2, 0.25, "N2"],
  [10, 2500, 1.8, 0.3, "N2"],
  [12, 1800, 2.5, 0.32, "N2"],
  [16, 1000, 4, 0.35, "N2"],
  [20, 600, 6, 0.4, "N2"],
  [25, 350, 8, 0.45, "N2"],
];
const AL_9KW: Row[] = [
  [1, 45000, 0.1, 0.1, "N2"],
  [2, 30000, 0.2, 0.12, "N2"],
  [3, 18000, 0.3, 0.15, "N2"],
  [4, 12000, 0.4, 0.18, "N2"],
  [5, 8500, 0.6, 0.2, "N2"],
  [6, 6000, 0.8, 0.22, "N2"],
  [8, 3500, 1.2, 0.25, "N2"],
  [10, 2200, 1.8, 0.3, "N2"],
  [12, 1500, 2.5, 0.32, "N2"],
  [16, 900, 4, 0.35, "N2"],
  [20, 550, 6, 0.4, "N2"],
  [25, 300, 8, 0.45, "N2"],
];

/** 6061 cuts a little slower than 5052 at the same thickness. */
const slower = (list: readonly Row[], f: number): Row[] => list.map(([t, feed, p, k, g]) => [t, Math.round((feed * f) / 10) * 10, p, k, g]);

function table(cs: Row[], ss: Row[], al: Row[]): ProfileCutRow[] {
  return [...rows("cs", cs), ...rows("ss", ss), ...rows("al5052", al), ...rows("al6061", slower(al, 0.9))];
}

const TABLE_3KW = table(CS_3KW, SS_3KW, AL_3KW);
const TABLE_6KW = table(CS_6KW, SS_6KW, AL_6KW);
const TABLE_9KW = table(CS_9KW, SS_9KW, AL_9KW);

// ---------- presets ----------

export interface AmadaPreset {
  /** Stable preset id (not a machine-file id: adding a preset makes a copy with a fresh id). */
  id: string;
  /** Model and resonator power, e.g. "ENSIS-3015 AJ 6 kW". */
  model: string;
  /** Typical sheet size the bed takes, mm (w x h), for the panel's caption. */
  sheet: { w: number; h: number };
  profile: Omit<MachineProfile, "id">;
}

interface Bed {
  /** X / Y travel, mm. */
  x: number;
  y: number;
  sheet: { w: number; h: number };
}

const BED_3015: Bed = { x: 3070, y: 1550, sheet: { w: 3000, h: 1500 } };
const BED_4020: Bed = { x: 4070, y: 2050, sheet: { w: 4000, h: 2000 } };

interface Motion {
  rapid: number;
  cutAccel: number;
  rapidAccel: number;
  headLift: number;
}

/** Linear-motor gantry (REGIUS) vs. the rack-and-pinion / ball-screw class (ENSIS, LCG). Estimates. */
const MOTION_STD: Motion = { rapid: 120000, cutAccel: 5000, rapidAccel: 10000, headLift: 0.3 };
const MOTION_FAST: Motion = { rapid: 200000, cutAccel: 10000, rapidAccel: 20000, headLift: 0.2 };

function preset(id: string, model: string, bed: Bed, motion: Motion, cut: ProfileCutRow[]): AmadaPreset {
  return {
    id,
    model,
    sheet: bed.sheet,
    profile: {
      name: `Amada ${model} (estimate)`,
      type: "laser",
      units: "mm",
      bedW: bed.x,
      bedH: bed.y,
      rapid: motion.rapid,
      cutAccel: motion.cutAccel,
      rapidAccel: motion.rapidAccel,
      headLift: motion.headLift,
      cornerAngle: 20,
      smallHole: 10,
      smallHoleFeedPct: 50,
      // Shuttle-table exchange; set it higher when sheets are loaded by hand.
      sheetLoadMin: 0.5,
      rows: cut.map((r) => ({ ...r })),
    },
  };
}

export const AMADA_PRESETS: readonly AmadaPreset[] = [
  preset("amada-lcg-3015aj-3kw", "LCG-3015 AJ 3 kW", BED_3015, MOTION_STD, TABLE_3KW),
  preset("amada-ensis-3015aj-3kw", "ENSIS-3015 AJ 3 kW", BED_3015, MOTION_STD, TABLE_3KW),
  preset("amada-ensis-3015aj-6kw", "ENSIS-3015 AJ 6 kW", BED_3015, MOTION_STD, TABLE_6KW),
  preset("amada-ensis-4020aj-6kw", "ENSIS-4020 AJ 6 kW", BED_4020, MOTION_STD, TABLE_6KW),
  preset("amada-regius-3015aj-9kw", "REGIUS-3015 AJ 9 kW", BED_3015, MOTION_FAST, TABLE_9KW),
  preset("amada-regius-4020aj-9kw", "REGIUS-4020 AJ 9 kW", BED_4020, MOTION_FAST, TABLE_9KW),
];

export function amadaPreset(id: string): AmadaPreset | undefined {
  return AMADA_PRESETS.find((p) => p.id === id);
}

/** A fresh, editable machine file from a preset (rows copied, so edits never reach the shipped table). */
export function machineFromPreset(p: AmadaPreset, id: string): MachineProfile {
  return { ...p.profile, id, rows: p.profile.rows.map((r) => ({ ...r })) };
}
