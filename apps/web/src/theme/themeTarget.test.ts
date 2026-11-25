import { describe, expect, it } from "vitest";
import { themeTarget, withoutThemeParam } from "./themeTarget";

/**
 * Why: the theme gallery links into the app with `?theme=`. A shipped theme
 * must switch without a prompt; anything else is a file to fetch, and only
 * from http(s) or this site's own paths — never a `javascript:` URL or a
 * protocol-relative "//host" sneaking past as a path.
 */
const O = "https://sketchor.example";

describe("themeTarget", () => {
  it("switches to the default modes and shipped themes by id", () => {
    expect(themeTarget("?theme=dark", O)).toEqual({ kind: "setting", setting: "dark", name: "Dark" });
    expect(themeTarget("?theme=blueprint", O)).toEqual({ kind: "setting", setting: "builtin:blueprint", name: "Blueprint" });
  });

  it("fetches a theme file from an http(s) URL or this site's own path", () => {
    expect(themeTarget("?theme=" + encodeURIComponent("https://x.example/t/ocean.sketchor-theme.json"), O)).toEqual({
      kind: "url",
      url: "https://x.example/t/ocean.sketchor-theme.json",
      name: "ocean.sketchor-theme.json",
    });
    expect(themeTarget("?theme=/themes/community/ocean.sketchor-theme.json", O)).toEqual({
      kind: "url",
      url: "https://sketchor.example/themes/community/ocean.sketchor-theme.json",
      name: "ocean.sketchor-theme.json",
    });
  });

  it("refuses everything else", () => {
    for (const bad of ["", "nope", "javascript:alert(1)//a.json", "//evil.example/a.json", "/\\evil.example/a.json", "ftp://x.example/a.json", "https://x.example/a.png"]) {
      expect(themeTarget("?theme=" + encodeURIComponent(bad), O)).toBeNull();
    }
    expect(themeTarget("?open=a.dxf", O)).toBeNull();
  });
});

describe("withoutThemeParam", () => {
  it("drops only theme", () => {
    expect(withoutThemeParam("?theme=dark")).toBe("");
    expect(withoutThemeParam("?open=x&theme=dark&demo")).toBe("?open=x&demo=");
  });
});
