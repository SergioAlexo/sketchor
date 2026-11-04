import { useMemo, useRef, useState } from "react";
import { PAPER_SIZE_NAMES, STANDARD_SCALES, paperSpec, planFromTemplate, planLayoutFromModel, scaleLabel } from "@sketchor/core";
import { bus, doc, useApp } from "../state/store";
import { setActiveLayout } from "./layoutState";
import { installTemplatePack, loadContributedTemplates } from "./templateStore";

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
  // L-09: sheet templates contributed by plugins; "" = a plain sheet built from the options below.
  const [packVersion, setPackVersion] = useState(0);
  const templates = useMemo(() => loadContributedTemplates(), [packVersion]);
  const [templateIdx, setTemplateIdx] = useState("");
  const [note, setNote] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);
  const template = templateIdx === "" ? undefined : templates[Number(templateIdx)];
  const installPack = async (f: File) => {
    const r = installTemplatePack(await f.text());
    if (r.ok) {
      setPackVersion((v) => v + 1);
      setNote(`Installed ${r.count} template${r.count === 1 ? "" : "s"} from ${r.id}${r.warnings.length ? `, ${r.warnings.length} warning(s)` : ""}`);
    } else setNote(r.reason);
  };

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
  const plan = useMemo(() => {
    if (template) {
      const t = planFromTemplate(doc, template, { ...(name.trim() ? { name } : {}), ...(useSelection && selection.length > 0 ? { ids: selection } : {}) });
      return t ? { layoutName: t.layoutNames[0], commands: t.commands, scale: 0, fits: true, warnings: t.warnings } : null;
    }
    return planLayoutFromModel(doc, options);
  }, [options, template, name, useSelection, selection]);

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
          Template{" "}
          <select value={templateIdx} data-testid="wizard-template" onChange={(e) => setTemplateIdx(e.target.value)}>
            <option value="">Plain sheet</option>
            {templates.map((t, i) => (
              <option key={`${t.file}:${i}`} value={i}>{t.title}</option>
            ))}
          </select>
        </label>
        <button className="btn ghost sm" data-testid="wizard-install-template" onClick={() => fileRef.current?.click()}>
          Install pack...
        </button>
        <input ref={fileRef} type="file" accept=".json,application/json" hidden onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ""; if (f) void installPack(f); }} />
      </div>
      {note && <div className="fill-row" style={{ opacity: 0.8 }}>{note}</div>}
      <div className="fill-row" hidden={!!template}>
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
      <div className="fill-row" hidden={!!template}>
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
        {template
          ? plan
            ? `Template "${template.title}": ${template.layouts.length} layout${template.layouts.length === 1 ? "" : "s"}, viewports fitted to the drawing`
            : "This template has no layout."
          : plan
            ? `Viewport at ${scaleLabel(plan.scale)}${plan.fits ? "" : " (model does not fit)"}`
            : "Nothing to frame, or the sheet is too small."}
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
