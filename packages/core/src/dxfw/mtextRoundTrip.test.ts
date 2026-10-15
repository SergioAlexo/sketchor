/**
 * D-10 (MTEXT): what breaks in a user's drawing if this regresses - formatted
 * notes coming back as flat single-line text, a wrap width or attachment
 * lost, long notes truncated at DXF's 250-character chunk limit, or a file in
 * inches whose note comes back 25.4x off. R12 has no MTEXT worth writing and
 * must still show the text.
 */
import { describe, expect, it } from "vitest";
import { parseDxf } from "../dxf";
import { entitiesToDxf } from "../dxfExport";
import type { Entity, MTextEntity } from "../entities";
import "../kinds/builtin";
import { entitiesToDxf2018 } from "./index";

const M = (over: Partial<MTextEntity> = {}): MTextEntity => ({
  id: "mt1",
  type: "mtext",
  at: { x: 10, y: 20 },
  width: 40,
  attachment: 5,
  text: "{\\fArial|b1|i0|c0|p0;Bold} note\\Psecond \\S1/2; line \\L\u0416\u0443\u043a\\l",
  height: 2.5,
  rotation: Math.PI / 6,
  style: "Standard",
  lineSpacing: 1.25,
  layer: "Notes",
  ...over,
});

const back = (e: Entity[], opts: Parameters<typeof entitiesToDxf2018>[1] = {}) => parseDxf(entitiesToDxf2018(e, opts)).entities;

describe("MTEXT in AC1032", () => {
  it("writes a real MTEXT record and reads it back unchanged", () => {
    const dxf = entitiesToDxf2018([M()]);
    expect(dxf).toContain("MTEXT");
    expect(dxf).toContain("AcDbMText");
    const [r] = back([M()]) as MTextEntity[];
    expect(r.type).toBe("mtext");
    expect(r.text).toBe(M().text);
    expect(r).toMatchObject({ width: 40, attachment: 5, height: 2.5, lineSpacing: 1.25, layer: "Notes" });
    expect(r.rotation).toBeCloseTo(Math.PI / 6, 9);
    expect(r.at.x).toBeCloseTo(10, 9);
  });

  it("splits a long note into 250-character chunks without losing or splitting a code", () => {
    const text = "ab\\P".repeat(200) + "tail\\";
    const dxf = entitiesToDxf2018([M({ text })]);
    expect(dxf.split("\n3\n").length).toBeGreaterThan(2);
    const [r] = back([M({ text })]) as MTextEntity[];
    expect(r.text).toBe(text);
  });

  it("keeps the background mask (colour + border factor)", () => {
    const [r] = back([M({ background: { color: "#ffee00", scale: 1.2 } })]) as MTextEntity[];
    expect(r.background).toEqual({ color: "#ffee00", scale: 1.2 });
    const [w] = back([M({ background: {} })]) as MTextEntity[];
    expect(w.background).toBeDefined();
    expect(w.background?.color).toBeUndefined();
    expect((back([M()])[0] as MTextEntity).background).toBeUndefined();
  });

  it("scales with the file unit (inches in, mm out)", () => {
    const [r] = back([M({ at: { x: 25.4, y: 0 }, width: 25.4, height: 2.54 })], { insUnits: 1, scale: 1 / 25.4 }) as MTextEntity[];
    expect(r.at.x).toBeCloseTo(25.4, 6);
    expect(r.width).toBeCloseTo(25.4, 6);
    expect(r.height).toBeCloseTo(2.54, 6);
  });

  it("survives inside a block definition", () => {
    const out = parseDxf(entitiesToDxf2018([{ id: "i", type: "insert", name: "NOTE", insert: { x: 0, y: 0 }, scale: { x: 1, y: 1 }, rotation: 0 } as Entity], {
      blocks: [{ name: "NOTE", basePoint: { x: 0, y: 0 }, entities: [M()], attributeDefs: [], explodable: true, scaleUniformly: false }],
    }));
    expect(out.blocks[0].entities[0].type).toBe("mtext");
  });

  it("R12 shows the text as plain TEXT, never MTEXT", () => {
    const dxf = entitiesToDxf([M()]);
    expect(dxf).not.toContain("MTEXT");
    expect(dxf).toContain("TEXT");
    expect(dxf).toContain("Bold");
  });

  it("reads an empty and a malformed MTEXT without throwing", () => {
    const base = "0\nSECTION\n2\nENTITIES\n0\nMTEXT\n8\n0\n10\n0\n20\n0\n40\n2\n";
    for (const body of ["1\n\n", "1\n{\\\n", "71\n99\n1\nx\n", "11\n0\n21\n1\n1\nx\n"]) {
      expect(() => parseDxf(`${base}${body}0\nENDSEC\n0\nEOF\n`)).not.toThrow();
    }
    const [r] = parseDxf(`${base}11\n0\n21\n1\n1\nx\n0\nENDSEC\n0\nEOF\n`).entities as MTextEntity[];
    expect(r.rotation).toBeCloseTo(Math.PI / 2, 9); // direction vector (0,1), no group 50
  });
});
