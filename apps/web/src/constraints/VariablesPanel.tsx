import { useMemo, useState } from "react";
import type { DimensionEntity } from "@sketchor/core";
import { evaluateValue, paramEnv, PARAMS_TABLE, resolveParams, validateParam } from "@sketchor/core";
import { bus, doc, useApp } from "../state/store";

/**
 * The Variables panel (T-45): named parameters (`width = 100`, `half = width/2`)
 * that driving dimensions can reference. Values are mm / radians; a unit
 * suffix (`2in`, `30deg`) converts. Every edit is a `put-param` /
 * `delete-param` command, so changing a variable re-drives the sketch in one
 * undo step. The selected dimension gets an expression field below.
 */
function ParamRow({ name, expression, comment }: { name: string; expression: string; comment?: string }) {
  const [text, setText] = useState(expression);
  const [error, setError] = useState<string | null>(null);
  const resolved = resolveParams(doc.records(PARAMS_TABLE)).get(name);
  const commit = () => {
    if (text === expression) return;
    const err = validateParam(doc.records(PARAMS_TABLE), name, text);
    setError(err);
    if (!err) bus.execute({ type: "put-param", name, expression: text, ...(comment ? { comment } : {}) });
  };
  return (
    <div className="variable-row" data-testid={`variable-${name}`}>
      <span className="variable-name">{name}</span>
      <input
        className="propspanel-input"
        value={text}
        onChange={(e) => setText(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => e.key === "Enter" && commit()}
        title={error ?? resolved?.error ?? comment ?? ""}
        aria-invalid={!!(error ?? resolved?.error)}
      />
      <span className="variable-value">{resolved?.value !== undefined ? String(Math.round(resolved.value * 1e6) / 1e6) : "!"}</span>
      <button className="btn ghost sm" title="Delete variable" onClick={() => bus.execute({ type: "delete-param", name })}>
        ✕
      </button>
    </div>
  );
}

function DimensionExpression({ dim }: { dim: DimensionEntity }) {
  const [text, setText] = useState(dim.expression ?? "");
  const [error, setError] = useState<string | null>(null);
  const angular = dim.kind === "angular2l" || dim.kind === "angular3p";
  const commit = () => {
    if (text === (dim.expression ?? "")) return;
    if (text.trim() === "") {
      const { expression: _drop, ...rest } = dim;
      void _drop;
      bus.execute({ type: "update-entity", entity: rest });
      return;
    }
    const r = evaluateValue(text, paramEnv(doc.records(PARAMS_TABLE)), angular ? "angle" : "length");
    if (!r.ok) return setError(r.error);
    setError(null);
    bus.execute({ type: "update-entity", entity: { ...dim, expression: text, value: r.value } });
  };
  return (
    <div className="variable-row" data-testid="dim-expression">
      <span className="variable-name">value =</span>
      <input
        className="propspanel-input"
        placeholder={angular ? "e.g. 90 or ang" : "e.g. width / 2 + 5"}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => e.key === "Enter" && commit()}
        title={error ?? ""}
        aria-invalid={!!error}
      />
      {error && <span className="variable-value">{error}</span>}
    </div>
  );
}

export function VariablesPanel({ onClose }: { onClose: () => void }) {
  const revision = useApp((s) => s.revision);
  const selection = useApp((s) => s.selection);
  const [name, setName] = useState("");
  const [expr, setExpr] = useState("");
  const [error, setError] = useState<string | null>(null);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const records = useMemo(() => doc.records(PARAMS_TABLE), [revision]);
  const dim = useMemo(() => {
    const e = selection.length === 1 ? doc.get(selection[0]!) : undefined;
    return e?.type === "dimension" ? e : null;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selection, revision]);

  const add = () => {
    const err = validateParam(records, name, expr);
    setError(err);
    if (err) return;
    bus.execute({ type: "put-param", name, expression: expr });
    setName("");
    setExpr("");
  };

  return (
    <aside className="propspanel" data-testid="variables-panel">
      <div className="layerpanel-header">
        <span>Variables</span>
        <button className="btn ghost sm" onClick={onClose} title="Close">
          ✕
        </button>
      </div>
      <div className="constraint-listhead">
        <span>{records.length} defined — mm and radians; units: mm cm m in ft deg rad</span>
      </div>
      {records.map((r) => (
        <ParamRow key={`${r.name}:${String(r.expression)}`} name={r.name} expression={String(r.expression ?? "")} comment={typeof r.comment === "string" ? r.comment : undefined} />
      ))}
      <div className="variable-row">
        <input className="propspanel-input" placeholder="name" value={name} onChange={(e) => setName(e.target.value)} data-testid="variable-new-name" />
        <input
          className="propspanel-input"
          placeholder="expression"
          value={expr}
          onChange={(e) => setExpr(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && add()}
          data-testid="variable-new-expr"
        />
        <button className="btn sm" onClick={add} data-testid="variable-add">
          Add
        </button>
      </div>
      {error && <div className="constraint-listhead">{error}</div>}
      {dim && (
        <>
          <div className="constraint-listhead">
            <span>Selected dimension</span>
          </div>
          <DimensionExpression key={`${dim.id}:${dim.expression ?? ""}`} dim={dim} />
        </>
      )}
    </aside>
  );
}
