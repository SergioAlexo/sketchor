import { useApp } from "../state/store";
import { useMTextUi } from "../mtext/mtextUi";
import type { Pick, Tool, ToolContext } from "./tool";

/** Text and multiline text (roadmap T-00 migration): click an existing one to edit it, or empty space to start a new one there. */
class EditTextTool implements Tool {
  noTyped = true;
  constructor(
    readonly id: "text" | "mtext",
    private readonly kind: "text" | "mtext",
  ) {}
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
    const hit = ctx.hitEntity(pick.world);
    const existing = hit ? ctx.doc.get(hit) : null;
    if (this.kind === "mtext") {
      // D-04: edit the multiline text under the cursor, or start one where you clicked.
      if (existing && existing.type === "mtext") useMTextUi.getState().openEdit(existing);
      else useMTextUi.getState().openNew(pick.world, useApp.getState().textHeight);
    } else {
      ctx.editText(existing && existing.type === "text" ? existing : null, pick.world);
    }
  }
  preview() {
    return [];
  }
}

export class TextTool extends EditTextTool {
  constructor() {
    super("text", "text");
  }
}

export class MTextTool extends EditTextTool {
  constructor() {
    super("mtext", "mtext");
  }
}
