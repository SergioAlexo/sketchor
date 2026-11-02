import { useState } from "react";
import { PAPER_SIZE_NAMES, getLayout, paperSpec, type LayoutRecord, type PlotStyle } from "@sketchor/core";
import { bus, doc } from "../state/store";

/** L-02 page setup: paper size (list + custom), orientation, margins and plot style, applied as one undoable record change. */
export function PageSetupDialog({ name, onClose }: { name: string; onClose: () => void }) {
  const current = getLayout(doc, name);
  const [draft, setDraft] = useState<LayoutRecord | null>(current ?? null);
  if (!current || !draft) return null;
  const p = draft.paper;

  const setSize = (size: string) =>
    setDraft({ ...draft, paper: size === "Custom" ? { ...p, size: "Custom" } : paperSpec(size, p.orientation) });
  const setOrientation = (o: "landscape" | "portrait") => {
    const [w, h] = o === "landscape" ? [Math.max(p.w, p.h), Math.min(p.w, p.h)] : [Math.min(p.w, p.h), Math.max(p.w, p.h)];
    setDraft({ ...draft, paper: { ...p, w, h, orientation: o } });
  };
  const num = (v: string, fallback: number) => (Number.isFinite(parseFloat(v)) ? Math.max(0, parseFloat(v)) : fallback);
  const margin = (key: keyof LayoutRecord["margins"], label: string) => (
    <label key={key} style={{ width: "48%" }}>
      {label}{" "}
      <input type="number" min={0} step={1} style={{ width: 56 }} value={draft.margins[key]} data-testid={`page-margin-${key}`} onChange={(e) => setDraft({ ...draft, margins: { ...draft.margins, [key]: num(e.target.value, draft.margins[key]) } })} />
    </label>
  );

  const apply = () => {
    bus.execute({ type: "put-table-record", table: "layouts", record: draft });
    onClose();
  };

  return (
    <div className="fill-panel" data-testid="page-setup" style={{ minWidth: 340, top: "20%", position: "fixed" }}>
      <strong>Page setup - {name}</strong>
      <div className="fill-row">
        <label>
          Paper{" "}
          <select value={p.size} data-testid="page-size" onChange={(e) => setSize(e.target.value)}>
            {PAPER_SIZE_NAMES.map((n) => (
              <option key={n}>{n}</option>
            ))}
          </select>
        </label>
        <label>
          <select value={p.orientation} data-testid="page-orientation" onChange={(e) => setOrientation(e.target.value as "landscape" | "portrait")}>
            <option value="landscape">Landscape</option>
            <option value="portrait">Portrait</option>
          </select>
        </label>
      </div>
      {p.size === "Custom" && (
        <div className="fill-row">
          <label>
            W <input type="number" min={1} style={{ width: 70 }} value={p.w} data-testid="page-width" onChange={(e) => setDraft({ ...draft, paper: { ...p, w: Math.max(1, num(e.target.value, p.w)) } })} />
          </label>
          <label>
            H <input type="number" min={1} style={{ width: 70 }} value={p.h} data-testid="page-height" onChange={(e) => setDraft({ ...draft, paper: { ...p, h: Math.max(1, num(e.target.value, p.h)) } })} />
          </label>
          <select value={p.units} data-testid="page-units" onChange={(e) => setDraft({ ...draft, paper: { ...p, units: e.target.value as "mm" | "in" } })}>
            <option value="mm">mm</option>
            <option value="in">in</option>
          </select>
        </div>
      )}
      <div className="fill-row" style={{ flexWrap: "wrap" }}>
        {margin("left", "Left")}
        {margin("right", "Right")}
        {margin("top", "Top")}
        {margin("bottom", "Bottom")}
      </div>
      <div className="fill-row">
        <label>
          Plot style{" "}
          <select value={draft.plotSettings.plotStyle} data-testid="page-plot-style" onChange={(e) => setDraft({ ...draft, plotSettings: { ...draft.plotSettings, plotStyle: e.target.value as PlotStyle } })}>
            <option>as displayed</option>
            <option>monochrome</option>
            <option>grayscale</option>
          </select>
        </label>
        <label>
          <input type="checkbox" checked={draft.plotSettings.scaleLineweights} onChange={(e) => setDraft({ ...draft, plotSettings: { ...draft.plotSettings, scaleLineweights: e.target.checked } })} /> Scale lineweights
        </label>
      </div>
      <div className="fill-row">
        <button className="btn" data-testid="page-setup-ok" onClick={apply}>OK</button>
        <button className="btn ghost" onClick={onClose}>Cancel</button>
      </div>
    </div>
  );
}
