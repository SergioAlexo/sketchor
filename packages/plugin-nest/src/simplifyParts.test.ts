/**
 * NF-05: the nester searches on simplified outlines but the output uses the
 * originals. If the translation correction is wrong, every curved part lands
 * a fraction of a millimetre off and parts overlap by it; if simplification
 * is not conservative about spacing, the requested kerf gap is silently lost.
 */
import { describe, expect, it } from "vitest";
import { bounds, rotate, segmentDistance, translate } from "./geometry";
import { simplifyParts } from "./simplifyParts";
import { nestTrueShape, placementTransform, type TrueNestPart } from "./trueNest";
import type { Point } from "./types";

/** A disc of `n` vertices - a flattened circle, as partExtraction produces. */
const disc = (r: number, n: number): Point[] =>
  Array.from({ length: n }, (_, i) => ({ x: r + r * Math.cos((i / n) * 2 * Math.PI), y: r + r * Math.sin((i / n) * 2 * Math.PI) }));
const rect = (w: number, h: number): Point[] => [{ x: 0, y: 0 }, { x: w, y: 0 }, { x: w, y: h }, { x: 0, y: h }];
const part = (id: string, outer: Point[], quantity = 1, holes: Point[][] = []): TrueNestPart => ({
  id,
  name: id,
  outer,
  holes,
  quantity,
  rotation: { mode: "free" } as never,
});

const place = (outer: Point[], pl: { rotationDeg: number; mirrored: boolean; translation: Point }): Point[] => {
  const t = placementTransform(outer, pl);
  return translate(rotate(outer, t.rotationDeg), t.translation.x, t.translation.y);
};

describe("simplifyParts", () => {
  it("removes redundant vertices, keeps rectangles untouched", () => {
    const { parts, changed } = simplifyParts([part("c", disc(50, 360)), part("r", rect(10, 5))]);
    expect(changed).toBe(true);
    expect(parts[0]!.outer.length).toBeLessThan(360);
    expect(parts[0]!.outer.length).toBeGreaterThanOrEqual(8);
    expect(parts[1]!.outer).toEqual(rect(10, 5));
  });

  it("returns the same objects when nothing simplifies, and treats tol 0 as off", () => {
    const input = [part("r", rect(10, 5))];
    const out = simplifyParts(input);
    expect(out.changed).toBe(false);
    expect(out.parts).toBe(input);
    expect(simplifyParts([part("c", disc(50, 360))], 0).changed).toBe(false);
  });

  it("every original vertex stays within the tolerance of the simplified outline", () => {
    const tol = 0.05;
    const orig = disc(40, 300);
    const s = simplifyParts([part("c", orig)], tol).parts[0]!.outer;
    for (const p of orig) {
      let m = Infinity;
      for (let j = 0; j < s.length; j++) m = Math.min(m, segmentDistance(p, p, s[j]!, s[(j + 1) % s.length]!));
      expect(m).toBeLessThanOrEqual(tol + 1e-9);
    }
  });

  it("restorePlacements puts the original outline exactly where the simplified one was found", () => {
    const orig = disc(30, 200);
    const s = simplifyParts([part("c", orig)]);
    const pl = { partId: "c", sheet: 0, rotationDeg: 37, mirrored: false, translation: { x: 100, y: 60 } };
    const restored = s.restorePlacements([pl])[0]!;
    const simp = s.parts[0]!.outer;
    // A vertex kept in both outlines must land on the same sheet point.
    const kept = simp[0]!;
    const k = orig.findIndex((p) => p.x === kept.x && p.y === kept.y);
    expect(k).toBeGreaterThanOrEqual(0);
    const a = place(simp, pl)[0]!;
    const b = place(orig, restored)[k]!;
    expect(b.x).toBeCloseTo(a.x, 9);
    expect(b.y).toBeCloseTo(a.y, 9);
  });

  it("a full nest on simplified discs keeps the requested gap on the original outlines", () => {
    const parts = [part("d", disc(20, 240), 6)];
    const gap = 2;
    const s = simplifyParts(parts);
    const r = nestTrueShape(s.parts, [{ size: { name: "S", width: 200, height: 120 }, qty: null }], { spacing: gap + 0.1, edgeMargin: 5.05 });
    expect(r.placed.length).toBe(6);
    const placed = s.restorePlacements(r.placed);
    const polys = placed.map((pl) => place(parts[0]!.outer, pl));
    for (let i = 0; i < polys.length; i++) {
      for (let j = i + 1; j < polys.length; j++) {
        if (placed[i]!.sheet !== placed[j]!.sheet) continue;
        let m = Infinity;
        for (let a = 0; a < polys[i]!.length; a++) {
          for (let b = 0; b < polys[j]!.length; b++) {
            m = Math.min(m, segmentDistance(polys[i]![a]!, polys[i]![(a + 1) % polys[i]!.length]!, polys[j]![b]!, polys[j]![(b + 1) % polys[j]!.length]!));
          }
        }
        expect(m).toBeGreaterThanOrEqual(gap - 1e-6);
      }
      expect(bounds(polys[i]!).minX).toBeGreaterThanOrEqual(5 - 1e-6);
    }
  });
});
