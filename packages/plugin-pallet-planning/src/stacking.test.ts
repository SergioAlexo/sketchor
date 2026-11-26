import { expect, it } from "vitest";
import {
  buildPalletDrawing, buildPalletReportCsv, buildPalletReportHtml, editPalletPlan, generatePalletPlan,
  DEFAULT_PALLET_RULES, isUpsideDown, palletReportFileName, parsePalletPlan, readPalletReport,
  REFERENCE_RULES, type PalletRules, type ProductRow,
} from "./index";

const IN = 25.4;
const version = { id: "bench-plan", revisionId: "generated", parentRevisionId: null };
const bench: ProductRow = {
  id: "bench-row", jobId: "BENCH-DEMO", productId: "Bench",
  lengthMm: 30 * IN, widthMm: 15 * IN, heightMm: 18 * IN, quantity: 7, canRotate: false,
  stack: { maxLayers: 3, pattern: "alternate", addedHeightMm: 5 * IN },
};
const generate = (rules: Partial<PalletRules> = {}, product = bench) => generatePalletPlan({
  products: [product], rules: { ...REFERENCE_RULES, maxLengthMm: 32 * IN, maxWidthMm: 49 * IN, ...rules },
}, version);

it("reopens the complete plan from one HTML report with an embedded CSV", () => {
  const plan = generate({}, { ...bench, productId: 'A </script><script>alert("example")</script>' });
  const html = buildPalletReportHtml(plan, "in");
  expect(html).toContain('id="sketchor-pallet-analysis"');
  expect(html).toContain("final_support_unit_id");
  expect(html).not.toContain("</script><script>");
  expect(readPalletReport(html)).toEqual(plan);
  expect(readPalletReport(JSON.stringify(plan))).toEqual(plan);
  expect(() => readPalletReport("<p>Unrelated HTML</p>")).toThrow(/no embedded/);
});

it("names reports from unique, file-safe job numbers and Winnipeg time", () => {
  const plan = generate({}, { ...bench, jobId: "237/71" });
  plan.products.push(bench, { ...bench, id: "row-3", jobId: "237/71" });
  expect(palletReportFileName(plan, new Date("2026-07-15T20:05:32.047Z")))
    .toBe("237-71_BENCH-DEMO_2026-07-15_15-05-32-047.html");
});

it("places six benches in two layers and makes a smaller base for the seventh", () => {
  const plan = generate({ maxLayers: 2 });
  expect(plan.pallets.map(p => p.placements.length)).toEqual([6, 1]);
  expect(plan.pallets[0].base.widthMm).toBeCloseTo(49 * IN);
  expect(plan.pallets[1].base.widthMm).toBeCloseTo(17 * IN);
  expect(plan.pallets[1].placements[0]).toMatchObject({ id: "bench-row/7", layer: 1 });
  expect(plan.pallets[0].placements.filter(item => isUpsideDown(bench, item.layer))).toHaveLength(3);
  expect(parsePalletPlan(plan)).toEqual(plan);
});

it("uses a third level only after filling the first two levels", () => {
  const plan = generate({ maxLayers: 3 });
  expect(plan.pallets).toHaveLength(1);
  const items = plan.pallets[0].placements;
  expect(items.map(item => item.layer)).toEqual([1, 1, 1, 2, 2, 2, 3]);
  expect(items[6].id).toBe("bench-row/7");
  expect(isUpsideDown(bench, items[6].layer)).toBe(false);
  const groups = buildPalletDrawing(plan, { unit: "in", perMm: 1 / IN, label: "in" })
    .filter(c => c.type === "group-entities");
  expect(groups.map(c => c.name)).toEqual([
    "P1 · BENCH-DEMO · 32 × 49 in",
    "Bench #1 / Bench #4 / Bench #7",
    "Bench #2 / Bench #5",
    "Bench #3 / Bench #6",
  ]);
});

it("requires explicit stacking permission and an aligned support on the preceding layer", () => {
  expect(generate({}, { ...bench, stack: undefined }).pallets.map(p => p.placements.length)).toEqual([3, 3, 1]);
  const plan = generate();
  const pallet = plan.pallets[0];
  const topUnit = pallet.placements.at(-1)!;
  expect(() => editPalletPlan(plan, {
    type: "place", palletId: pallet.id, unitId: topUnit.id, xMm: IN, yMm: 2 * IN, rotation: 0, layer: 3,
  }, "offset")).toThrow(/directly below/);
  expect(() => editPalletPlan(plan, {
    type: "unplace", unitId: pallet.placements[0].id,
  }, "unsupported")).toThrow(/directly below/);
});

it("accounts for the measured stack increment and deck in the loaded height limit", () => {
  const plan = generate({ deckHeightMm: 4 * IN, maxLoadedHeightMm: 27 * IN });
  expect(plan.pallets.map(p => p.placements.length)).toEqual([6, 1]);
  expect(plan.pallets[0].packedHeightMm).toBeCloseTo(27 * IN);
  const tooShort = generate({ deckHeightMm: 4 * IN, maxLoadedHeightMm: 21 * IN });
  expect(tooShort.pallets).toHaveLength(0);
  expect(tooShort.unplaced.map(item => item.reason)).toEqual(Array(7).fill("height"));
  expect(() => generate({ deckHeightMm: 4 * IN, maxLoadedHeightMm: 27 * IN }, {
    ...bench, stack: { maxLayers: 3, pattern: "alternate" },
  })).toThrow(/measured added height/);
});

it("uses the larger measured footprint before choosing a pallet size", () => {
  const measured = { ...bench, measuredLengthMm: 31 * IN, measuredWidthMm: 14 * IN };
  expect(generate({}, measured).unplaced).toHaveLength(7);
  const plan = generate({ maxLengthMm: 33 * IN }, measured);
  expect(plan.pallets[0].base.lengthMm).toBeCloseTo(33 * IN);
  expect(plan.pallets[0].base.widthMm).toBeCloseTo(49 * IN);
  expect(() => parsePalletPlan(plan)).not.toThrow();
});

it("adds product padding on both sides and a separate inset around the pallet", () => {
  const rules = { ...DEFAULT_PALLET_RULES, maxLengthMm: 52 * IN, maxWidthMm: 33 * IN, maxLayers: 2 } as const;
  const turnable = { ...bench, canRotate: true };
  const plan = generate(rules, turnable);
  expect(plan.pallets.map(p => p.placements.length)).toEqual([6, 1]);
  expect(plan.pallets[1].base.widthMm).toBeCloseTo(18 * IN);
  const [first, second] = plan.pallets[0].placements;
  expect(first.xMm).toBeCloseTo(1.5 * IN);
  expect(second.xMm - first.xMm - bench.widthMm).toBeCloseTo(2 * IN);
  expect(parsePalletPlan(plan)).toEqual(plan);
  const reduced = generate({ ...rules, productMarginMm: 0 }, turnable);
  expect(reduced.pallets[0].base.lengthMm).toBeLessThan(plan.pallets[0].base.lengthMm);
  expect(buildPalletReportHtml(plan, "in")).toContain("Product padding 1 in per side");
  expect(buildPalletReportHtml(plan, "in")).toContain("Fork entry is on the pallet's length side");
});

it("allows square and wider-than-long bases", () => {
  const plan = generate({ ...DEFAULT_PALLET_RULES, maxLengthMm: 40 * IN, maxWidthMm: 40 * IN }, {
    ...bench, lengthMm: 30 * IN, widthMm: 30 * IN, quantity: 1,
  });
  expect(plan.pallets[0].base.lengthMm).toBeCloseTo(33 * IN);
  expect(plan.pallets[0].base.widthMm).toBeCloseTo(33 * IN);
  const edited = editPalletPlan(plan, {
    type: "add-pallet", jobId: bench.jobId, base: { lengthMm: 33 * IN, widthMm: 34 * IN },
  }, "wide");
  expect(edited.pallets[1].base).toEqual({ lengthMm: 33 * IN, widthMm: 34 * IN });
  const stock = generate({
    ...DEFAULT_PALLET_RULES, allowCustom: false,
    standardBases: [{ name: "Wide", lengthMm: 33 * IN, widthMm: 34 * IN }],
  }, { ...bench, quantity: 1 });
  expect(stock.pallets[0].baseName).toBe("Wide");
});

it("sizes a mixed pallet to its footprint without extending its length past the width", () => {
  const products = [
    { ...bench, id: "a", productId: "A", lengthMm: 71 * IN, widthMm: 63 * IN, quantity: 2 },
    { ...bench, id: "b", productId: "B", lengthMm: 71 * IN, widthMm: 23 * IN, quantity: 2 },
    { ...bench, id: "c", productId: "C", lengthMm: 72 * IN, widthMm: 24 * IN, quantity: 4 },
  ];
  const rules = { ...DEFAULT_PALLET_RULES, maxLayers: 2 } as const;
  const [mixed] = generatePalletPlan({ products: products.slice(1), rules }, version).pallets;
  expect(mixed.base.lengthMm).toBeCloseTo(75 * IN);
  expect(mixed.base.widthMm).toBeCloseTo(78 * IN);
  expect(mixed.placements).toHaveLength(6);
  const plan = generatePalletPlan({ products, rules }, version);
  expect(plan.unplaced).toEqual([]);
  expect(plan.pallets).toHaveLength(2);
  const area = plan.pallets.reduce((sum, pallet) => sum + pallet.base.lengthMm * pallet.base.widthMm, 0);
  expect(area / (IN * IN)).toBeLessThanOrEqual(75 * 78 + 74 * 66);
});

it("supports a fourth layer with orientation, height limits, and report reopening", () => {
  const product: ProductRow = { ...bench, quantity: 4, stack: { maxLayers: 4, pattern: "alternate", addedHeightMm: 5 * IN } };
  const rules = { maxLayers: 4, maxWidthMm: 20 * IN } as const;
  const plan = generate(rules, product);
  expect(plan.pallets).toHaveLength(1);
  expect(plan.pallets[0].placements.map(item => item.layer)).toEqual([1, 2, 3, 4]);
  expect(plan.pallets[0].packedHeightMm).toBeCloseTo(33 * IN);
  expect(isUpsideDown(product, 4)).toBe(true);
  const report = buildPalletReportHtml(plan, "in");
  expect(report).toContain("<td>Bench #4</td><td>4</td><td>Upside down</td>");
  expect(readPalletReport(report)).toEqual(plan);
  expect(generate({ ...rules, maxLoadedHeightMm: 32 * IN }, product).pallets.map(p => p.placements.length))
    .toEqual([3, 1]);
});

it("supports a stack-height cap without a deck height", () => {
  const plan = generate({ maxLoadedHeightMm: 23 * IN });
  expect(plan.pallets.map(p => p.placements.length)).toEqual([6, 1]);
  expect(plan.pallets[0].packedHeightMm).toBeCloseTo(23 * IN);
});

it("exports the loading sequence, supporting units and original vs edited coordinates", () => {
  const generated = generate({ maxLengthMm: 34 * IN });
  const pallet = generated.pallets[0];
  const resized = editPalletPlan(generated, {
    type: "resize", palletId: pallet.id, base: { lengthMm: 34 * IN, widthMm: 49 * IN },
  }, "resized");
  const moved = editPalletPlan(resized, {
    type: "move-stack", palletId: pallet.id, unitId: "bench-row/1", xMm: 2 * IN, yMm: IN,
  }, "moved");
  expect(moved.pallets[0].placements.filter(p => p.xMm === 2 * IN).map(p => p.layer)).toEqual([1, 2, 3]);
  expect(moved.generation?.pallets[0].placements[0].xMm).toBeCloseTo(IN);
  const [header, ...rows] = buildPalletReportCsv(moved).trimEnd().split("\r\n");
  expect(rows).toHaveLength(7);
  const top = Object.fromEntries(header.split(",").map((key, i) => [key, rows[6].split(",")[i]]));
  expect(top).toMatchObject({
    revision_id: '"moved"', generated_revision_id: '"generated"', final_layer: "3",
    final_support_unit_id: '"bench-row/4"', final_upside_down: '"false"',
    generated_x_mm: "25.4", final_x_mm: "50.8", changed_since_generation: '"true"',
  });
  const html = buildPalletReportHtml(moved, "in");
  expect(html.match(/class="diagram"/g)).toHaveLength(1);
  expect(html.match(/class="piece"/g)).toHaveLength(3);
  expect(html).toContain("Bench #1 / Bench #4 / Bench #7");
  expect(html).toContain("<td>Bench #7</td><td>3</td>");
  expect(html).toContain("Upside down");
  expect(html).toContain("Bench #7");
});

it("opens prior single-layer JSON and escapes report labels", () => {
  const flat = generate({ maxLayers: 1 }, { ...bench, jobId: "=test", productId: "<Bench>", stack: undefined });
  const { generation, ...legacy } = flat;
  const migrated = parsePalletPlan({
    ...legacy, schemaVersion: 1,
    pallets: legacy.pallets.map(pallet => ({
      ...pallet, placements: pallet.placements.map(({ layer, ...item }) => item),
    })),
  });
  expect(migrated.schemaVersion).toBe(2);
  expect(migrated.pallets[0].placements[0].layer).toBe(1);
  expect(migrated.generation).toBeUndefined();
  expect(buildPalletReportHtml(migrated, "mm")).toContain("&lt;Bench&gt;");
  expect(buildPalletReportCsv(migrated)).toContain("\"'=test\"");
});
