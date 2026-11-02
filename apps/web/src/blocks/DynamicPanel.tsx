import { useState } from "react";
import {
  ACTION_PARAMS,
  addAction,
  addParam,
  addVisibilityState,
  blockConstraints,
  dimConstraintId,
  defaultParamName,
  emptySpec,
  entitiesToSvgDocument,
  evaluateDynamic,
  kindBounds,
  markDimension,
  moveAction,
  paramFields,
  removeAction,
  removeParam,
  removeVisibilityState,
  resolveParamValues,
  setLookupTable,
  setStateVisibility,
  uniqueParamName,
  validateSpec,
  withParamValue,
  type BlockAction,
  type BlockParam,
  type DynamicSpec,
  type Frame,
  type ParamKind,
  type ParamValues,
  type ValueSet,
} from "@sketchor/core";
import { activeBlockEdit, doc, setBlockEditDynamic, useApp } from "../state/store";

/**
 * B-21: the Authoring palette of the block editor. Every edit is a pure
 * function of `DynamicSpec` (core `blocks/authoring.ts`); geometry for a
 * parameter or frame is taken from the current selection (a line gives
 * base→end, any selection gives a frame around it) or typed in, so no new
 * pick tool is needed. "Test block" shows a sandbox instance with the same
 * controls the Properties panel gives a real one.
 */

const KINDS: ParamKind[] = ["linear", "polar", "xy", "rotation", "flip", "visibility", "lookup"];
const ACTIONS: BlockAction["kind"][] = ["stretch", "move", "polar-stretch", "scale", "rotate", "flip", "array", "lookup"];
const num = (v: string, d = 0): number => (Number.isFinite(parseFloat(v)) ? parseFloat(v) : d);

function parseValueSet(min: string, max: string, step: string, list: string): ValueSet | undefined {
  const l = list.split(/[;,\s]+/).map(Number).filter((n) => Number.isFinite(n) && list.trim() !== "");
  if (l.length > 0) return { list: l };
  const vs: ValueSet = {};
  if (min.trim() !== "") vs.min = num(min);
  if (max.trim() !== "") vs.max = num(max);
  if (step.trim() !== "" && num(step) > 0) vs.increment = num(step);
  return Object.keys(vs).length > 0 ? vs : undefined;
}

export function DynamicPanel({ onClose }: { onClose: () => void }) {
  useApp((st) => st.sessionsVersion);
  useApp((st) => st.revision);
  const selection = useApp((st) => st.selection);
  const be = activeBlockEdit();
  const spec = be?.dynamic;
  const cur: DynamicSpec = spec ?? emptySpec();
  const commit = (next: DynamicSpec) => setBlockEditDynamic(next);

  const [kind, setKind] = useState<ParamKind>("linear");
  const [name, setName] = useState("");
  const [pts, setPts] = useState({ bx: "0", by: "0", ex: "100", ey: "0" });
  const [vmin, setVmin] = useState("");
  const [vmax, setVmax] = useState("");
  const [vstep, setVstep] = useState("");
  const [vlist, setVlist] = useState("");
  const [actKind, setActKind] = useState<BlockAction["kind"]>("stretch");
  const [actParam, setActParam] = useState("");
  const [frame, setFrame] = useState({ x0: "0", y0: "0", x1: "10", y1: "10" });
  const [useSel, setUseSel] = useState(true);
  const [spacing, setSpacing] = useState("10");
  const [stateName, setStateName] = useState("");
  const [tblName, setTblName] = useState("");
  const [tblRows, setTblRows] = useState("");
  const [testOpen, setTestOpen] = useState(false);
  const [testVals, setTestVals] = useState<ParamValues>({});

  const selEntities = selection.map((id) => doc.get(id)).filter((e) => !!e);
  const problems = (
    spec ? validateSpec(spec, new Set(doc.all().map((e) => e.id)), new Set(blockConstraints({ ...be!.original, entities: doc.all(), constraints: doc.constraints() }).map((c) => c.id))) : []
  );
  if (!be) return null;

  const fromSelection = () => {
    const l = selEntities.find((e) => e.type === "line");
    if (l && l.type === "line") setPts({ bx: String(l.a.x), by: String(l.a.y), ex: String(l.b.x), ey: String(l.b.y) });
  };
  const frameFromSelection = () => {
    let b: { minX: number; minY: number; maxX: number; maxY: number } | null = null;
    for (const e of selEntities) {
      const k = kindBounds(e);
      if (k) b = b ? { minX: Math.min(b.minX, k.minX), minY: Math.min(b.minY, k.minY), maxX: Math.max(b.maxX, k.maxX), maxY: Math.max(b.maxY, k.maxY) } : k;
    }
    if (b) setFrame({ x0: String(b.minX), y0: String(b.minY), x1: String(b.maxX), y1: String(b.maxY) });
  };

  const addParamClick = () => {
    const base = { x: num(pts.bx), y: num(pts.by) };
    const end = { x: num(pts.ex, 100), y: num(pts.ey) };
    const nm = name.trim() || uniqueParamName(cur, defaultParamName(kind));
    const values = parseValueSet(vmin, vmax, vstep, vlist);
    let p: BlockParam;
    switch (kind) {
      case "linear":
      case "polar":
        p = { kind, name: nm, base, end, ...(values ? { values } : {}) };
        break;
      case "xy":
        p = { kind, name: nm, base };
        break;
      case "rotation":
        p = { kind, name: nm, center: base, radius: Math.hypot(end.x - base.x, end.y - base.y) || 1, ...(values ? { values } : {}) };
        break;
      case "flip":
        p = { kind, name: nm, base, end };
        break;
      case "visibility":
        p = { kind, name: nm };
        break;
      default:
        p = { kind: "lookup", name: nm, table: tblName.trim() || "table1" };
    }
    commit(addParam(cur, p));
    setName("");
  };

  const addActionClick = () => {
    const param = actParam || cur.params.find((p) => ACTION_PARAMS[actKind].includes(p.kind))?.name || "";
    if (!param) return;
    const entities = useSel && selection.length > 0 ? [...selection] : undefined;
    const fr: Frame = { min: { x: Math.min(num(frame.x0), num(frame.x1)), y: Math.min(num(frame.y0), num(frame.y1)) }, max: { x: Math.max(num(frame.x0), num(frame.x1)), y: Math.max(num(frame.y0), num(frame.y1)) } };
    let a: BlockAction;
    switch (actKind) {
      case "stretch":
      case "polar-stretch":
        a = { kind: actKind, param, frame: fr, ...(entities ? { entities } : {}) };
        break;
      case "array":
        a = { kind: "array", param, spacing: num(spacing, 10), ...(entities ? { entities } : {}) };
        break;
      case "lookup":
        a = { kind: "lookup", param };
        break;
      default:
        a = { kind: actKind, param, ...(entities ? { entities } : {}) } as BlockAction;
    }
    commit(addAction(cur, a));
  };

  const addLookup = () => {
    const nm = tblName.trim();
    if (!nm) return;
    const inputs = new Set<string>();
    const rows = tblRows
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const [label, rest = ""] = line.split(":");
        const values: Record<string, number | string> = {};
        for (const kv of rest.split(",")) {
          const [k, v] = kv.split("=").map((x) => x.trim());
          if (!k || v === undefined) continue;
          inputs.add(k);
          values[k] = Number.isFinite(Number(v)) && v !== "" ? Number(v) : v;
        }
        return { label: label.trim(), values };
      });
    commit(setLookupTable(cur, { name: nm, inputs: [...inputs], rows }));
  };

  const markSelectedDims = () => {
    let s = cur;
    for (const e of selEntities) if (e && e.type === "dimension" && e.driving) {
      const c = blockConstraints({ ...be.original, entities: doc.all(), constraints: doc.constraints() }).find((x) => x.id === dimConstraintId(e.id));
      if (c) s = markDimension(s, doc.constraints(), c.id);
    }
    commit(s);
  };

  const defaultValues = spec ? resolveParamValues({ ...be.original, constraints: doc.constraints() }, spec, undefined) : {};
  const testDef = spec ? { ...be.original, entities: doc.all(), constraints: doc.constraints(), dynamic: spec } : null;
  const testResolved = testDef && spec ? resolveParamValues(testDef, spec, testVals) : {};
  const testBody = testOpen && testDef ? evaluateDynamic(testDef, testVals) : [];
  const testSvg = testBody.length > 0 ? entitiesToSvgDocument([...testBody], { padding: 10 }) : "";

  return (
    <div className="fill-panel" data-testid="dynamic-panel" style={{ minWidth: 340, maxWidth: 400, maxHeight: "80vh", overflow: "auto", right: 8, left: "auto", top: 48 }}>
      <div className="fill-row">
        <strong style={{ flex: 1 }}>Authoring: {be.name}</strong>
        <button className="btn ghost" onClick={onClose}>✕</button>
      </div>
      {problems.map((p) => (
        <div key={p} className="straighten-hint" data-testid="dynamic-problem">⚠ {p}</div>
      ))}

      <div className="straighten-hint">Parameters</div>
      {cur.params.map((p) => (
        <div key={p.name} className="fill-row" data-testid={`dyn-param-${p.name}`}>
          <span style={{ flex: 1 }}>{p.name} <em>({p.kind})</em></span>
          <button className="btn ghost" title="Remove (and its actions)" onClick={() => commit(removeParam(cur, p.name))}>✕</button>
        </div>
      ))}
      <div className="fill-row">
        <select value={kind} data-testid="dyn-kind" onChange={(e) => setKind(e.target.value as ParamKind)}>
          {KINDS.map((k) => <option key={k}>{k}</option>)}
        </select>
        <input type="text" placeholder={defaultParamName(kind)} value={name} data-testid="dyn-name" style={{ width: 90 }} onChange={(e) => setName(e.target.value)} />
        <button className="btn" data-testid="dyn-add-param" onClick={addParamClick}>Add</button>
      </div>
      {kind !== "visibility" && kind !== "lookup" && (
        <>
          <div className="fill-row">
            base <input type="number" value={pts.bx} style={{ width: 55 }} onChange={(e) => setPts({ ...pts, bx: e.target.value })} />
            <input type="number" value={pts.by} style={{ width: 55 }} onChange={(e) => setPts({ ...pts, by: e.target.value })} />
            end <input type="number" value={pts.ex} data-testid="dyn-ex" style={{ width: 55 }} onChange={(e) => setPts({ ...pts, ex: e.target.value })} />
            <input type="number" value={pts.ey} style={{ width: 55 }} onChange={(e) => setPts({ ...pts, ey: e.target.value })} />
            <button className="btn ghost" title="Take base and end from the selected line" onClick={fromSelection}>From line</button>
          </div>
          {(kind === "linear" || kind === "polar" || kind === "rotation") && (
            <div className="fill-row">
              values: min <input type="number" value={vmin} style={{ width: 50 }} onChange={(e) => setVmin(e.target.value)} />
              max <input type="number" value={vmax} style={{ width: 50 }} onChange={(e) => setVmax(e.target.value)} />
              step <input type="number" value={vstep} style={{ width: 45 }} onChange={(e) => setVstep(e.target.value)} />
              <input type="text" placeholder="or list: 700 800 900" value={vlist} style={{ width: 110 }} onChange={(e) => setVlist(e.target.value)} />
            </div>
          )}
        </>
      )}
      <div className="fill-row">
        <button className="btn ghost" title="Make the selected driving dimensions' constraints block parameters" onClick={markSelectedDims}>Selected dimensions → parameters</button>
      </div>

      <div className="straighten-hint">Actions (applied in this order)</div>
      {cur.actions.map((a, i) => (
        <div key={i} className="fill-row" data-testid={`dyn-action-${i}`}>
          <span style={{ flex: 1 }}>{a.kind} · {a.param}</span>
          <button className="btn ghost" onClick={() => commit(moveAction(cur, i, -1))}>↑</button>
          <button className="btn ghost" onClick={() => commit(moveAction(cur, i, 1))}>↓</button>
          <button className="btn ghost" onClick={() => commit(removeAction(cur, i))}>✕</button>
        </div>
      ))}
      <div className="fill-row">
        <select value={actKind} data-testid="dyn-act-kind" onChange={(e) => setActKind(e.target.value as BlockAction["kind"])}>
          {ACTIONS.map((k) => <option key={k}>{k}</option>)}
        </select>
        <select value={actParam} data-testid="dyn-act-param" onChange={(e) => setActParam(e.target.value)}>
          <option value="">(first match)</option>
          {cur.params.filter((p) => ACTION_PARAMS[actKind].includes(p.kind)).map((p) => <option key={p.name}>{p.name}</option>)}
        </select>
        <button className="btn" data-testid="dyn-add-action" onClick={addActionClick}>Attach</button>
      </div>
      <div className="fill-row">
        <label><input type="checkbox" checked={useSel} onChange={(e) => setUseSel(e.target.checked)} /> only selected objects ({selection.length})</label>
        {actKind === "array" && <>spacing <input type="number" value={spacing} style={{ width: 55 }} onChange={(e) => setSpacing(e.target.value)} /></>}
      </div>
      {(actKind === "stretch" || actKind === "polar-stretch") && (
        <div className="fill-row">
          frame
          {(["x0", "y0", "x1", "y1"] as const).map((k) => (
            <input key={k} type="number" value={frame[k]} style={{ width: 50 }} onChange={(e) => setFrame({ ...frame, [k]: e.target.value })} />
          ))}
          <button className="btn ghost" title="Frame around the selection" onClick={frameFromSelection}>From selection</button>
        </div>
      )}

      <div className="straighten-hint">Visibility states</div>
      {(cur.visibilityStates ?? []).map((s) => (
        <div key={s.name} className="fill-row" data-testid={`dyn-state-${s.name}`}>
          <span style={{ flex: 1 }}>{s.name} ({s.visible.length})</span>
          <button className="btn ghost" title="Show the selected objects in this state" onClick={() => commit(setStateVisibility(cur, s.name, selection, true))}>+ sel</button>
          <button className="btn ghost" title="Hide the selected objects in this state" onClick={() => commit(setStateVisibility(cur, s.name, selection, false))}>− sel</button>
          <button className="btn ghost" onClick={() => commit(removeVisibilityState(cur, s.name))}>✕</button>
        </div>
      ))}
      <div className="fill-row">
        <input type="text" placeholder="State name" value={stateName} data-testid="dyn-state-name" style={{ width: 120 }} onChange={(e) => setStateName(e.target.value)} />
        <button className="btn" data-testid="dyn-add-state" onClick={() => { commit(addVisibilityState(cur, stateName, selection)); setStateName(""); }}>Add state</button>
      </div>

      <div className="straighten-hint">Lookup table (rows: <code>label: param=value, …</code>)</div>
      {(cur.lookup ?? []).map((t) => <div key={t.name} className="straighten-hint">{t.name}: {t.rows.map((r) => r.label).join(", ")}</div>)}
      <div className="fill-row">
        <input type="text" placeholder="Table name" value={tblName} style={{ width: 100 }} onChange={(e) => setTblName(e.target.value)} />
        <button className="btn" onClick={addLookup}>Save table</button>
      </div>
      <textarea rows={3} value={tblRows} placeholder={"M3: Dia=3\nM6: Dia=6"} style={{ width: "100%" }} onChange={(e) => setTblRows(e.target.value)} />

      <div className="fill-row">
        <button className="btn" data-testid="dyn-test" disabled={!spec} onClick={() => { setTestOpen((o) => !o); setTestVals({}); }}>{testOpen ? "Close test" : "Test block"}</button>
      </div>
      {testOpen && testDef && spec && (
        <div data-testid="dyn-test-area">
          {paramFields(testDef, { params: testResolved }).map((f) => (
            <div key={f.key} className="fill-row">
              <span style={{ flex: 1 }}>{f.label}</span>
              {f.control === "choice" ? (
                <select value={String(f.value)} onChange={(e) => setTestVals((v) => ({ ...testResolved, ...v, [f.key]: e.target.value }))}>
                  {(f.options ?? []).map((o) => <option key={String(o)}>{String(o)}</option>)}
                </select>
              ) : f.control === "toggle" ? (
                <input type="checkbox" checked={f.value === 1} onChange={(e) => setTestVals((v) => ({ ...testResolved, ...v, [f.key]: e.target.checked ? 1 : 0 }))} />
              ) : (
                <input
                  type="number"
                  step="any"
                  style={{ width: 80 }}
                  value={f.control === "angle" ? Math.round(Number(f.value) * 18000 / Math.PI) / 100 : Number(f.value)}
                  onChange={(e) => {
                    const n = parseFloat(e.target.value);
                    if (Number.isFinite(n)) setTestVals((v) => withParamValue(testDef, { params: { ...testResolved, ...v } } as never, f.key, f.control === "angle" ? (n * Math.PI) / 180 : n).params ?? v);
                  }}
                />
              )}
            </div>
          ))}
          <div className="fill-row">
            <button className="btn ghost" onClick={() => setTestVals({})}>Reset</button>
            <span className="straighten-hint">defaults: {Object.keys(defaultValues).length} values</span>
          </div>
          {testSvg && <div data-testid="dyn-test-svg" style={{ background: "#fff", maxHeight: 180 }} dangerouslySetInnerHTML={{ __html: testSvg }} />}
        </div>
      )}
    </div>
  );
}
