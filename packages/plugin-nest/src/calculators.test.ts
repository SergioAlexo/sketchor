import { describe, expect, it } from "vitest";
import { defaultBarInput, defaultTubeInput, parseTubeInput, runBarCalc, runTubeCalc } from "./calculators";

describe("tube calculator with mitred ends (NT-05)", () => {
  const frame = { ...defaultTubeInput(), unit: "mm" as const, kerf: "2", trim: "0", tail: "0", a: "50", wall: "3", feed: "3000", pierce: "0.5", index: "1", load: "30", unload: "2", stock: [{ length: "6000", qty: "", cost: "" }], cuts: [{ label: "F", length: "1000", qty: "6", a1: "45", a2: "45" }] };

  it("turns frame pieces to share mitre cuts: 6 x 1000 long-point pieces on one 6 m bar", () => {
    const r = runTubeCalc(frame, []);
    expect(r.error).toBeUndefined();
    expect(r.mitred).toBe(true);
    expect(r.summary.find(([l]) => l === "Bars to get")![1]).toBe("1");
    expect(r.bars[0]!.cuts).toContain("upside down");
    expect(r.bars[0]!.draw!.pieces).toHaveLength(6);
    expect(r.bars[0]!.draw!.depth).toBeCloseTo(50, 6);
    // 7 cuts (first end, 5 shared, last end), each at 45 degrees
    expect(r.summary.find(([l]) => l === "Cuts")![1]).toBe("7");
    expect(r.details!.some(([l]) => l === "Mitres")).toBe(true);
  });

  it("without turning, the same pieces need two bars and twice the cuts", () => {
    const r = runTubeCalc({ ...frame, turn: false, stock: [{ length: "5900", qty: "", cost: "" }] }, []);
    expect(r.summary.find(([l]) => l === "Bars to get")![1]).toBe("2");
  });

  it("rejects silly angles and keeps square plans unchanged", () => {
    const r = runTubeCalc({ ...frame, cuts: [{ label: "F", length: "1000", qty: "2", a1: "95", a2: "" }] }, []);
    expect(r.warnings.some((w) => w.includes("angle"))).toBe(true);
    expect(r.mitred).toBe(false);
    expect(parseTubeInput({ across: "a", turn: false }).turn).toBe(false);
    expect(parseTubeInput({}).across).toBe("b");
  });

  it("bars get a saw time when a time per cut is given", () => {
    const r = runBarCalc({ ...defaultBarInput(), cutSec: "20", loadSec: "60" });
    const cuts = Number(r.summary.find(([l]) => l === "Cuts")![1]);
    expect(cuts).toBeGreaterThan(0);
    expect(r.summary.some(([l]) => l === "Saw time")).toBe(true);
    expect(r.bars.every((b) => b.time)).toBe(true);
    expect(runBarCalc(defaultBarInput()).summary.some(([l]) => l === "Saw time")).toBe(false);
  });
});
