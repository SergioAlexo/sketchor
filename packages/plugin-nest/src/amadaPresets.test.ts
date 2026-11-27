import { describe, expect, it } from "vitest";
import { AMADA_PRESETS, amadaPreset, machineFromPreset } from "./amadaPresets";
import { MAX_PROFILE_ROWS, parseMachineProfile, profileMotionMm, profileRowFor } from "./machineProfile";
import { defaultJob, groupRunJob, jobParamsMm, type JobGroup } from "./nestJob";

/**
 * The Amada presets are machine files the user adds with one click and then
 * nests with. A preset the machine-file parser would trim (too many rows, a
 * long note, an unknown material) changes silently on the first save, and a
 * cut row with no feed or kerf gives no cutting time or the wrong part
 * spacing - so every preset must survive the parser unchanged and give a
 * usable row for each thickness a multi-material list is likely to hold.
 */

describe("Amada presets", () => {
  it("have unique ids and are laser machine files in mm", () => {
    const ids = AMADA_PRESETS.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const p of AMADA_PRESETS) {
      expect(p.profile.type).toBe("laser");
      expect(p.profile.units).toBe("mm");
      expect(p.profile.name).toMatch(/^Amada .*\(estimate\)$/);
      expect(p.profile.rows.length).toBeLessThanOrEqual(MAX_PROFILE_ROWS);
    }
  });

  for (const p of AMADA_PRESETS) {
    it(`${p.model}: survives the machine-file parser unchanged`, () => {
      const m = machineFromPreset(p, "m7");
      expect(parseMachineProfile(JSON.parse(JSON.stringify(m)), "x")).toEqual(m);
    });

    it(`${p.model}: the bed takes its nominal sheet`, () => {
      const bed = profileMotionMm(machineFromPreset(p, "m1")).bedMm!;
      expect(bed.width).toBeGreaterThanOrEqual(p.sheet.w);
      expect(bed.height).toBeGreaterThanOrEqual(p.sheet.h);
    });

    it(`${p.model}: feed falls and kerf / pierce do not fall as the sheet gets thicker`, () => {
      for (const mat of ["cs", "ss", "al5052", "al6061"]) {
        const rows = p.profile.rows.filter((r) => r.material === mat).sort((a, b) => a.thickness - b.thickness);
        expect(rows.length).toBeGreaterThan(5);
        for (let i = 1; i < rows.length; i++) {
          expect(rows[i]!.feed).toBeLessThan(rows[i - 1]!.feed);
          expect(rows[i]!.kerf!).toBeGreaterThanOrEqual(rows[i - 1]!.kerf!);
          expect(rows[i]!.pierce).toBeGreaterThanOrEqual(rows[i - 1]!.pierce);
        }
      }
    });
  }

  it("a copy is independent of the shipped table", () => {
    const p = amadaPreset("amada-ensis-3015aj-6kw")!;
    const m = machineFromPreset(p, "m1");
    m.rows[0]!.feed = 1;
    expect(p.profile.rows[0]!.feed).not.toBe(1);
    expect(amadaPreset("nope")).toBeUndefined();
  });

  it("gives each thickness of a mixed list its own kerf (3 mm and 10 mm mild steel differ)", () => {
    const m = machineFromPreset(amadaPreset("amada-ensis-3015aj-6kw")!, "m1");
    const thin = profileRowFor(m, "cs", 3)!;
    const thick = profileRowFor(m, "cs", 10)!;
    expect(thin.exact && thick.exact).toBe(true);
    expect(thick.kerfMm!).toBeGreaterThan(thin.kerfMm!);
    expect(thick.note).toMatch(/O2/);
    // and the group's run job carries it into the part spacing
    const g: JobGroup = { id: "cs|10", material: "cs", thickness: "10", thicknessUnit: "mm", sheet: { w: 60, h: 120 }, rotation: "r90", items: [] };
    const run = groupRunJob(defaultJob(), g, [], { v: String(thick.kerfMm), u: "mm" });
    expect(jobParamsMm(run).kerf).toBeCloseTo(thick.kerfMm!, 6);
  });
});
