import { useEffect, useRef, useState } from "react";
import { newEntityId } from "@sketchor/core";
import { bus, doc, useApp } from "../state/store";
import { nextEntityName } from "@sketchor/core";
import { htmlToMtext, mtextToHtml } from "./domCodec";
import { useMTextUi } from "./mtextUi";

/**
 * The MTEXT rich editor (D-04): a contentEditable surface with a toolbar
 * (bold/italic/underline/strike, colour, stacked fractions, bullets, numbered
 * lines, symbols) over the MTEXT codes - `domCodec.ts` converts both ways, so
 * what you edit is what `parseMtext` lays out. OK is one `add-entity` /
 * `update-entity` (one undo step). Ctrl+Enter confirms, Esc cancels.
 */

const SYMBOLS = ["Ø", "±", "°", "≈", "≤", "≥", "△", "⌀", "⌴", "⌵", "⏥", "☐", "²", "³", "α", "β", "μ", "Ω"];

const btn: React.CSSProperties = { minWidth: 28, height: 26, padding: "0 6px", border: "1px solid var(--border)", borderRadius: 4, background: "var(--bg)", color: "var(--text)", cursor: "pointer" };
const field: React.CSSProperties = { width: 64, height: 24, background: "var(--bg)", color: "var(--text)", border: "1px solid var(--border)", borderRadius: 4, padding: "0 4px" };

export function MTextEditor() {
  const draft = useMTextUi((s) => s.draft);
  const close = useMTextUi((s) => s.close);
  if (!draft) return null;
  return <Editor key={draft.id ?? "new"} draft={draft} close={close} />;
}

function Editor({ draft, close }: { draft: NonNullable<ReturnType<typeof useMTextUi.getState>["draft"]>; close: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(draft.width);
  const [height, setHeight] = useState(draft.height);
  const [attachment, setAttachment] = useState(draft.attachment);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.innerHTML = draft.text ? mtextToHtml(draft.text) : "<div><br></div>";
    try {
      document.execCommand("styleWithCSS", false, "true");
    } catch {
      /* not supported: the codec reads <b>/<font> too */
    }
    el.focus();
  }, [draft]);

  const cmd = (name: string, value?: string) => {
    ref.current?.focus();
    document.execCommand(name, false, value);
  };

  /** The block (direct child of the editor) holding the caret. */
  const caretBlock = (): HTMLElement | null => {
    const sel = window.getSelection();
    let n: Node | null = sel?.anchorNode ?? null;
    while (n && n.parentNode !== ref.current) n = n.parentNode;
    return n instanceof HTMLElement ? n : null;
  };

  const prefix = (make: (index: number) => string) => {
    const b = caretBlock();
    const root = ref.current;
    if (!b || !root) return;
    const index = Array.prototype.indexOf.call(root.children, b) + 1;
    b.insertBefore(document.createTextNode(make(index)), b.firstChild);
  };

  const stack = () => {
    const sel = window.getSelection();
    const text = sel?.toString() ?? "";
    const m = /^(.*?)([/#^])(.*)$/.exec(text);
    if (!m || !sel || sel.rangeCount === 0) return;
    const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");
    cmd("insertHTML", `<span class="mt-stack" contenteditable="false" data-top="${esc(m[1])}" data-bottom="${esc(m[3])}" data-bar="${m[2]}">${esc(m[1])}${m[2]}${esc(m[3])}</span>`);
  };

  const ok = () => {
    const el = ref.current;
    if (!el) return;
    const code = htmlToMtext(el);
    const isBlank = code.replace(/\\P/g, "").trim() === "";
    const w = Math.max(0, width);
    const h = height > 0 ? height : draft.height;
    if (draft.id) {
      const cur = doc.get(draft.id);
      if (cur && cur.type === "mtext") {
        if (isBlank) bus.execute({ type: "delete-entities", ids: [draft.id] });
        else bus.execute({ type: "update-entity", entity: { ...cur, text: code, width: w, height: h, attachment } });
      }
    } else if (!isBlank) {
      bus.execute({
        type: "add-entity",
        entity: {
          id: newEntityId(),
          type: "mtext",
          name: nextEntityName(doc, "mtext"),
          layer: useApp.getState().activeLayer,
          at: draft.at,
          width: w,
          attachment,
          text: code,
          height: h,
          rotation: draft.rotation,
        },
      });
    }
    close();
  };

  return (
    <div className="cmdpalette-backdrop" onMouseDown={close} data-testid="mtext-editor">
      <div
        className="shortcuts-panel"
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === "Escape") close();
          else if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) ok();
        }}
        style={{ width: "min(640px, 94vw)" }}
      >
        <div className="shortcuts-panel-head">
          <h2>{draft.id ? "Edit multiline text" : "Multiline text"}</h2>
          <button className="shortcuts-panel-close" onClick={close} aria-label="Close">
            &#10005;
          </button>
        </div>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 6, padding: "8px 12px", alignItems: "center" }}>
          <button style={{ ...btn, fontWeight: "bold" }} title="Bold" onMouseDown={(e) => e.preventDefault()} onClick={() => cmd("bold")} data-testid="mtext-bold">B</button>
          <button style={{ ...btn, fontStyle: "italic" }} title="Italic" onMouseDown={(e) => e.preventDefault()} onClick={() => cmd("italic")} data-testid="mtext-italic">I</button>
          <button style={{ ...btn, textDecoration: "underline" }} title="Underline" onMouseDown={(e) => e.preventDefault()} onClick={() => cmd("underline")} data-testid="mtext-underline">U</button>
          <button style={{ ...btn, textDecoration: "line-through" }} title="Strikethrough" onMouseDown={(e) => e.preventDefault()} onClick={() => cmd("strikeThrough")} data-testid="mtext-strike">S</button>
          <input type="color" title="Text colour" defaultValue="#ff0000" style={{ width: 30, height: 26, padding: 0 }} onChange={(e) => cmd("foreColor", e.target.value)} />
          <button style={btn} title="Stack the selected text: 1/2 (fraction), 1#2 (diagonal), 1^2 (tolerance)" onMouseDown={(e) => e.preventDefault()} onClick={stack} data-testid="mtext-stack">a/b</button>
          <button style={btn} title="Bulleted line" onMouseDown={(e) => e.preventDefault()} onClick={() => prefix(() => "• ")} data-testid="mtext-bullet">&bull;</button>
          <button style={btn} title="Numbered line" onMouseDown={(e) => e.preventDefault()} onClick={() => prefix((i) => `${i}. `)} data-testid="mtext-number">1.</button>
          <select
            style={{ ...field, width: 64 }}
            value=""
            title="Symbols"
            onChange={(e) => e.target.value && cmd("insertText", e.target.value)}
            data-testid="mtext-symbols"
          >
            <option value="">Symbol</option>
            {SYMBOLS.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </div>
        <div
          ref={ref}
          contentEditable
          suppressContentEditableWarning
          spellCheck={false}
          data-testid="mtext-surface"
          style={{ minHeight: 140, maxHeight: "40vh", overflow: "auto", margin: "0 12px", padding: 8, border: "1px solid var(--border)", borderRadius: 4, background: "var(--canvas-bg)", color: "var(--text)", userSelect: "text", outline: "none" }}
        />
        <div style={{ display: "flex", flexWrap: "wrap", gap: 10, padding: "10px 12px", alignItems: "center" }}>
          <label>
            Height <input style={field} type="number" min={0} step="any" value={height} onChange={(e) => setHeight(Number(e.target.value))} data-testid="mtext-height" />
          </label>
          <label>
            Width (0 = no wrap) <input style={field} type="number" min={0} step="any" value={width} onChange={(e) => setWidth(Number(e.target.value))} data-testid="mtext-width" />
          </label>
          <label>
            Attach{" "}
            <select style={{ ...field, width: 110 }} value={attachment} onChange={(e) => setAttachment(Number(e.target.value))} data-testid="mtext-attachment">
              {["Top left", "Top center", "Top right", "Middle left", "Middle center", "Middle right", "Bottom left", "Bottom center", "Bottom right"].map((n, i) => (
                <option key={n} value={i + 1}>
                  {n}
                </option>
              ))}
            </select>
          </label>
          <span style={{ flex: 1 }} />
          <button style={btn} onClick={close}>Cancel</button>
          <button style={{ ...btn, background: "var(--accent)", color: "#fff" }} onClick={ok} data-testid="mtext-ok">OK</button>
        </div>
      </div>
    </div>
  );
}
