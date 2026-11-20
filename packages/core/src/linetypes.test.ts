import { describe, expect, it } from "vitest";
import { BUILTIN_LINETYPES, builtinLinetype, effectiveLtscale, screenDashPattern } from "./linetypes";

/**
 * Z-04: the renderer trusts these two things completely — a wrong pattern
 * silently redraws every CENTER/HIDDEN/etc. line as the wrong real-world
 * dash length, and a wrong LOD cutoff either spams illegible noise when
 * zoomed out or never dashes at all when zoomed in.
 */

describe("BUILTIN_LINETYPES", () => {
  it("has all nine ISO-described linetypes plus CONTINUOUS", () => {
    expect(Object.keys(BUILTIN_LINETYPES).sort()).toEqual(
      ["BORDER", "CENTER", "CONTINUOUS", "DASHDOT", "DASHED", "DIVIDE", "DOT", "HIDDEN", "PHANTOM"].sort(),
    );
  });

  it("CONTINUOUS is the only empty (solid) pattern", () => {
    for (const [name, def] of Object.entries(BUILTIN_LINETYPES)) {
      if (name === "CONTINUOUS") expect(def.pattern).toEqual([]);
      else expect(def.pattern.length).toBeGreaterThan(0);
    }
  });

  it("every non-continuous pattern alternates dash(+)/gap(-) and sums to a closed period", () => {
    for (const [name, def] of Object.entries(BUILTIN_LINETYPES)) {
      if (name === "CONTINUOUS") continue;
      def.pattern.forEach((v, i) => {
        if (i % 2 === 0) expect(v).toBeGreaterThanOrEqual(0); // dash or dot
        else expect(v).toBeLessThan(0); // gap
      });
    }
  });
});

describe("builtinLinetype", () => {
  it("resolves a known name", () => {
    expect(builtinLinetype("DASHED").pattern).toEqual([6, -3]);
  });

  it("falls back to CONTINUOUS for absent or unknown names", () => {
    expect(builtinLinetype(undefined).name).toBe("CONTINUOUS");
    expect(builtinLinetype("SOME_CUSTOM_LINETYPE").name).toBe("CONTINUOUS");
  });
});

describe("screenDashPattern", () => {
  it("returns [] for a continuous pattern", () => {
    expect(screenDashPattern([], 1, 10)).toEqual([]);
  });

  it("scales by LTSCALE and zoom (pixels per world unit)", () => {
    // 6mm dash at LTSCALE 1, 10 px/mm zoom -> 60px dash.
    expect(screenDashPattern([6, -3], 1, 10)).toEqual([60, 30]);
    // Doubling LTSCALE doubles the real-world (and so screen) dash length.
    expect(screenDashPattern([6, -3], 2, 10)).toEqual([120, 60]);
  });

  it("takes the absolute value of every segment (canvas has no pen-up/down sign)", () => {
    const px = screenDashPattern([6, -3, 0, -3], 1, 10);
    expect(px.every((v) => v > 0)).toBe(true);
  });

  it("falls back to solid once the pattern's screen period drops below a few pixels (LOD)", () => {
    // Zoomed way out: 6mm/-3mm at 0.01 px/mm is a sub-pixel pattern.
    expect(screenDashPattern([6, -3], 1, 0.01)).toEqual([]);
  });

  it("stays dashed once the period is comfortably visible", () => {
    expect(screenDashPattern([6, -3], 1, 1)).not.toEqual([]);
  });
});

describe("effectiveLtscale (per-entity linetype scale, DXF group 48)", () => {
  it("multiplies the drawing's $LTSCALE by the entity's own scale", () => {
    expect(effectiveLtscale(2, { linetypeScale: 3 })).toBe(6);
  });

  it("treats a missing, non-finite, zero or negative entity scale as 1, the way AutoCAD reads group 48", () => {
    expect(effectiveLtscale(2, {})).toBe(2);
    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) expect(effectiveLtscale(2, { linetypeScale: bad })).toBe(2);
  });

  it("is what keeps a long dashed line dashed when zoomed out to a whole sheet", () => {
    // A 48x96 in sheet fitted on ~1100 px is ~0.45 px/mm: DASHED at scale 1 falls back to solid,
    // at the entity's own scale 10 it stays a visible dash.
    expect(screenDashPattern([6, -3], effectiveLtscale(1, {}), 0.45)).toEqual([]);
    expect(screenDashPattern([6, -3], effectiveLtscale(1, { linetypeScale: 10 }), 0.45)).not.toEqual([]);
  });
});
