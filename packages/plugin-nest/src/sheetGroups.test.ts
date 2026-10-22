import { describe, expect, it } from "vitest";
import type { Entity } from "@sketchor/core";
import type { Command } from "@sketchor/plugin-sdk";
import { NEST_HOLES_LAYER, NEST_LABELS_LAYER, NEST_PARTS_LAYER, NEST_SHEET_LAYER } from "./layout";
import { buildSideBySideLayout, describeGroup, groupIdenticalSheets, type SignaturePlacement } from "./sheetGroups";
import type { SheetPlacementEntities } from "./trueLayout";
import type { TrueNestSheet } from "./trueNest";

/**
 * Collapsing identical sheets is only safe if the signature is exact: two
 * sheets that differ by one part position must stay separate (that sheet would
 * otherwise be silently cut like its neighbour), while float noise below 1e-3
 * must not split a run of genuinely identical sheets.
 */
const sheet = (w = 100, h = 50): TrueNestSheet => ({ stockIndex: 0, width: w, height: h });
const pl = (s: number, partId: string, x: number, y: number, rot = 0): SignaturePlacement => ({ sheet: s, partId, rotationDeg: rot, translation: { x, y } });

describe("groupIdenticalSheets", () => {
  it("collapses identical sheets, keeps first-occurrence order and every index", () => {
    const sheets = [sheet(), sheet(), sheet(200, 50), sheet()];
    const placements = [pl(0, "a", 1, 2), pl(1, "a", 1, 2), pl(2, "a", 1, 2), pl(3, "a", 1, 2)];
    const groups = groupIdenticalSheets(sheets, placements);
    expect(groups.map((g) => g.indices)).toEqual([[0, 1, 3], [2]]);
    expect(groups.flatMap((g) => g.indices).sort()).toEqual([0, 1, 2, 3]);
  });

  it("is insensitive to placement order and to noise under 1e-3", () => {
    const g = groupIdenticalSheets([sheet(), sheet()], [pl(0, "a", 1, 2), pl(0, "b", 5, 5), pl(1, "b", 5.0001, 5), pl(1, "a", 1, 2.0002)]);
    expect(g).toHaveLength(1);
  });

  it("keeps sheets apart when a position, angle, part or size differs", () => {
    const base = [pl(0, "a", 1, 2), pl(1, "a", 1, 2)];
    expect(groupIdenticalSheets([sheet(), sheet()], [base[0], pl(1, "a", 1.01, 2)])).toHaveLength(2);
    expect(groupIdenticalSheets([sheet(), sheet()], [base[0], pl(1, "a", 1, 2, 90)])).toHaveLength(2);
    expect(groupIdenticalSheets([sheet(), sheet()], [base[0], pl(1, "b", 1, 2)])).toHaveLength(2);
    expect(groupIdenticalSheets([sheet(), sheet(101, 50)], base)).toHaveLength(2);
  });

  it("handles no sheets and empty sheets", () => {
    expect(groupIdenticalSheets([], [])).toEqual([]);
    expect(groupIdenticalSheets([sheet(), sheet()], [])[0].indices).toEqual([0, 1]);
  });

  it("describes groups 1-based with collapsed ranges", () => {
    expect(describeGroup([1])).toBe("Sheet 2");
    expect(describeGroup([2, 3, 4, 5, 6])).toBe("Sheets 3–7 ×5");
    expect(describeGroup([0, 2, 3])).toBe("Sheets 1+3+4 ×3");
  });
});

describe("buildSideBySideLayout", () => {
  const part = (id: string): Entity => ({ id, type: "polyline", points: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }], closed: true });
  const place = (s: number, n: number): SheetPlacementEntities => ({
    sheet: s,
    number: n,
    outerEntities: [part(`o${n}`)],
    holeEntities: [part(`h${n}`)],
    label: { at: { x: 3, y: 3 }, height: 2 },
  });
  const sheets = [sheet(), sheet(), sheet(80, 40)];
  const placements = [place(0, 1), place(1, 2), place(2, 3)];
  const groups = [
    { sheet: sheets[0], indices: [0, 1], signature: "x" },
    { sheet: sheets[2], indices: [2], signature: "y" },
  ];
  const cmds = buildSideBySideLayout(sheets, placements, groups, (_s, i) => `Sheet ${i + 1}`);
  const adds = cmds.filter((c): c is Extract<Command, { type: "add-entity" }> => c.type === "add-entity").map((c) => c.entity);

  it("draws a group once, on the four existing layers, one entity group per drawn sheet", () => {
    expect(new Set(adds.map((e) => e.layer))).toEqual(new Set([NEST_SHEET_LAYER, NEST_PARTS_LAYER, NEST_HOLES_LAYER, NEST_LABELS_LAYER]));
    expect(adds.filter((e) => e.layer === NEST_PARTS_LAYER)).toHaveLength(2); // 2 groups, not 3 sheets
    expect(cmds.filter((c) => c.type === "group-entities")).toHaveLength(2);
  });

  it("labels collapsed groups with their sheet range and count", () => {
    const names = cmds.filter((c): c is Extract<Command, { type: "group-entities" }> => c.type === "group-entities").map((c) => c.name);
    expect(names[0]).toContain("×2");
    expect(names[1]).not.toContain("×");
  });

  it("places groups left to right without overlap", () => {
    const xs = (pred: (e: Entity) => boolean) => adds.filter(pred).flatMap((e) => (e.type === "polyline" ? e.points.map((p) => p.x) : []));
    const outlines = adds.filter((e) => e.layer === NEST_SHEET_LAYER && e.type === "polyline");
    const spans = outlines.map((o) => (o.type === "polyline" ? [Math.min(...o.points.map((p) => p.x)), Math.max(...o.points.map((p) => p.x))] : [0, 0]));
    expect(spans[1][0]).toBeGreaterThan(spans[0][1]);
    expect(Math.min(...xs((e) => e.layer === NEST_SHEET_LAYER))).toBe(0);
  });
});
