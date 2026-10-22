import { describe, expect, it } from "vitest";
import { lookupFile, ocrDigits, resolveItem } from "./partLookup";

/**
 * RN-14: the file picked for a BOM line is the drawing that gets cut. A
 * "closest" guess would nest the wrong part without any error, so these pin
 * the strict precedence (exact > N-pieces > prefix+separator) and that a near
 * miss returns nothing.
 */
const files = (...names: string[]) => names.map((relPath) => ({ relPath }));

describe("lookupFile", () => {
  it("prefers an exact name, ignoring folders, case and extension", () => {
    const r = lookupFile("PN-0001", files("sub/PN-0001 rev A.dxf", "sub/pn-0001.DXF"));
    expect(r.how).toBe("exact");
    expect(r.file?.relPath).toBe("sub/pn-0001.DXF");
  });
  it.each([
    ["PN-0001-X5.dxf", 5],
    ["PN-0001 x5.dxf", 5],
    ["PN-0001_5.dxf", 5],
    ["PN-0001 (5).dxf", 5],
    ["PN-0001 5pcs.dxf", 5],
  ])("%s holds %i pieces", (name, per) => {
    const r = lookupFile("PN-0001", files(name));
    expect(r.per).toBe(per);
    expect(r.how).toBe("multi");
  });
  it("falls back to number + separator, shortest name first", () => {
    const r = lookupFile("PN-0001", files("PN-0001 long note here.dxf", "PN-0001 rev.dxf"));
    expect(r.how).toBe("prefix");
    expect(r.file?.relPath).toBe("PN-0001 rev.dxf");
  });
  it("never guesses: a longer number or glued suffix is not a match", () => {
    expect(lookupFile("PN-0001", files("PN-00012.dxf", "PN-0001A.dxf", "PN-0002.dxf")).file).toBeUndefined();
  });
  it("ignores non-dxf files and reports an empty folder", () => {
    expect(lookupFile("PN-0001", files("PN-0001.pdf")).file).toBeUndefined();
    expect(lookupFile("PN-0001", []).none).toBe(true);
    expect(lookupFile("PN-0001", null).none).toBe(true);
    expect(lookupFile("", files("a.dxf")).file).toBeUndefined();
  });
});

describe("resolveItem", () => {
  it("need is ceil(qty / per)", () => {
    const r = resolveItem("PN-0001", 11, files("PN-0001-X5.dxf"));
    expect(r.per).toBe(5);
    expect(r.need).toBe(3);
  });
  it("keeps need null when the quantity is unknown", () => {
    expect(resolveItem("PN-0001", null, files("PN-0001.dxf")).need).toBeNull();
  });
  it("repairs OCR look-alikes only when the literal number misses", () => {
    expect(ocrDigits("00000297l8")).toBe("0000029718");
    const r = resolveItem("00000297l8", 2, files("0000029718.dxf"));
    expect(r.file?.relPath).toBe("0000029718.dxf");
    expect(r.num).toBe("0000029718");
    const literal = resolveItem("00000297l8", 2, files("00000297l8.dxf", "0000029718.dxf"));
    expect(literal.num).toBe("00000297l8");
  });
  it("leaves ordinary part numbers alone and never throws", () => {
    expect(ocrDigits("PN-0001")).toBe("PN-0001");
    expect(ocrDigits(undefined as unknown as string)).toBe("");
    expect(resolveItem("", 1, undefined).file).toBeUndefined();
  });
});
