/**
 * People paste these snippets into their sites verbatim. A snippet that names
 * an attribute the element ignores, or an iframe URL the endpoint rejects, is
 * a broken embed on someone else's page with nothing on ours to show why.
 */
import { describe, expect, it } from "vitest";
import { frameAttrs } from "./embedFrame";
import { changedAttrs, embedSnippet, SCRIPT_URL } from "./embedSnippet";

const SRC = "https://cdn.test/parts/bracket.glb";

describe("embedSnippet", () => {
  it("leaves defaults out so the snippet shows only what changed", () => {
    expect(changedAttrs({ src: SRC, motion: "turntable", theme: "auto", controls: "minimal", logo: "on", label: "" })).toEqual([["src", SRC]]);
  });

  it("writes the element with boolean and valued attributes", () => {
    const s = embedSnippet("element", { src: SRC, autoplay: "", theme: "light", motion: "none" });
    expect(s).toContain(`src="${SCRIPT_URL}"`);
    expect(s).toContain(`<sketchor-view src="${SRC}" autoplay motion="none" theme="light"></sketchor-view>`);
  });

  it("auto-upgrade mode is a plain link with data-sketchor-* and data-auto on the script", () => {
    const s = embedSnippet("auto", { src: SRC, autoplay: "", logo: "off", label: "Bracket" });
    expect(s).toContain(" data-auto></script>");
    expect(s).toContain(`<a href="${SRC}" data-sketchor data-sketchor-autoplay data-sketchor-logo="off">Bracket</a>`);
  });

  it("the iframe URL is one the endpoint accepts with the same settings", () => {
    const s = embedSnippet("iframe", { src: SRC, autoplay: "", theme: "blueprint", background: "#102030" });
    const url = new URL(s.match(/src="([^"]+)"/)![1].replace(/&amp;/g, "&"));
    const r = frameAttrs(Object.fromEntries(url.searchParams));
    expect(r).toEqual({ ok: true, attrs: { src: SRC, autoplay: "", theme: "blueprint", background: "#102030" } });
  });

  it("escapes quotes and angle brackets the user typed", () => {
    const s = embedSnippet("element", { src: SRC, label: `a"b<c` });
    expect(s).toContain(`label="a&quot;b&lt;c"`);
  });

  it("an unusable src gives a comment, not a broken iframe", () => {
    expect(embedSnippet("iframe", { src: "javascript:alert(1)" })).toMatch(/^<!--/);
  });
});
