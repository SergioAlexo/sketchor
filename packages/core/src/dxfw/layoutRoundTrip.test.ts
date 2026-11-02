import { describe, expect, it } from "vitest";
import "../kinds/builtin";
import { parseDxf } from "../dxf";
import type { Entity, ViewportEntity } from "../entities";
import { newLayout, paperSpec, withSpace } from "../layouts/types";
import { newViewport } from "../layouts/viewport";
import { entitiesToDxf2018 } from "./index";

/**
 * Sheets must survive a save as DXF: which layouts exist and in what order, their paper, what is drawn on each, and
 * every viewport (window, scale, frozen layers, lock, clip). Paper entities must not leak into model space.
 */
const line = (id: string, x: number): Entity => ({ id, type: "line", a: { x, y: 0 }, b: { x: x + 10, y: 0 } });

function build(insUnits: number, scale: number) {
  const a = newLayout("Plan", paperSpec("A4", "landscape"));
  const b = { ...newLayout("Detail", paperSpec("A3", "portrait")), plotSettings: { scaleLineweights: false, plotStyle: "monochrome" as const, center: false, plotArea: "layout" as const } };
  const vp1: ViewportEntity = { ...newViewport({ x: 20, y: 30, w: 150, h: 100 }, { center: { x: 500, y: 250 }, scale: 0.02 }, { id: "vp1", space: "Plan" }), frozenLayers: ["WALLS"], locked: true, name: "VP1" };
  const vp2: ViewportEntity = { ...newViewport({ x: 10, y: 10, w: 100, h: 100 }, { center: { x: 0, y: 0 }, scale: 0.1 }, { id: "vp2", space: "Detail" }), clip: [{ x: 10, y: 10 }, { x: 110, y: 10 }, { x: 60, y: 110 }] };
  const model = [{ ...line("m1", 0), layer: "WALLS" } as Entity, line("m2", 100)];
  const text = entitiesToDxf2018(model, {
    insUnits,
    scale,
    layouts: [
      { layout: a, entities: [vp1, withSpace(line("p1", 5), "Plan")] },
      { layout: b, entities: [vp2, withSpace(line("p2", 7), "Detail")] },
    ],
  });
  return { text, parsed: parseDxf(text) };
}

describe("DXF layouts and viewports round trip", () => {
  for (const [label, units, scale] of [["mm", 4, 1], ["inch", 1, 1 / 25.4]] as const) {
    it(`restores layouts, paper entities and viewports (${label})`, () => {
      const { parsed } = build(units, scale);
      expect(parsed.layouts.map((l) => l.name)).toEqual(["Plan", "Detail"]);
      expect(parsed.layouts[0].paper).toMatchObject({ size: "A4", orientation: "landscape" });
      expect(parsed.layouts[1].paper).toMatchObject({ size: "A3", orientation: "portrait" });
      expect(parsed.layouts[1].plotSettings.plotStyle).toBe("monochrome");
      // Model space holds only the model.
      expect(parsed.entities.map((e) => e.id).sort()).toEqual(["m1", "m2"]);
      const byLayout = (n: string) => parsed.paperEntities.filter((e) => (e as { space?: string }).space === n);
      expect(byLayout("Plan").map((e) => e.type).sort()).toEqual(["line", "viewport"]);
      expect(byLayout("Detail").map((e) => e.type).sort()).toEqual(["line", "viewport"]);
      const vp = parsed.paperEntities.find((e) => e.id === "vp1") as ViewportEntity;
      expect(vp.center.x).toBeCloseTo(95, 3);
      expect(vp.scale).toBeCloseTo(0.02, 6);
      expect(vp.viewCenter.x).toBeCloseTo(500, 3);
      expect(vp).toMatchObject({ locked: true, frozenLayers: ["WALLS"], name: "VP1" });
      const vp2 = parsed.paperEntities.find((e) => e.id === "vp2") as ViewportEntity;
      expect(vp2.clip).toHaveLength(3);
      // The clip polyline is the window, not a second drawing entity.
      expect(byLayout("Detail").filter((e) => e.type === "polyline")).toHaveLength(0);
    });
  }

  it("writes the structure other CAD expects", () => {
    const { text } = build(4, 1);
    expect(text).toContain("*Paper_Space0");
    expect((text.match(/\n0\nLAYOUT\n/g) ?? []).length).toBe(3); // Model + two sheets
    expect((text.match(/\n0\nVIEWPORT\n/g) ?? []).length).toBe(4); // overall + ours, per sheet
    expect(text).toMatch(/\n67\n1\n/);
  });

  it("a file with paper-space entities and no LAYOUT objects gets one layout", () => {
    const dxf = "0\nSECTION\n2\nENTITIES\n0\nLINE\n8\n0\n10\n0\n20\n0\n11\n5\n21\n0\n0\nLINE\n67\n1\n8\n0\n10\n0\n20\n0\n11\n9\n21\n0\n0\nENDSEC\n0\nEOF\n";
    const p = parseDxf(dxf);
    expect(p.entities).toHaveLength(1);
    expect(p.layouts).toHaveLength(1);
    expect(p.paperEntities).toHaveLength(1);
  });

  it("returns no layouts for a model-only file", () => {
    const p = parseDxf(entitiesToDxf2018([line("a", 0)]));
    expect(p.layouts).toEqual([]);
    expect(p.paperEntities).toEqual([]);
  });
});
