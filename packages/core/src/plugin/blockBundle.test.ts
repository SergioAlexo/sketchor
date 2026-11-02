/**
 * Why this matters (B-24): a block pack installs without a signature because it
 * is data only. These pin that it really is (no code, no permissions, no path
 * traversal), that dynamic blocks survive the trip (DXF SKETCHOR record and
 * .sketchor), and that hostile or empty files give errors, never a throw.
 */
import { describe, expect, it } from "vitest";
import { CommandBus } from "../commands";
import { SketchDocument } from "../document";
import { entitiesToDxf2018 } from "../dxfw";
import "../kinds/builtin";
import { dynamicSpecOf } from "../blocks/dynamic";
import { fixtureDoor, fixtureWindow } from "../blocks/dynamicFixtures";
import { isBlockBundle, loadBlockBundle } from "./blockBundle";
import { HOST_API_VERSION } from "./hostApi";
import { isBlocksOnly, isSafeBundlePath, validateManifest } from "./manifest";

const manifest = (extra: Record<string, unknown> = {}, files = [{ file: "blocks/doors.dxf", category: "Doors" }]) =>
  JSON.stringify({ id: "com.example.blocks", version: "1.0.0", name: "Example blocks", engines: { sketchor: "^1.0.0" }, contributes: { blocks: files }, ...extra });

const dxf = entitiesToDxf2018([], { blocks: [fixtureWindow(), fixtureDoor()] });
const sketchorText = (): string => {
  const doc = new SketchDocument();
  const bus = new CommandBus(doc);
  bus.execute({ type: "put-table-record", table: "blocks", record: fixtureWindow() });
  return JSON.stringify(doc.toJSON());
};

describe("blocks-only plugin bundles", () => {
  it("lists every block of a DXF with its category and keeps the dynamic spec", () => {
    const r = loadBlockBundle({ manifest: manifest(), blocks: { "blocks/doors.dxf": dxf } });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.blocks.map((b) => b.entry.def.name).sort()).toEqual(["FX_DOOR", "FX_WINDOW"]);
    expect(r.blocks.every((b) => b.category === "Doors")).toBe(true);
    expect(dynamicSpecOf(r.blocks.find((b) => b.entry.def.name === "FX_WINDOW")!.entry.def)).toEqual(fixtureWindow().dynamic);
  });

  it("reads a .sketchor file and falls back to the plugin name as the category", () => {
    const m = manifest({}, [{ file: "w.sketchor" } as { file: string; category: string }]);
    const r = loadBlockBundle({ manifest: m, blocks: { "w.sketchor": sketchorText() } });
    expect(r.ok && r.blocks[0].category).toBe("Example blocks");
    expect(r.ok && dynamicSpecOf(r.blocks[0].entry.def)).toBeDefined();
  });

  it("a file of loose geometry becomes one block named after the file", () => {
    const loose = "0\nSECTION\n2\nENTITIES\n0\nLINE\n8\n0\n10\n0\n20\n0\n11\n5\n21\n5\n0\nENDSEC\n0\nEOF\n";
    const r = loadBlockBundle({ manifest: manifest({}, [{ file: "parts/bracket.dxf", category: "P" }]), blocks: { "parts/bracket.dxf": loose } });
    expect(r.ok && r.blocks.map((b) => b.entry.def.name)).toEqual(["bracket"]);
  });

  it("rejects code, permissions, other contributions, unsafe paths, missing / empty / garbage files", () => {
    const b = { "blocks/doors.dxf": dxf };
    expect(loadBlockBundle({ manifest: manifest({ main: "index.js" }), blocks: b }).ok).toBe(false);
    expect(loadBlockBundle({ manifest: manifest({ permissions: ["document.write"] }), blocks: b }).ok).toBe(false);
    expect(loadBlockBundle({ manifest: "{", blocks: b }).ok).toBe(false);
    expect(loadBlockBundle({ manifest: manifest(), blocks: {} }).ok).toBe(false);
    expect(loadBlockBundle({ manifest: manifest(), blocks: { "blocks/doors.dxf": "" } }).ok).toBe(false);
    expect(() => loadBlockBundle({ manifest: manifest(), blocks: { "blocks/doors.dxf": "\u0000\u0001 not a dxf" } })).not.toThrow();
    expect(loadBlockBundle({ manifest: manifest({}, [{ file: "../x.dxf", category: "A" }]), blocks: b }).ok).toBe(false);
    expect(loadBlockBundle({ manifest: manifest({}, [{ file: "x.txt", category: "A" }]), blocks: b }).ok).toBe(false);
    const withPattern = JSON.parse(manifest());
    withPattern.contributes.hatchPatterns = [{ file: "a.pat" }];
    expect(loadBlockBundle({ manifest: JSON.stringify(withPattern), blocks: b }).ok).toBe(false);
  });

  it("manifest helpers and the host API version", () => {
    expect(isSafeBundlePath("blocks/a.dxf", "block") && isSafeBundlePath("a.SKETCHOR", "block")).toBe(true);
    expect(isSafeBundlePath("a.json", "block")).toBe(false);
    const v = validateManifest(JSON.parse(manifest()));
    expect(v.ok && isBlocksOnly(v.manifest)).toBe(true);
    expect(isBlockBundle({ manifest: "{}", blocks: {} })).toBe(true);
    expect(isBlockBundle({ manifest: "{}", blocks: {}, code: "x" })).toBe(false);
    expect(HOST_API_VERSION).toBe("0.11.0");
  });
});
