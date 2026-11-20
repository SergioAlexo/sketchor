import { describe, expect, it } from "vitest";
import { entityPoints, rotated, translated, type Entity } from "@sketchor/core";
import { applyCanvasEdits, type LayoutSheetRef } from "./nestCanvasEdits";
import type { LastNestPlacement } from "./nestReport";

const rect = (id: string, x: number, y: number, w: number, h: number): Entity => ({
  id, type: "polyline", closed: true, layer: "Nest Parts",
  points: [{ x, y }, { x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h }],
});
const hole = (id: string, x: number, y: number): Entity => ({ id, type: "circle", layer: "Nest Holes", center: { x, y }, radius: 2 });
const outline = (id: string, x: number, w = 200, h = 100): Entity => ({ id, type: "polyline", closed: true, points: [{ x, y: 0 }, { x: x + w, y: 0 }, { x: x + w, y: h }, { x, y: h }] });

function pl(sheet: number, number: number, id: string, x: number, y: number): LastNestPlacement {
  return {
    sheet, number, id,
    outerEntities: [rect(`o${id}`, x, y, 30, 20)],
    holeEntities: [hole(`h${id}`, x + 15, y + 10)],
    label: { at: { x: x + 10, y: y + 5 }, height: 5 },
    partId: "bracket", name: "Bracket", rotationDeg: 0, mirrored: false, area: 587,
  };
}
const keyOf = (p: LastNestPlacement) => {
  const b = entityPoints(p.outerEntities[0]!);
  return `${p.partId}|${b[0]!.x}|${b[0]!.y}`;
};
/** The canvas exactly as buildSideBySideLayout draws it: sheet 0 at x=0, sheet 2 (drawn for sheets 2 and 3) at x=220. */
function canvas(placements: LastNestPlacement[], refs: LayoutSheetRef[]): Map<string, Entity> {
  const doc = new Map<string, Entity>();
  for (const r of refs) {
    doc.set(r.outlineId, outline(r.outlineId, r.origin.x));
    for (const p of placements.filter((q) => q.sheet === r.sheet)) for (const e of [...p.outerEntities, ...p.holeEntities]) doc.set(e.id, translated(e, r.origin.x, r.origin.y));
  }
  return doc;
}

const placements = [pl(0, 1, "0", 10, 10), pl(0, 2, "1", 60, 10), pl(2, 3, "2", 10, 10), pl(3, 4, "3", 10, 10)];
const refs: LayoutSheetRef[] = [
  { sheet: 0, indices: [0, 1], outlineId: "S0", origin: { x: 0, y: 0 } },
  { sheet: 2, indices: [2, 3], outlineId: "S2", origin: { x: 220, y: 0 } },
];

describe("applyCanvasEdits (NF-08: outputs follow parts moved on the canvas)", () => {
  it("an untouched layout gives back the nest unchanged", () => {
    const r = applyCanvasEdits(placements, refs, canvas(placements, refs), keyOf);
    expect(r).toMatchObject({ moved: 0, found: true });
    r.placements.forEach((p, i) => expect(p).toBe(placements[i]));
  });

  it("a part dragged on the canvas moves in the outputs, holes with it, label re-centred", () => {
    const doc = canvas(placements, refs);
    doc.set("o1", translated(doc.get("o1")!, 50, 30));
    doc.set("h1", translated(doc.get("h1")!, 50, 30));
    const r = applyCanvasEdits(placements, refs, doc, keyOf);
    expect(r.moved).toBe(1);
    const p = r.placements[1]!;
    expect(entityPoints(p.outerEntities[0]!)[0]).toEqual({ x: 110, y: 40 });
    expect(p.holeEntities[0]).toMatchObject({ center: { x: 125, y: 50 }, layer: "Nest Holes" });
    expect(p.outerEntities[0]!.layer).toBe("Nest Parts");
    expect(p.label.at.y).toBeCloseTo(50 - 2.5, 9);
    expect(r.placements[0]).toBe(placements[0]);
  });

  it("dragging a whole sheet (its group) changes nothing: parts are read relative to the outline", () => {
    const doc = new Map([...canvas(placements, refs)].map(([id, e]) => [id, translated(e, 500, -80)]));
    expect(applyCanvasEdits(placements, refs, doc, keyOf).moved).toBe(0);
  });

  it("a part rotated on a drawing of identical sheets is rotated on every sheet of the group, each keeping its own ids", () => {
    const doc = canvas(placements, refs);
    const pivot = { x: 220 + 25, y: 20 };
    doc.set("o2", rotated(doc.get("o2")!, pivot, Math.PI / 2));
    doc.set("h2", rotated(doc.get("h2")!, pivot, Math.PI / 2));
    const r = applyCanvasEdits(placements, refs, doc, keyOf);
    expect(r.moved).toBe(2);
    const [a, b] = [r.placements[2]!, r.placements[3]!];
    expect(entityPoints(a.outerEntities[0]!)).toEqual(entityPoints(b.outerEntities[0]!));
    expect(a.outerEntities[0]!.id).toBe("o2");
    expect(b.outerEntities[0]!.id).toBe("o3");
    expect(b.holeEntities[0]!.id).toBe("h3");
  });

  it("a deleted part stays as nested, and a tab that is not the layout changes nothing", () => {
    const doc = canvas(placements, refs);
    doc.delete("o1");
    expect(applyCanvasEdits(placements, refs, doc, keyOf).moved).toBe(0);
    const other = applyCanvasEdits(placements, refs, new Map([["x", rect("x", 0, 0, 1, 1)]]), keyOf);
    expect(other).toMatchObject({ moved: 0, found: false });
  });
});
