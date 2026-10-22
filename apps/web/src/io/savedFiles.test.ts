import { describe, expect, it, vi } from "vitest";
import { TextCache, dirOf, emitFileSaved, entryMatchesSaved, normPath, onFileSaved, samePath } from "./savedFiles";

/**
 * Regression cover for "file browser shows stale content after save": the
 * browser's text cache must be droppable per entry, an in-flight pre-save
 * read must not repopulate it, and a save must be matched to the right entry.
 */
describe("TextCache", () => {
  it("returns what was set and forgets after invalidate", () => {
    const c = new TextCache();
    c.set("a", "old");
    expect(c.get("a")).toBe("old");
    c.invalidate("a");
    expect(c.get("a")).toBeUndefined();
  });

  it("invalidating one key leaves the others", () => {
    const c = new TextCache();
    c.set("a", "1");
    c.set("b", "2");
    c.invalidate("a");
    expect(c.get("b")).toBe("2");
  });

  it("drops a read that started before the invalidation", () => {
    const c = new TextCache();
    const g = c.generation("a"); // read begins
    c.invalidate("a"); // save lands meanwhile
    expect(c.set("a", "stale", g)).toBe(false);
    expect(c.get("a")).toBeUndefined();
    expect(c.set("a", "fresh")).toBe(true);
    expect(c.get("a")).toBe("fresh");
  });
});

describe("paths", () => {
  it("compares ignoring slash style, case and trailing slash", () => {
    expect(samePath("C:\\Dir\\A.dxf", "c:/dir/a.dxf")).toBe(true);
    expect(samePath("C:\\Dir\\A.dxf", "c:/dir/b.dxf")).toBe(false);
    expect(samePath(undefined, "x")).toBe(false);
    expect(normPath("C:\\x\\")).toBe("c:/x");
  });
  it("finds the directory", () => {
    expect(dirOf("C:\\a\\b\\c.dxf")).toBe("C:/a/b");
    expect(dirOf("c.dxf")).toBe("");
  });
});

describe("entryMatchesSaved", () => {
  it("matches by path", async () => {
    expect(await entryMatchesSaved({ name: "a.dxf", path: "C:\\x\\a.dxf" }, { name: "a.dxf", path: "c:/x/a.dxf" })).toBe(true);
    expect(await entryMatchesSaved({ name: "a.dxf", path: "C:\\x\\a.dxf" }, { name: "a.dxf", path: "c:/y/a.dxf" })).toBe(false);
  });
  it("uses isSameEntry for handles", async () => {
    const saved = { name: "a.dxf", handle: { tag: 1 } };
    const same = { name: "a.dxf", handle: { isSameEntry: async (o: unknown) => o === saved.handle } };
    const other = { name: "a.dxf", handle: { isSameEntry: async () => false } };
    expect(await entryMatchesSaved(same, saved)).toBe(true);
    expect(await entryMatchesSaved(other, saved)).toBe(false);
  });
  it("falls back to the name when isSameEntry is missing or throws", async () => {
    const saved = { name: "a.dxf", handle: {} };
    expect(await entryMatchesSaved({ name: "a.dxf", handle: {} }, saved)).toBe(true);
    expect(await entryMatchesSaved({ name: "b.dxf", handle: {} }, saved)).toBe(false);
    const throwing = {
      name: "a.dxf",
      handle: {
        isSameEntry: async () => {
          throw new Error("x");
        },
      },
    };
    expect(await entryMatchesSaved(throwing, saved)).toBe(true);
  });
  it("never matches an entry with no comparable source", async () => {
    expect(await entryMatchesSaved({ name: "a.dxf" }, { name: "a.dxf", path: "x" })).toBe(false);
  });
});

describe("save bus", () => {
  it("delivers to subscribers, stops after unsubscribe, survives a throwing listener", () => {
    const got = vi.fn();
    const off1 = onFileSaved(() => {
      throw new Error("boom");
    });
    const off2 = onFileSaved(got);
    emitFileSaved({ name: "a.dxf", path: "p" });
    expect(got).toHaveBeenCalledTimes(1);
    off1();
    off2();
    emitFileSaved({ name: "a.dxf" });
    expect(got).toHaveBeenCalledTimes(1);
  });
});
