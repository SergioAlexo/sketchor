import { describe, expect, it } from "vitest";
import { defaultTubeInput, runTubeCalc } from "@sketchor/plugin-nest";
import { barLayoutCommands, buildBarReportHtml, buildBarReportPdf } from "./barReport";

const res = runTubeCalc({ ...defaultTubeInput(), unit: "mm", kerf: "2", trim: "5", tail: "50", a: "50", wall: "3", feed: "3000", stock: [{ length: "6000", qty: "", cost: "40" }], cuts: [{ label: "F", length: "1000", qty: "8", a1: "45", a2: "45" }, { label: "S", length: "300", qty: "5" }] }, []);

describe("bar report / layout (NT-05)", () => {
  it("draws every pattern with its pieces, titled with CUT xN when repeated", () => {
    const cmds = barLayoutCommands(res, { noun: "Tube" });
    const ents = cmds.flatMap((c) => (c.type === "add-entity" ? [c.entity] : []));
    const pieces = res.bars.reduce((n, b) => n + b.draw!.pieces.length, 0);
    // per pattern: outline + trim + pieces + drop (+ texts)
    expect(ents.filter((e) => e.type === "polyline").length).toBeGreaterThanOrEqual(pieces + res.bars.length);
    const titles = ents.flatMap((e) => (e.type === "text" ? [e.text] : [])).filter((t) => t.startsWith("Tube pattern"));
    expect(titles).toHaveLength(res.bars.length);
  });
  it("prints the summary, the stock to get and one drawing per pattern", () => {
    const html = buildBarReportHtml(res, { title: "Tube Cutting Report", noun: "Tube", jobName: "Frames <A>" });
    expect(html).toContain("Frames &lt;A&gt; - Tube Cutting Report");
    expect(html).toContain("Stock to get");
    expect((html.match(/<svg /g) || []).length).toBe(res.bars.length);
    expect(html).toContain("Cut time");
    const pdf = buildBarReportPdf(res, { title: "Tube Cutting Report", noun: "Tube" });
    expect(new TextDecoder().decode(pdf.slice(0, 5))).toBe("%PDF-");
  });
});

describe("bars arranged by hand in the report (NT-06)", () => {
  it("marks an overrun bar too long and draws the overrun", () => {
    const r = runTubeCalc({ ...defaultTubeInput(), unit: "mm", kerf: "0", trim: "0", tail: "0", a: "50", wall: "3", feed: "3000", stock: [{ length: "3000", qty: "", cost: "" }], cuts: [{ label: "S", length: "1200", qty: "3" }], manual: { patterns: [{ count: 1, stock: 3000, pieces: [1, 2, 3].map(() => ({ label: "S", length: 1200, flipped: false, upsideDown: false })) }] } }, []);
    expect(r.bars[0]!.over).toBeTruthy();
    const html = buildBarReportHtml(r, { title: "Tube Cutting Report", noun: "Tube" });
    expect(html).toContain("TOO LONG by");
    expect(html).toContain('fill="#f6c6cb"');
  });
});
