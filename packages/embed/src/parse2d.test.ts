/**
 * E-01: the embed reads drawings through the app's own importers. Fixtures
 * are written by core's exporters, so each test is a real file of that
 * format, not a hand-made look-alike. (SVG needs DOMParser — covered by the
 * browser smoke page, and by core's SVG suite.)
 */
import { describe, expect, it } from "vitest";
import type { BlockDefinition } from "../../core/src/blocks/types";
import { entitiesToDxf } from "../../core/src/dxfExport";
import type { Entity } from "../../core/src/entities";
import { entitiesToEps } from "../../core/src/eps/export";
import { PdfBuilder } from "../../core/src/pdf";
import { entitiesBounds } from "../../core/src/render2d/index";
import { MAX_DRAWING_ENTITIES, parseDrawing } from "./parse2d";

const plate: Entity[] = [
  { id: "a", type: "polyline", closed: true, points: [{ x: 0, y: 0 }, { x: 120, y: 0 }, { x: 120, y: 80 }, { x: 0, y: 80 }] },
  { id: "b", type: "circle", center: { x: 30, y: 40 }, radius: 10 },
  { id: "c", type: "line", a: { x: 60, y: 10 }, b: { x: 110, y: 70 } },
];
const bytes = (s: string): Uint8Array => new TextEncoder().encode(s);

describe("parseDrawing", () => {
  it("reads a DXF with its geometry in mm", async () => {
    const d = await parseDrawing(bytes(entitiesToDxf(plate, 4)), "plate.dxf", "dxf");
    expect(d.name).toBe("plate.dxf");
    expect(d.entities.map((e) => e.type).sort()).toEqual(["circle", "line", "polyline"]);
    const bb = entitiesBounds(d.entities)!;
    expect(bb.maxX - bb.minX).toBeCloseTo(120, 6);
    expect(bb.maxY - bb.minY).toBeCloseTo(80, 6);
  });

  it("keeps a DXF's blocks so inserts can be drawn", async () => {
    const bolt: BlockDefinition = {
      name: "BOLT",
      basePoint: { x: 0, y: 0 },
      entities: [{ id: "k1", type: "circle", center: { x: 0, y: 0 }, radius: 3 }],
      attributeDefs: [],
      explodable: true,
      scaleUniformly: false,
    };
    const inserts: Entity[] = [
      { id: "i1", type: "insert", block: "BOLT", insert: { x: 10, y: 10 }, rotation: 0, scale: { x: 1, y: 1 } } as Entity,
      { id: "i2", type: "insert", block: "BOLT", insert: { x: 50, y: 10 }, rotation: 0, scale: { x: 1, y: 1 } } as Entity,
    ];
    const d = await parseDrawing(bytes(entitiesToDxf(inserts, 4, 1, [bolt])), "bolts.dxf", "dxf");
    expect(d.entities.filter((e) => e.type === "insert")).toHaveLength(2);
    expect(d.blocks.map((b) => b.name)).toContain("BOLT");
  });

  it("reads an EPS", async () => {
    const d = await parseDrawing(bytes(entitiesToEps(plate)), "plate.eps", "eps");
    expect(d.entities.length).toBeGreaterThanOrEqual(3);
    const bb = entitiesBounds(d.entities)!;
    expect(bb.maxX - bb.minX).toBeCloseTo(120, 1);
  });

  it("reads a PDF's vector page", async () => {
    const pdf = new PdfBuilder();
    pdf.polyline([{ x: 72, y: 72 }, { x: 216, y: 72 }, { x: 216, y: 144 }], { stroke: "#000000" });
    pdf.circle(300, 300, 36, { stroke: "#ff0000" });
    const d = await parseDrawing(pdf.bytes(), "sheet.pdf", "pdf");
    expect(d.entities.length).toBeGreaterThanOrEqual(2);
  });

  it("says why an empty or unreadable file has nothing to show", async () => {
    await expect(parseDrawing(bytes(entitiesToDxf([], 4)), "empty.dxf", "dxf")).rejects.toThrow();
    await expect(parseDrawing(bytes("%PDF-1.4\nnot really a pdf"), "bad.pdf", "pdf")).rejects.toThrow();
  });

  it("caps the size of what it will draw", () => {
    expect(MAX_DRAWING_ENTITIES).toBeGreaterThan(100_000);
  });
});
