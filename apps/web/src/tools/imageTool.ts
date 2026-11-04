import { newEntityId, nextEntityName } from "@sketchor/core";
import { useApp } from "../state/store";
import { layerProp, type Pick, type Tool, type ToolContext } from "./tool";

/**
 * Image (roadmap T-00 migration): a file picker rather than a two-click
 * draw. The image is inserted at the clicked point once a file is chosen,
 * then the tool drops back to select so it can be moved/resized right away.
 */
export class ImageTool implements Tool {
  id = "image" as const;
  noTyped = true;
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
    const insertAt = pick.point;
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
          ctx.execute({
            type: "add-entity",
            entity: {
              id: newEntityId(),
              type: "image",
              name: nextEntityName(ctx.doc, "image"),
              ...layerProp(useApp.getState().activeLayer),
              insert: insertAt,
              width: naturalW * fit,
              height: naturalH * fit,
              rotation: 0,
              dataUrl,
            },
          });
          ctx.setTool("select");
          ctx.redraw();
        };
        probe.src = dataUrl;
      };
      reader.readAsDataURL(file);
    };
    input.click();
  }
  preview() {
    return [];
  }
}
