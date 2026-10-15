/**
 * Why: Explorer/Finder thumbnails come from the Rust parser (native/dxf-parse)
 * and the in-app file browser from `dxfToSvg`. Both must draw a block insert
 * array, a hatch and a DIMENSION (via its `*D` block) with the same extents,
 * or the same drawing looks different in two places. The Rust unit test reads
 * the same fixture and asserts the same numbers.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import "./kinds/builtin";
import { boundsOf, dxfToSvg, parseDxf } from "./dxf";

const fixture = readFileSync(new URL("../../../native/dxf-parse/tests/parity.dxf", import.meta.url), "utf8");

describe("DXF thumbnail parity (TS side)", () => {
  it("has the extents the Rust parser asserts", () => {
    const { entities } = parseDxf(fixture, { blocks: "explode" });
    const b = boundsOf(entities)!;
    expect([b.minX, b.maxX, b.minY, b.maxY].map((v) => Math.round(v * 1e6) / 1e6)).toEqual([0, 100, -2, 70]);
  });

  it("draws the insert array, the dimension block and a tinted hatch", () => {
    const svg = dxfToSvg(fixture);
    expect((svg.match(/<line /g) ?? []).length).toBe(3); // 2 inserted copies + the *D1 line
    expect(svg).toContain('fill-opacity="0.28"');
    expect(svg).toContain('fill-rule="evenodd"');
  });

  it("an unknown dimension block degrades to a warning, not a crash", () => {
    const r = parseDxf("0\nSECTION\n2\nENTITIES\n0\nDIMENSION\n2\n*D9\n0\nENDSEC\n0\nEOF\n", { blocks: "explode" });
    expect(r.entities).toHaveLength(0);
    expect(r.warnings.some((w) => w.includes("DIMENSION"))).toBe(true);
  });
});
