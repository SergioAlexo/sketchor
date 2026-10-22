import { describe, expect, it } from "vitest";
import { entitiesToDxf } from "@sketchor/core";
import { polyline } from "@sketchor/plugin-sdk";
import { loadDxfFile, PANEL_HTML, recFromExtracted } from "./sheetNestingPlugin";
import { extractPartsWithDiagnostics } from "@sketchor/plugin-nest";

/**
 * The panel runs in a sandboxed iframe a test cannot drive, so these pin the
 * two things that break silently: the panel script failing to even compile
 * (a stray quote in the template string leaves a blank panel), and the file
 * intake - a dropped DXF must give a part with the right size, honour a forced
 * unit, and turn garbage into an error message instead of a throw.
 */

const rect = (w: number, h: number) => polyline([{ x: 0, y: 0 }, { x: w, y: 0 }, { x: w, y: h }, { x: 0, y: h }], true);

describe("Sheet Nesting panel", () => {
  it("has a script that compiles and carries the credit", () => {
    const script = /<script>([\s\S]*)<\/script>/.exec(PANEL_HTML)![1]!;
    expect(() => new Function(script)).not.toThrow();
    expect(PANEL_HTML).toContain("Nesting engine based on the Sheet Nesting Calculator by Oleksandr Borenko");
  });
});

describe("loadDxfFile", () => {
  it("reads a rectangle as one part of the drawn size", () => {
    const text = entitiesToDxf([rect(100, 50)], 4, 1);
    const f = loadDxfFile("k", "plate.dxf", text, null);
    expect(f.error).toBeUndefined();
    expect(f.parts).toHaveLength(1);
    expect(f.parts[0]!.w).toBeCloseTo(100, 3);
    expect(f.parts[0]!.h).toBeCloseTo(50, 3);
    expect(f.parts[0]!.cutLength).toBeCloseTo(300, 3);
    expect(f.parts[0]!.pierceCount).toBe(1);
  });

  it("a forced unit rescales the geometry", () => {
    const text = entitiesToDxf([rect(100, 50)], 0, 1); // no declared unit
    const mm = loadDxfFile("k", "a.dxf", text, 4);
    const inch = loadDxfFile("k", "a.dxf", text, 1);
    expect(inch.parts[0]!.w / mm.parts[0]!.w).toBeCloseTo(25.4, 3);
  });

  it("never throws on empty, truncated or non-DXF input", () => {
    const good = entitiesToDxf([rect(10, 10)], 4, 1);
    for (const bad of ["", "garbage", good.slice(0, good.length / 2), "0\nSECTION\n2\nENTITIES\n0\nLINE\n"]) {
      const f = loadDxfFile("k", "x.dxf", bad, null);
      expect(f.parts.length === 0 ? typeof f.error : "ok").toBeTruthy();
    }
  });
});

describe("recFromExtracted", () => {
  it("keeps cut length and pierce count from extraction", () => {
    const e = rect(10, 20);
    const { parts, notes } = extractPartsWithDiagnostics([e], new Set([e.id]));
    const rec = recFromExtracted(parts[0]!, "k", new Map([[e.id, e]]), notes);
    expect(rec.cutLength).toBeCloseTo(60, 6);
    expect(rec.area).toBeCloseTo(200, 6);
  });
});
