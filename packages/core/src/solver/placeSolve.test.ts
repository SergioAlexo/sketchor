import { describe, expect, it } from "vitest";
import { buildConstraints } from "../constraintBuilder";
import type { Constraint } from "../constraints";
import type { Entity, InsertEntity, TextEntity } from "../entities";
import { solveSketch } from "./solve";

/**
 * K-01: text anchors and block inserts join the solver. What must hold:
 * they only take part when a constraint names them (otherwise every label
 * in a drawing would add three phantom degrees of freedom), and a block's
 * placement and rotation can be pinned like any other geometry.
 */

const text = (id: string, x: number, y: number, rotation = 0): TextEntity => ({ id, type: "text", at: { x, y }, text: "A", height: 5, rotation });
const insert = (id: string, x: number, y: number, rotation = 0): InsertEntity => ({
  id,
  type: "insert",
  block: "B",
  insert: { x, y },
  scale: { x: 1, y: 1 },
  rotation,
  attributes: {},
});
const line = (id: string, ax: number, ay: number, bx: number, by: number): Entity => ({ id, type: "line", a: { x: ax, y: ay }, b: { x: bx, y: by } });
const byId = (updates: Entity[], id: string) => updates.find((e) => e.id === id);

describe("text and inserts in the solver", () => {
  it("adds no degrees of freedom while nothing constrains them", () => {
    const r = solveSketch([text("t", 1, 2), insert("i", 3, 4), line("l", 0, 0, 10, 0)], [{ id: "h", type: "horizontal", entityId: "l" }]);
    expect(r.dof).toBe(3); // the line's own: ax ay bx
  });

  it("drags a block's base point onto a line's end with a coincident constraint", () => {
    const c: Constraint = { id: "k", type: "coincident", a: { entityId: "i", point: "a" }, b: { entityId: "l", point: "b" } };
    const r = solveSketch([insert("i", 3, 4), line("l", 0, 0, 10, 0)], [c, { id: "f", type: "fix", entityId: "l" }]);
    const moved = byId(r.updates, "i") as InsertEntity;
    expect(moved.insert.x).toBeCloseTo(10, 6);
    expect(moved.insert.y).toBeCloseTo(0, 6);
    expect(r.conflicts).toEqual([]);
  });

  it("holds a text anchor at the midpoint of a line", () => {
    const c: Constraint = { id: "m", type: "midpoint", point: { entityId: "t", point: "a" }, entityId: "l" };
    const r = solveSketch([text("t", 0, 9), line("l", 0, 0, 10, 0)], [c, { id: "f", type: "fix", entityId: "l" }]);
    const t = byId(r.updates, "t") as TextEntity;
    expect(t.at.x).toBeCloseTo(5, 6);
    expect(t.at.y).toBeCloseTo(0, 6);
  });

  it("pins a block's rotation, taking the branch nearest where it is", () => {
    const c: Constraint = { id: "r", type: "rotation", entityId: "i", value: Math.PI / 2 };
    const r = solveSketch([insert("i", 0, 0, 1.2)], [c]);
    expect((byId(r.updates, "i") as InsertEntity).rotation).toBeCloseTo(Math.PI / 2, 6);
    const near = solveSketch([insert("i", 0, 0, -3)], [{ id: "r", type: "rotation", entityId: "i", value: Math.PI }]);
    // From -3 rad the closer of {pi, -pi} is -pi: it must not swing the long way round.
    expect(Math.abs((byId(near.updates, "i") as InsertEntity).rotation + Math.PI)).toBeLessThan(1e-6);
  });

  it("fix freezes a text or insert", () => {
    const r = solveSketch(
      [insert("i", 3, 4), line("l", 0, 0, 10, 0)],
      [
        { id: "f", type: "fix", entityId: "i" },
        { id: "c", type: "coincident", a: { entityId: "i", point: "a" }, b: { entityId: "l", point: "a" } },
      ],
    );
    expect(byId(r.updates, "i")).toBeUndefined();
    const l = byId(r.updates, "l") as Extract<Entity, { type: "line" }>;
    expect(l.a.x).toBeCloseTo(3, 6);
    expect(l.a.y).toBeCloseTo(4, 6);
  });

  it("builds fix, coincident and rotation constraints from a selection", () => {
    const ctx = { newId: () => "k" };
    expect(buildConstraints("fix", [insert("i", 0, 0)], ctx)).toMatchObject({ constraints: [{ type: "fix", entityId: "i" }] });
    expect(buildConstraints("rotation", [text("t", 0, 0, 0.5)], ctx)).toMatchObject({ constraints: [{ type: "rotation", value: 0.5 }] });
    expect("error" in buildConstraints("rotation", [line("l", 0, 0, 1, 1)], ctx)).toBe(true);
    const joined = buildConstraints("coincident", [text("t", 0, 0), line("l", 5, 5, 9, 9)], ctx);
    expect(joined).toMatchObject({ constraints: [{ type: "coincident" }] });
  });
});
