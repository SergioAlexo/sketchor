import { describe, expect, it } from "vitest";
import { CommandBus } from "../commands";
import { SketchDocument } from "../document";
import { entitiesToDxf } from "../dxfExport";
import { rotated, transformed, translated, type ViewportEntity } from "../entities";
import { boundsOf } from "../dxf";
import "../kinds/builtin";
import { kindBounds, kindHitDistance, kindTessellate, kindTransform } from "../kinds/registry";
import { diffToCommands, parseCode, toCode } from "../sketchtext";
import { newLayout } from "./types";
import {
  fitViewportView,
  modelToPaper,
  newViewport,
  niceScaleBelow,
  paperToModel,
  panViewport,
  parseScale,
  pointInViewport,
  scaleLabel,
  setViewportScale,
  standardScaleName,
  viewportFromPolygon,
  viewportModelWindow,
  viewportPreset,
  zoomViewport,
} from "./viewport";

/**
 * A viewport is the one place model geometry meets the sheet. What breaks if
 * this regresses: a window that shows the wrong part of the model, a scale that
 * drifts (1:50 stops meaning 1:50 on paper), or a viewport that loses its
 * layout / frozen layers when the user edits sketch code or moves it.
 */
const vp = (): ViewportEntity => ({
  ...newViewport({ x: 10, y: 20, w: 100, h: 60 }, { center: { x: 500, y: 300 }, scale: 0.02 }, { id: "v1", space: "A" }),
  name: "VP1",
  layer: "VIEWPORTS",
  color: "#f00",
});

describe("viewport geometry", () => {
  it("maps model <-> paper through the centre and scale", () => {
    const v = vp();
    expect(modelToPaper(v, { x: 500, y: 300 })).toEqual(v.center);
    const p = modelToPaper(v, { x: 600, y: 400 });
    expect(p.x).toBeCloseTo(v.center.x + 2);
    expect(paperToModel(v, p).x).toBeCloseTo(600);
    expect(paperToModel(v, p).y).toBeCloseTo(400);
  });

  it("the model window is the window size divided by the scale", () => {
    const w = viewportModelWindow(vp());
    expect(w.maxX - w.minX).toBeCloseTo(100 / 0.02);
    expect(w.maxY - w.minY).toBeCloseTo(60 / 0.02);
  });

  it("zoom keeps the model point under the cursor; locked refuses pan, zoom and scale", () => {
    const v = vp();
    const about = { x: v.center.x + 20, y: v.center.y - 10 };
    const before = paperToModel(v, about);
    const z = zoomViewport(v, about, 2);
    expect(z.scale).toBeCloseTo(0.04);
    expect(paperToModel(z, about).x).toBeCloseTo(before.x);
    expect(paperToModel(z, about).y).toBeCloseTo(before.y);
    const locked = { ...v, locked: true };
    expect(zoomViewport(locked, about, 2)).toBe(locked);
    expect(panViewport(locked, 5, 5)).toBe(locked);
    expect(setViewportScale(locked, 1)).toBe(locked);
    expect(panViewport(v, 2, 0).viewCenter.x).toBeCloseTo(500 - 100);
  });

  it("a polygon window clips; the hit area is the polygon", () => {
    const tri = viewportFromPolygon([{ x: 0, y: 0 }, { x: 40, y: 0 }, { x: 0, y: 40 }], { center: { x: 0, y: 0 }, scale: 1 });
    expect(pointInViewport(tri, { x: 5, y: 5 })).toBe(true);
    expect(pointInViewport(tri, { x: 35, y: 35 })).toBe(false);
    expect(tri.width).toBe(40);
  });

  it("scales parse, print and snap to standard names", () => {
    expect(parseScale("1:50")).toBeCloseTo(0.02);
    expect(parseScale("2:1")).toBe(2);
    expect(parseScale("nonsense")).toBeNull();
    expect(parseScale("0:5")).toBeNull();
    expect(scaleLabel(0.02)).toBe("1:50");
    expect(scaleLabel(4)).toBe("4:1");
    expect(standardScaleName(0.02)).toBe("1:50");
    expect(standardScaleName(0.0213)).toBeNull();
    expect(niceScaleBelow(0.03)).toBeCloseTo(0.02); // largest standard scale not above 1:33 is 1:50 (1:25 would be too big)
  });

  it("fit picks the largest standard scale that holds the model", () => {
    const f = fitViewportView(200, 100, { minX: 0, minY: 0, maxX: 1000, maxY: 400 });
    expect(f.center).toEqual({ x: 500, y: 200 });
    expect(f.scale * 1000).toBeLessThanOrEqual(200 * 0.9 + 1e-9);
    expect(f.scale).toBeCloseTo(parseScale(standardScaleName(f.scale)!)!);
    expect(fitViewportView(10, 10, null).scale).toBe(1);
  });

  it("presets tile the area without overlap and share one scale", () => {
    for (const n of [1, 2, 3, 4] as const) {
      const vs = viewportPreset(n, { x: 0, y: 0, w: 400, h: 300 }, { minX: 0, minY: 0, maxX: 2000, maxY: 1000 }, { space: "A" });
      expect(vs).toHaveLength(n);
      for (const a of vs) for (const b of vs) {
        if (a === b) continue;
        const ox = Math.min(a.center.x + a.width / 2, b.center.x + b.width / 2) - Math.max(a.center.x - a.width / 2, b.center.x - b.width / 2);
        const oy = Math.min(a.center.y + a.height / 2, b.center.y + b.height / 2) - Math.max(a.center.y - a.height / 2, b.center.y - b.height / 2);
        expect(ox > 1e-9 && oy > 1e-9).toBe(false);
      }
      expect(vs.every((v) => v.space === "A")).toBe(true);
    }
  });
});

describe("viewport kind (new-entity checklist)", () => {
  it("tessellates its border and bounds contain it", () => {
    const v = vp();
    const run = kindTessellate(v, 0.1)[0];
    expect(run).toHaveLength(5);
    expect(run[0]).toEqual(run[4]);
    expect(kindBounds(v)).toEqual({ minX: 10, minY: 20, maxX: 110, maxY: 80 });
    expect(boundsOf([v])).toEqual({ minX: 10, minY: 20, maxX: 110, maxY: 80 });
  });

  it("hit distance is to the border (the inside is for MSPACE, not selection)", () => {
    const v = vp();
    expect(kindHitDistance(v, { x: 10, y: 50 })).toBeCloseTo(0);
    expect(kindHitDistance(v, { x: 60, y: 50 })).toBeCloseTo(30);
  });

  it("translated / rotated / transformed keep id, name, layer, colour and space", () => {
    const v = vp();
    const t = translated(v, 5, -5);
    expect(t).toMatchObject({ id: "v1", name: "VP1", layer: "VIEWPORTS", color: "#f00", space: "A" });
    expect(t.center).toEqual({ x: 65, y: 45 });
    expect(t.viewCenter).toEqual(v.viewCenter); // moving the window does not pan the model
    const s = transformed(v, { x: 0, y: 0 }, 0, 0, 0, 2);
    expect(s).toMatchObject({ id: "v1", name: "VP1", space: "A", width: 200, height: 120, scale: v.scale });
    // A window cannot rotate: the entity is left as it was.
    expect(rotated(v, { x: 0, y: 0 }, 1)).toEqual(v);
    expect(kindTransform(v, [Math.cos(1), Math.sin(1), -Math.sin(1), Math.cos(1), 0, 0])).toBeNull();
  });

  it("an R12 DXF writes only its border (no throw), and AC1032/SVG are layout-aware elsewhere", () => {
    expect(() => entitiesToDxf([vp()])).not.toThrow();
  });
});

describe("viewport in sketch code and documents", () => {
  const setup = () => {
    const doc = new SketchDocument();
    const bus = new CommandBus(doc);
    bus.execute({ type: "add-layout", layout: newLayout("A") });
    bus.execute({
      type: "add-entity",
      entity: { ...vp(), frozenLayers: ["WALLS"], locked: true, clip: [{ x: 10, y: 20 }, { x: 110, y: 20 }, { x: 60, y: 80 }], annotationScale: "1:50", layerOverrides: { WALLS: { color: "#0f0" } } },
    });
    return { doc, bus };
  };

  it("round-trips through toCode/parseCode with the same id and a layout", () => {
    const { doc, bus } = setup();
    const code = toCode(doc);
    expect(code).toMatch(/viewport VP1 at \(60, 50\) 100x60 view \(500, 300\) scale 0\.02 in "A"/);
    expect(diffToCommands(doc, parseCode(code).entities)).toEqual([]);
    const edited = code.replace("scale 0.02", "scale 0.04");
    const cmds = diffToCommands(doc, parseCode(edited).entities);
    for (const c of cmds) bus.execute(c);
    const v = doc.get("v1") as ViewportEntity;
    expect(v.scale).toBeCloseTo(0.04);
    // Everything the code row has no word for survives the edit.
    expect(v).toMatchObject({ space: "A", locked: true, frozenLayers: ["WALLS"], annotationScale: "1:50", layer: "VIEWPORTS", color: "#f00" });
    expect(v.clip).toHaveLength(3);
    expect(v.layerOverrides).toEqual({ WALLS: { color: "#0f0" } });
  });

  it("rejects a viewport row with a non-positive size or scale", () => {
    expect(parseCode('viewport V at (0, 0) 0x10 view (0, 0) scale 1').errors).toHaveLength(1);
    expect(parseCode('viewport V at (0, 0) 10x10 view (0, 0) scale 0').errors).toHaveLength(1);
  });

  it("survives a JSON round trip with every field", () => {
    const { doc } = setup();
    const back = SketchDocument.fromJSON(JSON.parse(JSON.stringify(doc.toJSON())));
    expect(back.get("v1")).toEqual(doc.get("v1"));
  });

  it("deleting the layout deletes its viewports, and undo brings them back", () => {
    const { doc, bus } = setup();
    bus.execute({ type: "delete-layout", name: "A" });
    expect(doc.get("v1")).toBeUndefined();
    bus.undo();
    expect(doc.get("v1")).toBeDefined();
  });
});
