import { useEffect, useMemo, useRef, useState } from "react";
import { partOf } from "./measure";
import type { Model3D, ModelNode } from "./types";
import { useViewer } from "./viewerStore";

/**
 * The model tab's right-hand panel: the assembly structure, in the slot
 * layers occupy for a drawing. Layers mean nothing to a STEP file — its
 * hierarchy does, so a model tab shows that instead.
 *
 * Clicking a part selects it (the measurement readout then reports its
 * size, area and volume), double-clicking frames it, and the dot hides
 * it. Right-clicking anything — a part or a whole sub-assembly — offers
 * **Isolate**, which hides everything else: the only practical way to
 * look at one bracket inside a 127-part assembly.
 */
export function StructurePanel({ model }: { model: Model3D }) {
  const selection = useViewer((s) => s.selection);
  const hidden = useViewer((s) => s.hidden);
  // Only the hovered *part*: the cursor crossing faces and edges of one part must not re-render a tree of thousands of rows.
  const hoveredPart = useViewer((s) => (s.hover ? partOf(model, s.hover) : null));
  const pick = useViewer((s) => s.pick);
  const setHover = useViewer((s) => s.setHover);
  const toggleHidden = useViewer((s) => s.toggleHidden);
  const hide = useViewer((s) => s.hide);
  const showAll = useViewer((s) => s.showAll);
  const isolate = useViewer((s) => s.isolate);
  const requestFrame = useViewer((s) => s.requestFrame);
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  const [filter, setFilter] = useState("");
  /** The right-click menu: where it is, and what it acts on. */
  const [menu, setMenu] = useState<{ x: number; y: number; label: string; parts: number[] } | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);

  // Any click elsewhere, or Escape, closes the menu — it is a menu, not a mode.
  // The close listener runs in the CAPTURE phase (so it also sees a click on
  // the canvas behind the panel), which fires *before* a bubble-phase click
  // inside the menu itself — a menu button's stopPropagation() can't undo
  // that, it's already too late in the dispatch order. So the check has to
  // be "was the target inside the menu", not "did something ask us to stop".
  // Get this wrong (as it was) and every menu button closes the menu on
  // pointerdown without ever running its own onClick, because React has
  // already unmounted it by the time the click event follows.
  useEffect(() => {
    if (!menu) return;
    const close = (e: PointerEvent) => {
      if (e.target instanceof Node && menuRef.current?.contains(e.target)) return;
      setMenu(null);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setMenu(null);
        e.stopPropagation();
      }
    };
    window.addEventListener("pointerdown", close, true);
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("pointerdown", close, true);
      window.removeEventListener("keydown", onKey, true);
    };
  }, [menu]);
  const q = filter.trim().toLowerCase();

  // Which parts the current selection touches, so a picked face highlights its part in the tree.
  const selectedParts = useMemo(() => new Set(selection.map((r) => partOf(model, r))), [selection, model]);

  /** Every part under a node, however deep — what "isolate this assembly" means. */
  const partsUnder = (node: ModelNode): number[] => [...node.parts, ...node.children.flatMap(partsUnder)];

  const rows: { key: string; depth: number; label: string; part: number | null; parts: number[] }[] = [];
  const walk = (node: ModelNode, depth: number, key: string, isRoot: boolean) => {
    let childDepth = depth;
    if (!isRoot || node.children.length > 0) {
      rows.push({ key, depth, label: node.name || "Assembly", part: null, parts: partsUnder(node) });
      childDepth = depth + 1;
      if (collapsed.has(key) && !q) return;
    }
    for (const p of node.parts) {
      const name = model.parts[p].name;
      if (q && !name.toLowerCase().includes(q)) continue;
      rows.push({ key: `${key}/p${p}`, depth: childDepth, label: name, part: p, parts: [p] });
    }
    node.children.forEach((c, i) => walk(c, childDepth, `${key}/${i}`, false));
  };
  walk(model.tree, 0, "root", true);

  return (
    <aside className="layerpanel" data-testid="structure-panel">
      <div className="layerpanel-header">
        <span>Structure</span>
        <button className="btn ghost sm" onClick={showAll} disabled={hidden.size === 0} title="Show every hidden part" data-testid="structure-show-all">
          Show all{hidden.size > 0 ? ` (${hidden.size})` : ""}
        </button>
      </div>
      <input
        className="filexplorer-search"
        type="search"
        placeholder="Filter parts…"
        value={filter}
        data-testid="structure-filter"
        onChange={(e) => setFilter(e.target.value)}
      />
      <div className="model-parts-list" onPointerLeave={() => setHover(null)}>
        {rows.map((r) =>
          r.part === null ? (
            <div
              key={r.key}
              className="model-parts-group"
              style={{ paddingLeft: 8 + r.depth * 12 }}
              onContextMenu={(e) => {
                e.preventDefault();
                setMenu({ x: e.clientX, y: e.clientY, label: r.label, parts: r.parts });
              }}
              onClick={() =>
                setCollapsed((c) => {
                  const next = new Set(c);
                  if (next.has(r.key)) next.delete(r.key);
                  else next.add(r.key);
                  return next;
                })
              }
            >
              <span className="model-parts-caret">{collapsed.has(r.key) ? "▸" : "▾"}</span>
              {r.label}
            </div>
          ) : (
            <div
              key={r.key}
              className={`model-parts-row ${selectedParts.has(r.part) ? "selected" : ""} ${hidden.has(r.part) ? "hidden" : ""} ${hoveredPart === r.part ? "hovered" : ""}`}
              style={{ paddingLeft: 8 + r.depth * 12 }}
              data-testid={`structure-part-${r.part}`}
              onClick={(e) => pick({ kind: "part", index: r.part! }, e.shiftKey || e.ctrlKey || e.metaKey)}
              onContextMenu={(e) => {
                e.preventDefault();
                // Right-clicking something unselected selects it first, so
                // the menu always acts on what the user is pointing at.
                if (!selectedParts.has(r.part!)) pick({ kind: "part", index: r.part! }, false);
                setMenu({ x: e.clientX, y: e.clientY, label: r.label, parts: r.parts });
              }}
              onDoubleClick={() => requestFrame(r.part!)}
              onPointerEnter={() => setHover({ kind: "part", index: r.part! })}
              title="Click to select · double-click to frame"
            >
              <button
                className="model-parts-eye"
                title={hidden.has(r.part) ? "Show" : "Hide"}
                onClick={(e) => {
                  e.stopPropagation();
                  toggleHidden(r.part!);
                }}
              >
                {hidden.has(r.part) ? "○" : "●"}
              </button>
              <span className="model-parts-name">{r.label}</span>
            </div>
          ),
        )}
      </div>
      {menu && (
        <div
          ref={menuRef}
          className="structure-menu"
          style={{ left: menu.x, top: menu.y }}
          data-testid="structure-menu"
        >
          <div className="structure-menu-head" title={menu.label}>
            {menu.label}
          </div>
          <button
            data-testid="structure-menu-isolate"
            onClick={() => {
              // The viewer fits what survives; no need to frame a part too.
              isolate(menu.parts, model.parts.length);
              setMenu(null);
            }}
          >
            Isolate{menu.parts.length > 1 ? ` (${menu.parts.length} parts)` : ""}
          </button>
          <button
            data-testid="structure-menu-hide"
            onClick={() => {
              for (const p of menu.parts) hide(p);
              setMenu(null);
            }}
          >
            Hide
          </button>
          <button
            data-testid="structure-menu-zoom"
            onClick={() => {
              requestFrame(menu.parts[0] ?? 0);
              setMenu(null);
            }}
          >
            Zoom to
          </button>
          <button
            data-testid="structure-menu-show-all"
            disabled={hidden.size === 0}
            onClick={() => {
              showAll();
              setMenu(null);
            }}
          >
            Show all
          </button>
        </div>
      )}
      <div className="structure-footer">
        {model.parts.length} parts · {model.faces.area.length} faces · {model.edgeTable.length.length} edges
      </div>
    </aside>
  );
}
