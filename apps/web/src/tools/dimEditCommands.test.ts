import { describe, expect, it } from "vitest";
import { CommandBus, SketchDocument, dimBetweenPoints, type DimensionEntity } from "@sketchor/core";
import { parseCommand } from "./commandLine";
import { isDimEdit, runDimEdit } from "./dimEditCommands";

/**
 * D-09 command-line editors: each acts on the selected dimensions and is ONE undo
 * step; with nothing (or the wrong thing) selected it says so instead of
 * silently doing nothing or throwing.
 */

function setup() {
  const doc = new SketchDocument();
  const bus = new CommandBus(doc);
  const ys = [10, 17, 40];
  ys.forEach((y, i) => bus.execute({ type: "add-entity", entity: dimBetweenPoints({ x: 0, y: 0 }, { x: 40 + i * 20, y: 0 }, { x: 20, y }, "linear", { id: `d${i}` }) }));
  return { doc, bus };
}
const dim = (doc: SketchDocument, id: string) => doc.get(id) as DimensionEntity;

describe("runDimEdit", () => {
  it("is reachable from the command line", () => {
    for (const w of ["dimreset", "dimleader", "dimflip", "dimspace 8", "dimoblique 45", "dimupdate", "dimreassoc"]) {
      const p = parseCommand(w);
      expect(p.kind, w).toBe("app");
      if (p.kind === "app") expect(isDimEdit(p.id)).toBe(true);
    }
  });

  it("with no dimension selected it reports instead of editing", () => {
    const { doc } = setup();
    expect(runDimEdit(doc, [], "dimFlip").command).toBeNull();
    expect(runDimEdit(doc, ["missing"], "dimFlip").message).toMatch(/select/);
  });

  it("flip, leader and reset each apply to the whole selection in one undo step", () => {
    const { doc, bus } = setup();
    const sel = ["d0", "d1", "d2"];
    bus.execute(runDimEdit(doc, sel, "dimFlip").command!);
    expect(sel.every((i) => dim(doc, i).flipArrows)).toBe(true);
    bus.undo();
    expect(sel.some((i) => dim(doc, i).flipArrows)).toBe(false);
    bus.execute(runDimEdit(doc, sel, "dimTextLeader").command!);
    expect(dim(doc, "d0").textLeader).toBe(true);
    expect(dim(doc, "d0").textPos).toBeDefined();
    bus.execute(runDimEdit(doc, sel, "dimTextReset").command!);
    expect(dim(doc, "d0").textPos).toBeUndefined();
    expect(runDimEdit(doc, sel, "dimTextReset").command).toBeNull();
  });

  it("dimspace takes the first selected dimension as the base and validates its argument", () => {
    const { doc, bus } = setup();
    const r = runDimEdit(doc, ["d0", "d1", "d2"], "dimSpace", "6");
    bus.execute(r.command!);
    expect(dim(doc, "d1").defPoints[2].y).toBeCloseTo(16);
    expect(dim(doc, "d2").defPoints[2].y).toBeCloseTo(22);
    bus.undo();
    expect(dim(doc, "d2").defPoints[2].y).toBeCloseTo(40);
    expect(runDimEdit(doc, ["d0", "d1"], "dimSpace", "abc").command).toBeNull();
    expect(runDimEdit(doc, ["d0", "d1"], "dimSpace", "-3").command).toBeNull();
    expect(runDimEdit(doc, ["d0"], "dimSpace", "5").command).toBeNull();
  });

  it("dimoblique slants and clears the extension lines; junk is rejected", () => {
    const { doc, bus } = setup();
    bus.execute(runDimEdit(doc, ["d0"], "dimOblique", "60").command!);
    expect(dim(doc, "d0").oblique).toBeCloseTo(Math.PI / 3);
    bus.execute(runDimEdit(doc, ["d0"], "dimOblique", "none").command!);
    expect(dim(doc, "d0").oblique).toBeUndefined();
    expect(runDimEdit(doc, ["d0"], "dimOblique", "steep").command).toBeNull();
  });

  it("dimupdate rebinds to the current style and drops overrides; dimreassoc finds geometry", () => {
    const { doc, bus } = setup();
    bus.execute({ type: "update-entity", entity: { ...dim(doc, "d0"), style: "Old", overrides: { textHeight: 9 } } });
    bus.execute({ type: "set-settings", patch: { currentDimStyle: "ISO-25" } });
    bus.execute(runDimEdit(doc, ["d0"], "dimRestyle").command!);
    expect(dim(doc, "d0").style).toBe("ISO-25");
    expect(dim(doc, "d0").overrides).toBeUndefined();
    expect(runDimEdit(doc, ["d0"], "dimReassoc").command).toBeNull();
    bus.execute({ type: "add-entity", entity: { id: "l", type: "line", a: { x: 0, y: 0 }, b: { x: 40, y: 0 } } });
    bus.execute(runDimEdit(doc, ["d0"], "dimReassoc").command!);
    expect(dim(doc, "d0").refs?.[0]?.entityId).toBe("l");
  });
});
