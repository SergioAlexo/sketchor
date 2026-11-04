import { describe, expect, it } from "vitest";
import "../kinds/builtin";
import { CommandBus } from "../commands";
import { SketchDocument } from "../document";
import type { Entity, ViewportEntity } from "../entities";
import { modelFrameBounds, planLayoutFromModel } from "./fromModel";
import { getLayout, layoutEntities, layoutList, paperSpec, printableRectMm } from "./types";
import { viewportModelWindow } from "./viewport";

/**
 * L-08 is the shortcut people will actually use: if it picks a scale the model does not fit, frames the wrong
 * thing, or leaves the drawing half-built when something goes wrong, the sheet is wrong before anyone looks at it.
 */
const line = (id: string, ax: number, ay: number, bx: number, by: number): Entity => ({ id, type: "line", a: { x: ax, y: ay }, b: { x: bx, y: by } }) as Entity;

function setup(entities: Entity[] = [line("a", 0, 0, 4000, 0), line("b", 4000, 0, 4000, 2500)]) {
  const doc = new SketchDocument();
  const bus = new CommandBus(doc);
  for (const entity of entities) bus.execute({ type: "add-entity", entity });
  return { doc, bus };
}

describe("planLayoutFromModel", () => {
  it("adds the layout, title block and one viewport in a single undo step", () => {
    const { doc, bus } = setup();
    const plan = planLayoutFromModel(doc, { paper: paperSpec("A3", "landscape") })!;
    expect(plan).not.toBeNull();
    bus.execute(plan.commands[0]);
    expect(layoutList(doc).map((l) => l.name)).toEqual([plan.layoutName]);
    const on = layoutEntities(doc, plan.layoutName);
    expect(on.filter((e) => e.type === "viewport")).toHaveLength(1);
    expect(on.some((e) => e.type === "insert")).toBe(true);
    expect(on.some((e) => e.type === "polyline")).toBe(true);
    bus.undo();
    expect(layoutList(doc)).toHaveLength(0);
    expect(layoutEntities(doc, plan.layoutName)).toHaveLength(0);
    expect(doc.hasRecord("blocks", "TITLEBLOCK")).toBe(false);
    bus.redo();
    expect(layoutEntities(doc, plan.layoutName).length).toBe(on.length);
  });

  it("fit picks a standard scale at which the whole model is inside the window and the window inside the printable area", () => {
    const { doc, bus } = setup();
    const plan = planLayoutFromModel(doc, { paper: paperSpec("A3", "landscape") })!;
    expect(plan.fits).toBe(true);
    bus.execute(plan.commands[0]);
    const vp = layoutEntities(doc, plan.layoutName).find((e) => e.type === "viewport") as ViewportEntity;
    expect([0.1, 0.05, 0.02, 0.01, 0.005, 0.2, 0.04].some((s) => Math.abs(s - vp.scale) < 1e-9) || vp.scale > 0).toBe(true);
    const win = viewportModelWindow(vp);
    expect(win.minX).toBeLessThanOrEqual(0);
    expect(win.maxX).toBeGreaterThanOrEqual(4000);
    expect(win.minY).toBeLessThanOrEqual(0);
    expect(win.maxY).toBeGreaterThanOrEqual(2500);
    const pr = printableRectMm(getLayout(doc, plan.layoutName)!);
    expect(vp.center.x - vp.width / 2).toBeGreaterThanOrEqual(pr.x);
    expect(vp.center.x + vp.width / 2).toBeLessThanOrEqual(pr.x + pr.w);
    expect(vp.center.y - vp.height / 2).toBeGreaterThanOrEqual(pr.y);
    expect(vp.center.y + vp.height / 2).toBeLessThanOrEqual(pr.y + pr.h);
  });

  it("the window clears the title block", () => {
    const { doc, bus } = setup();
    const plan = planLayoutFromModel(doc, { paper: paperSpec("A4", "landscape") })!;
    bus.execute(plan.commands[0]);
    const vp = layoutEntities(doc, plan.layoutName).find((e) => e.type === "viewport") as ViewportEntity;
    // The title block occupies the lower 40 mm inside a 5 mm inset.
    expect(vp.center.y - vp.height / 2).toBeGreaterThanOrEqual(5 + 40);
  });

  it("an explicit scale is used as given and a model that does not fit is reported", () => {
    const { doc } = setup();
    const ok = planLayoutFromModel(doc, { paper: paperSpec("A0", "landscape"), scale: "1:20" })!;
    expect(ok.scale).toBeCloseTo(0.05);
    expect(ok.fits).toBe(true);
    const tooBig = planLayoutFromModel(doc, { paper: paperSpec("A4", "landscape"), scale: "1:1" })!;
    expect(tooBig.fits).toBe(false);
    expect(tooBig.warnings.join(" ")).toMatch(/cut off/);
  });

  it("a bad scale falls back to fit with a warning; numeric scales work", () => {
    const { doc } = setup();
    const bad = planLayoutFromModel(doc, { scale: "banana" })!;
    expect(bad.warnings.join(" ")).toMatch(/not a scale/);
    expect(bad.scale).toBeGreaterThan(0);
    expect(planLayoutFromModel(doc, { scale: 0.02 })!.scale).toBe(0.02);
    expect(planLayoutFromModel(doc, { scale: -3 })!.warnings.length).toBeGreaterThan(0);
    expect(planLayoutFromModel(doc, { scale: Number.NaN })!.warnings.length).toBeGreaterThan(0);
  });

  it("frames the selection instead of everything, ignoring unknown and paper ids", () => {
    const { doc } = setup([line("a", 0, 0, 100, 0), line("far", 5000, 5000, 5100, 5000)]);
    expect(modelFrameBounds(doc, ["a"])).toMatchObject({ minX: 0, maxX: 100 });
    expect(modelFrameBounds(doc, ["nope"])).toMatchObject({ maxX: 5100 });
    expect(modelFrameBounds(doc, [])).toMatchObject({ maxX: 5100 });
  });

  it("an empty drawing or a degenerate (single point) model", () => {
    expect(planLayoutFromModel(new SketchDocument())).toBeNull();
    const { doc } = setup([line("z", 10, 10, 10, 10)]);
    const p = planLayoutFromModel(doc)!;
    expect(p).not.toBeNull();
    expect(Number.isFinite(p.scale)).toBe(true);
  });

  it("a taken name gets a fresh one; a sheet too small for the title block keeps the viewport", () => {
    const { doc, bus } = setup();
    const first = planLayoutFromModel(doc, { name: "Plan" })!;
    bus.execute(first.commands[0]);
    expect(first.layoutName).toBe("Plan");
    const again = planLayoutFromModel(doc, { name: "Plan" })!;
    expect(again.layoutName).not.toBe("Plan");
    const tiny = planLayoutFromModel(doc, { name: "Tiny", paper: paperSpec("Custom", "landscape", { w: 120, h: 90 }) })!;
    expect(tiny.warnings.join(" ")).toMatch(/title block/);
    expect(JSON.stringify(tiny.commands)).toContain('"viewport"');
    expect(JSON.stringify(tiny.commands)).not.toContain("TITLEBLOCK");
  });

  it("a sheet with no usable area gives no plan", () => {
    const { doc } = setup();
    expect(planLayoutFromModel(doc, { paper: paperSpec("Custom", "landscape", { w: 15, h: 15 }), titleBlock: false })).toBeNull();
  });
});
