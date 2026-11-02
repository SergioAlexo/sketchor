/**
 * Why this matters (B-22): the instance side of a dynamic block is what users
 * touch — grips on the canvas and the Custom section of the Properties panel.
 * A grip drag that bypasses value-set snapping, an edit that is not undoable,
 * or a code-panel edit that strips the stored values would each silently
 * change dimensions in a drawing. Checked through the real bus and kind registry.
 */
import { describe, expect, it } from "vitest";
import { CommandBus } from "../commands";
import { SketchDocument } from "../document";
import type { InsertEntity } from "../entities";
import { gripsOf, applyGrip } from "../grips";
import "../kinds/builtin";
import { kindBounds } from "../kinds/registry";
import { diffToCommands, parseCode, toCode } from "../sketchtext";
import { paramFields, resetParams, withParamValue } from "./dynamic";
import { fixtureWindow } from "./dynamicFixtures";
import { makeInsert } from "./ops";

function setup(params?: InsertEntity["params"]): { bus: CommandBus; doc: SketchDocument } {
  const doc = new SketchDocument();
  const bus = new CommandBus(doc);
  bus.execute({ type: "put-table-record", table: "blocks", record: fixtureWindow() });
  bus.execute({ type: "add-entity", entity: makeInsert("I1", "FX_WINDOW", { x: 1000, y: 0 }, params ? { params } : {}) });
  return { bus, doc };
}

describe("B-22 instance UX", () => {
  it("the insert shows a grip per parameter and bounds follow the value", () => {
    const { doc } = setup({ Width: 1200 });
    const ins = doc.get("I1") as InsertEntity;
    const grips = gripsOf(ins);
    const params = grips.filter((g) => g.kind === "param");
    expect(params).toHaveLength(2); // Width + Flip
    expect(params[0].point).toEqual({ x: 2200, y: 0 });
    expect(kindBounds(ins)!.maxX).toBe(2200);
  });
  it("dragging the width grip snaps to the 100 step and is one undoable update", () => {
    const { bus, doc } = setup();
    const ins = doc.get("I1") as InsertEntity;
    const grip = gripsOf(ins).find((g) => g.kind === "param" && g.index === 0)!;
    const moved = applyGrip(ins, grip, { x: 1000 + 1349, y: 20 }) as InsertEntity;
    expect(moved.params!.Width).toBe(1300);
    bus.execute({ type: "update-entity", entity: moved });
    expect(kindBounds(doc.get("I1")!)!.maxX).toBe(2300);
    bus.undo();
    expect(kindBounds(doc.get("I1")!)!.maxX).toBe(1900);
    bus.redo();
    expect((doc.get("I1") as InsertEntity).params!.Width).toBe(1300);
  });
  it("Custom fields list the controls, edits validate, and Reset block restores the defaults", () => {
    const { doc } = setup();
    const def = doc.getRecord("blocks", "FX_WINDOW") as never;
    const ins = doc.get("I1") as InsertEntity;
    expect(paramFields(def, ins).map((f) => f.key)).toEqual(["Width", "Flip"]);
    const edited = withParamValue(def, ins, "Width", 5000);
    expect(edited.params!.Width).toBe(1800); // clamped to the value set
    expect(resetParams(edited).params).toBeUndefined();
  });
  it("a code-panel edit keeps the stored values (the sketch code cannot express them)", () => {
    const { bus, doc } = setup({ Width: 1500, Flip: 1 });
    const code = toCode(doc);
    const parsed = parseCode(code);
    const cmds = diffToCommands(doc, parsed.entities);
    for (const c of cmds) bus.execute(c);
    expect((doc.get("I1") as InsertEntity).params).toEqual({ Width: 1500, Flip: 1 });
  });
  it("a plain instance (no values) of a dynamic block shows the as-authored geometry", () => {
    const { doc } = setup();
    expect(kindBounds(doc.get("I1")!)!.maxX).toBe(1900);
  });
});
