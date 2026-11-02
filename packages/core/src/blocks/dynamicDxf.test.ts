/**
 * Why this matters (B-25): a dynamic block must survive a save. If the file
 * only held the base definition every resized door would snap back; if it
 * held only geometry the block would stop being dynamic. We write the base
 * block, an anonymous `*U<n>` block per distinct state (so LibreCAD/AutoCAD
 * draw the right shape) and the spec + values in SKETCHOR data, and Sketchor
 * must read it back as the same live dynamic block with the same values.
 */
import { describe, expect, it } from "vitest";
import { SketchDocument } from "../document";
import { boundsOf, parseDxf } from "../dxf";
import { entitiesToDxf } from "../dxfExport";
import { entitiesToDxf2018 } from "../dxfw";
import { entitiesToSvgDocument } from "../svg";
import type { InsertEntity } from "../entities";
import "../kinds/builtin";
import { withBlocks } from "./context";
import { dynamicSpecOf, evaluateDynamic } from "./dynamic";
import { planDynamicExport } from "./dynamicExport";
import { fixtureDoor, fixtureWindow } from "./dynamicFixtures";
import { flattenInserts } from "./evaluate";
import { makeInsert } from "./ops";

const inserts = (): InsertEntity[] => [
  makeInsert("w0", "FX_WINDOW", { x: 0, y: 0 }),
  makeInsert("w1", "FX_WINDOW", { x: 0, y: 500 }, { params: { Width: 1300, Flip: 1 } }),
  makeInsert("w2", "FX_WINDOW", { x: 0, y: 1000 }, { params: { Width: 1300, Flip: 1 } }),
  makeInsert("d1", "FX_DOOR", { x: 5000, y: 0 }, { params: { Type: "Double", Size: "Narrow" } }),
];

describe("planDynamicExport", () => {
  it("one anonymous block per distinct state; defaults and static blocks stay plain references", () => {
    const plan = planDynamicExport([fixtureWindow(), fixtureDoor()], inserts());
    expect(plan.blocks.map((b) => b.name)).toEqual(["*U1", "*U2"]);
    expect(plan.stateOf(inserts()[0])).toBeNull();
    expect(plan.stateOf(inserts()[1])!.name).toBe(plan.stateOf(inserts()[2])!.name);
    expect(plan.blocks[0].dynamic).toBeUndefined();
  });
});

describe.each(["AC1032", "R12"])("%s", (flavour) => {
  const write = (e: InsertEntity[]): string => (flavour === "AC1032" ? entitiesToDxf2018(e, { blocks: [fixtureWindow(), fixtureDoor()] }) : entitiesToDxf(e, 0, 1, [fixtureWindow(), fixtureDoor()]));

  it("writes the evaluated geometry as *U blocks, so a reader that knows nothing of Sketchor draws the right size", () => {
    const text = write(inserts());
    expect(text).toContain("*U1");
    expect(text).toContain("*U2");
    // the plain text reader (blocks exploded) shows the stretched window at 1300 wide, the default one at 900
    const flat = parseDxf(text, { blocks: "explode" }).entities.filter((e) => e.type === "line");
    const b = boundsOf(flat)!;
    expect(b.maxX).toBeGreaterThan(5600); // the narrowed double door starts at x=5000, 700 wide
    expect(boundsOf(flat.filter((e) => e.type === "line" && e.a.y < 400 && e.a.x < 4000))!.maxX).toBe(900);
    expect(boundsOf(flat.filter((e) => e.type === "line" && e.a.y > 400 && e.a.y < 900 && e.a.x < 4000))!.maxX).toBe(1300);
  });
});

describe("SVG", () => {
  it("draws a non-default instance from its evaluated state, not the base definition", () => {
    const wide = entitiesToSvgDocument([makeInsert("w", "FX_WINDOW", { x: 0, y: 0 }, { params: { Width: 1800 } })], { blocks: [fixtureWindow()], padding: 0 });
    const plain = entitiesToSvgDocument([makeInsert("w", "FX_WINDOW", { x: 0, y: 0 })], { blocks: [fixtureWindow()], padding: 0 });
    const w = (s: string) => Number(/viewBox="[-\d.]+ [-\d.]+ ([\d.]+)/.exec(s)![1]);
    expect(w(wide)).toBe(1800);
    expect(w(plain)).toBe(900);
  });
});

describe("AC1032 round trip re-opens a live dynamic block", () => {
  const text = entitiesToDxf2018(inserts(), { blocks: [fixtureWindow(), fixtureDoor()] });
  const back = parseDxf(text);
  it("keeps the spec on the base definition and no anonymous block in the table", () => {
    expect(back.blocks.map((b) => b.name).sort()).toEqual(["FX_DOOR", "FX_WINDOW"]);
    const win = back.blocks.find((b) => b.name === "FX_WINDOW")!;
    expect(dynamicSpecOf(win)).toEqual(fixtureWindow().dynamic);
  });
  it("restores each instance's block and values (ids too)", () => {
    const byId = new Map(back.entities.filter((e): e is InsertEntity => e.type === "insert").map((e) => [e.id, e] as const));
    expect(byId.get("w0")!.params).toBeUndefined();
    expect(byId.get("w1")!.block).toBe("FX_WINDOW");
    expect(byId.get("w1")!.params).toEqual({ Width: 1300, Flip: 1 });
    expect(byId.get("d1")!.params).toEqual({ Type: "Double", Size: "Narrow", Opening: 700 });
  });
  it("evaluates to the same geometry as before saving", () => {
    const doc = new SketchDocument();
    for (const b of back.blocks) doc._putRecord("blocks", b);
    const flatBack = withBlocks(doc, () => flattenInserts(doc, back.entities));
    const doc0 = new SketchDocument();
    doc0._putRecord("blocks", fixtureWindow());
    doc0._putRecord("blocks", fixtureDoor());
    const flat0 = withBlocks(doc0, () => flattenInserts(doc0, inserts()));
    expect(boundsOf(flatBack)).toEqual(boundsOf(flat0));
    expect(flatBack).toHaveLength(flat0.length);
  });
  it("a long value set (JSON over several XDATA lines, non-ASCII label) survives", () => {
    const win = fixtureWindow();
    const spec = dynamicSpecOf(win)!;
    const many: Record<string, number | string> = { Width: 1100, Flip: 1 };
    // pad with unknown keys: dropped by validation on evaluate but the writer stores resolved values only
    const d = { ...win, dynamic: { ...spec, params: [...spec.params, { kind: "visibility" as const, name: "Vue" }], visibilityStates: [{ name: "Étage haut — très long nom ".repeat(8).trim(), visible: [] }, { name: "B", visible: [] }] } };
    const state = String(d.dynamic.visibilityStates![0].name);
    many.Vue = state;
    const out = parseDxf(entitiesToDxf2018([makeInsert("v", "FX_WINDOW", { x: 0, y: 0 }, { params: many })], { blocks: [d] }));
    const ins = out.entities.find((e) => e.type === "insert") as InsertEntity;
    expect(ins.params!.Vue).toBe(state);
    expect(ins.params!.Width).toBe(1100);
    expect(evaluateDynamic(out.blocks[0], ins.params).length).toBeGreaterThan(0);
  });
});
