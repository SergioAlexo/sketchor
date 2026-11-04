/**
 * Why this matters (L-09): a company's sheet template installs without a signature because it is data only. These
 * pin that it really is (no code, no permissions, no path traversal), that a template survives the trip from a
 * `.sketchor` / DXF file into a drawing (layout, title block, viewport, its block), and that hostile or empty
 * files give errors, never a throw or a half-added sheet.
 */
import { describe, expect, it } from "vitest";
import { CommandBus } from "../commands";
import { SketchDocument } from "../document";
import { entitiesToDxf2018 } from "../dxfw";
import type { Entity, ViewportEntity } from "../entities";
import "../kinds/builtin";
import { planTitleBlock } from "../layouts/titleBlock";
import { getLayout, layoutEntities, layoutList, newLayout, paperSpec } from "../layouts/types";
import { newViewport } from "../layouts/viewport";
import { HOST_API_VERSION } from "./hostApi";
import { isLayoutTemplateBundle, loadLayoutTemplateBundle, planFromTemplate } from "./layoutTemplateBundle";
import { isLayoutTemplatesOnly, validateManifest } from "./manifest";

const manifest = (extra: Record<string, unknown> = {}, files: object[] = [{ file: "sheets/a3.sketchor", title: "A3 company" }]) =>
  JSON.stringify({ id: "com.example.sheets", version: "1.0.0", name: "Example sheets", engines: { sketchor: "^1.0.0" }, contributes: { layoutTemplates: files }, ...extra });

/** A drawing with one A3 layout: border + title block + a viewport. */
function templateDoc(): SketchDocument {
  const doc = new SketchDocument();
  const bus = new CommandBus(doc);
  bus.execute({ type: "add-layout", layout: newLayout("Company A3", paperSpec("A3", "landscape")) });
  bus.execute({ type: "batch", commands: planTitleBlock(doc, "Company A3")! });
  bus.execute({ type: "add-entity", entity: newViewport({ x: 20, y: 60, w: 250, h: 180 }, { center: { x: 0, y: 0 }, scale: 1 }, { id: "tv", space: "Company A3" }) });
  return doc;
}

const sketchorText = () => JSON.stringify(templateDoc().toJSON());

function load(files: Record<string, string>, extra: Record<string, unknown> = {}, list?: object[]) {
  const r = loadLayoutTemplateBundle({ manifest: manifest(extra, list), templates: files });
  if (!r.ok) throw new Error(r.errors.join("; "));
  return r;
}

describe("layout template bundles", () => {
  it("lists a .sketchor template with its layout, entities and block", () => {
    const r = load({ "sheets/a3.sketchor": sketchorText() });
    expect(r.templates).toHaveLength(1);
    const t = r.templates[0];
    expect(t.title).toBe("A3 company");
    expect(t.layouts.map((l) => l.name)).toEqual(["Company A3"]);
    expect(t.entities.map((e) => e.type).sort()).toEqual(["insert", "polyline", "viewport"]);
    expect(t.blocks.map((b) => b.name)).toContain("TITLEBLOCK");
  });

  it("reads a Sketchor-written DXF too", () => {
    const src = templateDoc();
    const layouts = layoutList(src).map((layout) => ({ layout, entities: layoutEntities(src, layout.name) }));
    const dxf = entitiesToDxf2018([], { blocks: src.records("blocks") as never, layouts });
    const r = load({ "sheets/a3.dxf": dxf }, {}, [{ file: "sheets/a3.dxf", title: "From DXF" }]);
    expect(r.templates[0].layouts[0].paper.size).toBe("A3");
    expect(r.templates[0].entities.some((e) => e.type === "viewport")).toBe(true);
  });

  it("plans one undoable batch that brings the layout, entities and block into a drawing", () => {
    const t = load({ "sheets/a3.sketchor": sketchorText() }).templates[0];
    const doc = new SketchDocument();
    const bus = new CommandBus(doc);
    bus.execute({ type: "add-entity", entity: { id: "m", type: "line", a: { x: 0, y: 0 }, b: { x: 2000, y: 1000 } } as Entity });
    const plan = planFromTemplate(doc, t)!;
    expect(plan.layoutNames).toEqual(["Company A3"]);
    bus.execute(plan.commands[0]);
    expect(getLayout(doc, "Company A3")?.paper.size).toBe("A3");
    const on = layoutEntities(doc, "Company A3");
    expect(on).toHaveLength(3);
    expect(on.every((e) => e.id !== "tv")).toBe(true);
    expect(doc.hasRecord("blocks", "TITLEBLOCK")).toBe(true);
    // The viewport was pointed at the drawing: 2000 x 1000 in a 250 x 180 window.
    const vp = on.find((e) => e.type === "viewport") as ViewportEntity;
    expect(vp.viewCenter).toEqual({ x: 1000, y: 500 });
    expect(vp.scale).toBeLessThan(0.125);
    expect(vp.scale * 2000).toBeLessThanOrEqual(250);
    bus.undo();
    expect(layoutList(doc)).toHaveLength(0);
    expect(doc.hasRecord("blocks", "TITLEBLOCK")).toBe(false);
    expect(doc.all()).toHaveLength(1);
  });

  it("fit:false keeps the template's own view; a taken layout name is suffixed and the entities follow it", () => {
    const t = load({ "sheets/a3.sketchor": sketchorText() }).templates[0];
    const doc = new SketchDocument();
    const bus = new CommandBus(doc);
    bus.execute({ type: "add-layout", layout: newLayout("Company A3") });
    const plan = planFromTemplate(doc, t, { fit: false })!;
    expect(plan.layoutNames).toEqual(["Company A3 (2)"]);
    expect(plan.warnings.join(" ")).toMatch(/exists/);
    bus.execute(plan.commands[0]);
    const vp = layoutEntities(doc, "Company A3 (2)").find((e) => e.type === "viewport") as ViewportEntity;
    expect(vp.scale).toBe(1);
    expect(layoutEntities(doc, "Company A3")).toHaveLength(0);
    const named = planFromTemplate(doc, t, { name: "Mine" })!;
    expect(named.layoutNames).toEqual(["Mine"]);
  });

  it("keeps the drawing's own block when the name is taken", () => {
    const t = load({ "sheets/a3.sketchor": sketchorText() }).templates[0];
    const doc = new SketchDocument();
    const bus = new CommandBus(doc);
    bus.execute({ type: "put-table-record", table: "blocks", record: { name: "TITLEBLOCK", basePoint: { x: 0, y: 0 }, entities: [], attributeDefs: [], description: "mine" } });
    bus.execute(planFromTemplate(doc, t)!.commands[0]);
    expect((doc.getRecord("blocks", "TITLEBLOCK") as { description?: string }).description).toBe("mine");
  });

  it("a template with no layout, or no template at all, gives no plan", () => {
    expect(planFromTemplate(new SketchDocument(), { title: "x", file: "x.dxf", layouts: [], entities: [], blocks: [] })).toBeNull();
  });
});

describe("it is data only, and hostile input does not throw", () => {
  it("rejects code, permissions, path traversal and bad titles", () => {
    expect(isLayoutTemplatesOnly(JSON.parse(manifest()))).toBe(true);
    expect(isLayoutTemplatesOnly(JSON.parse(manifest({ main: "x.js" })))).toBe(false);
    expect(isLayoutTemplatesOnly(JSON.parse(manifest({ permissions: ["document.read"] })))).toBe(false);
    for (const bad of ["../x.dxf", "/etc/x.dxf", "c:/x.dxf", "a\\b.dxf", "x.txt", "x.js"]) {
      expect(validateManifest(JSON.parse(manifest({}, [{ file: bad, title: "t" }]))).ok, bad).toBe(false);
    }
    expect(validateManifest(JSON.parse(manifest({}, [{ file: "a.dxf", title: "" }]))).ok).toBe(false);
    expect(validateManifest(JSON.parse(manifest({}, [{ file: "a.dxf", title: "x".repeat(61) }]))).ok).toBe(false);
    expect(validateManifest(JSON.parse(manifest({ contributes: { layoutTemplates: "a" } }))).ok).toBe(false);
    const r = loadLayoutTemplateBundle({ manifest: manifest({ main: "x.js" }), templates: {} });
    expect(r.ok).toBe(false);
  });

  it("reports missing, empty, malformed and layout-less files as errors", () => {
    const errs = (files: Record<string, string>) => {
      const r = loadLayoutTemplateBundle({ manifest: manifest(), templates: files });
      return r.ok ? [] : r.errors;
    };
    expect(errs({}).join()).toMatch(/missing/);
    expect(errs({ "sheets/a3.sketchor": "" }).length).toBeGreaterThan(0);
    expect(errs({ "sheets/a3.sketchor": "{not json" }).length).toBeGreaterThan(0);
    expect(errs({ "sheets/a3.sketchor": JSON.stringify(new SketchDocument().toJSON()) }).join()).toMatch(/no layout/);
    const dxf = errs({ "sheets/a3.sketchor": "0\nSECTION\n2\nENTITIES\n0\nLINE\n" });
    expect(dxf.length).toBeGreaterThan(0);
    expect(loadLayoutTemplateBundle({ manifest: "nope", templates: {} }).ok).toBe(false);
    expect(errs({ "sheets/a3.sketchor": "x".repeat(5 * 1024 * 1024) }).join()).toMatch(/larger/);
  });

  it("recognises a bundle shape and bumps the host API additively", () => {
    expect(isLayoutTemplateBundle({ manifest: "{}", templates: {} })).toBe(true);
    expect(isLayoutTemplateBundle({ manifest: "{}", templates: {}, code: "x" })).toBe(false);
    expect(isLayoutTemplateBundle(null)).toBe(false);
    expect(HOST_API_VERSION).toBe("0.12.0");
  });
});
