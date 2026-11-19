/**
 * Runs the real Draco decoder (three's bundled wasm) end to end: a
 * Draco-compressed GLB must come out as the same part as its uncompressed
 * original, or a compressed export previews as garbage. The model files are
 * real exports and stay out of the repo (CLAUDE.md), so the comparison runs
 * only where `public/demo-local/` holds them; the decoder itself always loads.
 */
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { gltfUsesDraco, parseAnyMesh } from "../../../core/src/mesh/parse2";
import { createDracoDecoder } from "./draco";

const here = dirname(fileURLToPath(import.meta.url));
// three's "exports" hides package.json; its main entry sits in build/.
const threeDir = join(dirname(createRequire(import.meta.url).resolve("three")), "..");
const lib = (f: string) => join(threeDir, "examples", "jsm", "libs", "draco", f);
const local = (f: string) => join(here, "..", "..", "public", "demo-local", f);

async function decoder() {
  const wasm = readFileSync(lib("draco_decoder.wasm"));
  return createDracoDecoder(
    readFileSync(lib("draco_wasm_wrapper.js"), "utf8"),
    wasm.buffer.slice(wasm.byteOffset, wasm.byteOffset + wasm.byteLength),
  );
}

function bounds(positions: Float32Array[]) {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (const p of positions)
    for (let i = 0; i < p.length; i += 3)
      for (let k = 0; k < 3; k++) {
        min[k] = Math.min(min[k], p[i + k]);
        max[k] = Math.max(max[k], p[i + k]);
      }
  return { min, max };
}

describe("Draco decoder", () => {
  it("compiles three's bundled decoder and rejects bytes that aren't Draco", async () => {
    const decode = await decoder();
    expect(() => decode(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]), { POSITION: 0 })).toThrow();
  });

  const compressed = local("draco-PRT.glb");
  const original = local("PRT-11742.glb");
  it.skipIf(!existsSync(compressed) || !existsSync(original))("decodes a real Draco GLB to the same part as the uncompressed export", async () => {
    const draco = await decoder();
    const cBytes = new Uint8Array(readFileSync(compressed));
    expect(gltfUsesDraco(cBytes)).toBe(true);
    const c = await parseAnyMesh("glb", cBytes, "c", { draco });
    const o = await parseAnyMesh("glb", new Uint8Array(readFileSync(original)), "o");
    expect(c.parts.length).toBeGreaterThan(0);
    expect(c.parts.every((p) => p.indices.length % 3 === 0 && p.indices.every((i) => i < p.positions.length / 3))).toBe(true);
    const bc = bounds(c.parts.map((p) => p.positions));
    const bo = bounds(o.parts.map((p) => p.positions));
    // Draco quantizes positions (and the web copy was decimated): same box within 0.5 % of its size.
    const size = Math.max(...bo.max.map((v, k) => v - bo.min[k]));
    for (let k = 0; k < 3; k++) {
      expect(Math.abs(bc.min[k] - bo.min[k])).toBeLessThan(size * 0.005);
      expect(Math.abs(bc.max[k] - bo.max[k])).toBeLessThan(size * 0.005);
    }
  });
});
