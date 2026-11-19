import { describe, expect, it } from "vitest";
import { detectUpAxis, detectUpAxisFromBytes, reorientModel, upAxisMatrix } from "./upAxis";
import type { Model3D } from "./types";

/**
 * A SolidWorks assembly opens lying on its back unless we know it is Y-up;
 * a wrong guess the other way stands an Onshape model on its head. The
 * rotation must also move *every* coordinate the viewer reads (picking,
 * measure, overlays) — a table left behind would put a selection highlight
 * somewhere the model isn't.
 */

const SW =
  "ISO-10303-21;\nHEADER;\nFILE_DESCRIPTION(('SwSTEP 2.0'),'1');\nFILE_NAME('a.STEP','2023-01-01',(''),(''),'SwSTEP 2.0','SolidWorks 2023','');\nENDSEC;";
const ONSHAPE =
  "ISO-10303-21;\nHEADER;\nFILE_NAME('a.step','2023',(''),(''),'Onshape','Onshape','');\nENDSEC;";

describe("detectUpAxis", () => {
  it("SolidWorks is Y-up", () => expect(detectUpAxis(SW)).toBe("y"));
  it("Onshape is Z-up", () => expect(detectUpAxis(ONSHAPE)).toBe("z"));
  it("empty and garbage are Z-up", () => {
    expect(detectUpAxis("")).toBe("z");
    expect(detectUpAxis("\u0000\u0001 not a step file")).toBe("z");
  });
  it("a truncated header is Z-up rather than throwing", () => {
    expect(detectUpAxis("ISO-10303-21;\nHEADER;\nFILE_NAME('a.STEP','2023',(''),(''),'SwSTE")).toBe("z");
  });
  it("ignores SolidWorks mentioned outside FILE_NAME", () => {
    expect(detectUpAxis("FILE_DESCRIPTION(('SolidWorks'),'1');\nFILE_NAME('a','b',(''),(''),'x','y','');")).toBe("z");
  });
  it("reads from raw bytes, including an empty buffer", () => {
    expect(detectUpAxisFromBytes(new TextEncoder().encode(SW).buffer as ArrayBuffer)).toBe("y");
    expect(detectUpAxisFromBytes(new ArrayBuffer(0))).toBe("z");
  });
});

describe("upAxisMatrix", () => {
  it("maps file +Y to display +Z, and is a proper rotation", () => {
    const m = upAxisMatrix("y");
    const apply = (x: number, y: number, z: number) => [
      m[0] * x + m[4] * y + m[8] * z,
      m[1] * x + m[5] * y + m[9] * z,
      m[2] * x + m[6] * y + m[10] * z,
    ];
    expect(apply(0, 1, 0)).toEqual([0, 0, 1]);
    expect(apply(1, 0, 0)).toEqual([1, 0, 0]);
    const det =
      m[0] * (m[5] * m[10] - m[9] * m[6]) - m[4] * (m[1] * m[10] - m[9] * m[2]) + m[8] * (m[1] * m[6] - m[5] * m[2]);
    expect(det).toBe(1);
  });
});

function tiny(): Model3D {
  const z = new Float32Array(0);
  const u32 = new Uint32Array(0);
  return {
    name: "t",
    hash: "h",
    format: "step",
    positions: new Float32Array([1, 2, 3, 4, 5, 6]),
    normals: new Float32Array([0, 1, 0, 0, 0, 1]),
    colors: new Uint8Array(6),
    indices: new Uint32Array([0, 1, 0]),
    edges: new Float32Array([1, 2, 3, 4, 5, 6]),
    faces: {
      part: u32,
      triStart: u32,
      triCount: u32,
      area: z,
      perimeter: z,
      centroid: new Float32Array([1, 2, 3]),
      normal: new Float32Array([0, 1, 0]),
      planar: new Uint8Array(0),
    },
    edgeTable: {
      part: u32,
      segStart: u32,
      segCount: u32,
      length: z,
      kind: new Uint8Array(0),
      a: new Float32Array([1, 2, 3]),
      b: new Float32Array([4, 5, 6]),
      center: new Float32Array(3),
      radius: z,
      normal: new Float32Array([0, 1, 0]),
      faceA: u32,
      faceB: u32,
    },
    nodes: { part: u32, xyz: new Float32Array([1, 2, 3]) },
    faceOfTriangle: u32,
    edgeOfSegment: u32,
    parts: [
      {
        name: "p",
        vertexStart: 0,
        vertexCount: 2,
        indexStart: 0,
        indexCount: 3,
        edgeStart: 0,
        edgeCount: 1,
        faceStart: 0,
        faceCount: 1,
        edgeRefStart: 0,
        edgeRefCount: 1,
        nodeStart: 0,
        nodeCount: 1,
        area: 1,
        volume: 1,
        centroid: [1, 2, 3],
        bounds: { min: [1, 2, 3], max: [4, 5, 6] },
      },
    ],
    tree: { name: "r", parts: [0], children: [] },
    bounds: { min: [1, 2, 3], max: [4, 5, 6] },
    triangleCount: 1,
  };
}

describe("reorientModel", () => {
  it("Z is the identity (same object)", () => {
    const m = tiny();
    expect(reorientModel(m, "z")).toBe(m);
  });
  it("Y turns every coordinate table the same way and leaves the source alone", () => {
    const m = tiny();
    const r = reorientModel(m, "y");
    expect([...r.positions]).toEqual([1, -3, 2, 4, -6, 5]);
    expect([...r.normals]).toEqual([0, 0, 1, 0, -1, 0]);
    expect([...r.edges]).toEqual([...r.positions]);
    expect([...r.nodes.xyz]).toEqual([1, -3, 2]);
    expect([...r.faces.normal]).toEqual([0, 0, 1]);
    expect([...r.edgeTable.a]).toEqual([1, -3, 2]);
    expect(r.parts[0].centroid).toEqual([1, -3, 2]);
    expect(m.positions[1]).toBe(2);
  });
  it("bounds are the box of the turned points; the file's Y extent becomes display Z", () => {
    const r = reorientModel(tiny(), "y");
    expect(r.bounds).toEqual({ min: [1, -6, 2], max: [4, -3, 5] });
    expect(r.bounds.max[2] - r.bounds.min[2]).toBe(5 - 2);
    expect(r.parts[0].bounds).toEqual(r.bounds);
  });
});
