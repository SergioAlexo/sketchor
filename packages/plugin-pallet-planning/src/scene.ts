import type { DocumentReadModel, Point, PolylineEntity } from "@sketchor/plugin-sdk";
import { customBaseSize } from "./pack";
import {
  EPS, oriented, packingEdge, packingFootprint, placementStacks, type Footprint, type Layer,
  type PalletPlan, type Placement, type PlannedPallet, type ProductRow,
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

type SceneAction = { type: "group" | "group-selection" } | { type: "layer"; layer: Layer };

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
    const stacks = plan.pallets.flatMap(pallet => placementStacks(pallet.placements));
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
  if (!plan.pallets.some(pallet => pallet.placements.length)) return true;
  if (!hasPalletScene(plan, model)) return false;
  const outlines = productOutlines(model);
  const rows = new Map(plan.products.map(row => [row.id, row]));
  try {
    return plan.pallets.every(pallet => {
      const deck = model.entities.find(entity => entity.type === "polyline" && entity.layer === PALLET_PLAN_LAYER
        && entity.name === `Pallet ${pallet.id}`);
      if (deck?.type !== "polyline" || deck.points.length !== 4) return false;
      const { x, y, lengthMm, widthMm } = bounds(deck.points);
      if (Math.abs(lengthMm - pallet.base.lengthMm) > EPS || Math.abs(widthMm - pallet.base.widthMm) > EPS
        || (pallet.sceneOrigin && (Math.abs(x - pallet.sceneOrigin.x) > EPS || Math.abs(y - pallet.sceneOrigin.y) > EPS))) return false;
      return placementStacks(pallet.placements).every(stack => {
        const actual = readStack(outlines.get(stack[0].id)!, stack, pallet, rows, model);
        return stack.every((unit, index) => {
          const real = actual.units[index];
          return real.rotation === unit.rotation
            && Math.abs(real.xMm - x - unit.xMm) <= EPS && Math.abs(real.yMm - y - unit.yMm) <= EPS;
        });
      });
    });
  } catch {
    return false;
  }
}

function readStack(
  outline: PolylineEntity, stack: Placement[], pallet: PlannedPallet,
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

/** Read the latest product locations from the drawing and commit the entire layout together. */
export function planFromPalletScene(
  plan: PalletPlan, model: DocumentReadModel, selection: readonly string[], action: SceneAction, revisionId: string,
): PalletPlan {
  if (!hasPalletScene(plan, model)) throw new Error("Open the matching pallet plan and keep its product outlines in the drawing.");
  const outlines = productOutlines(model);
  const rows = new Map(plan.products.map(row => [row.id, row]));
  const stacks = plan.pallets.flatMap(pallet => placementStacks(pallet.placements)
    .map(stack => readStack(outlines.get(stack[0].id)!, stack, pallet, rows, model)));
  const selected = [...new Set(selection.flatMap(id => stacks.filter(stack => stack.selection.includes(id))))];
  if (action.type === "group-selection" && (!selected.length || selected.some(stack => stack.jobId !== selected[0].jobId))) {
    throw new Error("Select one or more product outlines from the same job.");
  }
  const distance = Math.max(25.4, 2 * plan.rules.gapMm);
  if (action.type === "layer" && !changeTopLayer(stacks, selected, action.layer, rows, plan.rules.gapMm)) return plan;
  const retained = stacks.filter(stack => stack.units.length && (action.type !== "group-selection" || !selected.includes(stack)));
  const groups = action.type === "layer"
    ? plan.pallets.map(pallet => retained.filter(stack => stack.palletId === pallet.id)).filter(group => group.length)
    : clusters(retained, distance);
  if (action.type === "group-selection") groups.push(selected);
  groups.sort((a, b) => Math.min(...a.map(s => s.box.x)) - Math.min(...b.map(s => s.box.x)));
  const pallets = groups.map((group, i) => scenePallet(plan, group, `${plan.id}/scene/${revisionId}/p${i + 1}`));
  return parsePalletPlan({ ...plan, pallets, review: "draft", parentRevisionId: plan.revisionId, revisionId });
}
