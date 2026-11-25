/**
 * Why (F-11): STL and 3MF files from real tools break naive readers in
 * known ways — binary STLs that start with "solid", wrong triangle counts,
 * colours hidden in the attribute bytes, 3MF parts that aren't at the usual
 * path, objects in other model parts, per-triangle colours, mirrored build
 * items, support objects. Each case here is one of those; the hostile ones
 * must fail with a message, not exhaust memory.
 */
import { describe, expect, it } from "vitest";
import { parseStl, stlIsBinary } from "./parse";
import { openZip, parse3mf } from "./parse2";
import { writeZip } from "./zipWrite";

const enc = (s: string) => new TextEncoder().encode(s);

/** A binary STL: `tris` as 9 numbers each, optional per-facet attribute, header text and stated count. */
function binStl(tris: number[][], o: { header?: string | Uint8Array; attrs?: number[]; count?: number; extra?: number } = {}): Uint8Array {
  const b = new Uint8Array(84 + tris.length * 50 + (o.extra ?? 0));
  const dv = new DataView(b.buffer);
  if (typeof o.header === "string") b.set(enc(o.header).subarray(0, 80));
  else if (o.header) b.set(o.header.subarray(0, 80));
  dv.setUint32(80, o.count ?? tris.length, true);
  tris.forEach((t, i) => {
    const at = 84 + i * 50;
    dv.setFloat32(at, 0, true); // a bogus stored normal — must be ignored
    t.forEach((v, k) => dv.setFloat32(at + 12 + k * 4, v, true));
    dv.setUint16(at + 48, o.attrs?.[i] ?? 0, true);
  });
  return b;
}
const T1 = [0, 0, 0, 1, 0, 0, 0, 1, 0];
const T2 = [0, 0, 1, 1, 0, 1, 0, 1, 1];

describe("STL read hardening", () => {
  it("reads a binary STL whose header starts with 'solid' (SolidWorks does this)", () => {
    const b = binStl([T1, T2], { header: "solid Part1 facet vertex exported by a CAD system" });
    expect(stlIsBinary(b)).toBe(true);
    const r = parseStl(b);
    expect(r.parts[0].indices.length).toBe(6);
    expect(r.warnings).toEqual([]);
  });

  it("trusts whole facets over a wrong header count, with a warning", () => {
    const r = parseStl(binStl([T1, T2], { count: 0, header: "solid x" }));
    expect(r.parts[0].indices.length).toBe(6);
    expect(r.warnings[0]).toMatch(/header says 0 triangles but the file holds 2/);
  });

  it("ignores trailing bytes after the stated triangles, with a warning", () => {
    const r = parseStl(binStl([T1], { extra: 7 }));
    expect(r.parts[0].indices.length).toBe(3);
    expect(r.warnings[0]).toMatch(/7 extra bytes/);
  });

  it("reads VisCAM/SolidView facet colours (bit 15 set, red in the high bits)", () => {
    const red = 0x8000 | (31 << 10);
    const r = parseStl(binStl([T1, T2], { attrs: [red, 0] }));
    const c = r.parts[0].colors!;
    expect(Array.from(c.subarray(0, 3))).toEqual([255, 0, 0]);
    expect(Array.from(c.subarray(9, 12))).toEqual([180, 180, 180]); // uncoloured facet: neutral grey
  });

  it("reads Materialise Magics colours (header COLOR=, bit 15 clear = own colour, red in the low bits)", () => {
    const header = new Uint8Array(80);
    header.set(enc("COLOR="), 0);
    header.set([0, 255, 0, 255], 6);
    const r = parseStl(binStl([T1, T2], { header, attrs: [31, 0x8000] }));
    const c = r.parts[0].colors!;
    expect(Array.from(c.subarray(0, 3))).toEqual([255, 0, 0]);
    expect(Array.from(c.subarray(9, 12))).toEqual([0, 255, 0]); // the header's default
  });

  it("leaves an uncoloured binary STL without colours", () => {
    expect(parseStl(binStl([T1])).parts[0].colors).toBeUndefined();
  });

  it("makes one part per solid in a multi-solid ASCII file", () => {
    const facet = "facet normal 0 0 1\nouter loop\nvertex 0 0 0\nvertex 1 0 0\nvertex 0 1 0\nendloop\nendfacet\n";
    const r = parseStl(enc(`solid base\n${facet}endsolid base\nsolid lid\n${facet}${facet}endsolid lid\n`));
    expect(r.parts.map((p) => [p.name, p.indices.length])).toEqual([["base", 3], ["lid", 6]]);
  });

  it("treats a head with NUL bytes as binary even when it says 'solid ... facet vertex'", () => {
    const b = binStl([T1], { header: "solid facet vertex", extra: 3 });
    expect(stlIsBinary(b)).toBe(true);
  });
});

const NS = 'xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02" xmlns:m="http://schemas.microsoft.com/3dmanufacturing/material/2015/02" xmlns:p="http://schemas.microsoft.com/3dmanufacturing/production/2015/06"';
const TRI_OBJ = (id: number, extra = "", tri = '<triangle v1="0" v2="1" v3="2"/>') =>
  `<object id="${id}" type="model"${extra}><mesh><vertices><vertex x="0" y="0" z="0"/><vertex x="1" y="0" z="0"/><vertex x="0" y="1" z="0"/></vertices><triangles>${tri}</triangles></mesh></object>`;
const RELS = (target: string) =>
  `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Target="${target}" Id="r0" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/></Relationships>`;

/** z of the normal of triangle `t` of a part: +1 when wound counter-clockwise seen from +z. */
function normalZ(p: { positions: Float32Array; indices: Uint32Array }, t = 0): number {
  const P = (i: number) => [p.positions[p.indices[t * 3 + i] * 3], p.positions[p.indices[t * 3 + i] * 3 + 1]];
  const [a, b, c] = [P(0), P(1), P(2)];
  return Math.sign((b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]));
}

describe("3MF read completeness", () => {
  it("finds the root model through _rels, whatever it is called, and reads metadata", async () => {
    const model = `<model unit="millimeter" ${NS}><metadata name="Title">Bracket &amp; clip</metadata><metadata name="Designer">A. Person</metadata><resources>${TRI_OBJ(1)}</resources><build><item objectid="1"/></build></model>`;
    const r = await parse3mf(await writeZip({ "_rels/.rels": RELS("/3D/Assembly.model"), "3D/Assembly.model": model, "3D/decoy.model": "<model/>" }));
    expect(r.parts).toHaveLength(1);
    expect(r.metadata).toEqual({ Title: "Bracket & clip", Designer: "A. Person" });
  });

  it("follows production-extension p:path components into other model parts", async () => {
    const root = `<model unit="millimeter" ${NS}><resources><object id="9" type="model"><components><component p:path="/3D/Objects/part.model" objectid="3" transform="1 0 0 0 1 0 0 0 1 5 0 0"/></components></object></resources><build><item objectid="9"/></build></model>`;
    const part = `<model unit="millimeter" ${NS}><resources>${TRI_OBJ(3)}</resources><build/></model>`;
    const r = await parse3mf(await writeZip({ "_rels/.rels": RELS("/3D/3dmodel.model"), "3D/3dmodel.model": root, "3D/Objects/part.model": part }));
    expect(r.parts).toHaveLength(1);
    expect(Array.from(r.parts[0].positions.subarray(0, 3))).toEqual([5, 0, 0]);
  });

  it("colours per triangle and per corner from colorgroups and basematerials", async () => {
    const res = `<m:colorgroup id="7"><m:color color="#FF0000"/><m:color color="#00FF00"/><m:color color="#0000FF"/></m:colorgroup><basematerials id="5"><base name="grey" displaycolor="#808080FF"/></basematerials>`;
    const tris = '<triangle v1="0" v2="1" v3="2" pid="7" p1="0" p2="1" p3="2"/><triangle v1="0" v2="2" v3="1"/>';
    const r = await parse3mf(await writeZip({ "3D/3dmodel.model": `<model ${NS}><resources>${res}${TRI_OBJ(1, ' pid="5" pindex="0"', tris)}</resources><build><item objectid="1"/></build></model>` }));
    const c = Array.from(r.parts[0].colors!);
    expect(c.slice(0, 9)).toEqual([255, 0, 0, 0, 255, 0, 0, 0, 255]); // per corner
    expect(c.slice(9, 12)).toEqual([128, 128, 128]); // the other triangle: the object's material
  });

  it("leaves support objects out, with a note", async () => {
    const model = `<model ${NS}><resources>${TRI_OBJ(1)}${TRI_OBJ(2).replace('type="model"', 'type="support"')}</resources><build><item objectid="1"/><item objectid="2"/></build></model>`;
    const r = await parse3mf(await writeZip({ "3D/3dmodel.model": model }));
    expect(r.parts).toHaveLength(1);
    expect(r.warnings.join()).toMatch(/1 support or non-model object was left out/);
  });

  it("keeps the outward winding under a mirroring build transform", async () => {
    const model = `<model ${NS}><resources>${TRI_OBJ(1)}</resources><build><item objectid="1" transform="-1 0 0 0 1 0 0 0 1 0 0 0"/></build></model>`;
    const plain = await parse3mf(await writeZip({ "3D/3dmodel.model": model.replace(' transform="-1 0 0 0 1 0 0 0 1 0 0 0"', "") }));
    const mirrored = await parse3mf(await writeZip({ "3D/3dmodel.model": model }));
    expect(normalZ(plain.parts[0])).toBe(1);
    expect(normalZ(mirrored.parts[0])).toBe(1);
  });

  it("names what it doesn't show: textures, beam lattices, slices", async () => {
    const model = `<model ${NS}><resources><m:texture2dgroup id="4" texid="1"/><object id="1" type="model"><mesh><vertices/><triangles/><b:beamlattice/></mesh></object><s:slicestack id="2"/></resources><build/></model>`;
    const r = await parse3mf(await writeZip({ "3D/3dmodel.model": model }));
    const w = r.warnings.join(" | ");
    expect(w).toMatch(/textures are not shown/);
    expect(w).toMatch(/beam lattices/);
    expect(w).toMatch(/slice data/);
  });

  it("matches part names case-insensitively, as OPC packages require", async () => {
    const model = `<model ${NS}><resources>${TRI_OBJ(1)}</resources><build><item objectid="1"/></build></model>`;
    const r = await parse3mf(await writeZip({ "_rels/.rels": RELS("/3d/3DMODEL.model"), "3D/3dmodel.model": model }));
    expect(r.parts).toHaveLength(1);
  });
});

describe("3MF / ZIP hostile input", () => {
  it("refuses XML entity declarations (billion laughs)", async () => {
    const model = `<?xml version="1.0"?><!DOCTYPE m [<!ENTITY a "aaaaaaaa"><!ENTITY b "&a;&a;&a;&a;">]><model ${NS}><resources/><build/></model>`;
    await expect(parse3mf(await writeZip({ "3D/3dmodel.model": model }))).rejects.toThrow(/entities/);
  });

  it("stops inflating a zip bomb at the limit instead of exhausting memory", async () => {
    const z = await writeZip({ "bomb.bin": new Uint8Array(2 * 1024 * 1024) });
    expect(z.length).toBeLessThan(20_000); // 2 MB of zeros deflates to a few kB
    const reader = openZip(z, { maxEntryBytes: 1024 * 1024 });
    await expect(reader.read("bomb.bin")).rejects.toThrow(/zip bomb/);
    expect((await openZip(z).read("bomb.bin"))!.length).toBe(2 * 1024 * 1024);
  });

  it("caps the total inflated across entries", async () => {
    const z = await writeZip({ "a.bin": new Uint8Array(600_000), "b.bin": new Uint8Array(600_000) });
    const reader = openZip(z, { maxTotalBytes: 1_000_000 });
    expect((await reader.read("a.bin"))!.length).toBe(600_000);
    await expect(reader.read("b.bin")).rejects.toThrow(/zip bomb/);
  });

  it("survives a component cycle", async () => {
    const model = `<model ${NS}><resources><object id="1" type="model"><components><component objectid="2"/></components></object><object id="2" type="model"><components><component objectid="1"/></components></object>${TRI_OBJ(3)}</resources><build><item objectid="1"/><item objectid="3"/></build></model>`;
    const r = await parse3mf(await writeZip({ "3D/3dmodel.model": model }));
    expect(r.parts).toHaveLength(1);
  });
});
