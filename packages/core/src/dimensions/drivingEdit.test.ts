/**
 * D-02b UI (pure half): the value editor's parsing, the over-constraint
 * check that makes the UI ask before a dimension over-defines a sketch, and
 * the driving/reference toggle.
 */
import { describe, expect, it } from "vitest";
import { CommandBus } from "../commands";
import { SketchDocument } from "../document";
import type { DimensionEntity, LineEntity } from "../entities";
import { asNewDriving, asNewDrivingAll, dimEditValue, drivingCheck, parseDimValue, withDimValue, withDriving } from "./drivingEdit";
import "../kinds/builtin";

const refs = [{ entityId: "l1", point: "a" as const }, { entityId: "l1", point: "b" as const }, null];
const hdim = (over: Partial<DimensionEntity> = {}): DimensionEntity => ({
  id: "d1",
  type: "dimension",
  kind: "linear",
  defPoints: [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 50, y: 20 }],
  refs,
  driving: false,
  ...over,
});

/** A horizontal 100 mm line whose start is fixed and which is held horizontal: one DOF left (its length). */
function sketch() {
  const doc = new SketchDocument();
  const bus = new CommandBus(doc);
  bus.execute({ type: "add-entity", entity: { id: "l1", type: "line", a: { x: 0, y: 0 }, b: { x: 100, y: 0 } } });
  bus.execute({ type: "add-entity", entity: { id: "k0", type: "point", p: { x: 0, y: 0 } } });
  bus.execute({ type: "add-constraint", constraint: { id: "fp", type: "fix", entityId: "k0" } });
  bus.execute({ type: "add-constraint", constraint: { id: "co", type: "coincident", a: { entityId: "l1", point: "a" }, b: { entityId: "k0", point: "a" } } });
  bus.execute({ type: "add-constraint", constraint: { id: "hz", type: "horizontal", entityId: "l1" } });
  return { doc, bus };
}

describe("parseDimValue", () => {
  it("reads a bare number in the display unit, or a unit-suffixed one as given", () => {
    expect(parseDimValue("4", "length", new Map(), 25.4)).toEqual({ ok: true, value: 101.6 });
    expect(parseDimValue("40mm", "length", new Map(), 25.4)).toEqual({ ok: true, value: 40 });
  });

  it("keeps an expression that names a parameter, but not one that is plain arithmetic", () => {
    const env = new Map([["width", 80]]);
    expect(parseDimValue("width / 2 + 5", "length", env)).toEqual({ ok: true, value: 45, expression: "width / 2 + 5" });
    expect(parseDimValue("2 * pi", "length", env)).toEqual({ ok: true, value: 2 * Math.PI });
  });

  it("reads angles in degrees and refuses zero, negatives and garbage", () => {
    const r = parseDimValue("90", "angle");
    expect(r.ok && r.value).toBeCloseTo(Math.PI / 2, 12);
    expect(parseDimValue("0", "length").ok).toBe(false);
    expect(parseDimValue("-3", "length").ok).toBe(false);
    expect(parseDimValue("width", "length").ok).toBe(false);
    expect(parseDimValue("  ", "length").ok).toBe(false);
  });
});

describe("drivingCheck", () => {
  it("lets a dimension drive the one degree of freedom left", () => {
    const { doc } = sketch();
    expect(drivingCheck(hdim(), 120, doc.all(), doc.solverConstraints())).toEqual({ ok: true });
  });

  it("flags a second dimension on the same length as over-defining (redundant at the same value, conflicting at another)", () => {
    const { doc, bus } = sketch();
    bus.execute({ type: "add-entity", entity: hdim({ driving: true, value: 100 }) });
    const second = hdim({ id: "d2" });
    const same = drivingCheck(second, 100, doc.all(), doc.solverConstraints());
    expect(same).toMatchObject({ ok: false, reason: "over", conflict: false });
    const other = drivingCheck(second, 130, doc.all(), doc.solverConstraints());
    expect(other).toMatchObject({ ok: false, reason: "over", conflict: true });
  });

  it("ignores the constraint the dimension itself already stands for (re-editing a driving value)", () => {
    const { doc, bus } = sketch();
    bus.execute({ type: "add-entity", entity: hdim({ driving: true, value: 100 }) });
    expect(drivingCheck(doc.get("d1") as DimensionEntity, 150, doc.all(), doc.solverConstraints())).toEqual({ ok: true });
  });

  it("says why a dimension cannot drive", () => {
    const { doc } = sketch();
    const loose = hdim({ refs: undefined });
    expect(drivingCheck(loose, 100, doc.all(), doc.solverConstraints())).toMatchObject({ ok: false, reason: "cannot" });
  });
});

describe("withDimValue / withDriving / dimEditValue", () => {
  it("a value edit makes the dimension drive and moves the geometry in one step", () => {
    const { doc, bus } = sketch();
    bus.execute({ type: "add-entity", entity: hdim() });
    const lookup = (id: string) => doc.get(id);
    bus.execute({ type: "update-entity", entity: withDimValue(doc.get("d1") as DimensionEntity, 140, undefined, lookup) });
    expect((doc.get("d1") as DimensionEntity).driving).toBe(true);
    expect((doc.get("l1") as LineEntity).b.x).toBeCloseTo(140, 6);
    bus.undo();
    expect((doc.get("l1") as LineEntity).b.x).toBeCloseTo(100, 6);
  });

  it("as a reference, a value edit only stores the value; the expression is replaced or cleared", () => {
    const { doc } = sketch();
    const lookup = (id: string) => doc.get(id);
    const d = withDimValue(hdim({ expression: "w" }), 140, undefined, lookup, false);
    expect(d.driving).toBe(false);
    expect(d.expression).toBeUndefined();
    expect(withDimValue(hdim(), 50, "w / 2", lookup).expression).toBe("w / 2");
  });

  it("turning driving on holds the current measurement, so nothing moves", () => {
    const { doc, bus } = sketch();
    bus.execute({ type: "add-entity", entity: hdim() });
    const lookup = (id: string) => doc.get(id);
    const on = withDriving(doc.get("d1") as DimensionEntity, true, lookup);
    expect("error" in on).toBe(false);
    expect((on as DimensionEntity).value).toBeCloseTo(100, 9);
    bus.execute({ type: "update-entity", entity: on as DimensionEntity });
    expect((doc.get("l1") as LineEntity).b.x).toBeCloseTo(100, 9);
    expect(dimEditValue(doc.get("d1") as DimensionEntity, lookup)).toBeCloseTo(100, 9);
    const off = withDriving(doc.get("d1") as DimensionEntity, false, lookup) as DimensionEntity;
    expect(off.driving).toBe(false);
    expect(withDriving(hdim({ refs: undefined }), true, lookup)).toHaveProperty("error");
  });

  it("a reference dimension's editor opens on what it measures now", () => {
    const { doc, bus } = sketch();
    bus.execute({ type: "update-entity", entity: { ...(doc.get("l1") as LineEntity), b: { x: 75, y: 0 } } });
    expect(dimEditValue(hdim({ value: 999 }), (id) => doc.get(id))).toBeCloseTo(75, 9);
  });
});

describe("asNewDriving (Sketch mode)", () => {
  it("drives when it can, and falls back to reference with a note when the sketch already fixes the value", () => {
    const { doc, bus } = sketch();
    const first = asNewDriving(hdim(), doc.all(), doc.solverConstraints());
    expect(first.dim.driving).toBe(true);
    expect(first.dim.value).toBeCloseTo(100, 9);
    expect(first.note).toBeUndefined();
    bus.execute({ type: "add-entity", entity: first.dim });
    const second = asNewDriving(hdim({ id: "d2" }), doc.all(), doc.solverConstraints());
    expect(second.dim.driving).toBe(false);
    expect(second.note).toMatch(/reference/);
  });

  it("leaves a dimension that cannot drive as it is, without a note", () => {
    const { doc } = sketch();
    const r = asNewDriving(hdim({ kind: "ordinate" }), doc.all(), doc.solverConstraints());
    expect(r.dim.driving).toBe(false);
    expect(r.note).toBeUndefined();
  });
});

describe("asNewDrivingAll", () => {
  it("checks each dimension of a batch against the ones before it", () => {
    const { doc } = sketch();
    const r = asNewDrivingAll([hdim(), hdim({ id: "d2" })], doc.all(), doc.solverConstraints());
    expect(r.dims.map((d) => d.driving)).toEqual([true, false]);
    expect(r.note).toMatch(/reference/);
  });
});
