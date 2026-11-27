/**
 * Edges must sit just in front of the faces they bound without showing
 * through thin parts from behind. The bias is a fixed fraction of the model
 * size injected into the line shader; if the injection silently stops
 * matching three.js's chunk name, edges fall back to z-fighting the faces.
 */
import { describe, expect, it } from "vitest";
import * as THREE from "three";
import { biasEdgesTowardEye, buildModelObjects, edgeBiasFor, EDGE_BIAS_FRACTION, fitClipPlanes } from "./modelScene";
import { buildModel } from "./buildModel";

describe("edge depth bias", () => {
  it("scales with the model's bounding radius", () => {
    const b = edgeBiasFor({ min: [0, 0, 0], max: [300, 400, 0] }); // radius 250
    expect(b).toBeCloseTo(250 * EDGE_BIAS_FRACTION, 9);
  });

  it("is zero for empty or broken bounds (no shader patch at all)", () => {
    expect(edgeBiasFor({ min: [1, 1, 1], max: [1, 1, 1] })).toBe(0);
    expect(edgeBiasFor({ min: [0, 0, 0], max: [NaN, 0, 0] })).toBe(0);
    const m = new THREE.LineBasicMaterial();
    const before = m.onBeforeCompile;
    biasEdgesTowardEye(m, 0);
    expect(m.onBeforeCompile).toBe(before);
  });

  it("replaces three.js's project_vertex chunk with the biased projection", () => {
    const m = new THREE.LineBasicMaterial();
    biasEdgesTowardEye(m, 1.5);
    const shader = { uniforms: {} as Record<string, { value: unknown }>, vertexShader: "void main() {\n#include <project_vertex>\n}" };
    m.onBeforeCompile(shader as never, undefined as never);
    expect(shader.uniforms.sketchorEdgeBias.value).toBe(1.5);
    expect(shader.vertexShader).not.toContain("#include <project_vertex>");
    expect(shader.vertexShader).toContain("normalize( mvPosition.xyz ) * sketchorEdgeBias");
    expect(shader.vertexShader).toContain("projectionMatrix[ 3 ][ 3 ] == 1.0");
    // The real chunk must still exist under that name, or the replace above is a no-op in production.
    expect(THREE.ShaderLib.basic.vertexShader).toContain("#include <project_vertex>");
  });
});

describe("clip planes", () => {
  // Zoomed out, a near plane tied to `far` made the depth step ~20x the edge bias: edges z-fought faces.
  it("puts the near plane just in front of the model while the camera is outside it", () => {
    const cam = new THREE.PerspectiveCamera(45, 1, 0.1, 1000);
    cam.position.set(0, 0, 1000);
    fitClipPlanes(cam, new THREE.Vector3(), 100);
    expect(cam.near).toBeCloseTo(1000 - 105, 6);
    expect(cam.far).toBeCloseTo(1200, 6);
  });

  it("falls back to a tiny near plane inside the model, so nothing near the eye is clipped", () => {
    const cam = new THREE.PerspectiveCamera(45, 1, 0.1, 1000);
    cam.position.set(0, 0, 10);
    fitClipPlanes(cam, new THREE.Vector3(), 100);
    expect(cam.near).toBeLessThan(0.01);
    expect(cam.near).toBeGreaterThan(0);
    expect(cam.far).toBeCloseTo(210, 6);
  });
});

describe("wires (F-06)", () => {
  it("draws free curves with the edge material, and only when there are some", () => {
    const tri = { name: "t", attributes: { position: { array: [0, 0, 0, 1, 0, 0, 0, 1, 0] } }, index: { array: [0, 1, 2] } };
    const wires = Float32Array.from([0, 0, 0, 50, 0, 0, 50, 0, 0, 50, 20, 0]);
    const withWires = buildModel({ success: true, meshes: [tri], wires, root: { meshes: [0] } } as never, "w.3dm", "h", "3dm");
    expect(withWires.bounds.max).toEqual([50, 20, 0]);
    const o = buildModelObjects(withWires);
    expect(o.wires).not.toBeNull();
    expect(o.wires!.material).toBe(o.edges.material);
    expect(o.group.children).toContain(o.wires);
    o.dispose();
    const plain = buildModelObjects(buildModel({ success: true, meshes: [tri], root: { meshes: [0] } } as never, "t.3dm", "h", "3dm"));
    expect(plain.wires).toBeNull();
    // A ragged array (not whole segments) is ignored rather than drawn wrong.
    expect(buildModel({ success: true, meshes: [tri], wires: Float32Array.from([1, 2, 3, 4]) } as never, "r.3dm", "h", "3dm").wires).toBeUndefined();
  });
});
