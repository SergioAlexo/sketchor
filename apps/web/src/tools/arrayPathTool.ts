import type { Command, Entity, Point } from "@sketchor/core";
import { pathOf, pathPatternCommands, pathPatternCopyCount, type PathPattern } from "@sketchor/core";
import type { ToolId } from "../state/store";
import type { Pick, Tool, ToolContext } from "./tool";
import { parseLength } from "./typedInput";

/**
 * Array along a path (T-35, AutoCAD ARRAYPATH). Select the objects first,
 * then click the path (a line, arc, circle, polyline, ellipse or spline).
 * Type the layout before the click: a whole number is a count spread over the
 * whole path (`arraypath 8`), a length with a unit or a decimal is a spacing
 * (`arraypath 25mm`). Words: `align` / `noalign` (turn the copies with the
 * path; on by default) and `keep` / `replace` (keep the originals, or delete
 * them once copied; replace by default, as AutoCAD's array consumes its
 * source). The layout math is `pathPatternCommands` in core.
 */
export class ArrayPathTool implements Tool {
  readonly id: ToolId = "arraypath";
  private mode: PathPattern["mode"] = "count";
  private count = 5;
  private spacing = 0;
  private align = true;
  private replace = true;
  private message: string | null = null;

  prompt(ctx: ToolContext): string {
    if (this.message) return this.message;
    if (ctx.selection().length === 0) return "Array along path: select the objects first (Esc, select, then run it again)";
    const how = this.mode === "spacing" ? `every ${this.spacing}` : `${this.count} copies`;
    return `Array along path (${how}${this.align ? ", aligned" : ""}${this.replace ? "" : ", keeping the originals"}): click the path - type a count or spacing first`;
  }

  busy(): boolean {
    return false;
  }

  anchor(): Point | null {
    return null;
  }

  cancel(): void {
    this.message = null;
  }

  typed(ctx: ToolContext, text: string): boolean {
    let used = false;
    for (const word of text.trim().split(/\s+/)) {
      const w = word.toLowerCase();
      if (w === "align") this.align = true;
      else if (w === "noalign") this.align = false;
      else if (w === "keep") this.replace = false;
      else if (w === "replace") this.replace = true;
      else if (/^\d+$/.test(w)) {
        const n = Number(w);
        if (n < 1 || n > 10000) return used;
        this.mode = "count";
        this.count = n;
      } else {
        const d = parseLength(w, ctx.displayUnit());
        if (d === null || d <= 0) return used;
        this.mode = "spacing";
        this.spacing = d;
      }
      used = true;
    }
    return used;
  }

  private spec(path: string): PathPattern {
    return { path, mode: this.mode, count: this.count, spacing: this.spacing, align: this.align, replaceSource: this.replace };
  }

  pick(ctx: ToolContext, p: Pick): void {
    this.message = null;
    const selection = ctx.selection();
    if (selection.length === 0) {
      this.message = "Select the objects to array first";
      return;
    }
    const target = ctx
      .hitTest(p.world)
      .filter((id) => !selection.includes(id))
      .map((id) => ctx.doc.get(id))
      .find((e): e is Entity => !!e && pathOf(e) !== null);
    if (!target) {
      this.message = "Click a line, arc, circle, polyline, ellipse or spline to follow";
      return;
    }
    const spec = this.spec(target.id);
    const commands: Command[] = pathPatternCommands(ctx.doc, selection, spec);
    if (commands.length === 0) {
      this.message = pathPatternCopyCount(ctx.doc, spec, selection.length) === 0 ? "That layout puts nothing on this path" : "Nothing to array";
      return;
    }
    ctx.commit(commands);
    ctx.setSelection(commands.flatMap((c) => (c.type === "add-entity" ? [c.entity.id] : [])));
    ctx.redraw();
  }

  preview(): Entity[] {
    return [];
  }
}
