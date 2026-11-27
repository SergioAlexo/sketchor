import { describe, expect, it } from "vitest";
import { drawReveal, easeInOut, floatPose, FLOAT_ROTATE, FLOAT_TRANSLATE, FLOAT_ZOOM, tiltTransform } from "./motion2d";

describe("floatPose", () => {
  it("is exactly the fitted view at zero intensity", () => {
    for (const t of [0, 3.7, 120]) expect(floatPose(t, 0)).toEqual({ dx: 0, dy: 0, rot: 0, zoom: 1 });
  });
  it("stays inside the stated amplitudes and uses them", () => {
    let maxDx = 0, maxRot = 0, maxZoom = 0;
    for (let t = 0; t < 120; t += 0.05) {
      const p = floatPose(t, 1);
      maxDx = Math.max(maxDx, Math.abs(p.dx), Math.abs(p.dy));
      maxRot = Math.max(maxRot, Math.abs(p.rot));
      maxZoom = Math.max(maxZoom, Math.abs(p.zoom - 1));
    }
    expect(maxDx).toBeLessThanOrEqual(FLOAT_TRANSLATE + 1e-12);
    expect(maxDx).toBeGreaterThan(FLOAT_TRANSLATE * 0.95);
    expect(maxRot).toBeLessThanOrEqual(FLOAT_ROTATE + 1e-12);
    expect(maxZoom).toBeLessThanOrEqual(FLOAT_ZOOM + 1e-12);
  });
  it("clamps intensity and moves smoothly frame to frame", () => {
    expect(floatPose(5, 3)).toEqual(floatPose(5, 1));
    const a = floatPose(10, 1);
    const b = floatPose(10 + 1 / 60, 1);
    expect(Math.abs(a.dx - b.dx)).toBeLessThan(1e-4);
    expect(Math.abs(a.rot - b.rot)).toBeLessThan(1e-4);
  });
  it("does not repeat itself within a minute", () => {
    const a = floatPose(0, 1);
    for (let t = 5; t < 60; t += 0.25) {
      const b = floatPose(t, 1);
      const same = Math.abs(a.dx - b.dx) < 1e-4 && Math.abs(a.dy - b.dy) < 1e-4 && Math.abs(a.rot - b.rot) < 1e-5;
      expect(same).toBe(false);
    }
  });
});

describe("drawReveal", () => {
  it("starts empty, eases, and ends with everything shown", () => {
    expect(drawReveal(0, 100)).toEqual({ shown: 0, partial: 0, done: false });
    const mid = drawReveal(1.25, 100);
    expect(mid.shown).toBe(50);
    expect(drawReveal(0.25, 100).shown).toBeLessThan(10); // eased in: slow start
    expect(drawReveal(2.5, 100)).toEqual({ shown: 100, partial: 0, done: true });
    expect(drawReveal(99, 100).done).toBe(true);
  });
  it("never goes backwards", () => {
    let last = -1;
    for (let t = 0; t <= 2.6; t += 0.01) {
      const r = drawReveal(t, 37);
      const v = r.shown + r.partial;
      expect(v).toBeGreaterThanOrEqual(last - 1e-9);
      last = v;
    }
  });
  it("handles an empty drawing", () => {
    expect(drawReveal(0, 0).done).toBe(true);
  });
  it("eases in and out", () => {
    expect(easeInOut(0)).toBe(0);
    expect(easeInOut(1)).toBe(1);
    expect(easeInOut(0.5)).toBe(0.5);
    expect(easeInOut(-1)).toBe(0);
  });
});

describe("tiltTransform", () => {
  it("leans toward the pointer by at most 6°", () => {
    expect(tiltTransform(0, 0)).toBe("perspective(900px) rotateX(0.000deg) rotateY(0.000deg)");
    expect(tiltTransform(1, -1)).toBe("perspective(900px) rotateX(6.000deg) rotateY(6.000deg)");
  });
});
