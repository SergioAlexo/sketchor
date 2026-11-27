import { expect, it } from "vitest";
import type { DocumentReadModel, Point } from "@sketchor/plugin-sdk";
import {
  buildPalletDrawing, buildPalletReportHtml, DEFAULT_PALLET_RULES, generatePalletPlan, palletSceneMatchesPlan,
  planFromPalletScene, readPalletReport, type PalletPlan, type ProductRow,
  stagePalletProducts,
} from "./index";

const mm = { unit: "mm", perMm: 1, label: "mm" } as const;
const row: ProductRow = {
  id: "unit", jobId: "example", productId: "Unit", lengthMm: 320, widthMm: 160,
  quantity: 3, canRotate: true, stack: { maxLayers: 2, pattern: "alternate" },
};

function draw(plan: PalletPlan): DocumentReadModel {
  return {
    revision: 0, groups: [], constraints: [],
    entities: buildPalletDrawing(plan, mm).flatMap(cmd => cmd.type === "add-entity" ? [cmd.entity] : []),
  };
}

function editGeometry(
  model: DocumentReadModel, product: string, points: (original: Point[]) => Point[],
): DocumentReadModel {
  return { ...model, entities: model.entities.map(entity => entity.type === "polyline" && entity.name === `Product ${product}`
    ? { ...entity, points: points(entity.points) } : entity) };
}

it("adopts three separated groups at their drawn locations and preserves the combined stack", () => {
  const source = generatePalletPlan({
    products: [row, { ...row, id: "wide", quantity: 1, stack: undefined }],
    rules: DEFAULT_PALLET_RULES,
  }, { id: "plan", revisionId: "generated", parentRevisionId: null });
  const original = draw(source);
  const model = editGeometry(editGeometry(editGeometry(original, "unit/1", () => [
    { x: 60, y: 0 }, { x: 60, y: 320 }, { x: -100, y: 320 }, { x: -100, y: 0 },
  ]), "unit/2", points => points.map(p => ({ x: p.x + 1000, y: p.y }))),
  "wide/1", points => points.map(p => ({ x: p.x + 2200, y: p.y })));
  expect(palletSceneMatchesPlan(source, original)).toBe(true);
  expect(palletSceneMatchesPlan(source, model)).toBe(false);
  const next = planFromPalletScene(source, model, [], { type: "group" }, "scene");
  expect(next.pallets.map(pallet => pallet.placements.map(unit => [unit.id, unit.layer]))).toEqual([
    [["unit/1", 1], ["unit/3", 2]], [["unit/2", 1]], [["wide/1", 1]],
  ]);
  expect(next.pallets[0].placements.map(unit => unit.rotation)).toEqual([90, 90]);
  expect(next.pallets[0].sceneOrigin?.x).toBeCloseTo(-138.1);
  expect(next.pallets[0].sceneOrigin?.y).toBeCloseTo(-38.1);
  expect(palletSceneMatchesPlan(next, draw(next))).toBe(true);
  expect(readPalletReport(buildPalletReportHtml(next, "mm"))).toEqual(next);
  expect(next.generation).toEqual(source.generation);
  const selected = model.entities.filter(entity => entity.name === "Product unit/1" || entity.name === "Product unit/2");
  const forced = planFromPalletScene(source, model, selected.map(entity => entity.id), { type: "group-selection" }, "selection");
  expect(forced.pallets.map(pallet => pallet.placements.length)).toEqual([3]);
  expect(forced.looseStacks?.[0].placements[0].id).toBe("wide/1");
});

it("moves the top unit of the selected 2D stack onto the Shift-selected support", () => {
  const source = generatePalletPlan({ products: [row], rules: DEFAULT_PALLET_RULES },
    { id: "plan", revisionId: "generated", parentRevisionId: null });
  const model = draw(source);
  const select = (unit: string) => model.entities.find(entity => entity.name === `Product ${unit}`)!.id;
  const selected = [select("unit/1"), select("unit/2")];
  const next = planFromPalletScene(source, model, selected, { type: "layer", layer: 2 }, "layer");
  expect(next.pallets.flatMap(pallet => pallet.placements).find(unit => unit.id === "unit/3")).toMatchObject({
    layer: 2, supportId: "unit/2",
  });
  expect(() => planFromPalletScene(source, model, selected, { type: "layer", layer: 3 }, "bad"))
    .toThrow(/supporting stack/);
  expect(palletSceneMatchesPlan(next, draw(next))).toBe(true);
});

it("starts 17 separate products, stacks by drop, and forms only the selected pallet", () => {
  const IN = 25.4;
  const products: ProductRow[] = [
    ["A", 6, 26, 6.5, 36],
    ["B", 3, 72, 27.11, 38.32],
    ["C", 6, 72, 24, 25.38],
    ["D", 2, 82, 36, 30.75],
  ].map(([productId, quantity, length, width, height]) => ({
    id: String(productId), jobId: "24514", productId: String(productId), quantity: Number(quantity),
    lengthMm: Number(length) * IN, widthMm: Number(width) * IN, heightMm: Number(height) * IN, canRotate: true,
  }));
  const rules = { ...DEFAULT_PALLET_RULES, maxLayers: 4 };
  const version = { id: "manual", revisionId: "start", parentRevisionId: null };
  let plan = stagePalletProducts({ products, rules }, null, version);
  expect(plan.looseStacks).toHaveLength(17);
  expect(plan.pallets).toEqual([]);
  expect(plan.unplaced).toHaveLength(17);
  expect(draw(plan).entities.some(e => e.type === "text" && e.text === "A6")).toBe(true);
  expect(palletSceneMatchesPlan(plan, draw(plan))).toBe(true);
  const select = (model: DocumentReadModel, id: string) => model.entities.find(entity => entity.name === `Product ${id}`)!.id;
  function drop(source: string, target: string) {
    const model = draw(plan);
    plan = planFromPalletScene(plan, model, [], { type: "drop", sourceId: select(model, source), targetId: select(model, target) },
      "drop-" + source.replace("/", "-"));
  }
  drop("A/2", "A/1");
  expect(plan.looseStacks).toHaveLength(16);
  expect(draw(plan).entities.some(e => e.type === "text" && e.text === "A1 / A2")).toBe(true);
  drop("A/4", "A/3");
  drop("A/6", "A/5");
  drop("B/2", "B/1");
  drop("B/3", "B/1");
  drop("C/6", "C/5");
  const group = ["B/1", "C/5", "A/1", "A/3", "A/5"];
  const positions = [0, 29.11, 55.11, 63.61, 72.11];
  let model = draw(plan);
  for (const [i, id] of group.entries()) {
    const x = positions[i] * IN;
    const row = products.find(product => id.startsWith(product.id))!;
    model = editGeometry(model, id, () => [
      { x: x + row.widthMm, y: 0 }, { x: x + row.widthMm, y: row.lengthMm },
      { x, y: row.lengthMm }, { x, y: 0 },
    ]);
  }
  plan = planFromPalletScene(plan, model, group.map(id => select(model, id)), { type: "group-selection" }, "first-pallet");
  expect(plan.pallets).toHaveLength(1);
  expect(plan.pallets[0].base).toEqual({ lengthMm: 82 * IN, widthMm: 75 * IN });
  expect(plan.pallets[0].placements).toHaveLength(11);
  expect(plan.unplaced).toHaveLength(6);
  expect(plan.looseStacks).toHaveLength(6);
  expect(palletSceneMatchesPlan(plan, draw(plan))).toBe(true);
  const before = plan.pallets[0];
  let next = stagePalletProducts({ products: [...products, { ...products[0], id: "E", productId: "E", quantity: 1 }], rules },
    plan, { ...version, revisionId: "add-row" });
  expect(next.pallets[0]).toEqual(before);
  expect(next.looseStacks).toHaveLength(7);
  model = draw(plan);
  const deck = model.entities.find(entity => entity.name === `Pallet ${before.id}`)!;
  next = planFromPalletScene(plan, model, [deck.id], { type: "release" }, "release");
  expect(next.pallets).toHaveLength(0);
  expect(next.unplaced).toHaveLength(17);
  expect(readPalletReport(buildPalletReportHtml(next, "in"))).toEqual(next);
});
