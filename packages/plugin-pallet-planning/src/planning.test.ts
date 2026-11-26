import { describe, expect, it } from "vitest";
import { nestByOrders, validateNest } from "@sketchor/plugin-truck-nesting";
import {
  buildPalletDrawing, editPalletPlan, generatePalletPlan, parsePalletPlan,
  REFERENCE_RULES, toTruckOrders, type PalletRules, type ProductRow,
} from "./index";

const IN = 25.4;
const version = { id: "demo-plan", revisionId: "generated", parentRevisionId: null };
const cartons: ProductRow = {
  id: "row-1", jobId: "demo", productId: "Long carton",
  lengthMm: 80 * IN, widthMm: 18 * IN, quantity: 2, canRotate: false,
};
const generate = (products = [cartons], rules: Partial<PalletRules> = {}) =>
  generatePalletPlan({ products, rules: { ...REFERENCE_RULES, ...rules } }, version);

describe("product-to-pallet generation", () => {
  it("fits two cartons side by side with one gap and both edge clearances", () => {
    const plan = generate();
    expect(plan.pallets).toHaveLength(1);
    expect(plan.unplaced).toEqual([]);
    const { base, placements } = plan.pallets[0];
    expect(base.lengthMm).toBeCloseTo(82 * IN);
    expect(base.widthMm).toBeCloseTo(39 * IN);
    expect(placements.map(p => p.xMm)).toEqual([IN, IN]);
    expect(placements[1].yMm - placements[0].yMm).toBeCloseTo(19 * IN);
    expect(() => parsePalletPlan(plan)).not.toThrow();
    expect(generate()).toEqual(plan);
  });

  it("prefers a standard base at equal count and area", () => {
    const plan = generate([cartons], { standardBases: [{ lengthMm: 82 * IN, widthMm: 39 * IN, name: "Demo stock" }] });
    expect(plan.pallets[0]).toMatchObject({ baseSource: "standard", baseName: "Demo stock" });
  });

  it("uses different stock sizes in stock-only mode", () => {
    const small: ProductRow = { ...cartons, id: "row-2", quantity: 1, lengthMm: 30 * IN };
    const plan = generate([cartons, small], {
      allowCustom: false,
      standardBases: [
        { lengthMm: 32 * IN, widthMm: 20 * IN, name: "Small" },
        { lengthMm: 82 * IN, widthMm: 39 * IN, name: "Long" },
      ],
    });
    expect(plan.pallets.map(p => p.baseName)).toEqual(["Long", "Small"]);
    expect(plan.unplaced).toEqual([]);
    expect(() => parsePalletPlan(plan)).not.toThrow();
  });

  it("turns only permitted products and accounts for units that do not fit", () => {
    const tight = { maxLengthMm: 54 * IN, maxWidthMm: 89 * IN };
    const locked = generate([cartons], tight);
    expect(locked.pallets).toEqual([]);
    expect(locked.unplaced).toHaveLength(2);
    const turned = generate([{ ...cartons, canRotate: true }], tight);
    expect(turned.pallets[0].placements.map(p => p.rotation)).toEqual([90, 90]);
    expect(() => parsePalletPlan(turned)).not.toThrow();
  });

  it("does not round a custom base past its cap", () => {
    const plan = generate([{ ...cartons, lengthMm: 79.25 * IN, quantity: 1 }], { maxLengthMm: 81.5 * IN });
    expect(plan.pallets).toEqual([]);
    expect(plan.unplaced[0].reason).toBe("size");
  });

  it("separates jobs and rejects fractional quantities and duplicate rows", () => {
    const different = { ...cartons, id: "row-2", jobId: "second" };
    expect(generate([cartons, different]).pallets.map(p => p.jobId)).toEqual(["demo", "second"]);
    expect(() => generate([{ ...cartons, quantity: 1.25 }])).toThrow(/whole number/);
    expect(() => generate([cartons, cartons])).toThrow(/duplicate row/);
  });
});

describe("editable revisions", () => {
  it("resizes a base, rejects overlap, and keeps the old revision", () => {
    const plan = generate();
    const pallet = plan.pallets[0];
    const moved = editPalletPlan(plan, {
      type: "resize", palletId: pallet.id, base: { lengthMm: 84 * IN, widthMm: 39 * IN },
    }, "resize");
    expect(moved.parentRevisionId).toBe(plan.revisionId);
    expect(moved.pallets[0].base.lengthMm).toBeCloseTo(84 * IN);
    expect(plan.pallets[0].base.lengthMm).toBeCloseTo(82 * IN);
    const first = pallet.placements[0];
    expect(() => editPalletPlan(moved, {
      type: "place", palletId: pallet.id, unitId: pallet.placements[1].id,
      xMm: first.xMm, yMm: first.yMm, rotation: 0,
    }, "bad-move")).toThrow(/overlap/);
    expect(moved.revisionId).toBe("resize");
  });

  it("moves units across same-job pallets and checks quantity on JSON import", () => {
    const plan = generate();
    const first = plan.pallets[0].placements[0];
    const withNew = editPalletPlan(plan, {
      type: "add-pallet", jobId: "demo", base: { lengthMm: 82 * IN, widthMm: 20 * IN },
    }, "added");
    const target = withNew.pallets[1];
    const moved = editPalletPlan(withNew, {
      type: "place", palletId: target.id, unitId: first.id, xMm: IN, yMm: IN, rotation: 0,
    }, "transferred");
    expect(moved.pallets.map(p => p.placements.length)).toEqual([1, 1]);
    const saved = JSON.parse(JSON.stringify(moved));
    expect(parsePalletPlan(saved)).toEqual(moved);
    saved.pallets[0].placements.push(saved.pallets[1].placements[0]);
    expect(() => parsePalletPlan(saved)).toThrow(/assigned twice/);
  });

  it("keeps unplaced items available for editing and requires all items to confirm", () => {
    const generated = generate();
    const item = generated.pallets[0].placements[0];
    const draft = editPalletPlan(generated, { type: "unplace", unitId: item.id }, "removed");
    expect(draft.unplaced).toEqual([{ id: item.id, rowId: item.rowId, reason: "manual" }]);
    expect(() => editPalletPlan(draft, { type: "confirm" }, "confirmed")).toThrow(/Place every product/);
    expect(() => editPalletPlan(draft, {
      type: "place", palletId: draft.pallets[0].id, unitId: item.id, xMm: IN, yMm: IN, rotation: 90,
    }, "bad-turn")).toThrow(/cannot be turned/);
  });

  it("rejects empty, incomplete, and unsupported plan records", () => {
    expect(() => parsePalletPlan(null)).toThrow(/missing or invalid/);
    expect(() => parsePalletPlan({ ...generate(), pallets: [] })).toThrow(/missing product units/);
    expect(() => parsePalletPlan({ ...generate(), schemaVersion: 99 })).toThrow(/Unsupported/);
  });

  it("builds native drawing commands with one group per base and product", () => {
    const commands = buildPalletDrawing(generate(), { unit: "in", perMm: 1 / IN, label: "in" });
    const groups = commands.filter(command => command.type === "group-entities");
    expect(groups.map(group => group.name)).toEqual(["P1 · demo · 82 × 39 in", "Long carton", "Long carton"]);
    expect(new Set(groups.map(group => group.groupId)).size).toBe(3);
  });
});

describe("handoff to the existing Truck Load Planner", () => {
  const stop = { id: "stop-1", jobNumber: "demo", city: "Winnipeg", state: "MB", color: "#5499cb" };

  it("passes the confirmed loaded footprint and stable ID through the live truck solver", () => {
    const plan = generate();
    const handled = editPalletPlan(plan, {
      type: "handling", palletId: plan.pallets[0].id, truckOrientation: "fixed", tag: "Use long forks",
    }, "handling");
    const confirmed = editPalletPlan(handled, { type: "confirm" }, "confirmed");
    const orders = toTruckOrders(confirmed, [stop]);
    expect(orders[0].pallets[0]).toMatchObject({
      id: confirmed.pallets[0].id, shape: "rect", qty: 1, orientation: "fixed", tag: "Use long forks",
    });
    const result = nestByOrders({ name: "Demo truck", length: 630 * IN, width: 90 * IN }, orders);
    expect(result.placed[0].instanceId).toBe(confirmed.pallets[0].id);
    expect(result.placed[0].length).toBeCloseTo(2082.8);
    expect(result.placed[0].width).toBeCloseTo(990.6);
    expect(validateNest(result).filter(finding => finding.level === "error")).toEqual([]);
  });

  it("requires confirmation and an unambiguous dispatch mapping", () => {
    const plan = generate();
    expect(() => toTruckOrders(plan, [stop])).toThrow(/Confirm/);
    const confirmed = editPalletPlan(plan, { type: "confirm" }, "confirmed");
    expect(() => toTruckOrders(confirmed, [])).toThrow(/Assign job demo/);
    expect(() => toTruckOrders(confirmed, [stop, { ...stop, id: "stop-2" }])).toThrow(/one mapping per job/);
  });
});
