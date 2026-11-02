import { describe, expect, it } from "vitest";
import "../kinds/builtin";
import { expandFields, setFieldContext, withFieldContext } from "../blocks/fields";
import { CommandBus } from "../commands";
import { SketchDocument } from "../document";
import type { InsertEntity, TextEntity } from "../entities";
import { insertContents } from "../kinds/insert";
import { layoutEntities, newLayout } from "./types";
import { newViewport } from "./viewport";
import { TITLE_BLOCK_NAME, planSheetSet, planTitleBlock } from "./titleBlock";

/**
 * A title block's job is to be right on every sheet without anyone retyping it: the sheet
 * number, the scale of the view under it, the project name. What breaks if this regresses: two
 * sheets both claiming to be "1 of 2", a scale that still says 1:1 after the viewport changed,
 * or a sheet-set edit that touches only one layout.
 */
function setup() {
  const doc = new SketchDocument();
  const bus = new CommandBus(doc);
  setFieldContext({ filename: "plant.sketchor", date: "2026-11-02" });
  bus.execute({ type: "add-layout", layout: newLayout("Plan") });
  bus.execute({ type: "add-layout", layout: newLayout("Detail") });
  for (const name of ["Plan", "Detail"]) {
    const cmds = planTitleBlock(doc, name)!;
    expect(cmds).not.toBeNull();
    bus.execute({ type: "batch", commands: cmds });
  }
  return { doc, bus };
}

const texts = (doc: SketchDocument, layout: string): Record<string, string> => {
  const ins = layoutEntities(doc, layout).find((e): e is InsertEntity => e.type === "insert")!;
  const out: Record<string, string> = {};
  for (const e of insertContents(ins)) if (e.type === "text" && e.id.includes(":attr:")) out[(e as TextEntity).text.length ? e.id : ""] = (e as TextEntity).text;
  return out;
};
const values = (doc: SketchDocument, layout: string): string[] => Object.values(texts(doc, layout));

describe("title block fields", () => {
  it("each sheet shows its own number out of the total", () => {
    const { doc } = setup();
    expect(values(doc, "Plan")).toContain("1 / 2");
    expect(values(doc, "Detail")).toContain("2 / 2");
  });

  it("scale follows the viewport under the block, else the biggest viewport, else 1:1", () => {
    const { doc, bus } = setup();
    expect(values(doc, "Plan")).toContain("1:1");
    bus.execute({ type: "add-entity", entity: newViewport({ x: 20, y: 60, w: 100, h: 100 }, { center: { x: 0, y: 0 }, scale: 0.02 }, { space: "Plan" }) });
    expect(values(doc, "Plan")).toContain("1:50");
    expect(values(doc, "Detail")).toContain("1:1"); // another sheet's viewport does not count
  });

  it("title defaults to the layout name; sheet-set attributes fill every sheet and a layout can override", () => {
    const { doc, bus } = setup();
    expect(values(doc, "Plan")).toContain("Plan");
    const cmds = planSheetSet(doc, { Project: "Depot", client: "ACME" }, { Detail: { title: "Section A-A" } });
    bus.execute({ type: "batch", commands: cmds });
    expect(values(doc, "Plan")).toEqual(expect.arrayContaining(["Depot", "ACME", "Plan"]));
    expect(values(doc, "Detail")).toEqual(expect.arrayContaining(["Depot", "Section A-A"]));
    bus.undo();
    expect(values(doc, "Plan")).not.toContain("Depot");
  });

  it("a no-change sheet-set edit emits nothing, and clearing a value removes it", () => {
    const { doc, bus } = setup();
    expect(planSheetSet(doc, {}, {})).toEqual([]);
    bus.execute({ type: "batch", commands: planSheetSet(doc, { project: "Depot" }) });
    expect(planSheetSet(doc, { project: "Depot" })).toEqual([]);
    bus.execute({ type: "batch", commands: planSheetSet(doc, {}) });
    expect(doc.settings.sheetSet).toBeUndefined();
  });

  it("date and filename come from the app-wide context", () => {
    const { doc } = setup();
    expect(values(doc, "Plan")).toEqual(expect.arrayContaining(["2026-11-02", "plant.sketchor"]));
  });

  it("refuses a sheet too small for the block and a missing layout", () => {
    const doc = new SketchDocument();
    const bus = new CommandBus(doc);
    bus.execute({ type: "add-layout", layout: { ...newLayout("Tiny"), paper: { size: "Custom", w: 100, h: 50, units: "mm", orientation: "landscape" } } });
    expect(planTitleBlock(doc, "Tiny")).toBeNull();
    expect(planTitleBlock(doc, "Nope")).toBeNull();
  });

  it("reuses an existing TITLEBLOCK record instead of redefining it", () => {
    const { doc } = setup();
    const again = planTitleBlock(doc, "Plan")!;
    expect(again.some((c) => c.type === "put-table-record")).toBe(false);
    expect(doc.hasRecord("blocks", TITLE_BLOCK_NAME)).toBe(true);
  });
});

describe("fields", () => {
  it("expands {{param:NAME}} and custom names, leaves unknown ones visible", () => {
    const ctx = { params: { width: 12.5 }, custom: { project: "X" } };
    expect(expandFields("w={{param:width}} p={{Project}} q={{nope}} r={{param:nope}}", ctx)).toBe("w=12.5 p=X q={{nope}} r={{param:nope}}");
  });
  it("withFieldContext layers over the app context and restores it", () => {
    setFieldContext({ filename: "a.sketchor" });
    expect(withFieldContext({ layout: "Plan" }, () => expandFields("{{layout}}/{{filename}}"))).toBe("Plan/a.sketchor");
    expect(expandFields("{{layout}}")).toBe("Model");
  });
});
