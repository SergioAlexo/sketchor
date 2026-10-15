import { describe, expect, it } from "vitest";
import { modeDefaults } from "./drawingMode";

describe("K-03 modeDefaults", () => {
  it("sketch turns auto-constraints and driving dims on", () => {
    expect(modeDefaults("sketch")).toEqual({ autoConstrain: true, drivingDims: true });
  });
  it("drafting turns both off", () => {
    expect(modeDefaults("drafting")).toEqual({ autoConstrain: false, drivingDims: false });
  });
});
