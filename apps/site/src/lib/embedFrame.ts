/**
 * E-02 iframe endpoint + oEmbed, the pure half (tested in embedFrame.test.ts).
 *
 *   https://sketchor.sergioalexo.com/embed?src=<file URL>&motion=none&theme=light
 *
 * is a full-bleed `<sketchor-view>` for CMSs that strip <script>, and
 *
 *   https://sketchor.sergioalexo.com/oembed?url=<that page, a /app?open= link, or a model URL>
 *
 * answers oEmbed (type "rich") so Notion / WordPress / Discourse can turn a
 * pasted link into that iframe. Every query value is untrusted: it becomes an
 * element attribute (React escapes it, but a `javascript:` src or a CSS
 * string in `background` is still wrong), so each one is checked against what
 * the element accepts and anything else is dropped.
 */

export const SITE = "https://sketchor.sergioalexo.com";

/** Formats the embed draws. A link to anything else isn't offered as an oEmbed. */
const PREVIEW_EXT = new Set(["stl", "obj", "ply", "3mf", "gltf", "glb"]);

type Check = (v: string) => string | null;

const oneOf =
  (...allowed: string[]): Check =>
  (v) => {
    const l = v.trim().toLowerCase();
    return allowed.includes(l) ? l : null;
  };

/** http(s) URL, absolute or relative to the site (the iframe has no host page to resolve against). */
export function safeUrl(v: string): string | null {
  try {
    const u = new URL(v.trim(), SITE);
    return u.protocol === "https:" || u.protocol === "http:" ? u.href : null;
  } catch {
    return null;
  }
}

const COLOR = /^(#[0-9a-f]{3,8}|[a-z]{3,20}|(rgb|hsl)a?\(\s*[-\d.]+(deg)?%?(\s*[,\s/]\s*[-\d.]+%?){2,3}\s*\))$/i;

const CHECKS: Record<string, Check> = {
  motion: oneOf("turntable", "float", "draw", "none"),
  controls: oneOf("minimal", "none"),
  logo: oneOf("on", "off"),
  up: oneOf("auto", "y", "z"),
  loading: oneOf("lazy", "eager"),
  autoplay: (v) => (["", "1", "true", "yes", "on", "autoplay"].includes(v.trim().toLowerCase()) ? "" : null),
  background: (v) => (COLOR.test(v.trim()) ? v.trim() : null),
  format: (v) => (/^[a-z0-9]{1,8}$/i.test(v.trim()) ? v.trim().toLowerCase() : null),
  "max-size": (v) => (/^\d{1,4}$/.test(v.trim()) ? v.trim() : null),
  label: (v) => {
    const t = v.replace(/[\u0000-\u001f]/g, "").trim();
    return t ? t.slice(0, 200) : null;
  },
  theme: (v) => {
    const t = v.trim();
    if (/^[a-z0-9][a-z0-9-]{0,40}$/i.test(t)) return t.toLowerCase(); // auto/dark/light or a built-in id
    return safeUrl(t);
  },
  "fit-padding": (v) => (/^\s*\d*\.?\d+\s*%?\s*$/.test(v) ? v.trim() : null),
  // Layer names from the file: printable text only, comma-separated, kept short.
  layers: (v) => {
    const t = v.replace(/[\u0000-\u001f<>"]/g, "").trim();
    return t ? t.slice(0, 300) : null;
  },
  "full-url": (v) => {
    const t = v.trim().toLowerCase();
    return t === "auto" || t === "none" ? t : safeUrl(v);
  },
};

/** Query parameters the iframe endpoint passes to the element, in a stable order. */
export const FRAME_PARAMS = ["src", ...Object.keys(CHECKS)] as const;

export type FrameAttrs = Record<string, string> & { src: string };

export type FrameResult = { ok: true; attrs: FrameAttrs } | { ok: false; error: string };

export function frameAttrs(params: Record<string, string | string[] | undefined>): FrameResult {
  const get = (k: string): string | undefined => {
    const v = params[k];
    return Array.isArray(v) ? v[0] : v;
  };
  const rawSrc = get("src");
  if (!rawSrc) return { ok: false, error: "missing src" };
  const src = safeUrl(rawSrc);
  if (!src) return { ok: false, error: "src must be an http(s) URL" };
  const attrs: FrameAttrs = { src };
  for (const [k, check] of Object.entries(CHECKS)) {
    const v = get(k);
    if (v === undefined) continue;
    const ok = check(v);
    if (ok !== null) attrs[k] = ok;
  }
  return { ok: true, attrs };
}

/** The iframe endpoint URL for these attributes. */
export function frameUrl(attrs: FrameAttrs): string {
  const q = new URLSearchParams();
  for (const k of FRAME_PARAMS) if (attrs[k] !== undefined) q.set(k, attrs[k]);
  return `${SITE}/embed?${q.toString()}`;
}

function extensionOf(url: string): string {
  try {
    const last = new URL(url).pathname.split("/").pop() ?? "";
    const dot = last.lastIndexOf(".");
    return dot > 0 ? last.slice(dot + 1).toLowerCase() : "";
  } catch {
    return "";
  }
}

function nameOf(url: string): string {
  try {
    return decodeURIComponent(new URL(url).pathname.split("/").pop() ?? "") || "3D model";
  } catch {
    return "3D model";
  }
}

/**
 * Which embed a pasted URL means: one of our own /embed pages (its settings
 * kept), a /app?open= link, or a model file the embed can draw. null = not ours.
 */
export function attrsForPastedUrl(url: string): FrameAttrs | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (u.origin === SITE && (u.pathname === "/embed" || u.pathname === "/embed/")) {
    const r = frameAttrs(Object.fromEntries(u.searchParams));
    return r.ok ? r.attrs : null;
  }
  if (u.origin === SITE && (u.pathname === "/app" || u.pathname === "/app/")) {
    const open = u.searchParams.get("open");
    const src = open ? safeUrl(open) : null;
    return src && PREVIEW_EXT.has(extensionOf(src)) ? { src } : null;
  }
  if ((u.protocol === "https:" || u.protocol === "http:") && PREVIEW_EXT.has(extensionOf(u.href))) return { src: u.href };
  return null;
}

const escapeAttr = (s: string): string => s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export interface OEmbed {
  version: "1.0";
  type: "rich";
  provider_name: "Sketchor";
  provider_url: string;
  title: string;
  width: number;
  height: number;
  html: string;
}

const DEFAULT_W = 640;
const ASPECT = 3 / 4;

/** The oEmbed answer for a pasted URL, sized 4:3 within the consumer's max width/height. */
export function oembedFor(url: string, maxWidth?: number, maxHeight?: number): OEmbed | null {
  const attrs = attrsForPastedUrl(url);
  if (!attrs) return null;
  let w = DEFAULT_W;
  if (maxWidth && maxWidth > 0) w = Math.min(w, Math.floor(maxWidth));
  let h = Math.round(w * ASPECT);
  if (maxHeight && maxHeight > 0 && h > maxHeight) {
    h = Math.floor(maxHeight);
    w = Math.round(h / ASPECT);
  }
  const title = attrs.label ?? nameOf(attrs.src);
  const html =
    `<iframe src="${escapeAttr(frameUrl(attrs))}" width="${w}" height="${h}" title="${escapeAttr(title)}" ` +
    `style="border:0;border-radius:12px;max-width:100%" loading="lazy" allow="fullscreen" allowfullscreen></iframe>`;
  return { version: "1.0", type: "rich", provider_name: "Sketchor", provider_url: SITE, title, width: w, height: h, html };
}
