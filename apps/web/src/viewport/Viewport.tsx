import { settingsFromHatch } from "../tools/hatchTool";
import { runDimEdit } from "../tools/dimEditCommands";
import { hatchesTinted } from "./hatchRender";
import { useEffect, useRef, useState } from "react";
import { autoConstrainSuppressed, withAutoConstraints } from "../tools/autoConstrain";
import type { BoxSelectMode, ClosedRegion, Command, Entity, EntityId, Point, TextEntity } from "@sketchor/core";
import {
  applyGrip,
  gripPointRef,
  arcSweep,
  boundsOf,
  gripsOf,
  type Grip,
  explodeCommands,
  joinCommands,
  simplifyPolylineCommands,
  bulgeToArc,
  dist,
  distToArc,
  kindHitDistance,
  distToSegment,
  polylineSegments,
  constraintAnchors,
  entityDofStates,
  entitiesInBox,
  entitiesCrossedByFence,
  entitiesInPolygon,
  editableAttributes,
  insertContents,
  attributeTable,
  attributeCsv,
  simplifyPath,
  selectSimilar,
  entityPoints,
  findClosedRegions,
  freeEndpointEntityIds,
  imageCorners,
  regionContainingPoint,
  resolveSelection,
  constraintEntityIds,
  layerOf,
  newEntityId,
  nextEntityName,
  polylineLength,
  entityLength,
  textCorners,
  linearDimension,
  newGroupId,
  wholeGroupSelected,
} from "@sketchor/core";
import {
  applyStraighten,
  beginBlockEdit,
  blockEditBackdrop,
  activeBlockEdit,
  saveBlockEdit,
  discardBlockEdit,
  bus,
  closeTab,
  computeStraightenTransform,
  doc,
  getSessionView,
  groupSelection,
  hiddenLayerSet,
  lockedLayerSet,
  selectableEntities,
  measurementText,
  referenceEdgeAngleDeg,
  setSessionView,
  ungroupSelection,
  useApp,
} from "../state/store";
import { openDrawing, saveCurrent } from "../io/drawingFile";
import { downloadText } from "../blocks/download";
import { useDimStyleUi } from "../dimstyles/dimStyleUi";
import { matchesBinding, matchesModifier } from "../keybindings";
import { printDrawing } from "../print/printDrawing";
import { formatArea, formatLength } from "../units";
import { CONSTRAINT_GLYPH_OFFSET, CONSTRAINT_GLYPH_SIZE, render } from "./renderer";
import { CONSTRAINT_GLYPHS } from "../constraints/ConstraintPanel";
import { setImageDecodeCallback } from "./imageCache";
import { findSnap, snapMovingSelection, snapRotation, SNAP_PX, type Snap } from "./snapping";
import { acquirePoint, trackAlignment, trackingAngles } from "./objectTracking";
import { fitToBounds, gridStep, screenToWorld, worldToScreen, zoomAt, type View } from "./view";
import { getTool, type Pick, type ToolContext } from "../tools";
import { copySelectionToClipboard, pasteFromClipboard } from "../io/clipboard";
import { applyTracking, trackingIncrement, useTracking } from "../tools/tracking";
import { useSnapSettings } from "../tools/snapSettings";
import { parseTypedInput, resolveTypedInput, startsTypedInput } from "../tools/typedInput";
import { parseCommand, type AppCommandId } from "../tools/commandLine";
import { COMMAND_LINE_ACTIONS } from "../metrics/actions";
import { track } from "../metrics/metrics";
import { CommandBar, type CommandEcho } from "../tools/CommandBar";
import { useTheme } from "../theme/themeStore";
import { useMTextUi } from "../mtext/mtextUi";

/**
 * The half-finished states a pan can interrupt. Panning or zooming mid-draw
 * must not throw the drawing away — you routinely need to scroll to where the
 * far end of a line goes — so a pan stashes one of these in its `resume` and
 * puts it back on pointer-up. (The drawing tools on the tool framework —
 * see ../tools — keep their own state and need no stashing; only the
 * legacy measure/dim sequences still live here.)
 */
type DrawInteraction = { kind: "measure"; start: Point } | { kind: "dim"; start: Point };

type Interaction =
  | { kind: "idle" }
  | { kind: "pan"; lastX: number; lastY: number; resume: DrawInteraction | { kind: "idle" } }
  /** Two fingers down: pan by the midpoint, zoom by the spread. Like "pan", it keeps a half-drawn entity. */
  | { kind: "pinch"; resume: DrawInteraction | { kind: "idle" } }
  | DrawInteraction
  | {
      kind: "move";
      ids: EntityId[];
      startWorld: Point;
      startScreen: Point;
      dx: number;
      dy: number;
      /** Every vertex of the selection at grab time; a snapped move aligns whichever one lands closest to a target. */
      baseVertices: Point[];
      /**
       * If this pointerdown grabbed an already-multi-selected item, the ids to
       * collapse the selection down to on pointerup *if it turns out to be a
       * plain click* (no drag) — a drag instead moves every currently selected
       * id together. `null` when no collapsing is needed (fresh click, or the
       * click already matched the whole selection).
       */
      collapseTo: EntityId[] | null;
    }
  | { kind: "rotate-group"; ids: EntityId[]; pivot: Point; startAngle: number; rotation: number }
  /** Dragging one grip of a selected entity (T-27); `preview` is the entity with the grip at the cursor. */
  /**
   * `preview` is what the drag would commit: just the dragged entity
   * normally, or every entity the solver moved when the sketch is
   * constrained (roadmap T-40's drag-solve).
   */
  | { kind: "grip"; entityId: EntityId; grip: Grip; startScreen: Point; preview: Entity[] }
  | { kind: "box-select"; startScreen: Point; startWorld: Point; currentWorld: Point; additive: boolean }
  /**
   * Alt-drag: a freehand path instead of a rectangle. Released as a **lasso**
   * (the loop closes; left-to-right takes only what is fully inside, like a
   * box) or, with the fence modifier held, as a **fence** — an open stroke
   * that takes everything it crosses.
   */
  | { kind: "free-select"; startScreen: Point; points: Point[]; additive: boolean; fence: boolean };

const DRAW_KINDS = ["measure", "dim"] as const;

/** The grip of a selected entity within reach of a screen point, nearest first. */
function findGrip(selection: EntityId[], screen: Point, view: View, touch: boolean): { entityId: EntityId; grip: Grip } | null {
  // Grips only show for small selections; a hundred selected entities would be a field of squares.
  if (selection.length === 0 || selection.length > 8) return null;
  const reach = touch ? GRIP_HIT_PX * 2 : GRIP_HIT_PX;
  let best: { entityId: EntityId; grip: Grip; d: number } | null = null;
  for (const id of selection) {
    const entity = doc.get(id);
    if (!entity) continue;
    for (const grip of gripsOf(entity)) {
      const d = dist(worldToScreen(view, grip.point), screen);
      if (d <= reach && (!best || d < best.d)) best = { entityId: id, grip, d };
    }
  }
  return best;
}

/** Narrows to the states worth preserving across a pan (see DrawInteraction). */
function resumable(i: Interaction): DrawInteraction | { kind: "idle" } {
  return (DRAW_KINDS as readonly string[]).includes(i.kind) ? (i as DrawInteraction) : { kind: "idle" };
}

/** Fixed pixel offset above a selected group's bounding box where its rotate handle is drawn/hit-tested. */
const GROUP_HANDLE_OFFSET_PX = 26;
const GROUP_HANDLE_HIT_PX = 8;
/** How close (screen px) a click must be to a grip to grab it. */
const GRIP_HIT_PX = 7;
/**
 * P-03 "Simplify polyline" (Shift+P / command line `simplify`): the
 * deviation a simplified polyline is allowed from the original, in mm.
 * 0.1mm is tight enough to be invisible on a laser/plasma-cut part but
 * loose enough to actually collapse a dense import — no settings surface
 * for this yet (fixed, not per-document or unit-aware).
 */
const DEFAULT_SIMPLIFY_TOLERANCE_MM = 0.1;

function groupHandleScreenPos(view: View, bb: { minX: number; maxX: number; maxY: number }): Point {
  const s = worldToScreen(view, { x: (bb.minX + bb.maxX) / 2, y: bb.maxY });
  return { x: s.x, y: s.y - GROUP_HANDLE_OFFSET_PX };
}

/** Every vertex of the selection — the anchors a snapped move/rotate can align. */
function selectionVertices(ids: EntityId[]): Point[] {
  const out: Point[] = [];
  for (const id of ids) {
    const entity = doc.get(id);
    if (!entity) continue;
    for (const p of entityPoints(entity)) out.push(p);
  }
  return out;
}

/** The "mouse.freeMove" modifier (Ctrl/⌘ by default, rebindable) held during a drag turns off position and angle snapping. */
function noSnap(e: { ctrlKey: boolean; metaKey: boolean; altKey: boolean; shiftKey: boolean }): boolean {
  return matchesModifier(e, "mouse.freeMove");
}

/**
 * Flips the current selection's `construction` flag (Z-04 — independent of
 * `linetype` now; before Z-04 this toggled the single `dashed` field that
 * conflated the two). Text has no construction concept and is skipped. If
 * every eligible entity is already construction, this clears them all;
 * otherwise it sets them all.
 */
function toggleConstruction(): void {
  const { selection } = useApp.getState();
  const targets = selection
    .map((id) => doc.get(id))
    .filter((e): e is Exclude<Entity, TextEntity> => !!e && e.type !== "text");
  if (targets.length === 0) return;
  const allConstruction = targets.every((e) => e.construction === true);
  const commands: Command[] = targets.map((e) => {
    const entity = { ...e };
    if (allConstruction) delete entity.construction;
    else entity.construction = true;
    return { type: "update-entity", entity };
  });
  bus.execute(commands.length === 1 ? commands[0] : { type: "batch", commands });
}

/** New geometry carries the active layer (omitted when it's the default). */
function activeLayerProp(active: string): { layer?: string } {
  return active && active !== "0" ? { layer: active } : {};
}

/** Snap kinds that mean the cursor is on a real feature point — trackable, and never overridden. */
const FEATURE_SNAP_KINDS = new Set<Snap["kind"]>([
  "origin",
  "endpoint",
  "midpoint",
  "center",
  "quadrant",
  "intersection",
  "node",
  "perpendicular",
  "tangent",
]);

/**
 * Window or crossing for a freehand loop, by the same rule a box uses: the
 * net direction of the drag. Ending right of where you started means
 * "only what I enclosed"; ending left means "anything I touched".
 */
function freeSelectMode(points: readonly Point[]): BoxSelectMode {
  if (points.length < 2) return "window";
  return points[points.length - 1].x >= points[0].x ? "window" : "crossing";
}

/** What a cycling popover row says: the entity's name if it has one, else its type. */
function entityLabel(entity: Entity): string {
  const layer = layerOf(entity);
  return `${entity.name ?? entity.type}${layer === "0" ? "" : ` · ${layer}`}`;
}

function hitTest(view: View, world: Point): EntityId | null {
  return hitCandidates(view, world)[0] ?? null;
}

/**
 * Everything within the pick aperture of `world`, nearest first — the list
 * selection cycling walks. A plain hit test is just its first element.
 */
function hitCandidates(view: View, world: Point): EntityId[] {
  const tol = 6 / view.scale;
  const found: { id: EntityId; d: number }[] = [];
  for (const e of selectableEntities()) {
    // Per-kind distance (kinds/builtin.ts): filled shapes are clickable anywhere inside.
    const d = kindHitDistance(e, world);
    if (d <= tol) found.push({ id: e.id, d });
  }
  // Nearest first; ties (two entities exactly under the cursor) keep
  // document order, so the topmost-drawn one leads.
  return found.sort((a, b) => a.d - b.d).map((f) => f.id);
}

/**
 * The topmost closed shape (a `closed` polyline or a circle) whose interior
 * contains `world` — the "click anywhere inside" target for the Fill tool.
 * Later entities win, matching paint order.
 */
function closedEntityAt(world: Point): Entity | null {
  let found: Entity | null = null;
  for (const e of selectableEntities()) {
    if (e.type === "circle") {
      if (dist(world, e.center) <= e.radius) found = e;
    } else if (e.type === "polyline" && e.closed && pointInPolygon(world, e.points)) {
      found = e;
    }
  }
  return found;
}

function pointInPolygon(p: Point, poly: Point[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i];
    const b = poly[j];
    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) {
      inside = !inside;
    }
  }
  return inside;
}

export function Viewport() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const viewRef = useRef<View>({ scale: 2, ox: 0, oy: 0 });
  const interactionRef = useRef<Interaction>({ kind: "idle" });
  /**
   * Fingers currently on the canvas, by pointer id, in screen space. One
   * finger is the tool (a tap clicks, a drag drags — exactly like the left
   * mouse button); the moment a second finger lands the gesture becomes a
   * two-finger pan/pinch-zoom from any tool, and a half-drawn line survives
   * it the same way it survives a middle-drag pan.
   */
  const touchesRef = useRef<Map<number, Point>>(new Map());
  /** Last single-finger tap, for double-tap detection (dblclick is unreliable with touch-action: none). */
  const lastTapRef = useRef<{ at: number; screen: Point } | null>(null);
  /**
   * A finger that has landed but whose tool action hasn't run yet. A
   * two-finger gesture necessarily starts with one finger down, and the
   * tools act on pointerdown — so a pinch would first place a line vertex
   * or select something. The action is held back until the finger either
   * moves (a drag), lifts (a tap), or is joined by a second one (a pinch,
   * and the action is dropped).
   */
  const pendingTouchRef = useRef<React.PointerEvent | null>(null);
  const snapRef = useRef<Snap | null>(null);
  /** The ortho/polar guide to draw, when the last pointer move was projected onto one. */
  const trackingRayRef = useRef<{ from: Point; to: Point; angleDeg: number } | null>(null);
  /** Object snap tracking (T-20): feature points the cursor has hovered, newest first, and the guides in play. */
  const acquiredRef = useRef<Point[]>([]);
  const trackRaysRef = useRef<{ from: Point; to: Point; angleDeg: number }[]>([]);
  /** Last pointer position on the canvas, where the typed-coordinate box opens. */
  const lastScreenRef = useRef<Point | null>(null);
  const hoverRef = useRef<EntityId | null>(null);
  /** The typed-coordinate box (T-08), open while a framework tool waits for a point and the user has started typing. */
  const [typed, setTyped] = useState<{ text: string; screen: Point } | null>(null);
  /**
   * The relative zero (T-08, LibreCAD's): the last point any tool placed.
   * `@dx,dy` measures from the tool's own anchor while it has one, and
   * from here when it doesn't — which is what makes "start 20 right of
   * that corner" typeable.
   */
  const relativeZeroRef = useRef<Point | null>(null);
  const [commandEcho, setCommandEcho] = useState<CommandEcho[]>([]);
  /** The selection-cycling list, open after a repeat click found more than one entity under the cursor. */
  const [cycle, setCycle] = useState<{ screen: Point; ids: EntityId[]; index: number } | null>(null);
  const cycleRef = useRef<{ screen: Point; at: number; index: number; ids: EntityId[] } | null>(null);
  const closedRegionsRef = useRef<ClosedRegion[]>([]);
  const tool = useApp((s) => s.tool);
  const commandLine = useApp((s) => s.commandLine);
  const promptText = useApp((s) => s.prompt);
  const selection = useApp((s) => s.selection);
  const revision = useApp((s) => s.revision);
  const themeResolved = useTheme((s) => s.tokens);
  const layers = useApp((s) => s.layers);

  // The floating text editor: open while placing or editing a text entity.
  const [textEdit, setTextEdit] = useState<{
    screen: Point;
    world: Point;
    value: string;
    id: EntityId | null;
    rotation: number;
    height: number;
  } | null>(null);

  const redraw = () => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    if (canvas.width !== w * dpr || canvas.height !== h * dpr) {
      canvas.width = w * dpr;
      canvas.height = h * dpr;
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    const state = useApp.getState();
    // During a pan, draw the interaction it suspended — otherwise the rubber
    // band vanishes the moment you scroll to see where the line is going.
    const held = interactionRef.current;
    const interaction: Interaction = held.kind === "pan" || held.kind === "pinch" ? held.resume : held;
    const snap = snapRef.current;

    const activeTool = getTool(state.tool);
    const preview: Entity[] = activeTool ? activeTool.preview(toolCtx, snap?.point ?? null) : [];
    // In the block editor the attribute definitions have no entity of their own: show each tag as text.
    for (const a of activeBlockEdit()?.attributeDefs ?? []) {
      preview.push({ id: `attdef:${a.tag}`, type: "text", at: a.at, text: `<${a.tag}>`, height: a.height, rotation: a.rotation });
    }

    const straightenPlan = state.tool === "straighten" ? computeStraightenTransform() : null;

    // A whole-group selection gets a dashed bbox + rotate handle (select tool only).
    const groupId = state.tool === "select" ? wholeGroupSelected(doc, state.selection) : null;
    const groupBounds = groupId
      ? boundsOf(state.selection.map((id) => doc.get(id)).filter((e): e is Entity => !!e))
      : null;
    const rotating = interaction.kind === "rotate-group" ? interaction : null;
    const groupPivot = rotating
      ? rotating.pivot
      : groupBounds
        ? { x: (groupBounds.minX + groupBounds.maxX) / 2, y: (groupBounds.minY + groupBounds.maxY) / 2 }
        : null;

    render(ctx, w, h, viewRef.current, doc, {
      selection: new Set(state.selection),
      backdrop: blockEditBackdrop(),
      preview,
      snap: state.tool === "select" ? null : snap,
      trackingRay: activeTool ? trackingRayRef.current : null,
      trackRays: activeTool ? trackRaysRef.current : [],
      relativeZero: activeTool ? relativeZeroRef.current : null,
      constraintGlyphs: constraintGlyphs(),
      dofStates: state.showDofColours ? entityDofStates(doc.solverConstraints(), bus.lastSolve) : undefined,
      acquiredPoints: activeTool ? acquiredRef.current : [],
      moveOffset:
        interaction.kind === "move" ? { dx: interaction.dx, dy: interaction.dy } : null,
      measurement: state.measurement,
      pinnedMeasurements: state.pinnedMeasurements,
      hiddenLayers: hiddenLayerSet(),
      lockedLayers: lockedLayerSet(),
      referenceEdgeId: state.tool === "straighten" || state.tool === "measure" ? state.referenceEdgeId : null,
      hoverId: state.tool === "measure" ? hoverRef.current : null,
      transformPreview: rotating
        ? { ids: new Set(rotating.ids), pivot: rotating.pivot, rotation: rotating.rotation }
        : straightenPlan
          ? { ...straightenPlan, ids: new Set(straightenPlan.ids) }
          : null,
      healMarkers: state.healIssues.map((i) => i.location),
      duplicateMarkers: state.duplicateIssues.map((i) => i.location),
      crossingMarkers: state.crossingIssues.map((i) => i.location),
      groupHandle: groupBounds && groupPivot ? { bounds: groupBounds, pivot: groupPivot } : null,
      gripPreview: interaction.kind === "grip" ? interaction.preview : [],
      freeEndpointIds: state.showConnectivityHint ? freeEndpointEntityIds(doc) : null,
      closedRegions: state.showClosedRegions ? closedRegionsRef.current.map((r) => r.points) : [],
      fmtLength: (n: number) => formatLength(n, state.displayUnit),
      fmtArea: (n: number) => formatArea(n, state.displayUnit),
      freeSelect:
        interaction.kind === "free-select"
          ? {
              points: interaction.points,
              kind: interaction.fence ? ("fence" as const) : ("lasso" as const),
              mode: freeSelectMode(interaction.points),
            }
          : null,
      boxSelect:
        interaction.kind === "box-select"
          ? {
              start: interaction.startWorld,
              end: interaction.currentWorld,
              mode: (interaction.currentWorld.x >= interaction.startWorld.x ? "window" : "crossing") as BoxSelectMode,
            }
          : null,
    });
    useApp.getState().setHatchTinted(hatchesTinted());
  };

  /** What a framework tool may touch (see ../tools/tool.ts). Stable for the component's life. */
  const toolCtxRef = useRef<ToolContext | null>(null);
  if (!toolCtxRef.current) {
    toolCtxRef.current = {
      doc,
      execute: (command) => bus.execute(withAutoConstraints(command, doc)),
      commit: (commands) => {
        if (commands.length === 1) bus.execute(withAutoConstraints(commands[0], doc));
        else if (commands.length > 1) bus.execute(withAutoConstraints({ type: "batch", commands }, doc));
      },
      activeLayer: () => useApp.getState().activeLayer,
      redraw: () => redraw(),
      setTool: (id) => useApp.getState().setTool(id),
      selection: () => useApp.getState().selection,
      setSelection: (ids) => useApp.getState().setSelection(ids),
      hitTest: (world) => {
        const hit = hitTest(viewRef.current, world);
        return hit ? resolveSelection(doc, hit, useApp.getState().enteredGroupId) : [];
      },
      displayUnit: () => useApp.getState().displayUnit,
      zoomTo: (minX, minY, maxX, maxY) => {
        const canvas = canvasRef.current;
        if (!canvas) return;
        rememberView();
        viewRef.current = fitToBounds({ minX, minY, maxX, maxY }, canvas.clientWidth, canvas.clientHeight, 0.02);
        useApp.getState().setZoom(viewRef.current.scale);
        redraw();
      },
    };
  }
  const toolCtx = toolCtxRef.current;

  /** Pushes the active tool's prompt to the status bar. */
  const syncPrompt = () => {
    const app = useApp.getState();
    const t = getTool(app.tool);
    app.setPrompt(t ? t.prompt(toolCtx) : "");
  };

  /**
   * Resolves a cursor position into what a tool receives, in the order
   * AutoCAD uses: the object snap the cursor actually touched wins; else
   * ortho/polar from the tool's anchor; else an alignment with a feature
   * point the cursor hovered earlier (object snap tracking, T-20). Also
   * records the guides for the renderer, and acquires the hovered point.
   */
  const resolvePick = (world: Point, shiftKey: boolean): { snap: Snap; ray: typeof trackingRayRef.current } => {
    const view = viewRef.current;
    const app = useApp.getState();
    const t = getTool(app.tool);
    const raw = findSnap(doc, view, world, { anchor: t?.anchor() ?? null, settings: useSnapSettings.getState().settings });
    const tracking = useTracking.getState();
    // Hovering a feature point makes it trackable, as in AutoCAD — no
    // separate gesture, and the acquired list is short enough to stay
    // predictable.
    if (tracking.otrack && FEATURE_SNAP_KINDS.has(raw.kind)) {
      acquiredRef.current = acquirePoint(acquiredRef.current, raw.point);
    }
    trackRaysRef.current = [];
    if (!t) return { snap: raw, ray: null };
    const increment = trackingIncrement(tracking, shiftKey);
    const tracked = applyTracking(t.anchor(), world, raw, increment);
    if (tracked.ray) {
      return {
        snap: { point: tracked.point, kind: "tracking" },
        ray: { from: tracked.ray.from, to: tracked.point, angleDeg: tracked.ray.angleDeg },
      };
    }
    if (tracking.otrack && !FEATURE_SNAP_KINDS.has(raw.kind)) {
      const hit = trackAlignment(world, acquiredRef.current, trackingAngles(increment), SNAP_PX / view.scale);
      if (hit) {
        trackRaysRef.current = hit.rays.map((r) => ({ from: r.from, to: hit.point, angleDeg: r.angleDeg }));
        return { snap: { point: hit.point, kind: "tracking" }, ray: null };
      }
    }
    return { snap: raw, ray: null };
  };

  /**
   * Every constraint mark currently on screen, with the world point it
   * hangs off. Built once per render and reused by the hit test, so a
   * click and the picture can't disagree about where a glyph is.
   */
  const constraintGlyphs = (): { id: string; at: Point; glyph: string; state: "normal" | "conflict" | "highlight" }[] => {
    const app = useApp.getState();
    if (!app.showConstraintGlyphs) return [];
    const conflicts = new Set(bus.lastSolve?.conflicts ?? []);
    const lookup = (id: EntityId) => doc.get(id);
    const out: { id: string; at: Point; glyph: string; state: "normal" | "conflict" | "highlight" }[] = [];
    for (const c of doc.constraints()) {
      const state = conflicts.has(c.id) ? "conflict" : app.highlightedConstraint === c.id ? "highlight" : "normal";
      for (const at of constraintAnchors(lookup, c)) out.push({ id: c.id, at, glyph: CONSTRAINT_GLYPHS[c.type], state });
    }
    return out;
  };

  /** The constraint whose glyph is under a screen point, if any. */
  const glyphAt = (screen: Point): string | null => {
    const view = viewRef.current;
    const reach = CONSTRAINT_GLYPH_SIZE / 2 + 2;
    for (const g of constraintGlyphs()) {
      const p = worldToScreen(view, g.at);
      const dx = screen.x - (p.x + CONSTRAINT_GLYPH_OFFSET.x);
      const dy = screen.y - (p.y + CONSTRAINT_GLYPH_OFFSET.y);
      if (Math.abs(dx) <= reach && Math.abs(dy) <= reach) return g.id;
    }
    return null;
  };

  /**
   * What a grip drag would commit. On an unconstrained drawing that is
   * simply the entity with its grip moved. Once the sketch has
   * constraints and the grip names a point the solver understands, the
   * cursor's pull goes through the solver instead, so everything tied to
   * that point comes along — the drag-solve that makes a constrained
   * sketch feel alive rather than stuck (roadmap T-40).
   */
  const gripPreviewFor = (entity: Entity, grip: Grip, target: Point): Entity[] => {
    const plain = [applyGrip(entity, grip, target)];
    if (doc.constraints().length === 0) return plain;
    const ref = gripPointRef(entity, grip);
    if (!ref) return plain;
    const solved = bus.solveSilently({ drag: { ref, to: target } });
    return solved && solved.updates.length > 0 ? solved.updates : plain;
  };

  /**
   * Commits a typed string to the active tool: the tool's own reading of it
   * first (an angle for rotate, a factor for scale), else a coordinate
   * relative to its anchor — or to the relative zero when it has none.
   * Shared by the floating coordinate box and the command line.
   */
  const commitTypedText = (text: string): boolean => {
    const app = useApp.getState();
    const t = getTool(app.tool);
    if (!t) return false;
    if (t.typed?.(toolCtx, text)) {
      syncPrompt();
      redraw();
      return true;
    }
    const parsed = parseTypedInput(text, app.displayUnit);
    const cursor = lastScreenRef.current ? screenToWorld(viewRef.current, lastScreenRef.current) : null;
    const point = parsed ? resolveTypedInput(parsed, t.anchor() ?? relativeZeroRef.current, cursor) : null;
    if (!point) return false;
    t.pick(toolCtx, { point, world: point, snap: null, shiftKey: false, ctrlKey: false, altKey: false });
    relativeZeroRef.current = point;
    syncPrompt();
    redraw();
    return true;
  };

  const pickFrom = (e: { shiftKey: boolean; ctrlKey: boolean; metaKey: boolean; altKey: boolean }, world: Point, snap: Snap): Pick => {
    autoConstrainSuppressed.value = e.ctrlKey || e.metaKey; // T-43: Ctrl suppresses inference for this click
    return {
      point: snap.point,
      world,
      snap,
      shiftKey: e.shiftKey,
      ctrlKey: e.ctrlKey || e.metaKey,
      altKey: e.altKey,
    };
  };

  // Switching tools drops the previous tool's half-finished sequence and
  // shows the new one's prompt.
  const prevToolRef = useRef(tool);
  useEffect(() => {
    if (prevToolRef.current !== tool) {
      getTool(prevToolRef.current)?.cancel(toolCtx);
      prevToolRef.current = tool;
      setTyped(null);
    }
    trackingRayRef.current = null;
    trackRaysRef.current = [];
    acquiredRef.current = [];
    syncPrompt();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tool]);

  // Initial placement of the origin + resize handling
  useEffect(() => {
    const canvas = canvasRef.current!;
    viewRef.current.ox = canvas.clientWidth * 0.25;
    viewRef.current.oy = canvas.clientHeight * 0.75;
    useApp.getState().setZoom(viewRef.current.scale);
    const observer = new ResizeObserver(redraw);
    observer.observe(canvas);
    redraw();
    return () => observer.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Image entities decode asynchronously (drawEntity can't await); redraw
  // once a decode finishes so the placeholder box is replaced by the picture.
  useEffect(() => {
    setImageDecodeCallback(redraw);
    return () => setImageDecodeCallback(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const activeSessionId = useApp((s) => s.activeSessionId);
  const prevSessionIdRef = useRef(activeSessionId);

  // Switching tabs: save the outgoing tab's pan/zoom, restore (or default) the incoming one's.
  useEffect(() => {
    const prevId = prevSessionIdRef.current;
    if (prevId === activeSessionId) return;
    setSessionView(prevId, viewRef.current);
    prevSessionIdRef.current = activeSessionId;

    const canvas = canvasRef.current;
    if (!canvas) return;
    const saved = getSessionView(activeSessionId);
    viewRef.current = saved ?? {
      scale: 2,
      ox: canvas.clientWidth * 0.25,
      oy: canvas.clientHeight * 0.75,
    };
    useApp.getState().setZoom(viewRef.current.scale);
    redraw();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeSessionId]);

  const measurement = useApp((s) => s.measurement);
  const pinnedMeasurements = useApp((s) => s.pinnedMeasurements);
  const referenceEdgeId = useApp((s) => s.referenceEdgeId);
  const straightenAxis = useApp((s) => s.straightenAxis);
  const straightenPivot = useApp((s) => s.straightenPivot);
  const healIssues = useApp((s) => s.healIssues);
  const duplicateIssues = useApp((s) => s.duplicateIssues);
  const crossingIssues = useApp((s) => s.crossingIssues);
  const healFocus = useApp((s) => s.healFocus);
  const showConnectivityHint = useApp((s) => s.showConnectivityHint);
  const showClosedRegions = useApp((s) => s.showClosedRegions);
  const showSplineCvs = useApp((s) => s.showSplineCvs);

  // Closed-loop detection only needs to rerun when the document changes, not
  // on every redraw (pan/zoom/selection) — cached here. Computed regardless
  // of the display toggle, since the measure tool's area-click also needs
  // it even when the highlight fill itself is turned off.
  useEffect(() => {
    closedRegionsRef.current = findClosedRegions(doc.all());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [revision]);

  // Redraw when document, selection, tool, measurement, layers, the straighten pick, heal findings, or the theme change
  useEffect(redraw, [
    revision,
    selection,
    tool,
    measurement,
    pinnedMeasurements,
    layers,
    referenceEdgeId,
    straightenAxis,
    straightenPivot,
    healIssues,
    duplicateIssues,
    crossingIssues,
    showConnectivityHint,
    showClosedRegions,
    showSplineCvs,
    themeResolved,
  ]);

  // Diagnostics panel row click: frame that finding.
  useEffect(() => {
    if (!healFocus) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const margin = 15;
    viewRef.current = fitToBounds(
      {
        minX: healFocus.x - margin,
        minY: healFocus.y - margin,
        maxX: healFocus.x + margin,
        maxY: healFocus.y + margin,
      },
      canvas.clientWidth,
      canvas.clientHeight,
      0.3,
    );
    useApp.getState().setZoom(viewRef.current.scale);
    redraw();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [healFocus]);

  const duplicateFocus = useApp((s) => s.duplicateFocus);
  // Duplicates panel row click: frame that finding.
  useEffect(() => {
    if (!duplicateFocus) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const margin = 15;
    viewRef.current = fitToBounds(
      {
        minX: duplicateFocus.x - margin,
        minY: duplicateFocus.y - margin,
        maxX: duplicateFocus.x + margin,
        maxY: duplicateFocus.y + margin,
      },
      canvas.clientWidth,
      canvas.clientHeight,
      0.3,
    );
    useApp.getState().setZoom(viewRef.current.scale);
    redraw();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [duplicateFocus]);

  /** Views before each zoom-extents / zoom-window, for "zoom previous" (T-29). */
  const viewHistoryRef = useRef<View[]>([]);
  const rememberView = () => {
    const h = viewHistoryRef.current;
    h.push({ ...viewRef.current });
    if (h.length > 20) h.shift();
  };
  const zoomPrevious = () => {
    const prev = viewHistoryRef.current.pop();
    if (!prev) return;
    viewRef.current = prev;
    useApp.getState().setZoom(prev.scale);
    redraw();
  };

  /** Zoom-extents: frames `ids` if given and non-empty, else every visible entity. */
  const fitView = (ids?: EntityId[]) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const hidden = hiddenLayerSet();
    const visible = doc.all().filter((e) => !hidden.has(layerOf(e)));
    const targets = ids && ids.length ? visible.filter((e) => ids.includes(e.id)) : visible;
    const bb = boundsOf(targets);
    if (!bb) return;
    rememberView();
    viewRef.current = fitToBounds(bb, canvas.clientWidth, canvas.clientHeight);
    useApp.getState().setZoom(viewRef.current.scale);
    redraw();
  };

  const fitRequestId = useApp((s) => s.fitRequestId);
  const firstFitRequestRef = useRef(true);
  // Opening a file (importDxfText/importEntities) bumps fitRequestId so the
  // newly-loaded part fills the viewport instead of sitting at whatever pan/zoom was left over.
  useEffect(() => {
    if (firstFitRequestRef.current) {
      firstFitRequestRef.current = false;
      return;
    }
    fitView();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fitRequestId]);

  // Keyboard: tools, undo/redo, delete, escape. Most bindings are rebindable
  // (see keybindings.ts) via matchesBinding(); a few stay hard-coded because
  // they're mode-dependent rather than a single command — Escape, Delete/
  // Backspace-to-delete-selection, and the in-progress-polyline keys.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      if (target.tagName === "INPUT" || target.tagName === "TEXTAREA") return;
      const app = useApp.getState();
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "c" && app.tool === "measure" && app.measurement) {
        e.preventDefault();
        void navigator.clipboard.writeText(measurementText(app.measurement, app.displayUnit, referenceEdgeAngleDeg()));
      } else if (matchesBinding(e, "file.save")) {
        e.preventDefault();
        void saveCurrent();
      } else if (matchesBinding(e, "file.open")) {
        e.preventDefault();
        void openDrawing();
      } else if (matchesBinding(e, "file.print")) {
        e.preventDefault();
        printDrawing();
      } else if (matchesBinding(e, "file.closeTab")) {
        // Desktop only in practice: browsers reserve Ctrl+W to close their own
        // tab and won't let a page preventDefault it.
        e.preventDefault();
        closeTab(useApp.getState().activeSessionId);
      } else if (matchesBinding(e, "edit.undo")) {
        bus.undo();
        e.preventDefault();
      } else if (matchesBinding(e, "edit.redo")) {
        bus.redo();
        e.preventDefault();
      } else if (matchesBinding(e, "edit.copy") || matchesBinding(e, "edit.cut")) {
        if (app.selection.length > 0) {
          e.preventDefault();
          void copySelectionToClipboard(app.selection, matchesBinding(e, "edit.cut"));
        }
      } else if (matchesBinding(e, "edit.paste") || matchesBinding(e, "edit.pasteInPlace")) {
        e.preventDefault();
        const inPlace = matchesBinding(e, "edit.pasteInPlace");
        const at = !inPlace && lastScreenRef.current ? (snapRef.current?.point ?? screenToWorld(viewRef.current, lastScreenRef.current)) : null;
        void pasteFromClipboard(at).then((ids) => {
          if (ids.length > 0) {
            app.setSelection(ids);
            app.setTool("select");
          }
        });
      } else if (matchesBinding(e, "edit.duplicate")) {
        if (app.selection.length > 0) {
          e.preventDefault();
          const step = gridStep(viewRef.current.scale);
          void copySelectionToClipboard(app.selection, false, { internalOnly: true }).then(() =>
            pasteFromClipboard(null, { x: step, y: step }).then((ids) => {
              if (ids.length > 0) app.setSelection(ids);
            }),
          );
        }
      } else if ((e.key === "ArrowLeft" || e.key === "ArrowRight" || e.key === "ArrowUp" || e.key === "ArrowDown") && app.selection.length > 0 && !getTool(app.tool)?.busy()) {
        e.preventDefault();
        const step = gridStep(viewRef.current.scale) * (e.shiftKey ? 10 : 1);
        const dx = e.key === "ArrowLeft" ? -step : e.key === "ArrowRight" ? step : 0;
        const dy = e.key === "ArrowDown" ? -step : e.key === "ArrowUp" ? step : 0;
        bus.execute({ type: "move-entities", ids: app.selection, dx, dy });
      } else if (matchesBinding(e, "view.ortho")) {
        e.preventDefault();
        useTracking.getState().toggleOrtho();
      } else if (matchesBinding(e, "view.polar")) {
        e.preventDefault();
        useTracking.getState().togglePolar();
      } else if (matchesBinding(e, "view.commandLine")) {
        e.preventDefault();
        app.toggleCommandLine();
      } else if (matchesBinding(e, "edit.relativeZero")) {
        e.preventDefault();
        runAppCommand("relativeZero");
      } else if (matchesBinding(e, "view.otrack")) {
        e.preventDefault();
        useTracking.getState().toggleOtrack();
        acquiredRef.current = [];
      } else if (getTool(app.tool)?.key?.(toolCtx, e)) {
        // The active tool's own keys (finish/close a polyline, arc modes, ...) come before the global ones.
        e.preventDefault();
        syncPrompt();
        redraw();
      } else if (getTool(app.tool) && startsTypedInput(e.key) && !e.ctrlKey && !e.metaKey && !e.altKey) {
        // Start of a typed coordinate: open the box with this character in it.
        e.preventDefault();
        const screen = lastScreenRef.current ?? { x: 40, y: 40 };
        setTyped({ text: e.key, screen });
      } else if (e.key === "Delete" || e.key === "Backspace") {
        if (app.selection.length > 0) {
          bus.execute({ type: "delete-entities", ids: app.selection });
        }
      } else if (e.key === "Escape") {
        // One key that always gets you back to a known-safe state: abandon
        // whatever is half-drawn, drop the selection, and fall back to the
        // select tool so the next stray click can't add geometry.
        getTool(app.tool)?.cancel(toolCtx);
        setTyped(null);
        setCycle(null);
        acquiredRef.current = [];
        interactionRef.current = { kind: "idle" };
        app.setSelection([]);
        app.setMeasurement(null);
        app.setEnteredGroup(null);
        app.setTool("select");
        redraw();
      } else if (matchesBinding(e, "edit.toggleConstruction") && interactionRef.current.kind === "idle") {
        e.preventDefault();
        toggleConstruction();
      } else if (matchesBinding(e, "tool.select")) {
        app.setTool("select");
      } else if (matchesBinding(e, "tool.line")) {
        app.setTool("line");
      } else if (matchesBinding(e, "tool.polyline")) {
        app.setTool("polyline");
      } else if (matchesBinding(e, "tool.rectangle")) {
        app.setTool("rectangle");
      } else if (matchesBinding(e, "tool.circle")) {
        app.setTool("circle");
      } else if (matchesBinding(e, "tool.arc")) {
        app.setTool("arc");
      } else if (matchesBinding(e, "tool.ellipse")) {
        app.setTool("ellipse");
      } else if (matchesBinding(e, "tool.spline")) {
        app.setTool("spline");
      } else if (matchesBinding(e, "tool.polygon")) {
        app.setTool("polygon");
      } else if (matchesBinding(e, "tool.slot")) {
        app.setTool("slot");
      } else if (matchesBinding(e, "tool.move")) {
        app.setTool("move");
      } else if (matchesBinding(e, "tool.copy")) {
        app.setTool("copy");
      } else if (matchesBinding(e, "tool.rotate")) {
        app.setTool("rotate");
      } else if (matchesBinding(e, "tool.scale")) {
        app.setTool("scale");
      } else if (matchesBinding(e, "tool.mirror")) {
        app.setTool("mirror");
      } else if (matchesBinding(e, "tool.trim")) {
        app.setTool("trim");
      } else if (matchesBinding(e, "tool.split")) {
        app.setTool("split");
      } else if (matchesBinding(e, "tool.fillet")) {
        app.setTool("fillet");
      } else if (matchesBinding(e, "tool.chamfer")) {
        app.setTool("chamfer");
      } else if (matchesBinding(e, "tool.offset")) {
        app.setTool("offset");
      } else if (matchesBinding(e, "tool.block")) {
        app.setTool("block");
      } else if (matchesBinding(e, "tool.divide")) {
        app.setTool("divide");
      } else if (matchesBinding(e, "tool.align")) {
        app.setTool("align");
      } else if (matchesBinding(e, "tool.lengthen")) {
        app.setTool("lengthen");
      } else if (matchesBinding(e, "tool.match")) {
        app.setTool("match");
      } else if (matchesBinding(e, "tool.stretch")) {
        app.setTool("stretch");
      } else if (matchesBinding(e, "tool.point")) {
        app.setTool("point");
      } else if (matchesBinding(e, "tool.image")) {
        app.setTool("image");
      } else if (matchesBinding(e, "tool.measure")) {
        app.setTool("measure");
      } else if (matchesBinding(e, "view.fit")) {
        fitView(app.selection.length ? app.selection : undefined);
      } else if (matchesBinding(e, "view.zoomPrevious")) {
        e.preventDefault();
        zoomPrevious();
      } else if (matchesBinding(e, "view.zoomWindow")) {
        app.setTool("zoom");
      } else if (matchesBinding(e, "edit.selectAll")) {
        e.preventDefault();
        app.setSelection(selectableEntities().map((en) => en.id));
      } else if (matchesBinding(e, "edit.invertSelection")) {
        e.preventDefault();
        const cur = new Set(app.selection);
        app.setSelection(selectableEntities().filter((en) => !cur.has(en.id)).map((en) => en.id));
      } else if (matchesBinding(e, "edit.selectSimilar")) {
        e.preventDefault();
        // Same type, same layer, same colour as whatever is selected now —
        // the one-gesture way to grab all 400 of something in an import.
        const samples = app.selection.map((id) => doc.get(id)).filter((en): en is Entity => !!en);
        if (samples.length > 0) app.setSelection(selectSimilar(selectableEntities(), samples));
      } else if (matchesBinding(e, "edit.join")) {
        e.preventDefault();
        const commands = joinCommands(app.selection.map((id) => doc.get(id)).filter((en): en is Entity => !!en));
        if (commands.length > 0) {
          bus.execute({ type: "batch", commands });
          app.setSelection(commands.filter((c) => c.type === "add-entity").map((c) => (c as { entity: Entity }).entity.id));
        }
      } else if (matchesBinding(e, "edit.explode")) {
        e.preventDefault();
        const commands = explodeCommands(app.selection.map((id) => doc.get(id)).filter((en): en is Entity => !!en));
        if (commands.length > 0) {
          bus.execute({ type: "batch", commands });
          app.setSelection(commands.filter((c) => c.type === "add-entity").map((c) => (c as { entity: Entity }).entity.id));
        }
      } else if (matchesBinding(e, "edit.simplify")) {
        e.preventDefault();
        const commands = simplifyPolylineCommands(
          app.selection.map((id) => doc.get(id)).filter((en): en is Entity => !!en),
          DEFAULT_SIMPLIFY_TOLERANCE_MM,
        );
        if (commands.length > 0) {
          bus.execute({ type: "batch", commands });
          app.setSelection(commands.filter((c) => c.type === "add-entity").map((c) => (c as { entity: Entity }).entity.id));
        }
      } else if (matchesBinding(e, "tool.straighten")) {
        app.setTool("straighten");
      } else if (matchesBinding(e, "tool.fill")) {
        app.setTool("fill");
      } else if (matchesBinding(e, "tool.text")) {
        app.setTool("text");
      } else if (matchesBinding(e, "tool.dim")) {
        app.setTool("dim");
      } else if (e.key === "Enter" && app.tool === "straighten") {
        applyStraighten();
      } else if (e.key === "Enter" && app.tool === "measure" && app.measurement) {
        app.pinMeasurement();
      } else if (matchesBinding(e, "edit.group") && app.tool === "select") {
        groupSelection();
      } else if (matchesBinding(e, "edit.ungroup") && app.tool === "select") {
        ungroupSelection();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    setCycle(null);
  }, [tool]);

  const screenPos = (e: React.PointerEvent): Point => {
    const rect = canvasRef.current!.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  };

  /**
   * Clicking the same spot again takes the *next* entity under the cursor
   * rather than the same one (AutoCAD's SELECTIONCYCLING), and puts up a
   * list so you can jump straight to the one you wanted. Repeat clicks
   * inside the double-click window are left alone — that gesture already
   * means "enter this group" / "zoom to fit".
   */
  const cyclingHit = (view: View, world: Point, screen: Point): EntityId | null => {
    const ids = hitCandidates(view, world);
    const prev = cycleRef.current;
    const now = performance.now();
    const sameSpot =
      !!prev &&
      dist(prev.screen, screen) < 6 &&
      prev.ids.length === ids.length &&
      prev.ids.every((id, i) => id === ids[i]);
    const index = sameSpot && now - prev.at > 300 ? (prev.index + 1) % ids.length : 0;
    cycleRef.current = ids.length > 0 ? { screen, at: now, index, ids } : null;
    setCycle(index > 0 ? { screen, ids, index } : null);
    return ids[index] ?? null;
  };

  const onPointerDown = (e: React.PointerEvent) => {
    try {
      canvasRef.current!.setPointerCapture(e.pointerId);
    } catch {
      // synthetic events (tests, automation) have no active pointer
    }
    if (e.pointerType !== "touch") {
      toolPointerDown(e);
      return;
    }
    const screen = screenPos(e);
    touchesRef.current.set(e.pointerId, screen);
    if (touchesRef.current.size >= 2) {
      // Second finger: the first finger's pending action is dropped and the
      // gesture becomes a pinch. A drag-move or box-select already in
      // progress is simply abandoned (nothing was committed yet); a
      // half-drawn entity is kept, as for a pan.
      pendingTouchRef.current = null;
      if (interactionRef.current.kind !== "pinch") {
        interactionRef.current = { kind: "pinch", resume: resumable(interactionRef.current) };
        redraw();
      }
      return;
    }
    // Double-tap: fit the tapped entity, or the whole drawing.
    const prev = lastTapRef.current;
    const now = performance.now();
    if (prev && now - prev.at < 350 && dist(prev.screen, screen) < 30) {
      lastTapRef.current = null;
      const world = screenToWorld(viewRef.current, screen);
      const t = getTool(useApp.getState().tool);
      if (t?.doubleClick?.(toolCtx, pickFrom(e, world, resolvePick(world, e.shiftKey).snap))) {
        syncPrompt();
        redraw();
      } else {
        const hit = hitTest(viewRef.current, world);
        fitView(hit ? [hit] : undefined);
      }
      return;
    }
    lastTapRef.current = { at: now, screen };
    pendingTouchRef.current = e;
  };

  /** Runs the held-back tool action of a single finger (see pendingTouchRef), if any. */
  const flushPendingTouch = () => {
    const pending = pendingTouchRef.current;
    if (!pending) return;
    pendingTouchRef.current = null;
    toolPointerDown(pending);
  };

  /** The tool's response to a primary-button press (or a single finger): what pointerdown does once it's known not to be a gesture. */
  const toolPointerDown = (e: React.PointerEvent) => {
    const screen = screenPos(e);
    const view = viewRef.current;
    const world = screenToWorld(view, screen);
    const app = useApp.getState();

    // Middle/right-drag pans from any tool, and explicitly preserves a
    // half-drawn line/polyline/circle/measurement rather than replacing it.
    // The pan tool does the same with the primary button (one finger).
    if (e.button === 1 || e.button === 2 || (e.button === 0 && app.tool === "pan")) {
      interactionRef.current = {
        kind: "pan",
        lastX: screen.x,
        lastY: screen.y,
        resume: resumable(interactionRef.current),
      };
      return;
    }
    if (e.button !== 0) return;

    if (app.tool === "select") {
      // A constraint mark is on top of everything: it is small, and the
      // geometry under it is reachable a pixel away.
      const glyph = glyphAt(screen);
      if (glyph) {
        const constraint = doc.constraints().find((c) => c.id === glyph);
        app.setHighlightedConstraint(glyph);
        if (constraint) app.setSelection(constraintEntityIds(constraint).filter((id) => !!doc.get(id)));
        interactionRef.current = { kind: "idle" };
        redraw();
        return;
      }
      app.setHighlightedConstraint(null);
      // A grip of a selected entity under the cursor beats everything else.
      const gripHit = findGrip(app.selection, screen, view, e.pointerType === "touch");
      if (gripHit) {
        interactionRef.current = { kind: "grip", entityId: gripHit.entityId, grip: gripHit.grip, startScreen: screen, preview: [] };
        redraw();
        return;
      }
      const groupId = wholeGroupSelected(doc, app.selection);
      const bb = groupId
        ? boundsOf(app.selection.map((id) => doc.get(id)).filter((ent): ent is Entity => !!ent))
        : null;
      if (bb && dist(screen, groupHandleScreenPos(view, bb)) <= GROUP_HANDLE_HIT_PX) {
        const pivot = { x: (bb.minX + bb.maxX) / 2, y: (bb.minY + bb.maxY) / 2 };
        const startAngle = Math.atan2(world.y - pivot.y, world.x - pivot.x);
        interactionRef.current = { kind: "rotate-group", ids: app.selection, pivot, startAngle, rotation: 0 };
        redraw();
        return;
      }
    }

    const fwTool = getTool(app.tool);
    if (fwTool) {
      const { snap } = resolvePick(world, e.shiftKey);
      fwTool.pick(toolCtx, pickFrom(e, world, snap));
      relativeZeroRef.current = snap.point;
      setTyped(null);
      syncPrompt();
      redraw();
      return;
    }

    const snapped = findSnap(doc, view, world, { settings: useSnapSettings.getState().settings }).point;
    const interaction = interactionRef.current;

    switch (app.tool) {
      case "line":
      case "polyline":
      case "circle":
      case "arc":
      case "ellipse":
      case "spline":
      case "polygon":
      case "slot":
      case "rectangle":
      case "point":
      case "move":
      case "copy":
      case "rotate":
      case "scale":
      case "mirror":
      case "trim":
      case "split":
      case "fillet":
      case "chamfer":
      case "offset":
      case "zoom":
      case "block":
      case "blockbase":
      case "insert":
      case "attdef":
      case "divide":
      case "align":
      case "lengthen":
      case "match":
      case "stretch":
        // On the tool framework; dispatched above.
        break;
      case "image": {
        // A file picker, not a two-click draw — insert at the point clicked
        // once a file is actually chosen, then drop back to the select tool
        // so the new image can be moved/resized right away.
        const insertAt = snapped;
        const input = document.createElement("input");
        input.type = "file";
        input.accept = "image/*";
        input.onchange = () => {
          const file = input.files?.[0];
          if (!file) return;
          const reader = new FileReader();
          reader.onload = () => {
            const dataUrl = String(reader.result);
            const probe = new Image();
            probe.onload = () => {
              const maxDim = 200; // mm — a sensible default footprint, independent of source pixel size
              const naturalW = probe.naturalWidth || 100;
              const naturalH = probe.naturalHeight || 100;
              const fit = Math.min(1, maxDim / Math.max(naturalW, naturalH));
              bus.execute({
                type: "add-entity",
                entity: {
                  id: newEntityId(),
                  type: "image",
                  name: nextEntityName(doc, "image"),
                  ...activeLayerProp(app.activeLayer),
                  insert: insertAt,
                  width: naturalW * fit,
                  height: naturalH * fit,
                  rotation: 0,
                  dataUrl,
                },
              });
              useApp.getState().setTool("select");
              redraw();
            };
            probe.src = dataUrl;
          };
          reader.readAsDataURL(file);
        };
        input.click();
        break;
      }
      case "measure": {
        const hit = hitTest(view, world);
        const hitEntity = hit ? doc.get(hit) : null;

        // Ctrl-click a line to pick it as the angle reference edge for
        // distance measurements (click it again to clear). Independent of
        // the straighten tool's own reference edge — each is reset when you
        // switch into that tool.
        if (e.ctrlKey && hitEntity?.type === "line") {
          app.setReferenceEdge(app.referenceEdgeId === hitEntity.id ? null : hitEntity.id);
          interactionRef.current = { kind: "idle" };
          break;
        }

        // Alt-click is the explicit "measure this whole entity" gesture —
        // a plain click always measures point-to-point (see below), snapping
        // to endpoints/midpoints/centers/intersections/on-line points, so it
        // isn't shadowed by clicking anywhere near a line. Once a running
        // total is showing, every further Alt-click adds to it with no
        // modifier needed — Shift used to be required here, but making
        // multi-select the default (and dropping it via Esc or a
        // double-click, see onDoubleClick) reads more like normal selection.
        if (e.altKey && hitEntity?.type === "arc") {
          const len = hitEntity.radius * arcSweep(hitEntity.startAngle, hitEntity.endAngle, hitEntity.ccw);
          const current = app.measurement;
          if (current?.kind === "length") {
            if (!current.ids.includes(hitEntity.id)) {
              app.setMeasurement({ kind: "length", ids: [...current.ids, hitEntity.id], total: current.total + len });
            }
          } else {
            app.setMeasurement({
              kind: "radius",
              id: hitEntity.id,
              center: hitEntity.center,
              radius: hitEntity.radius,
              arcLength: len,
            });
          }
          interactionRef.current = { kind: "idle" };
          break;
        }

        if (e.altKey && hitEntity?.type === "circle") {
          app.setMeasurement({ kind: "radius", id: hitEntity.id, center: hitEntity.center, radius: hitEntity.radius });
          interactionRef.current = { kind: "idle" };
          break;
        }

        if (e.altKey && (hitEntity?.type === "line" || hitEntity?.type === "polyline" || hitEntity?.type === "ellipse" || hitEntity?.type === "spline")) {
          const len =
            hitEntity.type === "line" ? dist(hitEntity.a, hitEntity.b) : hitEntity.type === "polyline" ? polylineLength(hitEntity) : (entityLength(hitEntity) ?? 0);
          const current = app.measurement;
          if (current?.kind === "length") {
            if (!current.ids.includes(hitEntity.id)) {
              app.setMeasurement({ kind: "length", ids: [...current.ids, hitEntity.id], total: current.total + len });
            }
          } else {
            app.setMeasurement({ kind: "length", ids: [hitEntity.id], total: len });
          }
          interactionRef.current = { kind: "idle" };
          break;
        }

        // Nothing under the cursor at all: an enclosing closed area takes
        // priority over starting a two-point distance drag.
        if (!hitEntity) {
          const region = regionContainingPoint(closedRegionsRef.current, world);
          if (region) {
            app.setMeasurement({ kind: "area", region });
            interactionRef.current = { kind: "idle" };
            break;
          }
        }

        if (interaction.kind === "measure") {
          // second click freezes the measurement
          app.setMeasurement({ kind: "distance", a: interaction.start, b: snapped });
          interactionRef.current = { kind: "idle" };
        } else {
          interactionRef.current = { kind: "measure", start: snapped };
          app.setMeasurement({ kind: "distance", a: snapped, b: snapped });
        }
        break;
      }
      case "select": {
        // Alt turns the drag into a freehand selection: a lasso, or a fence
        // while the no-snap modifier is also held. Checked before the hit
        // test, so a lasso can start over geometry in a crowded drawing.
        if (e.altKey) {
          interactionRef.current = {
            kind: "free-select",
            startScreen: screen,
            points: [world],
            additive: matchesModifier(e, "mouse.addToSelection"),
            fence: matchesModifier(e, "mouse.freeMove"),
          };
          break;
        }
        const hit = cyclingHit(view, world, screen);
        if (hit) {
          // Clicking any member of a group selects the whole group, unless it's currently "entered".
          const resolved = resolveSelection(doc, hit, app.enteredGroupId);
          let ids: EntityId[];
          let collapseTo: EntityId[] | null = null;
          if (matchesModifier(e, "mouse.addToSelection")) {
            const allSelected = resolved.every((id) => app.selection.includes(id));
            ids = allSelected
              ? app.selection.filter((id) => !resolved.includes(id))
              : [...new Set([...app.selection, ...resolved])];
          } else {
            const alreadyExact =
              app.selection.length === resolved.length && resolved.every((id) => app.selection.includes(id));
            const isSubsetOfBigger = app.selection.length > resolved.length && resolved.every((id) => app.selection.includes(id));
            if (isSubsetOfBigger) {
              // Grabbed one member of a bigger multi-selection: keep the whole
              // selection so a drag moves everything together; only collapse
              // to just this item on pointerup if it turns out to be a plain
              // click with no drag.
              ids = app.selection;
              collapseTo = resolved;
            } else {
              ids = alreadyExact ? app.selection : resolved;
            }
          }
          app.setSelection(ids);
          if (resolved.every((id) => ids.includes(id))) {
            interactionRef.current = {
              kind: "move",
              ids,
              startWorld: world,
              startScreen: screen,
              collapseTo,
              dx: 0,
              dy: 0,
              baseVertices: selectionVertices(ids),
            };
          }
        } else {
          // Nothing under the cursor: could be a plain click (clears the
          // selection on release) or the start of a window/crossing
          // drag-select — onPointerUp decides based on how far it moved.
          interactionRef.current = {
            kind: "box-select",
            startScreen: screen,
            startWorld: world,
            currentWorld: world,
            additive: matchesModifier(e, "mouse.addToSelection"),
          };
        }
        break;
      }
      case "straighten": {
        // A line, or one straight (non-bulged) segment of a polyline, already
        // in the selection can become the reference edge.
        const hit = hitTest(view, world);
        const entity = hit ? doc.get(hit) : null;
        if (hit && entity?.type === "line" && app.selection.includes(hit)) {
          app.setReferenceEdge(hit);
        } else if (hit && entity?.type === "polyline" && app.selection.includes(hit)) {
          const segs = polylineSegments(entity);
          let best = -1;
          let bestDist = Infinity;
          segs.forEach((s, i) => {
            if (s.bulge !== 0) return; // straighten needs a straight edge
            const d = distToSegment(world, s.a, s.b);
            if (d < bestDist) {
              bestDist = d;
              best = i;
            }
          });
          if (best >= 0) app.setReferenceEdge(hit, best);
        }
        break;
      }
      case "mtext": {
        // D-04: edit the multiline text under the cursor, or start one where you clicked.
        const hit = hitTest(view, world);
        const existing = hit ? doc.get(hit) : null;
        if (existing && existing.type === "mtext") useMTextUi.getState().openEdit(existing);
        else useMTextUi.getState().openNew(world, app.textHeight);
        break;
      }
      case "text": {
        // Edit the text under the cursor, or start a fresh one where you clicked.
        const hit = hitTest(view, world);
        const existing = hit ? doc.get(hit) : null;
        if (existing && existing.type === "text") {
          openTextEditor(existing);
        } else {
          setTextEdit({ screen, world, value: "", id: null, rotation: 0, height: app.textHeight });
        }
        break;
      }
      case "pan":
        // Handled above, together with the middle/right-button pan.
        break;
      case "dim": {
        if (interaction.kind === "dim") {
          placeDimension(interaction.start, snapped);
          interactionRef.current = { kind: "idle" };
          app.setMeasurement(null);
        } else {
          interactionRef.current = { kind: "dim", start: snapped };
          app.setMeasurement({ kind: "distance", a: snapped, b: snapped });
        }
        break;
      }
    }
    redraw();
  };

  /** Opens the floating editor for an existing text entity. */
  const openTextEditor = (t: TextEntity) => {
    const screen = worldToScreen(viewRef.current, t.at);
    setTextEdit({ screen, world: t.at, value: t.text, id: t.id, rotation: t.rotation, height: t.height });
  };

  /** Commits the floating text editor (add or update) and closes it. */
  const commitText = () => {
    const edit = textEdit;
    setTextEdit(null);
    if (!edit) return;
    const value = edit.value.trim();
    if (!value) {
      if (edit.id) bus.execute({ type: "delete-entities", ids: [edit.id] });
      return;
    }
    const app = useApp.getState();
    if (edit.id) {
      const cur = doc.get(edit.id);
      if (cur && cur.type === "text") {
        bus.execute({ type: "update-entity", entity: { ...cur, text: value, height: edit.height } });
      }
    } else {
      bus.execute({
        type: "add-entity",
        entity: {
          id: newEntityId(),
          type: "text",
          name: nextEntityName(doc, "text"),
          layer: app.activeLayer,
          at: edit.world,
          text: value,
          height: edit.height,
          rotation: edit.rotation,
        },
      });
    }
    redraw();
  };

  /** Draws a linear dimension between two points as a grouped batch on the Dimensions layer. */
  const placeDimension = (a: Point, b: Point) => {
    if (dist(a, b) < 1e-6) return;
    const app = useApp.getState();
    const d = linearDimension(a, b, {
      offset: Math.max(app.textHeight * 2, dist(a, b) * 0.12),
      textHeight: app.textHeight,
      label: formatLength(dist(a, b), app.displayUnit),
    });
    const layer = "Dimensions";
    const ids: EntityId[] = [];
    const commands: Command[] = [];
    for (const pts of d.lines) {
      const id = newEntityId();
      ids.push(id);
      commands.push({ type: "add-entity", entity: { id, type: "polyline", layer, points: pts, closed: false } });
    }
    const textId = newEntityId();
    ids.push(textId);
    commands.push({
      type: "add-entity",
      entity: { id: textId, type: "text", layer, at: d.text.at, text: d.text.text, height: d.text.height, rotation: d.text.rotation },
    });
    commands.push({ type: "group-entities", groupId: newGroupId(), ids, name: d.text.text });
    bus.execute({ type: "batch", commands });
    useApp.getState().syncLayersFromDoc?.();
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const screen = screenPos(e);
    const view = viewRef.current;
    const world = screenToWorld(view, screen);
    const app = useApp.getState();
    const interaction = interactionRef.current;

    if (e.pointerType === "touch" && touchesRef.current.has(e.pointerId)) {
      if (interaction.kind === "pinch") {
        pinchMove(e.pointerId, screen);
        return;
      }
      touchesRef.current.set(e.pointerId, screen);
      const pending = pendingTouchRef.current;
      if (pending) {
        // Still within the wobble budget: keep waiting for a tap or a second finger.
        if (dist(screenPos(pending), screen) < 10) return;
        flushPendingTouch();
        onPointerMove(e);
        return;
      }
    }

    if (interaction.kind === "pan") {
      view.ox += screen.x - interaction.lastX;
      view.oy += screen.y - interaction.lastY;
      interactionRef.current = { ...interaction, lastX: screen.x, lastY: screen.y };
    } else if (interaction.kind === "move") {
      const rawDx = world.x - interaction.startWorld.x;
      const rawDy = world.y - interaction.startWorld.y;
      // Snap the moved geometry itself, not the cursor: each axis is nudged so
      // some dragged vertex lands on some anchor's x / y. Hold Ctrl (or Alt) to
      // move completely free.
      const { dx, dy } = noSnap(e)
        ? { dx: rawDx, dy: rawDy }
        : snapMovingSelection(doc, view, interaction.baseVertices, rawDx, rawDy, interaction.ids);
      interactionRef.current = { ...interaction, dx, dy };
    } else if (interaction.kind === "rotate-group") {
      const angle = Math.atan2(world.y - interaction.pivot.y, world.x - interaction.pivot.x);
      // Snap to 45° steps so a turned pallet still lines up; Ctrl frees it.
      const rotation = snapRotation(angle - interaction.startAngle, noSnap(e));
      interactionRef.current = { ...interaction, rotation };
    } else if (interaction.kind === "grip") {
      const entity = doc.get(interaction.entityId);
      if (entity) {
        // Snap to everything but the entity being edited; ortho/polar from the grip's other end for a line.
        const target = noSnap(e) ? world : findSnap(doc, view, world, { exclude: [entity.id], settings: useSnapSettings.getState().settings }).point;
        interactionRef.current = { ...interaction, preview: gripPreviewFor(entity, interaction.grip, target) };
      }
    } else if (interaction.kind === "free-select") {
      // One point per move event is more than the shape needs; thin as we go
      // so a long lasso stays a few dozen edges rather than a few hundred.
      const last = interaction.points[interaction.points.length - 1];
      if (dist(last, world) > 2 / view.scale) interaction.points.push(world);
      interactionRef.current = { ...interaction };
    } else if (interaction.kind === "box-select") {
      interactionRef.current = { ...interaction, currentWorld: world };
    }

    lastScreenRef.current = screen;
    const resolved = resolvePick(world, e.shiftKey);
    const snap = resolved.snap;
    snapRef.current = snap;
    trackingRayRef.current = resolved.ray;
    hoverRef.current = app.tool === "measure" ? hitTest(view, world) : null;
    if (interaction.kind === "measure" || interaction.kind === "dim") {
      app.setMeasurement({ kind: "distance", a: interaction.start, b: snap.point });
    }
    const shown = app.tool === "select" ? world : snap.point;
    app.setCursor({ x: shown.x, y: shown.y });
    redraw();
  };

  /** Two-finger move: pan by the midpoint's travel, zoom by the change in finger spread, about the midpoint. */
  const pinchMove = (pointerId: number, screen: Point) => {
    const touches = touchesRef.current;
    const before = [...touches.values()];
    touches.set(pointerId, screen);
    const after = [...touches.values()];
    if (before.length < 2 || after.length < 2) return;
    const mid = (pts: Point[]) => ({ x: (pts[0].x + pts[1].x) / 2, y: (pts[0].y + pts[1].y) / 2 });
    const m0 = mid(before);
    const m1 = mid(after);
    const d0 = dist(before[0], before[1]);
    const d1 = dist(after[0], after[1]);
    let view = viewRef.current;
    if (d0 > 0 && d1 > 0) view = zoomAt(view, m0, d1 / d0);
    view = { ...view, ox: view.ox + (m1.x - m0.x), oy: view.oy + (m1.y - m0.y) };
    viewRef.current = view;
    useApp.getState().setZoom(view.scale);
    redraw();
  };

  const onPointerUp = (e: React.PointerEvent) => {
    if (e.pointerType === "touch") {
      touchesRef.current.delete(e.pointerId);
      // A tap: the finger's action runs now, then its release is handled as usual.
      if (e.type !== "pointercancel") flushPendingTouch();
      else pendingTouchRef.current = null;
      // A finger lifting out of a pinch ends the gesture; the remaining
      // finger is not promoted to a tool action, it just has to lift too.
      if (interactionRef.current.kind === "pinch") {
        if (touchesRef.current.size === 0) {
          interactionRef.current = interactionRef.current.resume;
          redraw();
        }
        try {
          canvasRef.current!.releasePointerCapture(e.pointerId);
        } catch {
          // see setPointerCapture note
        }
        return;
      }
    }
    const interaction = interactionRef.current;
    if (interaction.kind === "free-select") {
      const app = useApp.getState();
      const path = simplifyPath(interaction.points, 2 / viewRef.current.scale);
      const fence = interaction.fence || matchesModifier(e, "mouse.freeMove");
      const picked = fence
        ? entitiesCrossedByFence(selectableEntities(), path)
        : entitiesInPolygon(selectableEntities(), path, freeSelectMode(path));
      app.setSelection(interaction.additive ? [...new Set([...app.selection, ...picked])] : picked);
      interactionRef.current = { kind: "idle" };
      redraw();
      try {
        canvasRef.current!.releasePointerCapture(e.pointerId);
      } catch {
        // see setPointerCapture note
      }
      return;
    }
    if (interaction.kind === "box-select") {
      const screen = screenPos(e);
      const app = useApp.getState();
      if (dist(screen, interaction.startScreen) < (e.pointerType === "touch" ? 10 : 4)) {
        // Barely moved: treat as a plain click on empty canvas.
        if (!interaction.additive) app.setSelection([]);
      } else {
        const { startWorld: s, currentWorld: c } = interaction;
        const box = {
          minX: Math.min(s.x, c.x),
          maxX: Math.max(s.x, c.x),
          minY: Math.min(s.y, c.y),
          maxY: Math.max(s.y, c.y),
        };
        const mode: BoxSelectMode = c.x >= s.x ? "window" : "crossing";
        const picked = entitiesInBox(selectableEntities(), box, mode);
        app.setSelection(interaction.additive ? [...new Set([...app.selection, ...picked])] : picked);
      }
      interactionRef.current = { kind: "idle" };
      redraw();
      try {
        canvasRef.current!.releasePointerCapture(e.pointerId);
      } catch {
        // see setPointerCapture note
      }
      return;
    }
    if (interaction.kind === "pan") {
      interactionRef.current = interaction.resume;
      redraw();
    } else if (interaction.kind === "move") {
      const moved = dist(screenPos(e), interaction.startScreen) >= (e.pointerType === "touch" ? 10 : 4);
      if (moved && (interaction.dx !== 0 || interaction.dy !== 0)) {
        bus.execute({
          type: "move-entities",
          ids: interaction.ids,
          dx: interaction.dx,
          dy: interaction.dy,
        });
      } else if (!moved && interaction.collapseTo) {
        // A plain click (no drag) on one member of a bigger selection: now
        // collapse down to just that item, as a click normally would.
        useApp.getState().setSelection(interaction.collapseTo);
      }
      interactionRef.current = { kind: "idle" };
      redraw();
    } else if (interaction.kind === "rotate-group") {
      if (Math.abs(interaction.rotation) > 1e-9) {
        bus.execute({
          type: "transform-entities",
          ids: interaction.ids,
          pivot: interaction.pivot,
          rotation: interaction.rotation,
          dx: 0,
          dy: 0,
          scale: 1,
        });
      }
      interactionRef.current = { kind: "idle" };
      redraw();
    } else if (interaction.kind === "grip") {
      const moved = dist(screenPos(e), interaction.startScreen) >= (e.pointerType === "touch" ? 10 : 3);
      const previews = interaction.preview;
      if (moved && previews.length === 1) bus.execute({ type: "update-entity", entity: previews[0] });
      else if (moved && previews.length > 1) {
        // A drag-solve moved several entities: one batch, one undo step.
        bus.execute({ type: "batch", commands: previews.map((entity) => ({ type: "update-entity", entity })) });
      }
      interactionRef.current = { kind: "idle" };
      redraw();
    }
    try {
      canvasRef.current!.releasePointerCapture(e.pointerId);
    } catch {
      // see setPointerCapture note
    }
  };

  /** Runs one command-line entry and returns what to echo back. */
  const runCommand = (line: string): void => {
    const parsed = parseCommand(line);
    // Counted like a button or a shortcut would be: the action it resolved
    // to, never the line — that can hold coordinates the user typed.
    if (parsed.kind === "tool") track("action", { id: `tool.${parsed.tool}`, source: "command-line" });
    else if (parsed.kind === "app") track("action", { id: COMMAND_LINE_ACTIONS[parsed.id], source: "command-line" });
    const app = useApp.getState();
    const say = (text: string, kind: CommandEcho["kind"] = "out") =>
      setCommandEcho((prev) => [...prev, { text: line, kind: "in" as const }, { text, kind }].slice(-8));
    switch (parsed.kind) {
      case "tool": {
        app.setTool(parsed.tool);
        if (parsed.argument) {
          // The rest of the line is the tool's first typed input: `o 5`,
          // `f 2.5`. The tool has just been activated, so this reaches it.
          const consumed = getTool(parsed.tool)?.typed?.(toolCtx, parsed.argument) ?? false;
          say(consumed ? `${parsed.tool} ${parsed.argument}` : `${parsed.tool} (ignored "${parsed.argument}")`);
        } else {
          say(parsed.tool);
        }
        syncPrompt();
        redraw();
        return;
      }
      case "point": {
        if (commitTypedText(parsed.text)) say(parsed.text);
        else say(`Can't place ${parsed.text} — no tool is waiting for a point`, "error");
        return;
      }
      case "app": {
        const done = runAppCommand(parsed.id, parsed.argument);
        say(done ?? parsed.id, done ? "out" : "out");
        return;
      }
      case "unknown":
        say(`Unknown command "${parsed.text}"`, "error");
        return;
      case "empty":
        return;
    }
  };

  /** The non-tool commands; returns a line to echo. */
  const runAppCommand = (id: AppCommandId, argument?: string): string => {
    const app = useApp.getState();
    const entitiesOf = (ids: EntityId[]) => ids.map((i) => doc.get(i)).filter((en): en is Entity => !!en);
    switch (id) {
      case "undo":
        bus.undo();
        return "undo";
      case "redo":
        bus.redo();
        return "redo";
      case "delete": {
        if (app.selection.length === 0) return "nothing selected";
        const ids = app.selection;
        bus.execute({ type: "delete-entities", ids });
        app.setSelection([]);
        return `deleted ${ids.length}`;
      }
      case "selectAll": {
        const ids = selectableEntities().map((en) => en.id);
        app.setSelection(ids);
        return `${ids.length} selected`;
      }
      case "invertSelection": {
        const cur = new Set(app.selection);
        const ids = selectableEntities().filter((en) => !cur.has(en.id)).map((en) => en.id);
        app.setSelection(ids);
        return `${ids.length} selected`;
      }
      case "selectSimilar": {
        const samples = entitiesOf(app.selection);
        if (samples.length === 0) return "select one first";
        const ids = selectSimilar(selectableEntities(), samples);
        app.setSelection(ids);
        return `${ids.length} selected`;
      }
      case "join": {
        const commands = joinCommands(entitiesOf(app.selection));
        if (commands.length === 0) return "nothing to join";
        bus.execute({ type: "batch", commands });
        app.setSelection(commands.filter((c) => c.type === "add-entity").map((c) => (c as { entity: Entity }).entity.id));
        return "joined";
      }
      case "explode": {
        const commands = explodeCommands(entitiesOf(app.selection));
        if (commands.length === 0) return "nothing to explode";
        bus.execute({ type: "batch", commands });
        return "exploded";
      }
      case "simplify": {
        const commands = simplifyPolylineCommands(entitiesOf(app.selection), DEFAULT_SIMPLIFY_TOLERANCE_MM);
        if (commands.length === 0) return "nothing to simplify";
        bus.execute({ type: "batch", commands });
        app.setSelection(commands.filter((c) => c.type === "add-entity").map((c) => (c as { entity: Entity }).entity.id));
        return "simplified";
      }
      case "group":
        groupSelection();
        return "grouped";
      case "ungroup":
        ungroupSelection();
        return "ungrouped";
      case "fit":
        fitView(app.selection.length ? app.selection : undefined);
        return "fit";
      case "zoomPrevious":
        zoomPrevious();
        return "zoom previous";
      case "relativeZero": {
        const cursor = lastScreenRef.current ? screenToWorld(viewRef.current, lastScreenRef.current) : null;
        relativeZeroRef.current = cursor ? findSnap(doc, viewRef.current, cursor, { settings: useSnapSettings.getState().settings }).point : null;
        redraw();
        return relativeZeroRef.current ? "relative zero set" : "move the cursor onto the drawing first";
      }
      case "blockEdit": {
        const sel = app.selection.map((i) => doc.get(i)).find((en) => en?.type === "insert");
        const name = argument ?? (sel && sel.type === "insert" ? sel.block : "");
        if (!name) return "bedit: name a block or select an insert first";
        const err = beginBlockEdit(name);
        return err ?? `editing block ${name}`;
      }
      case "attEdit": {
        const sel = app.selection.map((i) => doc.get(i)).find((en) => en?.type === "insert");
        if (!sel) return "attedit: select an insert first";
        app.setAttedit(sel.id);
        return "editing attributes";
      }
      case "dimTextReset":
      case "dimTextLeader":
      case "dimFlip":
      case "dimSpace":
      case "dimOblique":
      case "dimRestyle":
      case "dimReassoc": {
        const r = runDimEdit(doc, app.selection, id, argument);
        if (r.command) bus.execute(r.command);
        return r.message;
      }
      case "dimStyles":
        useDimStyleUi.getState().setOpen(true);
        return "dimension styles";
      case "attExport": {
        const table = attributeTable(doc, argument ? { blocks: [argument] } : {});
        if (table.rows.length === 0) return "no inserts to extract";
        downloadText("attributes.csv", attributeCsv(table), "text/csv");
        return `extracted ${table.rows.length} insert(s)`;
      }
      case "blockSave":
        return saveBlockEdit() ?? "block saved";
      case "blockClose":
        discardBlockEdit();
        return "block edit closed";
      case "save":
        void saveCurrent();
        return "save";
      case "open":
        void openDrawing();
        return "open";
      case "cancel":
        getTool(app.tool)?.cancel(toolCtx);
        app.setSelection([]);
        syncPrompt();
        redraw();
        return "cancelled";
    }
  };

  const onWheel = (e: React.WheelEvent) => {
    const screen = { x: e.nativeEvent.offsetX, y: e.nativeEvent.offsetY };
    const factor = e.deltaY < 0 ? 1.1 : 1 / 1.1;
    viewRef.current = zoomAt(viewRef.current, screen, factor);
    useApp.getState().setZoom(viewRef.current.scale);
    redraw();
  };

  const onDoubleClick = (e: React.MouseEvent) => {
    // Touch double-taps are detected in onPointerDown.
    if ((e.nativeEvent as PointerEvent).pointerType === "touch") return;
    const screen = { x: e.nativeEvent.offsetX, y: e.nativeEvent.offsetY };
    const world = screenToWorld(viewRef.current, screen);
    const hit = hitTest(viewRef.current, world);
    const app = useApp.getState();

    // In the measure tool, double-click anywhere is "drop what I've got" —
    // the same job Esc does, but without falling back to the select tool.
    // Takes priority over the zoom-to-fit fallback below, which a double
    // click would otherwise trigger since "measure" has no Tool class.
    if (app.tool === "measure") {
      app.setMeasurement(null);
      interactionRef.current = { kind: "idle" };
      return;
    }

    // Double-clicking a constraint mark removes that constraint — the
    // gesture is unambiguous (a mark is not geometry), and it undoes.
    const glyph = app.tool === "select" ? glyphAt(screen) : null;
    if (glyph) {
      bus.execute({ type: "remove-constraint", id: glyph });
      app.setHighlightedConstraint(null);
      redraw();
      return;
    }

    // A tool's own double-click (finishing a polyline) takes priority over the zoom-to-fit / enter-group behavior below.
    const t = getTool(app.tool);
    if (t?.doubleClick?.(toolCtx, pickFrom(e, world, resolvePick(world, e.shiftKey).snap))) {
      syncPrompt();
      redraw();
      return;
    }

    // Double-click an insert: its attribute values (ATTEDIT) when the click lands on an attribute text, else its block definition (B-04).
    const dblInsert = hit ? doc.get(hit) : null;
    if (dblInsert && dblInsert.type === "insert" && app.tool === "select" && doc.hasRecord("blocks", dblInsert.block)) {
      if (editableAttributes(doc, dblInsert).length > 0 && insertContents(dblInsert).some((c) => c.type === "text" && c.id.includes(":attr:") && kindHitDistance(c, world) <= 8 / viewRef.current.scale)) {
        app.setAttedit(dblInsert.id);
      } else {
        beginBlockEdit(dblInsert.block, dblInsert.id);
      }
      return;
    }

    // Double-click a hatch to edit it in the Hatch panel (H-08).
    const dblHatch = hit ? doc.get(hit) : null;
    if (dblHatch && dblHatch.type === "hatch" && app.tool === "select") {
      app.setHatchSettings(settingsFromHatch(dblHatch));
      app.setTool("fill");
      app.setHatchEdit({ id: dblHatch.id, pickOrigin: false });
      syncPrompt();
      redraw();
      return;
    }

    // Double-click any text to edit it (from select or the text tool).
    const dblEntity = hit ? doc.get(hit) : null;
    if (dblEntity && dblEntity.type === "text" && (app.tool === "select" || app.tool === "text")) {
      openTextEditor(dblEntity);
      return;
    }
    if (dblEntity && dblEntity.type === "mtext" && (app.tool === "select" || app.tool === "mtext")) {
      useMTextUi.getState().openEdit(dblEntity);
      return;
    }

    if (hit && app.tool === "select") {
      const top = doc.topLevelGroupOf(hit);
      if (top && top.id !== app.enteredGroupId) {
        // Enter the group to edit its members individually (Esc exits).
        app.setEnteredGroup(top.id);
        app.setSelection([hit]);
        redraw();
        return;
      }
    }
    // Zoom to fit. Double-clicking *geometry* frames that entity; double-clicking
    // empty space always frames the whole drawing — deliberately ignoring the
    // selection, since the first click of the double-click may have just changed
    // it, which otherwise makes the gesture unpredictable.
    fitView(hit ? [hit] : undefined);
  };

  return (
    <>
      <canvas
        ref={canvasRef}
        className="viewport"
        data-testid="viewport"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onWheel={onWheel}
        onDoubleClick={onDoubleClick}
        onContextMenu={(e) => e.preventDefault()}
      />
      {commandLine && (
        <CommandBar
          echo={commandEcho}
          prompt={promptText}
          onSubmit={runCommand}
          onClose={() => useApp.getState().toggleCommandLine()}
        />
      )}
      {cycle && (
        <div className="select-cycle" style={{ left: cycle.screen.x + 14, top: cycle.screen.y + 14 }} data-testid="select-cycle">
          <div className="select-cycle-head">{cycle.ids.length} here</div>
          {cycle.ids.map((id, i) => {
            const entity = doc.get(id);
            if (!entity) return null;
            return (
              <button
                key={id}
                className={`select-cycle-row ${i === cycle.index ? "current" : ""}`}
                onClick={() => {
                  useApp.getState().setSelection(resolveSelection(doc, id, useApp.getState().enteredGroupId));
                  if (cycleRef.current) cycleRef.current = { ...cycleRef.current, index: i, at: performance.now() };
                  setCycle({ ...cycle, index: i });
                }}
                onPointerEnter={() => {
                  hoverRef.current = id;
                  redraw();
                }}
                onPointerLeave={() => {
                  hoverRef.current = null;
                  redraw();
                }}
              >
                {entityLabel(entity)}
              </button>
            );
          })}
        </div>
      )}
      {typed && (
        <TypedInputBox
          value={typed.text}
          screen={typed.screen}
          onChange={(text) => {
            setTyped({ text, screen: typed.screen });
            // Live preview of where the typed point would land.
            const t = getTool(useApp.getState().tool);
            const parsed = parseTypedInput(text, useApp.getState().displayUnit);
            const cursor = lastScreenRef.current ? screenToWorld(viewRef.current, lastScreenRef.current) : null;
            const point = t && parsed ? resolveTypedInput(parsed, t.anchor(), cursor) : null;
            if (point) snapRef.current = { point, kind: "tracking" };
            redraw();
          }}
          onCommit={(text) => {
            if (!commitTypedText(text)) return false;
            setTyped(null);
            return true;
          }}
          onCancel={() => {
            setTyped(null);
            redraw();
          }}
        />
      )}
      {textEdit && (
        <input
          className="text-editor"
          data-testid="text-editor"
          autoFocus
          value={textEdit.value}
          style={{
            position: "absolute",
            left: textEdit.screen.x,
            top: textEdit.screen.y - textEdit.height * viewRef.current.scale,
            fontSize: Math.max(9, textEdit.height * viewRef.current.scale),
          }}
          onChange={(ev) => setTextEdit((s) => (s ? { ...s, value: ev.target.value } : s))}
          onKeyDown={(ev) => {
            if (ev.key === "Enter") commitText();
            else if (ev.key === "Escape") setTextEdit(null);
            ev.stopPropagation();
          }}
          onBlur={commitText}
        />
      )}
    </>
  );
}

/**
 * The floating coordinate box (T-08). Opens at the cursor with the first
 * typed character already in it; Enter commits when the text parses,
 * Escape closes. Kept minimal on purpose — the grammar is the UI.
 */
function TypedInputBox({
  value,
  screen,
  onChange,
  onCommit,
  onCancel,
}: {
  value: string;
  screen: Point;
  onChange: (text: string) => void;
  onCommit: (text: string) => boolean;
  onCancel: () => void;
}) {
  const [bad, setBad] = useState(false);
  return (
    <div className="typed-input" style={{ left: screen.x + 16, top: screen.y + 16 }} data-testid="typed-input">
      <input
        className={bad ? "invalid" : ""}
        autoFocus
        value={value}
        spellCheck={false}
        onChange={(ev) => {
          setBad(false);
          onChange(ev.target.value);
        }}
        onKeyDown={(ev) => {
          if (ev.key === "Enter") {
            if (!onCommit(value)) setBad(true);
          } else if (ev.key === "Escape") {
            onCancel();
          }
          ev.stopPropagation();
        }}
        onBlur={onCancel}
      />
      <div className="typed-input-hint">length · len&lt;angle · x,y · @dx,dy</div>
    </div>
  );
}
