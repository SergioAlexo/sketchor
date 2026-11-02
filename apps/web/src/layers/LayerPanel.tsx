import { useMemo, useState } from "react";
import { layerOf, DEFAULT_LAYER } from "@sketchor/core";
import { bus, doc, useApp } from "../state/store";
import { useTargetViewport } from "../layouts/targetViewport";

/**
 * Layer panel: lists the drawing's layers with visibility and lock
 * toggles, the active layer (where new geometry lands), and add/delete.
 * Layers come from DXF imports (group code 8) or are created here; hiding
 * one removes its geometry from the canvas without deleting it, and
 * locking one leaves it on screen but out of reach of every selection.
 */
export function LayerPanel() {
  const layers = useApp((s) => s.layers);
  const activeLayer = useApp((s) => s.activeLayer);
  const revision = useApp((s) => s.revision);
  const setActiveLayer = useApp((s) => s.setActiveLayer);
  const toggleLayer = useApp((s) => s.toggleLayer);
  const toggleLayerLock = useApp((s) => s.toggleLayerLock);
  const addLayer = useApp((s) => s.addLayer);
  const deleteLayer = useApp((s) => s.deleteLayer);
  const renameLayer = useApp((s) => s.renameLayer);
  const flattenLayers = useApp((s) => s.flattenLayers);
  const deleteEmptyLayers = useApp((s) => s.deleteEmptyLayers);

  const vp = useTargetViewport(); // L-03: "VP freeze" column while a layout has a target viewport
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState("");

  // Entity count per layer, recomputed whenever the document changes.
  const counts = useMemo(() => {
    const m = new Map<string, number>();
    for (const e of doc.all()) m.set(layerOf(e), (m.get(layerOf(e)) ?? 0) + 1);
    return m;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [revision]);

  const emptyLayerCount = layers.filter((l) => l.name !== DEFAULT_LAYER && (counts.get(l.name) ?? 0) === 0).length;
  const canFlatten = layers.length > 1;

  const commitRename = (from: string) => {
    if (draft.trim() && draft.trim() !== from) renameLayer(from, draft);
    setEditing(null);
  };

  return (
    <aside className="layerpanel" data-testid="layer-panel">
      <div className="layerpanel-header">
        <span>Layers</span>
        <button
          className="btn ghost"
          onClick={addLayer}
          title="Add a new layer"
          data-testid="layer-add"
        >
          + Add
        </button>
      </div>
      <div className="layerpanel-toolbar">
        <button
          className="btn ghost sm"
          onClick={deleteEmptyLayers}
          title="Remove every layer with nothing on it"
          data-testid="layer-clean-empty"
          disabled={emptyLayerCount === 0}
        >
          Clean up{emptyLayerCount > 0 ? ` (${emptyLayerCount})` : ""}
        </button>
        <button
          className="btn ghost sm"
          onClick={flattenLayers}
          title="Move everything onto the default layer and remove the rest"
          data-testid="layer-flatten"
          disabled={!canFlatten}
        >
          Flatten
        </button>
      </div>
      <div className="layerpanel-list">
        {layers.map((layer) => {
          const active = layer.name === activeLayer;
          return (
            <div
              key={layer.name}
              className={`layer-row ${active ? "active" : ""} ${layer.locked ? "locked" : ""}`}
              data-testid={`layer-${layer.name}`}
              onClick={() => setActiveLayer(layer.name)}
            >
              <button
                className={`layer-eye ${layer.visible ? "" : "off"}`}
                title={layer.visible ? "Hide layer" : "Show layer"}
                data-testid={`layer-toggle-${layer.name}`}
                onClick={(e) => {
                  e.stopPropagation();
                  toggleLayer(layer.name);
                }}
              >
                {layer.visible ? <EyeIcon /> : <EyeOffIcon />}
              </button>
              <button
                className={`layer-eye ${layer.locked ? "on" : "off"}`}
                title={layer.locked ? "Unlock layer" : "Lock layer — visible, but nothing on it can be selected"}
                data-testid={`layer-lock-${layer.name}`}
                onClick={(e) => {
                  e.stopPropagation();
                  toggleLayerLock(layer.name);
                }}
              >
                {layer.locked ? <LockIcon /> : <UnlockIcon />}
              </button>

              {vp && (
                <button
                  className={`layer-eye ${vp.frozenLayers?.includes(layer.name) ? "on" : "off"}`}
                  title={vp.frozenLayers?.includes(layer.name) ? "Thaw in this viewport" : "Freeze in this viewport only"}
                  data-testid={`layer-vpfreeze-${layer.name}`}
                  onClick={(e) => {
                    e.stopPropagation();
                    const frozen = new Set(vp.frozenLayers ?? []);
                    if (!frozen.delete(layer.name)) frozen.add(layer.name);
                    const { frozenLayers: _drop, ...rest } = vp;
                    bus.execute({ type: "update-entity", entity: frozen.size ? { ...rest, frozenLayers: [...frozen] } : rest });
                  }}
                >
                  {vp.frozenLayers?.includes(layer.name) ? "F" : "T"}
                </button>
              )}

              {editing === layer.name ? (
                <input
                  className="layer-rename"
                  autoFocus
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  onBlur={() => commitRename(layer.name)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") commitRename(layer.name);
                    if (e.key === "Escape") setEditing(null);
                  }}
                  onClick={(e) => e.stopPropagation()}
                />
              ) : (
                <span
                  className="layer-name"
                  onDoubleClick={(e) => {
                    if (layer.name === DEFAULT_LAYER) return;
                    e.stopPropagation();
                    setDraft(layer.name);
                    setEditing(layer.name);
                  }}
                  title={layer.name === DEFAULT_LAYER ? "Default layer" : "Double-click to rename"}
                >
                  {layer.name}
                </span>
              )}

              <span className="layer-count">{counts.get(layer.name) ?? 0}</span>
              <button
                className="layer-del"
                title={
                  layer.name === DEFAULT_LAYER
                    ? "The default layer can't be removed"
                    : "Delete layer (its geometry moves to the default layer)"
                }
                data-testid={`layer-delete-${layer.name}`}
                disabled={layer.name === DEFAULT_LAYER}
                onClick={(e) => {
                  e.stopPropagation();
                  deleteLayer(layer.name);
                }}
              >
                <TrashIcon />
              </button>
            </div>
          );
        })}
      </div>
      <div className="layerpanel-footer">
        New geometry is drawn on <b>{activeLayer}</b>
      </div>
    </aside>
  );
}

function LockIcon() {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16">
      <rect x="5" y="11" width="14" height="9" rx="1.5" stroke="currentColor" strokeWidth="1.8" fill="none" />
      <path d="M8 11V8a4 4 0 0 1 8 0v3" stroke="currentColor" strokeWidth="1.8" fill="none" />
    </svg>
  );
}

/** The open shackle: same body, hasp swung clear, so locked/unlocked read at a glance. */
function UnlockIcon() {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16">
      <rect x="5" y="11" width="14" height="9" rx="1.5" stroke="currentColor" strokeWidth="1.8" fill="none" />
      <path d="M8 11V8a4 4 0 0 1 7.5-2" stroke="currentColor" strokeWidth="1.8" fill="none" />
    </svg>
  );
}

function EyeIcon() {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16">
      <path
        d="M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6S2 12 2 12z"
        stroke="currentColor"
        strokeWidth="1.8"
        fill="none"
      />
      <circle cx="12" cy="12" r="2.6" stroke="currentColor" strokeWidth="1.8" fill="none" />
    </svg>
  );
}

function EyeOffIcon() {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16">
      <path
        d="M4 4l16 16M9.6 5.2A9.9 9.9 0 0112 5c6.5 0 10 6 10 6a17 17 0 01-3.3 3.8M6.5 7.3A17 17 0 002 11s3.5 6 10 6a9.7 9.7 0 003.3-.6"
        stroke="currentColor"
        strokeWidth="1.8"
        fill="none"
        strokeLinecap="round"
      />
    </svg>
  );
}

function TrashIcon() {
  return (
    <svg viewBox="0 0 24 24" width="15" height="15">
      <path
        d="M4 7h16M9 7V5h6v2M6 7l1 13h10l1-13"
        stroke="currentColor"
        strokeWidth="1.8"
        fill="none"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
