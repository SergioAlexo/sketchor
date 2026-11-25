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
    expect(sniffFormat("plate.dwg", bytes("AC1032"))).toEqual({ kind: "app-only", ext: "dwg" });
  });
  it("reads 2D drawings by content first, then by name", () => {
    expect(sniffFormat("plate.dxf", bytes("0\nSECTION"))).toEqual({ kind: "drawing", format: "dxf" });
    expect(sniffFormat("download", bytes("%PDF-1.7\n"))).toEqual({ kind: "drawing", format: "pdf" });
    // An Illustrator 9+ file is a PDF inside: the PDF importer draws it.
    expect(sniffFormat("logo.ai", bytes("%PDF-1.5\n"))).toEqual({ kind: "drawing", format: "pdf" });
    expect(sniffFormat("logo.ai", bytes("%!PS-Adobe-3.0"))).toEqual({ kind: "drawing", format: "ai" });
    expect(sniffFormat("file", new Uint8Array([0xc5, 0xd0, 0xd3, 0xc6, 0, 0]))).toEqual({ kind: "drawing", format: "eps" });
    expect(sniffFormat("icon", bytes('<?xml version="1.0"?>\n<!-- made by hand -->\n<svg xmlns="http://www.w3.org/2000/svg">'))).toEqual({ kind: "drawing", format: "svg" });
    expect(sniffFormat("binary.bin", bytes("AutoCAD Binary DXF\r\n"))).toEqual({ kind: "drawing", format: "dxf" });
    expect(sniffFormat("A.SVG", null)).toEqual({ kind: "drawing", format: "svg" });
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
