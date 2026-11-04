import { describe, expect, it } from "vitest";
import { getSimplifyOnImport, getSimplifyTolerance, parseSimplifyTolerance, setSimplifyOnImport, setSimplifyTolerance, SIMPLIFY_DEFAULT_MM } from "./simplifySettings";

/**
 * P-03b: the tolerance is typed by the user (command line, banner field), so
 * garbage must never reach the simplifier - a 0 or NaN tolerance would
 * either do nothing silently or flatten a part. Also pins that the node
 * test environment (no localStorage) falls back to memory instead of throwing.
 */
describe("parseSimplifyTolerance", () => {
  it("accepts plain numbers, a decimal comma and an mm suffix", () => {
    expect(parseSimplifyTolerance("0.5")).toBe(0.5);
    expect(parseSimplifyTolerance(" 0,25 mm ")).toBe(0.25);
    expect(parseSimplifyTolerance(".05")).toBe(0.05);
  });
  it("rejects empty, zero, negative, huge and non-numeric input", () => {
    for (const bad of ["", "0", "-1", "abc", "1e3", "51", "1..2", "NaN", "Infinity"]) expect(parseSimplifyTolerance(bad)).toBeNull();
  });
});

describe("settings storage", () => {
  it("defaults, round-trips and refuses invalid values without storage", () => {
    expect(getSimplifyTolerance()).toBe(SIMPLIFY_DEFAULT_MM);
    expect(setSimplifyTolerance(0)).toBe(false);
    expect(setSimplifyTolerance(NaN)).toBe(false);
    expect(getSimplifyTolerance()).toBe(SIMPLIFY_DEFAULT_MM);
    expect(setSimplifyTolerance(0.4)).toBe(true);
    expect(getSimplifyTolerance()).toBe(0.4);
    expect(getSimplifyOnImport()).toBe(false);
    setSimplifyOnImport(true);
    expect(getSimplifyOnImport()).toBe(true);
  });
});
