/**
 * Tests for the nesting job model (RN-20). The job is read from plugin
 * storage that may be empty, hand-edited or written by an older panel, so the
 * parser must always hand back a runnable job, and the legacy migration must
 * not lose a user's stock list or per-part settings (the pre-RN panel's data).
 */
import { describe, expect, it } from "vitest";
import { defaultJob, jobFromLegacyState, jobParamsMm, jobParts, jobSheets, lengthMm, parseNestJob, rotationCodeFromLegacy, rotationSpecFor } from "./nestJob";

const garbage: unknown[] = [undefined, null, 0, "", "{", "text", [], [1, 2], true, { engine: 5 }, { material: "gold", machine: "laser2", parts: "x", stock: 3 }, { params: { kerf: "no" }, thickness: 7, timeMs: -5 }];

describe("parseNestJob", () => {
  it("returns a valid job for any input, never throwing", () => {
    for (const g of garbage) {
      const j = parseNestJob(g);
      expect(j.version).toBe(1);
      expect(["raster", "true-shape"]).toContain(j.engine);
      expect(j.sheet.w).toBeGreaterThan(0);
      expect(j.timeMs).toBeGreaterThanOrEqual(0);
      expect(Array.isArray(j.parts)).toBe(true);
    }
  });
  it("is idempotent: parse(parse(x)) equals parse(x)", () => {
    for (const g of [...garbage, defaultJob(), jobFromLegacyState({ stock: [{ size: { name: "A", width: 100, height: 200 }, qty: 2 }] })]) {
      const once = parseNestJob(g);
      expect(parseNestJob(JSON.parse(JSON.stringify(once)))).toEqual(once);
    }
  });
  it("defaults to the raster engine and keeps catalog values in inches", () => {
    const j = defaultJob();
    expect(j.engine).toBe("raster");
    expect(j.params.kerf.u).toBe("in");
  });
  it("falls back to the standard sheet when 'stock' has no usable rows", () => {
    expect(parseNestJob({ sheetSource: "stock", stock: [{ size: { width: -1, height: 0 } }] }).sheetSource).toBe("standard");
  });
  it("clamps part quantities and drops parts without a key", () => {
    const j = parseNestJob({ parts: [{ key: "a", qty: -3 }, { key: "", qty: 1 }, { key: "b", qty: 1e12 }, null] });
    expect(j.parts.map((p) => p.key)).toEqual(["a", "b"]);
    expect(j.parts[0]!.qty).toBe(0);
    expect(j.parts[1]!.qty).toBeLessThanOrEqual(100000);
  });
});

describe("jobFromLegacyState (pre-RN PersistedState)", () => {
  const legacy = {
    stock: [
      { size: { name: "48x96", width: 1219.2, height: 2438.4 }, qty: null },
      { size: { name: "Offcut", width: 500, height: 400 }, qty: 3, material: "Mild Steel", thickness: 3, cost: 12 },
    ],
    workingParts: [
      { key: "a,b", sourceIds: ["a", "b"], settings: { quantity: 4, rotationMode: "any", stepDeg: 15, mirror: true, allowInHoles: true } },
      { key: "c", sourceIds: ["c"], settings: { quantity: 2, rotationMode: "locked", mirror: false, allowInHoles: false } },
      { key: "", sourceIds: [], settings: {} },
    ],
    spacing: 2, edgeMargin: 5, kerf: 0.3, gravity: "top-left", minHoleArea: 50, searchLevel: "normal", joinTolerance: 0.1,
  };
  it("keeps every stock row and part setting", () => {
    const j = jobFromLegacyState(legacy);
    expect(j.stock).toEqual(legacy.stock);
    expect(j.sheetSource).toBe("stock");
    expect(j.parts.map((p) => [p.key, p.qty, p.rotation, p.mirror, p.allowInHoles])).toEqual([
      ["a,b", 4, "r15", true, true],
      ["c", 2, "none", false, false],
    ]);
    expect(j.engine).toBe("true-shape");
    expect([j.gravity, j.minHoleArea, j.searchLevel, j.joinTolerance]).toEqual(["top-left", 50, "normal", 0.1]);
  });
  it("preserves spacing, kerf and margin numerically (mm)", () => {
    const p = jobParamsMm(jobFromLegacyState(legacy));
    expect(p.kerf).toBeCloseTo(0.3, 6);
    expect(p.web).toBeCloseTo(2, 6);
    expect(p.spacing).toBeCloseTo(2.3, 6);
    expect(p.margin).toBeCloseTo(5, 6);
    expect(p.thickness).toBeCloseTo(3, 6);
  });
  it("survives empty / garbage legacy state", () => {
    for (const g of garbage) expect(jobFromLegacyState(g).version).toBe(1);
  });
  it("maps legacy rotation to the nearest code", () => {
    expect(rotationCodeFromLegacy("quarter", undefined)).toBe("r90");
    expect(rotationCodeFromLegacy("any", 1)).toBe("free");
    expect(rotationCodeFromLegacy("any", 45)).toBe("r45");
    expect(rotationCodeFromLegacy("any", 7)).toBe("free");
    expect(rotationCodeFromLegacy("locked", 15)).toBe("none");
  });
});

describe("engine inputs", () => {
  it("converts inch catalog values and fractions to mm", () => {
    expect(lengthMm({ v: "1/4", u: "in" })).toBeCloseTo(6.35, 6);
    expect(lengthMm({ v: "12", u: "mm" })).toBeCloseTo(12, 6);
    expect(lengthMm({ v: "", u: "in" })).toBe(0);
    expect(lengthMm({ v: "abc", u: "in" })).toBe(0);
  });
  it("spacing is kerf + web; bed is null when unknown", () => {
    const j = defaultJob();
    const p = jobParamsMm(j);
    expect(p.spacing).toBeCloseTo(p.kerf + p.web, 9);
    expect(p.bed).not.toBeNull();
    expect(jobParamsMm({ ...j, machine: "other", params: { ...j.params, bedW: { v: "", u: "in" }, bedH: { v: "", u: "in" } } }).bed).toBeNull();
  });
  it("standard source is one unlimited sheet; stock + buyExtra adds the purchase size", () => {
    const j = defaultJob();
    const std = jobSheets(j);
    expect(std.stock).toHaveLength(1);
    expect(std.stock[0]!.qty).toBeNull();
    expect(std.extra).toBeNull();
    const stock = [{ size: { name: "S", width: 500, height: 400 }, qty: 2 }];
    const s = jobSheets({ ...j, sheetSource: "stock", stock, buyExtra: true });
    expect(s.stock).toEqual(stock);
    expect(s.extra!.width).toBeCloseTo(j.sheet.w * 25.4, 6);
  });
  it("rotation specs and job parts", () => {
    expect(rotationSpecFor("none").mode).toBe("locked");
    expect(rotationSpecFor("r90").mode).toBe("quarter");
    expect(rotationSpecFor("r30", true)).toEqual({ mode: "any", stepDeg: 30, mirror: true });
    const j = parseNestJob({ parts: [{ key: "k", qty: 3, rotation: "r45" }, { key: "missing", qty: 1 }] });
    const parts = jobParts(j, new Map([["k", { name: "K", outer: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }], holes: [] }]]));
    expect(parts).toHaveLength(1);
    expect(parts[0]!.quantity).toBe(3);
    expect(parts[0]!.angles).toEqual([0, 45, 90, 135, 180, 225, 270, 315]);
  });
});
