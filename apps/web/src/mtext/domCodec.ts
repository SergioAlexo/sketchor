import { parseMtext, serializeMtext, type MFmt, type MParagraph, type MRun } from "@sketchor/core";

/**
 * D-04: the rich editor's contentEditable <-> MTEXT codes bridge. The DOM is
 * only a view: `mtextToHtml` renders the parsed runs, `htmlToMtext` reads
 * whatever the browser's editing commands produced (`<b>`, `<span style>`,
 * `<font color>`, `<div>` lines, `<br>`) back into runs and codes.
 */

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** `#rrggbb` for a stored colour; ACI index colours get no CSS (they follow the entity colour). */
const cssColor = (c?: string) => (c && c.startsWith("#") ? c : undefined);

export function mtextToHtml(code: string): string {
  return parseMtext(code)
    .map((p) => {
      const inner = p.runs
        .map((r) => {
          if (r.kind === "tab") return "&emsp;";
          const style = [
            r.fmt.bold ? "font-weight:bold" : "",
            r.fmt.italic ? "font-style:italic" : "",
            [r.fmt.underline ? "underline" : "", r.fmt.overline ? "overline" : "", r.fmt.strike ? "line-through" : ""].filter(Boolean).join(" ")
              ? `text-decoration:${[r.fmt.underline ? "underline" : "", r.fmt.overline ? "overline" : "", r.fmt.strike ? "line-through" : ""].filter(Boolean).join(" ")}`
              : "",
            cssColor(r.fmt.color) ? `color:${cssColor(r.fmt.color)}` : "",
          ]
            .filter(Boolean)
            .join(";");
          if (r.kind === "stack") {
            return `<span class="mt-stack" contenteditable="false" data-top="${esc(r.top)}" data-bottom="${esc(r.bottom)}" data-bar="${r.bar}"${style ? ` style="${style}"` : ""}>${esc(r.top)}${r.bar}${esc(r.bottom)}</span>`;
          }
          const t = esc(r.text);
          return style ? `<span style="${style}">${t}</span>` : t;
        })
        .join("");
      return `<div>${inner || "<br>"}</div>`;
    })
    .join("");
}

function hexOf(css: string): string | undefined {
  const m = /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/.exec(css.trim());
  if (m) return "#" + [m[1], m[2], m[3]].map((n) => Number(n).toString(16).padStart(2, "0")).join("");
  const h = /^#([0-9a-f]{6})$/i.exec(css.trim());
  if (h) return "#" + h[1].toLowerCase();
  const s = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/i.exec(css.trim());
  return s ? `#${s[1]}${s[1]}${s[2]}${s[2]}${s[3]}${s[3]}`.toLowerCase() : undefined;
}

const BLOCKS = new Set(["DIV", "P", "LI", "UL", "OL", "H1", "H2", "H3"]);

/** Reads an editor root back into paragraphs of runs. */
export function htmlToParagraphs(root: Node): MParagraph[] {
  const paras: MParagraph[] = [];
  let cur: MRun[] = [];
  let open = false;
  const endLine = () => {
    paras.push({ runs: cur });
    cur = [];
    open = false;
  };
  const push = (text: string, fmt: MFmt) => {
    const last = cur[cur.length - 1];
    if (last && last.kind === "text" && JSON.stringify(last.fmt) === JSON.stringify(fmt)) last.text += text;
    else cur.push({ kind: "text", text, fmt: { ...fmt } });
    open = true;
  };
  const visit = (node: Node, fmt: MFmt) => {
    if (node.nodeType === 3) {
      const t = (node.nodeValue ?? "").replace(/​/g, "").replace(/ /g, " ").replace(/\r?\n/g, " ");
      if (t) push(t, fmt);
      return;
    }
    if (node.nodeType !== 1) return;
    const el = node as HTMLElement;
    const tag = el.tagName;
    if (tag === "BR") {
      endLine();
      return;
    }
    if (el.classList?.contains("mt-stack")) {
      const bar = (el.dataset.bar ?? "/") as "/" | "#" | "^";
      cur.push({ kind: "stack", top: el.dataset.top ?? "", bottom: el.dataset.bottom ?? "", bar, fmt: { ...fmt } });
      open = true;
      return;
    }
    const next: MFmt = { ...fmt };
    if (tag === "B" || tag === "STRONG") next.bold = true;
    if (tag === "I" || tag === "EM") next.italic = true;
    if (tag === "U") next.underline = true;
    if (tag === "S" || tag === "STRIKE" || tag === "DEL") next.strike = true;
    if (tag === "FONT" && el.getAttribute("color")) next.color = hexOf(el.getAttribute("color")!) ?? next.color;
    const st = el.style;
    if (st) {
      if (st.fontWeight === "bold" || Number(st.fontWeight) >= 600) next.bold = true;
      if (st.fontStyle === "italic") next.italic = true;
      const td = st.textDecorationLine || st.textDecoration || "";
      if (td.includes("underline")) next.underline = true;
      if (td.includes("overline")) next.overline = true;
      if (td.includes("line-through")) next.strike = true;
      if (st.color) next.color = hexOf(st.color) ?? next.color;
    }
    const block = BLOCKS.has(tag);
    if (block && open) endLine();
    el.childNodes.forEach((c) => visit(c, next));
    if (block && open) endLine();
  };
  root.childNodes.forEach((c) => visit(c, {}));
  if (open || paras.length === 0) endLine();
  return paras;
}

/** The MTEXT codes for an editor root. */
export function htmlToMtext(root: Node): string {
  return serializeMtext(htmlToParagraphs(root));
}
