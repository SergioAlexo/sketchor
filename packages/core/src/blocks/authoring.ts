import type { Constraint } from "../constraints";
import type { EntityId } from "../entities";
import type { BlockAction, BlockParam, DynamicSpec, LookupTable, ParamKind } from "./dynamic";
import { paramKeys } from "./dynamic";

/**
 * B-21: the pure edits behind the block editor's Authoring palette. Each
 * returns a new spec (the old one is never mutated) or the same object when
 * the edit is refused; `validateSpec` reports what would make the spec
 * misbehave so the palette can warn before Save. The editor keeps the spec
 * on its session and mirrors it live, like attribute definitions.
 */

export const emptySpec = (): DynamicSpec => ({ params: [], actions: [] });

/** The spec to store on a definition: undefined when there is nothing dynamic left (the block is static again). */
export function specForSave(spec: DynamicSpec | undefined): DynamicSpec | undefined {
  return spec && spec.params.length > 0 ? spec : undefined;
}

/** A param name not yet taken, built from `base` ("Distance1", "Distance2", …). */
export function uniqueParamName(spec: DynamicSpec | undefined, base: string): string {
  const taken = new Set((spec?.params ?? []).flatMap((p) => [p.name, ...paramKeys(p)]));
  let n = 1;
  while (taken.has(`${base}${n}`)) n++;
  return `${base}${n}`;
}

const DEFAULT_NAMES: Record<ParamKind, string> = {
  linear: "Distance",
  polar: "Polar",
  xy: "XY",
  point: "Point",
  rotation: "Angle",
  flip: "Flip",
  visibility: "Visibility",
  lookup: "Lookup",
  dimension: "Dim",
  alignment: "Alignment",
  basepoint: "Basepoint",
};
export const defaultParamName = (kind: ParamKind): string => DEFAULT_NAMES[kind];

/** Adds a param; refused (same spec) for an empty, dotted or already used name, or a second visibility param. */
export function addParam(spec: DynamicSpec | undefined, param: BlockParam): DynamicSpec {
  const cur = spec ?? emptySpec();
  const name = param.name.trim();
  if (name === "" || name.includes(".") || name.includes(";")) return cur;
  if (cur.params.some((p) => p.name === name || paramKeys(p).includes(name))) return cur;
  if (param.kind === "visibility" && cur.params.some((p) => p.kind === "visibility")) return cur;
  return { ...cur, params: [...cur.params, { ...param, name }] };
}

/** Removes a param and every action that uses it. */
export function removeParam(spec: DynamicSpec, name: string): DynamicSpec {
  return { ...spec, params: spec.params.filter((p) => p.name !== name), actions: spec.actions.filter((a) => a.param !== name) };
}

/** Replaces the param called `name` (keeps its position; the new record's name wins and renames the actions that used it). */
export function updateParam(spec: DynamicSpec, name: string, param: BlockParam): DynamicSpec {
  const i = spec.params.findIndex((p) => p.name === name);
  if (i < 0) return spec;
  const next = param.name.trim();
  if (next !== name && (next === "" || spec.params.some((p) => p.name === next))) return spec;
  return {
    ...spec,
    params: spec.params.map((p, j) => (j === i ? { ...param, name: next } : p)),
    actions: next === name ? spec.actions : spec.actions.map((a) => (a.param === name ? ({ ...a, param: next } as BlockAction) : a)),
  };
}

/** Which param kinds each action can be attached to. */
export const ACTION_PARAMS: Record<BlockAction["kind"], ParamKind[]> = {
  move: ["linear", "polar", "xy", "point"],
  stretch: ["linear", "polar", "xy", "point"],
  "polar-stretch": ["polar"],
  scale: ["linear", "polar"],
  rotate: ["rotation", "polar"],
  flip: ["flip"],
  array: ["linear"],
  lookup: ["lookup"],
};

export function addAction(spec: DynamicSpec, action: BlockAction): DynamicSpec {
  const p = spec.params.find((x) => x.name === action.param);
  if (!p || !ACTION_PARAMS[action.kind].includes(p.kind)) return spec;
  return { ...spec, actions: [...spec.actions, action] };
}

export function removeAction(spec: DynamicSpec, index: number): DynamicSpec {
  return index < 0 || index >= spec.actions.length ? spec : { ...spec, actions: spec.actions.filter((_, i) => i !== index) };
}

/** Moves an action earlier/later: actions apply in list order. */
export function moveAction(spec: DynamicSpec, index: number, by: -1 | 1): DynamicSpec {
  const j = index + by;
  if (index < 0 || index >= spec.actions.length || j < 0 || j >= spec.actions.length) return spec;
  const actions = [...spec.actions];
  [actions[index], actions[j]] = [actions[j], actions[index]];
  return { ...spec, actions };
}

// --- visibility states ----------------------------------------------------

/** Adds a state (empty name or duplicate refused). The first state added is the default. */
export function addVisibilityState(spec: DynamicSpec, name: string, visible: EntityId[] = []): DynamicSpec {
  const n = name.trim();
  if (n === "" || (spec.visibilityStates ?? []).some((s) => s.name === n)) return spec;
  return { ...spec, visibilityStates: [...(spec.visibilityStates ?? []), { name: n, visible: [...visible] }] };
}

export function removeVisibilityState(spec: DynamicSpec, name: string): DynamicSpec {
  const states = (spec.visibilityStates ?? []).filter((s) => s.name !== name);
  const { visibilityStates: _v, ...rest } = spec;
  void _v;
  return states.length > 0 ? { ...rest, visibilityStates: states } : rest;
}

/** Shows/hides `ids` in one state. */
export function setStateVisibility(spec: DynamicSpec, state: string, ids: readonly EntityId[], visible: boolean): DynamicSpec {
  return {
    ...spec,
    visibilityStates: (spec.visibilityStates ?? []).map((s) => {
      if (s.name !== state) return s;
      const set = new Set(s.visible);
      for (const id of ids) {
        if (visible) set.add(id);
        else set.delete(id);
      }
      return { ...s, visible: [...set] };
    }),
  };
}

// --- lookup tables -----------------------------------------------------------

export function setLookupTable(spec: DynamicSpec, table: LookupTable): DynamicSpec {
  const others = (spec.lookup ?? []).filter((t) => t.name !== table.name);
  return { ...spec, lookup: [...others, table] };
}

export function removeLookupTable(spec: DynamicSpec, name: string): DynamicSpec {
  const rest = (spec.lookup ?? []).filter((t) => t.name !== name);
  const { lookup: _l, ...r } = spec;
  void _l;
  return rest.length > 0 ? { ...r, lookup: rest } : r;
}

// --- parametric route --------------------------------------------------------

/** "Mark as block parameter": a dimension param on a distance/radius/angle constraint. Refused for other constraints or one already marked. */
export function markDimension(spec: DynamicSpec | undefined, constraints: readonly Constraint[], constraintId: string, name?: string): DynamicSpec {
  const cur = spec ?? emptySpec();
  const c = constraints.find((x) => x.id === constraintId);
  if (!c || !(c.type === "distance" || c.type === "radius" || c.type === "angle")) return cur;
  if (cur.params.some((p) => p.kind === "dimension" && p.constraintId === constraintId)) return cur;
  return addParam(cur, { kind: "dimension", name: name ?? uniqueParamName(cur, c.type === "radius" ? "Radius" : c.type === "angle" ? "Angle" : "Length"), constraintId });
}

// --- validation ------------------------------------------------------------

/** Problems that make a spec misbehave; empty = fine. `entityIds`/`constraintIds` are the editor's current ones. */
export function validateSpec(spec: DynamicSpec, entityIds: ReadonlySet<EntityId>, constraintIds: ReadonlySet<string>): string[] {
  const out: string[] = [];
  const byName = new Map(spec.params.map((p) => [p.name, p] as const));
  const states = new Set((spec.visibilityStates ?? []).map((s) => s.name));
  const tables = new Set((spec.lookup ?? []).map((t) => t.name));
  spec.actions.forEach((a, i) => {
    const p = byName.get(a.param);
    if (!p) out.push(`Action ${i + 1} (${a.kind}) uses the missing parameter "${a.param}"`);
    else if (!ACTION_PARAMS[a.kind].includes(p.kind)) out.push(`Action ${i + 1}: ${a.kind} cannot use a ${p.kind} parameter`);
    if (a.kind !== "lookup" && a.entities) {
      const gone = a.entities.filter((id) => !entityIds.has(id));
      if (gone.length > 0) out.push(`Action ${i + 1} refers to ${gone.length} deleted object(s)`);
    }
    if (a.kind === "array" && !(a.spacing > 0)) out.push(`Action ${i + 1}: array spacing must be positive`);
  });
  for (const p of spec.params) {
    if (p.kind === "visibility" && states.size === 0) out.push(`"${p.name}" has no visibility states`);
    if (p.kind === "lookup" && !tables.has(p.table)) out.push(`"${p.name}" names the missing lookup table "${p.table}"`);
    if (p.kind === "lookup" && !spec.actions.some((a) => a.kind === "lookup" && a.param === p.name)) out.push(`"${p.name}" has no lookup action, so choosing a row changes nothing`);
    if (p.kind === "dimension" && !constraintIds.has(p.constraintId)) out.push(`"${p.name}" refers to a deleted constraint`);
  }
  for (const s of spec.visibilityStates ?? []) {
    const gone = s.visible.filter((id) => !entityIds.has(id));
    if (gone.length > 0) out.push(`State "${s.name}" lists ${gone.length} deleted object(s)`);
  }
  return out;
}
