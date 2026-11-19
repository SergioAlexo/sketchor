import { describe, expect, it } from "vitest";
import { shouldLoadDemo } from "./policy";

describe("shouldLoadDemo", () => {
  it("loads on a first web open only", () => {
    expect(shouldLoadDemo("", false, false, true)).toBe(true);
    expect(shouldLoadDemo("", true, false, true)).toBe(false);
    expect(shouldLoadDemo("", false, true, true)).toBe(false);
    expect(shouldLoadDemo("", false, false, false)).toBe(false);
  });
  it("?demo forces and ?blank skips", () => {
    expect(shouldLoadDemo("?demo", true, true, true)).toBe(true);
    expect(shouldLoadDemo("?blank", false, false, true)).toBe(false);
    expect(shouldLoadDemo("?demo&blank", false, false, true)).toBe(false);
    // E-06: a file arriving via ?open= must not land behind the showcase.
    expect(shouldLoadDemo("?open=https%3A%2F%2Fx.com%2Fa.glb", false, false, true)).toBe(false);
  });
});
