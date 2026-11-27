/**
 * Why (F-11): "repair" must turn the usual broken export — flipped faces, a
 * missing triangle, an inside-out shell, junk triangles — into a watertight
 * mesh a slicer accepts, without moving geometry, and must leave a clean
 * mesh alone.
 */
import { describe, expect, it } from "vitest";
import type { MeshPart } from "./parse";
import { describeRepair, repairChangedNothing, repairMesh } from "./repair";
import { checkMesh } from "./write";

function cube(size = 10, color?: [number, number, number]): MeshPart {
  const v = [[0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0], [0, 0, 1], [1, 0, 1], [1, 1, 1], [0, 1, 1]].map((p) => p.map((c) => c * size));
  const quads = [[0, 3, 2, 1], [4, 5, 6, 7], [0, 1, 5, 4], [2, 3, 7, 6], [1, 2, 6, 5], [3, 0, 4, 7]];
  const pos: number[] = [];
  for (const q of quads) for (const t of [[q[0], q[1], q[2]], [q[0], q[2], q[3]]]) for (const i of t) pos.push(...v[i]);
  const part: MeshPart = { name: "Cube", positions: Float32Array.from(pos), indices: Uint32Array.from({ length: pos.length / 3 }, (_, i) => i) };
  if (color) part.colors = Uint8Array.from({ length: pos.length }, (_, i) => color[i % 3]);
  return part;
}
const flip = (p: MeshPart, t: number) => {
  const i = p.indices;
  [i[t * 3 + 1], i[t * 3 + 2]] = [i[t * 3 + 2], i[t * 3 + 1]];
};
function volume(p: MeshPart) {
  let v = 0;
  for (let i = 0; i < p.indices.length; i += 3) {
    const [a, b, c] = [0, 1, 2].map((k) => Array.from(p.positions.subarray(p.indices[i + k] * 3, p.indices[i + k] * 3 + 3)));
    v += (a[0] * (b[1] * c[2] - b[2] * c[1]) - a[1] * (b[0] * c[2] - b[2] * c[0]) + a[2] * (b[0] * c[1] - b[1] * c[0])) / 6;
  }
  return v;
}

describe("repairMesh", () => {
  it("leaves a clean mesh alone (apart from welding)", () => {
    const { part, report } = repairMesh(cube());
    expect(repairChangedNothing(report)).toBe(true);
    expect(report.welded).toBe(28);
    expect(part.positions.length / 3).toBe(8);
    expect(volume(part)).toBeCloseTo(1000, 6);
    expect(describeRepair(report)).toBe("nothing to repair");
  });

  it("flips triangles that face the wrong way", () => {
    const p = cube();
    flip(p, 3);
    flip(p, 7);
    const { part, report } = repairMesh(p);
    expect(report.trianglesFlipped).toBe(2);
    expect(checkMesh(part).watertight).toBe(true);
    expect(volume(part)).toBeCloseTo(1000, 6);
  });

  it("turns an inside-out shell outward", () => {
    const p = cube();
    for (let t = 0; t < 12; t++) flip(p, t);
    const { part, report } = repairMesh(p);
    expect(report.shellsTurnedOutward).toBe(1);
    expect(volume(part)).toBeCloseTo(1000, 6);
  });

  it("fills a missing triangle and a missing face, and drops junk triangles", () => {
    const missingOne: MeshPart = { ...cube(), indices: cube().indices.slice(3) };
    const r1 = repairMesh(missingOne);
    expect(r1.report.holesFilled).toBe(1);
    expect(checkMesh(r1.part).watertight).toBe(true);
    expect(volume(r1.part)).toBeCloseTo(1000, 6);

    const noLid: MeshPart = { ...cube(), indices: Uint32Array.from([...cube().indices.slice(0, 6), ...cube().indices.slice(12)]) };
    const r2 = repairMesh(noLid); // both top triangles gone: a square hole
    expect(r2.report.holesFilled).toBe(1);
    expect(checkMesh(r2.part).watertight).toBe(true);
    expect(volume(r2.part)).toBeCloseTo(1000, 6);

    const junk: MeshPart = { ...cube(), indices: Uint32Array.from([...cube().indices, 0, 1, 2, 5, 5, 6]) };
    const r3 = repairMesh(junk);
    expect(r3.report).toMatchObject({ duplicateRemoved: 1, degenerateRemoved: 1 });
    expect(describeRepair(r3.report)).toBe("removed 1 zero-area triangle, removed 1 duplicate triangle");
  });

  it("leaves a hole bigger than the limit open and says so", () => {
    const noLid: MeshPart = { ...cube(), indices: Uint32Array.from([...cube().indices.slice(0, 6), ...cube().indices.slice(12)]) };
    const { report } = repairMesh(noLid, { maxHoleEdges: 3 });
    expect(report).toMatchObject({ holesFilled: 0, holesLeft: 1 });
  });

  it("keeps each triangle's colour, and gives a fill its neighbour's", () => {
    const p = cube(10, [10, 20, 30]);
    const { part } = repairMesh({ ...p, indices: p.indices.slice(3) });
    expect(part.colors!.length).toBe(part.positions.length);
    for (let i = 0; i < part.colors!.length; i += 3) expect(Array.from(part.colors!.subarray(i, i + 3))).toEqual([10, 20, 30]);
  });
});
