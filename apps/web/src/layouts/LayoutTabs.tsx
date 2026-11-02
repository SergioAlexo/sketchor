import { useEffect, useRef, useState } from "react";
import {
  LAYOUTS_TABLE,
  STANDARD_SCALES,
  boundsOf,
  layoutEntities,
  layoutList,
  modelEntities,
  newEntityId,
  newLayout,
  parseScale,
  scaleLabel,
  standardScaleName,
  uniqueLayoutName,
  viewportPreset,
  type LayoutRecord,
} from "@sketchor/core";
import { printableRect } from "../viewport/sheetRender";
import { useTargetViewport } from "./targetViewport";
import { bus, doc, useApp } from "../state/store";
import { setActiveLayout, setMspace, useSpaceState } from "./layoutState";
import { PageSetupDialog } from "./PageSetupDialog";

/**
 * L-02: the bottom strip of a drawing tab: Model | Layout1 | Layout2 | +.
 * Everything goes through layout commands, so renaming, deleting and
 * reordering are undoable; which tab is showing is UI state (layoutState.ts).
 */
export function LayoutTabs() {
  useApp((s) => s.revision);
  const space = useSpaceState();
  const layouts = layoutList(doc);
  const [menu, setMenu] = useState<{ x: number; y: number; name: string } | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [setup, setSetup] = useState<string | null>(null);

  // A layout can disappear under the user (delete, undo of its creation): fall back to Model.
  const gone = space.layout !== null && !doc.hasRecord(LAYOUTS_TABLE, space.layout);
  useEffect(() => {
    if (gone) setActiveLayout(null);
  }, [gone]);

  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    window.addEventListener("pointerdown", close);
    return () => window.removeEventListener("pointerdown", close);
  }, [menu]);

  const add = () => {
    const name = uniqueLayoutName(doc);
    bus.execute({ type: "add-layout", layout: newLayout(name) });
    setActiveLayout(name);
  };

  const duplicate = (name: string) => {
    const src = layouts.find((l) => l.name === name);
    if (!src) return;
    let n = 2;
    while (doc.hasRecord(LAYOUTS_TABLE, `${name} (${n})`)) n++;
    const finalName = `${name} (${n})`;
    const idMap = new Map<string, string>();
    const copies = layoutEntities(doc, name).map((e) => {
      const id = newEntityId();
      idMap.set(e.id, id);
      return { ...e, id, space: finalName };
    });
    bus.execute({
      type: "batch",
      commands: [{ type: "add-layout", layout: { ...src, name: finalName } as LayoutRecord }, ...copies.map((entity) => ({ type: "add-entity" as const, entity }))],
    });
    setActiveLayout(finalName);
  };

  const move = (name: string, delta: number) => {
    const names = layouts.map((l) => l.name);
    const i = names.indexOf(name);
    const j = i + delta;
    if (i < 0 || j < 0 || j >= names.length) return;
    [names[i], names[j]] = [names[j], names[i]];
    bus.execute({ type: "reorder-layouts", names });
  };

  const remove = (name: string) => {
    if (layoutEntities(doc, name).length > 0 && !window.confirm(`Delete layout "${name}" and everything drawn on it?`)) return;
    bus.execute({ type: "delete-layout", name });
  };

  return (
    <div className="layout-tabs" data-testid="layout-tabs">
      <button className={`layout-tab ${space.layout === null ? "active" : ""}`} data-testid="layout-tab-model" onClick={() => setActiveLayout(null)}>
        Model
      </button>
      {layouts.map((l) =>
        renaming === l.name ? (
          <RenameInput
            key={l.name}
            initial={l.name}
            onDone={(to) => {
              setRenaming(null);
              if (to && to !== l.name && !doc.hasRecord(LAYOUTS_TABLE, to)) {
                bus.execute({ type: "rename-layout", from: l.name, to });
                if (space.layout === l.name) setActiveLayout(to);
              }
            }}
          />
        ) : (
          <button
            key={l.name}
            className={`layout-tab ${space.layout === l.name ? "active" : ""}`}
            data-testid={`layout-tab-${l.name}`}
            onClick={() => setActiveLayout(l.name)}
            onDoubleClick={() => setRenaming(l.name)}
            onContextMenu={(e) => {
              e.preventDefault();
              setMenu({ x: e.clientX, y: e.clientY, name: l.name });
            }}
            title={`${l.paper.size} ${l.paper.orientation} - ${Math.round(l.paper.w * 10) / 10} x ${Math.round(l.paper.h * 10) / 10} ${l.paper.units}`}
          >
            {l.name}
          </button>
        ),
      )}
      <button className="layout-tab add" data-testid="layout-tab-add" onClick={add} title="New layout">
        +
      </button>
      {space.layout && (
        <button className="layout-tab setup" data-testid="layout-page-setup" onClick={() => setSetup(space.layout)} title="Page setup">
          Page setup
        </button>
      )}
      {menu && (
        <div className="layout-menu" style={{ left: menu.x, top: menu.y - 160 }} onPointerDown={(e) => e.stopPropagation()}>
          <button onClick={() => { setRenaming(menu.name); setMenu(null); }}>Rename</button>
          <button onClick={() => { duplicate(menu.name); setMenu(null); }}>Duplicate</button>
          <button onClick={() => { move(menu.name, -1); setMenu(null); }}>Move left</button>
          <button onClick={() => { move(menu.name, 1); setMenu(null); }}>Move right</button>
          <button onClick={() => { setSetup(menu.name); setMenu(null); }}>Page setup...</button>
          <button onClick={() => { remove(menu.name); setMenu(null); }}>Delete</button>
        </div>
      )}
      {setup && <PageSetupDialog name={setup} onClose={() => setSetup(null)} />}
    </div>
  );
}

function RenameInput({ initial, onDone }: { initial: string; onDone: (value: string | null) => void }) {
  const ref = useRef<HTMLInputElement>(null);
  const [v, setV] = useState(initial);
  useEffect(() => {
    ref.current?.select();
  }, []);
  return (
    <input
      ref={ref}
      className="layout-rename"
      value={v}
      data-testid="layout-rename"
      onChange={(e) => setV(e.target.value)}
      onBlur={() => onDone(v.trim() || null)}
      onKeyDown={(e) => {
        if (e.key === "Enter") onDone(v.trim() || null);
        if (e.key === "Escape") onDone(null);
      }}
    />
  );
}

/** L-03: the status-bar controls of a layout: viewport tool and presets, scale, lock and the MSPACE/PSPACE toggle. */
function ViewportControls({ layout }: { layout: string }) {
  const vp = useTargetViewport();
  const space = useSpaceState();
  const rec = layoutList(doc).find((l) => l.name === layout);
  const update = (patch: { scale?: number; locked?: boolean }) => {
    if (!vp) return;
    const { locked: _l, ...rest } = vp;
    const next = { ...rest, ...(patch.scale !== undefined ? { scale: patch.scale } : {}), ...((patch.locked ?? vp.locked) ? { locked: true } : {}) };
    bus.execute({ type: "update-entity", entity: next });
  };
  const preset = (n: number) => {
    if (!rec || n < 1 || n > 4) return;
    const a = printableRect(rec);
    const area = { x: a.x + 5, y: a.y + 5, w: Math.max(10, a.w - 10), h: Math.max(10, a.h - 10) };
    const vps = viewportPreset(n as 1 | 2 | 3 | 4, area, boundsOf(modelEntities(doc)), { space: layout });
    bus.execute({ type: "batch", commands: vps.map((entity) => ({ type: "add-entity" as const, entity })) });
  };
  const current = vp ? (standardScaleName(vp.scale) ?? scaleLabel(vp.scale)) : "";
  return (
    <div className="layout-vpbar" data-testid="layout-vpbar">
      <button className="layout-tab" data-testid="layout-viewport-tool" title="Draw a viewport (rectangle / polygon / from object)" onClick={() => useApp.getState().setTool("viewport")}>
        Viewport
      </button>
      <select className="layout-select" value="" data-testid="layout-vp-preset" title="Tile the sheet with 1-4 viewports" onChange={(e) => preset(Number(e.target.value))}>
        <option value="">Viewports...</option>
        {[1, 2, 3, 4].map((n) => (
          <option key={n} value={n}>{n} viewport{n > 1 ? "s" : ""}</option>
        ))}
      </select>
      {vp && (
        <>
          <select
            className="layout-select"
            value={current}
            data-testid="layout-vp-scale"
            title="Scale of the viewport (paper : model)"
            disabled={!!vp.locked}
            onChange={(e) => {
              if (e.target.value === "custom") {
                const text = window.prompt("Scale (paper:model), e.g. 1:75", current);
                const v = text ? parseScale(text) : null;
                if (v) update({ scale: v });
              } else {
                const v = parseScale(e.target.value);
                if (v) update({ scale: v });
              }
            }}
          >
            {!standardScaleName(vp.scale) && <option value={current}>{current}</option>}
            {STANDARD_SCALES.map((s) => (
              <option key={s}>{s}</option>
            ))}
            <option value="custom">Custom...</option>
          </select>
          <button className={`layout-tab ${vp.locked ? "active" : ""}`} data-testid="layout-vp-lock" title="Lock the viewport's pan/zoom" onClick={() => update({ locked: !vp.locked })}>
            {vp.locked ? "Locked" : "Lock"}
          </button>
          <button className={`layout-tab ${space.mspace ? "active" : ""}`} data-testid="layout-mspace" title="Work on the model through the viewport (double-click inside it) / back to the sheet (double-click outside)" onClick={() => setMspace(space.mspace ? null : vp.id)}>
            {space.mspace ? "Model (MS)" : "Paper (PS)"}
          </button>
        </>
      )}
    </div>
  );
}
