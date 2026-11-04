import { distToSegment, polylineSegments } from "@sketchor/core";
import { useApp } from "../state/store";
import type { Pick, Tool, ToolContext } from "./tool";

/**
 * Straighten (roadmap T-00 migration of the legacy switch case): picks the
 * reference edge the Straighten panel rotates the selection to. A line, or
 * one straight (non-bulged) segment of a polyline, that is already in the
 * selection can become the reference edge; the panel does the rotating.
 */
export class StraightenTool implements Tool {
  id = "straighten" as const;
  plain = true;
  prompt() {
    return "";
  }
  busy() {
    return false;
  }
  anchor() {
    return null;
  }
  cancel() {}
  pick(ctx: ToolContext, pick: Pick) {
    const app = useApp.getState();
    const hit = ctx.hitEntity(pick.world);
    const entity = hit ? ctx.doc.get(hit) : null;
    if (hit && entity?.type === "line" && app.selection.includes(hit)) {
      app.setReferenceEdge(hit);
    } else if (hit && entity?.type === "polyline" && app.selection.includes(hit)) {
      let best = -1;
      let bestDist = Infinity;
      polylineSegments(entity).forEach((s, i) => {
        if (s.bulge !== 0) return; // straighten needs a straight edge
        const d = distToSegment(pick.world, s.a, s.b);
        if (d < bestDist) {
          bestDist = d;
          best = i;
        }
      });
      if (best >= 0) app.setReferenceEdge(hit, best);
    }
  }
  preview() {
    return [];
  }
}
