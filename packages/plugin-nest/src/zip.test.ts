import { describe, expect, it } from "vitest";
import { crc32, makeZip, readZip } from "./zip";

/**
 * A damaged ZIP is the failure the shop notices last: the per-sheet DXFs are
 * downloaded in one archive and a bad CRC or offset only shows up when CAM
 * refuses a file. Round-trip through our own central-directory reader.
 */
describe("zip", () => {
  const enc = new TextEncoder();

  it("crc32 matches the standard check value", () => {
    expect(crc32(enc.encode("123456789"))).toBe(0xcbf43926);
    expect(crc32(new Uint8Array(0))).toBe(0);
  });

  it("round-trips names and bytes, including binary", () => {
    const bin = Uint8Array.from({ length: 600 }, (_, i) => (i * 7) & 255);
    const files = [
      { name: "a.dxf", data: "0\r\nSECTION\r\n" },
      { name: "sub/b.bin", data: bin },
      { name: "empty.txt", data: "" },
    ];
    const got = readZip(makeZip(files))!;
    expect(got.map((g) => g.name)).toEqual(files.map((f) => f.name));
    expect(got[0].data).toEqual(enc.encode("0\r\nSECTION\r\n"));
    expect(got[1].data).toEqual(bin);
    expect(got[2].data.length).toBe(0);
    for (const g of got) expect(crc32(g.data)).toBe(g.crc);
  });

  it("an empty archive is just the end record and parses to no entries", () => {
    const z = makeZip([]);
    expect(z.length).toBe(22);
    expect(readZip(z)).toEqual([]);
  });

  it("flags UTF-8 only for non-ASCII names", () => {
    const got = readZip(makeZip([{ name: "plain.dxf", data: "x" }, { name: "лист-1.dxf", data: "y" }]))!;
    expect(got[0].utf8Flag).toBe(false);
    expect(got[1].utf8Flag).toBe(true);
    expect(got[1].name).toBe("лист-1.dxf");
  });

  it("readZip never throws on empty, truncated or garbage input", () => {
    const z = makeZip([{ name: "a", data: "hello" }]);
    expect(readZip(new Uint8Array(0))).toBeNull();
    expect(readZip(z.slice(0, 10))).toBeNull();
    expect(readZip(z.slice(0, z.length - 5))).toBeNull();
    expect(readZip(Uint8Array.from({ length: 200 }, (_, i) => i))).toBeNull();
  });
});
