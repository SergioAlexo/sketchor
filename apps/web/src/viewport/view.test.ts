import { expect, it } from "vitest";
import { wheelZoomFactor } from "./view";

it("combines small smooth wheel events into the same zoom as their total distance", () => {
  expect(wheelZoomFactor(-1, 0, 800)).toBeLessThan(1.001);
  expect(wheelZoomFactor(-5, 0, 800) ** 20).toBeCloseTo(wheelZoomFactor(-100, 0, 800));
  expect(wheelZoomFactor(-100, 0, 800)).toBeCloseTo(1.1);
});

it("accounts for wheel delta units and limits very large events", () => {
  expect(wheelZoomFactor(3, 1, 800)).toBe(wheelZoomFactor(48, 0, 800));
  expect(wheelZoomFactor(-1, 2, 200)).toBe(wheelZoomFactor(-200, 0, 800));
  expect(wheelZoomFactor(-10_000, 0, 800)).toBe(wheelZoomFactor(-400, 0, 800));
  expect(wheelZoomFactor(0, 0, 800)).toBe(1);
});
