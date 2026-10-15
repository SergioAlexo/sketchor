import { useEffect, useMemo, useRef, useState } from "react";
import { colorOf, layerOf, selectMatching, type Entity, type SelectFilter } from "@sketchor/core";
import { doc, selectableEntities, useApp } from "./state/store";
import { matchesBinding } from "./keybindings";

/**
 * The status bar's SELECT button: AutoCAD's Quick Select, as a popover
 * (roadmap T-29). Tick the types, layers and colours you mean; the button
 * says how many entities match before you commit to it, which is the whole
 * point — a selection you can't preview is one you find out about by
 * pressing Delete.
 *
 * Only values actually present in the drawing are offered, so the list is
 * short and nothing in it selects zero.
 */

const TYPE_LABELS: Record<Entity["type"], string> = {
  line: "Lines",
  circle: "Circles",
  arc: "Arcs",
  ellipse: "Ellipses",
  spline: "Splines",
  hatch: "Hatches",
  insert: "Blocks",
  polyline: "Polylines",
  point: "Points",
  text: "Text",
  image: "Images",
  dimension: "Dimensions",
  mtext: "Multiline text",
};

type Tri = "any" | "yes" | "no";

export function SelectByPopover() {
  const revision = useApp((s) => s.revision);
  const setSelection = useApp((s) => s.setSelection);
  const [open, setOpen] = useState(false);
  const [types, setTypes] = useState<Set<Entity["type"]>>(() => new Set());
  const [layers, setLayers] = useState<Set<string>>(() => new Set());
  const [colors, setColors] = useState<Set<string>>(() => new Set());
  const [construction, setConstruction] = useState<Tri>("any");
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (matchesBinding(e, "edit.selectBy")) {
        e.preventDefault();
        setOpen((v) => !v);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpen(false);
        e.stopPropagation();
      }
    };
    window.addEventListener("pointerdown", onDown, true);
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("pointerdown", onDown, true);
      window.removeEventListener("keydown", onKey, true);
    };
  }, [open]);

  // What the drawing actually contains, recomputed as it changes.
  const present = useMemo(() => {
    const t = new Set<Entity["type"]>();
    const l = new Set<string>();
    const c = new Set<string>();
    for (const e of doc.all()) {
      t.add(e.type);
      l.add(layerOf(e));
      const col = colorOf(e);
      if (col) c.add(col);
    }
    return { types: [...t], layers: [...l], colors: [...c] };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [revision, open]);

  // "The theme default" is a real, selectable colour — an entity with no
  // colour of its own — so it gets its own row rather than being invisible.
  const filter: SelectFilter = {
    types: [...types],
    layers: [...layers],
    colors: [...colors].map((c) => (c === "default" ? null : c)),
    construction: construction === "any" ? undefined : construction === "yes",
  };
  const matches = open ? selectMatching(selectableEntities(), filter) : [];

  const toggleIn = <T,>(set: Set<T>, value: T, apply: (next: Set<T>) => void) => {
    const next = new Set(set);
    if (next.has(value)) next.delete(value);
    else next.add(value);
    apply(next);
  };

  const clear = () => {
    setTypes(new Set());
    setLayers(new Set());
    setColors(new Set());
    setConstruction("any");
  };

  return (
    <div className="snap-popover-wrap" ref={ref}>
      <button
        className="tracking-toggle"
        title="Select by type, layer or colour (Quick Select)"
        data-testid="toggle-select-by"
        onClick={() => setOpen((v) => !v)}
      >
        SELECT
      </button>
      {open && (
        <div className="snap-popover select-by" data-testid="select-by-popover">
          <div className="snap-popover-head">
            <span>Select by</span>
            <button className="btn ghost sm" onClick={clear}>
              Clear
            </button>
          </div>

          <div className="select-by-group">Type</div>
          {present.types.map((t) => (
            <label key={t} className="snap-popover-row">
              <input type="checkbox" checked={types.has(t)} onChange={() => toggleIn(types, t, setTypes)} data-testid={`select-by-type-${t}`} />
              <span>{TYPE_LABELS[t]}</span>
            </label>
          ))}

          {present.layers.length > 1 && (
            <>
              <div className="select-by-group">Layer</div>
              {present.layers.map((l) => (
                <label key={l} className="snap-popover-row">
                  <input type="checkbox" checked={layers.has(l)} onChange={() => toggleIn(layers, l, setLayers)} />
                  <span>{l}</span>
                </label>
              ))}
            </>
          )}

          {present.colors.length > 0 && (
            <>
              <div className="select-by-group">Colour</div>
              {["default", ...present.colors].map((c) => (
                <label key={c} className="snap-popover-row">
                  <input type="checkbox" checked={colors.has(c)} onChange={() => toggleIn(colors, c, setColors)} />
                  {c !== "default" && <span className="select-by-swatch" style={{ background: c }} />}
                  <span>{c === "default" ? "Default" : c}</span>
                </label>
              ))}
            </>
          )}

          <div className="select-by-group">Construction</div>
          <div className="select-by-tri">
            {(["any", "yes", "no"] as Tri[]).map((v) => (
              <button
                key={v}
                className={`btn ghost sm ${construction === v ? "active" : ""}`}
                onClick={() => setConstruction(v)}
              >
                {v === "any" ? "Any" : v === "yes" ? "Only" : "Never"}
              </button>
            ))}
          </div>

          <button
            className="btn sm select-by-apply"
            data-testid="select-by-apply"
            disabled={matches.length === 0}
            onClick={() => {
              setSelection(matches);
              setOpen(false);
            }}
          >
            Select {matches.length}
          </button>
        </div>
      )}
    </div>
  );
}
