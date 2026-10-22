import { describe, expect, it } from "vitest";
import { ACCURACY_CELL_IN, defaultMachines, defaultRotationFor, defaultSheets, materialFileToken, MATERIALS, rotationAngles, thicknessesFor, THICKNESSES } from "./catalog";
import { parseLen } from "./units";

/**
 * RN-21: the catalog seeds every new job. A typo here (a thickness whose
 * typed value and decimal disagree, a material with no sheets) becomes a
 * wrong default in front of every user, so these check the tables against
 * themselves rather than pinning individual numbers.
 */
describe("catalog tables", () => {
  it("every material has a sheet list and a thickness list, all positive", () => {
    const sheets = defaultSheets();
    for (const m of MATERIALS) {
      expect(sheets.sizes[m.id].length).toBeGreaterThan(0);
      for (const s of sheets.sizes[m.id]) expect(s.w > 0 && s.h > 0).toBe(true);
      expect(THICKNESSES.byMaterial[m.id].length).toBeGreaterThan(0);
    }
  });
  it("each thickness's typed value parses to its decimal inches (within a rounded caption)", () => {
    for (const m of MATERIALS) {
      for (const o of thicknessesFor(m.id)) expect(parseLen(o.value)).toBeCloseTo(o.inches, 3);
    }
  });
  it("thickness lists ascend", () => {
    for (const m of MATERIALS) {
      const l = thicknessesFor(m.id).map((o) => o.inches);
      expect([...l].sort((a, b) => a - b)).toEqual(l);
    }
  });
  it("everything is flagged as an estimate and in inches", () => {
    expect(defaultSheets()).toMatchObject({ estimate: true, unit: "in" });
    expect(THICKNESSES).toMatchObject({ estimate: true, unit: "in" });
    const mach = defaultMachines();
    expect(mach.estimate).toBe(true);
    for (const p of Object.values(mach.machines)) for (const f of Object.values(p)) expect(f.u).toBe("in");
  });
  it("defaults are fresh copies a caller can edit", () => {
    const a = defaultSheets();
    a.sizes.al5052.push({ w: 1, h: 1 });
    expect(defaultSheets().sizes.al5052.some((s) => s.w === 1)).toBe(false);
    const m = defaultMachines();
    m.machines.laser.kerf.v = "9";
    expect(defaultMachines().machines.laser.kerf.v).toBe("0.012");
  });
  it("machine fields that have values parse as lengths", () => {
    for (const p of Object.values(defaultMachines().machines)) {
      for (const f of [p.kerf, p.web, p.margin, p.clamp]) expect(parseLen(f.v)).toBeGreaterThanOrEqual(0);
    }
  });
  it("unknown materials fall back to a generic thickness list and their own file token", () => {
    expect(thicknessesFor("mystery").length).toBeGreaterThan(0);
    expect(materialFileToken("mystery")).toBe("mystery");
    expect(materialFileToken("ss")).toBe("STAINLESS");
  });
});

describe("rotation codes", () => {
  it("none, flip and the step codes", () => {
    expect(rotationAngles("none")).toEqual([0]);
    expect(rotationAngles("flip")).toEqual([0, 180]);
    expect(rotationAngles("r90")).toEqual([0, 90, 180, 270]);
    expect(rotationAngles("r45")).toHaveLength(8);
    expect(rotationAngles("free")).toHaveLength(360);
    expect(rotationAngles("bogus")).toEqual([0, 90, 180, 270]);
  });
  it("stone and quartz default to no rotation", () => {
    expect(defaultRotationFor("stone")).toBe("none");
    expect(defaultRotationFor("quartz")).toBe("none");
    expect(defaultRotationFor("al5052")).toBe("r90");
  });
  it("accuracy cells get finer from fast to precise", () => {
    expect(ACCURACY_CELL_IN.fast).toBeGreaterThan(ACCURACY_CELL_IN.normal);
    expect(ACCURACY_CELL_IN.normal).toBeGreaterThan(ACCURACY_CELL_IN.precise);
  });
});
