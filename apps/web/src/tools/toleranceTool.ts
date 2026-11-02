import type { DimensionEntity, Entity, Point } from "@sketchor/core";
import { buildTolerance, fcfFromTyped, nextEntityName, parseFcf } from "@sketchor/core";
import type { ToolId } from "../state/store";
import { type Pick, type Tool, type ToolContext } from "./tool";

/**
 * Feature control frame tool (D-06). The frame's content is typed on the
 * command line - `tol position *0.5(M) A B(M)` (`*` = Ø, `/` starts a composite
 * row; a bare symbol name such as `tol flatness 0.05` works too) - and one
 * click places it. With nothing typed the last content is reused (first use:
 * a position frame to datum A). What the text means lives in core
 * (`dimensions/gdt.ts`); this only collects the text and the click.
 */

const PREVIEW_ID = "__tolerance_preview__";
const DEFAULT_CONTENT = "position|Ø0.1|A";

export class ToleranceTool implements Tool {
  readonly id: ToolId = "tolerance";
  private content = DEFAULT_CONTENT;

  prompt(): string {
    return `Frame ${this.content.replace(/\n/g, " / ")}: click where it goes (type e.g. "position *0.5(M) A B" to change it)`;
  }

  busy(): boolean {
    return false;
  }

  anchor(): Point | null {
    return null;
  }

  cancel(): void {}

  typed(_ctx: ToolContext, text: string): boolean {
    const t = text.trim();
    if (t === "" || /^[@\-.\d]/.test(t) && /^[@\-.\d,<\s]+$/.test(t)) return false; // empty or a coordinate
    const content = fcfFromTyped(t);
    if (parseFcf(content).length === 0) return false;
    this.content = content;
    return true;
  }

  private make(ctx: ToolContext, at: Point, id?: string): DimensionEntity {
    const style = ctx.doc.settings.currentDimStyle;
    return buildTolerance(this.content, at, { layer: ctx.activeLayer(), ...(style ? { style } : {}), ...(id ? { id } : {}) });
  }

  pick(ctx: ToolContext, p: Pick): void {
    const d = this.make(ctx, p.point);
    ctx.execute({ type: "add-entity", entity: { ...d, name: nextEntityName(ctx.doc, "dimension") } });
    ctx.redraw();
  }

  preview(ctx: ToolContext, cursor: Point | null): Entity[] {
    return cursor ? [this.make(ctx, cursor, PREVIEW_ID)] : [];
  }
}
