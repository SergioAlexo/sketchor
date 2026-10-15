/**
 * Why: glTF/GLB and 3MF are containers (binary chunks, ZIP, transforms,
 * units). A wrong unit or node transform silently makes a part 1000x too big
 * or inside-out; a bad archive must fail with a message, not hang.
 */
import { describe, expect, it } from "vitest";
import { anyMeshFormatOf, parse3mf, parseAnyMesh, parseGltf, unzip } from "./parse2";

const enc = (s: string) => new TextEncoder().encode(s);

function crc32(b: Uint8Array): number {
  let c, crc = ~0;
  for (let i = 0; i < b.length; i++) {
    c = (crc ^ b[i]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return ~crc >>> 0;
}

/** Minimal ZIP writer: files are stored, or deflated when `deflate` is set. */
async function zip(files: Record<string, string>, deflate = false): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  for (const [name, text] of Object.entries(files)) {
    const data = enc(text);
    let body = data;
    if (deflate) body = new Uint8Array(await new Response(new Blob([data as BlobPart]).stream().pipeThrough(new CompressionStream("deflate-raw"))).arrayBuffer());
    const n = enc(name);
    const lh = new DataView(new ArrayBuffer(30));
    lh.setUint32(0, 0x04034b50, true);
    lh.setUint16(8, deflate ? 8 : 0, true);
    lh.setUint32(14, crc32(data), true);
    lh.setUint32(18, body.length, true);
    lh.setUint32(22, data.length, true);
    lh.setUint16(26, n.length, true);
    const cd = new DataView(new ArrayBuffer(46));
    cd.setUint32(0, 0x02014b50, true);
    cd.setUint16(10, deflate ? 8 : 0, true);
    cd.setUint32(16, crc32(data), true);
    cd.setUint32(20, body.length, true);
    cd.setUint32(24, data.length, true);
    cd.setUint16(28, n.length, true);
    cd.setUint32(42, offset, true);
    chunks.push(new Uint8Array(lh.buffer), n, body);
    central.push(new Uint8Array(cd.buffer), n);
    offset += 30 + n.length + body.length;
  }
  const cdSize = central.reduce((s, c) => s + c.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, Object.keys(files).length, true);
  end.setUint16(10, Object.keys(files).length, true);
  end.setUint32(12, cdSize, true);
  end.setUint32(16, offset, true);
  const all = [...chunks, ...central, new Uint8Array(end.buffer)];
  const out = new Uint8Array(all.reduce((s, c) => s + c.length, 0));
  let o = 0;
  for (const c of all) { out.set(c, o); o += c.length; }
  return out;
}

const MODEL = (unit: string) => `<?xml version="1.0"?><model unit="${unit}" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">
<resources>
<basematerials id="5"><base name="r" displaycolor="#FF0000FF"/></basematerials>
<object id="1" type="model" pid="5" pindex="0"><mesh><vertices>
<vertex x="0" y="0" z="0"/><vertex x="1" y="0" z="0"/><vertex x="0" y="1" z="0"/></vertices>
<triangles><triangle v1="0" v2="1" v3="2"/><triangle v1="0" v2="1" v3="9"/></triangles></mesh></object>
<object id="2"><components><component objectid="1" transform="1 0 0 0 1 0 0 0 1 10 0 0"/></components></object>
</resources><build><item objectid="2" transform="1 0 0 0 1 0 0 0 1 0 5 0"/></build></model>`;

describe("3MF", () => {
  for (const deflate of [false, true]) {
    it(`reads units, component + build transforms and colours (${deflate ? "deflate" : "stored"})`, async () => {
      const z = await zip({ "3D/3dmodel.model": MODEL("centimeter") }, deflate);
      const r = await parse3mf(z);
      expect(r.parts).toHaveLength(1);
      const p = r.parts[0];
      expect(p.indices.length).toBe(3); // the out-of-range triangle is dropped
      // vertex (1,0,0): +10 x via component, +5 y via build, then centimetre -> mm
      expect(Array.from(p.positions.subarray(3, 6))).toEqual([110, 50, 0]);
      expect(Array.from(p.colors!.subarray(0, 3))).toEqual([255, 0, 0]);
    });
  }
  it("rejects non-zip and zips without a model", async () => {
    await expect(parse3mf(enc("hello world, definitely not a zip file"))).rejects.toThrow(/ZIP/);
    await expect(parse3mf(await zip({ "a.txt": "x" }))).rejects.toThrow(/no 3D model/);
    expect((await unzip(await zip({ "a.txt": "x" }))).get("a.txt")).toEqual(enc("x"));
  });
});

function glb(json: object, bin: Uint8Array): Uint8Array {
  const j = enc(JSON.stringify(json));
  const jp = new Uint8Array(Math.ceil(j.length / 4) * 4).fill(0x20);
  jp.set(j);
  const bp = new Uint8Array(Math.ceil(bin.length / 4) * 4);
  bp.set(bin);
  const out = new Uint8Array(12 + 8 + jp.length + 8 + bp.length);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, 0x46546c67, true);
  dv.setUint32(4, 2, true);
  dv.setUint32(8, out.length, true);
  dv.setUint32(12, jp.length, true);
  dv.setUint32(16, 0x4e4f534a, true);
  out.set(jp, 20);
  dv.setUint32(20 + jp.length, bp.length, true);
  dv.setUint32(24 + jp.length, 0x004e4942, true);
  out.set(bp, 28 + jp.length);
  return out;
}

describe("glTF / GLB", () => {
  const bin = new Uint8Array(36 + 6);
  const bv = new DataView(bin.buffer);
  [0, 0, 0, 1, 0, 0, 0, 1, 0].forEach((v, i) => bv.setFloat32(i * 4, v, true));
  [0, 1, 2].forEach((v, i) => bv.setUint16(36 + i * 2, v, true));
  const doc = {
    asset: { version: "2.0" },
    buffers: [{ byteLength: bin.length }],
    bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: 36 }, { buffer: 0, byteOffset: 36, byteLength: 6 }],
    accessors: [{ bufferView: 0, componentType: 5126, count: 3, type: "VEC3" }, { bufferView: 1, componentType: 5123, count: 3, type: "SCALAR" }],
    materials: [{ pbrMetallicRoughness: { baseColorFactor: [0, 1, 0, 1] } }],
    meshes: [{ name: "tri", primitives: [{ attributes: { POSITION: 0 }, indices: 1, material: 0 }] }],
    nodes: [{ mesh: 0, translation: [1, 0, 0], scale: [2, 2, 2] }],
    scenes: [{ nodes: [0] }],
  };
  it("reads a GLB: metres to mm, node TRS, indices, material colour", () => {
    const r = parseGltf(glb(doc, bin));
    expect(r.parts).toHaveLength(1);
    expect(r.parts[0].name).toBe("tri");
    expect(Array.from(r.parts[0].positions.subarray(3, 6))).toEqual([3000, 0, 0]);
    expect(Array.from(r.parts[0].indices)).toEqual([0, 1, 2]);
    expect(Array.from(r.parts[0].colors!.subarray(0, 3))).toEqual([0, 255, 0]);
  });
  it("reads .gltf with an embedded base64 buffer; warns on external buffers", () => {
    let s = "";
    for (const b of bin) s += String.fromCharCode(b);
    const emb = { ...doc, buffers: [{ byteLength: bin.length, uri: `data:application/octet-stream;base64,${btoa(s)}` }] };
    expect(parseGltf(enc(JSON.stringify(emb))).parts).toHaveLength(1);
    const ext = parseGltf(enc(JSON.stringify({ ...doc, buffers: [{ byteLength: 42, uri: "x.bin" }] })));
    expect(ext.parts).toHaveLength(0);
    expect(ext.warnings[0]).toMatch(/external buffer/);
  });
  it("rejects garbage, survives cyclic nodes and out-of-range accessors", async () => {
    expect(() => parseGltf(enc("{nope"))).toThrow(/glTF/);
    const cyc = { ...doc, nodes: [{ mesh: 0, children: [0] }] };
    expect(parseGltf(glb(cyc, bin)).parts).toHaveLength(1);
    const bad = { ...doc, accessors: [{ bufferView: 0, componentType: 5126, count: 9999, type: "VEC3" }, doc.accessors[1]] };
    expect(parseGltf(glb(bad, bin)).parts).toHaveLength(0);
    await expect(parseAnyMesh("glb", glb(bad, bin))).rejects.toThrow(/no triangles/);
  });
  it("dispatches by extension", () => {
    expect(anyMeshFormatOf("a.GLB")).toBe("glb");
    expect(anyMeshFormatOf("a.3mf")).toBe("3mf");
    expect(anyMeshFormatOf("a.stl")).toBe("stl");
    expect(anyMeshFormatOf("a.dxf")).toBeNull();
  });
});
