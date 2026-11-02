import type { Command, Entity, EntityId, Point, SketchDocument } from "@sketchor/core";
import type { ToolId } from "../state/store";
import type { DisplayUnit } from "../units";
import type { Snap } from "../viewport/snapping";

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
 * Tools not yet migrated (select, measure, text, image, fill, straighten,
 * dim, pan) still live as cases inside Viewport.tsx; `getTool` returns
 * null for those and the viewport takes its legacy path.
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
  /** The tab's display unit, for tools that interpret a typed number themselves. */
  displayUnit(): DisplayUnit;
  /** Frames a world-space box (the zoom-window tool). */
  zoomTo(minX: number, minY: number, maxX: number, maxY: number): void;
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
