/**
 * The embed's motion is all springs: if one overshoots, the turntable jerks
 * past its stop when paused; if a long frame blows it up, a tab that comes
 * back from the background flings the part off screen.
 */
import { describe, expect, it } from "vitest";
import { atRest, spring, stepSpring } from "./motion";

describe("critically damped spring", () => {
  it("reaches its target without overshooting", () => {
    const s = spring(0, 64);
    s.target = 1;
    let max = 0;
    for (let i = 0; i < 240; i++) {
      stepSpring(s, 1 / 60);
      max = Math.max(max, s.x);
    }
    expect(s.x).toBeCloseTo(1, 3);
    expect(max).toBeLessThanOrEqual(1 + 1e-3);
    expect(atRest(s, 1e-3)).toBe(true);
  });

  it("settles in well under a second at the default stiffness (the play ramp)", () => {
    const s = spring(0, 64);
    s.target = 1;
    for (let i = 0; i < 48; i++) stepSpring(s, 1 / 60); // 0.8 s
    expect(s.x).toBeGreaterThan(0.95);
  });

  it("stays stable and finite after a huge dt (tab returning from the background)", () => {
    const s = spring(0, 400);
    s.target = 10;
    stepSpring(s, 30);
    expect(Number.isFinite(s.x)).toBe(true);
    expect(Math.abs(s.x)).toBeLessThan(20);
  });

  it("ignores negative dt", () => {
    const s = spring(0.5);
    s.target = 1;
    stepSpring(s, -1);
    expect(s.x).toBe(0.5);
  });
});
