/**
 * T-45: the expression language and the params table. A wrong value here
 * silently resizes a customer's part, so precedence, units, cycles and the
 * one-undo-step guarantee of a parameter edit are pinned.
 */
import { describe, expect, it } from "vitest";
import { CommandBus } from "./commands";
import { SketchDocument } from "./document";
import { evaluateExpr, evaluateValue, paramNameError, resolveParams, validateParam } from "./expr";
import "./kinds/builtin";

const ev = (s: string, env: Record<string, number> = {}) => {
  const r = evaluateExpr(s, new Map(Object.entries(env)));
  return r.ok ? r.value : `ERR:${r.error}`;
};

describe("expression evaluator", () => {
  it("honours precedence, right-associative power and unary minus", () => {
    expect(ev("1 + 2 * 3")).toBe(7);
    expect(ev("(1 + 2) * 3")).toBe(9);
    expect(ev("2 ^ 3 ^ 2")).toBe(512);
    expect(ev("-2 ^ 2")).toBe(-4);
    expect(ev("10 % 4")).toBe(2);
    expect(ev("width / 2 + 5", { width: 100 })).toBe(55);
  });
  it("reads units and constants", () => {
    expect(ev("2in + 5mm")).toBeCloseTo(55.8);
    expect(ev("(1 + 1)cm")).toBe(20);
    expect(ev("180deg")).toBeCloseTo(Math.PI);
    expect(ev("sin(90deg)")).toBeCloseTo(1);
    expect(ev("2 * pi")).toBeCloseTo(2 * Math.PI);
    expect(ev("1.5e2")).toBe(150);
  });
  it("evaluates functions", () => {
    expect(ev("sqrt(a^2 + b^2)", { a: 3, b: 4 })).toBe(5);
    expect(ev("max(1, 5, 3)")).toBe(5);
    expect(ev("atan2(1, 1)")).toBeCloseTo(Math.PI / 4);
  });
  it("rejects malformed input without throwing", () => {
    for (const bad of ["", "1 +", "(1", "1 2", "foo(1)", "sqrt()", "sqrt(1,2)", "$", "mm", "1/0", "q"]) {
      expect(String(ev(bad))).toMatch(/^ERR:/);
    }
    expect(String(ev("sqrt(-1)"))).toMatch(/^ERR:/);
  });
  it("angle context: bare numbers are degrees, units/params are taken as radians", () => {
    const a = evaluateValue("90", new Map(), "angle");
    expect(a.ok && a.value).toBeCloseTo(Math.PI / 2);
    const b = evaluateValue("90deg", new Map(), "angle");
    expect(b.ok && b.value).toBeCloseTo(Math.PI / 2);
  });
});

describe("params table", () => {
  it("resolves in dependency order and flags cycles / unknowns", () => {
    const r = resolveParams([
      { name: "b", expression: "a * 2" },
      { name: "a", expression: "10" },
      { name: "x", expression: "y + 1" },
      { name: "y", expression: "x + 1" },
      { name: "z", expression: "nope" },
      { name: "w", expression: "x" },
    ]);
    expect(r.get("b")?.value).toBe(20);
    expect(r.get("x")?.error).toMatch(/Circular/);
    expect(r.get("z")?.error).toMatch(/Unknown/);
    expect(r.get("w")?.value).toBeUndefined();
  });
  it("validates names and cycles before a put", () => {
    expect(paramNameError("1a")).not.toBeNull();
    expect(paramNameError("mm")).not.toBeNull();
    expect(paramNameError("width")).toBeNull();
    expect(validateParam([{ name: "a", expression: "b" }, { name: "b", expression: "1" }], "b", "a")).toMatch(/Circular/);
  });
});

describe("put-param / delete-param", () => {
  it("a parameter change re-drives a dimension and its geometry in ONE undo step", () => {
    const doc = new SketchDocument();
    const bus = new CommandBus(doc);
    bus.execute({ type: "add-entity", entity: { id: "k0", type: "point", p: { x: 0, y: 0 } } });
    bus.execute({ type: "add-entity", entity: { id: "c1", type: "circle", center: { x: 0, y: 50 }, radius: 10 } });
    bus.execute({ type: "put-param", name: "r", expression: "10" });
    bus.execute({
      type: "add-entity",
      entity: { id: "d1", type: "dimension", kind: "radial", defPoints: [{ x: 0, y: 50 }, { x: 10, y: 50 }, { x: 10, y: 50 }], target: "c1", driving: true, value: 10, expression: "r * 2" },
    });
    bus.execute({ type: "put-param", name: "r", expression: "10" }); // refresh expression value (20)
    expect((doc.get("c1") as { radius: number }).radius).toBeCloseTo(20);
    const before = JSON.stringify(doc.toJSON());
    bus.execute({ type: "put-param", name: "r", expression: "4" });
    expect((doc.get("d1") as { value: number }).value).toBe(8);
    expect((doc.get("c1") as { radius: number }).radius).toBeCloseTo(8);
    bus.undo();
    expect(JSON.stringify(doc.toJSON())).toBe(before);
    bus.redo();
    expect((doc.get("c1") as { radius: number }).radius).toBeCloseTo(8);
  });

  it("an explicit constraint with an expression follows too; bad or cyclic puts are ignored", () => {
    const doc = new SketchDocument();
    const bus = new CommandBus(doc);
    bus.execute({ type: "add-entity", entity: { id: "c1", type: "circle", center: { x: 0, y: 0 }, radius: 3 } });
    bus.execute({ type: "put-param", name: "r", expression: "5" });
    bus.execute({ type: "add-constraint", constraint: { id: "k1", type: "radius", entityId: "c1", value: 5, expression: "r" } });
    bus.execute({ type: "put-param", name: "r", expression: "7" });
    expect((doc.get("c1") as { radius: number }).radius).toBeCloseTo(7);
    bus.execute({ type: "put-param", name: "r", expression: "r + 1" });
    bus.execute({ type: "put-param", name: "bad name", expression: "1" });
    expect(doc.records("params")).toEqual([{ name: "r", expression: "7" }]);
    bus.execute({ type: "delete-param", name: "r" });
    expect(doc.records("params")).toEqual([]);
    bus.undo();
    expect(doc.records("params")).toHaveLength(1);
  });
});
