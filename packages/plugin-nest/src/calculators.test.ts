import { describe, expect, it } from "vitest";
import { defaultBarInput, defaultTubeInput, parseManualBars, parseTubeInput, runBarCalc, runTubeCalc } from "./calculators";

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

describe("bars arranged by hand (NT-06)", () => {
  const inp = { ...defaultBarInput(), unit: "mm" as const, kerf: "3", trim: "0", tail: "0", stock: [{ length: "6000", qty: "", cost: "" }, { length: "3000", qty: "", cost: "" }], cuts: [{ label: "A", length: "1000", qty: "5" }, { label: "B", length: "700", qty: "4" }], cutSec: "10", loadSec: "30" };
  const auto = runBarCalc(inp);

  it("an automatic plan hands back its patterns; fed back unchanged it gives the same result", () => {
    expect(auto.manual).toBe(false);
    expect(auto.patterns!.patterns.length).toBe(auto.bars.length);
    const again = runBarCalc({ ...inp, manual: auto.patterns });
    expect(again.manual).toBe(true);
    expect(again.summary).toEqual(auto.summary);
    expect(again.toCut).toEqual([]);
  });

  it("keeps the order given, sends a removed piece to the tray, and flags an overrun bar red", () => {
    const pats = JSON.parse(JSON.stringify(auto.patterns!.patterns));
    const first = pats[0];
    first.pieces.reverse();
    const r1 = runBarCalc({ ...inp, manual: { patterns: pats } });
    expect(r1.bars[0]!.draw!.pieces.map((x) => x.label)).toEqual(first.pieces.map((x: { label: string }) => x.label));
    const taken = first.pieces.pop();
    const r2 = runBarCalc({ ...inp, manual: { patterns: pats } });
    expect(r2.toCut).toEqual([{ label: taken.label, length: taken.length, text: expect.any(String), count: first.count }]);
    expect(r2.warnings.some((w) => w.includes("To cut tray"))).toBe(true);
    // pile everything onto a 3000 bar: over
    const r3 = runBarCalc({ ...inp, manual: { patterns: [{ count: 1, stock: 3000, pieces: [{ label: "A", length: 1000, flipped: false, upsideDown: false }, { label: "A", length: 1000, flipped: false, upsideDown: false }, { label: "A", length: 1000, flipped: false, upsideDown: false }] }] } });
    expect(r3.bars[0]!.over).toBeTruthy();
    expect(r3.warnings.some((w) => w.includes("too long"))).toBe(true);
    expect(r3.toCut!.map((t) => [t.label, t.count])).toEqual([["A", 2], ["B", 4]]);
  });

  it("counts pieces beyond the order, drops pieces whose row is gone", () => {
    const r = runBarCalc({ ...inp, manual: { patterns: [{ count: 2, stock: 6000, pieces: [...Array(3)].map(() => ({ label: "A", length: 1000, flipped: false, upsideDown: false })).concat([{ label: "Z", length: 50, flipped: false, upsideDown: false }]) }] } });
    expect(r.extra).toEqual(["A 1000 mm +1"]);
    expect(r.warnings.some((w) => w.includes("no longer match"))).toBe(true);
  });

  it("a mitred piece turned by hand shares the cut with its neighbour", () => {
    const t = { ...defaultTubeInput(), unit: "mm" as const, kerf: "0", trim: "0", tail: "0", a: "50", wall: "3", feed: "3000", stock: [{ length: "6000", qty: "", cost: "" }], cuts: [{ label: "F", length: "1000", qty: "2", a1: "45", a2: "45" }] };
    const piece = (upsideDown: boolean) => ({ label: "F", length: 1000, flipped: false, upsideDown });
    const plain = runTubeCalc({ ...t, manual: { patterns: [{ count: 1, stock: 6000, pieces: [piece(false), piece(false)] }] } }, []);
    const turned = runTubeCalc({ ...t, manual: { patterns: [{ count: 1, stock: 6000, pieces: [piece(false), piece(true)] }] } }, []);
    expect(Number(plain.summary.find(([l]) => l === "Cuts")![1])).toBe(4);
    expect(Number(turned.summary.find(([l]) => l === "Cuts")![1])).toBe(3);
    expect(turned.bars[0]!.draw!.used).toBeLessThan(plain.bars[0]!.draw!.used - 40);
  });

  it("rejects malformed layouts", () => {
    expect(parseManualBars(null)).toBeUndefined();
    expect(parseManualBars({ patterns: [{ count: 0, stock: 6000, pieces: [] }, { count: 1, stock: "x", pieces: [] }, { count: 2, stock: 3000, pieces: [{ label: 3, length: 1 }, { label: "A", length: -1 }, { label: "B", length: 10, flipped: "yes" }] }] })).toEqual({ patterns: [{ count: 2, stock: 3000, pieces: [{ label: "B", length: 10, flipped: false, upsideDown: false }] }] });
  });
});
