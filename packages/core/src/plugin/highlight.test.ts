import { describe, expect, it } from "vitest";
import { MAX_HIGHLIGHT_LABEL, MAX_HIGHLIGHT_MARKS, MAX_HIGHLIGHT_OUTLINE_POINTS, MAX_HIGHLIGHT_TOTAL_POINTS, sanitizeHighlightMarks } from "./highlight";

/**
 * `ui.highlight` hands the host whatever a plugin sends; the renderer then
 * draws it every frame. A NaN that reaches the canvas, a million markers, or a
 * label that smuggles control characters into the drawing surface is the
 * plugin's bug becoming the app's — so the host keeps only what it can draw.
 */

describe("sanitizeHighlightMarks", () => {
  it("keeps well-formed marks, with or without a label", () => {
    expect(sanitizeHighlightMarks([{ at: { x: 1, y: 2 }, label: "gap 0.2 mm" }, { at: { x: -3, y: 4 } }])).toEqual([
      { at: { x: 1, y: 2 }, label: "gap 0.2 mm" },
      { at: { x: -3, y: 4 } },
    ]);
  });

  it("treats anything but an array as 'clear'", () => {
    for (const v of [null, undefined, "x", 3, { at: { x: 0, y: 0 } }]) expect(sanitizeHighlightMarks(v)).toEqual([]);
  });

  it("drops marks without a finite, sane point", () => {
    const bad = [null, 7, {}, { at: null }, { at: { x: "1", y: 2 } }, { at: { x: Number.NaN, y: 0 } }, { at: { x: 0, y: Number.POSITIVE_INFINITY } }, { at: { x: 2e9, y: 0 } }];
    expect(sanitizeHighlightMarks([...bad, { at: { x: 5, y: 5 } }])).toEqual([{ at: { x: 5, y: 5 } }]);
  });

  it("keeps only plain-string labels, stripped of control characters and capped", () => {
    const [a, b, c] = sanitizeHighlightMarks([
      { at: { x: 0, y: 0 }, label: "  gap\n0.2\u0007 mm  " },
      { at: { x: 0, y: 0 }, label: { toString: () => "sneaky" } },
      { at: { x: 0, y: 0 }, label: "x".repeat(200) },
    ]);
    expect(a.label).toBe("gap 0.2  mm");
    expect(b).toEqual({ at: { x: 0, y: 0 } });
    expect(c.label).toHaveLength(MAX_HIGHLIGHT_LABEL);
  });

  it("never keeps more than the cap", () => {
    const many = Array.from({ length: MAX_HIGHLIGHT_MARKS + 50 }, (_, i) => ({ at: { x: i, y: 0 } }));
    expect(sanitizeHighlightMarks(many)).toHaveLength(MAX_HIGHLIGHT_MARKS);
  });

  it("keeps an outline's finite points and a known tone", () => {
    const [m] = sanitizeHighlightMarks([{ at: { x: 0, y: 0 }, outline: [{ x: 0, y: 0 }, { x: Number.NaN, y: 1 }, { x: 10, y: 0 }, { x: 10, y: 10 }, "x"], tone: "warn" }]);
    expect(m).toEqual({ at: { x: 0, y: 0 }, outline: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }], tone: "warn" });
    const [n] = sanitizeHighlightMarks([{ at: { x: 0, y: 0 }, outline: [{ x: 0, y: 0 }, { x: 1, y: 1 }], tone: "purple" }]);
    expect(n).toEqual({ at: { x: 0, y: 0 } });
  });

  it("caps outline points per mark and across the call", () => {
    const big = Array.from({ length: MAX_HIGHLIGHT_OUTLINE_POINTS + 10 }, (_, i) => ({ x: i, y: i % 2 }));
    const [m] = sanitizeHighlightMarks([{ at: { x: 0, y: 0 }, outline: big }]);
    expect(m.outline).toHaveLength(MAX_HIGHLIGHT_OUTLINE_POINTS);
    const many = Array.from({ length: Math.ceil(MAX_HIGHLIGHT_TOTAL_POINTS / MAX_HIGHLIGHT_OUTLINE_POINTS) + 3 }, () => ({ at: { x: 0, y: 0 }, outline: big }));
    const total = sanitizeHighlightMarks(many).reduce((n, x) => n + (x.outline?.length ?? 0), 0);
    expect(total).toBeLessThanOrEqual(MAX_HIGHLIGHT_TOTAL_POINTS);
  });
});
