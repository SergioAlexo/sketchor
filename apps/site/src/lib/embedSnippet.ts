/**
 * E-09: the copy-paste snippets the /embed configurator shows. Pure so the
 * three forms (script tag, auto-upgrade link, iframe) can't drift from what
 * the element and the iframe endpoint actually accept.
 */
import { frameAttrs, frameUrl, SITE } from "./embedFrame";

export const SCRIPT_URL = `${SITE}/embed/sketchor-embed.js`;

export type SnippetMode = "element" | "auto" | "iframe";

/** Configurator state: attribute → value; "" means a boolean attribute that is on, undefined/absent means default. */
export type EmbedOptions = Record<string, string | undefined> & { src: string };

/** Defaults the snippet leaves out, so it shows only what the user changed. */
const DEFAULTS: Record<string, string> = { motion: "turntable", theme: "auto", controls: "minimal", logo: "on" };

const escapeAttr = (s: string): string => s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");

/** Attributes that differ from the defaults, in a stable, readable order. */
export function changedAttrs(opts: EmbedOptions): [string, string][] {
  const order = ["src", "autoplay", "motion", "theme", "background", "controls", "logo", "label"];
  const out: [string, string][] = [];
  for (const k of order) {
    const v = opts[k];
    if (v === undefined || (k !== "src" && DEFAULTS[k] === v)) continue;
    if (k === "label" && !v) continue;
    out.push([k, v]);
  }
  return out;
}

const attrText = ([k, v]: [string, string]): string => (v === "" ? k : `${k}="${escapeAttr(v)}"`);

export function embedSnippet(mode: SnippetMode, opts: EmbedOptions): string {
  const attrs = changedAttrs(opts);
  if (mode === "iframe") {
    const r = frameAttrs(Object.fromEntries(attrs.map(([k, v]) => [k, k === "autoplay" ? "1" : v])));
    if (!r.ok) return `<!-- ${r.error} -->`;
    return `<iframe src="${escapeAttr(frameUrl(r.attrs))}"\n  width="640" height="480" style="border:0;border-radius:12px"\n  allow="fullscreen" allowfullscreen></iframe>`;
  }
  const script = `<script type="module"\n  src="${SCRIPT_URL}"${mode === "auto" ? " data-auto" : ""}></script>`;
  if (mode === "auto") {
    const pass = attrs.filter(([k]) => k !== "src" && k !== "label").map(([k, v]) => attrText([`data-sketchor-${k}`, v]));
    const label = opts.label || "My part";
    return `${script}\n\n<a href="${escapeAttr(opts.src)}" data-sketchor${pass.length ? " " + pass.join(" ") : ""}>${escapeAttr(label)}</a>`;
  }
  return `${script}\n\n<sketchor-view ${attrs.map(attrText).join(" ")}></sketchor-view>`;
}
