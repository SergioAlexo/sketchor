/**
 * Measuring in the embed's full view: a click has to land on the part and
 * face that was actually under the cursor, the selection rules have to match
 * the app's (click replaces, Shift adds), and the numbers have to read in
 * real units. A wrong part lookup highlights a face on a different part; a
 * fake mass row would state a weight nobody chose a material for.
 */
import { describe, expect, it } from "vitest";
import { buildModel } from "./three/buildModel";
import type { OcctMesh, OcctResult } from "./three/types";
import { EMBED_FORMATTERS, faceTrianglePositions, measureForEmbed, nextSelection, partOfTriangle } from "./measureView";

/** A w×w×w cube at (ox,0,0), per-face vertices like a STEP tessellation. */
function cube(w: number, ox: number, name: string): OcctMesh {
  const q = (pts: number[][]) => pts.map(([x, y, z]) => [x * w + ox, y * w, z * w]);
  const quads = [
    q([[0, 0, 1], [1, 0, 1], [1, 1, 1], [0, 1, 1]]),
    q([[0, 0, 0], [0, 1, 0], [1, 1, 0], [1, 0, 0]]),
    q([[1, 0, 0], [1, 1, 0], [1, 1, 1], [1, 0, 1]]),
    q([[0, 0, 0], [0, 0, 1], [0, 1, 1], [0, 1, 0]]),
    q([[0, 1, 0], [0, 1, 1], [1, 1, 1], [1, 1, 0]]),
    q([[0, 0, 0], [1, 0, 0], [1, 0, 1], [0, 0, 1]]),
  ];
  const position: number[] = [];
  const index: number[] = [];
  const brep_faces: OcctMesh["brep_faces"] = [];
  quads.forEach((quad, f) => {
    const base = f * 4;
    for (const [x, y, z] of quad) position.push(x, y, z);
    index.push(base, base + 1, base + 2, base, base + 2, base + 3);
    brep_faces.push({ first: f * 2, last: f * 2 + 1, color: null });
  });
  return { name, brep_faces, attributes: { position: { array: position } }, index: { array: index } };
}

const model = buildModel({ success: true, meshes: [cube(10, 0, "A"), cube(20, 50, "B")] } as OcctResult, "two.stl", "h", "stl");

describe("partOfTriangle", () => {
  it("maps every triangle to the part that owns it", () => {
    for (let p = 0; p < model.parts.length; p++) {
      const first = model.parts[p].indexStart / 3;
      const last = first + model.parts[p].indexCount / 3 - 1;
      expect(partOfTriangle(model, first)).toBe(p);
      expect(partOfTriangle(model, last)).toBe(p);
    }
    expect(partOfTriangle(model, 10_000)).toBe(-1);
  });
});

describe("faceTrianglePositions", () => {
  it("returns the face's own triangles (a 20 mm cube face spans 20 mm)", () => {
    const face = model.parts[1].faceStart;
    const pts = faceTrianglePositions(model, face);
    expect(pts.length).toBe(model.faces.triCount[face] * 9);
    const xs = Array.from(pts.filter((_, i) => i % 3 === 0));
    const ys = Array.from(pts.filter((_, i) => i % 3 === 1));
    expect(Math.max(...xs) - Math.min(...xs) + Math.max(...ys) - Math.min(...ys)).toBeCloseTo(40, 6);
  });
});

describe("nextSelection", () => {
  const f = (index: number) => ({ kind: "face" as const, index });
  it("click replaces, clicking the only selection again clears it, empty clears", () => {
    expect(nextSelection([f(1)], f(2), false)).toEqual([f(2)]);
    expect(nextSelection([f(2)], f(2), false)).toEqual([]);
    expect(nextSelection([f(1), f(2)], null, false)).toEqual([]);
  });
  it("Shift adds up to two, toggles one off, and keeps the selection on an empty click", () => {
    expect(nextSelection([f(1)], f(2), true)).toEqual([f(1), f(2)]);
    expect(nextSelection([f(1), f(2)], f(3), true)).toEqual([f(2), f(3)]);
    expect(nextSelection([f(1), f(2)], f(1), true)).toEqual([f(2)]);
    expect(nextSelection([f(1)], null, true)).toEqual([f(1)]);
  });
});

describe("measureForEmbed", () => {
  it("reads a part in real units and never shows a mass", () => {
    const m = measureForEmbed(model, [{ kind: "part", index: 1 }]);
    const labels = m.rows.map((r) => r.label);
    expect(labels.some((l) => /^(total )?massb/i.test(l))).toBe(false); // "Center of mass" is geometry and stays
    const vol = m.rows.find((r) => /volume/i.test(r.label));
    expect(vol?.value).toBe("8.00 cm³"); // 20 mm cube = 8000 mm³
  });
  it("gives a distance and its segment between two faces", () => {
    const a = model.parts[0].faceStart + 2; // +X face of cube A at x=10
    const b = model.parts[1].faceStart + 3; // -X face of cube B at x=50
    const m = measureForEmbed(model, [{ kind: "face", index: a }, { kind: "face", index: b }]);
    expect(m.rows.some((r) => r.value === "40.00 mm")).toBe(true);
    expect(m.segment).not.toBeNull();
  });
  it("formats small, large and negative numbers readably", () => {
    expect(EMBED_FORMATTERS.length(0.12345)).toBe("0.123 mm");
    expect(EMBED_FORMATTERS.length(1234.4)).toBe("1234 mm");
    expect(EMBED_FORMATTERS.length(-0.0001)).toBe("0.000 mm");
    expect(EMBED_FORMATTERS.volume(500)).toBe("500.0 mm³");
  });
});
