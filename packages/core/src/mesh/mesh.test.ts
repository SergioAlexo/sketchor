/**
 * Why: mesh files are the most common 3D input a user has, and the readers run
 * on arbitrary bytes. A mis-read index or a wrong face split shows up as a
 * garbled part or as picking/measure that treats a whole flat panel as 20
 * faces; malformed files must degrade, never throw out of the worker.
 */
import { describe, expect, it } from "vitest";
import { meshFormatOf, parseMesh, parseObj, parsePly, parseStl } from "./parse";
import { segmentMesh } from "./segment";

const enc = (s: string) => new TextEncoder().encode(s);

/** Unit cube as 12 triangles (shared corners). */
const CUBE_V = [0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0, 0, 0, 1, 1, 0, 1, 1, 1, 1, 0, 1, 1];
const CUBE_F = [0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 2, 3, 7, 2, 7, 6, 1, 2, 6, 1, 6, 5, 3, 0, 4, 3, 4, 7];

function cubeObj(): string {
  const v = [];
  for (let i = 0; i < CUBE_V.length; i += 3) v.push(`v ${CUBE_V[i]} ${CUBE_V[i + 1]} ${CUBE_V[i + 2]}`);
  const f = [];
  for (let i = 0; i < CUBE_F.length; i += 3) f.push(`f ${CUBE_F[i] + 1} ${CUBE_F[i + 1] + 1} ${CUBE_F[i + 2] + 1}`);
  return [...v, ...f].join("\n");
}

function binaryStl(): Uint8Array {
  const buf = new ArrayBuffer(84 + 12 * 50);
  const dv = new DataView(buf);
  dv.setUint32(80, 12, true);
  for (let t = 0; t < 12; t++)
    for (let k = 0; k < 3; k++)
      for (let c = 0; c < 3; c++) dv.setFloat32(84 + t * 50 + 12 + k * 12 + c * 4, CUBE_V[CUBE_F[t * 3 + k] * 3 + c], true);
  return new Uint8Array(buf);
}

describe("mesh readers", () => {
  it("recognises extensions", () => {
    expect(meshFormatOf("a.STL")).toBe("stl");
    expect(meshFormatOf("C:\\x\\a.ply")).toBe("ply");
    expect(meshFormatOf("a.step")).toBeNull();
  });

  it("reads binary STL", () => {
    const r = parseStl(binaryStl());
    expect(r.parts[0].indices.length).toBe(36);
    expect(r.parts[0].positions.length).toBe(108);
  });

  it("reads ASCII STL and drops an incomplete trailing facet", () => {
    const tri = "facet normal 0 0 1\nouter loop\nvertex 0 0 0\nvertex 1 0 0\nvertex 0 1 0\nendloop\nendfacet\n";
    const r = parseStl(enc(`solid x\n${tri}${tri}facet normal 0 0 1\nouter loop\nvertex 0 0 0\nvertex 1 0 0\n`));
    expect(r.parts[0].indices.length).toBe(6);
    expect(r.warnings.length).toBe(1);
  });

  it("tolerates a truncated binary STL", () => {
    const b = binaryStl().subarray(0, 84 + 5 * 50 + 7);
    const r = parseStl(b);
    expect(r.parts[0].indices.length).toBe(15);
    expect(r.warnings[0]).toMatch(/truncated/);
  });

  it("reads OBJ: polygons, negative indices, groups, vertex colours, bad faces", () => {
    const r = parseObj(enc("o A\nv 0 0 0 1 0 0\nv 1 0 0 1 0 0\nv 1 1 0 1 0 0\nv 0 1 0 1 0 0\nf 1/1/1 2 3 4\nf -4 -3 -2\nf 1 2 99\ng B\nf 1 2 3\n"));
    expect(r.parts.map((p) => p.name)).toEqual(["A", "B"]);
    expect(r.parts[0].indices.length).toBe(9); // quad fan (2) + 1
    expect(r.parts[0].colors![0]).toBe(255);
    expect(r.warnings[0]).toMatch(/1 face/);
  });

  it("reads PLY ascii and binary with colours and quads", () => {
    const ascii = "ply\nformat ascii 1.0\nelement vertex 4\nproperty float x\nproperty float y\nproperty float z\nproperty uchar red\nproperty uchar green\nproperty uchar blue\nelement face 1\nproperty list uchar int vertex_indices\nend_header\n0 0 0 255 0 0\n1 0 0 0 255 0\n1 1 0 0 0 255\n0 1 0 9 9 9\n4 0 1 2 3\n";
    const a = parsePly(enc(ascii));
    expect(a.parts[0].indices.length).toBe(6);
    expect(Array.from(a.parts[0].colors!.subarray(0, 3))).toEqual([255, 0, 0]);

    const head = enc("ply\nformat binary_big_endian 1.0\nelement vertex 3\nproperty float x\nproperty float y\nproperty float z\nelement face 1\nproperty list uchar uint vertex_indices\nend_header\n");
    const body = new DataView(new ArrayBuffer(3 * 12 + 1 + 12));
    [0, 0, 0, 1, 0, 0, 0, 1, 0].forEach((v, i) => body.setFloat32(i * 4, v, false));
    body.setUint8(36, 3);
    [0, 1, 2].forEach((v, i) => body.setUint32(37 + i * 4, v, false));
    const bin = new Uint8Array(head.length + body.byteLength);
    bin.set(head);
    bin.set(new Uint8Array(body.buffer), head.length);
    const b = parsePly(bin);
    expect(Array.from(b.parts[0].indices)).toEqual([0, 1, 2]);
    expect(b.parts[0].positions[3]).toBe(1);
  });

  it("rejects garbage without hanging and reports truncated PLY bodies", () => {
    expect(() => parsePly(enc("not a ply"))).toThrow();
    expect(() => parseMesh("obj", enc("hello"))).toThrow(/no triangles/);
    const cut = parsePly(enc("ply\nformat binary_little_endian 1.0\nelement vertex 100\nproperty float x\nproperty float y\nproperty float z\nend_header\n\0\0\0\0"));
    expect(cut.warnings.length).toBe(1);
  });
});

describe("segmentMesh", () => {
  const cube = () => parseObj(enc(cubeObj())).parts[0];

  it("splits a cube into six flat faces, each with its own vertices", () => {
    const m = segmentMesh(cube());
    expect(m.brep_faces).toHaveLength(6);
    expect(m.brep_faces.every((f) => f.last - f.first === 1)).toBe(true);
    expect(m.index.array.length).toBe(36);
    expect(m.attributes.position.array.length / 3).toBe(24);
  });

  it("keeps a smooth surface in one face", () => {
    // A shallow 3x3 grid bump (<20 degrees between neighbours).
    const pos: number[] = [];
    const idx: number[] = [];
    for (let y = 0; y < 4; y++) for (let x = 0; x < 4; x++) pos.push(x, y, 0.05 * x * x);
    for (let y = 0; y < 3; y++)
      for (let x = 0; x < 3; x++) {
        const a = y * 4 + x;
        idx.push(a, a + 1, a + 5, a, a + 5, a + 4);
      }
    const m = segmentMesh({ name: "g", positions: Float32Array.from(pos), indices: Uint32Array.from(idx) });
    expect(m.brep_faces).toHaveLength(1);
  });

  it("welds an unindexed (STL-style) soup and averages vertex colours per face", () => {
    const stl = parseStl(binaryStl()).parts[0];
    stl.colors = new Uint8Array(stl.positions.length).fill(128);
    const m = segmentMesh(stl);
    expect(m.brep_faces).toHaveLength(6);
    expect(m.brep_faces[0].color![0]).toBeCloseTo(128 / 255, 2);
  });

  it("ignores degenerate triangles", () => {
    const m = segmentMesh({ name: "d", positions: Float32Array.from([0, 0, 0, 1, 0, 0, 2, 0, 0, 0, 0, 0, 1, 0, 0, 0, 1, 0]), indices: Uint32Array.from([0, 1, 2, 3, 4, 5]) });
    expect(m.index.array.length).toBe(3);
  });
});
