import { describe, expect, it } from "vitest";
import "../kinds/builtin";
import { CommandBus } from "../commands";
import { SketchDocument } from "../document";
import type { Entity } from "../entities";
import { layoutPageSize, plotColor, plotLayoutsToPdf } from "./plot";
import { paperSpec, newLayout } from "./types";
import { planTitleBlock } from "./titleBlock";
import { newViewport } from "./viewport";

/**
 * Plotting is where the sheet leaves the screen. What breaks if this regresses: a viewport that prints at the
 * wrong scale or position (a 1:50 view that measures 1:49 on paper), model geometry spilling outside its window,
 * or a multi-sheet file whose pages share one size. The PDF text is uncompressed, so geometry is checked in it.
 */
const PT = 72 / 25.4;
const latin1 = (b: Uint8Array) => Array.from(b, (c) => String.fromCharCode(c)).join("");

function setup() {
  const doc = new SketchDocument();
  const bus = new CommandBus(doc);
  bus.execute({ type: "add-layout", layout: newLayout("Plan", paperSpec("A4", "landscape")) });
  bus.execute({ type: "add-layout", layout: newLayout("Detail", paperSpec("A3", "portrait")) });
  bus.execute({ type: "add-entity", entity: { id: "m1", type: "line", a: { x: 0, y: 0 }, b: { x: 100, y: 0 }, color: "#ff0000" } as Entity });
  bus.execute({ type: "add-entity", entity: { id: "far", type: "line", a: { x: 9000, y: 9000 }, b: { x: 9100, y: 9000 } } as Entity });
  bus.execute({
    type: "add-entity",
    entity: newViewport({ x: 48.5, y: 55, w: 200, h: 100 }, { center: { x: 50, y: 0 }, scale: 0.5 }, { id: "vp1", space: "Plan" }),
  });
  return { doc, bus };
}

describe("layout plot", () => {
  it("pages take their layout's paper size, in order", () => {
    const { doc } = setup();
    const text = latin1(plotLayoutsToPdf(doc, ["Plan", "Detail"])!);
    expect((text.match(/\/Type \/Page /g) ?? []).length).toBe(2);
    const boxes = [...text.matchAll(/\/MediaBox \[0 0 ([\d.]+) ([\d.]+)\]/g)].map((m) => [Number(m[1]), Number(m[2])]);
    expect(boxes).toHaveLength(2);
    expect(boxes[0][0]).toBeCloseTo(297 * PT, 1);
    expect(boxes[0][1]).toBeCloseTo(210 * PT, 1);
    expect(boxes[1][0]).toBeCloseTo(297 * PT, 1);
    expect(boxes[1][1]).toBeCloseTo(420 * PT, 1);
    expect(layoutPageSize(newLayout("x", paperSpec("A4", "portrait"))).width).toBeCloseTo(210 * PT, 6);
  });

  it("a viewport prints the model at its scale, clipped to the window", () => {
    const { doc } = setup();
    const text = latin1(plotLayoutsToPdf(doc, ["Plan"])!);
    const clipAt = text.indexOf(" h W n");
    expect(clipAt).toBeGreaterThan(0);
    // Model (0,0)-(100,0) at 1:2 about view centre (50,0) lands at paper x 123.5..173.5, y 105.
    const m = /([\d.]+) ([\d.]+) m ([\d.]+) ([\d.]+) l S/g;
    const segs = [...text.matchAll(m)].map((r) => r.slice(1, 5).map(Number));
    const model = segs.find((s) => Math.abs(s[0] - 123.5 * PT) < 0.01 && Math.abs(s[2] - 173.5 * PT) < 0.01);
    expect(model, JSON.stringify(segs)).toBeTruthy();
    expect(model![1]).toBeCloseTo(105 * PT, 2);
    expect(model![3]).toBeCloseTo(105 * PT, 2);
    // It is drawn inside the clip (after it, before the closing Q), and the far-away line is culled.
    expect(text.indexOf(model!.slice(0, 1).map((v) => String(Math.round(v * 1000) / 1000))[0], clipAt)).toBeGreaterThan(clipAt);
    expect(segs.some((s) => s[0] > 1000)).toBe(false);
  });

  it("frozen layers stay out of that viewport, and hidden layers out of the file", () => {
    const { doc, bus } = setup();
    bus.execute({ type: "update-entity", entity: { ...doc.get("m1")!, layer: "WALLS" } as Entity });
    bus.execute({ type: "update-entity", entity: { ...doc.get("vp1")!, frozenLayers: ["WALLS"] } as Entity });
    const frozen = latin1(plotLayoutsToPdf(doc, ["Plan"])!);
    expect(frozen).not.toContain(String(Math.round(123.5 * PT * 1000) / 1000));
    bus.execute({ type: "update-entity", entity: { ...doc.get("vp1")!, frozenLayers: undefined } as Entity });
    bus.execute({ type: "put-table-record", table: "layers", record: { name: "WALLS", visible: false } });
    expect(latin1(plotLayoutsToPdf(doc, ["Plan"])!)).not.toContain(String(Math.round(123.5 * PT * 1000) / 1000));
  });

  it("monochrome inks black, grayscale keeps luminance, lineweights print at true mm", () => {
    const { doc, bus } = setup();
    bus.execute({ type: "update-entity", entity: { ...doc.get("m1")!, lineweight: 0.5 } as Entity });
    const asShown = latin1(plotLayoutsToPdf(doc, ["Plan"], { plotStyle: "as displayed" })!);
    expect(asShown).toContain("1 0 0 RG");
    expect(asShown).toContain(`${Math.round(0.5 * PT * 1000) / 1000} w`);
    expect(latin1(plotLayoutsToPdf(doc, ["Plan"], { plotStyle: "monochrome" })!)).not.toContain("1 0 0 RG");
    expect(plotColor("#ff0000", "grayscale")).toBe("#4c4c4c");
    expect(plotColor("#ff0000", "monochrome")).toBe("#000000");
    expect(plotColor("tomato", "grayscale")).toBe("tomato");
  });

  it("title block fields are evaluated for the sheet being plotted", () => {
    const { doc, bus } = setup();
    bus.execute({ type: "batch", commands: planTitleBlock(doc, "Detail")! });
    const text = latin1(plotLayoutsToPdf(doc, ["Plan", "Detail"])!);
    expect(text).toContain("(2 / 2)");
  });

  it("returns null when no named layout exists, skips unknown names", () => {
    const { doc } = setup();
    expect(plotLayoutsToPdf(doc, ["Nope"])).toBeNull();
    expect((latin1(plotLayoutsToPdf(doc, ["Nope", "Plan"])!).match(/\/Type \/Page /g) ?? []).length).toBe(1);
  });
});
