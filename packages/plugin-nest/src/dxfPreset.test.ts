import { describe, expect, it } from "vitest";
import { entitiesToDxf, parseDxf, type Entity } from "@sketchor/core";
import { circle, polyline } from "@sketchor/plugin-sdk";
import { CAM_INNER_LAYER, CAM_OUTER_LAYER, CAM_SHEET_LAYER, sheetDxfEntities, sheetDxfFileName, stackedSheetsDxfEntities } from "./dxfPreset";
import { NEST_LABELS_LAYER } from "./layout";
import type { SheetPlacementEntities } from "./trueLayout";
import type { TrueNestSheet } from "./trueNest";

/**
 * The CAM preset decides which contour a shop's machine cuts as an outside
 * profile and which as a hole. Checked through a real DXF write/parse: layers
 * as named, no labels, arcs kept as arcs (not flattened), lower-left origin.
 */
const sheets: TrueNestSheet[] = [
  { stockIndex: 0, width: 100, height: 50 },
  { stockIndex: 0, width: 100, height: 50 },
];
// A rounded part: one bulged segment (a real arc), plus a circular hole.
const bulged = polyline([{ x: 10, y: 10 }, { x: 30, y: 10 }, { x: 30, y: 30 }, { x: 10, y: 30 }], true, { layer: "Nest Parts" });
bulged.bulges = [0, 0.5, 0, 0];
const hole = circle({ x: 20, y: 20 }, 3, { layer: "Nest Holes" });
const placements: SheetPlacementEntities[] = [
  { sheet: 0, number: 1, outerEntities: [bulged as Entity], holeEntities: [hole as Entity], label: { at: { x: 20, y: 20 }, height: 3 } },
  { sheet: 1, number: 2, outerEntities: [bulged as Entity], holeEntities: [], label: { at: { x: 20, y: 20 }, height: 3 } },
];

describe("sheetDxfEntities", () => {
  it("cam: outer on CUT_OUTER, holes on CUT_INNER, no labels, no sheet outline by default", () => {
    const es = sheetDxfEntities(sheets[0], 0, "S1", placements);
    expect(es.map((e) => e.layer).sort()).toEqual([CAM_INNER_LAYER, CAM_OUTER_LAYER]);
    expect(es.some((e) => e.layer === NEST_LABELS_LAYER)).toBe(false);
  });

  it("cam: optional SHEET outline, and only this sheet's placements", () => {
    const es = sheetDxfEntities(sheets[1], 1, "S2", placements, { includeSheetOutline: true });
    expect(es.filter((e) => e.layer === CAM_SHEET_LAYER)).toHaveLength(1);
    expect(es.filter((e) => e.layer === CAM_INNER_LAYER)).toHaveLength(0);
  });

  it("survives a DXF round trip with the layers, arcs kept, nothing below the lower-left origin", () => {
    const text = entitiesToDxf(sheetDxfEntities(sheets[0], 0, "S1", placements, { includeSheetOutline: true }), 4, 1);
    const back = parseDxf(text).entities;
    expect(new Set(back.map((e) => e.layer))).toEqual(new Set([CAM_OUTER_LAYER, CAM_INNER_LAYER, CAM_SHEET_LAYER]));
    const outer = back.find((e) => e.layer === CAM_OUTER_LAYER)!;
    const curved = outer.type === "polyline" ? (outer.bulges ?? []).some((b) => Math.abs(b) > 1e-6) : outer.type === "arc";
    expect(curved || back.filter((e) => e.layer === CAM_OUTER_LAYER).some((e) => e.type === "arc")).toBe(true);
    const xs = back.filter((e) => e.type === "polyline").flatMap((e) => (e.type === "polyline" ? e.points.map((p) => p.x) : []));
    expect(Math.min(...xs)).toBeGreaterThanOrEqual(-1e-6);
  });

  it("nest preset keeps the canvas layers, title and part number", () => {
    const es = sheetDxfEntities(sheets[0], 0, "S1", placements, { preset: "nest" });
    expect(es.filter((e) => e.layer === NEST_LABELS_LAYER).length).toBeGreaterThanOrEqual(2);
  });

  it("stacked export holds every sheet, shifted apart", () => {
    const es = stackedSheetsDxfEntities(sheets, ["S1", "S2"], placements);
    const ys = es.filter((e) => e.type === "polyline").map((e) => (e.type === "polyline" ? Math.min(...e.points.map((p) => p.y)) : 0));
    expect(Math.max(...ys) - Math.min(...ys)).toBeGreaterThan(50);
  });

  it("file names sort in sheet order", () => {
    expect(sheetDxfFileName(0)).toBe("nest-sheet-01.dxf");
    expect([sheetDxfFileName(9), sheetDxfFileName(1)].sort()).toEqual(["nest-sheet-02.dxf", "nest-sheet-10.dxf"]);
  });
});
