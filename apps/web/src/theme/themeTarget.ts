import { builtinTheme } from "@sketchor/core";

/**
 * TH-05/TH-07: the pure half of `/app?theme=…` — the theme gallery's
 * "Open in Sketchor" link (kept free of the store so it tests in node).
 *
 * - `dark` / `light` / a shipped theme's id switch to it: nothing to install.
 * - An http(s) URL, or a path on the app's own site (`/themes/…`), names a
 *   theme file to fetch; it is installed only after the user confirms.
 */
export type ThemeTarget =
  | { kind: "setting"; setting: "dark" | "light" | `builtin:${string}`; name: string }
  | { kind: "url"; url: string; name: string };

export function themeTarget(search: string, origin: string): ThemeTarget | null {
  const raw = new URLSearchParams(search).get("theme")?.trim();
  if (!raw) return null;
  if (raw === "dark" || raw === "light") return { kind: "setting", setting: raw, name: raw === "dark" ? "Dark" : "Light" };
  const shipped = builtinTheme(raw);
  if (shipped) return { kind: "setting", setting: `builtin:${shipped.id}`, name: shipped.name };
  let u: URL;
  try {
    // A path resolves against the app's own origin only; "//host" or "\\host" would leave it.
    if (raw.startsWith("/") && !raw.startsWith("//") && !raw.includes("\\")) u = new URL(raw, origin);
    else u = new URL(raw);
  } catch {
    return null;
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") return null;
  const file = decodeURIComponent(u.pathname.split("/").pop() ?? "");
  if (!/\.json$/i.test(file)) return null;
  return { kind: "url", url: u.href, name: file };
}

/** The page's query string without `theme`, so a reload doesn't ask again. */
export function withoutThemeParam(search: string): string {
  const p = new URLSearchParams(search);
  p.delete("theme");
  const s = p.toString();
  return s ? `?${s}` : "";
}
