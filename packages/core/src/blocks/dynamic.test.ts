/**
 * Why this matters: a dynamic block is geometry that changes with stored
 * values. A wrong stretch frame, a visibility state that hides the wrong
 * entity, or a value that escapes its value set produces a drawing that looks
 * plausible but is the wrong size. Each B-20 action, the value-set snapping,
 * the constraint ("dimension") route, grips and the integration with the one
 * placement path (evaluateInsert) are pinned here against hand-computed geometry.
 */
import { describe, expect, it } from "vitest";
import { SketchDocument } from "../document";
import type { Entity, InsertEntity, LineEntity } from "../entities";
import "../kinds/builtin";
import { evaluateInsert } from "./evaluate";
import { withBlocks } from "./context";
import {
  applyParamGrip,
  defaultParamValues,
  dynamicSpecOf,
  evaluateDynamic,
  paramFields,
  paramGrips,
  resetParams,
  resolveParamValues,
  snapToValueSet,
  withParamValue,
  type DynamicSpec,
} from "./dynamic";
import type { BlockDefinition } from "./types";

const line = (id: string, ax: number, ay: number, bx: number, by: number): LineEntity => ({ id, type: "line", a: { x: ax, y: ay }, b: { x: bx, y: by } });
const def = (entities: Entity[], dynamic: DynamicSpec | undefined, over: Partial<BlockDefinition> = {}): BlockDefinition => ({
  name: "D",
  basePoint: { x: 0, y: 0 },
  entities,
  attributeDefs: [],
  explodable: true,
  scaleUniformly: false,
  ...(dynamic ? { dynamic } : {}),
  ...over,
});
const insert = (params?: InsertEntity["params"], over: Partial<InsertEntity> = {}): InsertEntity => ({
  id: "I",
  type: "insert",
  block: "D",
  insert: { x: 0, y: 0 },
  scale: { x: 1, y: 1 },
  rotation: 0,
  attributes: {},
  ...(params ? { params } : {}),
  ...over,
});
const L = (e: Entity | undefined): LineEntity => e as LineEntity;
const find = (list: Entity[], id: string): Entity => list.find((e) => e.id === id)!;

/** A 10x4 rectangle of four lines; width param stretches the right edge. */
const rect = (): Entity[] => [line("b", 0, 0, 10, 0), line("t", 0, 4, 10, 4), line("l", 0, 0, 0, 4), line("r", 10, 0, 10, 4)];
const widthSpec = (extra: Partial<DynamicSpec> = {}): DynamicSpec => ({
  params: [{ kind: "linear", name: "width", base: { x: 0, y: 0 }, end: { x: 10, y: 0 }, values: { min: 2, max: 20, increment: 1 } }],
  actions: [{ kind: "stretch", param: "width", frame: { min: { x: 9, y: -1 }, max: { x: 11, y: 5 } } }],
  ...extra,
});

describe("value sets", () => {
  it("snaps to a list, an increment (from min) and clamps", () => {
    expect(snapToValueSet(7.4, { list: [3, 6, 9] })).toBe(6);
    expect(snapToValueSet(7.4, { min: 2, max: 20, increment: 2 })).toBe(8);
    expect(snapToValueSet(99, { min: 2, max: 20 })).toBe(20);
    expect(snapToValueSet(-5, { min: 2, max: 20 })).toBe(2);
    expect(snapToValueSet(1.23, undefined)).toBe(1.23);
  });
  it("resolve fills defaults, snaps numbers, drops bad names", () => {
    const d = def(rect(), widthSpec());
    const spec = dynamicSpecOf(d)!;
    expect(defaultParamValues(d, spec)).toEqual({ width: 10 });
    expect(resolveParamValues(d, spec, { width: 14.4, junk: 3 })).toEqual({ width: 14 });
    expect(resolveParamValues(d, spec, { width: "abc" })).toEqual({ width: 10 });
  });
});

describe("B-20 actions", () => {
  it("stretch moves only the points inside the frame", () => {
    const d = def(rect(), widthSpec());
    const out = evaluateDynamic(d, { width: 15 });
    expect(L(find(out, "b")).b.x).toBe(15);
    expect(L(find(out, "b")).a.x).toBe(0);
    expect(L(find(out, "r")).a.x).toBe(15);
    expect(L(find(out, "r")).b.x).toBe(15);
    expect(L(find(out, "l")).a.x).toBe(0);
  });
  it("the default values leave the body untouched, and the input is never mutated", () => {
    const d = def(rect(), widthSpec());
    expect(evaluateDynamic(d, {})).toEqual(d.entities);
    evaluateDynamic(d, { width: 18 });
    expect(L(d.entities[3]).a.x).toBe(10);
  });
  it("stretch honours the selection set and the multiplier", () => {
    const spec = widthSpec();
    spec.actions = [{ kind: "stretch", param: "width", frame: { min: { x: 9, y: -1 }, max: { x: 11, y: 5 } }, entities: ["r"], multiplier: 0.5 }];
    const out = evaluateDynamic(def(rect(), spec), { width: 14 });
    expect(L(find(out, "r")).a.x).toBe(12);
    expect(L(find(out, "b")).b.x).toBe(10);
  });
  it("move translates the whole selection", () => {
    const spec: DynamicSpec = { params: [{ kind: "xy", name: "p", base: { x: 0, y: 0 } }], actions: [{ kind: "move", param: "p", entities: ["l"] }] };
    const out = evaluateDynamic(def(rect(), spec), { "p.x": 3, "p.y": -2 });
    expect(L(find(out, "l")).a).toEqual({ x: 3, y: -2 });
    expect(L(find(out, "r")).a).toEqual({ x: 10, y: 0 });
  });
  it("polar-stretch follows the end of a polar param", () => {
    const spec: DynamicSpec = {
      params: [{ kind: "polar", name: "arm", base: { x: 0, y: 0 }, end: { x: 10, y: 0 } }],
      actions: [{ kind: "polar-stretch", param: "arm", frame: { min: { x: 9, y: -1 }, max: { x: 11, y: 1 } } }],
    };
    const d = def([line("a", 0, 0, 10, 0)], spec);
    const out = evaluateDynamic(d, { arm: 5, "arm.angle": Math.PI / 2 });
    expect(L(out[0]).b.x).toBeCloseTo(0, 9);
    expect(L(out[0]).b.y).toBeCloseTo(5, 9);
  });
  it("scale scales about the param base by value/default", () => {
    const spec: DynamicSpec = { params: [{ kind: "linear", name: "s", base: { x: 0, y: 0 }, end: { x: 10, y: 0 } }], actions: [{ kind: "scale", param: "s" }] };
    const out = evaluateDynamic(def(rect(), spec), { s: 20 });
    expect(L(find(out, "t")).b).toEqual({ x: 20, y: 8 });
  });
  it("rotate turns by value minus default about the centre", () => {
    const spec: DynamicSpec = { params: [{ kind: "rotation", name: "a", center: { x: 0, y: 0 } }], actions: [{ kind: "rotate", param: "a" }] };
    const out = evaluateDynamic(def([line("x", 0, 0, 5, 0)], spec), { a: Math.PI / 2 });
    expect(L(out[0]).b.x).toBeCloseTo(0, 9);
    expect(L(out[0]).b.y).toBeCloseTo(5, 9);
  });
  it("flip mirrors about the axis only while set", () => {
    const spec: DynamicSpec = { params: [{ kind: "flip", name: "f", base: { x: 0, y: 0 }, end: { x: 0, y: 1 } }], actions: [{ kind: "flip", param: "f" }] };
    const d = def([line("x", 2, 1, 5, 3)], spec);
    expect(L(evaluateDynamic(d, { f: 0 })[0]).a).toEqual({ x: 2, y: 1 });
    const out = L(evaluateDynamic(d, { f: 1 })[0]);
    expect(out.a.x).toBeCloseTo(-2, 9);
    expect(out.a.y).toBeCloseTo(1, 9);
    expect(out.b.x).toBeCloseTo(-5, 9);
  });
  it("array repeats the selection every spacing along the param, floor(value/spacing) in all", () => {
    const spec: DynamicSpec = {
      params: [{ kind: "linear", name: "len", base: { x: 0, y: 0 }, end: { x: 3, y: 0 }, values: { min: 1, max: 100 } }],
      actions: [{ kind: "array", param: "len", spacing: 1, entities: ["tick"] }],
    };
    const d = def([line("tick", 0, 0, 0, 1), line("axis", 0, 0, 3, 0)], spec);
    expect(evaluateDynamic(d, {}).filter((e) => e.id.startsWith("tick"))).toHaveLength(3);
    const out = evaluateDynamic(d, { len: 5.5 });
    expect(out.filter((e) => e.id.startsWith("tick"))).toHaveLength(5);
    expect(L(find(out, "tick#4")).a.x).toBe(4);
    expect(out.filter((e) => e.id === "axis")).toHaveLength(1);
  });
  it("actions apply in the spec's order", () => {
    // Stretch first, then scale about the origin: x of the stretched edge is (10+5)*2.
    const spec: DynamicSpec = {
      params: [
        { kind: "linear", name: "w", base: { x: 0, y: 0 }, end: { x: 10, y: 0 } },
        { kind: "linear", name: "s", base: { x: 0, y: 0 }, end: { x: 1, y: 0 } },
      ],
      actions: [
        { kind: "stretch", param: "w", frame: { min: { x: 9, y: -1 }, max: { x: 11, y: 5 } } },
        { kind: "scale", param: "s" },
      ],
    };
    const out = evaluateDynamic(def([line("r", 10, 0, 10, 4)], spec), { w: 15, s: 2 });
    expect(L(out[0]).a.x).toBe(30);
  });
});

describe("visibility and lookup", () => {
  const vis: DynamicSpec = {
    params: [{ kind: "visibility", name: "type" }],
    actions: [],
    visibilityStates: [
      { name: "Single", visible: ["a"] },
      { name: "Double", visible: ["a", "b"] },
    ],
  };
  const body = [line("a", 0, 0, 1, 0), line("b", 0, 1, 1, 1), line("always", 0, 2, 1, 2)];
  it("shows only the current state's entities; unlisted ones are always shown", () => {
    const d = def(body, vis);
    expect(evaluateDynamic(d, {}).map((e) => e.id)).toEqual(["a", "always"]);
    expect(evaluateDynamic(d, { type: "Double" }).map((e) => e.id)).toEqual(["a", "b", "always"]);
    expect(evaluateDynamic(d, { type: "Nope" }).map((e) => e.id)).toEqual(["a", "always"]);
  });
  it("a lookup row sets the params it names (and wins over stored values)", () => {
    const spec: DynamicSpec = {
      params: [
        { kind: "lookup", name: "size", table: "bolts" },
        { kind: "linear", name: "dia", base: { x: 0, y: 0 }, end: { x: 3, y: 0 } },
      ],
      actions: [{ kind: "lookup", param: "size" }, { kind: "scale", param: "dia" }],
      lookup: [{ name: "bolts", inputs: ["dia"], rows: [{ label: "M3", values: { dia: 3 } }, { label: "M6", values: { dia: 6 } }] }],
    };
    const d = def([line("x", 0, 0, 3, 0)], spec);
    expect(L(evaluateDynamic(d, {})[0]).b.x).toBe(3);
    expect(L(evaluateDynamic(d, { size: "M6", dia: 3 })[0]).b.x).toBe(6);
  });
});

describe("parametric (dimension) route", () => {
  it("a named constraint value is solved into the geometry", () => {
    const d = def([line("s", 0, 0, 10, 0)], { params: [{ kind: "dimension", name: "len", constraintId: "c1" }], actions: [] }, {
      constraints: [
        { id: "c1", type: "distance", a: { entityId: "s", point: "a" }, b: { entityId: "s", point: "b" }, value: 10 },
        { id: "c2", type: "horizontal", entityId: "s" },
      ],
    });
    expect(defaultParamValues(d, dynamicSpecOf(d)!)).toEqual({ len: 10 });
    const out = L(evaluateDynamic(d, { len: 25 })[0]);
    expect(Math.hypot(out.b.x - out.a.x, out.b.y - out.a.y)).toBeCloseTo(25, 5);
    expect(out.a.y).toBeCloseTo(out.b.y, 6);
  });
});

describe("integration with evaluateInsert", () => {
  const mk = (): SketchDocument => {
    const doc = new SketchDocument();
    doc._putRecord("blocks", def(rect(), widthSpec()));
    return doc;
  };
  it("instances with different values place different geometry; the placement still applies", () => {
    const doc = mk();
    const a = evaluateInsert(doc, insert({ width: 12 }, { insert: { x: 100, y: 0 } }));
    const bottom = L(a.find((e) => e.id.endsWith(":b"))!);
    expect(bottom.b.x).toBe(112);
    const b = evaluateInsert(doc, insert({ width: 4 }, { insert: { x: 100, y: 0 }, rotation: Math.PI / 2 }));
    const bb = L(b.find((e) => e.id.endsWith(":b"))!);
    expect(bb.b.x).toBeCloseTo(100, 9);
    expect(bb.b.y).toBeCloseTo(4, 9);
  });
  it("a static block ignores params", () => {
    const doc = new SketchDocument();
    doc._putRecord("blocks", def(rect(), undefined));
    expect(evaluateInsert(doc, insert({ width: 99 }))).toHaveLength(4);
  });
  it("editing the spec (a new record) invalidates cached bodies", () => {
    const doc = mk();
    withBlocks(doc, () => {
      expect(L(evaluateInsert(doc, insert({ width: 12 })).find((e) => e.id.endsWith(":b"))!).b.x).toBe(12);
      doc._putRecord("blocks", def(rect(), widthSpec({ actions: [] })));
      expect(L(evaluateInsert(doc, insert({ width: 12 })).find((e) => e.id.endsWith(":b"))!).b.x).toBe(10);
    });
  });
});

describe("grips and panel fields", () => {
  const d = def(rect(), widthSpec());
  it("a linear param has a grip at base + value; dragging snaps to the value set", () => {
    const i = insert({ width: 12 }, { insert: { x: 50, y: 0 } });
    const g = paramGrips(d, i);
    expect(g).toHaveLength(1);
    expect(g[0].point).toEqual({ x: 62, y: 0 });
    expect(applyParamGrip(d, i, 0, { x: 50 + 7.4, y: 3 }).params).toEqual({ width: 7 });
    expect(applyParamGrip(d, i, 0, { x: 500, y: 0 }).params).toEqual({ width: 20 });
    expect(applyParamGrip(d, i, 0, { x: -500, y: 0 }).params).toEqual({ width: 2 });
  });
  it("the grip follows the instance's rotation", () => {
    const i = insert({ width: 10 }, { rotation: Math.PI / 2 });
    const p = paramGrips(d, i)[0].point;
    expect(p.x).toBeCloseTo(0, 9);
    expect(p.y).toBeCloseTo(10, 9);
    expect(applyParamGrip(d, i, 0, { x: 0, y: 6 }).params).toEqual({ width: 6 });
  });
  it("flip grip flips by the side of the axis the cursor is on", () => {
    const spec: DynamicSpec = { params: [{ kind: "flip", name: "f", base: { x: 0, y: 0 }, end: { x: 0, y: 4 } }], actions: [{ kind: "flip", param: "f" }] };
    const fd = def(rect(), spec);
    expect(applyParamGrip(fd, insert(), 0, { x: 3, y: 2 }).params).toEqual({ f: 1 });
    expect(applyParamGrip(fd, insert({ f: 1 }), 0, { x: -3, y: 2 }).params).toEqual({ f: 0 });
  });
  it("fields describe each control; withParamValue validates; reset drops values", () => {
    const spec: DynamicSpec = {
      params: [
        { kind: "linear", name: "w", label: "Width", base: { x: 0, y: 0 }, end: { x: 10, y: 0 }, values: { list: [5, 10] } },
        { kind: "visibility", name: "v" },
        { kind: "flip", name: "f", base: { x: 0, y: 0 }, end: { x: 0, y: 1 } },
      ],
      actions: [],
      visibilityStates: [{ name: "A", visible: [] }, { name: "B", visible: [] }],
    };
    const sd = def(rect(), spec);
    const f = paramFields(sd, insert());
    expect(f.map((x) => [x.key, x.control, x.label])).toEqual([["w", "number", "Width"], ["v", "choice", "v"], ["f", "toggle", "f"]]);
    expect(f[1].options).toEqual(["A", "B"]);
    const i = withParamValue(sd, insert(), "w", 8);
    expect(i.params!.w).toBe(10);
    expect(withParamValue(sd, i, "v", "B").params!.v).toBe("B");
    expect(resetParams(i).params).toBeUndefined();
  });
});
