import {
  EPS, MAX_PRODUCTS, MAX_STANDARD_BASES, knownLoadedHeight, layerLimit, oriented, packingFootprint, sharesStack, unitId,
  type Footprint, type Layer, type PalletInput, type PalletPlan, type PalletResult,
  type PalletRules, type Placement, type PlannedPallet, type ProductRow, type UnplacedProduct,
} from "./types";

export function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} is missing or invalid.`);
  return value as Record<string, unknown>;
}

function list(value: unknown, limit: number, label: string): unknown[] {
  if (!Array.isArray(value) || value.length > limit) throw new Error(`${label} must be a list of at most ${limit} entries.`);
  return value;
}

export function labelText(value: unknown, label: string, limit = 120): string {
  if (typeof value !== "string" || !value.trim() || value.trim().length > limit) {
    throw new Error(`${label} must contain 1 to ${limit} characters.`);
  }
  return value.trim();
}

function optionalText(value: unknown, label: string, limit = 120): string | undefined {
  return value === undefined || value === "" ? undefined : labelText(value, label, limit);
}

export function measurement(value: unknown, label: string, allowZero = false): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < (allowZero ? 0 : EPS) || value > 1_000_000) {
    throw new Error(`${label} must be a finite ${allowZero ? "non-negative" : "positive"} number up to 1,000,000.`);
  }
  return value;
}

function boolean(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") throw new Error(`${label} must be true or false.`);
  return value;
}

export function footprint(value: unknown, label: string): Footprint {
  const size = record(value, label);
  return {
    lengthMm: measurement(size.lengthMm, `${label} length`),
    widthMm: measurement(size.widthMm, `${label} width`),
  };
}

function layerNumber(value: unknown, label: string): Layer {
  if (value === 1 || value === 2 || value === 3) return value;
  throw new Error(`${label} must be 1, 2, or 3.`);
}

function productStack(value: unknown, label: string): ProductRow["stack"] {
  if (value === undefined) return undefined;
  const stack = record(value, `${label} stacking`);
  if ((stack.maxLayers !== 2 && stack.maxLayers !== 3)
    || (stack.pattern !== "upright" && stack.pattern !== "alternate")) {
    throw new Error(`${label} needs a valid stacking pattern and a 2- or 3-layer limit.`);
  }
  return {
    maxLayers: stack.maxLayers, pattern: stack.pattern,
    addedHeightMm: stack.addedHeightMm === undefined ? undefined : measurement(stack.addedHeightMm, `${label} added layer height`, true),
  };
}

export function parsePalletInput(value: unknown): PalletInput {
  const input = record(value, "Pallet inputs");
  const profile = record(input.rules, "Pallet rules");
  const rules: PalletRules = {
    maxLengthMm: measurement(profile.maxLengthMm, "Maximum base length"),
    maxWidthMm: measurement(profile.maxWidthMm, "Maximum base width"),
    edgeMm: measurement(profile.edgeMm, "Edge clearance", true),
    gapMm: measurement(profile.gapMm, "Product gap", true),
    incrementMm: measurement(profile.incrementMm, "Custom size increment"),
    allowCustom: boolean(profile.allowCustom, "Allow custom bases"),
    maxLayers: layerNumber(profile.maxLayers ?? 3, "Maximum pallet layers"),
    deckHeightMm: profile.deckHeightMm === undefined ? undefined : measurement(profile.deckHeightMm, "Deck height", true),
    maxLoadedHeightMm: profile.maxLoadedHeightMm === undefined ? undefined : measurement(profile.maxLoadedHeightMm, "Maximum loaded height"),
    standardBases: list(profile.standardBases, MAX_STANDARD_BASES, "Standard bases").map((raw, index) => {
      const name = `Standard base ${index + 1}`;
      const base = record(raw, name);
      return { ...footprint(base, name), name: labelText(base.name, `${name} name`) };
    }),
  };
  if (rules.maxLoadedHeightMm !== undefined
    && (rules.deckHeightMm === undefined || rules.deckHeightMm >= rules.maxLoadedHeightMm)) {
    throw new Error("Enter the deck height below the maximum loaded height.");
  }
  if (rules.edgeMm * 2 >= Math.min(rules.maxLengthMm, rules.maxWidthMm)) {
    throw new Error("Edge clearance leaves no usable space on a pallet.");
  }
  if (!rules.allowCustom && !rules.standardBases.some(base =>
    base.lengthMm <= rules.maxLengthMm + EPS && base.widthMm <= rules.maxWidthMm + EPS
    && Math.min(base.lengthMm, base.widthMm) > 2 * rules.edgeMm,
  )) {
    throw new Error("Add a standard base that fits within the limits, or allow custom bases.");
  }
  const ids = new Set<string>();
  let total = 0;
  const products = list(input.products, MAX_PRODUCTS, "Products").map((raw, index): ProductRow => {
    const label = `Product row ${index + 1}`;
    const row = record(raw, label);
    const id = labelText(row.id, `${label} ID`);
    if (ids.has(id)) throw new Error(`${label} has a duplicate row ID.`);
    ids.add(id);
    const quantity = measurement(row.quantity, `${label} quantity`);
    if (!Number.isInteger(quantity)) throw new Error(`${label} quantity must be a whole number.`);
    total += quantity;
    if (total > MAX_PRODUCTS) throw new Error(`A plan can contain at most ${MAX_PRODUCTS} product units.`);
    const stack = productStack(row.stack, label);
    if (rules.maxLoadedHeightMm !== undefined) {
      if (row.heightMm === undefined) throw new Error(`${label} needs a height when a loaded height limit is set.`);
      if (rules.maxLayers > 1 && stack?.pattern === "alternate" && stack.addedHeightMm === undefined) {
        throw new Error(`${label} needs the measured added height of an upside-down layer for the height limit.`);
      }
    }
    return {
      ...footprint(row, label), id, quantity, stack,
      jobId: labelText(row.jobId, `${label} job`),
      productId: labelText(row.productId, `${label} product`),
      canRotate: boolean(row.canRotate, `${label} rotation`),
      measuredLengthMm: row.measuredLengthMm === undefined ? undefined : measurement(row.measuredLengthMm, `${label} measured length`),
      measuredWidthMm: row.measuredWidthMm === undefined ? undefined : measurement(row.measuredWidthMm, `${label} measured width`),
      heightMm: row.heightMm === undefined ? undefined : measurement(row.heightMm, `${label} height`),
      weightKg: row.weightKg === undefined ? undefined : measurement(row.weightKg, `${label} weight`),
      notes: optionalText(row.notes, `${label} notes`, 300),
      sourceUnit: optionalText(row.sourceUnit, `${label} source unit`, 16),
      sourceRowId: optionalText(row.sourceRowId, `${label} source row ID`),
    };
  });
  if (products.length === 0) throw new Error("Add at least one product row.");
  return { products, rules };
}

export function parsePlacement(raw: unknown): Placement {
  const placement = record(raw, "Product placement");
  if (placement.rotation !== 0 && placement.rotation !== 90) throw new Error("Product rotation must be 0° or 90°.");
  return {
    id: labelText(placement.id, "Product unit ID", 256),
    rowId: labelText(placement.rowId, "Product row ID"),
    xMm: measurement(placement.xMm, "Product X", true),
    yMm: measurement(placement.yMm, "Product Y", true),
    rotation: placement.rotation,
    layer: layerNumber(placement.layer ?? 1, "Placement layer"),
  };
}

export function truckOrientation(value: unknown): PlannedPallet["truckOrientation"] {
  if (value === "auto" || value === "fixed" || value === "turned") return value;
  throw new Error("Choose a valid truck orientation.");
}

function parsePallet(raw: unknown): PlannedPallet {
  const pallet = record(raw, "Pallet");
  if (pallet.baseSource !== "standard" && pallet.baseSource !== "custom" && pallet.baseSource !== "manual") {
    throw new Error("Pallet base source is invalid.");
  }
  return {
    id: labelText(pallet.id, "Pallet ID", 256),
    jobId: labelText(pallet.jobId, "Pallet job"),
    base: footprint(pallet.base, "Pallet base"),
    loadedFootprint: footprint(pallet.loadedFootprint, "Loaded footprint"),
    baseSource: pallet.baseSource,
    baseName: optionalText(pallet.baseName, "Pallet base name"),
    truckOrientation: truckOrientation(pallet.truckOrientation),
    tag: optionalText(pallet.tag, "Handling tag"),
    packedHeightMm: pallet.packedHeightMm === undefined
      ? undefined : measurement(pallet.packedHeightMm, "Packed pallet height"),
    grossWeightKg: pallet.grossWeightKg === undefined
      ? undefined : measurement(pallet.grossWeightKg, "Pallet gross weight"),
    placements: list(pallet.placements, MAX_PRODUCTS, "Pallet placements").map(parsePlacement),
  };
}

function parseUnplaced(raw: unknown): UnplacedProduct {
  const item = record(raw, "Unplaced product");
  if (item.reason !== "size" && item.reason !== "height" && item.reason !== "manual") throw new Error("Unplaced product reason is invalid.");
  return {
    id: labelText(item.id, "Unplaced product ID", 256),
    rowId: labelText(item.rowId, "Unplaced product row ID"),
    reason: item.reason,
  };
}

function validatePalletGeometry(pallet: PlannedPallet, rules: PalletRules, rows: ReadonlyMap<string, ProductRow>, name: string) {
  const { base, loadedFootprint, placements } = pallet;
  if (base.lengthMm > rules.maxLengthMm + EPS || base.widthMm > rules.maxWidthMm + EPS) {
    throw new Error(`${name} exceeds the configured base limits.`);
  }
  if (Math.abs(base.lengthMm - loadedFootprint.lengthMm) > EPS || Math.abs(base.widthMm - loadedFootprint.widthMm) > EPS) {
    throw new Error(`${name} must have its loaded footprint within and equal to the base in this plan version.`);
  }
  const boxes = placements.map(p => {
    const row = rows.get(p.rowId);
    if (!row || row.jobId !== pallet.jobId) throw new Error(`${name} contains a product from a different job.`);
    if (p.rotation === 90 && !row.canRotate) throw new Error(`${row.productId} cannot be turned.`);
    if (p.layer > layerLimit(row, rules)) throw new Error(`${row.productId} exceeds the configured layer or loaded height limit.`);
    if (p.layer > 1 && !placements.some(other => other.layer === p.layer - 1 && sharesStack(p, other))) {
      throw new Error(`${row.productId} on layer ${p.layer} needs a matching product directly below it.`);
    }
    const size = oriented(packingFootprint(row), p.rotation);
    const xEnd = p.xMm + size.lengthMm;
    const yEnd = p.yMm + size.widthMm;
    if (p.xMm < rules.edgeMm - EPS || p.yMm < rules.edgeMm - EPS
      || xEnd > base.lengthMm - rules.edgeMm + EPS || yEnd > base.widthMm - rules.edgeMm + EPS) {
      throw new Error(`${row.productId} in ${name} is outside the allowed edge clearance.`);
    }
    return { x: p.xMm, y: p.yMm, xEnd, yEnd, label: row.productId, layer: p.layer };
  });
  for (const [index, a] of boxes.entries()) {
    for (let j = index + 1; j < boxes.length; j += 1) {
      const b = boxes[j];
      if (a.layer !== b.layer) continue;
      const gap = rules.gapMm - EPS;
      const separated = a.xEnd + gap <= b.x || b.xEnd + gap <= a.x || a.yEnd + gap <= b.y || b.yEnd + gap <= a.y;
      if (!separated) throw new Error(`${a.label} and ${b.label} on ${name} overlap or need more gap.`);
    }
  }
}

function parseResult(plan: Record<string, unknown>, { products, rules }: PalletInput): PalletResult {
  const rows = new Map(products.map(row => [row.id, row]));
  const allUnits = new Map(products.flatMap(row =>
    Array.from({ length: row.quantity }, (_, i) => [unitId(row.id, i), row.id] as const),
  ));
  const takeUnit = (unit: Pick<Placement, "id" | "rowId">) => {
    if (allUnits.get(unit.id) !== unit.rowId) throw new Error("A product unit is unknown, assigned twice, or linked to the wrong row.");
    allUnits.delete(unit.id);
  };
  const pallets = list(plan.pallets, MAX_PRODUCTS, "Pallets").map(parsePallet);
  const unplaced = list(plan.unplaced, MAX_PRODUCTS, "Unplaced products").map(parseUnplaced);
  const palletIds = new Set<string>();
  const jobIds = new Set(products.map(row => row.jobId));
  for (const [index, pallet] of pallets.entries()) {
    if (palletIds.has(pallet.id)) throw new Error("A pallet ID is duplicated.");
    if (!jobIds.has(pallet.jobId)) throw new Error("A pallet is linked to an unknown job.");
    palletIds.add(pallet.id);
    for (const placement of pallet.placements) takeUnit(placement);
    validatePalletGeometry(pallet, rules, rows, `pallet ${index + 1}`);
    pallet.packedHeightMm = knownLoadedHeight(pallet, rows, rules) ?? pallet.packedHeightMm;
  }
  for (const item of unplaced) takeUnit(item);
  if (allUnits.size) throw new Error("The plan is missing product units.");
  return { pallets, unplaced };
}

export function parsePalletPlan(raw: unknown): PalletPlan {
  const plan = record(raw, "Pallet plan");
  if (plan.schemaVersion !== 1 && plan.schemaVersion !== 2) throw new Error("Unsupported pallet plan version.");
  if (plan.review !== "draft" && plan.review !== "confirmed") throw new Error("Pallet plan review state is invalid.");
  const input = parsePalletInput(plan);
  const { pallets, unplaced } = parseResult(plan, input);
  if (plan.review === "confirmed" && (unplaced.length || pallets.some(p => !p.placements.length))) {
    throw new Error("Place every product and remove empty pallets before confirming.");
  }
  const generated = plan.generation === undefined ? undefined : record(plan.generation, "Generated layout");
  return {
    schemaVersion: 2, ...input, pallets, unplaced, review: plan.review,
    id: labelText(plan.id, "Plan ID"),
    revisionId: labelText(plan.revisionId, "Revision ID"),
    parentRevisionId: plan.parentRevisionId === null ? null : labelText(plan.parentRevisionId, "Parent revision ID"),
    generation: generated && {
      ...parseResult(generated, input),
      solver: labelText(generated.solver, "Solver"),
      revisionId: labelText(generated.revisionId, "Generated revision ID"),
    },
  };
}
