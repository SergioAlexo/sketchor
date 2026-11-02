import { describe, expect, it } from "vitest";
import { newLayout, paperSpec } from "@sketchor/core";
import { printableRect, sheetRect } from "./sheetRender";

/** The dashed printable area is what the user lays the drawing out inside: margins in inches must not be read as mm. */
describe("sheet geometry", () => {
  it("the sheet starts at the origin and has the paper's size in mm", () => {
    expect(sheetRect(newLayout("L", paperSpec("A4", "landscape")))).toEqual({ x: 0, y: 0, w: 297, h: 210 });
  });
  it("the printable area is the sheet minus the margins", () => {
    const l = { ...newLayout("L", paperSpec("A4", "landscape")), margins: { left: 10, right: 5, top: 7, bottom: 3 } };
    expect(printableRect(l)).toEqual({ x: 10, y: 3, w: 282, h: 200 });
  });
  it("inch sheets convert paper and margins to mm together", () => {
    const l = newLayout("L", paperSpec("Custom", "landscape", { w: 10, h: 8, units: "in" }));
    l.margins = { left: 1, right: 1, top: 1, bottom: 1 };
    expect(sheetRect(l)).toMatchObject({ w: 254, h: 203.2 });
    expect(printableRect(l)).toMatchObject({ x: 25.4, w: 203.2 });
  });
});

import { viewportScreenView, paperViewFromModelView, viewportFromModelView } from "./sheetRender";
import { modelToPaper, newViewport } from "@sketchor/core";
import { worldToScreen } from "./view";

describe("model through a viewport", () => {
  const vp = newViewport({ x: 20, y: 30, w: 100, h: 80 }, { center: { x: 500, y: -200 }, scale: 0.02 });
  const paper = { scale: 3.5, ox: 40, oy: 700 };
  it("draws a model point where the paper view draws its paper image", () => {
    const mv = viewportScreenView(paper, vp);
    for (const m of [{ x: 0, y: 0 }, { x: 500, y: -200 }, { x: 1234, y: 77 }]) {
      const a = worldToScreen(mv, m);
      const b = worldToScreen(paper, modelToPaper(vp, m));
      expect(a.x).toBeCloseTo(b.x, 9);
      expect(a.y).toBeCloseTo(b.y, 9);
    }
  });
  it("a model view change becomes viewport scale/centre with the sheet fixed", () => {
    const model = viewportScreenView(paper, vp);
    const zoomed = { scale: model.scale * 2, ox: model.ox - 50, oy: model.oy + 30 };
    const vp2 = viewportFromModelView(paper, zoomed, vp);
    expect(vp2.scale).toBeCloseTo(vp.scale * 2, 12);
    const back = viewportScreenView(paper, vp2);
    expect(back.scale).toBeCloseTo(zoomed.scale, 9);
    expect(back.ox).toBeCloseTo(zoomed.ox, 9);
    expect(back.oy).toBeCloseTo(zoomed.oy, 9);
  });
  it("inverts: model view -> paper view", () => {
    const back = paperViewFromModelView(viewportScreenView(paper, vp), vp);
    expect(back.scale).toBeCloseTo(paper.scale, 9);
    expect(back.ox).toBeCloseTo(paper.ox, 9);
    expect(back.oy).toBeCloseTo(paper.oy, 9);
  });
});
