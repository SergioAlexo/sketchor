import {
  boundsOf,
  fitViewportView,
  kindTessellate,
  newEntityId,
  newViewport,
  viewportFromPolygon,
  type Entity,
  type Point,
} from "@sketchor/core";
import { layerProp, type Pick, type Tool, type ToolContext } from "./tool";
import { getSpaceState } from "../layouts/layoutState";

const PREVIEW = "preview-viewport";
export type ViewportMode = "rectangle" | "polygon" | "object";

/**
 * L-03 "Viewport" tool: paper-space only. Rectangle (two corners), polygon
 * (points, Enter or double-click closes) or from an object (a closed polyline
 * or circle on the sheet becomes the window). The new window shows the model
 * extents at the largest standard scale that fits. Tab cycles the mode.
 */
export class ViewportTool implements Tool {
  readonly id = "viewport" as const;
  mode: ViewportMode = "rectangle";
  private picks: Point[] = [];

  prompt(ctx: ToolContext): string {
    if (!getSpaceState().layout) return "Viewport: switch to a layout tab first (viewports live on sheets)";
    const modes = "(Tab: rectangle / polygon / from object)";
    if (this.mode === "object") return `Viewport from object: click a closed shape on the sheet ${modes}`;
    if (this.mode === "polygon") return this.picks.length === 0 ? `Polygonal viewport: first point ${modes}` : "Next point (Enter or double-click closes)";
    return this.picks.length === 0 ? `Viewport: first corner ${modes}` : "Opposite corner";
  }
  busy(): boolean {
    return this.picks.length > 0;
  }
  anchor(): Point | null {
    return this.picks[this.picks.length - 1] ?? null;
  }
  cancel(): void {
    this.picks = [];
  }
  key(ctx: ToolContext, e: KeyboardEvent): boolean {
    if (e.key === "Enter" && this.mode === "polygon" && this.picks.length >= 3) {
      this.finishPolygon(ctx);
      return true;
    }
    if (e.key !== "Tab" || e.ctrlKey || e.metaKey || e.altKey) return false;
    const order: ViewportMode[] = ["rectangle", "polygon", "object"];
    this.mode = order[(order.indexOf(this.mode) + (e.shiftKey ? 2 : 1)) % 3];
    this.cancel();
    ctx.redraw();
    return true;
  }
  pick(ctx: ToolContext, p: Pick): void {
    const layout = getSpaceState().layout;
    if (!layout) return;
    if (this.mode === "object") return this.fromObject(ctx, p.world, layout);
    this.picks.push(p.point);
    if (this.mode === "rectangle" && this.picks.length === 2) {
      const [a, b] = this.picks;
      this.picks = [];
      const w = Math.abs(b.x - a.x);
      const h = Math.abs(b.y - a.y);
      if (w < 1 || h < 1) return;
      const view = fitViewportView(w, h, this.modelBounds(ctx));
      ctx.execute({ type: "add-entity", entity: { ...newViewport({ x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w, h }, view, { space: layout }), ...layerProp(ctx.activeLayer()) } });
    }
  }
  doubleClick(ctx: ToolContext): boolean {
    if (this.mode === "polygon" && this.picks.length >= 3) {
      // The double-click's first click already added its point (the last one is a duplicate of it).
      this.finishPolygon(ctx);
      return true;
    }
    return false;
  }
  preview(_ctx: ToolContext, cursor: Point | null): Entity[] {
    if (this.picks.length === 0 || !cursor) return [];
    if (this.mode === "rectangle") {
      const a = this.picks[0];
      return [{ id: PREVIEW, type: "polyline", points: [a, { x: cursor.x, y: a.y }, cursor, { x: a.x, y: cursor.y }], closed: true }];
    }
    return [{ id: PREVIEW, type: "polyline", points: [...this.picks, cursor], closed: false }];
  }

  private modelBounds(ctx: ToolContext) {
    return boundsOf(ctx.doc.all().filter((e) => !(e as { space?: string }).space));
  }

  private finishPolygon(ctx: ToolContext): void {
    const layout = getSpaceState().layout;
    const pts = dedupe(this.picks);
    this.picks = [];
    if (!layout || pts.length < 3) return;
    const bb = boundsOf([{ id: "t", type: "polyline", points: pts, closed: true } as Entity]);
    if (!bb) return;
    const view = fitViewportView(bb.maxX - bb.minX, bb.maxY - bb.minY, this.modelBounds(ctx));
    ctx.execute({ type: "add-entity", entity: { ...viewportFromPolygon(pts, view, { space: layout }), ...layerProp(ctx.activeLayer()) } });
  }

  private fromObject(ctx: ToolContext, world: Point, layout: string): void {
    const ids = ctx.hitTest(world);
    const src = ids.map((id) => ctx.doc.get(id)).find((e): e is Entity => !!e && (e.type === "polyline" || e.type === "circle"));
    if (!src) return;
    const run = kindTessellate(src, 0.1)[0];
    if (!run || run.length < 4) return;
    const pts = dedupe(run);
    const bb = boundsOf([src]);
    if (!bb) return;
    const view = fitViewportView(bb.maxX - bb.minX, bb.maxY - bb.minY, this.modelBounds(ctx));
    // The source shape stays: the window follows its outline (delete it if it was only a template).
    ctx.execute({ type: "add-entity", entity: { ...viewportFromPolygon(pts, view, { id: newEntityId(), space: layout }), ...layerProp(ctx.activeLayer()) } });
  }
}

function dedupe(points: Point[]): Point[] {
  const out: Point[] = [];
  for (const p of points) {
    const last = out[out.length - 1];
    if (!last || Math.hypot(p.x - last.x, p.y - last.y) > 1e-9) out.push({ ...p });
  }
  if (out.length > 1 && Math.hypot(out[0].x - out[out.length - 1].x, out[0].y - out[out.length - 1].y) < 1e-9) out.pop();
  return out;
}
