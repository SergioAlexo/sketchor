/**
 * The model cache decides what a returning visitor sees. A key that ignores
 * the up axis or format shows a part lying on its side; one built from the
 * URL shows yesterday's file after a re-upload; eviction that picks the wrong
 * entries lets one site fill the visitor's disk. The IndexedDB calls fail
 * soft and aren't exercised here (node has no IndexedDB) — these are the
 * decisions behind them.
 */
import { describe, expect, it } from "vitest";
import { cacheKey, CACHE_VERSION, getCachedModel, modelBytes, pickEvictions, putCachedModel, sha256Hex } from "./modelCache";

describe("cache keys", () => {
  it("depend on content, format and up axis, not on where the file came from", async () => {
    const a = await sha256Hex(new TextEncoder().encode("solid a"));
    const b = await sha256Hex(new TextEncoder().encode("solid b"));
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(a).not.toBe(b);
    expect(cacheKey(a, "stl", "z")).not.toBe(cacheKey(a, "stl", "y"));
    expect(cacheKey(a, "stl", "z")).not.toBe(cacheKey(a, "obj", "z"));
    expect(cacheKey(a, "stl", "z").startsWith(`${CACHE_VERSION}:`)).toBe(true);
  });
});

describe("modelBytes", () => {
  it("counts every typed array once, however deep", () => {
    const shared = new Float32Array(10); // 40 bytes
    const m = { positions: new Float32Array(3), faces: { area: new Float64Array(2), ref: shared }, parts: [{ range: new Uint32Array(4) }], again: shared, name: "x" };
    expect(modelBytes(m)).toBe(12 + 16 + 40 + 16);
  });
});

describe("pickEvictions", () => {
  const e = (key: string, bytes: number, at: number) => ({ key, bytes, at });
  it("keeps everything that fits", () => {
    expect(pickEvictions([e("a", 10, 1), e("b", 10, 2)], 5, 100)).toEqual([]);
  });
  it("drops the oldest first until both the count and the byte limit hold", () => {
    expect(pickEvictions([e("new", 10, 9), e("old", 10, 1), e("mid", 10, 5)], 2, 100)).toEqual(["old"]);
    expect(pickEvictions([e("new", 60, 9), e("old", 30, 1), e("mid", 30, 5)], 10, 70)).toEqual(["old", "mid"]);
  });
});

describe("without IndexedDB", () => {
  it("misses and stores nothing, without throwing", async () => {
    expect(await getCachedModel("1:stl:z:00")).toBeNull();
    await expect(putCachedModel("1:stl:z:00", {} as never)).resolves.toBeUndefined();
  });
});
