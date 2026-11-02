/**
 * Why this matters: the Authoring palette is the only way a user builds a
 * dynamic block, and a spec that silently loses an action when a parameter is
 * renamed or deleted gives instances that no longer move. The edits must keep
 * the spec consistent, refuse nonsense, and the validator must name what is
 * wrong. The shipped fixtures double as end-to-end checks of the whole route.
 */
import { describe, expect, it } from "vitest";
import "../kinds/builtin";
import {
  addAction,
  addParam,
  addVisibilityState,
  markDimension,
  moveAction,
  removeAction,
  removeParam,
  removeVisibilityState,
  setLookupTable,
  setStateVisibility,
  specForSave,
  uniqueParamName,
  updateParam,
  validateSpec,
} from "./authoring";
import { evaluateDynamic, type DynamicSpec, type LinearParam } from "./dynamic";
import { fixtureBlocks, fixtureDoor, fixtureSlot, fixtureWindow } from "./dynamicFixtures";
import type { LineEntity } from "../entities";

const lin = (name: string): LinearParam => ({ kind: "linear", name, base: { x: 0, y: 0 }, end: { x: 10, y: 0 } });
const L = (e: unknown): LineEntity => e as LineEntity;

describe("B-21 spec edits", () => {
  it("adds params with unique names and refuses duplicates, dotted names, a second visibility param", () => {
    let s = addParam(undefined, lin("A"));
    expect(s.params).toHaveLength(1);
    expect(addParam(s, lin("A"))).toBe(s);
    expect(addParam(s, lin("a.b"))).toBe(s);
    expect(addParam(s, lin(" "))).toBe(s);
    s = addParam(s, { kind: "visibility", name: "V" });
    expect(addParam(s, { kind: "visibility", name: "V2" })).toBe(s);
    expect(uniqueParamName(s, "A")).toBe("A1");
    s = addParam(s, { kind: "polar", name: "P", base: { x: 0, y: 0 }, end: { x: 1, y: 0 } });
    expect(addParam(s, lin("P.angle"))).toBe(s);
  });
  it("attaches actions only to compatible params; removing a param drops its actions; renaming follows", () => {
    let s = addParam(undefined, lin("W"));
    s = addParam(s, { kind: "flip", name: "F", base: { x: 0, y: 0 }, end: { x: 0, y: 1 } });
    expect(addAction(s, { kind: "flip", param: "W" })).toBe(s);
    expect(addAction(s, { kind: "stretch", param: "nope", frame: { min: { x: 0, y: 0 }, max: { x: 1, y: 1 } } })).toBe(s);
    s = addAction(s, { kind: "scale", param: "W" });
    s = addAction(s, { kind: "flip", param: "F" });
    const renamed = updateParam(s, "W", lin("Width"));
    expect(renamed.actions[0]).toMatchObject({ kind: "scale", param: "Width" });
    expect(updateParam(s, "W", lin("F"))).toBe(s);
    const removed = removeParam(s, "W");
    expect(removed.params.map((p) => p.name)).toEqual(["F"]);
    expect(removed.actions).toHaveLength(1);
    expect(moveAction(s, 0, 1).actions.map((a) => a.kind)).toEqual(["flip", "scale"]);
    expect(moveAction(s, 0, -1)).toBe(s);
    expect(removeAction(s, 0).actions).toHaveLength(1);
  });
  it("manages visibility states and lookup tables", () => {
    let s = addParam(undefined, { kind: "visibility", name: "V" });
    s = addVisibilityState(s, "One", ["a"]);
    expect(addVisibilityState(s, "One")).toBe(s);
    s = addVisibilityState(s, "Two");
    s = setStateVisibility(s, "Two", ["a", "b"], true);
    s = setStateVisibility(s, "Two", ["a"], false);
    expect(s.visibilityStates![1].visible).toEqual(["b"]);
    expect(removeVisibilityState(removeVisibilityState(s, "One"), "Two").visibilityStates).toBeUndefined();
    const t = setLookupTable(s, { name: "T", inputs: [], rows: [] });
    expect(setLookupTable(t, { name: "T", inputs: ["x"], rows: [] }).lookup).toHaveLength(1);
  });
  it("marks a distance constraint as a block parameter, once; other constraints refused", () => {
    const slot = fixtureSlot();
    const s = markDimension(undefined, slot.constraints!, "len");
    expect(s.params[0]).toMatchObject({ kind: "dimension", constraintId: "len", name: "Length1" });
    expect(markDimension(s, slot.constraints!, "len")).toBe(s);
    expect(markDimension(undefined, slot.constraints!, "hz").params).toHaveLength(0);
  });
  it("specForSave drops an empty spec", () => {
    expect(specForSave({ params: [], actions: [] })).toBeUndefined();
    expect(specForSave(undefined)).toBeUndefined();
  });
});

describe("validateSpec", () => {
  const ids = new Set(["a", "b"]);
  it("passes the shipped fixtures against their own entities", () => {
    for (const d of fixtureBlocks()) {
      const problems = validateSpec(d.dynamic as DynamicSpec, new Set(d.entities.map((e) => e.id)), new Set((d.constraints ?? []).map((c) => c.id)));
      expect(problems, d.name).toEqual([]);
    }
  });
  it("names dangling references and incomplete params", () => {
    const spec: DynamicSpec = {
      params: [{ kind: "visibility", name: "V" }, { kind: "lookup", name: "L", table: "gone" }, { kind: "dimension", name: "D", constraintId: "zz" }],
      actions: [{ kind: "array", param: "X", spacing: 0 }, { kind: "move", param: "V", entities: ["a", "dead"] }],
      visibilityStates: [{ name: "S", visible: ["dead"] }],
    };
    const text = validateSpec(spec, ids, new Set()).join("\n");
    for (const needle of ["missing parameter", "cannot use a visibility", "deleted object", "missing lookup table", "no lookup action", "deleted constraint"]) expect(text).toContain(needle);
  });
});

describe("fixture blocks end to end", () => {
  it("window: width stretches the right edge only; flip mirrors about the mid line", () => {
    const w = fixtureWindow();
    const wide = evaluateDynamic(w, { Width: 1250 });
    expect(L(wide.find((e) => e.id === "r")).a.x).toBe(1300); // snapped to the 100 step
    expect(L(wide.find((e) => e.id === "l")).a.x).toBe(0);
    const flipped = evaluateDynamic(w, { Flip: 1 });
    expect(L(flipped.find((e) => e.id === "sill")).b.y).toBeCloseTo(120, 9); // -20 mirrored about y=50
  });
  it("door: visibility hides the second leaf; the lookup row sets the opening", () => {
    const d = fixtureDoor();
    expect(evaluateDynamic(d, {}).some((e) => e.id === "leafB")).toBe(false);
    expect(evaluateDynamic(d, { Type: "Double" }).some((e) => e.id === "leafB")).toBe(true);
    const narrow = evaluateDynamic(d, { Type: "Double", Size: "Narrow" });
    expect(L(narrow.find((e) => e.id === "jambR")).a.x).toBe(700);
  });
  it("slot: the dimension param drives the solved length", () => {
    const out = L(evaluateDynamic(fixtureSlot(), { Length: 35 })[0]);
    expect(Math.hypot(out.b.x - out.a.x, out.b.y - out.a.y)).toBeCloseTo(35, 5);
  });
});
