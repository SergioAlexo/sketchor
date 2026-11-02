/**
 * D-05 leaders / multileaders / balloons. What breaks in a user's drawing: a
 * callout whose text lands on the wrong side of its landing, a balloon that
 * is not the shape asked for, extra leader lines lost on a code-panel edit,
 * a leader that vanishes from R12 / SVG exports (no real record there), and
 * balloon numbers that repeat.
 */
import { describe, expect, it } from "vitest";
import { CommandBus } from "../commands";
import { SketchDocument } from "../document";
import type { DimensionEntity } from "../entities";
import { kindBounds, kindTessellate, kindTransform } from "../kinds/registry";
import "../kinds/builtin";
import { diffToCommands, parseCode, toCode } from "../sketchtext";
import { explodeDimension } from "./explode";
import { layoutOf } from "./resolve";
import { balloonOutline, leaderPlainText, nextBalloonNumber } from "./leader";
import { addLeaderLine, alignLeaders, buildLeader, collectLeaders, leaderLineCount, removeLeaderLine } from "./leaderOps";

const P = (x: number, y: number) => ({ x, y });
const mk = (pts: [number, number][], extra: Partial<DimensionEntity> = {}): DimensionEntity => ({ ...buildLeader(pts.map(([x, y]) => P(x, y)), { text: "NOTE" }, { id: "ld" })!, ...extra });

describe("leader layout", () => {
  it("puts the arrow at the tip, a landing at the attach point and the text beyond it", () => {
    const l = layoutOf(mk([[0, 0], [10, 10]]));
    expect(l.fills.length).toBe(1); // filled arrow head
    expect(l.text?.text).toBe("NOTE");
    expect(l.text!.at.x).toBeGreaterThan(10);
    expect(l.text!.at.y).toBeCloseTo(10, 9);
    // the landing is horizontal from the attach point
    expect(l.lines.some((r) => r.length === 2 && r[0].x === 10 && r[0].y === 10 && r[1].y === 10 && r[1].x > 10)).toBe(true);
  });

  it("mirrors to the left when the line arrives from the right", () => {
    const l = layoutOf(mk([[20, 0], [10, 10]]));
    expect(l.text!.at.x).toBeLessThan(10);
  });

  it("draws no landing and no text for a leader without content", () => {
    const l = layoutOf({ ...mk([[0, 0], [10, 10]]), textOverride: undefined });
    expect(l.text).toBeNull();
    expect(l.lines.every((r) => r.length !== 2 || r[1].y !== 10 || r[0].y !== 10)).toBe(true);
  });

  it("draws every branch of a multileader to the same attach point", () => {
    const d = addLeaderLine(mk([[0, 0], [10, 10]]), P(0, 20));
    expect(leaderLineCount(d)).toBe(2);
    const l = layoutOf(d);
    expect(l.fills.length).toBe(2);
    expect(l.lines.filter((r) => r[r.length - 1].x === 10 && r[r.length - 1].y === 10 && r.length === 2).length).toBeGreaterThanOrEqual(2);
  });

  it("smooths a spline leader through its points", () => {
    const straight = layoutOf(mk([[0, 0], [5, 8], [10, 10]])).lines[0];
    const curved = layoutOf(mk([[0, 0], [5, 8], [10, 10]], { leaderSpline: true })).lines[0];
    expect(curved.length).toBeGreaterThan(straight.length);
    expect(curved[0]).toEqual(P(0, 0));
    expect(curved[curved.length - 1].x).toBeCloseTo(10, 9);
  });

  it("wraps balloon content in the requested shape, sized to the text", () => {
    const l = layoutOf(mk([[0, 0], [10, 10]], { balloon: "hexagon", textOverride: "12" }));
    const closed = l.lines.filter((r) => r.length === 7);
    expect(closed.length).toBe(1);
    const xs = closed[0].map((p) => p.x);
    expect(Math.min(...xs)).toBeLessThanOrEqual(l.text!.at.x - l.text!.width / 2);
    expect(balloonOutline("circle", P(0, 0), 3).length).toBe(49);
    expect(balloonOutline("triangle", P(0, 0), 3).length).toBe(4);
    expect(balloonOutline("square", P(0, 0), 3).length).toBe(5);
  });

  it("reduces MTEXT codes to one plain line", () => {
    expect(leaderPlainText("{\\C1;RED}\\Pline two")).toBe("RED line two");
  });

  it("is empty (not a throw) for fewer than two points or NaN", () => {
    expect(layoutOf({ ...mk([[0, 0], [1, 1]]), defPoints: [P(0, 0)] }).lines).toEqual([]);
    expect(layoutOf({ ...mk([[0, 0], [1, 1]]), defPoints: [P(0, 0), P(NaN, 1)] }).lines).toEqual([]);
  });
});

describe("leader as an entity kind", () => {
  it("tessellation stays inside the exact bounds and transform keeps the drawing similar", () => {
    const d = mk([[0, 0], [10, 10]], { balloon: "circle", textOverride: "3" });
    const b = kindBounds(d)!;
    for (const run of kindTessellate(d, 0.01)) for (const p of run) {
      expect(p.x).toBeGreaterThanOrEqual(b.minX - 1e-9);
      expect(p.x).toBeLessThanOrEqual(b.maxX + 1e-9);
    }
    const t = kindTransform(d, [2, 0, 0, 2, 5, 5]) as DimensionEntity;
    expect(t.defPoints[1]).toEqual(P(25, 25));
    expect(t.scale).toBe(2);
    const withBranch = kindTransform(addLeaderLine(d, P(1, 2)), [1, 0, 0, 1, 3, 0]) as DimensionEntity;
    expect(withBranch.branches![0][0]).toEqual(P(4, 2));
  });

  it("explodes to lines, a filled arrow and one TEXT for R12 / SVG / PDF writers", () => {
    const parts = explodeDimension(mk([[0, 0], [10, 10]]));
    expect(parts.some((e) => e.type === "polyline")).toBe(true);
    expect(parts.some((e) => e.type === "hatch")).toBe(true);
    const texts = parts.filter((e) => e.type === "text");
    expect(texts.length).toBe(1);
  });
});

describe("leader sketch code", () => {
  it("round trips with the same id and keeps extra leader lines on edit", () => {
    const doc = new SketchDocument();
    const bus = new CommandBus(doc);
    const base = addLeaderLine(mk([[0, 0], [10, 10]], { balloon: "square", landing: 4, leaderSpline: true, textOverride: "7" }), P(2, 30));
    bus.execute({ type: "add-entity", entity: { ...base, name: "D1" } });
    const code = toCode(doc);
    expect(code).toContain("dimension D1 leader");
    expect(code).toContain("balloon square");
    const parsed = parseCode(code);
    expect(parsed.errors).toEqual([]);
    expect(diffToCommands(doc, parsed.entities)).toEqual([]);
    const edited = code.replace("(10, 10)", "(12, 10)");
    for (const c of diffToCommands(doc, parseCode(edited).entities)) bus.execute(c);
    const d = doc.get("ld") as DimensionEntity;
    expect(d.defPoints[1]).toEqual(P(12, 10));
    expect(d.branches?.length).toBe(1);
    expect(d.balloon).toBe("square");
    expect(d.landing).toBe(4);
    expect(d.leaderSpline).toBe(true);
  });

  it("keeps all the points of a bent leader (the kind has no fixed count)", () => {
    const parsed = parseCode('dimension D1 leader (0, 0) (5, 5) (9, 5) (12, 9) text "A"');
    expect(parsed.errors).toEqual([]);
    expect((parsed.entities[0] as { pts: unknown[] }).pts.length).toBe(4);
    expect(parseCode("dimension D1 leader (0, 0)").errors.length).toBe(1);
  });
});

describe("leader operations", () => {
  it("builds nothing from a single point and drops repeated clicks", () => {
    expect(buildLeader([P(0, 0)])).toBeNull();
    expect(buildLeader([P(0, 0), P(0, 0), P(5, 5)])!.defPoints.length).toBe(2);
  });

  it("removes lines: a branch is promoted when the main line goes, the last line cannot go", () => {
    const d = addLeaderLine(addLeaderLine(mk([[0, 0], [10, 10]]), P(0, 20)), P(0, 30));
    expect(leaderLineCount(d)).toBe(3);
    const noMain = removeLeaderLine(d, 0)!;
    expect(noMain.defPoints).toEqual([P(0, 20), P(10, 10)]);
    expect(leaderLineCount(noMain)).toBe(2);
    const noSecond = removeLeaderLine(d, 2)!;
    expect(noSecond.branches).toEqual([[P(0, 20)]]);
    expect(removeLeaderLine(mk([[0, 0], [10, 10]]), 0)).toBeNull();
    expect(removeLeaderLine(d, 9)).toBeNull();
  });

  it("aligns and stacks attach points without touching the tips", () => {
    const a = mk([[0, 0], [10, 10]]);
    const b = { ...mk([[3, 3], [20, 14]]), id: "b" };
    const [, bb] = alignLeaders([a, b], "horizontal");
    expect(bb.defPoints[1]).toEqual(P(20, 10));
    expect(bb.defPoints[0]).toEqual(P(3, 3));
    const [, bv] = alignLeaders([a, b], "vertical");
    expect(bv.defPoints[1]).toEqual(P(10, 14));
    const [, bc] = collectLeaders([a, b], 8);
    expect(bc.defPoints[1]).toEqual(P(10, 2));
    expect(alignLeaders([a], "horizontal")).toEqual([]);
  });

  it("numbers balloons from the highest number in use", () => {
    expect(nextBalloonNumber([])).toBe(1);
    const e = (n: string) => ({ type: "dimension", balloon: "circle", textOverride: n });
    expect(nextBalloonNumber([e("1"), e("4"), e("x"), { type: "line" }])).toBe(5);
  });
});
