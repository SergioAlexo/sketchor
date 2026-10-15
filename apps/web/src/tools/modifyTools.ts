import type { Command, Entity, Point } from "@sketchor/core";
import {
  axisLineFor,
  mirrorConstraints,
  dist,
  mirrored,
  newEntityId,
  transformed,
  translated,
} from "@sketchor/core";
import { associativeOn } from "./autoConstrain";
import { parseLength } from "./typedInput";
import type { Pick, Tool, ToolContext } from "./tool";

/**
 * The modify tools (roadmap T-10..T-14): move, copy, rotate, scale,
 * mirror. All share one shape — work on the selection, take a base point,
 * take one or two more picks (or a typed value), commit one undoable
 * command — so they share a base class that handles the "nothing selected
 * yet" phase: with an empty selection, picks add entities (AutoCAD's
 * "Select objects:"), Enter moves on.
 *
 * The maths is @sketchor/core's `translated` / `transformed` / `mirrored`;
 * the tools only pick.
 */

abstract class SelectionTool implements Tool {
  abstract readonly id: Tool["id"];
  /** Picks made after the selection phase, in order. */
  protected picks: Point[] = [];

  abstract pick(ctx: ToolContext, p: Pick): void;
  abstract preview(ctx: ToolContext, cursor: Point | null): Entity[];
  /** The prompt once there is a selection to work on. */
  protected abstract stepPrompt(ctx: ToolContext): string;

  prompt(ctx: ToolContext): string {
    return ctx.selection().length > 0
      ? this.stepPrompt(ctx)
      : "Click the object to modify (to work on several, select them with the Select tool first)";
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

  /** Handles a pick while nothing is selected (it selects what was clicked); true when consumed. */
  protected selectPick(ctx: ToolContext, p: Pick): boolean {
    if (ctx.selection().length > 0) return false;
    const hit = ctx.hitTest(p.world);
    if (hit.length > 0) ctx.setSelection(hit);
    return true;
  }

  /** Entities the tool works on, in document order. */
  protected targets(ctx: ToolContext): Entity[] {
    const ids = new Set(ctx.selection());
    return ctx.doc.all().filter((e) => ids.has(e.id));
  }
}

/**
 * Copies of `entities` with fresh ids and no names — the sketch code's
 * `assignNames` hands out the next free L/C/A… names, which is simpler
 * than predicting them for a whole batch here.
 */
function copiesOf(entities: Entity[]): Entity[] {
  return entities.map((e) => {
    const { name: _dropped, ...rest } = e;
    return { ...rest, id: newEntityId() } as Entity;
  });
}

/* ---------------------------------- move ---------------------------------- */

/** Move: base point, then destination (or a typed displacement). Ctrl at the destination copies instead. */
export class MoveTool extends SelectionTool {
  readonly id = "move" as const;

  protected stepPrompt(): string {
    return this.picks.length === 0
      ? "Move: specify base point"
      : "Specify destination — or type @dx,dy / a distance (Ctrl-click copies)";
  }

  pick(ctx: ToolContext, p: Pick): void {
    if (this.selectPick(ctx, p)) return;
    if (this.picks.length === 0) {
      this.picks = [p.point];
      return;
    }
    const base = this.picks[0];
    const dx = p.point.x - base.x;
    const dy = p.point.y - base.y;
    const ids = ctx.selection();
    if (dx !== 0 || dy !== 0) {
      if (p.ctrlKey) {
        const copies = copiesOf(this.targets(ctx)).map((e) =>
          translated(e, dx, dy),
        );
        ctx.commit(
          copies.map((entity): Command => ({ type: "add-entity", entity })),
        );
      } else {
        ctx.execute({ type: "move-entities", ids, dx, dy });
      }
    }
    this.picks = [];
  }

  preview(ctx: ToolContext, cursor: Point | null): Entity[] {
    if (this.picks.length === 0 || !cursor) return [];
    const base = this.picks[0];
    return this.targets(ctx).map((e) =>
      translated(e, cursor.x - base.x, cursor.y - base.y),
    );
  }
}

/* ---------------------------------- copy ---------------------------------- */

/** Copy: like move, but leaves the source and repeats — every destination pick drops another copy until Esc/Enter. */
export class CopyTool extends SelectionTool {
  readonly id = "copy" as const;

  protected stepPrompt(): string {
    return this.picks.length === 0
      ? "Copy: specify base point"
      : "Specify destination for a copy (again for more) — Enter or Esc to stop";
  }

  pick(ctx: ToolContext, p: Pick): void {
    if (this.selectPick(ctx, p)) return;
    if (this.picks.length === 0) {
      this.picks = [p.point];
      return;
    }
    const base = this.picks[0];
    const dx = p.point.x - base.x;
    const dy = p.point.y - base.y;
    if (dx === 0 && dy === 0) return;
    const copies = copiesOf(this.targets(ctx)).map((e) =>
      translated(e, dx, dy),
    );
    ctx.commit(
      copies.map((entity): Command => ({ type: "add-entity", entity })),
    );
    // Stay armed on the same base point for the next copy.
  }

  key(_ctx: ToolContext, e: KeyboardEvent): boolean {
    if (e.key === "Enter" && this.picks.length > 0) {
      this.picks = [];
      return true;
    }
    return false;
  }

  preview(ctx: ToolContext, cursor: Point | null): Entity[] {
    if (this.picks.length === 0 || !cursor) return [];
    const base = this.picks[0];
    return this.targets(ctx).map((e) =>
      translated(e, cursor.x - base.x, cursor.y - base.y),
    );
  }
}

/* --------------------------------- rotate --------------------------------- */

/**
 * Rotate: pivot, then a reference direction, then the new direction — the
 * rotation is the angle between them (AutoCAD's Reference mode, which is
 * what squares up an imported drawing). Typing a number after the pivot
 * rotates by that many degrees outright. Ctrl at the last pick copies.
 */
export class RotateTool extends SelectionTool {
  readonly id = "rotate" as const;

  protected stepPrompt(): string {
    if (this.picks.length === 0) return "Rotate: specify the pivot point";
    if (this.picks.length === 1)
      return "Specify a reference point (the direction to rotate from) — or type the angle in degrees";
    return "Specify the new direction (Ctrl-click copies)";
  }
  anchor(): Point | null {
    // Both direction picks measure from the pivot, so polar increments give 15/45° steps.
    return this.picks[0] ?? null;
  }

  pick(ctx: ToolContext, p: Pick): void {
    if (this.selectPick(ctx, p)) return;
    if (this.picks.length < 2) {
      if (this.picks.length === 1 && dist(this.picks[0], p.point) === 0) return;
      this.picks.push(p.point);
      return;
    }
    const angle = this.angleTo(p.point);
    if (angle !== null) this.apply(ctx, angle, p.ctrlKey);
    this.picks = [];
  }

  typed(ctx: ToolContext, text: string): boolean {
    if (this.picks.length !== 1) return false;
    const deg = parseFloat(text.trim());
    if (!Number.isFinite(deg)) return false;
    this.apply(ctx, (deg * Math.PI) / 180, false);
    this.picks = [];
    return true;
  }

  private angleTo(point: Point): number | null {
    const [pivot, ref] = this.picks;
    if (dist(pivot, point) === 0) return null;
    return (
      Math.atan2(point.y - pivot.y, point.x - pivot.x) -
      Math.atan2(ref.y - pivot.y, ref.x - pivot.x)
    );
  }

  private apply(ctx: ToolContext, rotation: number, copy: boolean): void {
    const pivot = this.picks[0];
    if (Math.abs(rotation) < 1e-12) return;
    if (copy) {
      const copies = copiesOf(this.targets(ctx)).map((e) =>
        transformed(e, pivot, 0, 0, rotation, 1),
      );
      ctx.commit(
        copies.map((entity): Command => ({ type: "add-entity", entity })),
      );
    } else {
      ctx.execute({
        type: "transform-entities",
        ids: ctx.selection(),
        pivot,
        rotation,
        dx: 0,
        dy: 0,
        scale: 1,
      });
    }
  }

  preview(ctx: ToolContext, cursor: Point | null): Entity[] {
    if (!cursor || this.picks.length === 0) return [];
    const pivot = this.picks[0];
    const guide: Entity = {
      id: "preview-guide",
      type: "line",
      a: pivot,
      b: cursor,
    };
    if (this.picks.length < 2) return [guide];
    const angle = this.angleTo(cursor);
    if (angle === null) return [guide];
    return [
      guide,
      ...this.targets(ctx).map((e) => transformed(e, pivot, 0, 0, angle, 1)),
    ];
  }
}

/* ---------------------------------- scale --------------------------------- */

/**
 * Scale: base point, then either a typed factor, or a reference length
 * (pick a point) followed by what that length should become (a pick, or a
 * typed length — the way a DXF imported in the wrong unit gets fixed).
 * Uniform only: circles and arcs can't express anything else.
 */
export class ScaleTool extends SelectionTool {
  readonly id = "scale" as const;

  protected stepPrompt(): string {
    if (this.picks.length === 0) return "Scale: specify the base point";
    if (this.picks.length === 1)
      return "Type the scale factor — or pick a point to use its distance from the base as the reference length";
    return "Pick the new end of the reference length — or type the length it should be (Ctrl-click copies)";
  }
  anchor(): Point | null {
    return this.picks[0] ?? null;
  }

  pick(ctx: ToolContext, p: Pick): void {
    if (this.selectPick(ctx, p)) return;
    if (this.picks.length < 2) {
      if (this.picks.length === 1 && dist(this.picks[0], p.point) === 0) return;
      this.picks.push(p.point);
      return;
    }
    const factor = this.factorTo(p.point);
    if (factor !== null) this.apply(ctx, factor, p.ctrlKey);
    this.picks = [];
  }

  typed(ctx: ToolContext, text: string): boolean {
    if (this.picks.length === 1) {
      const factor = parseFloat(text.trim());
      if (!Number.isFinite(factor) || factor <= 0) return false;
      this.apply(ctx, factor, false);
      this.picks = [];
      return true;
    }
    if (this.picks.length === 2) {
      const target = parseLength(text, ctx.displayUnit());
      const ref = dist(this.picks[0], this.picks[1]);
      if (target === null || target <= 0 || ref === 0) return false;
      this.apply(ctx, target / ref, false);
      this.picks = [];
      return true;
    }
    return false;
  }

  private factorTo(point: Point): number | null {
    const ref = dist(this.picks[0], this.picks[1]);
    const now = dist(this.picks[0], point);
    if (ref === 0 || now === 0) return null;
    return now / ref;
  }

  private apply(ctx: ToolContext, scale: number, copy: boolean): void {
    const pivot = this.picks[0];
    if (Math.abs(scale - 1) < 1e-12) return;
    if (copy) {
      const copies = copiesOf(this.targets(ctx)).map((e) =>
        transformed(e, pivot, 0, 0, 0, scale),
      );
      ctx.commit(
        copies.map((entity): Command => ({ type: "add-entity", entity })),
      );
    } else {
      ctx.execute({
        type: "transform-entities",
        ids: ctx.selection(),
        pivot,
        rotation: 0,
        dx: 0,
        dy: 0,
        scale,
      });
    }
  }

  preview(ctx: ToolContext, cursor: Point | null): Entity[] {
    if (!cursor || this.picks.length === 0) return [];
    const pivot = this.picks[0];
    const guide: Entity = {
      id: "preview-guide",
      type: "line",
      a: pivot,
      b: cursor,
    };
    if (this.picks.length < 2) return [guide];
    const factor = this.factorTo(cursor);
    if (factor === null) return [guide];
    return [
      guide,
      ...this.targets(ctx).map((e) => transformed(e, pivot, 0, 0, 0, factor)),
    ];
  }
}

/* --------------------------------- mirror --------------------------------- */

/** Mirror: two points define the axis (ortho makes it H/V); the source is kept unless the second pick is Ctrl-clicked. */
export class MirrorTool extends SelectionTool {
  readonly id = "mirror" as const;

  protected stepPrompt(): string {
    return this.picks.length === 0
      ? "Mirror: specify the first point of the mirror line"
      : "Specify the second point of the mirror line (Ctrl-click to delete the source)";
  }

  pick(ctx: ToolContext, p: Pick): void {
    if (this.selectPick(ctx, p)) return;
    if (this.picks.length === 0) {
      this.picks = [p.point];
      return;
    }
    const a = this.picks[0];
    if (dist(a, p.point) === 0) return;
    const targets = this.targets(ctx);
    const copies = copiesOf(targets).map((e) => mirrored(e, a, p.point));
    const commands: Command[] = copies.map((entity): Command => ({ type: "add-entity", entity }));
    if (p.ctrlKey)
      commands.push({ type: "delete-entities", ids: targets.map((e) => e.id) });
    else if (associativeOn()) {
      // T-46: when the axis lies on a real line, the copy stays symmetric to its source.
      const axis = axisLineFor(a, p.point, ctx.doc.all());
      for (const constraint of mirrorConstraints(targets.map((source, i) => ({ source, copy: copies[i] })), axis))
        commands.push({ type: "add-constraint", constraint });
    }
    ctx.commit(commands);
    this.picks = [];
  }

  preview(ctx: ToolContext, cursor: Point | null): Entity[] {
    if (!cursor || this.picks.length === 0) return [];
    const a = this.picks[0];
    const axis: Entity = { id: "preview-guide", type: "line", a, b: cursor };
    if (dist(a, cursor) === 0) return [axis];
    return [axis, ...this.targets(ctx).map((e) => mirrored(e, a, cursor))];
  }
}
