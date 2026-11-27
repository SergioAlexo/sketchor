import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * TH-07: what the `/themes` gallery shows. Theme files live in `public/` so
 * they download as they are and the app and the embed can fetch them:
 *
 *   public/themes/<id>.sketchor-theme.json            the themes Sketchor ships
 *   public/themes/community/<id>.sketchor-theme.json  submitted by pull request
 *
 * The shipped copies are checked against `@sketchor/core` by
 * `themes.test.ts`, which also runs the app's own validator over every
 * community file — the gallery itself only needs the summary below and stays
 * free of core.
 */

export type ThemeSource = "builtin" | "community";

export interface GalleryTheme {
  id: string;
  name: string;
  author?: string;
  base: "dark" | "light";
  source: ThemeSource;
  /** Public path of the file to download; null for Dark and Light, which are the defaults rather than files. */
  file: string | null;
  /** The `theme` value for `<sketchor-view>` and for `/app?theme=`. */
  ref: string;
  /** A few of the theme's own colours, in the order shown on the card. */
  swatches: string[];
}

/** Dark and Light: the app's defaults, shown first. Their swatches are the default tokens' (kept in step by themes.test.ts). */
export const DEFAULT_THEMES: readonly GalleryTheme[] = [
  { id: "dark", name: "Dark", author: "Sketchor", base: "dark", source: "builtin", file: null, ref: "dark", swatches: ["#1e2025", "#3574f0", "#17181c", "#e8e9ec", "#5b96ff"] },
  { id: "light", name: "Light", author: "Sketchor", base: "light", source: "builtin", file: null, ref: "light", swatches: ["#f3f4f6", "#2f63d6", "#fbfbfc", "#202329", "#2f63d6"] },
];

const ID = /^[a-z0-9][a-z0-9-]{0,47}$/;
/** A colour as a theme file may write it: hex, rgb/hsl functions or a CSS name — nothing that could become markup or a URL. */
const COLOR = /^(#[0-9a-f]{3,8}|(rgb|rgba|hsl|hsla)\([0-9.,%\s/+-]+\)|[a-z]{3,24})$/i;

const str = (v: unknown, max = 80): string | undefined => (typeof v === "string" && v.trim() && v.length <= max ? v.trim() : undefined);
const color = (v: unknown): string | undefined => (typeof v === "string" && COLOR.test(v.trim()) ? v.trim() : undefined);

/**
 * A card for one theme file, or null when it doesn't look like one. This is
 * a summary for display, not the gate: the app validates a theme fully
 * before installing it.
 */
export function summarizeTheme(json: unknown, source: ThemeSource, file: string): GalleryTheme | null {
  if (!json || typeof json !== "object") return null;
  const t = json as Record<string, unknown>;
  const id = str(t.id, 48);
  const name = str(t.name, 60);
  if (!id || !ID.test(id) || !name || (t.base !== "dark" && t.base !== "light")) return null;
  const tokens = (t.tokens && typeof t.tokens === "object" ? t.tokens : {}) as Record<string, Record<string, unknown> | undefined>;
  const ui = tokens.ui ?? {};
  const canvas = tokens.canvas ?? {};
  const swatches = [ui.bg, ui.accent, canvas.bg, canvas.entity, canvas.selected].map(color).filter((c): c is string => !!c);
  return {
    id,
    name,
    author: str(t.author, 60),
    base: t.base,
    source,
    file,
    // Shipped themes go by id (the app and the embed know them); community ones by their path on this site.
    ref: source === "builtin" ? id : file,
    swatches,
  };
}

async function readThemesIn(dir: string, publicPath: string, source: ThemeSource): Promise<GalleryTheme[]> {
  let names: string[];
  try {
    names = (await readdir(dir)).filter((n) => n.endsWith(".sketchor-theme.json")).sort();
  } catch {
    return [];
  }
  const out: GalleryTheme[] = [];
  for (const n of names) {
    try {
      const card = summarizeTheme(JSON.parse(await readFile(join(dir, n), "utf8")), source, `${publicPath}/${n}`);
      if (card) out.push(card);
    } catch {
      // a malformed file is left out of the gallery; themes.test.ts names it
    }
  }
  return out;
}

/** Every theme the gallery shows: the defaults, the shipped themes, then community submissions by name. */
export async function galleryThemes(root = join(process.cwd(), "public", "themes")): Promise<GalleryTheme[]> {
  const shipped = await readThemesIn(root, "/themes", "builtin");
  const community = await readThemesIn(join(root, "community"), "/themes/community", "community");
  const byName = (a: GalleryTheme, b: GalleryTheme) => a.name.localeCompare(b.name);
  return [...DEFAULT_THEMES, ...shipped, ...community.sort(byName)];
}
