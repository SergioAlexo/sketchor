import { describe, expect, it } from "vitest";
import type { Constraint } from "../constraints";
import type { Entity, LineEntity } from "../entities";
import { solveSketch } from "./solve";

/**
 * K-02. Two promises: a drawing full of independent constrained sketches
 * solves fast (components are solved separately, so cost follows the
 * biggest sketch, not the whole file), and the solver stays on the branch
 * nearest the current geometry in the classic "flip" cases — a tangent
 * that jumps to the other side of a circle is a sketch that rearranges
 * itself when the user nudges a dimension.
 */

const line = (id: string, ax: number, ay: number, bx: number, by: number): LineEntity => ({
  id,
  type: "line",
  a: { x: ax, y: ay },
  b: { x: bx, y: by },
});
const circle = (id: string, cx: number, cy: number, r: number): Entity => ({ id, type: "circle", center: { x: cx, y: cy }, radius: r });
const get = <T extends Entity>(updates: Entity[], entities: Entity[], id: string): T =>
  (updates.find((e) => e.id === id) ?? entities.find((e) => e.id === id)) as T;

/** A slightly skewed rectangle: 4 coincident + 2 horizontal + 2 vertical + 1 distance... = 9 constraints. */
function skewedRect(n: number): { entities: Entity[]; constraints: Constraint[] } {
  const x = (n % 10) * 100;
  const y = Math.floor(n / 10) * 100;
  const ids = [`r${n}a`, `r${n}b`, `r${n}c`, `r${n}d`];
  const entities = [
    line(ids[0], x, y, x + 50, y + 2),
    line(ids[1], x + 50.5, y + 2, x + 52, y + 30),
    line(ids[2], x + 52, y + 30, x + 1, y + 31),
    line(ids[3], x + 0.5, y + 30, x, y + 0.3),
  ];
  const joint = (k: number, a: string, b: string): Constraint => ({
    id: `r${n}j${k}`,
    type: "coincident",
    a: { entityId: a, point: "b" },
    b: { entityId: b, point: "a" },
  });
  const constraints: Constraint[] = [
    joint(0, ids[0], ids[1]),
    joint(1, ids[1], ids[2]),
    joint(2, ids[2], ids[3]),
    joint(3, ids[3], ids[0]),
    { id: `r${n}h0`, type: "horizontal", entityId: ids[0] },
    { id: `r${n}h1`, type: "horizontal", entityId: ids[2] },
    { id: `r${n}v0`, type: "vertical", entityId: ids[1] },
    { id: `r${n}v1`, type: "vertical", entityId: ids[3] },
    { id: `r${n}d`, type: "distance", a: { entityId: ids[0], point: "a" }, b: { entityId: ids[0], point: "b" }, value: 60 },
  ];
  return { entities, constraints };
}

describe("solver at scale", () => {
  it("solves 500+ constraints across independent sketches quickly, and every sketch converges", () => {
    const entities: Entity[] = [];
    const constraints: Constraint[] = [];
    for (let n = 0; n < 60; n++) {
      const r = skewedRect(n);
      entities.push(...r.entities);
      constraints.push(...r.constraints);
    }
    expect(constraints.length).toBeGreaterThanOrEqual(500);
    let best = Infinity;
    let result = solveSketch(entities, constraints);
    for (let i = 0; i < 3; i++) {
      const t = performance.now();
      result = solveSketch(entities, constraints);
      best = Math.min(best, performance.now() - t);
    }
    expect(result.converged).toBe(true);
    expect(result.conflicts).toEqual([]);
    expect(best).toBeLessThan(50);
    // Spot-check one: the first rectangle's bottom edge is now 60 long and level.
    const a = get<LineEntity>(result.updates, entities, "r0a");
    expect(a.a.y).toBeCloseTo(a.b.y, 8);
    expect(Math.hypot(a.b.x - a.a.x, a.b.y - a.a.y)).toBeCloseTo(60, 8);
  });

  it("gives the same answer as solving one sketch alone", () => {
    const alone = skewedRect(0);
    const together = [skewedRect(0), skewedRect(1), skewedRect(2)];
    const a = solveSketch(alone.entities, alone.constraints);
    const b = solveSketch(
      together.flatMap((r) => r.entities),
      together.flatMap((r) => r.constraints),
    );
    for (const e of a.updates) {
      expect(b.updates.find((u) => u.id === e.id)).toEqual(e);
    }
    expect(b.dof).toBe(a.dof * 3);
  });

  it("counts unconstrained geometry's freedom without solving it", () => {
    const r = solveSketch([line("l", 0, 0, 1, 1), circle("c", 0, 0, 1), ...skewedRect(0).entities], skewedRect(0).constraints);
    expect(r.dof).toBe(4 + 3 + solveSketch(skewedRect(0).entities, skewedRect(0).constraints).dof);
  });

  it("sends a drag only to the component it belongs to", () => {
    const a = skewedRect(0);
    const b = skewedRect(1);
    const all = [...a.entities, ...b.entities];
    const cs = [...a.constraints, ...b.constraints];
    // Settle both first, so any later movement of the second can only come from the drag.
    const settled = solveSketch(all, cs);
    const entities = all.map((e) => settled.updates.find((u) => u.id === e.id) ?? e);
    const r = solveSketch(entities, cs, { drag: { ref: { entityId: "r0b", point: "b" }, to: { x: 80, y: 40 } } });
    expect(r.conflicts).toEqual([]);
    expect(r.updates.some((e) => e.id.startsWith("r0"))).toBe(true);
    expect(r.updates.some((e) => e.id.startsWith("r1"))).toBe(false);
  });

  it("copes with a very large unconstrained drawing (no argument-spread blowups)", () => {
    const many: Entity[] = [];
    for (let i = 0; i < 20000; i++) many.push(line(`l${i}`, i, 0, i, 1));
    const r = solveSketch(many, [{ id: "k", type: "horizontal", entityId: "l0" }]);
    expect(r.dof).toBe(20000 * 4 - 1);
  });
});

describe("staying on the nearest branch", () => {
  it("keeps a tangent line on the side of the circle it started on", () => {
    const entities = [circle("c", 0, 0, 5), line("l", 6.5, -10, 6.5, 10)];
    const cs: Constraint[] = [
      { id: "f", type: "fix", entityId: "c" },
      { id: "t", type: "tangent", a: "l", b: "c" },
    ];
    const r = solveSketch(entities, cs);
    const l = get<LineEntity>(r.updates, entities, "l");
    expect(Math.min(l.a.x, l.b.x)).toBeGreaterThan(4.9);
  });

  it("keeps it on the left side when it started there", () => {
    const entities = [circle("c", 0, 0, 5), line("l", -6.5, -10, -6.5, 10)];
    const r = solveSketch(entities, [
      { id: "f", type: "fix", entityId: "c" },
      { id: "t", type: "tangent", a: "l", b: "c" },
    ]);
    const l = get<LineEntity>(r.updates, entities, "l");
    expect(Math.max(l.a.x, l.b.x)).toBeLessThan(-4.9);
  });

  it("resolves an angle near 180 degrees to the antiparallel line, not the parallel one", () => {
    // Lines at 170 degrees to each other, asked for exactly 180.
    const a = (170 * Math.PI) / 180;
    const entities = [line("a", 0, 0, 10, 0), line("b", 20, 0, 20 + 10 * Math.cos(a), 10 * Math.sin(a))];
    const r = solveSketch(entities, [
      { id: "f", type: "fix", entityId: "a" },
      { id: "k", type: "angle", a: "a", b: "b", value: Math.PI },
    ]);
    const b = get<LineEntity>(r.updates, entities, "b");
    expect(b.b.x - b.a.x).toBeLessThan(0);
    expect(Math.abs(b.b.y - b.a.y)).toBeLessThan(1e-6);
  });

  it("keeps a perpendicular's handedness when nudged", () => {
    const entities = [line("a", 0, 0, 10, 0), line("b", 5, 0, 5.4, 8)];
    const r = solveSketch(entities, [
      { id: "f", type: "fix", entityId: "a" },
      { id: "p", type: "perpendicular", a: "a", b: "b" },
    ]);
    const b = get<LineEntity>(r.updates, entities, "b");
    expect(b.b.y).toBeGreaterThan(b.a.y); // still pointing up, not flipped down
  });

  it("does not swing a line the long way round to satisfy horizontal", () => {
    const entities = [line("l", 0, 0, -10, 0.5)];
    const r = solveSketch(entities, [{ id: "h", type: "horizontal", entityId: "l" }]);
    const l = get<LineEntity>(r.updates, entities, "l");
    expect(l.b.x - l.a.x).toBeLessThan(0); // still runs right-to-left
  });
});
