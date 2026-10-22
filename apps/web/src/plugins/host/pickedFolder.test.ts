import { describe, expect, it } from "vitest";
import { listDirectory, readPickedFile, splitRelPath, type DirHandleLike, type FileHandleLike } from "./pickedFolder";

/**
 * `ui.readPickedFile` takes a path from sandboxed plugin code. If it can walk
 * out of the picked folder the plugin reads arbitrary files; if the listing
 * has no cap, a cyclic or giant tree hangs the host. These pin both.
 */

type Tree = { [name: string]: string | Tree };

function fakeDir(tree: Tree, name = "root"): DirHandleLike & { name: string; kind: "directory" } {
  const file = (n: string, text: string): FileHandleLike => ({
    kind: "file",
    name: n,
    getFile: async () => {
      const buf = new TextEncoder().encode(text).buffer as ArrayBuffer;
      return { size: buf.byteLength, arrayBuffer: async () => buf };
    },
  });
  return {
    kind: "directory",
    name,
    async *values() {
      for (const [n, v] of Object.entries(tree)) yield typeof v === "string" ? file(n, v) : fakeDir(v, n);
    },
    async getDirectoryHandle(n: string) {
      const v = tree[n];
      if (typeof v !== "object") throw new Error("NotFound");
      return fakeDir(v, n);
    },
    async getFileHandle(n: string) {
      const v = tree[n];
      if (typeof v !== "string") throw new Error("NotFound");
      return file(n, v);
    },
  };
}

describe("listDirectory", () => {
  it("includes subfolders with / separated relative paths, sorted, with sizes", async () => {
    const root = fakeDir({ "b.dxf": "12345", sub: { "a.csv": "xy", deep: { "z.txt": "" } }, "a.dxf": "1" });
    const { files, truncated } = await listDirectory(root);
    expect(truncated).toBe(false);
    expect(files.map((f) => f.relPath)).toEqual(["a.dxf", "b.dxf", "sub/a.csv", "sub/deep/z.txt"]);
    expect(files.find((f) => f.relPath === "b.dxf")?.size).toBe(5);
  });

  it("an empty folder lists nothing", async () => {
    expect(await listDirectory(fakeDir({}))).toEqual({ files: [], truncated: false });
  });

  it("stops at the file cap and says so", async () => {
    const tree: Tree = {};
    for (let i = 0; i < 10; i++) tree[`f${i}.txt`] = "x";
    const { files, truncated } = await listDirectory(fakeDir(tree), { maxFiles: 4 });
    expect(files).toHaveLength(4);
    expect(truncated).toBe(true);
  });

  it("terminates on a cyclic tree via the depth cap", async () => {
    const loop: Tree = { "f.txt": "x" };
    loop.again = loop; // a junction pointing at its own parent
    const { files, truncated } = await listDirectory(fakeDir(loop), { maxDepth: 3 });
    expect(truncated).toBe(true);
    expect(files.length).toBeGreaterThan(0);
  });

  it("skips an unreadable directory instead of throwing", async () => {
    const root = fakeDir({ "a.txt": "x" });
    const orig = root.values.bind(root);
    const bad = {
      ...root,
      async *values() {
        yield* orig();
        yield { kind: "directory" as const, name: "locked", values: () => { throw new Error("EACCES"); } } as unknown as FileHandleLike;
      },
    };
    expect((await listDirectory(bad)).files.map((f) => f.relPath)).toEqual(["a.txt"]);
  });
});

describe("splitRelPath", () => {
  it("accepts nested relative paths and backslashes", () => {
    expect(splitRelPath("a/b/c.dxf")).toEqual(["a", "b", "c.dxf"]);
    expect(splitRelPath("a\\b.dxf")).toEqual(["a", "b.dxf"]);
  });
  it.each(["", "/etc/passwd", "\\x", "C:/x", "c:\\x", "../x", "a/../b", "a/./b", "a//b", "a/", ".", "..", "a\u0000b"])(
    "rejects %j",
    (p) => {
      expect(() => splitRelPath(p)).toThrow();
    },
  );
  it("rejects non-strings", () => {
    expect(() => splitRelPath(undefined as unknown as string)).toThrow();
  });
});

describe("readPickedFile", () => {
  const root = fakeDir({ "a.txt": "hello", sub: { "b.txt": "w\u00f6rld" } });
  it("reads text and bytes from nested paths", async () => {
    expect(await readPickedFile(root, "a.txt", "text")).toBe("hello");
    expect(await readPickedFile(root, "sub/b.txt", "text")).toBe("w\u00f6rld");
    const bytes = await readPickedFile(root, "a.txt", "bytes");
    expect(Array.from(bytes)).toEqual([104, 101, 108, 108, 111]);
  });
  it("rejects escapes and missing files", async () => {
    await expect(readPickedFile(root, "../a.txt", "text")).rejects.toThrow();
    await expect(readPickedFile(root, "nope.txt", "text")).rejects.toThrow();
    await expect(readPickedFile(root, "sub", "text")).rejects.toThrow();
  });
  it("round-trips every path the listing returned", async () => {
    const { files } = await listDirectory(root);
    for (const f of files) expect((await readPickedFile(root, f.relPath, "bytes")).length).toBe(f.size);
  });
});
