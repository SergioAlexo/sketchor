import { describe, expect, it } from "vitest";
import { fmtIn, formatLen, parseLen, parseNum, type LengthFormat } from "./units";

/**
 * RN-23: shop users type sheet sizes and kerf as fractions and feet-inches.
 * A misread `1 3/16` or `4' 6"` is a wrong sheet with no error, so these pin
 * the grammar and the parse(format(x)) round trip, and that garbage is NaN
 * rather than a throw or a silent zero.
 */
describe("parseNum", () => {
  it.each([
    ["12", 12],
    ["12,5", 12.5],
    ["3/16", 0.1875],
    ["1 3/16", 1.1875],
    ["1-3/16", 1.1875],
    ["  7 ", 7],
  ])("%s", (s, v) => expect(parseNum(s)).toBeCloseTo(v, 9));
  it.each(["", "-1", "a", "1/0", "1/2/3", "1 2", "3/", "/4", "1.5 1/2"])("rejects %j", (s) => expect(parseNum(s)).toBeNaN());
  it("tolerates non-strings", () => {
    expect(parseNum(null)).toBeNaN();
    expect(parseNum(undefined)).toBeNaN();
  });
});

describe("parseLen", () => {
  it("treats a bare number in the given unit", () => {
    expect(parseLen("25.4", "mm")).toBeCloseTo(1, 9);
    expect(parseLen("2", "ft")).toBe(24);
    expect(parseLen("1 3/16")).toBeCloseTo(1.1875, 9);
  });
  it("reads feet-inches in several spellings", () => {
    for (const s of [`4' 6 1/2"`, `4'-6 1/2`, `4' 6 1/2`, "4ft 6 1/2in"]) expect(parseLen(s)).toBeCloseTo(54.5, 9);
    expect(parseLen("4'")).toBe(48);
    expect(parseLen(`4'6"`)).toBe(54);
    expect(parseLen("4’ 6”")).toBe(54);
  });
  it("lets an explicit suffix override the unit", () => {
    expect(parseLen("25.4 mm", "in")).toBeCloseTo(1, 9);
    expect(parseLen("2.54cm", "mm")).toBeCloseTo(1, 9);
    expect(parseLen("0.0254 m")).toBeCloseTo(1, 9);
    expect(parseLen(`3/4"`, "mm")).toBeCloseTo(0.75, 9);
    expect(parseLen("1 ft", "mm")).toBe(12);
  });
  it("is NaN for garbage and never throws", () => {
    for (const s of ["", " ", "abc", "-5", `'`, `"`, "1/0", "mm", "4' x", `4'6"6"`, "\u0000"]) expect(parseLen(s)).toBeNaN();
    expect(parseLen(undefined)).toBeNaN();
  });
});

describe("formatLen", () => {
  it("formats fractions in lowest terms", () => {
    expect(fmtIn(1.1875)).toBe("1 3/16");
    expect(fmtIn(0.5)).toBe("1/2");
    expect(fmtIn(60)).toBe("60");
    expect(fmtIn(0.012)).toBe("0.012");
  });
  it("renders each mode", () => {
    expect(formatLen(1.1875, "in")).toBe('1 3/16"');
    expect(formatLen(0.125, "indec")).toBe('0.125"');
    expect(formatLen(54.5, "ftin")).toBe(`4' 6 1/2"`);
    expect(formatLen(48, "ftin")).toBe("4'");
    expect(formatLen(6, "ftin")).toBe('6"');
    expect(formatLen(1, "mm")).toBe("25.4 mm");
    expect(formatLen(1, "cm")).toBe("2.54 cm");
    expect(formatLen(1, "m")).toBe("0.025 m");
    expect(formatLen(1.5, "indec", true)).toBe('1,5"');
    expect(formatLen(NaN, "in")).toBe("");
  });
  it("parse(format(x)) returns x for the lossless modes", () => {
    for (const x of [0.03125, 0.5, 1.1875, 12, 54.5, 60, 143.96875]) {
      for (const mode of ["in", "indec", "ftin"] as LengthFormat[]) {
        if (mode === "indec" && Math.abs(x * 1000 - Math.round(x * 1000)) > 1e-9) continue;
        expect(parseLen(formatLen(x, mode))).toBeCloseTo(x, 3);
      }
    }
  });
});
