/**
 * The parse worker hands the model back by transferring its buffers, and a
 * page without workers must still get a preview. A missed buffer means a
 * full copy of a large model on the main thread (the jank the worker exists
 * to avoid); a fallback that throws means a blank preview.
 */
import { describe, expect, it } from "vitest";
import { transferablesOf } from "./parse";
import { parseOffThread, workerDisabled } from "./parseClient";

describe("transferablesOf", () => {
  it("lists each buffer once, however deep or shared", () => {
    const a = new Float32Array(4);
    const shared = new Uint32Array(8);
    const view = new Uint8Array(shared.buffer, 4, 4); // same buffer, different view
    const bufs = transferablesOf({ a, nested: { list: [shared, { view }] }, again: a, name: "x", n: 3 });
    expect(bufs).toHaveLength(2);
    expect(bufs).toContain(a.buffer);
    expect(bufs).toContain(shared.buffer);
  });
});

describe("parseOffThread without Worker", () => {
  it("parses on the main thread instead", async () => {
    expect(workerDisabled).toBe(true); // node has no Worker
    const stl = new TextEncoder().encode(
      "solid t\nfacet normal 0 0 1\nouter loop\nvertex 0 0 0\nvertex 10 0 0\nvertex 0 10 0\nendloop\nendfacet\nendsolid t\n",
    );
    const m = await parseOffThread(stl, "t.stl", "stl", "auto");
    expect(m.parts.length).toBe(1);
  });
});
