/**
 * Why: the format list is duplicated where code can't import it (Tauri
 * config, the native Explorer DLL). A format added in one place and not the
 * others means double-click or Explorer previews silently don't work for it.
 */
import tauriConfRaw from "../../src-tauri/tauri.conf.json?raw";
import thumbnailerLibRaw from "../../../../native/dxf-thumbnailer/src/lib.rs?raw";
import { describe, expect, it } from "vitest";
import { FORMATS, acceptList, allExtensions, formatOf, mimeOf } from "./formats";

describe("format registry", () => {
  it("resolves names case-insensitively, including aliases", () => {
    expect(formatOf("Part.STP")?.label).toBe("STEP model");
    expect(formatOf("a.igs")?.kind).toBe("3d");
    expect(formatOf("readme.txt")).toBeNull();
    expect(formatOf("noext")).toBeNull();
    expect(mimeOf("x.svg")).toBe("image/svg+xml");
    expect(formatOf("Art.AI")?.kind).toBe("2d");
    expect(formatOf("Art.eps")?.writable).toBe(true);
    expect(mimeOf("x.unknown")).toBe("application/dxf");
  });
  it("builds accept lists", () => {
    expect(acceptList((f) => f.kind === "2d")).toBe(".dxf,.svg,.dwg,.eps,.ai,.pdf");
  });
  it("tauri.conf.json fileAssociations equal the association-flagged formats", () => {
    const conf = JSON.parse(tauriConfRaw);
    const exts = (conf.bundle.fileAssociations as { ext: string[] }[]).flatMap((a) => a.ext);
    const mine = allExtensions((f) => f.association);
    // .sketchor is Sketchor's own format, not in the import registry.
    expect(exts.filter((e) => e !== "sketchor").sort()).toEqual([...mine].sort());
  });
  it("the Explorer thumbnailer registers exactly the nativeThumbnail formats", () => {
    const lib = thumbnailerLibRaw;
    const list = /const EXTENSIONS: \[&str; \d+\] = \[([^\]]*)\]/.exec(lib)![1];
    const exts = [...list.matchAll(/"\.([a-z]+)"/g)].map((m) => m[1]);
    expect(exts.sort()).toEqual(allExtensions((f) => f.nativeThumbnail).sort());
  });
  it("has no extension claimed twice", () => {
    const all = allExtensions();
    expect(new Set(all).size).toBe(all.length);
    expect(FORMATS.length).toBeGreaterThan(0);
  });
});
