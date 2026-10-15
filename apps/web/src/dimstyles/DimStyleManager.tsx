import { useMemo, useState } from "react";
import {
  DEFAULT_DIM_STYLE,
  DIM_STYLE_FIELDS,
  DIM_STYLE_PRESETS,
  DIM_STYLE_TABS,
  diffDimStyles,
  dimStyleOf,
  layoutDimension,
  newStyleCommand,
  presetCommand,
  styleUsage,
  withoutChildField,
  withStyleField,
  type DimensionEntity,
  type DimFamily,
  type DimStyleField,
  type DimStyleTab,
  type StyleScope,
  type TableRecord,
} from "@sketchor/core";
import { bus, doc, useApp } from "../state/store";
import { useDimStyleUi } from "./dimStyleUi";

/**
 * The dimension style manager (D-03): the styles in the drawing, a live
 * preview of all nine dimension kinds drawn with the selected one, the form
 * grouped like AutoCAD's dialog, child styles per family, and a compare table.
 * Every edit is one `put-table-record`, i.e. one undo step that restyles every
 * dimension using the style.
 */

const FAMILIES: { id: StyleScope; label: string }[] = [
  { id: "parent", label: "Parent (all)" },
  { id: "angular", label: "Angular" },
  { id: "radial", label: "Radius / jogged" },
  { id: "diametric", label: "Diameter" },
  { id: "ordinate", label: "Ordinate" },
];

const dim = (kind: DimensionEntity["kind"], pts: [number, number][], extra: Partial<DimensionEntity> = {}): DimensionEntity => ({
  id: kind,
  type: "dimension",
  kind,
  defPoints: pts.map(([x, y]) => ({ x, y })),
  driving: false,
  ...extra,
});

/** One sample of every kind, laid out on a grid so a style change shows everywhere at once. */
const SAMPLES: DimensionEntity[] = [
  dim("linear", [[0, 0], [40, 0], [20, 9]], { angle: 0 }),
  dim("aligned", [[0, 30], [30, 45], [10, 50]]),
  dim("linear", [[55, 0], [55, 30], [70, 15]], { angle: Math.PI / 2 }),
  dim("angular3p", [[90, 0], [125, 0], [105, 30], [112, 18]]),
  dim("radial", [[20, 80], [32, 86]]),
  dim("diametric", [[70, 80], [82, 88]]),
  dim("arclength", [[110, 70], [124, 70], [110, 84], [118, 80]]),
  dim("ordinate", [[0, 60], [50, 66], [50, 76]], { axis: "x" }),
];

function Preview({ style }: { style: ReturnType<typeof dimStyleOf> }) {
  const parts = useMemo(() => {
    const out: { key: string; d: string; fill: boolean }[] = [];
    const texts: { key: string; x: number; y: number; rot: number; h: number; s: string }[] = [];
    // Circles / arcs the radial kinds measure.
    const circles: { cx: number; cy: number; r: number }[] = [{ cx: 20, cy: 80, r: 12 }, { cx: 70, cy: 80, r: 12 }];
    SAMPLES.forEach((e, i) => {
      const geo = e.kind === "radial" ? { pts: e.defPoints, circle: { center: e.defPoints[0], radius: 12 } } : e.kind === "diametric" ? { pts: e.defPoints, circle: { center: e.defPoints[0], radius: 12 } } : { pts: e.defPoints };
      const l = layoutDimension(e, dimStyleOf(style, undefined, e.kind), geo);
      l.lines.forEach((p, j) => out.push({ key: `l${i}.${j}`, d: "M" + p.map((q) => `${q.x} ${q.y}`).join("L"), fill: false }));
      l.fills.forEach((p, j) => out.push({ key: `f${i}.${j}`, d: "M" + p.map((q) => `${q.x} ${q.y}`).join("L") + "Z", fill: true }));
      if (l.text) texts.push({ key: `t${i}`, x: l.text.at.x, y: l.text.at.y, rot: l.text.rotation, h: l.text.height, s: l.text.text });
    });
    return { out, texts, circles };
  }, [style]);
  return (
    <svg viewBox="-12 -12 160 112" className="dimstyle-preview" data-testid="dimstyle-preview">
      <g transform="translate(0 88) scale(1 -1)" fill="none" stroke="currentColor" strokeWidth="0.25">
        {parts.circles.map((c, i) => (
          <circle key={i} cx={c.cx} cy={c.cy} r={c.r} />
        ))}
        <path d="M122 70 A12 12 0 0 1 110 82" />
        {parts.out.map((p) => (
          <path key={p.key} d={p.d} fill={p.fill ? "currentColor" : "none"} />
        ))}
      </g>
      <g transform="translate(0 88) scale(1 -1)" fill="currentColor" stroke="none">
        {parts.texts.map((t) => (
          <text key={t.key} transform={`translate(${t.x} ${t.y}) scale(1 -1) rotate(${(-t.rot * 180) / Math.PI})`} fontSize={t.h} textAnchor="middle" dominantBaseline="central">
            {t.s}
          </text>
        ))}
      </g>
    </svg>
  );
}

function FieldInput({ f, value, onChange }: { f: DimStyleField; value: unknown; onChange: (v: unknown) => void }) {
  const id = `dimstyle-${f.key}`;
  if (f.type === "boolean")
    return <input id={id} data-testid={id} type="checkbox" checked={!!value} onChange={(e) => onChange(e.target.checked)} />;
  if (f.type === "enum")
    return (
      <select id={id} data-testid={id} value={String(value ?? "")} onChange={(e) => onChange(e.target.value)}>
        {f.options.map((o) => (
          <option key={o} value={o}>
            {o === "" ? "(same)" : o}
          </option>
        ))}
      </select>
    );
  if (f.type === "number")
    return (
      <input
        id={id}
        data-testid={id}
        type="number"
        min={f.min}
        max={f.max}
        step={f.step ?? "any"}
        defaultValue={Number(value)}
        key={String(value)}
        onBlur={(e) => {
          const n = Number(e.target.value);
          if (Number.isFinite(n) && n !== value) onChange(n);
        }}
        onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
      />
    );
  return (
    <input
      id={id}
      data-testid={id}
      type="text"
      defaultValue={String(value ?? "")}
      key={String(value)}
      onBlur={(e) => e.target.value !== value && onChange(e.target.value)}
      onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
    />
  );
}

export function DimStyleManager() {
  const open = useDimStyleUi((s) => s.open);
  const setOpen = useDimStyleUi((s) => s.setOpen);
  const revision = useApp((s) => s.revision);
  const [selected, setSelected] = useState<string>("");
  const [tab, setTab] = useState<DimStyleTab>("Lines");
  const [scope, setScope] = useState<StyleScope>("parent");
  const [newName, setNewName] = useState("");
  const [compareWith, setCompareWith] = useState("");
  const [note, setNote] = useState("");

  const records = useMemo<TableRecord[]>(() => doc.records("dimStyles"), [revision, open]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!open) return null;

  const current = doc.settings.currentDimStyle ?? "";
  const name = records.some((r) => r.name === selected) ? selected : (records.find((r) => r.name === current) ?? records[0])?.name ?? "";
  const record = records.find((r) => r.name === name);
  const family = scope === "parent" ? null : (scope as DimFamily);
  const style = dimStyleOf(record ?? { name: "Standard" });
  const effective = dimStyleOf(record ?? { name: "Standard" }, undefined, family === "angular" ? "angular2l" : family === "radial" ? "radial" : family === "diametric" ? "diametric" : family === "ordinate" ? "ordinate" : undefined);
  const childOverrides = family ? ((record?.children as Record<string, Record<string, unknown>> | undefined)?.[family] ?? {}) : {};
  const fields = DIM_STYLE_FIELDS.filter((f) => f.tab === tab);
  const used = record ? styleUsage(doc.all(), record.name) : 0;
  const other = records.find((r) => r.name === compareWith);
  const diffs = record && other ? diffDimStyles(dimStyleOf(record), dimStyleOf(other)) : [];

  const run = (cmd: ReturnType<typeof newStyleCommand>, ok: string): boolean => {
    if (!cmd) {
      setNote("That name is empty or already used.");
      return false;
    }
    bus.execute(cmd);
    setNote(ok);
    return true;
  };

  const edit = (key: string, value: unknown) => {
    if (!record) return;
    bus.execute({ type: "put-table-record", table: "dimStyles", record: withStyleField(record, key, value, scope) });
  };

  return (
    <div className="cmdpalette-backdrop" onMouseDown={() => setOpen(false)} data-testid="dimstyle-manager">
      <div className="shortcuts-panel dimstyle-panel" onMouseDown={(e) => e.stopPropagation()}>
        <div className="shortcuts-panel-head">
          <h2>Dimension styles</h2>
          <button className="shortcuts-panel-close" onClick={() => setOpen(false)} aria-label="Close">
            &#10005;
          </button>
        </div>
        <div className="dimstyle-body">
          <div className="dimstyle-list">
            {records.length === 0 && <div className="shortcuts-desc">No styles yet. Add one from the presets below.</div>}
            {records.map((r) => (
              <button key={r.name} className={`dimstyle-item ${r.name === name ? "on" : ""}`} onClick={() => setSelected(r.name)} data-testid={`dimstyle-item-${r.name}`}>
                {r.name}
                {r.name === current && <span className="dimstyle-current"> (current)</span>}
              </button>
            ))}
            <div className="dimstyle-actions">
              <select value="" onChange={(e) => e.target.value && run(presetCommand(records, e.target.value), `Added ${e.target.value}.`)} data-testid="dimstyle-add-preset">
                <option value="">Add preset…</option>
                {DIM_STYLE_PRESETS.filter((p) => !records.some((r) => r.name === p.name)).map((p) => (
                  <option key={p.name}>{p.name}</option>
                ))}
              </select>
              <input placeholder="New style name" value={newName} onChange={(e) => setNewName(e.target.value)} data-testid="dimstyle-new-name" />
              <button
                onClick={() => run(newStyleCommand(records, record, newName), `Created ${newName.trim()} from ${name || "defaults"}.`) && (setSelected(newName.trim()), setNewName(""))}
                data-testid="dimstyle-new"
              >
                New from selected
              </button>
              <button disabled={!record || name === current} onClick={() => bus.execute({ type: "set-settings", patch: { currentDimStyle: name } })} data-testid="dimstyle-set-current">
                Set current
              </button>
              <button
                disabled={!record || used > 0 || name === current}
                title={used > 0 ? `${used} dimension(s) use it` : name === current ? "It is the current style" : "Delete this style"}
                onClick={() => bus.execute({ type: "delete-table-record", table: "dimStyles", name })}
                data-testid="dimstyle-delete"
              >
                Delete
              </button>
            </div>
            {note && <div className="shortcuts-desc">{note}</div>}
          </div>
          <div className="dimstyle-main">
            <Preview style={effective} />
            <div className="dimstyle-scope">
              <span className="shortcuts-desc">Edit:</span>
              {FAMILIES.map((f) => (
                <button key={f.id} className={scope === f.id ? "on" : ""} onClick={() => setScope(f.id)}>
                  {f.label}
                </button>
              ))}
            </div>
            <div className="dimstyle-tabs">
              {DIM_STYLE_TABS.map((t) => (
                <button key={t} className={tab === t ? "on" : ""} onClick={() => setTab(t)} data-testid={`dimstyle-tab-${t}`}>
                  {t}
                </button>
              ))}
            </div>
            {record ? (
              <div className="dimstyle-form">
                {fields.map((f) => {
                  const overridden = family ? f.key in childOverrides : false;
                  return (
                    <label key={f.key} className="dimstyle-row" title={f.dxf}>
                      <span>
                        {f.label}
                        {family && overridden && (
                          <button className="dimstyle-reset" title="Use the parent's value" onClick={() => bus.execute({ type: "put-table-record", table: "dimStyles", record: withoutChildField(record, f.key, family) })}>
                            &#8635;
                          </button>
                        )}
                      </span>
                      <FieldInput f={f} value={effective[f.key]} onChange={(v) => edit(f.key, v)} />
                    </label>
                  );
                })}
              </div>
            ) : (
              <div className="shortcuts-desc">Select or add a style to edit it.</div>
            )}
            <div className="dimstyle-compare">
              <span className="shortcuts-desc">Compare with:</span>
              <select value={compareWith} onChange={(e) => setCompareWith(e.target.value)} data-testid="dimstyle-compare">
                <option value="">(none)</option>
                {records.filter((r) => r.name !== name).map((r) => (
                  <option key={r.name}>{r.name}</option>
                ))}
              </select>
              {other && diffs.length === 0 && <span className="shortcuts-desc">identical</span>}
              {diffs.length > 0 && (
                <table className="dimstyle-diff" data-testid="dimstyle-diff">
                  <thead>
                    <tr>
                      <th>Setting</th>
                      <th>{name}</th>
                      <th>{other?.name}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {diffs.map((d) => (
                      <tr key={d.key}>
                        <td>{DIM_STYLE_FIELDS.find((f) => f.key === d.key)?.label ?? d.key}</td>
                        <td>{String(d.a)}</td>
                        <td>{String(d.b)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
            <div className="shortcuts-desc">
              {used} dimension(s) use this style. Defaults: {DEFAULT_DIM_STYLE.textHeight} mm text. {style.name}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
