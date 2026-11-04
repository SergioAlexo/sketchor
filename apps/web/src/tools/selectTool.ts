import type { BoxSelectMode, Entity, EntityId, Grip, Point } from "@sketchor/core";
import {
  boundsOf,
  constraintEntityIds,
  dist,
  entitiesCrossedByFence,
  entitiesInBox,
  entitiesInPolygon,
  entityPoints,
  gripMenuActions,
  gripsOf,
  resolveSelection,
  simplifyPath,
  wholeGroupSelected,
} from "@sketchor/core";
import { matchesModifier } from "../keybindings";
import { selectableEntities, useApp } from "../state/store";
import { findSnap, snapMovingSelection, snapRotation } from "../viewport/snapping";
import { worldToScreen, type View } from "../viewport/view";
import { useSnapSettings } from "./snapSettings";
import type { Pick, PointerGesture, Tool, ToolContext, ToolOverlay } from "./tool";

/**
 * The select tool (roadmap T-00: the last legacy tool, moved out of
 * Viewport.tsx's switch). It is the one tool whose press starts a *drag
 * gesture*, so it uses the framework's `press/dragMove/release` hooks
 * rather than `pick`, and reports what to draw through `overlay()`.
 *
 * Gestures, decided on press:
 *  - a constraint mark: select what it holds (no drag);
 *  - a grip of a selected entity (T-27): drag it, one `update-entity`;
 *  - the rotate handle of a whole-group selection: turn it;
 *  - Alt: lasso (or fence with the free-move modifier) selection;
 *  - an entity (cycling through stacked ones on a repeat click): select it
 *    and drag-move the selection. Pressing one member of a bigger
 *    multi-selection KEEPS the selection so a drag moves them all, and only
 *    collapses to that item on a release that did not move;
 *  - empty space: window/crossing box, or a plain click that clears.
 */

/** Fixed pixel offset above a selected group's bounding box where its rotate handle is hit-tested (renderer.ts draws it; keep in step). */
const GROUP_HANDLE_OFFSET_PX = 26;
const GROUP_HANDLE_HIT_PX = 8;
/** How close (screen px) a press must be to a grip to grab it. */
const GRIP_HIT_PX = 7;

function groupHandleScreenPos(view: View, bb: { minX: number; maxX: number; maxY: number }): Point {
  const s = worldToScreen(view, { x: (bb.minX + bb.maxX) / 2, y: bb.maxY });
  return { x: s.x, y: s.y - GROUP_HANDLE_OFFSET_PX };
}

/** The "mouse.freeMove" modifier (Ctrl/⌘ by default, rebindable) held during a drag turns off position and angle snapping. */
function noSnap(g: PointerGesture): boolean {
  return matchesModifier(g, "mouse.freeMove");
}

/** Lasso direction: ending to the right of where it began means "only what I enclosed"; ending left means "anything I touched". */
export function freeSelectMode(points: readonly Point[]): BoxSelectMode {
  if (points.length < 2) return "window";
  return points[points.length - 1].x >= points[0].x ? "window" : "crossing";
}

/** The grip of a selected entity within reach of a screen point, nearest first. */
function findGrip(ctx: ToolContext, selection: EntityId[], screen: Point, view: View, touch: boolean): { entityId: EntityId; grip: Grip } | null {
  // Grips only show for small selections; a hundred selected entities would be a field of squares.
  if (selection.length === 0 || selection.length > 8) return null;
  const reach = touch ? GRIP_HIT_PX * 2 : GRIP_HIT_PX;
  let best: { entityId: EntityId; grip: Grip; d: number } | null = null;
  for (const id of selection) {
    const entity = ctx.doc.get(id);
    if (!entity) continue;
    for (const grip of gripsOf(entity)) {
      const d = dist(worldToScreen(view, grip.point), screen);
      if (d <= reach && (!best || d < best.d)) best = { entityId: id, grip, d };
    }
  }
  return best;
}

/** Every vertex of the selection — the anchors a snapped move can align. */
function selectionVertices(ctx: ToolContext, ids: EntityId[]): Point[] {
  const out: Point[] = [];
  for (const id of ids) {
    const entity = ctx.doc.get(id);
    if (!entity) continue;
    for (const p of entityPoints(entity)) out.push(p);
  }
  return out;
}

type Gesture =
  | { kind: "idle" }
  | {
      kind: "move";
      ids: EntityId[];
      startWorld: Point;
      startScreen: Point;
      dx: number;
      dy: number;
      /** Every vertex of the selection at grab time; a snapped move aligns whichever one lands closest to a target. */
      baseVertices: Point[];
      /** Ids to collapse the selection to if this turns out to be a click with no drag (see class doc), else null. */
      collapseTo: EntityId[] | null;
    }
  | { kind: "rotate-group"; ids: EntityId[]; pivot: Point; startAngle: number; rotation: number }
  /** `preview` is what the drag would commit: the dragged entity, or every entity the solver moved on a constrained sketch (T-40). */
  | { kind: "grip"; entityId: EntityId; grip: Grip; startScreen: Point; preview: Entity[] }
  | { kind: "box-select"; startScreen: Point; startWorld: Point; currentWorld: Point; additive: boolean }
  | { kind: "free-select"; startScreen: Point; points: Point[]; additive: boolean; fence: boolean };

export class SelectTool implements Tool {
  id = "select" as const;
  plain = true;
  private g: Gesture = { kind: "idle" };

  prompt() {
    return "";
  }
  busy() {
    return false;
  }
  anchor() {
    return null;
  }
  cancel() {
    this.g = { kind: "idle" };
  }
  pick() {}
  preview() {
    return [];
  }

  /**
   * T-27: hovering a polyline vertex grip of the selection opens its
   * multifunction menu (add / remove vertex, convert segment to arc/line);
   * dragging the grip still stretches the vertex.
   */
  hover(ctx: ToolContext, pick: Pick) {
    const host = ctx.select;
    if (this.g.kind !== "idle") {
      host.setGripMenu(null);
      return;
    }
    const view = host.view();
    const hit = findGrip(ctx, useApp.getState().selection, worldToScreen(view, pick.world), view, false);
    const entity = hit ? ctx.doc.get(hit.entityId) : undefined;
    if (hit && entity?.type === "polyline" && hit.grip.kind === "vertex" && gripMenuActions(entity, hit.grip.index).length > 0) {
      host.setGripMenu({ entityId: entity.id, index: hit.grip.index, point: hit.grip.point });
    } else {
      host.setGripMenu(null);
    }
  }

  gestureActive() {
    return this.g.kind !== "idle";
  }
  abortGesture() {
    this.g = { kind: "idle" };
  }

  overlay(): ToolOverlay {
    const g = this.g;
    return {
      moveOffset: g.kind === "move" ? { dx: g.dx, dy: g.dy } : null,
      rotating: g.kind === "rotate-group" ? { ids: g.ids, pivot: g.pivot, rotation: g.rotation } : null,
      gripPreview: g.kind === "grip" ? g.preview : [],
      freeSelect: g.kind === "free-select" ? { points: g.points, kind: g.fence ? "fence" : "lasso", mode: freeSelectMode(g.points) } : null,
      boxSelect:
        g.kind === "box-select"
          ? { start: g.startWorld, end: g.currentWorld, mode: g.currentWorld.x >= g.startWorld.x ? "window" : "crossing" }
          : null,
    };
  }

  press(ctx: ToolContext, e: PointerGesture) {
    const app = useApp.getState();
    const host = ctx.select;
    const view = host.view();
    const { screen, world } = e;
    const doc = ctx.doc;
    const touch = e.pointerType === "touch";

    // A constraint mark is on top of everything: it is small, and the
    // geometry under it is reachable a pixel away.
    const glyph = host.glyphAt(screen);
    if (glyph) {
      const constraint = doc.constraints().find((c) => c.id === glyph);
      app.setHighlightedConstraint(glyph);
      if (constraint) app.setSelection(constraintEntityIds(constraint).filter((id) => !!doc.get(id)));
      this.g = { kind: "idle" };
      return;
    }
    app.setHighlightedConstraint(null);

    // A grip of a selected entity under the cursor beats everything else.
    const gripHit = findGrip(ctx, app.selection, screen, view, touch);
    if (gripHit) {
      this.g = { kind: "grip", entityId: gripHit.entityId, grip: gripHit.grip, startScreen: screen, preview: [] };
      return;
    }
    const groupId = wholeGroupSelected(doc, app.selection);
    const bb = groupId ? boundsOf(app.selection.map((id) => doc.get(id)).filter((ent): ent is Entity => !!ent)) : null;
    if (bb && dist(screen, groupHandleScreenPos(view, bb)) <= GROUP_HANDLE_HIT_PX) {
      const pivot = { x: (bb.minX + bb.maxX) / 2, y: (bb.minY + bb.maxY) / 2 };
      const startAngle = Math.atan2(world.y - pivot.y, world.x - pivot.x);
      this.g = { kind: "rotate-group", ids: app.selection, pivot, startAngle, rotation: 0 };
      return;
    }

    // Alt turns the drag into a freehand selection: a lasso, or a fence
    // while the no-snap modifier is also held. Checked before the hit
    // test, so a lasso can start over geometry in a crowded drawing.
    if (e.altKey) {
      this.g = {
        kind: "free-select",
        startScreen: screen,
        points: [world],
        additive: matchesModifier(e, "mouse.addToSelection"),
        fence: matchesModifier(e, "mouse.freeMove"),
      };
      return;
    }
    const hit = host.cyclingHit(world, screen);
    if (hit) {
      // Clicking any member of a group selects the whole group, unless it's currently "entered".
      const resolved = resolveSelection(doc, hit, app.enteredGroupId);
      let ids: EntityId[];
      let collapseTo: EntityId[] | null = null;
      if (matchesModifier(e, "mouse.addToSelection")) {
        const allSelected = resolved.every((id) => app.selection.includes(id));
        ids = allSelected ? app.selection.filter((id) => !resolved.includes(id)) : [...new Set([...app.selection, ...resolved])];
      } else {
        const alreadyExact = app.selection.length === resolved.length && resolved.every((id) => app.selection.includes(id));
        const isSubsetOfBigger = app.selection.length > resolved.length && resolved.every((id) => app.selection.includes(id));
        if (isSubsetOfBigger) {
          // Grabbed one member of a bigger multi-selection: keep the whole
          // selection so a drag moves everything together; only collapse
          // to just this item on release if it turns out to be a plain
          // click with no drag.
          ids = app.selection;
          collapseTo = resolved;
        } else {
          ids = alreadyExact ? app.selection : resolved;
        }
      }
      app.setSelection(ids);
      if (resolved.every((id) => ids.includes(id))) {
        this.g = {
          kind: "move",
          ids,
          startWorld: world,
          startScreen: screen,
          collapseTo,
          dx: 0,
          dy: 0,
          baseVertices: selectionVertices(ctx, ids),
        };
      }
    } else {
      // Nothing under the cursor: could be a plain click (clears the
      // selection on release) or the start of a window/crossing
      // drag-select — release decides based on how far it moved.
      this.g = {
        kind: "box-select",
        startScreen: screen,
        startWorld: world,
        currentWorld: world,
        additive: matchesModifier(e, "mouse.addToSelection"),
      };
    }
  }

  dragMove(ctx: ToolContext, e: PointerGesture) {
    const g = this.g;
    const view = ctx.select.view();
    const { world } = e;
    if (g.kind === "move") {
      const rawDx = world.x - g.startWorld.x;
      const rawDy = world.y - g.startWorld.y;
      // Snap the moved geometry itself, not the cursor: each axis is nudged so
      // some dragged vertex lands on some anchor's x / y. Hold Ctrl (or Alt) to
      // move completely free.
      const { dx, dy } = noSnap(e) ? { dx: rawDx, dy: rawDy } : snapMovingSelection(ctx.doc, view, g.baseVertices, rawDx, rawDy, g.ids);
      this.g = { ...g, dx, dy };
    } else if (g.kind === "rotate-group") {
      const angle = Math.atan2(world.y - g.pivot.y, world.x - g.pivot.x);
      // Snap to 45° steps so a turned pallet still lines up; Ctrl frees it.
      const rotation = snapRotation(angle - g.startAngle, noSnap(e));
      this.g = { ...g, rotation };
    } else if (g.kind === "grip") {
      const entity = ctx.doc.get(g.entityId);
      if (entity) {
        // Snap to everything but the entity being edited; ortho/polar from the grip's other end for a line.
        const target = noSnap(e) ? world : findSnap(ctx.doc, view, world, { exclude: [entity.id], settings: useSnapSettings.getState().settings }).point;
        this.g = { ...g, preview: ctx.select.gripPreview(entity, g.grip, target) };
      }
    } else if (g.kind === "free-select") {
      // One point per move event is more than the shape needs; thin as we go
      // so a long lasso stays a few dozen edges rather than a few hundred.
      const last = g.points[g.points.length - 1];
      if (dist(last, world) > 2 / view.scale) g.points.push(world);
      this.g = { ...g };
    } else if (g.kind === "box-select") {
      this.g = { ...g, currentWorld: world };
    }
  }

  release(ctx: ToolContext, e: PointerGesture) {
    const g = this.g;
    const app = useApp.getState();
    const touch = e.pointerType === "touch";
    this.g = { kind: "idle" };
    if (g.kind === "free-select") {
      const path = simplifyPath(g.points, 2 / ctx.select.view().scale);
      const fence = g.fence || matchesModifier(e, "mouse.freeMove");
      const picked = fence ? entitiesCrossedByFence(selectableEntities(), path) : entitiesInPolygon(selectableEntities(), path, freeSelectMode(path));
      app.setSelection(g.additive ? [...new Set([...app.selection, ...picked])] : picked);
    } else if (g.kind === "box-select") {
      if (dist(e.screen, g.startScreen) < (touch ? 10 : 4)) {
        // Barely moved: treat as a plain click on empty canvas.
        if (!g.additive) app.setSelection([]);
      } else {
        const { startWorld: s, currentWorld: c } = g;
        const box = { minX: Math.min(s.x, c.x), maxX: Math.max(s.x, c.x), minY: Math.min(s.y, c.y), maxY: Math.max(s.y, c.y) };
        const mode: BoxSelectMode = c.x >= s.x ? "window" : "crossing";
        const picked = entitiesInBox(selectableEntities(), box, mode);
        app.setSelection(g.additive ? [...new Set([...app.selection, ...picked])] : picked);
      }
    } else if (g.kind === "move") {
      const moved = dist(e.screen, g.startScreen) >= (touch ? 10 : 4);
      if (moved && (g.dx !== 0 || g.dy !== 0)) {
        ctx.select.executeRaw({ type: "move-entities", ids: g.ids, dx: g.dx, dy: g.dy });
      } else if (!moved && g.collapseTo) {
        // A plain click (no drag) on one member of a bigger selection: now
        // collapse down to just that item, as a click normally would.
        app.setSelection(g.collapseTo);
      }
    } else if (g.kind === "rotate-group") {
      if (Math.abs(g.rotation) > 1e-9) {
        ctx.select.executeRaw({ type: "transform-entities", ids: g.ids, pivot: g.pivot, rotation: g.rotation, dx: 0, dy: 0, scale: 1 });
      }
    } else if (g.kind === "grip") {
      const moved = dist(e.screen, g.startScreen) >= (touch ? 10 : 3);
      const previews = g.preview;
      if (moved && previews.length === 1) ctx.select.executeRaw({ type: "update-entity", entity: previews[0] });
      else if (moved && previews.length > 1) {
        // A drag-solve moved several entities: one batch, one undo step.
        ctx.select.executeRaw({ type: "batch", commands: previews.map((entity) => ({ type: "update-entity" as const, entity })) });
      }
    }
  }
}
