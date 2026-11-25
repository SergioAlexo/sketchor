/**
 * E-07: what colours a `<sketchor-view>` wears. Pure, so the decisions are
 * tested without a browser:
 *
 *  - `pickMode`: `theme="auto"` follows the host page's own `color-scheme`
 *    when it states one outright, else the visitor's `prefers-color-scheme`.
 *  - `embedPalette`: Sketchor theme tokens (Z-03 / TH-01) → the handful of
 *    colours the embed uses. The stage is the theme's own background when it
 *    sets one (`model3d.bg`, else `canvas.bg` — a "blueprint" theme means a
 *    blue sheet); otherwise dark keeps the app's 3D stage and light gets
 *    `ui.bg`, because the app's single dark `model3d` stage would make a
 *    "light" embed look identical to a dark one.
 *  - `paletteCss`: the palette as custom properties for the host element.
 *    They are `--sk-*`, never the public `--sketchor-*` names, so a page that
 *    sets `--sketchor-bg` or `--sketchor-accent` always wins over the theme.
 *
 * Imports the core theme module directly (not the core barrel) to stay small.
 */
import { DEFAULT_DARK, DEFAULT_LIGHT, type ThemeMode, type ThemeTokens } from "../../core/src/theme";

export interface EmbedPalette {
  mode: ThemeMode;
  /** 3D stage / element background. */
  stage: string;
  /** B-rep edge lines. */
  edge: string;
  /** E-01: a 2D drawing's sheet (theme `canvas.bg`) and default line colour (`canvas.entity`, inverting like ACI 7). */
  sheet: string;
  ink: string;
  fg: string;
  dim: string;
  /** Floating button / card fill, before translucency. */
  chrome: string;
  border: string;
  accent: string;
}

/** `theme` values handled without loading anything. */
export type BuiltinMode = "auto" | "dark" | "light";

export function pickMode(attr: string | null, hostColorScheme: string, prefersDark: boolean): ThemeMode {
  const v = (attr ?? "auto").trim().toLowerCase();
  if (v === "dark" || v === "light") return v;
  const cs = hostColorScheme.trim().toLowerCase();
  if (cs === "dark" || cs === "only dark") return "dark";
  if (cs === "light" || cs === "only light") return "light";
  return prefersDark ? "dark" : "light";
}

/** Whether `theme` needs a theme file (a built-in id or a URL) rather than a plain mode. */
export function needsThemeFile(attr: string | null): boolean {
  const v = (attr ?? "").trim().toLowerCase();
  return v !== "" && v !== "auto" && v !== "dark" && v !== "light";
}

/** `stage`: a background the theme set on purpose (see the module doc); omitted = the per-mode default. */
export function embedPalette(tokens: ThemeTokens, mode: ThemeMode, stage?: string): EmbedPalette {
  stage ??= mode === "dark" ? tokens.model3d.bg : tokens.ui.bg;
  return {
    mode,
    stage,
    edge: tokens.model3d.edge,
    sheet: tokens.canvas.bg,
    ink: tokens.canvas.entity,
    fg: tokens.ui.text,
    dim: tokens.ui.textDim,
    chrome: tokens.ui.panel,
    border: tokens.ui.border,
    accent: tokens.ui.accent,
  };
}

export const defaultPalette = (mode: ThemeMode): EmbedPalette => embedPalette(mode === "dark" ? DEFAULT_DARK : DEFAULT_LIGHT, mode);

export function paletteCss(p: EmbedPalette): Record<string, string> {
  return {
    "--sk-stage": p.stage,
    "--sk-fg": p.fg,
    "--sk-dim": p.dim,
    "--sk-chrome": p.chrome,
    "--sk-border": p.border,
    "--sk-accent": p.accent,
  };
}
