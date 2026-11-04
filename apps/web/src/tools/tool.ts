import type { BoxSelectMode, ClosedRegion, Command, Entity, EntityId, Grip, Point, SketchDocument, TextEntity } from "@sketchor/core";
import type { ToolId } from "../state/store";
import type { DisplayUnit } from "../units";
import type { Snap } from "../viewport/snapping";
import type { View } from "../viewport/view";

/**
 * The tool framework (roadmap T-00). A tool is a small state machine —
 * prompt → pick → pick → commit — that lives in its own file, keeps its
 * own in-progress state, and talks to the drawing only through Commands.
 * The viewport owns input decoding (snapping, tracking, touch vs mouse,
 * typed coordinates) and hands the tool finished picks; it also asks the
 * tool what to draw as a preview and what to say in the status bar.
 *
 * Rules for every tool (also in CLAUDE.md):
 *  1. Geometry math is a pure function in @sketchor/core with a test. The
 *     tool only collects picks and calls it.
 *  2. The tool emits Command values through `ctx.execute`/`ctx.commit` —
 *     never mutates entities.
 *  3. `cancel` must leave the tool idle; Esc calls it before anything else.
 *
 * Every tool runs on this framework.
 */

export interface ToolContext {
  doc: SketchDocument;
  /** Runs one command (one undo step). */
  execute(command: Command): void;
  /** Runs several commands as a single undo step. */
  commit(commands: Command[]): void;
  /** Layer new entities go on. */
  activeLayer(): string;
  /** Asks the viewport to repaint (previews changed). */
  redraw(): void;
  setTool(id: ToolId): void;
  /** Current selection (entity ids), for the modify tools. */
  selection(): EntityId[];
  setSelection(ids: EntityId[]): void;
  /** What a click at a world point would select: the entity under it, expanded to its whole group ([] for nothing). */
  hitTest(world: Point): EntityId[];
  /** The single entity under a world point, exactly as the hit test finds it (no group expansion), or null. */
  hitEntity(world: Point): EntityId | null;
  /** Opens the floating text editor on an existing text entity, or for a new one at a world point. */
  editText(existing: TextEntity | null, world: Point): void;
  /** The closed loop of lines/arcs/circles enclosing a world point (the measure tool's area), or null. */
  closedRegionAt(world: Point): ClosedRegion | null;
  /** Marks the entity the pointer is over, for the renderer's hover highlight (measure). */
  setHoverEntity(id: EntityId | null): void;
  /** The select tool's window onto the viewport (hit cycling, constraint marks, solver-aware grip drags). */
  select: SelectHost;
  /** The tab's display unit, for tools that interpret a typed number themselves. */
  displayUnit(): DisplayUnit;
  /** Frames a world-space box (the zoom-window tool). */
  zoomTo(minX: number, minY: number, maxX: number, maxY: number): void;
}

/** What the select tool needs from the viewport; see ToolContext.select. */
export interface SelectHost {
  view(): View;
  /** The constraint whose mark is under a screen point, if any. */
  glyphAt(screen: Point): string | null;
  /** The entity under the cursor; clicking the same spot again steps through the stack (selection cycling). */
  cyclingHit(world: Point, screen: Point): EntityId | null;
  /** What dragging a grip to `target` would commit (the solver moves tied geometry on a constrained sketch). */
  gripPreview(entity: Entity, grip: Grip, target: Point): Entity[];
  /** T-27: shows (or with null hides) the hover menu of a polyline vertex grip. */
  setGripMenu(menu: GripMenuTarget | null): void;
  /** Runs a command without the drawing tools' auto-constraint inference (moving is not drawing). */
  executeRaw(command: Command): void;
}

/** The vertex grip the multifunction menu is open on. */
export interface GripMenuTarget {
  entityId: EntityId;
  /** Vertex index. */
  index: number;
  point: Point;
}

/** A raw pointer event as the gesture hooks see it. */
export interface PointerGesture {
  screen: Point;
  world: Point;
  pointerType: string;
  shiftKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
}

/** What a gesture tool wants drawn while its drag is in progress. */
export interface ToolOverlay {
  moveOffset: { dx: number; dy: number } | null;
  rotating: { ids: EntityId[]; pivot: Point; rotation: number } | null;
  gripPreview: Entity[];
  freeSelect: { points: Point[]; kind: "lasso" | "fence"; mode: BoxSelectMode } | null;
  boxSelect: { start: Point; end: Point; mode: BoxSelectMode } | null;
}

/** One resolved pick: where the user clicked/tapped/typed, after snapping and tracking. */
export interface Pick {
  /** The point the tool should use. */
  point: Point;
  /** Raw cursor position in world space (before snapping). */
  world: Point;
  snap: Snap | null;
  shiftKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
}

export interface Tool {
  id: ToolId;
  /** The primary button (one finger) pans the view instead of picking (the pan tool). */
  panDrag?: boolean;
  /** A tool with no point to place (select, pan, measure, text...): no tracking, relative zero or typed-coordinate box, as before the framework. */
  plain?: boolean;
  /** Status-bar prompt for the current state, e.g. "Specify next point". */
  prompt(ctx: ToolContext): string;
  /** True while a multi-click sequence is in progress (Esc cancels it before leaving the tool). */
  busy(): boolean;
  /** The anchor for relative typed input and ortho/polar tracking — usually the last placed point. */
  anchor(): Point | null;
  /** Drops in-progress state. Called on Esc and when the tool is deactivated. */
  cancel(ctx: ToolContext): void;
  /** Primary click, tap, or a typed coordinate. */
  pick(ctx: ToolContext, pick: Pick): void;
  /** Double-click / double-tap. Return true when consumed (otherwise the viewport zooms to fit). */
  doubleClick?(ctx: ToolContext, pick: Pick): boolean;
  /**
   * Fence drag (trim, T-16): when defined, a press-and-drag hands the tool the
   * stroke (world points) on release instead of a pick; a press without a
   * drag (and any Shift press) is still an ordinary `pick`.
   */
  fence?(ctx: ToolContext, path: Point[]): void;
  /** Pointer moved over the canvas (not mid-gesture): the cursor after snapping/tracking. For live readouts. */
  hover?(ctx: ToolContext, pick: Pick): void;
  /**
   * Gesture tools (select): a primary press starts a drag handled here
   * instead of `pick`; the viewport routes moves and the release while
   * `gestureActive()`, and `abortGesture()` drops it (a pinch or a pan
   * button took over). `overlay()` says what to draw meanwhile.
   */
  press?(ctx: ToolContext, e: PointerGesture): void;
  dragMove?(ctx: ToolContext, e: PointerGesture): void;
  release?(ctx: ToolContext, e: PointerGesture): void;
  gestureActive?(): boolean;
  abortGesture?(): void;
  overlay?(): ToolOverlay;
  /** Keys while the tool is active (not typed coordinates). Return true when consumed. */
  key?(ctx: ToolContext, e: KeyboardEvent): boolean;
  /**
   * First look at a committed typed-input string, for tools where a bare
   * number isn't a length toward the cursor (an angle for rotate, a factor
   * for scale). Return true when consumed; otherwise the viewport resolves
   * it as a coordinate and calls `pick`.
   */
  typed?(ctx: ToolContext, text: string): boolean;
  /**
   * Entities to draw dashed as the live preview, given the current cursor
   * (already snapped/tracked), or null when the pointer isn't over the canvas.
   */
  preview(ctx: ToolContext, cursor: Point | null): Entity[];
}

/** `layer` property for a new entity, omitted on the default layer to keep files minimal. */
export function layerProp(layer: string): { layer?: string } {
  return layer && layer !== "0" ? { layer } : {};
}
