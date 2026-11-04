/**
 * T-08 quick edit: retyping the length/radius of what was just drawn must
 * keep the anchor end and direction, ignore unusable input instead of
 * collapsing the entity, and (in sketch mode) leave one driving dimension
 * that the solver is already satisfied by — all as a single undo step.
 */
import { describe, expect, it } from "vitest";
import { CommandBus } from "./commands";
import { SketchDocument } from "./document";
import type { ArcEntity, CircleEntity, DimensionEntity, LineEntity } from "./entities";
import "./kinds/builtin";
import { applyQuickEdit, quickEditCommands, quickEditTarget } from "./quickEdit";

const line = (over: Partial<LineEntity> = {}): LineEntity => ({ id: "l1", type: "line", a: { x: 10, y: 10 }, b: { x: 10, y: 40 }, ...over });
const circle: CircleEntity = { id: "c1", type: "circle", center: { x: 5, y: 5 }, radius: 3 };
const arc: ArcEntity = { id: "a1", type: "arc", center: { x: 0, y: 0 }, radius: 4, startAngle: 0, endAngle: Math.PI / 2, ccw: true };

describe("quickEditTarget", () => {
  it("names length for a line and radius for a circle or arc", () => {
    expect(quickEditTarget(line())).toEqual({ kind: "length", value: 30 });
    expect(quickEditTarget(circle)).toEqual({ kind: "radius", value: 3 });
    expect(quickEditTarget(arc)).toEqual({ kind: "radius", value: 4 });
  });
  it("has nothing to edit on a zero-length line, an infinite line, a point", () => {
    expect(quickEditTarget(line({ b: { x: 10, y: 10 } }))).toBeNull();
    expect(quickEditTarget(line({ infinite: true }))).toBeNull();
    expect(quickEditTarget({ id: "p", type: "point", p: { x: 0, y: 0 } })).toBeNull();
  });
});

describe("applyQuickEdit", () => {
  it("moves the far end of a line along its direction, keeping the first end", () => {
    const e = applyQuickEdit(line(), 50) as LineEntity;
    expect(e.a).toEqual({ x: 10, y: 10 });
    expect(e.b.x).toBeCloseTo(10, 9);
    expect(e.b.y).toBeCloseTo(60, 9);
  });
  it("keeps a diagonal line's angle", () => {
    const e = applyQuickEdit(line({ a: { x: 0, y: 0 }, b: { x: 3, y: 4 } }), 10) as LineEntity;
    expect(e.b.x).toBeCloseTo(6, 9);
    expect(e.b.y).toBeCloseTo(8, 9);
  });
  it("changes only the radius of a circle and the radius (not the sweep) of an arc", () => {
    expect(applyQuickEdit(circle, 7)).toEqual({ ...circle, radius: 7 });
    expect(applyQuickEdit(arc, 9)).toEqual({ ...arc, radius: 9 });
  });
  it("refuses zero, negative, NaN and infinite values", () => {
    for (const v of [0, -5, NaN, Infinity, 1e-12]) {
      expect(applyQuickEdit(line(), v)).toBeNull();
      expect(applyQuickEdit(circle, v)).toBeNull();
    }
  });
});

describe("quickEditCommands", () => {
  it("is empty for an unusable value", () => {
    expect(quickEditCommands(line(), 0)).toEqual([]);
  });

  it("drafting: one update-entity, undone in one step", () => {
    const doc = new SketchDocument();
    const bus = new CommandBus(doc);
    bus.execute({ type: "add-entity", entity: line() });
    const cmds = quickEditCommands(line(), 50);
    expect(cmds).toHaveLength(1);
    bus.execute({ type: "batch", commands: cmds });
    expect((doc.get("l1") as LineEntity).b.y).toBeCloseTo(60, 9);
    bus.undo();
    expect((doc.get("l1") as LineEntity).b.y).toBeCloseTo(40, 9);
  });

  it("sketch mode: the driving dimension holds the typed value and the solver leaves the geometry alone", () => {
    const doc = new SketchDocument();
    const bus = new CommandBus(doc);
    bus.execute({ type: "add-entity", entity: line() });
    bus.execute({ type: "batch", commands: quickEditCommands(line(), 50, { driving: true }) });
    const dims = [...doc.all()].filter((e): e is DimensionEntity => e.type === "dimension");
    expect(dims).toHaveLength(1);
    expect(dims[0].driving).toBe(true);
    expect(dims[0].value).toBe(50);
    expect(doc.solverConstraints()).toHaveLength(1);
    const l = doc.get("l1") as LineEntity;
    expect(l.a).toEqual({ x: 10, y: 10 });
    expect(l.b.y).toBeCloseTo(60, 6);
    bus.undo();
    expect([...doc.all()].some((e) => e.type === "dimension")).toBe(false);
    expect((doc.get("l1") as LineEntity).b.y).toBeCloseTo(40, 9);
  });

  it("sketch mode on a circle and a sloped line", () => {
    const doc = new SketchDocument();
    const bus = new CommandBus(doc);
    bus.execute({ type: "add-entity", entity: circle });
    bus.execute({ type: "add-entity", entity: line({ id: "l2", a: { x: 0, y: 0 }, b: { x: 3, y: 4 } }) });
    bus.execute({ type: "batch", commands: quickEditCommands(circle, 8, { driving: true }) });
    bus.execute({ type: "batch", commands: quickEditCommands(doc.get("l2")!, 10, { driving: true }) });
    expect((doc.get("c1") as CircleEntity).radius).toBeCloseTo(8, 6);
    const l2 = doc.get("l2") as LineEntity;
    expect(Math.hypot(l2.b.x - l2.a.x, l2.b.y - l2.a.y)).toBeCloseTo(10, 5);
    expect(doc.solverConstraints()).toHaveLength(2);
  });
});
