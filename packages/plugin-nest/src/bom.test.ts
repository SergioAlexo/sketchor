import { describe, expect, it } from "vitest";
import { classifyMat, cleanNum, csvDelim, normName, parseBom, parseSheetText, splitCsvLine, sumRepeatedRows, thickFrom } from "./bom";

/**
 * RN-13: a pasted or exported parts list decides which parts get nested and
 * how many. A misread quantity or material silently nests the wrong job, so
 * these pin the conservative rules: unreadable quantity stays null, non-sheet
 * rows are skipped (and counted), repeats are summed, and malformed input
 * never throws.
 */
describe("classifyMat / thickFrom", () => {
  it("recognises aluminium alloys, stainless and carbon steel", () => {
    expect(classifyMat("SHEET, AL 5052 .125")).toBe("al5052");
    expect(classifyMat("ALUMINUM 6061")).toBe("al6061");
    expect(classifyMat("STAINLESS 304")).toBe("ss");
    expect(classifyMat("HRPO steel")).toBe("cs");
    expect(classifyMat("mystery")).toBeNull();
    expect(classifyMat("")).toBeNull();
  });
  it("reads a decimal thickness and ignores integers", () => {
    expect(thickFrom("SHEET .125 AL")).toBe("0.125");
    expect(thickFrom("SHEET 0.0598 SS")).toBe("0.0598");
    expect(thickFrom("SHEET 12 pcs")).toBe("");
    expect(thickFrom("")).toBe("");
  });
});

describe("cleanNum", () => {
  it("drops extensions and leading icon noise", () => {
    expect(cleanNum("PN-0001.SLDPRT")).toBe("PN-0001");
    expect(cleanNum("~ PN-0002.dxf")).toBe("PN-0002");
  });
  it("glues an OCR-split long number", () => {
    expect(cleanNum("00000297 18.SLDPRT")).toBe("0000029718");
  });
  it("never throws", () => {
    for (const s of ["", "   ", ".", "..SLDPRT", "\u0000"]) expect(typeof cleanNum(s)).toBe("string");
  });
});

describe("splitCsvLine / csvDelim", () => {
  it("honours quotes and escaped quotes", () => {
    expect(splitCsvLine('a,"b,c","d""e"', ",")).toEqual(["a", "b,c", 'd"e']);
  });
  it("tolerates an unterminated quote", () => {
    expect(splitCsvLine('a,"b', ",")).toEqual(["a", "b"]);
  });
  it("needs two delimiters to call it a table", () => {
    expect(csvDelim("a,b,c")).toBe(",");
    expect(csvDelim("a;b;c")).toBe(";");
    expect(csvDelim("a\tb\tc")).toBe("\t");
    expect(csvDelim("a,b")).toBe("");
  });
});

describe("parseSheetText", () => {
  it("reads a CSV with a header in any column order and keeps only SHEET rows", () => {
    const csv = ["Item,Part Number,Material,Qty.", '1,PN-0001.SLDPRT,"SHEET, AL 5052 .125",4', "2,PN-0002,TUBE 1x1,3", "3,PN-0003,SHEET .0598 STAINLESS 304,"].join("\n");
    const r = parseSheetText(csv);
    expect(r.rows).toEqual([
      { num: "PN-0001", qty: 4, mat: "al5052", thick: "0.125", text: "SHEET, AL 5052 .125" },
      { num: "PN-0003", qty: null, mat: "ss", thick: "0.0598", text: "SHEET .0598 STAINLESS 304" },
    ]);
    expect(r.skipped).toBe(1);
  });
  it("reads plain pasted lines and keeps a row whose quantity is unreadable", () => {
    const r = parseSheetText("1 PN-0001 4 SHEET .125 AL 5052\nPN-0002 SHEET .25 STEEL");
    expect(r.rows.map((x) => [x.num, x.qty, x.mat])).toEqual([
      ["PN-0001", 4, "al5052"],
      ["PN-0002", null, "cs"],
    ]);
  });
  it("never throws on empty, truncated or garbage input", () => {
    for (const s of ["", "\n\n", ",,,", '"', "SHEET", "Item,Qty,Material\n1,", "﻿", "a\tb\tc\td"]) {
      const r = parseSheetText(s);
      expect(Array.isArray(r.rows)).toBe(true);
    }
    expect(parseSheetText(undefined as unknown as string).rows).toEqual([]);
  });
});

describe("sumRepeatedRows", () => {
  it("adds repeats and keeps unknown only when all are unknown", () => {
    const row = (qty: number | null) => ({ num: "PN-1", qty, mat: "ss" as const, thick: "0.1", text: "" });
    expect(sumRepeatedRows([row(2), row(3), row(null)])[0].qty).toBe(5);
    expect(sumRepeatedRows([row(null), row(null)])[0].qty).toBeNull();
    expect(sumRepeatedRows([row(1), { ...row(1), thick: "0.2" }])).toHaveLength(2);
  });
});

describe("normName / parseBom", () => {
  it("normalises names", () => {
    expect(normName("  PN-0001  X.SLDPRT ")).toBe("pn-0001 x");
  });
  it("sums repeated numbers in a table and skips assemblies and headers", () => {
    const r = parseBom("Part\tQty.\nPN-0001.SLDPRT\t2\nPN-0002.SLDPRT\t1\nPN-0001.SLDPRT\t3\nTOP.SLDASM\t1");
    expect(r.map).toEqual({ "pn-0001": 5, "pn-0002": 1 });
    expect(r.order).toEqual(["pn-0001", "pn-0002"]);
  });
  it("reads free text with x-counts and trailing counts", () => {
    const r = parseBom("PN-0001 x3, PN-0002 2 PN-0003");
    expect(r.map).toEqual({ "pn-0001": 3, "pn-0002": 2, "pn-0003": 1 });
  });
  it("honours the line filter and never throws", () => {
    expect(parseBom("PN-0001 x2\nKEEP-0002", "keep").order).toEqual(["keep-0002"]);
    for (const s of ["", "\t\t", " x ", "5"]) expect(parseBom(s).order).toEqual([]);
    expect(parseBom(undefined as unknown as string).order).toEqual([]);
  });
});
