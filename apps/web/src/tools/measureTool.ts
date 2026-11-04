import { arcSweep, dist, entityLength, polylineLength } from "@sketchor/core";
import type { Point } from "@sketchor/core";
import { useApp } from "../state/store";
import type { Pick, Tool, ToolContext } from "./tool";

/**
 * Measure (roadmap T-00 migration of the legacy switch case). Results live
 * in the store (`measurement`), not the document, so nothing here emits a
 * Command.
 *  - plain click, click: point-to-point distance (snapped);
 *  - Alt-click an entity: its length / radius, a running total after the first;
 *  - Ctrl-click a line: toggle it as the angle reference edge;
 *  - click on empty space inside a closed loop: its area;
 *  - double-click anywhere: drop what is showing (Esc does too, but leaves the tool).
 */
export class MeasureTool implements Tool {
  id = "measure" as const;
  plain = true;
  private start: Point | null = null;

  prompt() {
    return "";
  }
  // Deliberately never "busy": arrow keys keep nudging the selection while measuring, as they always did.
  busy() {
    return false;
  }
  anchor() {
    return null;
  }
  cancel() {
    this.start = null;
  }

  pick(ctx: ToolContext, pick: Pick) {
    const app = useApp.getState();
    const world = pick.world;
    const hit = ctx.hitEntity(world);
    const hitEntity = hit ? ctx.doc.get(hit) : null;

    // Ctrl-click a line to pick it as the angle reference edge for distance
    // measurements (click it again to clear). Independent of the straighten
    // tool's own reference edge.
    if (pick.ctrlKey && hitEntity?.type === "line") {
      app.setReferenceEdge(app.referenceEdgeId === hitEntity.id ? null : hitEntity.id);
      this.start = null;
      return;
    }

    // Alt-click is the explicit "measure this whole entity" gesture; a plain
    // click always measures point-to-point. Once a running total is showing,
    // every further Alt-click adds to it.
    if (pick.altKey && hitEntity?.type === "arc") {
      const len = hitEntity.radius * arcSweep(hitEntity.startAngle, hitEntity.endAngle, hitEntity.ccw);
      const current = app.measurement;
      if (current?.kind === "length") {
        if (!current.ids.includes(hitEntity.id)) {
          app.setMeasurement({ kind: "length", ids: [...current.ids, hitEntity.id], total: current.total + len });
        }
      } else {
        app.setMeasurement({ kind: "radius", id: hitEntity.id, center: hitEntity.center, radius: hitEntity.radius, arcLength: len });
      }
      this.start = null;
      return;
    }

    if (pick.altKey && hitEntity?.type === "circle") {
      app.setMeasurement({ kind: "radius", id: hitEntity.id, center: hitEntity.center, radius: hitEntity.radius });
      this.start = null;
      return;
    }

    if (pick.altKey && (hitEntity?.type === "line" || hitEntity?.type === "polyline" || hitEntity?.type === "ellipse" || hitEntity?.type === "spline")) {
      const len = hitEntity.type === "line" ? dist(hitEntity.a, hitEntity.b) : hitEntity.type === "polyline" ? polylineLength(hitEntity) : (entityLength(hitEntity) ?? 0);
      const current = app.measurement;
      if (current?.kind === "length") {
        if (!current.ids.includes(hitEntity.id)) {
          app.setMeasurement({ kind: "length", ids: [...current.ids, hitEntity.id], total: current.total + len });
        }
      } else {
        app.setMeasurement({ kind: "length", ids: [hitEntity.id], total: len });
      }
      this.start = null;
      return;
    }

    // Nothing under the cursor at all: an enclosing closed area takes
    // priority over starting a two-point distance drag.
    if (!hitEntity) {
      const region = ctx.closedRegionAt(world);
      if (region) {
        app.setMeasurement({ kind: "area", region });
        this.start = null;
        return;
      }
    }

    if (this.start) {
      // second click freezes the measurement
      app.setMeasurement({ kind: "distance", a: this.start, b: pick.point });
      this.start = null;
    } else {
      this.start = pick.point;
      app.setMeasurement({ kind: "distance", a: pick.point, b: pick.point });
    }
  }

  hover(ctx: ToolContext, pick: Pick) {
    ctx.setHoverEntity(ctx.hitEntity(pick.world));
    if (this.start) useApp.getState().setMeasurement({ kind: "distance", a: this.start, b: pick.point });
  }

  /** Double-click anywhere drops the measurement without leaving the tool. */
  doubleClick() {
    useApp.getState().setMeasurement(null);
    this.start = null;
    return true;
  }

  preview() {
    return [];
  }
}
