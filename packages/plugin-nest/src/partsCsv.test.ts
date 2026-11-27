import { describe, expect, it } from "vitest";
import { classifyMaterialLoose, groupsFromCsvRows, looksLikePartsCsv, parsePartsCsv, parseSheetCell, parseThicknessCell } from "./partsCsv";
import { defaultJob, groupRunJob, groupThickness, jobParamsMm, lengthMm, parseNestJob } from "./nestJob";

/**
 * A CSV parts list drives a multi-material nest: every row says how many of
 * which part, in which material and thickness. A misread column nests the
 * wrong quantity, a lost unit reads "3" (mm) as three inches, and a material
 * mix-up cuts a stainless part from mild steel - all silently, until the
 * parts are cut. These tests pin the header aliases, the unit rules and the
 * grouping, and that bad input degrades to counted problems, never a throw.
 */

describe("parsePartsCsv", () => {
  it("reads a header in any order with units in the header", () => {
    const r = parsePartsCsv("Material;Thickness (mm);Qty;Part number\nS235;3;4;BR-001\nAISI 304;1,5;2;BR-002\n");
    expect(r.header).toBe(true);
    expect(r.rows).toEqual([
      { num: "BR-001", qty: 4, material: "cs", thickness: { v: "3", u: "mm" } },
      { num: "BR-002", qty: 2, material: "ss", thickness: { v: "1.5", u: "mm" } },
    ]);
  });

  it("a unit in the cell beats the header and the default; gauges come from the material's table", () => {
    const r = parsePartsCsv('Part,Qty,Material,Thickness\nA,1,Aluminium 5052,1/8"\nB,1,mild steel,16 ga\nC,1,stainless,2 mm\nD,1,steel,3\n', { defaultThicknessUnit: "in" });
    expect(r.rows.map((x) => x.thickness)).toEqual([
      { v: "1/8", u: "in" },
      { v: "0.0598", u: "in" },
      { v: "2", u: "mm" },
      { v: "3", u: "in" }, // bare number: the default unit (here inches)
    ]);
  });

  it("without a header the columns are part, qty, material, thickness", () => {
    const r = parsePartsCsv("P1,3,SS,2\nP2,1,AL6061,4\n");
    expect(r.header).toBe(false);
    expect(r.rows.map((x) => [x.num, x.qty, x.material, x.thickness?.v])).toEqual([
      ["P1", 3, "ss", "2"],
      ["P2", 1, "al6061", "4"],
    ]);
  });

  it("a file-name column is what gets looked up, ahead of the part number and name", () => {
    const r = parsePartsCsv("Name,Part No,File,Qty\nBracket,PN-7,bracket-v2.dxf,5\n");
    expect(r.rows[0]!.num).toBe("bracket-v2.dxf");
    const r2 = parsePartsCsv("Name,Part No,Qty\nBracket,PN-7,5\n");
    expect(r2.rows[0]!.num).toBe("PN-7");
  });

  it("reads Excel's sep= line, quoted fields, a BOM mark and optional columns", () => {
    const text = '﻿sep=;\nPart;Qty;Material;Thk;Rotation;Priority;Due;Sheet\n"Plate; big";2 pcs;S355;8mm;none;high;31.12.2026;3000x1500 mm\n';
    const r = parsePartsCsv(text);
    expect(r.rows).toEqual([
      { num: "Plate; big", qty: 2, material: "cs", thickness: { v: "8", u: "mm" }, rotation: "none", priority: "high", due: "2026-12-31", sheet: { w: 59.0551, h: 118.1102 } },
    ]);
  });

  it("counts what it cannot read instead of guessing", () => {
    const r = parsePartsCsv("Part,Qty,Material,Thickness\nA,,unobtainium,2\n,4,SS,2\nTotal,9,,\nB,0,SS,2\nC,many,SS,2\n");
    expect(r.rows.map((x) => x.num)).toEqual(["A", "C"]);
    expect(r.qtyMissing).toBe(2);
    expect(r.materialUnknown).toBe(1);
    expect(r.rows[0]!.material).toBeNull();
    expect(r.skipped).toBe(3); // no part, a total line, quantity 0
  });

  it("takes the thickness from the material text when there is no thickness column", () => {
    const r = parsePartsCsv("Part,Qty,Material\nA,1,DC01 2mm\nB,1,\"SHEET, AL 5052 .125\"\n");
    expect(r.rows.map((x) => [x.material, x.thickness])).toEqual([
      ["cs", { v: "2", u: "mm" }],
      ["al5052", { v: "0.125", u: "in" }],
    ]);
  });

  it("never throws on empty, truncated or junk input", () => {
    for (const t of ["", "\n\n", "sep=;", 'Part,Qty\n"unterminated,3', "\u0000\u0001,,,", ";;;;\n;;;", "x".repeat(10000)]) {
      expect(() => parsePartsCsv(t)).not.toThrow();
    }
    expect(parsePartsCsv("").rows).toEqual([]);
    expect(parsePartsCsv(null as unknown as string).rows).toEqual([]);
  });

  it("looksLikePartsCsv needs a recognised header with a part column", () => {
    expect(looksLikePartsCsv("Part,Qty,Thickness\nA,1,2")).toBe(true);
    expect(looksLikePartsCsv("A,1,2")).toBe(false);
  });
});

describe("cell readers", () => {
  it("classifies grades and names", () => {
    expect(classifyMaterialLoose("1.4301")).toBe("ss");
    expect(classifyMaterialLoose("SUS304")).toBe("ss");
    expect(classifyMaterialLoose("EN AW-5754")).toBe("al5052");
    expect(classifyMaterialLoose("AlMgSi 6082")).toBe("al6061");
    expect(classifyMaterialLoose("SPCC")).toBe("cs");
    expect(classifyMaterialLoose("galvanised")).toBe("cs");
    expect(classifyMaterialLoose("acrylic")).toBe("plastic");
    expect(classifyMaterialLoose("al5052")).toBe("al5052");
    expect(classifyMaterialLoose("??")).toBeNull();
    expect(classifyMaterialLoose("")).toBeNull();
  });

  it("rejects thickness values that are not lengths", () => {
    expect(parseThicknessCell("abc", null, null, "mm")).toBeNull();
    expect(parseThicknessCell("-3", null, null, "mm")).toBeNull();
    expect(parseThicknessCell("0", null, null, "mm")).toBeNull();
    expect(parseThicknessCell("0.3 cm", null, null, "in")).toEqual({ v: "3", u: "mm" });
    expect(parseThicknessCell("99 ga", "cs", null, "mm")).toBeNull();
  });

  it("reads sheet sizes in either orientation", () => {
    expect(parseSheetCell("120 x 60", null, "in")).toEqual({ w: 60, h: 120 });
    expect(parseSheetCell("48x96 in", null, "mm")).toEqual({ w: 48, h: 96 });
    expect(parseSheetCell("big", null, "mm")).toBeNull();
  });
});

describe("groupsFromCsvRows", () => {
  const csv = "Part,Qty,Material,Thickness (mm)\nA,2,S235,3\nB,1,S235,10\nC,4,304,3\nA,3,S235,3.0\nD,1,,\n";

  it("one group per material + thickness, first-seen order, repeats summed", () => {
    const groups = groupsFromCsvRows(parsePartsCsv(csv).rows, { material: "al5052", thickness: { v: "1/8", u: "in" } });
    expect(groups.map((g) => [g.material, g.thickness, g.thicknessUnit ?? "in", g.items.map((i) => `${i.num}x${i.qty}`).join(" ")])).toEqual([
      ["cs", "3", "mm", "Ax5"],
      ["cs", "10", "mm", "Bx1"],
      ["ss", "3", "mm", "Cx4"],
      ["al5052", "1/8", "in", "Dx1"], // no material / thickness: the job's
    ]);
  });

  it('"1/8" and "0.125" in are one group; per-row rotation / priority / due date are kept', () => {
    const rows = parsePartsCsv("Part,Qty,Material,Thickness,Rotation,Priority,Due\nA,1,SS,1/8 in,none,low,2026-12-01\nB,1,SS,0.125 in,,,\n").rows;
    const groups = groupsFromCsvRows(rows, { material: "cs", thickness: null });
    expect(groups).toHaveLength(1);
    expect(groups[0]!.items).toEqual([
      { num: "A", qty: 1, rotation: "none", priority: "low", due: "2026-12-01" },
      { num: "B", qty: 1 },
    ]);
  });

  it("uses the sheet column, else the sheetFor callback", () => {
    const rows = parsePartsCsv("Part,Qty,Material,Thickness,Sheet\nA,1,SS,2,48x96 in\nB,1,cs,2,\n").rows;
    const groups = groupsFromCsvRows(rows, { material: "cs", thickness: null, sheetFor: () => ({ w: 1, h: 2 }) });
    expect(groups.map((g) => g.sheet)).toEqual([{ w: 48, h: 96 }, { w: 1, h: 2 }]);
  });

  it("each group runs with its own thickness and kerf, and survives a save / reopen", () => {
    const groups = groupsFromCsvRows(parsePartsCsv(csv).rows, { material: "cs", thickness: null });
    const job = { ...defaultJob(), mode: "groups" as const, groups: [{ ...groups[1]!, kerf: { v: "0.4", u: "mm" as const } }, groups[0]!] };
    const back = parseNestJob(JSON.parse(JSON.stringify(job)));
    expect(back.groups).toEqual(job.groups);
    const thick = groupRunJob(back, back.groups[0]!, []);
    const thin = groupRunJob(back, back.groups[1]!, [], { v: "0.15", u: "mm" });
    // Lengths go through parseLen's inches (rounded to ~1e-8 mm): 6 decimals = 1 µm, far below any kerf or sheet tolerance.
    expect(lengthMm(groupThickness(back.groups[0]!))).toBeCloseTo(10, 6);
    expect(jobParamsMm(thick).kerf).toBeCloseTo(0.4, 6); // the group's own kerf
    expect(jobParamsMm(thin).kerf).toBeCloseTo(0.15, 6); // the machine file's
    expect(jobParamsMm(groupRunJob(back, back.groups[1]!, [])).kerf).toBeCloseTo(jobParamsMm(back).kerf, 6); // the job's
    expect(thick.thickness).toEqual({ v: "10", u: "mm" });
  });

  it("an unreadable stored kerf or unit falls back instead of breaking the job", () => {
    const back = parseNestJob({ mode: "groups", groups: [{ material: "cs", thickness: "3", thicknessUnit: "furlong", kerf: { v: "", u: "mm" }, items: [{ num: "A", qty: 1, rotation: "sideways", priority: "max", due: "2026-02-30" }] }] });
    expect(back.groups[0]).toMatchObject({ thickness: "3", items: [{ num: "A", qty: 1 }] });
    expect(back.groups[0]!.thicknessUnit).toBeUndefined();
    expect(back.groups[0]!.kerf).toBeUndefined();
    expect(back.groups[0]!.items[0]).toEqual({ num: "A", qty: 1 });
    expect(jobParamsMm(groupRunJob(back, { ...back.groups[0]!, kerf: { v: "junk", u: "mm" } }, [])).kerf).toBeCloseTo(jobParamsMm(back).kerf, 6);
  });
});
