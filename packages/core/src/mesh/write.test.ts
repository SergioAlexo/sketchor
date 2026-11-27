/**
 * Why (F-11): an exported STL or 3MF has to open in a slicer at the right
 * size and come back into Sketchor unchanged. These round-trip every writer
 * through our own (hardened) readers, compare STL with 3MF, and check the
 * mesh checker counts what a slicer would complain about.
 */
import { describe, expect, it } from "vitest";
import type { MeshPart } from "./parse";
import { parseStl } from "./parse";
import { parse3mf } from "./parse2";
import { checkMesh, describeMeshCheck, weldVertices, write3mf, writeStl } from "./write";
import { unzip } from "./parse2";

/** A closed cube as an unwelded soup (every face its own vertices, as the viewer stores it), wound outward. */
function cube(size = 10, at = [0, 0, 0], color?: [number, number, number]): MeshPart {
  const v = [[0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0], [0, 0, 1], [1, 0, 1], [1, 1, 1], [0, 1, 1]].map((p) => p.map((c, i) => c * size + at[i]));
  const quads = [[0, 3, 2, 1], [4, 5, 6, 7], [0, 1, 5, 4], [2, 3, 7, 6], [1, 2, 6, 5], [3, 0, 4, 7]];
  const pos: number[] = [];
  for (const q of quads) for (const t of [[q[0], q[1], q[2]], [q[0], q[2], q[3]]]) for (const i of t) pos.push(...v[i]);
  const positions = Float32Array.from(pos);
  const indices = Uint32Array.from({ length: positions.length / 3 }, (_, i) => i);
  const part: MeshPart = { name: "Cube", positions, indices };
  if (color) part.colors = Uint8Array.from({ length: positions.length }, (_, i) => color[i % 3]);
  return part;
}

function bbox(parts: MeshPart[]) {
  const b = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
  for (const p of parts)
    for (let i = 0; i < p.positions.length; i += 3)
      for (let j = 0; j < 3; j++) {
        b[j] = Math.min(b[j], p.positions[i + j]);
        b[j + 3] = Math.max(b[j + 3], p.positions[i + j]);
      }
  return b;
}
/** Signed volume (divergence theorem): positive for an outward-wound closed mesh. */
function volume(parts: MeshPart[]) {
  let v = 0;
  for (const p of parts)
    for (let i = 0; i < p.indices.length; i += 3) {
      const [a, b, c] = [0, 1, 2].map((k) => Array.from(p.positions.subarray(p.indices[i + k] * 3, p.indices[i + k] * 3 + 3)));
      v += (a[0] * (b[1] * c[2] - b[2] * c[1]) - a[1] * (b[0] * c[2] - b[2] * c[0]) + a[2] * (b[0] * c[1] - b[1] * c[0])) / 6;
    }
  return v;
}

describe("checkMesh", () => {
  it("passes a closed, consistently wound cube once welded", () => {
    const c = checkMesh(cube());
    expect(c).toMatchObject({ triangles: 12, openEdges: 0, nonManifoldEdges: 0, flippedEdges: 0, shells: 1, watertight: true });
    expect(describeMeshCheck("Cube", c)).toEqual([]);
  });
  it("counts holes, flipped triangles, degenerate and duplicate ones, and shells", () => {
    const p = cube();
    const open: MeshPart = { ...p, indices: p.indices.slice(3) }; // one triangle removed
    expect(checkMesh(open)).toMatchObject({ openEdges: 3, watertight: false });
    const flipped = cube();
    [flipped.indices[1], flipped.indices[2]] = [flipped.indices[2], flipped.indices[1]];
    expect(checkMesh(flipped).flippedEdges).toBe(3);
    const extra: MeshPart = { ...p, indices: Uint32Array.from([...p.indices, 0, 1, 2, 0, 0, 1]) };
    expect(checkMesh(extra)).toMatchObject({ duplicate: 1, degenerate: 1 });
    const two = cube();
    const far = cube(10, [50, 0, 0]);
    const both: MeshPart = { name: "x", positions: Float32Array.from([...two.positions, ...far.positions]), indices: Uint32Array.from([...two.indices, ...far.indices.map((i) => i + two.positions.length / 3)]) };
    expect(checkMesh(both).shells).toBe(2);
    expect(describeMeshCheck("Lid", checkMesh(open))[0]).toBe("Lid: not closed (3 open edges)");
  });
  it("welds coincident corners", () => {
    expect(weldVertices(cube().positions).positions.length / 3).toBe(8);
  });
});

describe("writeStl", () => {
  it("round-trips binary STL: size, volume, winding, and a header that doesn't start with 'solid'", () => {
    const parts = [cube(10), cube(5, [20, 0, 0])];
    const bytes = writeStl(parts);
    expect(new TextDecoder().decode(bytes.subarray(0, 5))).not.toBe("solid");
    expect(bytes.length).toBe(84 + 24 * 50);
    const back = parseStl(bytes).parts;
    expect(bbox(back)).toEqual(bbox(parts));
    expect(volume(back)).toBeCloseTo(1000 + 125, 3);
  });
  it("writes ASCII with one solid per part, read back as separate parts", () => {
    const text = writeStl([cube(10), { ...cube(5, [20, 0, 0]), name: "Small lid" }], { format: "ascii" });
    const back = parseStl(text).parts;
    expect(back.map((p) => p.name)).toEqual(["Cube", "Small_lid"]);
    expect(volume(back)).toBeCloseTo(1125, 3);
  });
  it("scales to inches and writes facet colours that read back", () => {
    const inch = parseStl(writeStl([cube(25.4)], { scale: 1 / 25.4 })).parts;
    expect(bbox(inch)[3]).toBeCloseTo(1, 6);
    const coloured = parseStl(writeStl([cube(10, [0, 0, 0], [255, 0, 0])], { colors: true })).parts[0];
    expect(Array.from(coloured.colors!.subarray(0, 3))).toEqual([255, 0, 0]);
  });
  it("writes normals from the winding", () => {
    const b = writeStl([cube(10)]);
    const dv = new DataView(b.buffer);
    // First facet is the bottom (z = 0), wound to face -z.
    expect([dv.getFloat32(84, true), dv.getFloat32(88, true), dv.getFloat32(92, true)]).toEqual([0, 0, -1]);
  });
});

describe("write3mf", () => {
  it("is a valid package: content types, rels, model; vertices shared, one object and build item per part", async () => {
    const files = await unzip(await write3mf([cube(10), cube(5, [20, 0, 0])], { metadata: { Title: "Two <cubes> & more" } }));
    expect([...files.keys()]).toEqual(["[Content_Types].xml", "_rels/.rels", "3D/3dmodel.model"]);
    const xml = new TextDecoder().decode(files.get("3D/3dmodel.model"));
    expect((xml.match(/<vertex /g) ?? []).length).toBe(16); // 8 per cube, welded
    expect((xml.match(/<object /g) ?? []).length).toBe(2);
    expect((xml.match(/<item /g) ?? []).length).toBe(2);
    expect(xml).toContain('unit="millimeter"');
    expect(xml).toContain("Two &lt;cubes&gt; &amp; more");
  });
  it("round-trips losslessly (±0.001 mm), names, metadata and colours included", async () => {
    const parts = [cube(12.345, [1.5, -2.25, 3]), { ...cube(5, [20, 0, 0], [0, 128, 255]), name: "Blue" }];
    const back = await parse3mf(await write3mf(parts, { metadata: { Title: "T", Designer: "D" } }));
    expect(back.parts.map((p) => p.name)).toEqual(["Cube", "Blue"]);
    expect(back.metadata).toMatchObject({ Title: "T", Designer: "D", Application: "Sketchor" });
    bbox(back.parts).forEach((v, i) => expect(Math.abs(v - bbox(parts)[i])).toBeLessThan(0.001));
    expect(volume(back.parts)).toBeCloseTo(volume(parts), 3);
    expect(Array.from(back.parts[1].colors!.subarray(0, 3))).toEqual([0, 128, 255]);
    expect(back.parts[0].colors).toBeUndefined();
  });
  it("writes per-triangle colours as a colour group", async () => {
    const p = cube(10, [0, 0, 0], [200, 0, 0]);
    for (let i = 0; i < 9; i++) p.colors!.set([0, 200, 0], i * 3); // the first 9 corners: three triangles
    const bytes = await write3mf([p]);
    const xml = new TextDecoder().decode((await unzip(bytes)).get("3D/3dmodel.model"));
    expect(xml).toMatch(/<m:colorgroup id="\d+"><m:color color="#00C800FF"\/><m:color color="#C80000FF"\/><\/m:colorgroup>/);
    const back = (await parse3mf(bytes)).parts[0];
    expect(Array.from(back.colors!.subarray(0, 3))).toEqual([0, 200, 0]);
    expect(Array.from(back.colors!.subarray(27, 30))).toEqual([200, 0, 0]);
  });
  it("converts to the chosen unit and back", async () => {
    const back = await parse3mf(await write3mf([cube(25.4)], { unit: "inch" }));
    expect(bbox(back.parts)[3]).toBeCloseTo(25.4, 4);
  });
  it("STL and 3MF of the same model agree on size and volume", async () => {
    const parts = [cube(7.5, [3, 4, 5])];
    const a = parseStl(writeStl(parts)).parts;
    const b = (await parse3mf(await write3mf(parts))).parts;
    expect(bbox(a)).toEqual(bbox(b));
    expect(volume(a)).toBeCloseTo(volume(b), 4);
  });
  it("adds a thumbnail part when given one", async () => {
    const files = await unzip(await write3mf([cube()], { thumbnail: new Uint8Array([137, 80, 78, 71]) }));
    expect(files.has("Metadata/thumbnail.png")).toBe(true);
    expect(new TextDecoder().decode(files.get("_rels/.rels"))).toContain("/Metadata/thumbnail.png");
  });
});
