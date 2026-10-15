import { describe, expect, it } from "vitest";
import type { Constraint } from "./constraints";
import { entityDofStates, resolveConflictCommand } from "./dofState";
import type { Entity } from "./entities";
import { solveSketch } from "./solver/solve";

/**
 * The colours a drafter reads a sketch by: if "fully defined" is shown for
 * geometry that can still move, the user stops trusting the whole panel.
 */

const line = (id: string, ax: number, ay: number, bx: number, by: number): Entity => ({
  id,
  type: "line",
  a: { x: ax, y: ay },
  b: { x: bx, y: by },
});
const states = (es: Entity[], cs: Constraint[]) => {
  const r = solveSketch(es, cs);
  return { map: entityDofStates(cs, r), r };
};

describe("entity DOF states", () => {
  it("leaves unconstrained geometry out entirely", () => {
    const { map } = states([line("a", 0, 0, 10, 0), line("b", 0, 5, 10, 5)], [{ id: "k1", type: "horizontal", entityId: "a" }]);
    expect(map.has("b")).toBe(false);
    expect(map.get("a")).toBe("under");
  });

  it("marks a fixed line fully defined and a line hung off it under-defined", () => {
    const es = [line("a", 0, 0, 10, 0), line("b", 10, 0, 10, 8)];
    const cs: Constraint[] = [
      { id: "f", type: "fix", entityId: "a" },
      { id: "c", type: "coincident", a: { entityId: "a", point: "b" }, b: { entityId: "b", point: "a" } },
    ];
    const { map } = states(es, cs);
    expect(map.get("a")).toBe("full");
    expect(map.get("b")).toBe("under");
  });

  it("turns fully defined once every freedom is taken", () => {
    const es = [line("a", 0, 0, 10, 0), line("b", 10, 0, 10, 8)];
    const cs: Constraint[] = [
      { id: "f", type: "fix", entityId: "a" },
      { id: "c", type: "coincident", a: { entityId: "a", point: "b" }, b: { entityId: "b", point: "a" } },
      { id: "v", type: "vertical", entityId: "b" },
      { id: "d", type: "distance", a: { entityId: "b", point: "a" }, b: { entityId: "b", point: "b" }, value: 8 },
    ];
    const { map, r } = states(es, cs);
    expect(r.status).toBe("fully-constrained");
    expect(map.get("b")).toBe("full");
    expect(r.underDefined).toEqual([]);
  });

  it("marks geometry held by contradictory constraints as conflicting", () => {
    const es = [line("a", 0, 0, 10, 0), line("b", 0, 3, 7, 3)];
    const cs: Constraint[] = [
      { id: "h1", type: "horizontal", entityId: "a" },
      { id: "p", type: "perpendicular", a: "a", b: "b" },
      { id: "h2", type: "horizontal", entityId: "b" },
    ];
    const { map } = states(es, cs);
    expect([...map.values()]).toContain("conflict");
  });

  it("copes with no solve result and no constraints", () => {
    expect(entityDofStates([], null).size).toBe(0);
    expect(entityDofStates([], solveSketch([], [])).size).toBe(0);
  });
});

describe("resolveConflictCommand", () => {
  it("removes a plain constraint", () => {
    expect(resolveConflictCommand("k9", () => undefined)).toEqual({ type: "remove-constraint", id: "k9" });
  });
  it("turns a driving dimension into a reference", () => {
    const dim = { id: "d1", type: "dimension", driving: true } as unknown as Entity;
    expect(resolveConflictCommand("dim:d1", (id) => (id === "d1" ? dim : undefined))).toMatchObject({
      type: "update-entity",
      entity: { id: "d1", driving: false },
    });
    expect(resolveConflictCommand("dim:gone", () => undefined)).toBeNull();
  });
});
