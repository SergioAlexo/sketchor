import { describe, expect, it } from "vitest";
import { CommandBus } from "../commands";
import { SketchDocument } from "../document";
import type { LineEntity } from "../entities";
import { diffToCommands, parseCode, toCode } from "../sketchtext";
import { layoutEntities, layoutList, modelEntities, newLayout, normalizeLayout, paperSizeMm, paperSpec, uniqueLayoutName, withSpace } from "./types";

/**
 * Layouts carry the sheet a drawing is printed on. What breaks if this
 * regresses: a sheet that vanishes or changes size on reopen, paper-space
 * geometry leaking into model-space exports, or a rename that orphans the
 * entities drawn on the sheet.
 */
const line = (id: string): LineEntity => ({ id, type: "line", a: { x: 0, y: 0 }, b: { x: 1, y: 0 } });

describe("layout model", () => {
  it("paper specs apply orientation and unit conversion", () => {
    expect(paperSpec("A4", "landscape")).toMatchObject({ w: 297, h: 210 });
    expect(paperSpec("A4", "portrait")).toMatchObject({ w: 210, h: 297 });
    expect(paperSpec("Custom", "landscape", { w: 8, h: 10, units: "in" })).toMatchObject({ orientation: "portrait" });
    expect(paperSizeMm({ size: "Custom", w: 10, h: 8, units: "in", orientation: "landscape" })).toEqual({ w: 254, h: 203.2 });
  });

  it("normalizeLayout repairs a hand-edited record", () => {
    const r = normalizeLayout({ name: "X", paper: { w: -1 } });
    expect(r.paper.w).toBe(297);
    expect(r.margins.left).toBe(5);
    expect(r.plotSettings.plotStyle).toBe("as displayed");
  });

  it("keeps layouts in order and separates the two spaces", () => {
    const doc = new SketchDocument();
    const bus = new CommandBus(doc);
    bus.execute({ type: "add-layout", layout: newLayout("Layout1") });
    bus.execute({ type: "add-layout", layout: newLayout(uniqueLayoutName(doc)) });
    expect(layoutList(doc).map((l) => l.name)).toEqual(["Layout1", "Layout2"]);
    bus.execute({ type: "add-entity", entity: line("m") });
    bus.execute({ type: "add-entity", entity: withSpace(line("p"), "Layout2") });
    expect(modelEntities(doc).map((e) => e.id)).toEqual(["m"]);
    expect(layoutEntities(doc, "Layout2").map((e) => e.id)).toEqual(["p"]);
    bus.execute({ type: "reorder-layouts", names: ["Layout2"] });
    expect(layoutList(doc).map((l) => l.name)).toEqual(["Layout2", "Layout1"]);
  });

  it("refuses duplicate, empty and missing names", () => {
    const doc = new SketchDocument();
    const bus = new CommandBus(doc);
    bus.execute({ type: "add-layout", layout: newLayout("A") });
    bus.execute({ type: "add-layout", layout: newLayout("A") });
    bus.execute({ type: "add-layout", layout: newLayout("") });
    bus.execute({ type: "rename-layout", from: "A", to: "" });
    bus.execute({ type: "rename-layout", from: "Z", to: "Q" });
    bus.execute({ type: "move-to-space", ids: ["nope"], space: "Missing" });
    expect(layoutList(doc).map((l) => l.name)).toEqual(["A"]);
  });

  it("rename follows the entities, delete removes them, both undo", () => {
    const doc = new SketchDocument();
    const bus = new CommandBus(doc);
    bus.execute({ type: "add-layout", layout: newLayout("A") });
    bus.execute({ type: "add-entity", entity: withSpace(line("p"), "A") });
    bus.execute({ type: "rename-layout", from: "A", to: "B" });
    expect(layoutEntities(doc, "B").map((e) => e.id)).toEqual(["p"]);
    bus.execute({ type: "delete-layout", name: "B" });
    expect(doc.get("p")).toBeUndefined();
    bus.undo();
    expect(layoutEntities(doc, "B").map((e) => e.id)).toEqual(["p"]);
    bus.undo();
    expect(layoutEntities(doc, "A").map((e) => e.id)).toEqual(["p"]);
  });

  it("the bus draws on the active layout unless an entity names its own space", () => {
    const doc = new SketchDocument();
    const bus = new CommandBus(doc);
    bus.execute({ type: "add-layout", layout: newLayout("A") });
    bus.activeSpace = "A";
    bus.execute({ type: "batch", commands: [{ type: "add-entity", entity: line("x") }] });
    bus.execute({ type: "add-entity", entity: { ...line("y"), space: "A" } as LineEntity });
    bus.activeSpace = null;
    bus.execute({ type: "add-entity", entity: line("z") });
    expect(layoutEntities(doc, "A").map((e) => e.id)).toEqual(["x", "y"]);
    expect(modelEntities(doc).map((e) => e.id)).toEqual(["z"]);
    bus.undo();
    bus.undo();
    bus.undo();
    expect(layoutEntities(doc, "A")).toHaveLength(0);
  });

  it("a sketch-code edit keeps the sheet an entity is on", () => {
    const doc = new SketchDocument();
    const bus = new CommandBus(doc);
    bus.execute({ type: "add-layout", layout: newLayout("A") });
    bus.execute({ type: "add-entity", entity: { ...line("p"), name: "L1", space: "A" } as LineEntity });
    const code = toCode(doc);
    expect(code).toContain("(1, 0)");
    const cmds = diffToCommands(doc, parseCode(code.replace("(1, 0)", "(2, 0)")).entities);
    expect(cmds.length).toBeGreaterThan(0);
    for (const c of cmds) bus.execute(c);
    expect((doc.get("p") as LineEntity).b.x).toBe(2);
    expect(layoutEntities(doc, "A").map((e) => e.id)).toEqual(["p"]);
  });

  it("survives a JSON round trip", () => {
    const doc = new SketchDocument();
    const bus = new CommandBus(doc);
    bus.execute({ type: "add-layout", layout: newLayout("A", paperSpec("ANSI D")) });
    bus.execute({ type: "add-entity", entity: withSpace(line("p"), "A") });
    const back = SketchDocument.fromJSON(JSON.parse(JSON.stringify(doc.toJSON())));
    expect(layoutList(back)[0].paper).toMatchObject({ size: "ANSI D", w: 863.6 });
    expect(layoutEntities(back, "A")).toHaveLength(1);
  });
});
