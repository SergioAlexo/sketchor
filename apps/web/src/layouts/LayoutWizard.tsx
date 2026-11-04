import { useMemo, useState } from "react";
import { PAPER_SIZE_NAMES, STANDARD_SCALES, paperSpec, planLayoutFromModel, scaleLabel } from "@sketchor/core";
import { bus, doc, useApp } from "../state/store";
import { setActiveLayout } from "./layoutState";

/**
 * L-08: "Layout from model". Pick the paper, whether to add a border + title block, a scale (or fit) and what to
 * frame (the whole drawing or the selection); one click creates the layout with its viewport (one undo step) and
 * switches to it. The plan is recomputed live so the dialog can say which scale "fit" gave and whether it fits.
 */
export function LayoutWizard({ onClose }: { onClose: () => void }) {
  const selection = useApp((s) => s.selection);
  const [size, setSize] = useState("A4");
  const [orientation, setOrientation] = useState<"landscape" | "portrait">("landscape");
  const [titleBlock, setTitleBlock] = useState(true);
  const [scale, setScale] = useState("fit");
  const [useSelection, setUseSelection] = useState(selection.length > 0);
  const [name, setName] = useState("");

  const options = useMemo(
    () => ({
      ...(name.trim() ? { name } : {}),
      paper: paperSpec(size, orientation),
      titleBlock,
      scale,
      ...(useSelection && selection.length > 0 ? { ids: selection } : {}),
    }),
    [name, size, orientation, titleBlock, scale, useSelection, selection],
  );
  const plan = useMemo(() => planLayoutFromModel(doc, options), [options]);

  const create = () => {
    if (!plan) return;
    bus.execute(plan.commands[0]);
    setActiveLayout(plan.layoutName);
    onClose();
  };

  return (
    <div className="fill-panel" data-testid="layout-wizard" style={{ minWidth: 340, top: "20%", position: "fixed" }}>
      <strong>Layout from model</strong>
      <div className="fill-row">
        <label>
          Name{" "}
          <input value={name} placeholder="Layout1" style={{ width: 120 }} data-testid="wizard-name" onChange={(e) => setName(e.target.value)} />
        </label>
      </div>
      <div className="fill-row">
        <label>
          Paper{" "}
          <select value={size} data-testid="wizard-paper" onChange={(e) => setSize(e.target.value)}>
            {PAPER_SIZE_NAMES.filter((n) => n !== "Custom").map((n) => (
              <option key={n}>{n}</option>
            ))}
          </select>
        </label>
        <select value={orientation} data-testid="wizard-orientation" onChange={(e) => setOrientation(e.target.value as "landscape" | "portrait")}>
          <option value="landscape">Landscape</option>
          <option value="portrait">Portrait</option>
        </select>
      </div>
      <div className="fill-row">
        <label>
          Scale{" "}
          <select value={scale} data-testid="wizard-scale" onChange={(e) => setScale(e.target.value)}>
            <option value="fit">Fit to sheet</option>
            {STANDARD_SCALES.map((s) => (
              <option key={s}>{s}</option>
            ))}
          </select>
        </label>
        <label>
          <input type="checkbox" checked={titleBlock} data-testid="wizard-titleblock" onChange={(e) => setTitleBlock(e.target.checked)} /> Title block
        </label>
      </div>
      {selection.length > 0 && (
        <div className="fill-row">
          <label>
            <input type="checkbox" checked={useSelection} data-testid="wizard-selection" onChange={(e) => setUseSelection(e.target.checked)} /> Frame the selection only
          </label>
        </div>
      )}
      <div className="fill-row" data-testid="wizard-summary" style={{ opacity: 0.8 }}>
        {plan ? `Viewport at ${scaleLabel(plan.scale)}${plan.fits ? "" : " (model does not fit)"}` : "Nothing to frame, or the sheet is too small."}
      </div>
      {plan?.warnings.map((w) => (
        <div key={w} className="fill-row" style={{ opacity: 0.8 }}>
          {w}
        </div>
      ))}
      <div className="fill-row">
        <button className="btn" data-testid="wizard-create" disabled={!plan} onClick={create}>
          Create layout
        </button>
        <button className="btn ghost" onClick={onClose}>
          Cancel
        </button>
      </div>
    </div>
  );
}
