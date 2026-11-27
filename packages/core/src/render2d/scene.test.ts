import { describe, expect, it } from "vitest";
import type { Entity } from "../entities";
import { drawFitted } from "./index";

/** A 2D context that records the points of every path call and ignores the rest. */
function recordingCtx() {
  const pts: { x: number; y: number }[] = [];
  const target: Record<string, unknown> = {};
  const ctx = new Proxy(target, {
    get(t, k) {
      if (k in t) return t[k as string];
      if (k === "moveTo" || k === "lineTo") return (x: number, y: number) => pts.push({ x, y });
      if (k === "arc") return (x: number, y: number, r: number) => (pts.push({ x: x - r, y: y - r }), pts.push({ x: x + r, y: y + r }));
      if (k === "measureText") return () => ({ width: 0 });
      if (k === "getLineDash") return () => [];
      if (k === "getTransform") return () => ({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 });
      return () => {};
    },
    set(t, k, v) {
      t[k as string] = v;
      return true;
    },
  });
  return { ctx: ctx as unknown as CanvasRenderingContext2D, pts };
}

const env = { ink: "#fff", bg: "#000" };

describe("drawFitted", () => {
  it("fills the frame, padded and centred, whatever the drawing's size", () => {
    for (const k of [1e-3, 1, 1e7]) {
      const { ctx, pts } = recordingCtx();
      const es: Entity[] = [{ id: "l", type: "line", a: { x: 0, y: 0 }, b: { x: 200 * k, y: 100 * k } }];
      const view = drawFitted(ctx, es, { width: 100, height: 100, env, padding: 0.1 });
      expect(view).not.toBeNull();
      const xs = pts.map((p) => p.x);
      const ys = pts.map((p) => p.y);
      expect(Math.min(...xs)).toBeCloseTo(10, 6);
      expect(Math.max(...xs)).toBeCloseTo(90, 6);
      expect(Math.min(...ys)).toBeCloseTo(30, 6); // 2:1 drawing, centred vertically
      expect(Math.max(...ys)).toBeCloseTo(70, 6);
    }
  });

  it("flips Y (world up, canvas down)", () => {
    const { ctx, pts } = recordingCtx();
    drawFitted(ctx, [{ id: "l", type: "line", a: { x: 0, y: 0 }, b: { x: 0, y: 10 } }], { width: 50, height: 50, env });
    expect(pts[0].y).toBeGreaterThan(pts[1].y);
  });

  it("draws nothing and returns null for a drawing without extent", () => {
    const { ctx, pts } = recordingCtx();
    expect(drawFitted(ctx, [], { width: 50, height: 50, env })).toBeNull();
    expect(pts).toEqual([]);
  });
});
