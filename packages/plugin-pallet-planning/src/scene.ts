import type { DocumentReadModel, Point, PolylineEntity } from "@sketchor/plugin-sdk";
import { customBaseSize } from "./pack";
import {
  EPS, oriented, packingEdge, packingFootprint, placementStacks, type Footprint, type Layer,
  type LooseStack, type PalletPlan, type Placement, type PlannedPallet, type ProductRow, type UnplacedProduct,
} from "./types";
import { parsePalletPlan } from "./validate";
import { PALLET_PLAN_LAYER } from "./layout";

interface Box extends Footprint {
  x: number;
  y: number;
}

interface SceneStack {
  box: Box;
  units: Placement[];
  jobId: string;
  palletId: string;
  selection: string[];
}

type SceneAction =
  | { type: "group" | "group-selection" | "sync" | "release" }
  | { type: "layer"; layer: Layer }
  | { type: "drop"; sourceId: string; targetId: string };

function productOutlines(model: DocumentReadModel) {
  const outlines = new Map<string, PolylineEntity>();
  for (const entity of model.entities) {
    if (entity.type !== "polyline" || entity.layer !== PALLET_PLAN_LAYER || !entity.name?.startsWith("Product ")) continue;
    if (!entity.id.startsWith("pallet-plan-entity:")) continue;
    const id = entity.name.slice("Product ".length);
    if (outlines.has(id)) throw new Error("The drawing contains duplicate product outlines.");
    outlines.set(id, entity);
  }
  return outlines;
}

export function hasPalletScene(plan: PalletPlan, model: DocumentReadModel): boolean {
  try {
    const outlines = productOutlines(model);
    const stacks = [
      ...plan.pallets.flatMap(pallet => placementStacks(pallet.placements)),
      ...(plan.looseStacks ?? []).map(stack => stack.placements),
    ];
    return Boolean(stacks.length) && stacks.length === outlines.size && stacks.every(([base]) => outlines.has(base.id));
  } catch {
    return false;
  }
}

function bounds(points: readonly Point[]): Box {
  const x = Math.min(...points.map(point => point.x));
  const y = Math.min(...points.map(point => point.y));
  return { x, y, lengthMm: Math.max(...points.map(p => p.x)) - x, widthMm: Math.max(...points.map(p => p.y)) - y };
}

export function palletSceneMatchesPlan(plan: PalletPlan, model: DocumentReadModel): boolean {
  if (!plan.pallets.some(pallet => pallet.placements.length) && !plan.looseStacks?.length) return true;
  if (!hasPalletScene(plan, model)) return false;
  const outlines = productOutlines(model);
  const rows = new Map(plan.products.map(row => [row.id, row]));
  try {
    const sameStack = (stack: Placement[], pallet: Pick<PlannedPallet, "id" | "jobId">, { x, y }: Point) => {
      const actual = readStack(outlines.get(stack[0].id)!, stack, pallet, rows, model);
      return stack.every((unit, index) => {
        const real = actual.units[index];
        return real.rotation === unit.rotation
          && Math.abs(real.xMm - x - unit.xMm) <= EPS && Math.abs(real.yMm - y - unit.yMm) <= EPS;
      });
    };
    return plan.pallets.every(pallet => {
      const deck = deckBounds(model, pallet.id);
      if (!deck) return false;
      const { x, y, lengthMm, widthMm } = deck;
      if (Math.abs(lengthMm - pallet.base.lengthMm) > EPS || Math.abs(widthMm - pallet.base.widthMm) > EPS
        || (pallet.sceneOrigin && (Math.abs(x - pallet.sceneOrigin.x) > EPS || Math.abs(y - pallet.sceneOrigin.y) > EPS))) return false;
      return placementStacks(pallet.placements).every(stack => sameStack(stack, pallet, { x, y }));
    }) && (plan.looseStacks ?? []).every(stack => sameStack(
      stack.placements, { id: "", jobId: rows.get(stack.placements[0].rowId)!.jobId }, stack.origin,
    ));
  } catch {
    return false;
  }
}

function deckBounds(model: DocumentReadModel, id: string): Box | undefined {
  const deck = model.entities.find(entity => entity.type === "polyline" && entity.layer === PALLET_PLAN_LAYER
    && entity.name === `Pallet ${id}` && entity.id.startsWith("pallet-plan-entity:"));
  if (deck?.type === "polyline" && deck.points.length === 4) return bounds(deck.points);
}

function readStack(
  outline: PolylineEntity, stack: Placement[], pallet: Pick<PlannedPallet, "id" | "jobId">,
  rows: ReadonlyMap<string, ProductRow>, model: DocumentReadModel,
): SceneStack {
  const box = bounds(outline.points);
  const first = outline.points[0];
  const second = outline.points[1];
  const uniqueCorners = new Set(outline.points.map(p => (p.x > box.x + EPS ? 1 : 0) + (p.y > box.y + EPS ? 2 : 0)));
  const rectangle = outline.closed && outline.points.length === 4 && uniqueCorners.size === 4
    && !outline.bulges?.some(bulge => Math.abs(bulge) > EPS)
    && outline.points.every(p => (Math.abs(p.x - box.x) <= EPS || Math.abs(p.x - box.x - box.lengthMm) <= EPS)
      && (Math.abs(p.y - box.y) <= EPS || Math.abs(p.y - box.y - box.widthMm) <= EPS));
  if (!rectangle) throw new Error("Keep product outlines rectangular and turn them in 90° steps.");
  const horizontal = Math.abs(second.y - first.y) <= EPS;
  if (!horizontal && Math.abs(second.x - first.x) > EPS) throw new Error("Turn product outlines in 90° steps.");
  const axisX = horizontal ? Math.sign(second.x - first.x) : 0;
  const axisY = horizontal ? 0 : Math.sign(second.y - first.y);
  const [base] = stack;
  const units = stack.map(unit => {
    const row = rows.get(unit.rowId)!;
    const source = oriented(packingFootprint(row), unit.rotation);
    const ux = unit.xMm - base.xMm;
    const uy = unit.yMm - base.yMm;
    const transformed = bounds([
      { x: ux, y: uy }, { x: ux + source.lengthMm, y: uy },
      { x: ux + source.lengthMm, y: uy + source.widthMm }, { x: ux, y: uy + source.widthMm },
    ].map(p => ({ x: first.x + axisX * p.x - axisY * p.y, y: first.y + axisY * p.x + axisX * p.y })));
    const rotation = horizontal ? unit.rotation : unit.rotation === 0 ? 90 : 0;
    if (unit === base && (Math.abs(box.lengthMm - transformed.lengthMm) > EPS
      || Math.abs(box.widthMm - transformed.widthMm) > EPS)) {
      throw new Error(`The outline of ${row.productId} was resized. Keep its original dimensions.`);
    }
    return { ...unit, xMm: transformed.x, yMm: transformed.y, rotation };
  }) satisfies Placement[];
  const group = model.groups.find(group => group.members.includes(outline.id));
  return { box, units, jobId: pallet.jobId, palletId: pallet.id, selection: [outline.id, ...(group?.members ?? [])] };
}

function gap(a: Box, b: Box): number {
  const dx = Math.max(0, a.x - b.x - b.lengthMm, b.x - a.x - a.lengthMm);
  const dy = Math.max(0, a.y - b.y - b.widthMm, b.y - a.y - a.widthMm);
  return Math.hypot(dx, dy);
}

function clusters(stacks: SceneStack[], distance: number): SceneStack[][] {
  const pending = new Set(stacks);
  const groups: SceneStack[][] = [];
  for (const stack of stacks) {
    if (!pending.delete(stack)) continue;
    const group = [stack];
    for (const member of group) {
      for (const other of pending) {
        if (member.jobId !== other.jobId || gap(member.box, other.box) > distance + EPS) continue;
        pending.delete(other);
        group.push(other);
      }
    }
    groups.push(group);
  }
  return groups;
}

function changeTopLayer(
  stacks: SceneStack[], selected: SceneStack[], layer: Layer, rows: ReadonlyMap<string, ProductRow>, clearance: number,
) {
  const source = selected[0];
  if (!source) throw new Error("Select a product on the 2D drawing.");
  if (selected.length > 2) throw new Error("Select one source product and, optionally, one supporting stack.");
  const unit = source.units.at(-1)!;
  if (layer === unit.layer && !selected[1]) return false;
  const size = oriented(packingFootprint(rows.get(unit.rowId)!), unit.rotation);
  const target = layer === 1 ? undefined : (selected[1] ?? stacks.find(stack =>
    stack !== source && stack.jobId === source.jobId && stack.units.at(-1)?.layer === layer - 1
    && gap(source.box, stack.box) <= EPS));
  const support = target?.units.at(-1);
  if (layer > 1 && (!support || target?.jobId !== source.jobId || support.layer !== layer - 1)) {
    throw new Error(`Select a product, then Shift-select a supporting stack whose top is on layer ${layer - 1}.`);
  }
  if (support) {
    const below = oriented(packingFootprint(rows.get(support.rowId)!), support.rotation);
    if (size.lengthMm > below.lengthMm + EPS || size.widthMm > below.widthMm + EPS) {
      throw new Error("The product would overhang the supporting product.");
    }
    target!.units.push({
      ...unit, layer, supportId: support.id,
      xMm: support.xMm + (below.lengthMm - size.lengthMm) / 2,
      yMm: support.yMm + (below.widthMm - size.widthMm) / 2,
    });
  } else if (unit.layer > 1) {
    const x = Math.max(...stacks.filter(stack => stack.palletId === source.palletId)
      .map(stack => stack.box.x + stack.box.lengthMm)) + clearance;
    const y = source.box.y;
    stacks.push({ box: { ...size, x, y }, jobId: source.jobId, selection: [],
      palletId: source.palletId,
      units: [{ ...unit, layer, supportId: undefined, xMm: x, yMm: y }] });
  } else {
    return false;
  }
  source.units.pop();
  return true;
}

function scenePallet(plan: PalletPlan, group: SceneStack[], id: string): PlannedPallet {
  const { rules } = plan;
  const edge = packingEdge(rules);
  const x = Math.min(...group.map(s => s.box.x)) - edge;
  const y = Math.min(...group.map(s => s.box.y)) - edge;
  const extentX = Math.max(...group.map(s => s.box.x + s.box.lengthMm)) - x;
  const extentY = Math.max(...group.map(s => s.box.y + s.box.widthMm)) - y;
  const custom = customBaseSize(extentX, extentY, rules);
  const fits = (base: Footprint) => base.lengthMm <= rules.maxLengthMm + EPS && base.widthMm <= rules.maxWidthMm + EPS;
  const stock = rules.standardBases.filter(base => fits(base)
    && base.lengthMm >= extentX + edge - EPS && base.widthMm >= extentY + edge - EPS)
    .sort((a, b) => a.lengthMm * a.widthMm - b.lengthMm * b.widthMm)[0];
  const base = rules.allowCustom && fits(custom) ? custom : stock;
  if (!base) throw new Error("A 2D group exceeds the allowed pallet size. Split it or check Pallet rules.");
  return {
    id, jobId: group[0].jobId, sceneOrigin: { x, y },
    base, loadedFootprint: base, baseSource: base === stock ? "standard" : "custom", baseName: base === stock ? stock?.name : undefined,
    truckOrientation: "auto",
    placements: group.flatMap(stack => stack.units.map(unit => ({ ...unit, xMm: unit.xMm - x, yMm: unit.yMm - y }))),
  };
}

function stackOnSupport(
  source: SceneStack, target: SceneStack, rows: ReadonlyMap<string, ProductRow>, maxLayers: Layer,
) {
  if (source === target || source.jobId !== target.jobId) throw new Error("Choose two products from the same job.");
  if (source.units.length + target.units.length > maxLayers) {
    throw new Error(`This stack would exceed the ${maxLayers}-layer limit in Pallet rules.`);
  }
  for (const unit of source.units) {
    const below = target.units.at(-1)!;
    const size = oriented(packingFootprint(rows.get(unit.rowId)!), unit.rotation);
    const support = oriented(packingFootprint(rows.get(below.rowId)!), below.rotation);
    if (size.lengthMm > support.lengthMm + EPS || size.widthMm > support.widthMm + EPS) {
      throw new Error("This product would overhang the support. Choose a larger support or turn the product.");
    }
    target.units.push({
      ...unit, layer: (below.layer + 1) as Layer, supportId: below.id,
      xMm: below.xMm + (support.lengthMm - size.lengthMm) / 2,
      yMm: below.yMm + (support.widthMm - size.widthMm) / 2,
    });
  }
  source.units = [];
}

function reconcileManualScene(
  plan: PalletPlan, model: DocumentReadModel, stacks: SceneStack[], selected: SceneStack[],
  selection: readonly string[], action: SceneAction, revisionId: string,
): PalletPlan {
  const edge = packingEdge(plan.rules);
  const pallets: PlannedPallet[] = [];
  const looseStacks: LooseStack[] = [];
  const placed = new Set<string>();
  const looseById = new Map<string, UnplacedProduct>(plan.unplaced.map(unit => [unit.id, unit]));

  // A drop can finish between CAD moves, so read the footprints in the drawing
  // once and retain the membership of decks the operator did not regroup.
  const form = action.type === "group-selection" ? selected : [];
  const forming = new Set(form);
  const released = action.type === "release" ? new Set(selection.flatMap(id => {
    const shape = model.entities.find(entity => entity.id === id && entity.type === "polyline" && entity.name?.startsWith("Pallet "));
    return shape?.name ? [shape.name.slice(7)] : [];
  })) : new Set<string>();
  if (action.type === "release" && !released.size) throw new Error("Select the pallet outline to release its products.");

  const toLoose = (stack: SceneStack) => {
    if (!stack.units.length) return;
    const { x, y } = stack.box;
    const placements = stack.units.map(unit => ({ ...unit, xMm: Math.max(0, unit.xMm - x), yMm: Math.max(0, unit.yMm - y) }));
    looseStacks.push({ origin: { x, y }, placements });
    for (const unit of placements) looseById.set(unit.id, { id: unit.id, rowId: unit.rowId, reason: "manual" });
  };

  for (const pallet of plan.pallets) {
    const members = stacks.filter(stack => stack.units.length && stack.palletId === pallet.id && !forming.has(stack));
    if (released.has(pallet.id)) {
      members.forEach(toLoose);
      continue;
    }
    const deck = deckBounds(model, pallet.id);
    if (!deck) throw new Error("A pallet outline is missing. Restore the outline before editing this plan.");
    const { x, y } = deck;
    const placements = members.flatMap(stack => {
      const { box } = stack;
      const outside = box.x < x + edge - EPS || box.y < y + edge - EPS
        || box.x + box.lengthMm > x + pallet.base.lengthMm - edge + EPS
        || box.y + box.widthMm > y + pallet.base.widthMm - edge + EPS;
      if (outside) {
        toLoose(stack);
        return [];
      }
      return stack.units.map(unit => ({ ...unit, xMm: unit.xMm - x, yMm: unit.yMm - y }));
    });
    if (placements.length || !pallet.placements.length) {
      pallets.push({ ...pallet, placements, sceneOrigin: { x, y }, packedHeightMm: undefined });
    }
  }
  stacks.filter(stack => !stack.palletId && !forming.has(stack)).forEach(toLoose);
  if (form.length) pallets.push(scenePallet(plan, form, `${plan.id}/scene/${revisionId}`));
  for (const pallet of pallets) for (const unit of pallet.placements) placed.add(unit.id);
  const unplaced = [...looseById.values()].filter(unit => !placed.has(unit.id));
  return parsePalletPlan({ ...plan, pallets, unplaced, looseStacks, review: "draft", parentRevisionId: plan.revisionId, revisionId });
}

/** Read the latest product locations from the drawing and commit the entire layout together. */
export function planFromPalletScene(
  plan: PalletPlan, model: DocumentReadModel, selection: readonly string[], action: SceneAction, revisionId: string,
): PalletPlan {
  if (!hasPalletScene(plan, model)) throw new Error("Open the matching pallet plan and keep its product outlines in the drawing.");
  const outlines = productOutlines(model);
  const rows = new Map(plan.products.map(row => [row.id, row]));
  const stacks = plan.pallets.flatMap(pallet => placementStacks(pallet.placements)
    .map(stack => readStack(outlines.get(stack[0].id)!, stack, pallet, rows, model)));
  for (const { placements } of plan.looseStacks ?? []) {
    const bottom = placements[0];
    const jobId = rows.get(bottom.rowId)!.jobId;
    stacks.push(readStack(outlines.get(bottom.id)!, placements, { id: "", jobId }, rows, model));
  }
  const selected = [...new Set(selection.flatMap(id => stacks.filter(stack => stack.selection.includes(id))))];
  if (action.type === "group-selection" && (!selected.length || selected.some(stack => stack.jobId !== selected[0].jobId))) {
    throw new Error("Select one or more product outlines from the same job.");
  }
  const distance = Math.max(25.4, 2 * plan.rules.gapMm);
  if (action.type === "drop") {
    const source = stacks.find(stack => stack.selection.includes(action.sourceId));
    const target = stacks.find(stack => stack.selection.includes(action.targetId));
    if (!source || !target) throw new Error("Select a product and a supporting outline from the current drawing.");
    stackOnSupport(source, target, rows, plan.rules.maxLayers);
  }
  if (action.type === "layer" && !changeTopLayer(stacks, selected, action.layer, rows, plan.rules.gapMm)) return plan;
  if (action.type !== "group" && (plan.looseStacks || action.type !== "layer")) {
    return reconcileManualScene(plan, model, stacks, selected, selection, action, revisionId);
  }
  const retained = stacks.filter(stack => stack.units.length);
  const groups = action.type === "layer"
    ? plan.pallets.map(pallet => retained.filter(stack => stack.palletId === pallet.id)).filter(group => group.length)
    : clusters(retained, distance);
  groups.sort((a, b) => Math.min(...a.map(s => s.box.x)) - Math.min(...b.map(s => s.box.x)));
  const pallets = groups.map((group, i) => scenePallet(plan, group, `${plan.id}/scene/${revisionId}/p${i + 1}`));
  return parsePalletPlan({ ...plan, pallets, review: "draft", parentRevisionId: plan.revisionId, revisionId });
}
