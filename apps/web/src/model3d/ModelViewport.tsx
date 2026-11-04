import { useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import type { DocSession } from "../state/store";
import { bus, openNamedTab, useApp } from "../state/store";
import { matchesBinding } from "../keybindings";
import { formatArea, formatLength, formatMass, formatVolume } from "../units";
import {
  buildLights,
  buildModelObjects,
  EDGE_COLOR,
  framePerspective,
  HOVER_COLOR,
  SELECT_COLOR,
  STAGE_BACKGROUND,
  toBox3,
  type ModelObjects,
  type ViewPreset,
} from "./modelScene";
import { useTheme } from "../theme/themeStore";
import { formatBytes } from "./importError";
import { measureSelection, partOf, refLabel, type MeasureSegment, type SelRef } from "./measure";
import { faceOutlineBlocker, outlineOfFace } from "./faceTo2d";
import { pickEdge, pickVertex, type Projector } from "./picking";
import { useOpenLoads } from "./stepImport";
import type { Model3D } from "./types";
import { reorientModel, saveUpAxis, savedUpAxis, type UpAxis } from "./upAxis";
import { useViewer } from "./viewerStore";

/**
 * The 3D viewer that replaces the drawing canvas in a model tab.
 *
 * Mouse: left-drag orbits, right/middle-drag pans, wheel zooms toward the
 * cursor, double-click frames what is under it. Clicking picks **topology**,
 * the way Onshape does — the vertex, edge or face under the cursor, in that
 * order of preference — and the corner readout says what it measures:
 * a length, a radius, an area, or the distance and angle between two picks.
 * Shift-click adds to the selection; the Structure panel picks whole parts. Touch: one finger
 * orbits, two fingers pinch-zoom and pan, tap selects, double-tap frames,
 * long-press hides the part under the finger. Keys: F fits all,
 * H hides the selected part, Shift+H shows everything, E toggles edges,
 * M toggles the measure tool, Esc clears the measurement / selection,
 * 1/2/3/4 jump to iso/top/front/right.
 *
 * Measuring is not a separate mode: selecting *is* measuring. One pick
 * reports what that thing is (a length, a radius, an area, a volume); a
 * second reports the distance between them, broken into ΔX/ΔY/ΔZ, and the
 * viewer draws the span it measured — a solid dimension line between the
 * two points it used, with dashed legs for the three components. The
 * overlay is screen-space SVG, re-projected after every render so it
 * sticks to the geometry while the camera moves. Nothing is stored — a
 * measurement is a readout, not data.
 *
 * Rendering is on demand — a frame is drawn only when the camera or the
 * scene changed — so an open model tab costs nothing while idle.
 *
 * Everything the file parsed into is one merged mesh (see Model3D), so
 * per-part operations work on index/colour *ranges* rather than objects:
 * selecting a part rewrites its vertex colours, hiding one collapses its
 * triangles and edge segments to degenerate zero-area ones. That keeps a
 * 3,000-part assembly at two draw calls, and part offsets stable so picking
 * needs no bookkeeping.
 */

interface Props {
  session: DocSession;
}

export function ModelViewport({ session }: Props) {
  const model = session.model ?? null;
  if (session.modelError) return <ModelError name={session.name} message={session.modelError} />;
  if (!model) return <ModelLoading name={session.name} />;
  return <OrientedViewer key={model.hash} model={model} />;
}

/**
 * Owns the file's up axis: the header's guess unless the user overrode it
 * for this file. The viewer is handed the model already turned upright
 * (see upAxis.ts), so nothing below it knows there is a choice.
 */
function OrientedViewer({ model }: { model: Model3D }) {
  const [up, setUp] = useState<UpAxis>(() => savedUpAxis(model.hash) ?? model.detectedUp ?? "z");
  const shown = useMemo(() => reorientModel(model, up), [model, up]);
  const toggleUp = () => {
    const next: UpAxis = up === "z" ? "y" : "z";
    saveUpAxis(model.hash, next);
    setUp(next);
    // The file browser's picture of this file was drawn the old way up.
    void import("./modelThumbnail").then(({ refreshThumbnail }) => refreshThumbnail(model)).catch(() => undefined);
  };
  return <Viewer model={shown} up={up} onToggleUp={toggleUp} />;
}

/* ------------------------------ loading/error --------------------------- */

/** Above this, the loading card calls out the size — reading dominates wall time on a big assembly. */
const LARGE_FILE_BYTES = 20 * 1024 * 1024;

function ModelLoading({ name }: { name: string }) {
  const loads = useOpenLoads();
  const load = loads.find((l) => l.name === name) ?? loads[0];
  const [, tick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 500);
    return () => clearInterval(t);
  }, []);
  const seconds = load ? Math.floor((Date.now() - load.startedAt) / 1000) : 0;
  const phase =
    load?.phase === "queued"
      ? "Waiting for a free import worker…"
      : load?.phase === "cached"
        ? "Loading from cache…"
        : load?.phase === "hashing"
          ? "Reading file…"
          : "Reading geometry with OpenCascade…";
  return (
    <div className="model-stage model-loading" data-testid="model-loading">
      <div className="model-loading-card">
        <div className="model-loading-spinner" />
        <div className="model-loading-title">{name}</div>
        <div className="model-loading-phase">{phase}</div>
        <div className="model-loading-hint">
          {seconds > 0 ? `${seconds}s · ` : ""}
          Large assemblies take a while the first time; this file opens instantly afterwards.
        </div>
        {load && load.bytes > LARGE_FILE_BYTES && (
          <div className="model-loading-hint" data-testid="model-loading-size-hint">
            Large file ({formatBytes(load.bytes)}) — this can take a few minutes.
          </div>
        )}
      </div>
    </div>
  );
}

function ModelError({ name, message }: { name: string; message: string }) {
  return (
    <div className="model-stage model-loading" data-testid="model-error">
      <div className="model-loading-card error">
        <div className="model-loading-title">Couldn't open {name}</div>
        <div className="model-loading-phase">{message}</div>
      </div>
    </div>
  );
}

/* ------------------------------ highlighting ----------------------------- */

const rgbToHex = (rgb: readonly [number, number, number]): number => (rgb[0] << 16) | (rgb[1] << 8) | rgb[2];
// Read live, not cached at module load: SELECT_COLOR/HOVER_COLOR (modelScene.ts)
// are reassigned by the theme store, and a function call picks up whatever
// they are when a viewer mounts rather than freezing in the first theme seen.
const highlightSelect = (): number => rgbToHex(SELECT_COLOR);
const highlightHover = (): number => rgbToHex(HOVER_COLOR);

/** Push the edges and vertices of `refs` into the overlay line/point objects. */
function setOverlay(lines: THREE.LineSegments, points: THREE.Points, model: Model3D, refs: readonly SelRef[]) {
  const linePts: number[] = [];
  const pointPts: number[] = [];
  for (const r of refs) {
    if (r.kind === "edge") {
      const start = model.edgeTable.segStart[r.index];
      const count = model.edgeTable.segCount[r.index];
      for (let i = 0; i < count; i++) {
        const o = (start + i) * 6;
        for (let k = 0; k < 6; k++) linePts.push(model.edges[o + k]);
      }
    } else if (r.kind === "vertex") {
      const o = r.index * 3;
      pointPts.push(model.nodes.xyz[o], model.nodes.xyz[o + 1], model.nodes.xyz[o + 2]);
    }
  }
  setPositions(lines.geometry, linePts);
  setPositions(points.geometry, pointPts);
}

function setPositions(g: THREE.BufferGeometry, values: number[]) {
  g.setAttribute("position", new THREE.BufferAttribute(new Float32Array(values), 3));
  g.computeBoundingSphere();
}

/* --------------------------------- viewer -------------------------------- */

interface Scene {
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  controls: OrbitControls;
  objects: ModelObjects;
  raycaster: THREE.Raycaster;
  partBoxes: THREE.Box3[];
  /** Selection/hover overlays: picked edges and vertices, drawn over the shaded model. */
  selLines: THREE.LineSegments;
  hoverLines: THREE.LineSegments;
  selPoints: THREE.Points;
  hoverPoints: THREE.Points;
  requestRender: () => void;
  /** Called after each frame with the camera settled — the measure overlay re-projects itself here. */
  afterRender: { current: (() => void) | null };
  dispose: () => void;
}

function Viewer({ model, up, onToggleUp }: { model: Model3D; up: UpAxis; onToggleUp: () => void }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const sceneRef = useRef<Scene | null>(null);
  const themeResolved = useTheme((s) => s.tokens);
  const selection = useViewer((v) => v.selection);
  const hover = useViewer((v) => v.hover);
  const hidden = useViewer((v) => v.hidden);
  const frameRequest = useViewer((v) => v.frameRequest);
  const fitRequest = useViewer((v) => v.fitRequest);
  const pickInto = useViewer((v) => v.pick);
  const setHover = useViewer((v) => v.setHover);
  const hidePart = useViewer((v) => v.hide);
  const showAllParts = useViewer((v) => v.showAll);
  const isolate = useViewer((v) => v.isolate);
  const useModel = useViewer((v) => v.useModel);
  const density = useViewer((v) => v.density);
  const setDensity = useViewer((v) => v.setDensity);
  const [showEdges, setShowEdges] = useState(true);
  /** The span the current selection measures; the overlay re-projects it every frame. */
  const segmentRef = useRef<MeasureSegment | null>(null);
  /** The overlay's re-projection, so a new measurement can draw itself without waiting for a frame. */
  const syncOverlayRef = useRef<(() => void) | null>(null);
  const overlayRef = useRef<SVGSVGElement>(null);
  const labelRef = useRef<HTMLDivElement>(null);
  const displayUnit = useApp((s) => s.displayUnit);
  /** Surface point under a client position — refreshed every render so the scene's listeners see current hidden parts. */
  const surfaceRef = useRef<(x: number, y: number) => THREE.Vector3 | null>(() => null);

  // ---- scene lifetime: one per model --------------------------------------
  useEffect(() => {
    const host = hostRef.current;
    const canvas = canvasRef.current;
    if (!host || !canvas) return;
    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false, powerPreference: "high-performance" });
    } catch {
      return;
    }
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.setClearColor(STAGE_BACKGROUND, 1);

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(35, 1, 0.1, 1000);
    camera.up.set(0, 0, 1);
    scene.add(...buildLights(camera));
    const objects = buildModelObjects(model);
    scene.add(objects.group);

    const controls = new OrbitControls(camera, canvas);
    controls.enableDamping = false;
    controls.zoomToCursor = true;
    controls.screenSpacePanning = true;
    controls.mouseButtons = { LEFT: THREE.MOUSE.ROTATE, MIDDLE: THREE.MOUSE.PAN, RIGHT: THREE.MOUSE.PAN };
    // One finger orbits; two fingers pinch-zoom and pan together.
    controls.touches = { ONE: THREE.TOUCH.ROTATE, TWO: THREE.TOUCH.DOLLY_PAN };
    controls.target.copy(framePerspective(camera, model.bounds, "iso"));
    controls.update();

    // ---- navigation feel (Onshape / SolidWorks) -----------------------------
    // Orbit pivots on the surface point under the cursor at drag start, and
    // that point stays put on screen while the model turns. The wheel dollies
    // toward the surface point under the cursor by a fixed *fraction* of the
    // distance to it (OrbitControls' zoomToCursor re-targets on a plane at the
    // old target depth, which makes close-up zooming lurch).
    const box = toBox3(model.bounds);
    const modelCenter = box.getCenter(new THREE.Vector3());
    const modelRadius = Math.max(box.getSize(new THREE.Vector3()).length() / 2, 1e-3);
    const minPivotDist = modelRadius * 1e-4;
    const maxTargetDist = modelRadius * 40;

    let pivot: THREE.Vector3 | null = null;
    const pivotNdc = new THREE.Vector2();
    const onPivotDown = (e: PointerEvent) => {
      pivot = null;
      if (!e.isPrimary || e.button !== 0 || e.ctrlKey || e.shiftKey || e.metaKey) return;
      const hit = surfaceRef.current(e.clientX, e.clientY);
      if (!hit) return;
      camera.updateMatrixWorld();
      const ndc = hit.clone().project(camera);
      pivotNdc.set(ndc.x, ndc.y);
      pivot = hit.clone();
      controls.target.copy(hit);
    };
    const onPivotUp = () => {
      pivot = null;
    };
    /** After OrbitControls turned the view about `pivot`, slide camera and target so it is back where it was on screen. */
    const holdPivot = () => {
      if (!pivot) return;
      camera.updateMatrixWorld();
      const z = pivot.clone().project(camera).z;
      const back = new THREE.Vector3(pivotNdc.x, pivotNdc.y, z).unproject(camera);
      const shift = pivot.clone().sub(back);
      camera.position.add(shift);
      controls.target.add(shift);
      camera.updateMatrixWorld();
    };
    controls.addEventListener("change", holdPivot);    canvas.addEventListener("pointerdown", onPivotDown);
    canvas.addEventListener("pointerup", onPivotUp);
    canvas.addEventListener("pointercancel", onPivotUp);

    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      e.stopImmediatePropagation();
      const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 120 : 1;
      const dy = Math.max(-240, Math.min(240, e.deltaY * unit));
      let factor = Math.exp(dy * 0.0012);
      const rect = canvas.getBoundingClientRect();
      camera.updateMatrixWorld();
      const ndc = new THREE.Vector2(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
      let at = surfaceRef.current(e.clientX, e.clientY);
      if (!at) {
        const ray = new THREE.Raycaster();
        ray.setFromCamera(ndc, camera);
        at = ray.ray.at(camera.position.distanceTo(controls.target), new THREE.Vector3());
      }
      const toPivot = camera.position.distanceTo(at);
      if (factor < 1) factor = Math.max(factor, Math.min(1, minPivotDist / Math.max(toPivot, 1e-9)));
      else if (camera.position.distanceTo(controls.target) * factor > maxTargetDist) return;
      // A homothety about `at`: the point under the cursor does not move on screen.
      camera.position.sub(at).multiplyScalar(factor).add(at);
      controls.target.sub(at).multiplyScalar(factor).add(at);
      controls.update();
      requestRender();
    };
    canvas.addEventListener("wheel", onWheel, { passive: false, capture: true });

    let pending = false;
    const afterRender: Scene["afterRender"] = { current: null };
    const requestRender = () => {
      if (pending) return;
      pending = true;
      requestAnimationFrame(() => {
        pending = false;
        // Clip planes follow the camera: a fixed near plane eats the model once you are close.
        const far = camera.position.distanceTo(modelCenter) + modelRadius * 2;
        camera.far = far;
        camera.near = Math.max(far * 1e-5, 1e-4);
        camera.updateProjectionMatrix();
        renderer.render(scene, camera);
        afterRender.current?.();
      });
    };
    controls.addEventListener("change", requestRender);

    const resize = () => {
      const w = Math.max(1, host.clientWidth);
      const h = Math.max(1, host.clientHeight);
      // Re-read the ratio: the window may have moved to a different-DPI screen.
      renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
      renderer.setSize(w, h, false);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      requestRender();
    };
    const observer = new ResizeObserver(resize);
    observer.observe(host);
    resize();

    // Selection overlays. depthTest off so a picked edge stays visible when
    // it sits a hair behind the surface it bounds — the same call Onshape makes.
    const lineObject = (color: number) => {
      const g = new THREE.BufferGeometry();
      g.setAttribute("position", new THREE.BufferAttribute(new Float32Array(0), 3));
      const o = new THREE.LineSegments(g, new THREE.LineBasicMaterial({ color, depthTest: false }));
      o.renderOrder = 10;
      o.frustumCulled = false;
      return o;
    };
    const pointObject = (color: number, size: number) => {
      const g = new THREE.BufferGeometry();
      g.setAttribute("position", new THREE.BufferAttribute(new Float32Array(0), 3));
      const o = new THREE.Points(g, new THREE.PointsMaterial({ color, size, sizeAttenuation: false, depthTest: false }));
      o.renderOrder = 11;
      o.frustumCulled = false;
      return o;
    };
    const selLines = lineObject(highlightSelect());
    const hoverLines = lineObject(highlightHover());
    const selPoints = pointObject(highlightSelect(), 11);
    const hoverPoints = pointObject(highlightHover(), 9);
    scene.add(selLines, hoverLines, selPoints, hoverPoints);

    const partBoxes = model.parts.map((p) => toBox3(p.bounds));
    const s: Scene = {
      renderer,
      scene,
      camera,
      controls,
      objects,
      raycaster: new THREE.Raycaster(),
      partBoxes,
      selLines,
      hoverLines,
      selPoints,
      hoverPoints,
      requestRender,
      afterRender,
      dispose() {
        observer.disconnect();
        canvas.removeEventListener("wheel", onWheel, { capture: true });
        canvas.removeEventListener("pointerdown", onPivotDown);
        canvas.removeEventListener("pointerup", onPivotUp);
        canvas.removeEventListener("pointercancel", onPivotUp);
        controls.dispose();
        objects.dispose();
        for (const o of [selLines, hoverLines, selPoints, hoverPoints]) {
          o.geometry.dispose();
          (o.material as THREE.Material).dispose();
        }
        renderer.dispose();
      },
    };
    sceneRef.current = s;
    return () => {
      s.dispose();
      sceneRef.current = null;
    };
  }, [model]);

  // Live theme switch (Z-03): the scene above only reads STAGE_BACKGROUND/
  // EDGE_COLOR/SELECT_COLOR/HOVER_COLOR once, at creation, so a theme change
  // needs to push the new colours onto the already-built renderer/materials
  // itself — a part's own baked colour is unaffected (see theme.ts's doc).
  useEffect(() => {
    const s = sceneRef.current;
    if (!s) return;
    s.renderer.setClearColor(STAGE_BACKGROUND, 1);
    (s.objects.edges.material as THREE.LineBasicMaterial).color.setHex(EDGE_COLOR);
    (s.selLines.material as THREE.LineBasicMaterial).color.setHex(highlightSelect());
    (s.selPoints.material as THREE.PointsMaterial).color.setHex(highlightSelect());
    (s.hoverLines.material as THREE.LineBasicMaterial).color.setHex(highlightHover());
    (s.hoverPoints.material as THREE.PointsMaterial).color.setHex(highlightHover());
    s.requestRender();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [themeResolved]);

  // ---- derived scene state ------------------------------------------------
  useEffect(() => {
    const s = sceneRef.current;
    if (!s) return;
    s.objects.edges.visible = showEdges;
    s.requestRender();
  }, [showEdges]);

  // The state that belongs to this model, not the previous one.
  useEffect(() => {
    useModel(model.hash);
  }, [model, useModel]);

  /**
   * Highlighting. Faces and parts are painted into the shared colour
   * attribute (restored from the model's pristine colours each time);
   * edges and vertices go into the overlay objects, since they aren't
   * surfaces. Hover paints first so a selected thing stays selected-coloured.
   */
  useEffect(() => {
    const s = sceneRef.current;
    if (!s) return;
    const attr = s.objects.geometry.getAttribute("color") as THREE.BufferAttribute;
    const arr = attr.array as Uint8Array;
    arr.set(model.colors);
    const paint = (refs: readonly SelRef[], rgb: readonly number[]) => {
      for (const r of refs) {
        if (r.kind === "face") {
          const start = model.faces.triStart[r.index];
          const count = model.faces.triCount[r.index];
          for (let t = 0; t < count; t++) {
            for (let k = 0; k < 3; k++) {
              const vi = model.indices[(start + t) * 3 + k];
              arr[vi * 3] = rgb[0];
              arr[vi * 3 + 1] = rgb[1];
              arr[vi * 3 + 2] = rgb[2];
            }
          }
        } else if (r.kind === "part") {
          const p = model.parts[r.index];
          if (!p) continue;
          for (let i = p.vertexStart; i < p.vertexStart + p.vertexCount; i++) {
            arr[i * 3] = rgb[0];
            arr[i * 3 + 1] = rgb[1];
            arr[i * 3 + 2] = rgb[2];
          }
        }
      }
    };
    if (hover) paint([hover], HOVER_COLOR);
    paint(selection, SELECT_COLOR);
    attr.needsUpdate = true;

    setOverlay(s.selLines, s.selPoints, model, selection);
    setOverlay(s.hoverLines, s.hoverPoints, model, hover ? [hover] : []);
    s.requestRender();
  }, [selection, hover, model]);

  // Visibility: hidden parts get degenerate triangles/segments in place, so
  // every other part's ranges stay where they are.
  useEffect(() => {
    const s = sceneRef.current;
    if (!s) return;
    const index = s.objects.geometry.getIndex()!;
    const idx = index.array as Uint32Array;
    idx.set(model.indices);
    const edgeAttr = s.objects.edgeGeometry.getAttribute("position") as THREE.BufferAttribute;
    const edges = edgeAttr.array as Float32Array;
    edges.set(model.edges);
    for (const pi of hidden) {
      const p = model.parts[pi];
      if (!p) continue;
      idx.fill(p.vertexStart, p.indexStart, p.indexStart + p.indexCount);
      edges.fill(0, p.edgeStart * 6, (p.edgeStart + p.edgeCount) * 6);
    }
    index.needsUpdate = true;
    edgeAttr.needsUpdate = true;
    s.requestRender();
  }, [hidden, model]);

  // The Structure panel can't drive the camera, so it asks through the store.
  useEffect(() => {
    if (!frameRequest) return;
    const p = model.parts[frameRequest.part];
    if (p) frame(p.bounds);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [frameRequest]);

  // Isolating ends with a fit, so what survived fills the screen.
  useEffect(() => {
    if (fitRequest > 0) fitAll();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fitRequest]);

  // ---- picking ------------------------------------------------------------
  /**
   * Everything a pick needs from one ray: the nearest surface hit (with the
   * triangle, which names the face), the parts the ray passes through, and a
   * world→pixel projector for the screen-space edge and vertex search.
   *
   * Coarse pass on part boxes, then exact triangles only inside candidate
   * parts (via drawRange) — a click on a million-triangle assembly stays
   * instant.
   */
  const probe = (clientX: number, clientY: number) => {
    const s = sceneRef.current;
    const canvas = canvasRef.current;
    if (!s || !canvas) return null;
    const rect = canvas.getBoundingClientRect();
    const cursor = { x: clientX - rect.left, y: clientY - rect.top };
    const ndc = new THREE.Vector2((cursor.x / rect.width) * 2 - 1, -(cursor.y / rect.height) * 2 + 1);
    s.raycaster.setFromCamera(ndc, s.camera);
    const ray = s.raycaster.ray;
    const at = new THREE.Vector3();
    const candidates: { part: number; dist: number }[] = [];
    for (let i = 0; i < s.partBoxes.length; i++) {
      if (hidden.has(i)) continue;
      if (ray.intersectBox(s.partBoxes[i], at)) candidates.push({ part: i, dist: at.distanceTo(ray.origin) });
    }
    candidates.sort((a, b) => a.dist - b.dist);
    const geometry = s.objects.geometry;
    let hit: { part: number; triangle: number; point: THREE.Vector3; dist: number } | null = null;
    for (const c of candidates) {
      if (hit && c.dist > hit.dist) break;
      const p = model.parts[c.part];
      geometry.setDrawRange(p.indexStart, p.indexCount);
      const hits = s.raycaster.intersectObject(s.objects.mesh, false);
      if (hits.length > 0 && (!hit || hits[0].distance < hit.dist)) {
        hit = { part: c.part, triangle: hits[0].faceIndex ?? 0, point: hits[0].point.clone(), dist: hits[0].distance };
      }
    }
    geometry.setDrawRange(0, Infinity);

    const v = new THREE.Vector3();
    const project: Projector = (p) => {
      v.set(p[0], p[1], p[2]);
      const depth = v.distanceTo(s.camera.position);
      v.project(s.camera);
      return { x: ((v.x + 1) / 2) * rect.width, y: ((1 - v.y) / 2) * rect.height, visible: v.z < 1, depth };
    };
    const worldPerPixel = (d: number) => (2 * d * Math.tan((s.camera.fov * Math.PI) / 360)) / Math.max(1, canvas.clientHeight);
    return { cursor, hit, candidates, project, worldPerPixel };
  };

  surfaceRef.current = (x, y) => probe(x, y)?.hit?.point ?? null;

  /** The topology under the cursor: vertex, then edge, then the face the ray landed on. */
  const pickRef = (clientX: number, clientY: number, touch: boolean): SelRef | null => {
    const pr = probe(clientX, clientY);
    if (!pr) return null;
    const tolPx = touch ? 14 : 7;
    // Only the part the ray actually hit competes for edges and vertices;
    // with nothing hit, the few parts the ray passes near do.
    const parts = pr.hit ? [pr.hit.part] : pr.candidates.slice(0, 8).map((c) => c.part);
    const opts = {
      tolPx,
      maxDepth: pr.hit ? pr.hit.dist + pr.worldPerPixel(pr.hit.dist) * (tolPx + 2) : Infinity,
    };
    for (const part of parts) {
      const v = pickVertex(model, part, pr.cursor, pr.project, opts);
      if (v !== null) return { kind: "vertex", index: v };
    }
    for (const part of parts) {
      const e = pickEdge(model, part, pr.cursor, pr.project, opts);
      if (e !== null) return { kind: "edge", index: e };
    }
    if (pr.hit) return { kind: "face", index: model.faceOfTriangle[pr.hit.triangle] ?? 0 };
    return null;
  };

  const pick = (clientX: number, clientY: number): number | null => probe(clientX, clientY)?.hit?.part ?? null;


  /**
   * The dimension drawing. Re-projected imperatively after each render
   * rather than through React state, so orbiting with a measurement on
   * screen doesn't re-render the component once per frame.
   *
   * Three dashed legs run from one end to the other along X, then Y, then
   * Z — the same numbers the ΔX ΔY ΔZ row gives, in the place they
   * actually apply. A leg shorter than a few pixels is left out; an
   * axis-aligned span would otherwise draw a degenerate staircase on top
   * of itself.
   */
  useEffect(() => {
    const s = sceneRef.current;
    if (!s) return;
    const sync = () => {
      const svg = overlayRef.current;
      const label = labelRef.current;
      const canvas = canvasRef.current;
      if (!svg || !label || !canvas) return;
      const w = canvas.clientWidth;
      const h = canvas.clientHeight;
      svg.setAttribute("viewBox", `0 0 ${w} ${h}`);
      const seg = segmentRef.current;
      const v = new THREE.Vector3();
      const project = (p: readonly [number, number, number]) => {
        v.set(p[0], p[1], p[2]).project(s.camera);
        return { x: ((v.x + 1) / 2) * w, y: ((1 - v.y) / 2) * h, visible: v.z < 1 };
      };
      const el = (id: string) => svg.querySelector(id) as SVGElement | null;
      const hide = (node: SVGElement | null) => {
        if (node) node.style.display = "none";
      };
      if (!seg) {
        for (const id of ["#m-a", "#m-b", "#m-line", "#m-dx", "#m-dy", "#m-dz"]) hide(el(id));
        label.style.display = "none";
        return;
      }
      const a = project(seg.from);
      const b = project(seg.to);
      const corners: [number, number, number][] = [
        seg.from,
        [seg.to[0], seg.from[1], seg.from[2]],
        [seg.to[0], seg.to[1], seg.from[2]],
        seg.to,
      ];
      const legs = [0, 1, 2].map((i) => ({ from: project(corners[i]), to: project(corners[i + 1]) }));
      const place = (node: SVGElement | null, p: { x: number; y: number; visible: boolean }) => {
        if (!node) return;
        node.style.display = p.visible ? "" : "none";
        node.setAttribute("cx", String(p.x));
        node.setAttribute("cy", String(p.y));
      };
      place(el("#m-a"), a);
      place(el("#m-b"), b);
      const span = (node: SVGElement | null, from: { x: number; y: number; visible: boolean }, to: { x: number; y: number; visible: boolean }) => {
        if (!node) return;
        const draw = from.visible && to.visible && Math.hypot(to.x - from.x, to.y - from.y) > 3;
        node.style.display = draw ? "" : "none";
        if (!draw) return;
        node.setAttribute("x1", String(from.x));
        node.setAttribute("y1", String(from.y));
        node.setAttribute("x2", String(to.x));
        node.setAttribute("y2", String(to.y));
      };
      span(el("#m-line"), a, b);
      span(el("#m-dx"), legs[0].from, legs[0].to);
      span(el("#m-dy"), legs[1].from, legs[1].to);
      span(el("#m-dz"), legs[2].from, legs[2].to);
      const both = a.visible && b.visible;
      label.style.display = both ? "" : "none";
      if (both) {
        label.style.left = `${(a.x + b.x) / 2}px`;
        label.style.top = `${(a.y + b.y) / 2}px`;
      }
    };
    s.afterRender.current = sync;
    syncOverlayRef.current = sync;
    sync();
    return () => {
      if (s.afterRender.current === sync) s.afterRender.current = null;
      if (syncOverlayRef.current === sync) syncOverlayRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [model]);

  /** Frames `bounds` from a preset, or from wherever the camera is looking now. */
  const frame = (bounds: Model3D["bounds"], preset?: ViewPreset) => {
    const s = sceneRef.current;
    if (!s) return;
    const from = preset ?? s.camera.position.clone().sub(s.controls.target).normalize();
    s.controls.target.copy(framePerspective(s.camera, bounds, from));
    s.controls.update();
    s.requestRender();
  };
  const fitAll = (preset?: ViewPreset) => frame(visibleBounds(model, hidden), preset);
  const fitPart = (part: number) => frame(model.parts[part].bounds);

  // ---- pointer + keys -----------------------------------------------------
  // Taps and clicks share one path. Touch gets a wider "didn't move" budget
  // (fingers wobble), its own double-tap detection (dblclick is unreliable
  // once touch-action is none), and a long-press to hide the part under the
  // finger — the touch stand-in for the H key. Orbit/pan/pinch themselves are
  // OrbitControls' built-in one- and two-finger gestures.
  const downAt = useRef<{ x: number; y: number; id: number; touch: boolean } | null>(null);
  const lastTap = useRef<{ at: number; x: number; y: number } | null>(null);
  const longPress = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cancelLongPress = () => {
    if (longPress.current) clearTimeout(longPress.current);
    longPress.current = null;
  };
  const slop = (touch: boolean) => (touch ? 12 : 4);

  const onPointerDown = (e: React.PointerEvent) => {
    const touch = e.pointerType === "touch";
    // A second finger means a pinch/pan gesture, never a tap.
    if (downAt.current && touch) {
      downAt.current = null;
      cancelLongPress();
      return;
    }
    downAt.current = { x: e.clientX, y: e.clientY, id: e.pointerId, touch };
    cancelLongPress();
    if (touch) {
      const { clientX, clientY } = e;
      longPress.current = setTimeout(() => {
        longPress.current = null;
        downAt.current = null;
        const part = pick(clientX, clientY);
        if (part === null) return;
        hidePart(part);
      }, 550);
    }
  };
  /** Hover highlighting, one pick per frame at most — the cursor moves far more often than that. */
  const hoverQueued = useRef(false);
  const onPointerMove = (e: React.PointerEvent) => {
    const d = downAt.current;
    if (d && d.id === e.pointerId && Math.hypot(e.clientX - d.x, e.clientY - d.y) > slop(d.touch)) cancelLongPress();
    if (e.pointerType === "touch" || e.buttons !== 0) return;
    if (hoverQueued.current) return;
    hoverQueued.current = true;
    const { clientX, clientY } = e;
    requestAnimationFrame(() => {
      hoverQueued.current = false;
      setHover(pickRef(clientX, clientY, false));
    });
  };
  const onPointerUp = (e: React.PointerEvent) => {
    cancelLongPress();
    const d = downAt.current;
    downAt.current = null;
    // A drag is an orbit, not a click.
    if (!d || d.id !== e.pointerId || e.button !== 0 || Math.hypot(e.clientX - d.x, e.clientY - d.y) > slop(d.touch)) return;
    if (d.touch) {
      const prev = lastTap.current;
      const now = performance.now();
      if (prev && now - prev.at < 350 && Math.hypot(e.clientX - prev.x, e.clientY - prev.y) < 30) {
        lastTap.current = null;
        frameAt(e.clientX, e.clientY);
        return;
      }
      lastTap.current = { at: now, x: e.clientX, y: e.clientY };
    }
    pickInto(pickRef(e.clientX, e.clientY, d.touch), e.shiftKey || e.ctrlKey || e.metaKey);
  };
  const onPointerCancel = () => {
    cancelLongPress();
    downAt.current = null;
  };
  const onPointerLeave = () => setHover(null);
  /** Double-click / double-tap: frame the part under the cursor, or everything. */
  const frameAt = (clientX: number, clientY: number) => {
    const part = pick(clientX, clientY);
    if (part !== null) fitPart(part);
    else fitAll();
  };
  const onDoubleClick = (e: React.MouseEvent) => {
    // Touch double-taps are handled in onPointerUp.
    if ((e.nativeEvent as PointerEvent).pointerType === "touch") return;
    frameAt(e.clientX, e.clientY);
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if (matchesBinding(e, "view.toggleUpAxis")) {
        e.preventDefault();
        onToggleUp();
        return;
      }
      switch (e.key) {
        case "f":
        case "F":
          fitAll();
          break;
        case "e":
        case "E":
          setShowEdges((v) => !v);
          break;
        case "h": {
          const last = selection[selection.length - 1];
          if (last) hidePart(partOf(model, last));
          break;
        }
        case "H":
          showAllParts();
          break;
        case "i":
        case "I": {
          // Isolate what is selected; with nothing selected, show everything.
          const parts = [...new Set(selection.map((r) => partOf(model, r)))];
          if (parts.length > 0) isolateParts(parts);
          else showAllParts();
          break;
        }
        case "Escape":
          pickInto(null, false);
          break;
        case "1":
          fitAll("iso");
          break;
        case "2":
          fitAll("top");
          break;
        case "3":
          fitAll("front");
          break;
        case "4":
          fitAll("right");
          break;
        default:
          return;
      }
      e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selection, hidden, model]);

  const sizeOf = (b: Model3D["bounds"]) => [0, 1, 2].map((k) => formatLength(b.max[k] - b.min[k], displayUnit)).join(" × ");
  const size = useMemo(() => sizeOf(model.bounds), [model, displayUnit]); // eslint-disable-line react-hooks/exhaustive-deps

  const shown = hover ?? selection[selection.length - 1] ?? null;
  const statusPart = shown ? partOf(model, shown) : null;
  const measurement = useMemo(
    () =>
      measureSelection(model, selection, {
        length: (v) => formatLength(v, displayUnit),
        area: (v) => formatArea(v, displayUnit),
        volume: (v) => formatVolume(v, displayUnit),
        // volume (mm³) × density (g/cm³) / 1000 = grams — the mm³↔cm³ factor.
        mass: (v) => formatMass((v * density) / 1000, displayUnit),
      }),
    [model, selection, displayUnit, density],
  );
  const rows = measurement.rows;
  const spanLength = measurement.segment
    ? formatLength(
        Math.hypot(
          measurement.segment.to[0] - measurement.segment.from[0],
          measurement.segment.to[1] - measurement.segment.from[1],
          measurement.segment.to[2] - measurement.segment.from[2],
        ),
        displayUnit,
      )
    : "";

  // Hand the span to the overlay. Drawn straight away rather than waiting
  // for the next frame: the camera hasn't moved, so the projection is
  // already valid, and a measurement that appears one frame late reads as
  // a glitch.
  useEffect(() => {
    segmentRef.current = measurement.segment;
    syncOverlayRef.current?.();
    sceneRef.current?.requestRender();
  }, [measurement]);

  /** How many parts are on screen — the Isolate button lights up when it's just the selection. */
  const visiblePartCount = model.parts.length - hidden.size;
  const isolateParts = (parts: number[]) => isolate(parts, model.parts.length);
  /** F-07: the picked flat face becomes a new 2D tab (lines, arcs, circles at the origin). */
  const lastRef = selection[selection.length - 1];
  const flatFace = lastRef && lastRef.kind === "face" && faceOutlineBlocker(model, lastRef.index) === null ? lastRef.index : null;
  const faceTo2d = () => {
    if (flatFace === null) return;
    const r = outlineOfFace(model, flatFace);
    if ("error" in r) {
      window.alert(r.error);
      return;
    }
    openNamedTab(r.name);
    // `bus` is a live binding to the tab just opened.
    bus.execute({ type: "batch", commands: r.entities.map((entity) => ({ type: "add-entity" as const, entity })) });
    useApp.getState().syncLayersFromDoc();
    useApp.getState().requestFit();
  };
  const readoutTitle = selection
    .slice(-2)
    .map((r) => refLabel(model, r))
    .join(" ↔ ");

  return (
    <div className="model-stage" ref={hostRef} data-testid="model-viewport">
      <canvas
        ref={canvasRef}
        className="model-canvas"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerCancel}
        onPointerLeave={onPointerLeave}
        onDoubleClick={onDoubleClick}
        onContextMenu={(e) => e.preventDefault()}
      />
      {/* Measurement overlay: screen-space, re-projected after every render (see the sync effect). */}
      <svg ref={overlayRef} className="model-measure-overlay" data-testid="model-measure-overlay" aria-hidden="true">
        {/* The ΔX / ΔY / ΔZ staircase, drawn behind the direct span. */}
        <line id="m-dx" className="m-delta m-dx" style={{ display: "none" }} />
        <line id="m-dy" className="m-delta m-dy" style={{ display: "none" }} />
        <line id="m-dz" className="m-delta m-dz" style={{ display: "none" }} />
        <line id="m-line" style={{ display: "none" }} />
        <circle id="m-a" r="5" style={{ display: "none" }} />
        <circle id="m-b" r="5" style={{ display: "none" }} />
      </svg>
      <div ref={labelRef} className="model-measure-label" data-testid="model-measure-label" style={{ display: "none" }}>
        {spanLength}
      </div>
      <div className="model-toolbar" data-testid="model-toolbar">
        <ToolButton title="Isometric (1)" label="Iso" icon={ICONS.iso} onClick={() => fitAll("iso")} testId="model-view-iso" />
        <ToolButton title="Top (2)" label="Top" icon={ICONS.top} onClick={() => fitAll("top")} testId="model-view-top" />
        <ToolButton title="Front (3)" label="Front" icon={ICONS.front} onClick={() => fitAll("front")} testId="model-view-front" />
        <ToolButton title="Right (4)" label="Right" icon={ICONS.right} onClick={() => fitAll("right")} testId="model-view-right" />
        <ToolButton
          title="Exported Y-up (SolidWorks)? Toggle which axis is up"
          label={up === "z" ? "Z up" : "Y up"}
          icon={ICONS.upAxis}
          active={up === "y"}
          onClick={onToggleUp}
          testId="model-up-axis"
        />
        <span className="model-toolbar-sep" />
        <ToolButton title="Fit everything visible (F)" label="Fit" icon={ICONS.fit} onClick={() => fitAll()} testId="model-fit" />
        <ToolButton
          title="Toggle B-rep edges (E)"
          label="Edges"
          icon={ICONS.edges}
          active={showEdges}
          onClick={() => setShowEdges((v) => !v)}
          testId="model-edges"
        />
        <ToolButton
          title="Isolate the selected part — everything else is hidden (I)"
          label="Isolate"
          icon={ICONS.isolate}
          active={hidden.size > 0 && hidden.size === model.parts.length - visiblePartCount}
          disabled={selection.length === 0}
          onClick={() => isolateParts([...new Set(selection.map((r) => partOf(model, r)))])}
          testId="model-isolate"
        />
        <ToolButton
          title="Hide the selected part (H)"
          label="Hide"
          icon={ICONS.hide}
          disabled={selection.length === 0}
          onClick={() => {
            const last = selection[selection.length - 1];
            if (last) hidePart(partOf(model, last));
          }}
          testId="model-hide"
        />
        <ToolButton
          title={flatFace === null ? "Select a flat face, then send its outline to a new 2D tab" : "Send the selected flat face's outline to a new 2D tab (true size, at the origin) - save it as DXF for the laser"}
          label="To 2D"
          icon={ICONS.to2d}
          disabled={flatFace === null}
          onClick={faceTo2d}
          testId="model-face-to-2d"
        />
        <ToolButton
          title="Show all hidden parts (Shift+H)"
          label={`Show all${hidden.size > 0 ? ` (${hidden.size})` : ""}`}
          icon={ICONS.showAll}
          disabled={hidden.size === 0}
          onClick={showAllParts}
          testId="model-show-all"
        />
      </div>
      <div className="model-status" data-testid="model-status">
        <span>{model.parts.length} parts</span>
        <span>{model.triangleCount.toLocaleString()} triangles</span>
        <span title={statusPart !== null ? "Part bounding box, X × Y × Z" : "Bounding box, X × Y × Z"}>
          {statusPart !== null ? sizeOf(model.parts[statusPart].bounds) : size}
        </span>
        {statusPart !== null && (
          <span className="model-status-part" data-testid="model-status-part">
            {model.parts[statusPart].name}
          </span>
        )}
        {hidden.size > 0 && (
          <span className="model-status-part" data-testid="model-status-hidden">
            {hidden.size} hidden
          </span>
        )}
      </div>
      {/* The corner readout: what the current picks measure. */}
      {rows.length > 0 && (
        <div className="model-measure-panel" data-testid="model-measure-panel">
          <div className="model-measure-panel-head">
            <span className="model-measure-panel-title" title={readoutTitle}>
              {readoutTitle}
            </span>
            <button className="btn ghost sm" title="Clear the selection (Esc)" onClick={() => pickInto(null, false)}>
              ✕
            </button>
          </div>
          {rows.map((r) => (
            <div className="model-measure-row" key={r.label}>
              <span className="model-measure-key">{r.label}</span>
              <span className="model-measure-value" title={r.approx ? "Approximate — measured on the tessellation" : undefined}>
                {r.approx ? "≈ " : ""}
                {r.value}
              </span>
            </div>
          ))}
          {/* Mass depends on a material nobody told the viewer — shown right
              under the row it feeds, so the number and its assumption stay together. */}
          {rows.some((r) => r.label === "Mass" || r.label.startsWith("Total mass")) && (
            <div className="model-measure-row model-measure-density">
              <span className="model-measure-key">Density</span>
              <span>
                <input
                  type="number"
                  className="model-density-input"
                  data-testid="model-density-input"
                  min={0.001}
                  step={0.01}
                  value={density}
                  onChange={(e) => {
                    const v = Number(e.target.value);
                    if (Number.isFinite(v) && v > 0) setDensity(v);
                  }}
                  title="Material density used for Mass — assumed, not read from the file"
                />{" "}
                g/cm³
              </span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/* ------------------------------- toolbar --------------------------------- */

interface ToolButtonProps {
  title: string;
  label: string;
  icon: JSX.Element;
  active?: boolean;
  disabled?: boolean;
  onClick: () => void;
  testId?: string;
}

/** A toolbar button: icon + label. In touch mode the stylesheet stacks them into a big tile. */
function ToolButton({ title, label, icon, active, disabled, onClick, testId }: ToolButtonProps) {
  return (
    <button
      className={`btn ghost sm model-tool ${active ? "active" : ""}`}
      title={title}
      disabled={disabled}
      onClick={onClick}
      data-testid={testId}
    >
      {icon}
      <span className="model-tool-label">{label}</span>
    </button>
  );
}

const stroke = { stroke: "currentColor", strokeWidth: 1.8, fill: "none", strokeLinecap: "round", strokeLinejoin: "round" } as const;

const ICONS = {
  iso: (
    <svg viewBox="0 0 24 24" width="18" height="18">
      <path d="M12 3l8 4.5v9L12 21l-8-4.5v-9zM12 12l8-4.5M12 12L4 7.5M12 12v9" {...stroke} />
    </svg>
  ),
  top: (
    <svg viewBox="0 0 24 24" width="18" height="18">
      <rect x="4" y="4" width="16" height="16" rx="1.5" {...stroke} />
      <path d="M4 9h16" {...stroke} />
    </svg>
  ),
  front: (
    <svg viewBox="0 0 24 24" width="18" height="18">
      <rect x="4" y="4" width="16" height="16" rx="1.5" {...stroke} />
      <path d="M4 15h16" {...stroke} />
    </svg>
  ),
  right: (
    <svg viewBox="0 0 24 24" width="18" height="18">
      <rect x="4" y="4" width="16" height="16" rx="1.5" {...stroke} />
      <path d="M15 4v16" {...stroke} />
    </svg>
  ),
  upAxis: (
    <svg viewBox="0 0 24 24" width="18" height="18">
      <path d="M12 20V5M12 5l-3.5 3.5M12 5l3.5 3.5M5 20h14" {...stroke} />
    </svg>
  ),
  fit: (
    <svg viewBox="0 0 24 24" width="18" height="18">
      <path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" {...stroke} />
      <rect x="9" y="9" width="6" height="6" {...stroke} />
    </svg>
  ),
  edges: (
    <svg viewBox="0 0 24 24" width="18" height="18">
      <path d="M12 3l8 4.5v9L12 21l-8-4.5v-9z" {...stroke} />
      <path d="M12 12l8-4.5M12 12L4 7.5M12 12v9" {...stroke} strokeDasharray="2 2" />
    </svg>
  ),
  isolate: (
    <svg viewBox="0 0 24 24" width="18" height="18">
      <path d="M9 9h6v6H9z" {...stroke} />
      <path d="M4 4h3M4 4v3M20 4h-3M20 4v3M4 20h3M4 20v-3M20 20h-3M20 20v-3" {...stroke} />
    </svg>
  ),
  to2d: (
    <svg viewBox="0 0 24 24" width="18" height="18">
      <path d="M4 8l8-4 8 4-8 4z" {...stroke} />
      <path d="M12 12v4M9 16l3 3 3-3" {...stroke} />
    </svg>
  ),
  hide: (
    <svg viewBox="0 0 24 24" width="18" height="18">
      <path d="M3 12s3.5-6 9-6 9 6 9 6-3.5 6-9 6-9-6-9-6z" {...stroke} />
      <path d="M4 4l16 16" {...stroke} />
    </svg>
  ),
  showAll: (
    <svg viewBox="0 0 24 24" width="18" height="18">
      <path d="M3 12s3.5-6 9-6 9 6 9 6-3.5 6-9 6-9-6-9-6z" {...stroke} />
      <circle cx="12" cy="12" r="2.5" {...stroke} />
    </svg>
  ),
};

function visibleBounds(model: Model3D, hidden: Set<number>) {
  const parts = model.parts.filter((_, i) => !hidden.has(i));
  if (parts.length === 0 || hidden.size === 0) return model.bounds;
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (const p of parts) {
    for (let k = 0; k < 3; k++) {
      min[k] = Math.min(min[k], p.bounds.min[k]);
      max[k] = Math.max(max[k], p.bounds.max[k]);
    }
  }
  return { min, max };
}
