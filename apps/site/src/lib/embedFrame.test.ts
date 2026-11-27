/**
 * The iframe endpoint and oEmbed answer turn strangers' query strings into
 * markup that other sites paste into their pages. A `javascript:` src, a CSS
 * string smuggled through `background`, or an unescaped title in the oEmbed
 * HTML would be an injection on someone else's site; a wrong "not ours"
 * means a pasted link never becomes a preview.
 */
import { describe, expect, it } from "vitest";
import { attrsForPastedUrl, frameAttrs, frameUrl, oembedFor, SITE } from "./embedFrame";

describe("frameAttrs", () => {
  it("needs an http(s) src and resolves site-relative ones", () => {
    expect(frameAttrs({})).toEqual({ ok: false, error: "missing src" });
    expect(frameAttrs({ src: "javascript:alert(1)" }).ok).toBe(false);
    expect(frameAttrs({ src: "data:text/html,hi" }).ok).toBe(false);
    expect(frameAttrs({ src: "/models/bracket.glb" })).toEqual({ ok: true, attrs: { src: `${SITE}/models/bracket.glb` } });
  });

  it("keeps values the element accepts and drops the rest", () => {
    const r = frameAttrs({
      src: "https://cdn.test/a.stl",
      motion: "NONE",
      controls: "full",
      autoplay: "1",
      background: "#112233",
      theme: "Blueprint",
      logo: "off",
      label: "Arm\u0007 bracket",
      onload: "x()",
    });
    expect(r).toEqual({
      ok: true,
      attrs: { src: "https://cdn.test/a.stl", motion: "none", autoplay: "", background: "#112233", theme: "blueprint", logo: "off", label: "Arm bracket" },
    });
  });

  it("rejects CSS strings in background and non-http theme/full-url URLs", () => {
    const r = frameAttrs({ src: "https://c/a.stl", background: "red; background-image:url(https://evil)", theme: "javascript:alert(1)", "full-url": "javascript:x" });
    expect(r.ok && r.attrs).toEqual({ src: "https://c/a.stl" });
    // E-01: the 2D motions pass; anything else does not.
    expect((frameAttrs({ src: "https://c/a.dxf", motion: "draw" }) as { attrs: Record<string, string> }).attrs.motion).toBe("draw");
    expect((frameAttrs({ src: "https://c/a.dxf", motion: "float" }) as { attrs: Record<string, string> }).attrs.motion).toBe("float");
    expect((frameAttrs({ src: "https://c/a.dxf", motion: "spin" }) as { attrs: Record<string, string> }).attrs.motion).toBeUndefined();
    expect(frameAttrs({ src: "https://c/a.stl", background: "rgba(10, 20, 30, 0.5)" }).ok && true).toBe(true);
    expect((frameAttrs({ src: "https://c/a.stl", background: "rgba(10, 20, 30, 0.5)" }) as { attrs: Record<string, string> }).attrs.background).toBe("rgba(10, 20, 30, 0.5)");
  });

  it("passes fit-padding and layers through, cleaned (E-02)", () => {
    const at = (q: Record<string, string>) => (frameAttrs({ src: "https://c/a.dxf", ...q }) as { attrs: Record<string, string> }).attrs;
    expect(at({ "fit-padding": "15%", layers: "Outline, -Notes" })).toMatchObject({ "fit-padding": "15%", layers: "Outline, -Notes" });
    expect(at({ "fit-padding": "wide" })["fit-padding"]).toBeUndefined();
    expect(at({ layers: '<b onclick="x">' }).layers).toBe("b onclick=x");
  });

  it("takes the first of repeated parameters", () => {
    expect(frameAttrs({ src: ["https://c/a.stl", "https://c/b.stl"] })).toEqual({ ok: true, attrs: { src: "https://c/a.stl" } });
  });
});

describe("pasted URLs", () => {
  it("round-trips our own /embed page with its settings", () => {
    const url = frameUrl({ src: "https://c/a.glb", motion: "none", theme: "light" });
    expect(attrsForPastedUrl(url)).toEqual({ src: "https://c/a.glb", motion: "none", theme: "light" });
  });
  it("understands /app?open= links and bare model URLs", () => {
    expect(attrsForPastedUrl(`${SITE}/app?open=${encodeURIComponent("https://c/x/arm.3mf")}`)).toEqual({ src: "https://c/x/arm.3mf" });
    expect(attrsForPastedUrl("https://c/x/part.STL?v=2")).toEqual({ src: "https://c/x/part.STL?v=2" });
  });
  it("says no to what it can't draw", () => {
    expect(attrsForPastedUrl("https://c/x/plate.step")).toBeNull();
    expect(attrsForPastedUrl(`${SITE}/`)).toBeNull();
    expect(attrsForPastedUrl("not a url")).toBeNull();
    expect(attrsForPastedUrl("ftp://c/a.stl")).toBeNull();
  });
});

describe("oembedFor", () => {
  it("answers a rich embed, 4:3 within the consumer's limits", () => {
    const o = oembedFor("https://c/m/bracket.glb", 500)!;
    expect(o).toMatchObject({ version: "1.0", type: "rich", provider_name: "Sketchor", title: "bracket.glb", width: 500, height: 375 });
    expect(o.html).toContain(`src="${SITE}/embed?src=https%3A%2F%2Fc%2Fm%2Fbracket.glb"`);
    const tall = oembedFor("https://c/m/bracket.glb", 2000, 300)!;
    expect([tall.width, tall.height]).toEqual([400, 300]);
  });
  it("escapes the title and URL inside the iframe HTML", () => {
    const o = oembedFor(frameUrl({ src: "https://c/a.glb", label: `"><script>alert(1)</script>` }))!;
    expect(o.html).not.toContain("<script>");
    expect(o.html).toContain("&quot;&gt;&lt;script&gt;");
    expect(o.title).toBe(`"><script>alert(1)</script>`); // JSON field, escaped by JSON itself
  });
  it("returns null for URLs that aren't previews", () => {
    expect(oembedFor("https://example.com/page")).toBeNull();
  });
});
