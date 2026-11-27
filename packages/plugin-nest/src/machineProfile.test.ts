/**
 * Machine files are typed by hand and passed between shop PCs, so the
 * parser must survive anything, and the row lookup decides the feed every
 * cutting-time quote is built on: an exact row must be used as is, and a
 * thickness between rows must land between their feeds, never outside.
 */
import { describe, expect, it } from "vitest";
import { newMachineProfile, parseMachineProfile, profileMotionMm, profileRowFor, serializeMachineProfile } from "./machineProfile";

describe("machine profiles", () => {
  it("round-trips through the file text", () => {
    const p = newMachineProfile("bodor-3k", "Bodor 3 kW");
    expect(parseMachineProfile(JSON.parse(serializeMachineProfile(p)))).toEqual(p);
  });

  it("never throws on junk and drops invalid rows", () => {
    expect(parseMachineProfile(null)).toBeNull();
    expect(parseMachineProfile("x")).toBeNull();
    const p = parseMachineProfile({ name: 5, rows: [{ material: "unobtainium", thickness: 1, feed: 1 }, { material: "cs", thickness: -1, feed: 10 }, { material: "cs", thickness: 3, feed: 1000 }] }, "m1")!;
    expect(p.id).toBe("m1");
    expect(p.rows).toHaveLength(1);
  });

  it("uses an exact row as is, in mm", () => {
    const p = newMachineProfile("x");
    const m = profileRowFor(p, "cs", 0.125 * 25.4)!;
    expect(m.exact).toBe(true);
    expect(m.feedMmPerMin).toBeCloseTo(140 * 25.4, 6);
    expect(m.kerfMm).toBeCloseTo(0.01 * 25.4, 6);
  });

  it("interpolates between rows inside their range", () => {
    const p = newMachineProfile("x");
    const m = profileRowFor(p, "cs", 0.19 * 25.4)!;
    expect(m.exact).toBe(false);
    expect(m.feedMmPerMin).toBeLessThan(140 * 25.4);
    expect(m.feedMmPerMin).toBeGreaterThan(70 * 25.4);
  });

  it("slows down past the thickest row and has nothing for an unknown material", () => {
    const p = newMachineProfile("x");
    expect(profileRowFor(p, "cs", 0.5 * 25.4)!.feedMmPerMin).toBeCloseTo((70 * 25.4) / 2, 6);
    expect(profileRowFor(p, "plywood", 3)).toBeNull();
  });

  it("converts motion values to mm", () => {
    const m = profileMotionMm(newMachineProfile("x"));
    expect(m.rapidMmPerMin).toBeCloseTo(3000 * 25.4, 6);
    expect(m.sheetLoadSec).toBe(300);
    expect(m.bedMm).toEqual({ width: 60 * 25.4, height: 120 * 25.4 });
  });
});
