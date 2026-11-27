import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { BUILTIN_THEMES, DEFAULT_DARK, DEFAULT_LIGHT, validateTheme } from "@sketchor/core";
import { DEFAULT_THEMES, galleryThemes, summarizeTheme } from "./themes";

/**
 * Why: the gallery serves copies of the shipped themes from public/ (so they
 * download as files and community themes sit beside them). A copy that
 * drifts from @sketchor/core would show and hand out a theme the app no
 * longer ships. `UPDATE_THEMES=1 npx vitest run apps/site/src/lib/themes.test.ts`
 * rewrites the copies. Community files get the app's own validator, the
 * same gate a dropped theme file goes through.
 */
const root = fileURLToPath(new URL("../../public/themes", import.meta.url));
const fileText = (t: unknown) => JSON.stringify(t, null, 2) + "\n";

describe("shipped theme copies", () => {
  it("match @sketchor/core", () => {
    for (const t of BUILTIN_THEMES) {
      const path = join(root, `${t.id}.sketchor-theme.json`);
      if (process.env.UPDATE_THEMES) writeFileSync(path, fileText(t));
      expect(readFileSync(path, "utf8"), `${t.id}: run with UPDATE_THEMES=1`).toBe(fileText(t));
    }
    const files = readdirSync(root).filter((n) => n.endsWith(".sketchor-theme.json"));
    expect(files.sort()).toEqual(BUILTIN_THEMES.map((t) => `${t.id}.sketchor-theme.json`).sort());
  });

  it("show the default modes' real colours", () => {
    const sw = (tk: typeof DEFAULT_DARK) => [tk.ui.bg, tk.ui.accent, tk.canvas.bg, tk.canvas.entity, tk.canvas.selected];
    expect(DEFAULT_THEMES.map((t) => t.swatches)).toEqual([sw(DEFAULT_DARK), sw(DEFAULT_LIGHT)]);
  });
});

describe("community themes", () => {
  const dir = join(root, "community");
  const files = readdirSync(dir).filter((n) => n.endsWith(".sketchor-theme.json"));
  it.each(files.length ? files : ["(none yet)"])("%s passes the app's validator and has a card", (n) => {
    if (n === "(none yet)") return;
    const json = JSON.parse(readFileSync(join(dir, n), "utf8"));
    const v = validateTheme(json);
    expect(v.ok ? "" : v.issues.map((i) => `${i.path} ${i.message}`).join("; ")).toBe("");
    expect(n).toBe(`${json.id}.sketchor-theme.json`);
    expect(BUILTIN_THEMES.some((t) => t.id === json.id) || json.id === "dark" || json.id === "light").toBe(false);
    expect(summarizeTheme(json, "community", `/themes/community/${n}`)).not.toBeNull();
  });
});

describe("summarizeTheme", () => {
  const good = { id: "ocean", name: "Ocean", author: "A. Person", base: "dark", tokens: { ui: { bg: "#001020", accent: "rgb(0, 160, 255)" }, canvas: { bg: "#000814", entity: "white" } } };

  it("summarises a theme file, by id when shipped and by path when submitted", () => {
    expect(summarizeTheme(good, "community", "/themes/community/ocean.sketchor-theme.json")).toEqual({
      id: "ocean",
      name: "Ocean",
      author: "A. Person",
      base: "dark",
      source: "community",
      file: "/themes/community/ocean.sketchor-theme.json",
      ref: "/themes/community/ocean.sketchor-theme.json",
      swatches: ["#001020", "rgb(0, 160, 255)", "#000814", "white"],
    });
    expect(summarizeTheme(good, "builtin", "/themes/ocean.sketchor-theme.json")?.ref).toBe("ocean");
  });

  it("drops what isn't a theme, and colours that aren't colours", () => {
    expect(summarizeTheme(null, "community", "x")).toBeNull();
    expect(summarizeTheme({ ...good, id: "Bad Id" }, "community", "x")).toBeNull();
    expect(summarizeTheme({ ...good, base: "sepia" }, "community", "x")).toBeNull();
    const sneaky = { ...good, tokens: { ui: { bg: 'red" onload="x', accent: "url(https://x)" }, canvas: { bg: "#000" } } };
    expect(summarizeTheme(sneaky, "community", "x")?.swatches).toEqual(["#000"]);
  });

  it("lists defaults, shipped, then community by name", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "themes-"));
    writeFileSync(join(tmp, "b.sketchor-theme.json"), JSON.stringify({ ...good, id: "b", name: "B" }));
    const all = await galleryThemes(tmp);
    expect(all.map((t) => t.id)).toEqual(["dark", "light", "b"]);
    const real = await galleryThemes(root);
    expect(real.length).toBe(2 + BUILTIN_THEMES.length + readdirSync(join(root, "community")).filter((n) => n.endsWith(".json")).length);
  });
});
