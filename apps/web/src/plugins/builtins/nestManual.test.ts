import { describe, expect, it } from "vitest";
import { rotated, translated, type Entity } from "@sketchor/core";
import { fitRigid, readManualNest, shapeClash, trayPositions, type ManualInstance, type ManualSheet } from "./nestManual";
import type { LastNestPlacement } from "./nestReport";

type Pt = { x: number; y: number };
const sq = (id: string, x: number, y: number, w: number, h = w): Entity => ({
  id,
  type: "polyline",
  closed: true,
  layer: "Nest Parts",
  points: [{ x, y }, { x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h }],
} as Entity);
const poly = (x: number, y: number, w: number, h = w): Pt[] => [{ x, y }, { x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h }];

function placement(id: string, partId: string, number: number, sheet: number, outer: Entity[], holes: Entity[] = []): LastNestPlacement {
  return { sheet, number, id, outerEntities: outer, holeEntities: holes, label: { at: { x: 0, y: 0 }, height: 5 }, partId, name: partId.toUpperCase(), rotationDeg: 0, mirrored: false, area: 100 };
}
function inst(id: string, p: LastNestPlacement, outer: Pt[], home: number, drawnAt: Pt = { x: 0, y: 0 }, holes: Pt[][] = []): ManualInstance {
  return { id, placement: p, outer, holes, drawnAt, home };
}

/** Sheet 0 (100 x 100) drawn at x=0; sheet 1 drawn at x=300 and standing for sheets 1 and 2. */
const sheets: ManualSheet[] = [
  { sheet: 0, indices: [0], outlineId: "s0", width: 100, height: 100, margin: 0, clampRect: null },
  { sheet: 1, indices: [1, 2], outlineId: "s1", width: 100, height: 100, margin: 0, clampRect: null },
];
const outline = (id: string, x: number): Entity => sq(id, x, 0, 100);

function scene() {
  const a = placement("0", "a", 1, 0, [sq("a0", 10, 10, 20)]);
  const b = placement("1", "b", 2, 0, [sq("b0", 50, 10, 20)]);
  const c = placement("2", "a", 3, 1, [sq("c0", 10, 10, 20)]);
  const instances = [inst("0", a, poly(10, 10, 20), 0), inst("1", b, poly(50, 10, 20), 0), inst("2", c, poly(10, 10, 20), 1, { x: 300, y: 0 })];
  const doc = new Map<string, Entity>([
    ["s0", outline("s0", 0)],
    ["s1", outline("s1", 300)],
    ["a0", sq("a0", 10, 10, 20)],
    ["b0", sq("b0", 50, 10, 20)],
    ["c0", sq("c0", 310, 10, 20)],
  ]);
  const ordered = new Map([["a", { name: "A", qty: 3 }], ["b", { name: "B", qty: 1 }]]);
  return { instances, doc, ordered };
}

describe("fitRigid", () => {
  const src = [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 5 }];
  it("finds a pure move", () => {
    const t = fitRigid(src, src.map((p) => ({ x: p.x + 3, y: p.y - 2 })));
    expect(t.mirrored).toBe(false);
    expect(Math.abs(t.angle)).toBeLessThan(1e-9);
    expect(t.residual).toBeLessThan(1e-9);
  });
  it("finds a quarter turn and a flip", () => {
    const turned = fitRigid(src, src.map((p) => ({ x: -p.y, y: p.x })));
    expect((turned.angle * 180) / Math.PI).toBeCloseTo(90, 6);
    const flipped = fitRigid(src, src.map((p) => ({ x: -p.x, y: p.y })));
    expect(flipped.mirrored).toBe(true);
    expect(flipped.residual).toBeLessThan(1e-9);
  });
});

describe("readManualNest", () => {
  it("an untouched layout is unchanged, clean, and counts identical sheets", () => {
    const { instances, doc, ordered } = scene();
    const r = readManualNest(instances, sheets, doc, { gap: 0, ordered });
    expect(r.found).toBe(true);
    expect(r.changed).toBe(false);
    expect(r.issues).toEqual([]);
    expect(r.counts).toEqual([{ partId: "a", name: "A", ordered: 3, placed: 3 }, { partId: "b", name: "B", ordered: 1, placed: 1 }]);
    // sheet 1's drawing is cut twice: its part lands on sheets 1 and 2, with distinct ids
    expect(r.placements.map((p) => `${p.sheet}:${p.id}`)).toEqual(["0:0", "0:1", "1:2", "2:2~1"]);
    expect(r.placements[3]!.outerEntities[0]!.id).toBe("c0~1");
  });

  it("moving the whole layout changes nothing", () => {
    const { instances, doc, ordered } = scene();
    for (const [k, e] of doc) doc.set(k, translated(e, 1000, -40));
    const r = readManualNest(instances, sheets, doc, { gap: 0, ordered });
    expect(r.changed).toBe(false);
    expect(r.placements[0]!.outerEntities[0]).toMatchObject({ points: poly(10, 10, 20) });
  });

  it("flags two parts that overlap red, and not parts snapped edge to edge", () => {
    const { instances, doc, ordered } = scene();
    doc.set("b0", sq("b0", 30, 10, 20)); // touches a along x = 30
    let r = readManualNest(instances, sheets, doc, { gap: 0, ordered });
    expect(r.issues).toEqual([]);
    expect(r.moved).toBe(1);
    doc.set("b0", sq("b0", 25, 15, 20));
    r = readManualNest(instances, sheets, doc, { gap: 0, ordered });
    expect(r.issues.map((i) => [i.instanceId, i.kind, i.tone])).toEqual([["0", "overlap", "error"], ["1", "overlap", "error"]]);
    expect(r.issues[0]!.label).toBe("#1 overlaps #2");
  });

  it("flags a part laid exactly over another one", () => {
    const { instances, doc, ordered } = scene();
    doc.set("b0", sq("b0", 10, 10, 20));
    const r = readManualNest(instances, sheets, doc, { gap: 0, ordered });
    expect(r.issues.map((i) => i.kind)).toEqual(["overlap", "overlap"]);
  });

  it("flags a part sticking off the sheet and one closer than the web gap", () => {
    const { instances, doc, ordered } = scene();
    doc.set("b0", sq("b0", 90, 10, 20));
    let r = readManualNest(instances, sheets, doc, { gap: 0, ordered });
    expect(r.issues.map((i) => [i.instanceId, i.kind, i.tone])).toEqual([["1", "off-sheet", "error"]]);
    doc.set("b0", sq("b0", 31, 10, 20));
    r = readManualNest(instances, sheets, doc, { gap: 2, ordered });
    expect(r.issues.map((i) => [i.instanceId, i.kind, i.tone])).toEqual([["0", "gap", "warn"], ["1", "gap", "warn"]]);
  });

  it("flags the edge margin and the clamp strip orange - on parts placed by hand only", () => {
    const { instances, doc, ordered } = scene();
    const withRules: ManualSheet[] = [{ ...sheets[0]!, margin: 12, clampRect: { x: 0, y: 0, w: 100, h: 5 } }, sheets[1]!];
    doc.set("b0", sq("b0", 50, 2, 20));
    const r = readManualNest(instances, withRules, doc, { gap: 0, ordered });
    // part 0 sits in the margin as nested (the engine's own rounding) - not flagged; part 1 was dragged onto the clamp strip
    expect(r.issues.map((i) => [i.instanceId, i.kind])).toEqual([["1", "clamp"]]);
    doc.set("a0", sq("a0", 5, 40, 20));
    expect(readManualNest(instances, withRules, doc, { gap: 0, ordered }).issues.map((i) => [i.instanceId, i.kind])).toEqual([["0", "margin"], ["1", "clamp"]]);
  });

  it("a deleted part counts as one more to nest; a drawing for two sheets counts two", () => {
    const { instances, doc, ordered } = scene();
    doc.delete("b0");
    doc.delete("c0");
    const r = readManualNest(instances, sheets, doc, { gap: 0, ordered });
    expect(r.deleted).toBe(2);
    expect(r.changed).toBe(true);
    expect(r.counts).toEqual([{ partId: "a", name: "A", ordered: 3, placed: 1 }, { partId: "b", name: "B", ordered: 1, placed: 0 }]);
  });

  it("a part dragged from one sheet to another, or out of the tray, goes with it", () => {
    const { instances, doc, ordered } = scene();
    const t = placement("t1", "b", 4, -1, [sq("t0", 0, -200, 20)]);
    const all = [...instances, inst("t1", t, poly(0, -200, 20), -1)];
    doc.set("t0", sq("t0", 0, -200, 20));
    let r = readManualNest(all, sheets, doc, { gap: 0, ordered });
    expect(r.inTray).toEqual(["t1"]);
    expect(r.changed).toBe(false);
    doc.set("t0", sq("t0", 360, 60, 20)); // onto the sheet-1 drawing (cut twice)
    doc.set("a0", sq("a0", 340, 30, 20)); // part a from sheet 0 onto sheet 1 too
    r = readManualNest(all, sheets, doc, { gap: 0, ordered });
    expect(r.inTray).toEqual([]);
    expect(r.moved).toBe(2);
    expect(r.counts).toEqual([{ partId: "a", name: "A", ordered: 3, placed: 4 }, { partId: "b", name: "B", ordered: 1, placed: 3 }]);
    const tp = r.placements.filter((p) => p.partId === "b" && p.sheet > 0);
    expect(tp.map((p) => p.sheet)).toEqual([1, 2]);
    expect(tp[0]!.outerEntities[0]).toMatchObject({ points: poly(60, 60, 20) });
  });

  it("records a quarter turn as the part's rotation", () => {
    const { instances, doc, ordered } = scene();
    doc.set("b0", rotated(sq("b0", 50, 10, 20), { x: 60, y: 20 }, Math.PI / 2));
    const r = readManualNest(instances, sheets, doc, { gap: 0, ordered });
    expect(r.placements.find((p) => p.id === "1")!.rotationDeg).toBe(90);
    expect(r.issues).toEqual([]);
  });

  it("a part in another part's hole is not an overlap", () => {
    const ring = placement("0", "a", 1, 0, [sq("a0", 10, 10, 60)], [sq("ah", 20, 20, 40)]);
    const small = placement("1", "b", 2, 0, [sq("b0", 30, 30, 10)]);
    const instances = [inst("0", ring, poly(10, 10, 60), 0, { x: 0, y: 0 }, [poly(20, 20, 40)]), inst("1", small, poly(30, 30, 10), 0)];
    const doc = new Map<string, Entity>([["s0", outline("s0", 0)], ["s1", outline("s1", 300)], ["a0", sq("a0", 10, 10, 60)], ["ah", sq("ah", 20, 20, 40)], ["b0", sq("b0", 30, 30, 10)]]);
    const ordered = new Map([["a", { name: "A", qty: 1 }], ["b", { name: "B", qty: 1 }]]);
    expect(readManualNest(instances, sheets, doc, { gap: 0, ordered }).issues).toEqual([]);
    doc.set("b0", sq("b0", 15, 30, 10)); // across the ring's material
    expect(readManualNest(instances, sheets, doc, { gap: 0, ordered }).issues.map((i) => i.kind)).toEqual(["overlap", "overlap"]);
  });

  it("is not found when the layout tab is not the one open", () => {
    const { instances, ordered } = scene();
    expect(readManualNest(instances, sheets, new Map(), { gap: 0, ordered }).found).toBe(false);
  });
});

describe("shapeClash / trayPositions", () => {
  it("treats crossing outlines as an overlap", () => {
    const s = (x: number, y: number, w: number) => ({ outer: poly(x, y, w), holes: [], box: { minX: x, minY: y, maxX: x + w, maxY: y + w } });
    expect(shapeClash(s(0, 0, 10), s(5, 5, 10), 0)).toBe("overlap");
    expect(shapeClash(s(0, 0, 10), s(11, 0, 10), 0)).toBeNull();
    expect(shapeClash(s(0, 0, 10), s(11, 0, 10), 2)).toBe("gap");
  });
  it("lays tray parts in rows that wrap", () => {
    const t = trayPositions([{ w: 40, h: 10 }, { w: 40, h: 20 }, { w: 40, h: 10 }], -100, 100, 5);
    expect(t.offsets).toEqual([{ x: 0, y: -110 }, { x: 45, y: -120 }, { x: 0, y: -135 }]);
  });
});
