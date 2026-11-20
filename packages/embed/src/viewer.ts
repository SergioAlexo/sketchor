/**
 * The lazy half of `<sketchor-view>`: everything that needs three.js or a
 * parser. Imported with `import()` the first time an element loads a file.
 *
 * Parsing is the app's own path (F-05): core `parseAnyMesh` → `segmentMesh`
 * → `buildModel`, so faces, B-rep-style edges and colours come out exactly as
 * they do in a Sketchor model tab, and `buildModelObjects`/`buildLights` draw
 * them the same way (E-01: one renderer, three consumers).
 */
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { gltfUsesDraco, parseAnyMesh } from "../../core/src/mesh/parse2";
import { segmentMesh } from "../../core/src/mesh/segment";
import { buildModel } from "./three/buildModel";
import { buildLights, buildModelObjects, fitClipPlanes, framePerspective, STAGE_BACKGROUND, type ModelObjects } from "./three/modelScene";
import type { Model3D, OcctResult } from "./three/types";
import { reorientModel, type UpAxis } from "./three/upAxis";
import { atRest, spring, stepSpring, TURNTABLE_RAD_PER_S, type Spring } from "./motion";
import type { PreviewFormat } from "./load";

export async function parseModel(bytes: Uint8Array, name: string, format: PreviewFormat, up: UpAxis | "auto"): Promise<Model3D> {
  // Draco-compressed glTF: fetch the decoder (its own lazy chunk) only for files that need it.
  const draco = (format === "glb" || format === "gltf") && gltfUsesDraco(bytes) ? await (await import("./three/draco")).loadDracoDecoder() : undefined;
  const parsed = await parseAnyMesh(format, bytes, name.replace(/\.[^.]*$/, "") || "Part", { draco });
  const meshes = parsed.parts.map((p) => segmentMesh(p));
  const result: OcctResult = {
    success: true,
    meshes,
    root: meshes.length > 1 ? { name, children: meshes.map((m, i) => ({ name: m.name, meshes: [i] })) } : { name, meshes: [0] },
  };
  const model = buildModel(result, name, "embed", format);
  if (model.parts.length === 0) throw new Error("the file contains no triangles to show");
  const detected: UpAxis = format === "gltf" || format === "glb" ? "y" : "z";
  return reorientModel(model, up === "auto" ? detected : up);
}

export interface StageOptions {
  /** CSS colour, or null for a transparent canvas over the host page. */
  background: string | null;
  /** Edge-line colour (E-07 theme); the app's edge colour when omitted. */
  edge?: string;
  reducedMotion: boolean;
}

/** Seconds after a drag before the turntable takes over again. */
const RESUME_AFTER_S = 2;

export class Stage {
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera(32, 1, 0.1, 1000);
  private controls: OrbitControls;
  private pivot = new THREE.Group();
  private objects: ModelObjects | null = null;
  private radius = 1;
  private model: Model3D | null = null;
  private home = { position: new THREE.Vector3(), target: new THREE.Vector3(), up: new THREE.Vector3(0, 0, 1) };

  private intensity: Spring = spring(0, 64);
  private yawBias: Spring = spring(0, 30);
  private tiltBias: Spring = spring(0, 30);
  private yaw = 0;
  private playing = false;
  private dragging = false;
  private idleFor = Infinity;
  private visible = true;
  private running = false;
  private last = 0;
  private dirty = true;

  constructor(private canvas: HTMLCanvasElement, private opts: StageOptions) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: opts.background === null, powerPreference: "low-power" });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    if (opts.background === null) this.renderer.setClearColor(0x000000, 0);
    else this.scene.background = new THREE.Color(opts.background || STAGE_BACKGROUND);
    this.scene.add(this.pivot, ...buildLights(this.camera));
    this.camera.up.set(0, 0, 1);

    this.controls = new OrbitControls(this.camera, canvas);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.12;
    this.controls.enableZoom = false;
    this.controls.enablePan = false;
    this.controls.addEventListener("start", () => {
      this.dragging = true;
      this.wake();
    });
    this.controls.addEventListener("end", () => {
      this.dragging = false;
      this.idleFor = 0;
      this.wake();
    });
    this.controls.addEventListener("change", () => {
      this.dirty = true;
    });
  }

  /** Re-themes a live stage (E-07): background (null = transparent canvas) and edge colour. */
  setColors(background: string | null, edge?: string): void {
    this.opts = { ...this.opts, background, edge };
    if (background === null) {
      this.scene.background = null;
      this.renderer.setClearColor(0x000000, 0);
    } else this.scene.background = new THREE.Color(background || STAGE_BACKGROUND);
    if (edge && this.objects) (this.objects.edges.material as THREE.LineBasicMaterial).color.set(edge);
    this.wake();
  }

  setModel(model: Model3D): void {
    this.objects?.dispose();
    this.pivot.clear();
    this.model = model;
    this.objects = buildModelObjects(model);
    if (this.opts.edge) (this.objects.edges.material as THREE.LineBasicMaterial).color.set(this.opts.edge);
    const c = new THREE.Vector3(
      (model.bounds.min[0] + model.bounds.max[0]) / 2,
      (model.bounds.min[1] + model.bounds.max[1]) / 2,
      (model.bounds.min[2] + model.bounds.max[2]) / 2,
    );
    // Turn about the part's own centre, around world Z (up as displayed).
    this.pivot.position.copy(c);
    const b = model.bounds;
    this.radius = Math.hypot(b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2]) / 2 || 1;
    this.objects.group.position.copy(c).multiplyScalar(-1);
    this.pivot.add(this.objects.group);
    this.fit();
  }

  /** Frames the whole model from the isometric view and remembers that as "home". */
  fit(): void {
    if (!this.model) return;
    this.yaw = 0;
    this.pivot.rotation.set(0, 0, 0);
    const target = framePerspective(this.camera, this.model.bounds, "iso");
    this.controls.target.copy(target);
    this.controls.update();
    this.home.position.copy(this.camera.position);
    this.home.target.copy(target);
    this.wake();
  }

  reset(): void {
    this.intensity.x = this.intensity.v = 0;
    this.camera.position.copy(this.home.position);
    this.camera.up.copy(this.home.up);
    this.controls.target.copy(this.home.target);
    this.yaw = 0;
    this.pivot.rotation.set(0, 0, 0);
    this.controls.update();
    this.wake();
  }

  resize(width: number, height: number): void {
    if (width < 2 || height < 2) return;
    this.renderer.setSize(width, height, false);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.wake();
  }

  setPlaying(on: boolean): void {
    this.playing = on;
    this.intensity.target = on ? 1 : 0;
    this.wake();
  }

  /** Full view: zoom and pan join orbit. Inline previews keep the wheel for page scrolling. */
  setInteractive(full: boolean): void {
    this.controls.enableZoom = full;
    this.controls.enablePan = full;
  }

  /** Pointer position over the element, -1…1 each way; null when it leaves. */
  setPointer(p: { x: number; y: number } | null): void {
    if (this.opts.reducedMotion) return;
    this.yawBias.target = p ? p.x * 0.25 : 0;
    this.tiltBias.target = p ? -p.y * 0.12 : 0;
    this.wake();
  }

  setVisible(on: boolean): void {
    this.visible = on;
    if (on) this.wake();
  }

  private wake(): void {
    this.dirty = true;
    if (this.running || !this.visible) return;
    this.running = true;
    this.last = performance.now();
    this.renderer.setAnimationLoop((t) => this.frame(t));
  }

  private frame(now: number): void {
    const dt = Math.min((now - this.last) / 1000, 0.1);
    this.last = now;
    if (!this.dragging && this.idleFor < RESUME_AFTER_S) this.idleFor += dt;
    // While the user is orbiting (and for a moment after) the turntable yields.
    const handsOn = this.dragging || this.idleFor < RESUME_AFTER_S;
    this.intensity.target = this.playing && !handsOn ? 1 : 0;
    stepSpring(this.intensity, dt);
    stepSpring(this.yawBias, dt);
    stepSpring(this.tiltBias, dt);

    const t = now / 1000;
    const k = Math.max(0, this.intensity.x);
    this.yaw += k * TURNTABLE_RAD_PER_S * dt;
    // The pointer bias swings the part toward the cursor on top of the turntable, scaled by intensity
    // so a paused preview stays exactly where the user left it.
    this.pivot.rotation.z = this.yaw + this.yawBias.x * k;
    this.pivot.rotation.x = this.tiltBias.x * k + Math.sin(t * 0.45) * 0.035 * k;
    this.controls.update();

    this.fitClip();
    this.renderer.render(this.scene, this.camera);
    this.dirty = false;

    const moving = k > 1e-3 || !atRest(this.intensity) || !atRest(this.yawBias) || !atRest(this.tiltBias) || this.dragging;
    const damping = this.controls.enableDamping && this.idleFor < 1;
    if (!this.visible || (!moving && !damping && !this.dirty)) {
      this.running = false;
      this.renderer.setAnimationLoop(null);
    }
  }

  /** Clip planes hug the model each frame so zooming out keeps depth precision (edges on faces, not through them). */
  private fitClip(): void {
    fitClipPlanes(this.camera, this.pivot.position, this.radius);
  }

  /** A still frame, for the idle look before play. */
  renderOnce(): void {
    this.fitClip();
    this.renderer.render(this.scene, this.camera);
  }

  dispose(): void {
    this.renderer.setAnimationLoop(null);
    this.controls.dispose();
    this.objects?.dispose();
    this.renderer.dispose();
  }
}
