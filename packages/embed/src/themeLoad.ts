/**
 * E-07, lazy half: `theme="<built-in id>"` or `theme="<URL of a
 * .sketchor-theme.json>"`. Loaded only when an element names one, so the
 * entry stays small. A theme file is untrusted: it goes through core's TH-01
 * `validateTheme`, which admits colour values only — nothing from it can
 * become `url()`, `var()` or arbitrary CSS on the host page.
 */
import { BUILTIN_THEMES, builtinTheme } from "../../core/src/builtinThemes";
import { resolveTheme, validateTheme, type ThemeFile } from "../../core/src/themeFile";
import { embedPalette, type EmbedPalette } from "./embedTheme";

const MAX_THEME_BYTES = 64 * 1024;
const cache = new Map<string, Promise<ThemeFile>>();

export const builtinThemeIds = (): string[] => BUILTIN_THEMES.map((t) => t.id);

async function fetchTheme(url: string): Promise<ThemeFile> {
  const res = await fetch(url, { mode: "cors" });
  if (!res.ok) throw new Error(`theme could not be downloaded (HTTP ${res.status})`);
  const text = await res.text();
  if (text.length > MAX_THEME_BYTES) throw new Error("theme file is too large");
  const v = validateTheme(JSON.parse(text));
  if (!v.ok) throw new Error(`invalid theme: ${v.issues.map((i) => `${i.path} ${i.message}`).join("; ")}`);
  return v.theme;
}

/** Resolves a `theme` attribute naming a built-in theme or a theme URL (relative to `base`). */
export async function loadThemePalette(attr: string, base: string): Promise<EmbedPalette> {
  const key = attr.trim();
  const builtin = builtinTheme(key);
  let file: ThemeFile;
  if (builtin) file = builtin;
  else {
    const url = new URL(key, base).href;
    let p = cache.get(url);
    if (!p) {
      p = fetchTheme(url);
      cache.set(url, p);
      p.catch(() => cache.delete(url));
    }
    file = await p;
  }
  return embedPalette(resolveTheme(file), file.base, file.tokens.model3d?.bg ?? file.tokens.canvas?.bg);
}
