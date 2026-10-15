import { describe, expect, it } from "vitest";
import { SketchDocument, type Command, type DimensionEntity, type Entity, type Point } from "@sketchor/core";
import { DimTool, type DimMode } from "./dimTools";
import type { Pick, ToolContext } from "./tool";

/**
 * The dimension tools turn clicks into DimensionEntity values. What matters
 * to a drawing: the right kind for what was clicked, associative anchors kept,
 * one undo step per user action, and Esc leaving the tool idle.
 */

function onLine(e: Entity, p: Point): boolean {
  if (e.type !== "line") return false;
  const cross = (e.b.y - e.a.y) * (p.x - e.a.x) - (e.b.x - e.a.x) * (p.y - e.a.y);
  return Math.abs(cross) < 1e-6 && p.x >= Math.min(e.a.x, e.b.x) - 1e-9 && p.x <= Math.max(e.a.x, e.b.x) + 1e-9 && p.y >= Math.min(e.a.y, e.b.y) - 1e-9 && p.y <= Math.max(e.a.y, e.b.y) + 1e-9;
}

function setup(entities: Entity[], selection: string[] = []) {
  const doc = new SketchDocument();
  for (const e of entities) doc._put(e);
  const commands: Command[] = [];
  let commits = 0;
  const hitTest = (p: Point): string[] =>
    doc
      .all()
      .filter((e) => onLine(e, p) || (e.type === "circle" && Math.abs(Math.hypot(p.x - e.center.x, p.y - e.center.y) - e.radius) < 1e-6) || (e.type === "dimension" && e.defPoints[2] && Math.hypot(e.defPoints[2].x - p.x, e.defPoints[2].y - p.y) < 1e-6))
      .map((e) => e.id);
  const run = (c: Command) => {
    commands.push(c);
    if (c.type === "add-entity") doc._put(c.entity);
  };
  const ctx = {
    doc,
    execute: run,
    commit: (cs: Command[]) => {
      commits += 1;
      cs.forEach(run);
    },
    activeLayer: () => "0",
    redraw: () => {},
    selection: () => selection,
    hitTest,
  } as unknown as ToolContext;
  const click = (t: DimTool, p: Point) => t.pick(ctx, { point: p, world: p, snap: null, shiftKey: false, ctrlKey: false, altKey: false } as unknown as Pick);
  const added = () => commands.filter((c) => c.type === "add-entity").map((c) => (c as { entity: DimensionEntity }).entity);
  return { ctx, click, added, commits: () => commits };
}
const line = (id: string, ax: number, ay: number, bx: number, by: number): Entity => ({ id, type: "line", a: { x: ax, y: ay }, b: { x: bx, y: by } });
const tool = (m: DimMode) => new DimTool("dim", m);

describe("DimTool", () => {
  it("smart: click a line, click the placement -> one attached dimension, tool idle again", () => {
    const { click, added } = setup([line("l", 0, 0, 30, 0)]);
    const t = tool("smart");
    click(t, { x: 15, y: 0 });
    expect(t.busy()).toBe(true);
    click(t, { x: 15, y: 8 });
    expect(added()).toHaveLength(1);
    expect(added()[0].kind).toBe("linear");
    expect(added()[0].refs?.[0]?.entityId).toBe("l");
    expect(t.busy()).toBe(false);
  });

  it("smart: a circle gives a diameter; two crossing lines an angle (the second line only selects)", () => {
    const c = setup([{ id: "c", type: "circle", center: { x: 0, y: 0 }, radius: 5 }]);
    const t = tool("smart");
    c.click(t, { x: 5, y: 0 });
    c.click(t, { x: 12, y: 0 });
    expect(c.added()[0].kind).toBe("diametric");
    const l = setup([line("a", 0, 0, 10, 0), line("b", 0, 0, 0, 10)]);
    const t2 = tool("smart");
    l.click(t2, { x: 6, y: 0 });
    l.click(t2, { x: 0, y: 6 });
    expect(l.added()).toHaveLength(0);
    l.click(t2, { x: 4, y: 4 });
    expect(l.added()[0].kind).toBe("angular2l");
  });

  it("two free points then a placement make a linear dimension; cancel leaves the tool idle", () => {
    const { click, added } = setup([]);
    const t = tool("linear");
    click(t, { x: 0, y: 0 });
    click(t, { x: 10, y: 5 });
    t.cancel();
    expect(t.busy()).toBe(false);
    click(t, { x: 0, y: 0 });
    click(t, { x: 10, y: 5 });
    click(t, { x: 5, y: -6 });
    expect(added()).toHaveLength(1);
    expect(added()[0].angle).toBe(0);
  });

  it("three-point angular and ordinate", () => {
    const a = setup([]);
    const t = tool("angular");
    for (const p of [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 0, y: 10 }, { x: 4, y: 4 }]) a.click(t, p);
    expect(a.added()[0].kind).toBe("angular3p");
    const o = setup([]);
    const to = tool("ordinate");
    o.click(to, { x: 12, y: 3 });
    o.click(to, { x: 12, y: 15 });
    expect(o.added()[0].axis).toBe("x");
  });

  it("continue chains from an existing dimension until Enter", () => {
    const s = setup([]);
    const first = tool("linear");
    s.click(first, { x: 0, y: 0 });
    s.click(first, { x: 10, y: 0 });
    s.click(first, { x: 5, y: -6 });
    const t = tool("continue");
    s.click(t, { x: 5, y: -6 }); // hits the dimension (its placement point)
    s.click(t, { x: 25, y: 0 });
    s.click(t, { x: 40, y: 0 });
    const dims = s.added();
    expect(dims).toHaveLength(3);
    expect(dims[2].defPoints[0]).toEqual({ x: 25, y: 0 });
    expect(t.busy()).toBe(true);
    t.key!(s.ctx, { key: "Enter" } as KeyboardEvent);
    expect(t.busy()).toBe(false);
  });

  it("qdim: a selection then the placement makes the whole chain as one batch", () => {
    const s = setup([line("a", 0, 0, 10, 0), line("b", 10, 0, 25, 0)], ["a", "b"]);
    const t = tool("qdim");
    s.click(t, { x: 0, y: 0 });
    s.click(t, { x: 12, y: -10 });
    expect(s.added()).toHaveLength(2);
    expect(s.commits()).toBe(1);
  });
});
