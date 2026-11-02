import type { Point } from "../geometry";
import type { BlockAction, BlockParam, DynamicSpec, ParamValues, ValueSet, VisibilityState } from "./dynamic";
import { dynamicSpecOf, paramKeys } from "./dynamic";

/**
 * B-26: reading AutoCAD dynamic blocks from DXF. AutoCAD stores a dynamic
 * block as a normal definition whose BLOCK_RECORD has an extension dictionary
 * (`ACAD_ENHANCEDBLOCK` -> an evaluation graph) pointing at BLOCK*PARAMETER and
 * BLOCK*ACTION objects, plus an anonymous `*U<n>` block per distinct state
 * that INSERTs reference (the `*U` record or the INSERT carries XDATA naming
 * the base definition and the state's property values). We always keep the
 * `*U` geometry as a static insert (the importer's default expansion), and only
 * when the base block's objects map onto a {@link DynamicSpec} AND the insert
 * names its values do we re-open it as a live dynamic instance. What cannot be
 * mapped (lookup tables, unknown BLOCK* objects, damaged records) is reported
 * as a warning and the geometry stays static. Pure and total: never throws,
 * every walk is bounded.
 *
 * Fields read (the subset of the undocumented records that we rely on; files
 * that differ simply map less): parameter name 305 (else 300), label 301, base
 * point 1010/1020, end point 1011/1021, value set min/max/increment 140/141/142
 * and list entries 144, visibility states 303 (name) each followed by 332 entity
 * handles; actions name their parameter in 301, stretch frame corners 1012/1022,
 * multiplier 140, selection set 331, array spacing 140.
 */

interface Pair {
  code: number;
  value: string;
}
export interface RawRecord {
  type: string;
  pairs: Pair[];
}

const MAX_OBJECTS = 20000;
const norm = (h: string): string => h.trim().toUpperCase();
const first = (r: RawRecord, code: number): string | undefined => r.pairs.find((p) => p.code === code)?.value;
const nums = (r: RawRecord, code: number): number[] => r.pairs.filter((p) => p.code === code).map((p) => parseFloat(p.value)).filter(Number.isFinite);
const numOf = (r: RawRecord, code: number): number | undefined => {
  const v = first(r, code);
  const n = v === undefined ? NaN : parseFloat(v);
  return Number.isFinite(n) ? n : undefined;
};

function pointOf(r: RawRecord, xc: number): Point | undefined {
  const x = numOf(r, xc);
  const y = numOf(r, xc + 10);
  return x === undefined || y === undefined ? undefined : { x, y };
}

function xdictHandle(r: RawRecord): string | undefined {
  const i = r.pairs.findIndex((p) => p.code === 102 && p.value.trim() === "{ACAD_XDICTIONARY");
  return i >= 0 && r.pairs[i + 1]?.code === 360 ? norm(r.pairs[i + 1].value) : undefined;
}

/** The pairs of one XDATA application (from its 1001 to the next 1001). */
function xdataOf(pairs: readonly Pair[], app: string): Pair[] | undefined {
  const i = pairs.findIndex((p) => p.code === 1001 && p.value.trim() === app);
  if (i < 0) return undefined;
  const out: Pair[] = [];
  for (let j = i + 1; j < pairs.length && pairs[j].code !== 1001; j++) out.push(pairs[j]);
  return out;
}

const PARAM_KINDS: Record<string, BlockParam["kind"] | "lookup-unmapped"> = {
  BLOCKLINEARPARAMETER: "linear",
  BLOCKPOLARPARAMETER: "polar",
  BLOCKXYPARAMETER: "xy",
  BLOCKPOINTPARAMETER: "point",
  BLOCKROTATIONPARAMETER: "rotation",
  BLOCKFLIPPARAMETER: "flip",
  BLOCKVISIBILITYPARAMETER: "visibility",
  BLOCKALIGNMENTPARAMETER: "alignment",
  BLOCKBASEPOINTPARAMETER: "basepoint",
  BLOCKLOOKUPPARAMETER: "lookup-unmapped",
};
const ACTION_KINDS: Record<string, BlockAction["kind"] | "lookup-unmapped"> = {
  BLOCKMOVEACTION: "move",
  BLOCKSTRETCHACTION: "stretch",
  BLOCKPOLARSTRETCHACTION: "polar-stretch",
  BLOCKSCALEACTION: "scale",
  BLOCKROTATEACTION: "rotate",
  BLOCKFLIPACTION: "flip",
  BLOCKARRAYACTION: "array",
  BLOCKLOOKUPACTION: "lookup-unmapped",
};

interface Parsed {
  name: string;
  params: BlockParam[];
  actions: (BlockAction & { handles?: string[] })[];
  states: { name: string; handles: string[] }[];
}

function valueSet(r: RawRecord, k: number): ValueSet | undefined {
  const list = nums(r, 144);
  if (list.length > 0) return { list: list.map((v) => v * k) };
  const min = numOf(r, 140);
  const max = numOf(r, 141);
  const inc = numOf(r, 142);
  if (min === undefined && max === undefined && inc === undefined) return undefined;
  return { ...(min !== undefined ? { min: min * k } : {}), ...(max !== undefined ? { max: max * k } : {}), ...(inc !== undefined && inc > 0 ? { increment: inc * k } : {}) };
}

const sc = (p: Point, k: number): Point => ({ x: p.x * k, y: p.y * k });

function parseBlock(name: string, objs: RawRecord[], k: number, warn: (m: string) => void): Parsed | null {
  const params: BlockParam[] = [];
  const actions: Parsed["actions"] = [];
  const states: Parsed["states"] = [];
  const used = new Set<string>();
  const unique = (base: string): string => {
    let n = base;
    for (let i = 2; used.has(n); i++) n = `${base}${i}`;
    used.add(n);
    return n;
  };
  for (const r of objs) {
    const type = r.type.toUpperCase();
    const pk = PARAM_KINDS[type];
    const ak = ACTION_KINDS[type];
    if (pk === "lookup-unmapped" || ak === "lookup-unmapped") {
      warn(`dynamic block '${name}': lookup tables are not imported (${r.type})`);
      continue;
    }
    if (pk) {
      const pname = unique((first(r, 305) ?? first(r, 300) ?? "").trim() || `${pk}${params.length + 1}`);
      const label = first(r, 301)?.trim();
      const base = pointOf(r, 1010);
      const end = pointOf(r, 1011);
      const common = { name: pname, ...(label ? { label } : {}) };
      switch (pk) {
        case "linear":
        case "polar": {
          if (!base || !end) {
            warn(`dynamic block '${name}': ${r.type} without base/end points was skipped`);
            used.delete(pname);
            break;
          }
          const values = valueSet(r, k);
          params.push({ kind: pk, ...common, base: sc(base, k), end: sc(end, k), ...(values ? { values } : {}) });
          break;
        }
        case "flip":
          if (!base || !end) {
            warn(`dynamic block '${name}': ${r.type} without an axis was skipped`);
            used.delete(pname);
            break;
          }
          params.push({ kind: "flip", ...common, base: sc(base, k), end: sc(end, k) });
          break;
        case "xy":
        case "point":
          params.push({ kind: pk, ...common, base: sc(base ?? { x: 0, y: 0 }, k) });
          break;
        case "rotation":
          params.push({ kind: "rotation", ...common, center: sc(base ?? { x: 0, y: 0 }, k) });
          break;
        case "visibility": {
          params.push({ kind: "visibility", ...common });
          let cur: { name: string; handles: string[] } | null = null;
          for (const p of r.pairs) {
            if (p.code === 303) {
              cur = { name: p.value.trim(), handles: [] };
              if (cur.name && !states.some((s) => s.name === cur!.name)) states.push(cur);
            } else if (p.code === 332 && cur) cur.handles.push(norm(p.value));
          }
          break;
        }
        case "alignment":
        case "basepoint":
          params.push({ kind: pk, ...common, ...(base ? { at: sc(base, k) } : {}) });
          break;
        default:
          break;
      }
      continue;
    }
    if (ak) {
      const param = (first(r, 301) ?? "").trim();
      const handles = r.pairs.filter((p) => p.code === 331).map((p) => norm(p.value));
      const mult = numOf(r, 140);
      switch (ak) {
        case "stretch":
        case "polar-stretch": {
          const xs = nums(r, 1012);
          const ys = nums(r, 1022);
          const n = Math.min(xs.length, ys.length);
          if (n < 2) {
            warn(`dynamic block '${name}': ${r.type} without a stretch frame was skipped`);
            break;
          }
          const frame = { min: { x: Math.min(...xs.slice(0, n)) * k, y: Math.min(...ys.slice(0, n)) * k }, max: { x: Math.max(...xs.slice(0, n)) * k, y: Math.max(...ys.slice(0, n)) * k } };
          actions.push(ak === "stretch" ? { kind: "stretch", param, frame, ...(mult !== undefined && mult !== 1 ? { multiplier: mult } : {}), handles } : { kind: "polar-stretch", param, frame, handles });
          break;
        }
        case "move":
          actions.push({ kind: "move", param, ...(mult !== undefined && mult !== 1 ? { multiplier: mult } : {}), handles });
          break;
        case "array": {
          const spacing = numOf(r, 140);
          if (!spacing || spacing <= 0) warn(`dynamic block '${name}': ${r.type} without a spacing was skipped`);
          else actions.push({ kind: "array", param, spacing: spacing * k, handles });
          break;
        }
        case "scale":
        case "rotate":
        case "flip":
          actions.push({ kind: ak, param, handles });
          break;
        default:
          break;
      }
      continue;
    }
    if (type.startsWith("BLOCK")) warn(`dynamic block '${name}': ${r.type} is not mapped`);
  }
  // Only parameters that change geometry make a dynamic block worth keeping live.
  if (!params.some((p) => p.kind !== "alignment" && p.kind !== "basepoint")) return null;
  return { name, params, actions, states };
}

export interface DynamicImportPlan {
  /** Warnings found while mapping the objects (report once). */
  warnings: string[];
  /** Dynamic blocks whose objects map onto a spec. */
  has(block: string): boolean;
  /**
   * What an INSERT of an anonymous `*U` block stands for: the base block and the
   * values it shows, or null (keep the `*U` geometry as a static insert).
   * `warn` is told when a recognised dynamic block stays static.
   */
  represent(starName: string, insertPairs: readonly Pair[], warn: (m: string) => void): { block: string; params: ParamValues } | null;
  /** The specs, with selection-set / visibility handles resolved to the entity ids of the built definitions. */
  specs(handleToId: ReadonlyMap<string, string>): Map<string, DynamicSpec>;
}

/** `tableRecords` = TABLES section records (BLOCK_RECORD used), `objects` = OBJECTS section records; `k` = mm per drawing unit. */
export function planDynamicImport(tableRecords: readonly RawRecord[], objects: readonly RawRecord[], k: number): DynamicImportPlan {
  const warnings: string[] = [];
  const warn = (m: string): void => void warnings.push(m);
  const records = tableRecords.filter((r) => r.type === "BLOCK_RECORD").slice(0, MAX_OBJECTS);
  const nameByHandle = new Map<string, string>();
  const recordByName = new Map<string, RawRecord>();
  for (const r of records) {
    const n = (first(r, 2) ?? "").trim();
    const h = first(r, 5);
    if (!n) continue;
    recordByName.set(n, r);
    if (h) nameByHandle.set(norm(h), n);
  }
  const byHandle = new Map<string, RawRecord>();
  for (const o of objects.slice(0, MAX_OBJECTS)) {
    const h = first(o, 5);
    if (h) byHandle.set(norm(h), o);
  }
  const parsed = new Map<string, Parsed>();
  for (const [name, rec] of recordByName) {
    if (name.startsWith("*")) continue;
    const xd = xdictHandle(rec);
    const dict = xd ? byHandle.get(xd) : undefined;
    if (!dict || dict.type !== "DICTIONARY") continue;
    let graphHandle: string | undefined;
    for (let i = 0; i < dict.pairs.length - 1; i++) {
      if (dict.pairs[i].code === 3 && dict.pairs[i].value.trim().toUpperCase() === "ACAD_ENHANCEDBLOCK" && (dict.pairs[i + 1].code === 360 || dict.pairs[i + 1].code === 350)) {
        graphHandle = norm(dict.pairs[i + 1].value);
        break;
      }
    }
    if (!graphHandle) continue;
    const graph = byHandle.get(graphHandle);
    if (!graph) {
      warn(`dynamic block '${name}': its evaluation graph is missing — kept static`);
      continue;
    }
    const seen = new Set<string>();
    const objs: RawRecord[] = [];
    for (const p of graph.pairs) {
      if (p.code !== 360) continue;
      const h = norm(p.value);
      const o = byHandle.get(h);
      if (o && !seen.has(h)) {
        seen.add(h);
        objs.push(o);
      }
    }
    const p = parseBlock(name, objs, k, warn);
    if (p) parsed.set(name, p);
    else warn(`dynamic block '${name}': no parameter could be mapped — kept static`);
  }

  const baseOf = (starName: string, insertPairs: readonly Pair[]): string | undefined => {
    const fromHandle = (xd: Pair[] | undefined): string | undefined => {
      const h = xd?.find((p) => p.code === 1005)?.value;
      return h ? nameByHandle.get(norm(h)) : undefined;
    };
    const rec = recordByName.get(starName);
    const candidates = [
      xdataOf(insertPairs, "AcDbDynamicBlockTrueName")?.find((p) => p.code === 1000)?.value.trim(),
      fromHandle(xdataOf(insertPairs, "AcDbBlockRepresentation")),
      fromHandle(xdataOf(insertPairs, "AcDbBlockRepBTag")),
      rec ? fromHandle(xdataOf(rec.pairs, "AcDbBlockRepresentation")) : undefined,
      rec ? fromHandle(xdataOf(rec.pairs, "AcDbBlockRepBTag")) : undefined,
    ];
    return candidates.find((c): c is string => !!c && !c.startsWith("*") && recordByName.has(c));
  };

  return {
    warnings,
    has: (b) => parsed.has(b),
    represent(starName, insertPairs, w) {
      const base = baseOf(starName, insertPairs);
      if (!base) return null;
      const p = parsed.get(base);
      if (!p) {
        w(`dynamic block '${base}' was imported as a static block (its parameters are not understood)`);
        return null;
      }
      const props = xdataOf(insertPairs, "AcDbDynamicBlockReferenceProperty");
      const given: ParamValues = {};
      if (props) {
        const items = props.filter((q) => q.code === 1000 || q.code === 1040);
        for (let i = 0; i + 1 < items.length; i += 2) {
          if (items[i].code !== 1000) {
            i--;
            continue;
          }
          const key = items[i].value.trim();
          const v = items[i + 1];
          if (v.code === 1040) {
            const n = parseFloat(v.value);
            if (Number.isFinite(n)) given[key] = n;
          } else given[key] = v.value.trim();
        }
      }
      const out: ParamValues = {};
      for (const prm of p.params) {
        for (const key of paramKeys(prm)) {
          const v = given[key];
          if (v === undefined) continue;
          const scaled = typeof v === "number" && (prm.kind === "linear" || prm.kind === "xy" || prm.kind === "point" || (prm.kind === "polar" && key === prm.name)) ? v * k : v;
          out[key] = scaled;
        }
        if (prm.kind === "visibility" && typeof given[prm.name] === "string") out[prm.name] = given[prm.name];
      }
      if (Object.keys(out).length === 0) {
        w(`an instance of dynamic block '${base}' names no parameter values — its current geometry was kept as a static block`);
        return null;
      }
      return { block: base, params: out };
    },
    specs(handleToId) {
      const res = new Map<string, DynamicSpec>();
      for (const [name, p] of parsed) {
        const ids = (hs: string[] | undefined): string[] | undefined => {
          if (!hs || hs.length === 0) return undefined;
          const m = hs.map((h) => handleToId.get(h)).filter((x): x is string => !!x);
          return m.length > 0 ? m : undefined;
        };
        const names = new Set(p.params.map((q) => q.name));
        const actions: BlockAction[] = [];
        for (const a of p.actions) {
          const { handles, ...rest } = a;
          if (!names.has(rest.param)) {
            warnings.push(`dynamic block '${name}': a ${rest.kind} action names an unknown parameter ('${rest.param}') and was dropped`);
            continue;
          }
          const sel = ids(handles);
          actions.push(sel ? ({ ...rest, entities: sel } as BlockAction) : (rest as BlockAction));
        }
        const states: VisibilityState[] = p.states.map((s) => ({ name: s.name, visible: ids(s.handles) ?? [] }));
        const spec: DynamicSpec = { params: p.params, actions, ...(states.length > 0 ? { visibilityStates: states } : {}) };
        if (p.params.some((q) => q.kind === "visibility") && states.length === 0) warnings.push(`dynamic block '${name}': a visibility parameter has no states`);
        if (dynamicSpecOf({ dynamic: spec } as never)) res.set(name, spec);
      }
      return res;
    },
  };
}
