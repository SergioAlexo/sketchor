/**
 * The embed must read a file into the same Model3D a Sketchor model tab
 * builds — same parser, same faces and edges, and glTF stood upright — or a
 * preview and the opened file disagree about what the part looks like.
 */
import { describe, expect, it } from "vitest";
import { parseModel } from "./parse";

/** A 10 × 20 × 30 mm box as ASCII STL (12 triangles). */
function boxStl(): Uint8Array {
  const v = (x: number, y: number, z: number) => [x * 10, y * 20, z * 30];
  const quads = [
    [v(0, 0, 0), v(1, 0, 0), v(1, 1, 0), v(0, 1, 0)],
    [v(0, 0, 1), v(0, 1, 1), v(1, 1, 1), v(1, 0, 1)],
    [v(0, 0, 0), v(0, 0, 1), v(1, 0, 1), v(1, 0, 0)],
    [v(0, 1, 0), v(1, 1, 0), v(1, 1, 1), v(0, 1, 1)],
    [v(0, 0, 0), v(0, 1, 0), v(0, 1, 1), v(0, 0, 1)],
    [v(1, 0, 0), v(1, 0, 1), v(1, 1, 1), v(1, 1, 0)],
  ];
  const tri = (a: number[], b: number[], c: number[]) =>
    `facet normal 0 0 0\nouter loop\nvertex ${a.join(" ")}\nvertex ${b.join(" ")}\nvertex ${c.join(" ")}\nendloop\nendfacet\n`;
  let s = "solid box\n";
  for (const [a, b, c, d] of quads) s += tri(a, b, c) + tri(a, c, d);
  return new TextEncoder().encode(s + "endsolid box\n");
}

/** One triangle as a minimal GLB, in metres with Y up (the glTF convention). */
function triangleGlb(): Uint8Array {
  const pos = new Float32Array([0, 0, 0, 1, 0, 0, 0, 2, 0]);
  const json = JSON.stringify({
    asset: { version: "2.0" },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0 }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }],
    accessors: [{ bufferView: 0, componentType: 5126, count: 3, type: "VEC3", min: [0, 0, 0], max: [1, 2, 0] }],
    bufferViews: [{ buffer: 0, byteLength: pos.byteLength }],
    buffers: [{ byteLength: pos.byteLength }],
  });
  const jsonBytes = new TextEncoder().encode(json.padEnd(Math.ceil(json.length / 4) * 4, " "));
  const bin = new Uint8Array(pos.buffer);
  const total = 12 + 8 + jsonBytes.length + 8 + bin.length;
  const out = new Uint8Array(total);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, 0x46546c67, true);
  dv.setUint32(4, 2, true);
  dv.setUint32(8, total, true);
  dv.setUint32(12, jsonBytes.length, true);
  dv.setUint32(16, 0x4e4f534a, true);
  out.set(jsonBytes, 20);
  const o = 20 + jsonBytes.length;
  dv.setUint32(o, bin.length, true);
  dv.setUint32(o + 4, 0x004e4942, true);
  out.set(bin, o + 8);
  return out;
}

describe("parseModel", () => {
  it("builds faces and B-rep edges for a mesh the way a model tab does", async () => {
    const m = await parseModel(boxStl(), "box.stl", "stl", "auto");
    expect(m.parts).toHaveLength(1);
    expect(m.bounds.min).toEqual([0, 0, 0]);
    expect(m.bounds.max).toEqual([10, 20, 30]);
    // A box has 12 edges; each is drawn as at least one segment (6 floats).
    expect(m.edges.length).toBeGreaterThanOrEqual(12 * 6);
  });

  it("converts glTF metres to millimetres and stands Y-up files on Z", async () => {
    const m = await parseModel(triangleGlb(), "tri.glb", "glb", "auto");
    // 2 m along glTF's Y (up) becomes 2000 mm along displayed Z.
    expect(m.bounds.max[2]).toBeCloseTo(2000, 3);
    expect(m.bounds.max[0]).toBeCloseTo(1000, 3);
  });

  it("lets the up override leave a file as authored", async () => {
    const m = await parseModel(triangleGlb(), "tri.glb", "glb", "z");
    expect(m.bounds.max[1]).toBeCloseTo(2000, 3);
  });

  it("rejects a file with no triangles instead of drawing an empty stage", async () => {
    await expect(parseModel(new TextEncoder().encode("solid empty\nendsolid empty\n"), "e.stl", "stl", "auto")).rejects.toThrow();
  });
});
