import * as THREE from "three";
// The theme module directly, not the core barrel: the embed bundles this file and only needs the colours.
import type { Model3dTokens } from "../../../core/src/theme";
import { DEFAULT_DARK } from "../../../core/src/theme";
import type { Bounds3, Model3D } from "./types";

/**
 * three.js plumbing shared by the interactive viewer and the thumbnail
 * renderer, so a card preview and the opened model look the same: one
 * merged mesh with baked vertex colours, one line-segments object for the
 * B-rep edges, a headlight rig, and a CAD-style isometric framing.
 *
 * Z is up. That's the STEP convention (and Onshape's), and it is what the
 * view presets assume.
 */

function hexToInt(hex: string): number {
  return parseInt(hex.replace("#", ""), 16);
}

function hexToRgb255(hex: string): [number, number, number] {
  const n = hexToInt(hex);
  return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
}

// Z-03: mutable, starting from `DEFAULT_DARK.model3d` (today's hard-coded
// values) so the first frame before the theme store's init effect runs still
// renders exactly as before. `setModel3dTheme` is the only writer (see
// `apps/web/src/theme/themeStore.ts`); a part's own colour is unaffected
// (baked at import time — see theme.ts's module doc).
export let STAGE_BACKGROUND = hexToInt(DEFAULT_DARK.model3d.bg);
export let EDGE_COLOR = hexToInt(DEFAULT_DARK.model3d.edge);
export let SELECT_COLOR: [number, number, number] = hexToRgb255(DEFAULT_DARK.model3d.highlight);
export let HOVER_COLOR: [number, number, number] = hexToRgb255(DEFAULT_DARK.model3d.hover);

export function setModel3dTheme(tokens: Model3dTokens): void {
  STAGE_BACKGROUND = hexToInt(tokens.bg);
  EDGE_COLOR = hexToInt(tokens.edge);
  SELECT_COLOR = hexToRgb255(tokens.highlight);
  HOVER_COLOR = hexToRgb255(tokens.hover);
}

export type ViewPreset = "iso" | "top" | "front" | "right" | "back" | "left" | "bottom";

/** Unit view directions (from the model toward the camera), Z up. */
const VIEW_DIR: Record<ViewPreset, [number, number, number]> = {
  iso: [1, -1, 1],
  top: [0, 0, 1],
  bottom: [0, 0, -1],
  front: [0, -1, 0],
  back: [0, 1, 0],
  right: [1, 0, 0],
  left: [-1, 0, 0],
};

/** Camera "up" per preset — Z, except when looking straight along Z. */
function viewUp(preset: ViewPreset): THREE.Vector3 {
  if (preset === "top") return new THREE.Vector3(0, 1, 0);
  if (preset === "bottom") return new THREE.Vector3(0, -1, 0);
  return new THREE.Vector3(0, 0, 1);
}

export function viewDirection(preset: ViewPreset): THREE.Vector3 {
  return new THREE.Vector3(...VIEW_DIR[preset]).normalize();
}

export interface ModelObjects {
  group: THREE.Group;
  mesh: THREE.Mesh;
  edges: THREE.LineSegments;
  /** F-06: free curves and points, sharing the edge material (so the theme recolours both). */
  wires: THREE.LineSegments | null;
  geometry: THREE.BufferGeometry;
  edgeGeometry: THREE.BufferGeometry;
  dispose(): void;
}

/**
 * Builds the renderable objects for a model. The colour attribute is a
 * *copy* of the model's, so selection highlighting can write into it and
 * restore from the model's pristine array.
 */
export function buildModelObjects(model: Model3D): ModelObjects {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(model.positions, 3));
  geometry.setAttribute("normal", new THREE.BufferAttribute(model.normals, 3));
  geometry.setAttribute("color", new THREE.BufferAttribute(model.colors.slice(), 3, true));
  geometry.setIndex(new THREE.BufferAttribute(model.indices, 1));
  geometry.boundingBox = toBox3(model.bounds);
  geometry.boundingSphere = geometry.boundingBox.getBoundingSphere(new THREE.Sphere());

  const material = new THREE.MeshLambertMaterial({
    vertexColors: true,
    side: THREE.DoubleSide,
    // Push faces back a hair so coplanar edge lines win the depth test. The
    // slope-scaled part is kept small: at grazing angles it grows without
    // bound and pushed a thin plate's front face behind the edges on its back,
    // so hidden edges showed through. `biasEdgesTowardEye` does the rest.
    polygonOffset: true,
    polygonOffsetFactor: 0.5,
    polygonOffsetUnits: 1,
  });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.frustumCulled = false;

  const edgeGeometry = new THREE.BufferGeometry();
  edgeGeometry.setAttribute("position", new THREE.BufferAttribute(model.edges, 3));
  edgeGeometry.boundingBox = geometry.boundingBox;
  edgeGeometry.boundingSphere = geometry.boundingSphere;
  const edgeMaterial = new THREE.LineBasicMaterial({ color: EDGE_COLOR });
  biasEdgesTowardEye(edgeMaterial, edgeBiasFor(model.bounds));
  const edges = new THREE.LineSegments(edgeGeometry, edgeMaterial);
  edges.frustumCulled = false;

  let wires: THREE.LineSegments | null = null;
  if (model.wires && model.wires.length >= 6) {
    const wg = new THREE.BufferGeometry();
    wg.setAttribute("position", new THREE.BufferAttribute(model.wires, 3));
    wg.boundingBox = geometry.boundingBox;
    wg.boundingSphere = geometry.boundingSphere;
    wires = new THREE.LineSegments(wg, edgeMaterial);
    wires.frustumCulled = false;
  }

  const group = new THREE.Group();
  group.add(mesh, edges);
  if (wires) group.add(wires);
  return {
    group,
    mesh,
    edges,
    wires,
    geometry,
    edgeGeometry,
    dispose() {
      geometry.dispose();
      edgeGeometry.dispose();
      wires?.geometry.dispose();
      material.dispose();
      (edges.material as THREE.Material).dispose();
    },
  };
}

/** Fraction of the model's bounding radius that edges are drawn in front of the faces they sit on. */
export const EDGE_BIAS_FRACTION = 0.003;

/** Edge depth bias in model units (mm) for a model of these bounds. */
export function edgeBiasFor(bounds: Bounds3): number {
  const dx = bounds.max[0] - bounds.min[0];
  const dy = bounds.max[1] - bounds.min[1];
  const dz = bounds.max[2] - bounds.min[2];
  const radius = Math.hypot(dx, dy, dz) / 2;
  return Number.isFinite(radius) && radius > 0 ? radius * EDGE_BIAS_FRACTION : 0;
}

/**
 * Moves each edge vertex `bias` model units toward the eye before
 * projection, so a B-rep edge wins against the faces it bounds by a fixed
 * *world* distance. Unlike a slope-scaled polygon offset this doesn't grow at
 * grazing angles, so edges on the far side of a thin part (a 3 mm plate, the
 * back of a sign) stay hidden behind its near face. Perspective cameras pull
 * along the view ray, orthographic ones along view Z.
 */
export function biasEdgesTowardEye(material: THREE.Material, bias: number): void {
  if (!(bias > 0)) return;
  material.onBeforeCompile = (shader) => {
    shader.uniforms.sketchorEdgeBias = { value: bias };
    shader.vertexShader =
      "uniform float sketchorEdgeBias;\n" +
      shader.vertexShader.replace(
        "#include <project_vertex>",
        [
          "vec4 mvPosition = modelViewMatrix * vec4( transformed, 1.0 );",
          "if ( projectionMatrix[ 3 ][ 3 ] == 1.0 ) mvPosition.z += sketchorEdgeBias;",
          "else mvPosition.xyz -= normalize( mvPosition.xyz ) * sketchorEdgeBias;",
          "gl_Position = projectionMatrix * mvPosition;",
        ].join("\n"),
      );
  };
  // Distinct programs per material kind, not per bias value (the bias is a uniform).
  material.customProgramCacheKey = () => "sketchor-edge-bias";
}

/** A headlight rig: soft sky/ground fill plus a key light that follows the camera. */
export function buildLights(camera: THREE.Camera): THREE.Object3D[] {
  const hemi = new THREE.HemisphereLight(0xffffff, 0x666a72, 1.1);
  hemi.position.set(0, 0, 1);
  const key = new THREE.DirectionalLight(0xffffff, 1.6);
  key.position.set(0.6, 0.8, 1.2);
  // Parenting the key light *and its target* to the camera makes it a
  // headlight — the model is always lit from where you look, so no view is
  // ever in shadow. (A directional light shines toward its target, which
  // must be in the scene graph to follow the camera.)
  key.target.position.set(0, 0, -1);
  camera.add(key, key.target);
  return [hemi, camera];
}

export function toBox3(b: Bounds3): THREE.Box3 {
  return new THREE.Box3(new THREE.Vector3(...b.min), new THREE.Vector3(...b.max));
}

/**
 * Points an orthographic camera at `bounds` from `preset` and sizes its
 * frustum so the model's projected extent fits with `padding` (fraction of
 * the larger side) to spare. Used for thumbnails and the view presets.
 */
export function frameOrthographic(
  camera: THREE.OrthographicCamera,
  bounds: Bounds3,
  preset: ViewPreset,
  aspect: number,
  padding = 0.08,
): void {
  const box = toBox3(bounds);
  const center = box.getCenter(new THREE.Vector3());
  const radius = Math.max(box.getSize(new THREE.Vector3()).length() / 2, 1e-3);
  const dir = viewDirection(preset);
  camera.up.copy(viewUp(preset));
  camera.position.copy(center).addScaledVector(dir, radius * 4);
  camera.lookAt(center);
  camera.updateMatrixWorld();

  // Project the eight corners to find the true screen-space extent — tighter
  // than the bounding sphere, which wastes a third of a thumbnail.
  const view = camera.matrixWorldInverse;
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  const p = new THREE.Vector3();
  for (let i = 0; i < 8; i++) {
    p.set(i & 1 ? box.max.x : box.min.x, i & 2 ? box.max.y : box.min.y, i & 4 ? box.max.z : box.min.z);
    p.applyMatrix4(view);
    if (p.x < minX) minX = p.x;
    if (p.x > maxX) maxX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.y > maxY) maxY = p.y;
  }
  const w = Math.max(maxX - minX, 1e-3);
  const h = Math.max(maxY - minY, 1e-3);
  const halfW = (Math.max(w, h * aspect) / 2) * (1 + padding);
  const halfH = halfW / aspect;
  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;
  camera.left = cx - halfW;
  camera.right = cx + halfW;
  camera.top = cy + halfH;
  camera.bottom = cy - halfH;
  camera.near = 0.01 * radius;
  camera.far = radius * 10;
  camera.updateProjectionMatrix();
}

/**
 * Fits a perspective camera's clip planes around a model's bounding sphere,
 * for every frame. Depth precision goes as near/z², so the near plane must
 * sit as far out as it can: just in front of the sphere while the camera is
 * outside it. A near plane tied to `far` (or fixed at framing time) leaves
 * the depth step bigger than the edge bias once you zoom out, and the B-rep
 * edges z-fight the faces they lie on — the "noise" on a zoomed-out model.
 * Inside the sphere it falls back to a tiny fraction of `far`, so nothing
 * close to the eye is clipped.
 */
export function fitClipPlanes(camera: THREE.PerspectiveCamera, center: THREE.Vector3, radius: number): void {
  const r = Math.max(radius, 1e-3);
  const dist = camera.position.distanceTo(center);
  const far = dist + r * 2;
  const outside = dist - r * 1.05;
  camera.far = far;
  camera.near = Math.max(outside, far * 1e-5, 1e-4);
  camera.updateProjectionMatrix();
}

/**
 * Places a perspective camera to see all of `bounds` — from a preset, or
 * along an explicit unit direction (model → camera) to keep the user's
 * current orbit — and returns the orbit target (the box centre).
 */
export function framePerspective(
  camera: THREE.PerspectiveCamera,
  bounds: Bounds3,
  from: ViewPreset | THREE.Vector3,
): THREE.Vector3 {
  const box = toBox3(bounds);
  const center = box.getCenter(new THREE.Vector3());
  const radius = Math.max(box.getSize(new THREE.Vector3()).length() / 2, 1e-3);
  const fov = (camera.fov * Math.PI) / 180;
  const fitH = radius / Math.sin(fov / 2);
  const fitW = radius / Math.sin(Math.atan(Math.tan(fov / 2) * camera.aspect));
  const dist = Math.max(fitH, fitW) * 1.05;
  const dir = from instanceof THREE.Vector3 ? from : viewDirection(from);
  if (!(from instanceof THREE.Vector3)) camera.up.copy(viewUp(from));
  camera.position.copy(center).addScaledVector(dir, dist);
  camera.near = Math.max(dist / 1000, 1e-3);
  camera.far = dist * 20 + radius * 4;
  camera.lookAt(center);
  camera.updateProjectionMatrix();
  return center;
}
