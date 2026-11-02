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
