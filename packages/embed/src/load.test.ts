/**
 * Format sniffing decides which parser sees untrusted bytes from someone
 * else's server, and the full-view URL is what a visitor clicks to leave the
 * host page — both must be right before any three.js is downloaded.
 */
import { describe, expect, it } from "vitest";
import { extensionOf, fileNameFromSrc, resolveFullUrl, sniffFormat } from "./load";

const bytes = (s: string): Uint8Array => new TextEncoder().encode(s);

describe("sniffFormat", () => {
  it("trusts GLB magic over a misleading extension", () => {
    expect(sniffFormat("model.bin", bytes("glTF\u0002\u0000\u0000\u0000"))).toEqual({ kind: "preview", format: "glb" });
  });
  it("sends STEP (by content or name) to the app instead of a mesh parser", () => {
    expect(sniffFormat("part.txt", bytes("ISO-10303-21;\nHEADER;"))).toEqual({ kind: "app-only", ext: "step" });
    expect(sniffFormat("part.STP", null)).toEqual({ kind: "app-only", ext: "stp" });
    expect(sniffFormat("plate.dxf", bytes("0\nSECTION"))).toEqual({ kind: "app-only", ext: "dxf" });
  });
  it("reads a zip as 3MF and mesh formats by extension", () => {
    expect(sniffFormat("download", bytes("PK\u0003\u0004rest"))).toEqual({ kind: "preview", format: "3mf" });
    expect(sniffFormat("a/b/Bracket.STL?v=2", bytes("solid x"))).toEqual({ kind: "preview", format: "stl" });
  });
  it("honours an explicit format override", () => {
    expect(sniffFormat("blob", bytes("anything"), ".OBJ")).toEqual({ kind: "preview", format: "obj" });
  });
  it("says unknown rather than guessing", () => {
    expect(sniffFormat("notes.docx", bytes("xxxx"))).toEqual({ kind: "unknown" });
    expect(sniffFormat("", new Uint8Array())).toEqual({ kind: "unknown" });
  });
});

describe("names and links", () => {
  it("extracts extensions and readable names from URLs", () => {
    expect(extensionOf("https://x.com/m/ASM-4019.glb?x=1#y")).toBe("glb");
    expect(extensionOf(".hidden")).toBe("");
    expect(fileNameFromSrc("/models/My%20Part.stl")).toBe("My Part.stl");
    expect(fileNameFromSrc("https://x.com/")).toBe("model");
  });
  it("points 'Open in Sketchor' at the app's ?open= route by default", () => {
    expect(resolveFullUrl(null, "https://site.com/a b.glb")).toBe("https://sketchor.sergioalexo.com/app?open=https%3A%2F%2Fsite.com%2Fa%20b.glb");
    expect(resolveFullUrl("auto", null)).toBe("https://sketchor.sergioalexo.com/app");
    expect(resolveFullUrl("none", "https://site.com/a.glb")).toBeNull();
    expect(resolveFullUrl("https://my.app/view", "https://site.com/a.glb")).toBe("https://my.app/view");
  });
});
