/**
 * The lazy half of `<sketchor-view>`: everything that needs three.js or a
 * parser. Imported with `import()` the first time an element loads a file.
 *
 * Parsing (parse.ts) runs in a worker (parseClient.ts); this module draws the
 * result with `buildModelObjects`/`buildLights`, exactly as a Sketchor model
 * tab does (E-01: one renderer, three consumers).
 */
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { buildLights, buildModelObjects, fitClipPlanes, framePerspective, STAGE_BACKGROUND, type ModelObjects } from "./three/modelScene";
import type { Model3D } from "./three/types";
import { edgePoints, vertexPoint, type Measurement, type SelRef } from "./three/measure";
import { pickEdge, pickVertex, type Projector } from "./three/picking";
import { faceTrianglePositions, measureForEmbed, nextSelection, partOfTriangle } from "./measureView";
import { atRest, spring, stepSpring, TURNTABLE_RAD_PER_S, type Spring } from "./motion";

export interface StageOptions {
  /** CSS colour, or null for a transparent canvas over the host page. */
  background: string | null;
  /** Edge-line colour (E-07 theme); the app's edge colour when omitted. */
  edge?: string;
  /** Selection highlight colour (E-06), the theme accent. */
  accent?: string;
  reducedMotion: boolean;
}

/** Seconds after a drag before the turntable takes over again. */
const RESUME_AFTER_S = 2;

export class Stage {
  readonly kind = "3d" as const;
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

  // E-06: click-to-measure in full view.
  private interactive = false;
  private selection: SelRef[] = [];
  private overlay = new THREE.Group();
  private raycaster = new THREE.Raycaster();
  private down: { x: number; y: number; t: number } | null = null;
  /** Called with the readout after every selection change (null = nothing selected). */
  onMeasure: ((m: Measurement | null) => void) | null = null;

  private onDown = (e: PointerEvent) => {
    this.down = e.button === 0 && e.isPrimary ? { x: e.clientX, y: e.clientY, t: performance.now() } : null;
  };
  private onUp = (e: PointerEvent) => {
    const d = this.down;
    this.down = null;
    if (!d || !this.interactive || !this.model) return;
    // A click, not the end of an orbit drag.
    if (Math.hypot(e.clientX - d.x, e.clientY - d.y) > 5 || performance.now() - d.t > 600) return;
    this.pickAt(e.clientX, e.clientY, e.shiftKey || e.ctrlKey || e.metaKey, e.pointerType === "touch");
  };

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
    canvas.addEventListener("pointerdown", this.onDown);
    canvas.addEventListener("pointerup", this.onUp);
    this.overlay.renderOrder = 10;
  }

  /** Re-themes a live stage (E-07): background (null = transparent canvas) and edge colour. */
  setColors(background: string | null, edge?: string, accent?: string): void {
    this.opts = { ...this.opts, background, edge, accent: accent ?? this.opts.accent };
    if (this.selection.length) this.showSelection();
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
    this.selection = [];
    this.clearOverlay();
    this.objects.group.add(this.overlay);
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
    this.interactive = full;
    if (!full) this.clearSelection();
  }

  /** Drops the measurement; true when there was one (so Esc can clear it before closing full view). */
  clearSelection(): boolean {
    if (!this.selection.length) return false;
    this.selection = [];
    this.showSelection();
    return true;
  }

  /**
   * The app's rule: within a few pixels a vertex beats an edge beats the
   * face under the cursor, and only the part the ray hit competes, so a
   * click never grabs an edge on the far side of the solid.
   */
  private pickAt(clientX: number, clientY: number, additive: boolean, touch: boolean): void {
    const model = this.model;
    const objects = this.objects;
    if (!model || !objects) return;
    const rect = this.canvas.getBoundingClientRect();
    const cursor = { x: clientX - rect.left, y: clientY - rect.top };
    this.scene.updateMatrixWorld(true);
    this.raycaster.setFromCamera(new THREE.Vector2((cursor.x / rect.width) * 2 - 1, -(cursor.y / rect.height) * 2 + 1), this.camera);
    const hit = this.raycaster.intersectObject(objects.mesh, false)[0];
    let ref: SelRef | null = null;
    if (hit && hit.faceIndex != null) {
      const toWorld = objects.group.matrixWorld;
      const v = new THREE.Vector3();
      const project: Projector = (p) => {
        v.set(p[0], p[1], p[2]).applyMatrix4(toWorld);
        const depth = v.distanceTo(this.camera.position);
        v.project(this.camera);
        return { x: ((v.x + 1) / 2) * rect.width, y: ((1 - v.y) / 2) * rect.height, visible: v.z < 1, depth };
      };
      const tolPx = touch ? 14 : 7;
      const worldPerPx = (2 * hit.distance * Math.tan((this.camera.fov * Math.PI) / 360)) / Math.max(rect.height, 1);
      const opts = { tolPx, maxDepth: hit.distance + worldPerPx * (tolPx + 2) };
      const part = partOfTriangle(model, hit.faceIndex);
      const vtx = part >= 0 ? pickVertex(model, part, cursor, project, opts) : null;
      const edge = vtx === null && part >= 0 ? pickEdge(model, part, cursor, project, opts) : null;
      ref =
        vtx !== null
          ? { kind: "vertex", index: vtx }
          : edge !== null
            ? { kind: "edge", index: edge }
            : { kind: "face", index: model.faceOfTriangle[hit.faceIndex] ?? 0 };
    }
    this.selection = nextSelection(this.selection, ref, additive);
    this.showSelection();
  }

  private clearOverlay(): void {
    for (const child of [...this.overlay.children]) {
      const o = child as THREE.Mesh;
      o.geometry?.dispose();
      (o.material as THREE.Material | undefined)?.dispose();
      this.overlay.remove(child);
    }
  }

  /** Redraws the highlight and the dimension line, and reports the readout. */
  private showSelection(): void {
    this.clearOverlay();
    const model = this.model;
    if (!model || !this.selection.length) {
      this.onMeasure?.(null);
      this.wake();
      return;
    }
    const accent = new THREE.Color(this.opts.accent || "#5a8dff");
    const onTop = { depthTest: false, transparent: true };
    for (const ref of this.selection) {
      if (ref.kind === "face") {
        const g = new THREE.BufferGeometry();
        g.setAttribute("position", new THREE.BufferAttribute(faceTrianglePositions(model, ref.index), 3));
        const mat = new THREE.MeshBasicMaterial({
          color: accent,
          transparent: true,
          opacity: 0.45,
          side: THREE.DoubleSide,
          depthWrite: false,
          polygonOffset: true,
          polygonOffsetFactor: -1,
          polygonOffsetUnits: -4,
        });
        this.overlay.add(new THREE.Mesh(g, mat));
      } else if (ref.kind === "edge") {
        const pts = edgePoints(model, ref.index).map((p) => new THREE.Vector3(...p));
        this.overlay.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), new THREE.LineBasicMaterial({ color: accent, ...onTop })));
      } else if (ref.kind === "vertex") {
        const g = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(...vertexPoint(model, ref.index))]);
        this.overlay.add(new THREE.Points(g, new THREE.PointsMaterial({ color: accent, size: 9, sizeAttenuation: false, ...onTop })));
      }
    }
    const m = measureForEmbed(model, this.selection);
    if (m.segment) {
      const ends = [new THREE.Vector3(...m.segment.from), new THREE.Vector3(...m.segment.to)];
      const dim = new THREE.Color("#ffb02e");
      this.overlay.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(ends), new THREE.LineBasicMaterial({ color: dim, ...onTop })));
      this.overlay.add(new THREE.Points(new THREE.BufferGeometry().setFromPoints(ends), new THREE.PointsMaterial({ color: dim, size: 7, sizeAttenuation: false, ...onTop })));
    }
    for (const c of this.overlay.children) c.renderOrder = 10;
    this.onMeasure?.(m);
    this.wake();
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
    this.canvas.removeEventListener("pointerdown", this.onDown);
    this.canvas.removeEventListener("pointerup", this.onUp);
    this.clearOverlay();
    this.renderer.setAnimationLoop(null);
    this.controls.dispose();
    this.objects?.dispose();
    this.renderer.dispose();
  }
}
