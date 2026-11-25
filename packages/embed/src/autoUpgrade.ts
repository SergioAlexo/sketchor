/**
 * E-02 auto-upgrade mode: "connect Sketchor to any website" with one
 * attribute per file instead of new markup.
 *
 *   <script type="module" src=".../sketchor-embed.js" data-auto></script>
 *   <a href="/files/bracket.glb" data-sketchor>Bracket</a>
 *   <img src="/img/bracket.png" data-sketchor-src="/files/bracket.glb" alt="Bracket">
 *
 * Each marked link / image is replaced by a `<sketchor-view>` for the same
 * file. `data-sketchor-<attribute>` on the original passes element attributes
 * through (`data-sketchor-motion="none"`, `data-sketchor-autoplay`). A link to
 * a file the preview can't name a format for is left alone, so a page never
 * loses a working download link to an error card it didn't ask for.
 *
 * `upgradePlan` is the pure decision (tested); `upgrade` applies it to a DOM.
 */
import { DRAWING_FORMATS, extensionOf, PREVIEW_FORMATS } from "./load";

/** `<sketchor-view>` attributes a `data-sketchor-*` attribute may set. */
export const PASSTHROUGH = [
  "format",
  "autoplay",
  "motion",
  "background",
  "controls",
  "full-url",
  "logo",
  "up",
  "max-size",
  "loading",
  "label",
  "theme",
] as const;

/** Presentation attributes carried over so the preview takes the original's place in the layout. */
const KEEP = ["id", "class", "style", "width", "height", "title"] as const;

/** Extensions worth upgrading: previewable meshes and drawings, plus what shows the "opens in Sketchor" card. */
const KNOWN = new Set<string>([...PREVIEW_FORMATS, ...DRAWING_FORMATS, "step", "stp", "iges", "igs", "brep", "3dm", "dwg"]);

export interface UpgradeSource {
  /** Lower-case tag name. */
  tag: string;
  /** Every attribute on the element, by name. */
  attrs: Record<string, string>;
  /** Resolved (absolute) href, for links. */
  href?: string;
  /** Visible text, for links. */
  text?: string;
}

export interface UpgradePlan {
  src: string;
  attrs: Record<string, string>;
}

export function upgradePlan(el: UpgradeSource): UpgradePlan | null {
  const a = el.attrs;
  if ("data-sketchor-upgraded" in a) return null;
  let src: string | undefined;
  let label: string | undefined;
  if (el.tag === "a" && "data-sketchor" in a) {
    src = el.href || a.href;
    label = a["data-sketchor-label"] || el.text?.trim() || a.title;
  } else if (el.tag === "img" && a["data-sketchor-src"]) {
    src = a["data-sketchor-src"];
    label = a["data-sketchor-label"] || a.alt;
  }
  if (!src) return null;
  const forced = a["data-sketchor-format"];
  if (!forced && !KNOWN.has(extensionOf(src))) return null;

  const attrs: Record<string, string> = {};
  for (const k of KEEP) if (a[k] !== undefined) attrs[k] = a[k];
  for (const k of PASSTHROUGH) {
    const v = a[`data-sketchor-${k}`];
    if (v !== undefined) attrs[k] = v;
  }
  if (label && attrs.label === undefined) attrs.label = label;
  // An <img> has intrinsic size; keep its box when the page gave it one.
  if (el.tag === "img" && attrs.width && attrs.height && !attrs.style) attrs.style = `width:${px(attrs.width)};height:${px(attrs.height)};aspect-ratio:auto`;
  return { src, attrs };
}

const px = (v: string): string => (/^\d+(\.\d+)?$/.test(v) ? `${v}px` : v);

const SELECTOR = "a[data-sketchor], img[data-sketchor-src]";

function sourceOf(el: Element): UpgradeSource {
  const attrs: Record<string, string> = {};
  for (const at of Array.from(el.attributes)) attrs[at.name] = at.value;
  const tag = el.tagName.toLowerCase();
  return tag === "a" ? { tag, attrs, href: (el as HTMLAnchorElement).href, text: el.textContent ?? "" } : { tag, attrs };
}

/** Replaces every marked link / image under `root` with a preview. Returns how many were upgraded. */
export function upgrade(root: ParentNode = document): number {
  let n = 0;
  const candidates = [...(root instanceof Element && root.matches(SELECTOR) ? [root] : []), ...Array.from(root.querySelectorAll(SELECTOR))];
  for (const el of candidates) {
    const plan = upgradePlan(sourceOf(el));
    if (!plan) {
      el.setAttribute("data-sketchor-upgraded", "skipped");
      continue;
    }
    const view = document.createElement("sketchor-view");
    for (const [k, v] of Object.entries(plan.attrs)) view.setAttribute(k, v);
    view.setAttribute("src", plan.src);
    el.replaceWith(view);
    n++;
  }
  return n;
}

let observer: MutationObserver | null = null;

/** Upgrades the page now and anything added later (client-rendered pages, infinite scroll). */
export function autoUpgrade(): void {
  const run = () => {
    upgrade(document);
    if (observer || typeof MutationObserver === "undefined") return;
    observer = new MutationObserver((records) => {
      for (const r of records) for (const node of Array.from(r.addedNodes)) if (node instanceof Element) upgrade(node);
    });
    observer.observe(document.documentElement, { childList: true, subtree: true });
  };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", run, { once: true });
  else run();
}

/**
 * Whether the page asked for auto-upgrade: a `<script data-auto>` that loaded
 * this file (module scripts have no `document.currentScript`, so it's found by
 * name), or `<html data-sketchor-auto>`.
 */
export function pageWantsAutoUpgrade(): boolean {
  if (typeof document === "undefined") return false;
  if (document.documentElement.hasAttribute("data-sketchor-auto")) return true;
  return Array.from(document.querySelectorAll<HTMLScriptElement>("script[data-auto][src]")).some((s) => /sketchor-embed/i.test(s.src));
}
