import { describe, expect, it } from "vitest";
import type { CircleEntity, Entity, LineEntity, PolylineEntity } from "@sketchor/core";
import { extractParts, extractPartsWithDiagnostics } from "./partExtraction";

/**
 * N-01: the panel's part list has to reflect what a laser actually cuts —
 * a hole stays a hole, and a part someone drew inside a hole (for later
 * part-in-hole filling) mustn't get folded into that hole's data. These
 * tests pin the containment classification, not just "some polygon came
 * out" — a wrong depth here silently cuts a part in half on the sheet.
 */

function rectPolyline(id: string, x: number, y: number, w: number, h: number, name?: string): PolylineEntity {
  return {
    id,
    type: "polyline",
    name,
    closed: true,
    points: [
      { x, y },
      { x: x + w, y },
      { x: x + w, y: y + h },
      { x, y: y + h },
    ],
  };
}

function allIds(entities: Entity[]): Set<string> {
  return new Set(entities.map((e) => e.id));
}

describe("extractParts", () => {
  it("a rectangle with one square hole becomes one part with one hole", () => {
    const outer = rectPolyline("outer", 0, 0, 100, 50, "Plate");
    const hole = rectPolyline("hole", 20, 10, 10, 10);
    const entities = [outer, hole];
    const parts = extractParts(entities, allIds(entities));
    expect(parts).toHaveLength(1);
    expect(parts[0].name).toBe("Plate");
    expect(parts[0].holes).toHaveLength(1);
    expect(parts[0].sourceIds.sort()).toEqual(["hole", "outer"]);
    expect(parts[0].outerSourceIds).toEqual(["outer"]);
    expect(parts[0].holeSourceIds).toEqual([["hole"]]);
  });

  it("two separate holes in one outer shape both attach to it", () => {
    const outer = rectPolyline("outer", 0, 0, 100, 50);
    const holeA = rectPolyline("holeA", 10, 10, 5, 5);
    const holeB = rectPolyline("holeB", 60, 30, 5, 5);
    const entities = [outer, holeA, holeB];
    const parts = extractParts(entities, allIds(entities));
    expect(parts).toHaveLength(1);
    expect(parts[0].holes).toHaveLength(2);
    expect(parts[0].outerSourceIds).toEqual(["outer"]);
    expect(parts[0].holeSourceIds.map((ids) => ids.slice().sort())).toEqual(
      expect.arrayContaining([["holeA"], ["holeB"]]),
    );
  });

  it("a shape nested inside a hole becomes its own part, not a hole of a hole", () => {
    const outer = rectPolyline("outer", 0, 0, 100, 100);
    const hole = rectPolyline("hole", 20, 20, 40, 40);
    const inner = rectPolyline("inner", 30, 30, 10, 10);
    const entities = [outer, hole, inner];
    const parts = extractParts(entities, allIds(entities));
    expect(parts).toHaveLength(2);
    const outerPart = parts.find((p) => p.sourceIds.includes("outer"))!;
    const innerPart = parts.find((p) => p.sourceIds.includes("inner"))!;
    expect(outerPart.holes).toHaveLength(1);
    expect(outerPart.sourceIds).not.toContain("inner");
    expect(innerPart.holes).toHaveLength(0);
    expect(innerPart.sourceIds).toEqual(["inner"]);
  });

  it("an open, non-closing chain in the selection is ignored rather than thrown", () => {
    const outer = rectPolyline("outer", 0, 0, 100, 50);
    const strayLine: LineEntity = { id: "stray", type: "line", a: { x: 200, y: 200 }, b: { x: 210, y: 210 } };
    const entities: Entity[] = [outer, strayLine];
    expect(() => extractParts(entities, allIds(entities))).not.toThrow();
    const parts = extractParts(entities, allIds(entities));
    expect(parts).toHaveLength(1);
    expect(parts[0].sourceIds).toEqual(["outer"]);
  });

  it("open line/arc chains that close into a loop become a part", () => {
    // A square drawn as four separate lines rather than a closed polyline.
    const lines: LineEntity[] = [
      { id: "l1", type: "line", a: { x: 0, y: 0 }, b: { x: 20, y: 0 } },
      { id: "l2", type: "line", a: { x: 20, y: 0 }, b: { x: 20, y: 20 } },
      { id: "l3", type: "line", a: { x: 20, y: 20 }, b: { x: 0, y: 20 } },
      { id: "l4", type: "line", a: { x: 0, y: 20 }, b: { x: 0, y: 0 } },
    ];
    const parts = extractParts(lines, allIds(lines));
    expect(parts).toHaveLength(1);
    expect(parts[0].sourceIds.sort()).toEqual(["l1", "l2", "l3", "l4"]);
    expect(parts[0].outer.length).toBeGreaterThanOrEqual(4);
    // A closed outline joined from several entities: all of them are the
    // outer boundary's own ids, none are holes.
    expect(parts[0].outerSourceIds.slice().sort()).toEqual(["l1", "l2", "l3", "l4"]);
    expect(parts[0].holeSourceIds).toEqual([]);
  });

  it("a washer (circle with a circular hole) extracts correctly", () => {
    const outer: CircleEntity = { id: "o", type: "circle", center: { x: 0, y: 0 }, radius: 20 };
    const inner: CircleEntity = { id: "i", type: "circle", center: { x: 0, y: 0 }, radius: 5 };
    const entities = [outer, inner];
    const parts = extractParts(entities, allIds(entities));
    expect(parts).toHaveLength(1);
    expect(parts[0].holes).toHaveLength(1);
  });

  it("only considers the given selection, ignoring unselected entities", () => {
    const outer = rectPolyline("outer", 0, 0, 100, 50);
    const unrelated = rectPolyline("unrelated", 500, 500, 10, 10);
    const entities = [outer, unrelated];
    const parts = extractParts(entities, new Set(["outer"]));
    expect(parts).toHaveLength(1);
    expect(parts[0].sourceIds).toEqual(["outer"]);
  });
});

/**
 * NF-03: a real DXF is rarely perfectly closed — nestPlugin.ts's "Add
 * selection" needs to say *why* it found nothing (or fewer parts than
 * expected) instead of a flat "select closed shapes", and a small
 * `joinTolerance` needs to actually close a near-miss.
 */
describe("extractPartsWithDiagnostics — open chains (NF-03)", () => {
  it("a near-square with a small gap reports one open chain instead of silently vanishing", () => {
    const lines: LineEntity[] = [
      { id: "l1", type: "line", a: { x: 0, y: 0 }, b: { x: 20, y: 0 } },
      { id: "l2", type: "line", a: { x: 20, y: 0 }, b: { x: 20, y: 20 } },
      { id: "l3", type: "line", a: { x: 20, y: 20 }, b: { x: 0, y: 20 } },
      // l4 stops 0.2mm short of closing back to l1's start.
      { id: "l4", type: "line", a: { x: 0, y: 20 }, b: { x: 0, y: 0.2 } },
    ];
    const { parts, openChains } = extractPartsWithDiagnostics(lines, allIds(lines));
    expect(parts).toHaveLength(0);
    expect(openChains).toHaveLength(1);
    expect(openChains[0].entityIds.slice().sort()).toEqual(["l1", "l2", "l3", "l4"]);
    expect(openChains[0].gap).toBeCloseTo(0.2, 6);
  });

  it("a larger joinTolerance closes that same gap into a real part", () => {
    const lines: LineEntity[] = [
      { id: "l1", type: "line", a: { x: 0, y: 0 }, b: { x: 20, y: 0 } },
      { id: "l2", type: "line", a: { x: 20, y: 0 }, b: { x: 20, y: 20 } },
      { id: "l3", type: "line", a: { x: 20, y: 20 }, b: { x: 0, y: 20 } },
      { id: "l4", type: "line", a: { x: 0, y: 20 }, b: { x: 0, y: 0.2 } },
    ];
    const { parts, openChains } = extractPartsWithDiagnostics(lines, allIds(lines), { joinTolerance: 0.5 });
    expect(parts).toHaveLength(1);
    expect(openChains).toHaveLength(0);
  });

  it("a lone selected line with nothing to connect to is reported as its own open chain", () => {
    const strayLine: LineEntity = { id: "stray", type: "line", a: { x: 200, y: 200 }, b: { x: 210, y: 210 } };
    const { parts, openChains } = extractPartsWithDiagnostics([strayLine], allIds([strayLine]));
    expect(parts).toHaveLength(0);
    expect(openChains).toHaveLength(1);
    expect(openChains[0].entityIds).toEqual(["stray"]);
  });

  it("a fully closed selection reports no open chains", () => {
    const outer = rectPolyline("outer", 0, 0, 100, 50);
    const { parts, openChains } = extractPartsWithDiagnostics([outer], allIds([outer]));
    expect(parts).toHaveLength(1);
    expect(openChains).toHaveLength(0);
  });
});

describe("C-08: ellipses and splines are parts", () => {
  const ell = (id: string, rx: number, ry: number): Entity => ({ id, type: "ellipse", center: { x: 0, y: 0 }, majorAxis: { x: rx, y: 0 }, ratio: ry / rx, start: 0, end: Math.PI * 2 });
  it("a full ellipse is one part with a tessellated outline of the right area", () => {
    const parts = extractParts([ell("e", 10, 5)], new Set(["e"]));
    expect(parts).toHaveLength(1);
    let a = 0;
    const o = parts[0].outer;
    for (let i = 0; i < o.length; i++) a += o[i].x * o[(i + 1) % o.length].y - o[(i + 1) % o.length].x * o[i].y;
    expect(Math.abs(Math.abs(a / 2) - Math.PI * 50)).toBeLessThan(2); // within the 0.05 mm chord tolerance
  });
  it("an ellipse inside a rectangle becomes its hole", () => {
    const parts = extractParts([rectPolyline("r", -20, -20, 40, 40), ell("e", 10, 5)], new Set(["r", "e"]));
    expect(parts).toHaveLength(1);
    expect(parts[0].holes).toHaveLength(1);
    expect(parts[0].holeSourceIds[0]).toEqual(["e"]);
  });
});

/**
 * RN-10: the contour rules ported from the Sheet Nesting Calculator
 * (Oleksandr Borenko). Each guards a way a nest quietly goes wrong: a doubled
 * line cut twice, a bend line cut as an outline, a quote off by the pierces.
 */
describe("extractPartsWithDiagnostics contour rules (RN-10)", () => {
  const line = (id: string, ax: number, ay: number, bx: number, by: number, extra: Partial<LineEntity> = {}): LineEntity => ({
    id,
    type: "line",
    a: { x: ax, y: ay },
    b: { x: bx, y: by },
    ...extra,
  });

  it("per-part cut length, holes and pierces add up from outer + holes", () => {
    const entities = [rectPolyline("o", 0, 0, 100, 50), rectPolyline("h", 10, 10, 10, 10)];
    const [part] = extractParts(entities, allIds(entities));
    expect(part.cutLength).toBeCloseTo(300 + 40);
    expect(part.holeCount).toBe(1);
    expect(part.pierceCount).toBe(2);
  });

  it("drops a duplicated primitive and says so", () => {
    const entities: Entity[] = [rectPolyline("o", 0, 0, 10, 10), rectPolyline("dup", 0, 0, 10, 10)];
    const r = extractPartsWithDiagnostics(entities, allIds(entities));
    expect(r.parts).toHaveLength(1);
    expect(r.notes).toContainEqual({ kind: "duplicates", count: 1 });
    expect(r.parts[0].cutLength).toBeCloseTo(40);
  });

  it("ignores helper lines by layer, linetype and construction flag, unless kept", () => {
    const entities: Entity[] = [
      rectPolyline("o", 0, 0, 10, 10),
      line("bend", 5, 0, 5, 10, { layer: "BEND_LINES" }),
      line("ctr", 0, 5, 10, 5, { linetype: "CENTER" }),
      line("con", 0, 2, 10, 2, { construction: true }),
    ];
    const r = extractPartsWithDiagnostics(entities, allIds(entities));
    expect(r.openChains).toHaveLength(0);
    expect(r.notes.find((n) => n.kind === "helper")).toMatchObject({ count: 3 });
    const kept = extractPartsWithDiagnostics(entities, allIds(entities), { keepHelpers: true });
    expect(kept.notes.find((n) => n.kind === "helper")).toBeUndefined();
    expect(kept.openChains.length).toBeGreaterThan(0);
  });

  it("closes a small gap only with a close tolerance, and reports it", () => {
    const entities: Entity[] = [line("a", 0, 0, 10, 0), line("b", 10.005, 0, 10, 10), line("c", 10, 10, 0, 10), line("d", 0, 10, 0, 0)];
    expect(extractParts(entities, allIds(entities))).toHaveLength(0);
    const r = extractPartsWithDiagnostics(entities, allIds(entities), { closeTolerance: 0.01 });
    expect(r.parts).toHaveLength(1);
    const gap = r.notes.find((n) => n.kind === "gap-closed");
    expect(gap && gap.kind === "gap-closed" && gap.maxGap).toBeCloseTo(0.005, 3);
  });

  it("flags several separate outer contours only for single-part selections", () => {
    const entities: Entity[] = [rectPolyline("a", 0, 0, 10, 10), rectPolyline("b", 50, 0, 10, 10)];
    expect(extractPartsWithDiagnostics(entities, allIds(entities)).notes).toEqual([]);
    const r = extractPartsWithDiagnostics(entities, allIds(entities), { singlePart: true });
    expect(r.notes).toContainEqual({ kind: "multi-outer", count: 2 });
  });

  it("never throws on an empty selection or only helper lines", () => {
    expect(extractPartsWithDiagnostics([], new Set()).parts).toEqual([]);
    const h = [line("x", 0, 0, 1, 1, { layer: "centerline" })];
    expect(extractPartsWithDiagnostics(h, allIds(h)).parts).toEqual([]);
  });
});
