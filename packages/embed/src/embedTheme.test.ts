/**
 * The embed sits on someone else's page: `theme="auto"` must match that
 * page (a dark preview punched into a light article looks broken), a light
 * theme must actually look light, and a theme file must never outrank the
 * page's own `--sketchor-*` overrides or smuggle CSS in.
 */
import { describe, expect, it } from "vitest";
import { DEFAULT_DARK, DEFAULT_LIGHT } from "../../core/src/theme";
import { builtinTheme } from "../../core/src/builtinThemes";
import { resolveTheme } from "../../core/src/themeFile";
import { defaultPalette, embedPalette, needsThemeFile, paletteCss, pickMode } from "./embedTheme";
import { builtinThemeIds, loadThemePalette } from "./themeLoad";

describe("pickMode", () => {
  it("an explicit mode wins over everything", () => {
    expect(pickMode("light", "dark", true)).toBe("light");
    expect(pickMode("dark", "light", false)).toBe("dark");
  });
  it("auto follows the host page's stated color-scheme first", () => {
    expect(pickMode("auto", "dark", false)).toBe("dark");
    expect(pickMode(null, "only light", true)).toBe("light");
  });
  it("auto falls back to the visitor's preference when the page states none or both", () => {
    expect(pickMode("auto", "normal", true)).toBe("dark");
    expect(pickMode("auto", "light dark", false)).toBe("light");
    expect(pickMode("", "", true)).toBe("dark");
  });
});

describe("embedPalette", () => {
  it("dark keeps the app's 3D stage colours exactly", () => {
    const p = defaultPalette("dark");
    expect(p.stage).toBe(DEFAULT_DARK.model3d.bg);
    expect(p.edge).toBe(DEFAULT_DARK.model3d.edge);
    expect(p.fg).toBe(DEFAULT_DARK.ui.text);
  });
  it("light gets a light stage, not the shared dark model3d one", () => {
    const p = defaultPalette("light");
    expect(p.stage).toBe(DEFAULT_LIGHT.ui.bg);
    expect(p.stage).not.toBe(DEFAULT_LIGHT.model3d.bg);
    expect(p.fg).toBe(DEFAULT_LIGHT.ui.text);
  });
  it("a 2D drawing gets the theme's drawing sheet and ink (white on dark, black on light)", () => {
    expect(defaultPalette("dark").sheet).toBe(DEFAULT_DARK.canvas.bg);
    expect(defaultPalette("dark").ink).toBe(DEFAULT_DARK.canvas.entity);
    expect(defaultPalette("light").sheet).toBe(DEFAULT_LIGHT.canvas.bg);
    expect(defaultPalette("light").ink).toBe(DEFAULT_LIGHT.canvas.entity);
  });
  it("a background the theme set on purpose is the stage", () => {
    expect(embedPalette(DEFAULT_LIGHT, "light", "#ddeeff").stage).toBe("#ddeeff");
  });
  it("only ever writes private --sk-* properties, so the page's --sketchor-* wins", () => {
    const keys = Object.keys(paletteCss(defaultPalette("dark")));
    expect(keys.every((k) => k.startsWith("--sk-"))).toBe(true);
  });
});

describe("theme files", () => {
  it("knows which values need a theme file", () => {
    expect(needsThemeFile("auto")).toBe(false);
    expect(needsThemeFile("Light")).toBe(false);
    expect(needsThemeFile(null)).toBe(false);
    expect(needsThemeFile("nord")).toBe(true);
    expect(needsThemeFile("/themes/brand.json")).toBe(true);
  });
  it("resolves a built-in theme id without any network", async () => {
    const id = builtinThemeIds()[0];
    const file = builtinTheme(id)!;
    const p = await loadThemePalette(id, "https://site.test/");
    expect(p.mode).toBe(file.base);
    expect(p.accent).toBe(resolveTheme(file).ui.accent);
  });
  it("a theme that only recolours the drawing sheet still colours the stage (blueprint is blue)", async () => {
    const file = builtinTheme("blueprint")!;
    expect(file.tokens.canvas?.bg).toBeDefined();
    const p = await loadThemePalette("blueprint", "https://site.test/");
    expect(p.stage).toBe(file.tokens.model3d?.bg ?? file.tokens.canvas!.bg);
    expect(p.stage).not.toBe(DEFAULT_DARK.model3d.bg);
    expect(p.sheet).toBe(resolveTheme(file).canvas.bg);
    expect(p.ink).toBe(resolveTheme(file).canvas.entity);
  });
});
