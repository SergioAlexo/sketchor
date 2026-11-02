import { useState } from "react";
import { SHEET_SET_DEFAULTS, layoutList, planSheetSet, sheetSetAttributes } from "@sketchor/core";
import { bus, doc } from "../state/store";

/**
 * L-04 sheet-set-lite: the attributes every title block shares (project, client, drawn by...) edited once for all
 * layouts, plus each sheet's own title. Applied as one undoable step; the fields in the title blocks follow live.
 */
export function SheetsDialog({ onClose }: { onClose: () => void }) {
  const layouts = layoutList(doc);
  const existing = sheetSetAttributes(doc);
  const keys = [...SHEET_SET_DEFAULTS, ...Object.keys(existing).filter((k) => !SHEET_SET_DEFAULTS.includes(k) && k !== "title")];
  const [common, setCommon] = useState<Record<string, string>>(() => Object.fromEntries(keys.map((k) => [k, existing[k] ?? ""])));
  const [titles, setTitles] = useState<Record<string, string>>(() => Object.fromEntries(layouts.map((l) => [l.name, (l.attributes as Record<string, string> | undefined)?.title ?? ""])));
  const [extra, setExtra] = useState("");

  const apply = () => {
    const nextCommon = { ...common };
    if (extra.trim()) nextCommon[extra.trim().toLowerCase()] = "";
    const perLayout: Record<string, Record<string, string>> = {};
    for (const l of layouts) {
      const own = { ...((l.attributes as Record<string, string> | undefined) ?? {}) };
      if (titles[l.name]?.trim()) own.title = titles[l.name];
      else delete own.title;
      perLayout[l.name] = own;
    }
    const commands = planSheetSet(doc, nextCommon, perLayout);
    if (commands.length) bus.execute({ type: "batch", commands });
    onClose();
  };

  return (
    <div className="fill-panel" data-testid="sheets-dialog" style={{ minWidth: 380, top: "15%", position: "fixed" }}>
      <strong>Sheet set - shared title block attributes</strong>
      {keys.map((k) => (
        <div className="fill-row" key={k}>
          <label style={{ flex: 1 }}>
            {`{{${k}}}`}{" "}
            <input type="text" value={common[k] ?? ""} style={{ width: "60%" }} data-testid={`sheets-${k}`} onChange={(e) => setCommon({ ...common, [k]: e.target.value })} />
          </label>
        </div>
      ))}
      <div className="fill-row">
        <label>
          Add attribute{" "}
          <input type="text" value={extra} placeholder="name" style={{ width: 90 }} onChange={(e) => setExtra(e.target.value.replace(/[^A-Za-z0-9_]/g, ""))} />
        </label>
      </div>
      <strong>Sheet titles</strong>
      {layouts.length === 0 && <div className="straighten-hint">No layouts yet.</div>}
      {layouts.map((l) => (
        <div className="fill-row" key={l.name}>
          <label style={{ flex: 1 }}>
            {l.name}{" "}
            <input type="text" value={titles[l.name] ?? ""} placeholder={l.name} style={{ width: "60%" }} onChange={(e) => setTitles({ ...titles, [l.name]: e.target.value })} />
          </label>
        </div>
      ))}
      <div className="fill-row">
        <button className="btn" data-testid="sheets-ok" onClick={apply}>OK</button>
        <button className="btn ghost" onClick={onClose}>Cancel</button>
      </div>
    </div>
  );
}
