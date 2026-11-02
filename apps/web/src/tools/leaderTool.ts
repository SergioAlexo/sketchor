import type { DimensionEntity, Entity, Point } from "@sketchor/core";
import { addLeaderLine, buildLeader, nextBalloonNumber,nextEntityName, refAtPoint, type BalloonShape } from "@sketchor/core";
import type { ToolId } from "../state/store";
import { type Pick, type Tool, type ToolContext } from "./tool";

/**
 * Leader and balloon tools (D-05). Click the arrow tip, then the landing
 * point; Alt-click on any click after the first keeps the line going (a bend)
 * instead of finishing. `leader` types its text on the command line
 * (`leader NOTE 4`); `balloon` numbers itself (next free item number) unless a
 * whole number was typed (`balloon 12`), and `balloon hexagon` picks the shape.
 * What the clicks become is decided in core (`dimensions/leaderOps.ts`).
 */

const PREVIEW_ID = "__leader_preview__";
const SHAPES: readonly BalloonShape[] = ["circle", "hexagon", "triangle", "square"];

export class LeaderTool implements Tool {
  private pts: Point[] = [];
  private text = "";
  private number: number | null = null;
  private shape: BalloonShape = "circle";
  private tipRef: ReturnType<typeof refAtPoint> = null;

  constructor(readonly id: ToolId) {}

  private get balloon(): boolean {
    return this.id === "balloon";
  }

  prompt(): string {
    if (this.pts.length === 0) return this.balloon ? "Balloon: click the part to point at" : "Leader: click the arrow tip";
    return "Click the landing point (Alt-click adds a bend) - Enter finishes, Esc cancels";
  }

  busy(): boolean {
    return this.pts.length > 0;
  }

  anchor(): Point | null {
    return this.pts.length ? this.pts[this.pts.length - 1] : null;
  }

  cancel(): void {
    this.pts = [];
    this.tipRef = null;
  }

  /** Typed command argument: a number or shape for a balloon, the note for a leader. */
  typed(_ctx: ToolContext, text: string): boolean {
    const t = text.trim();
    if (this.pts.length > 0 || t === "") return false;
    if (this.balloon) {
      if ((SHAPES as readonly string[]).includes(t.toLowerCase())) {
        this.shape = t.toLowerCase() as BalloonShape;
        return true;
      }
      if (/^\d+$/.test(t)) {
        this.number = Number(t);
        return true;
      }
      return false;
    }
    if (/^[@\-.\d]/.test(t) && /^[@\-.\d,<\s]+$/.test(t)) return false; // a coordinate, not a note
    this.text = t;
    return true;
  }

  private make(ctx: ToolContext, pts: Point[], id?: string): DimensionEntity | null {
    const style = ctx.doc.settings.currentDimStyle;
    const content = this.balloon
      ? { text: String(this.number ?? nextBalloonNumber(ctx.doc.all())), balloon: this.shape }
      : { text: this.text };
    return buildLeader(pts, content, { layer: ctx.activeLayer(), ...(style ? { style } : {}), ...(id ? { id } : {}) });
  }

  private finish(ctx: ToolContext, pts: Point[]): void {
    const d = this.make(ctx, pts);
    if (d) {
      const refs = this.tipRef ? [this.tipRef, ...pts.slice(1).map(() => null)] : undefined;
      ctx.execute({ type: "add-entity", entity: { ...d, name: nextEntityName(ctx.doc, "dimension"), ...(refs ? { refs } : {}) } });
      if (this.balloon) this.number = null;
      else this.text = "";
    }
    this.cancel();
    ctx.redraw();
  }

  pick(ctx: ToolContext, p: Pick): void {
    if (this.pts.length === 0) {
      this.pts = [p.point];
      this.tipRef = refAtPoint(ctx.doc.all(), p.point);
      return;
    }
    const pts = [...this.pts, p.point];
    if (p.altKey) {
      this.pts = pts;
      return;
    }
    this.finish(ctx, pts);
  }

  doubleClick(ctx: ToolContext): boolean {
    if (this.pts.length >= 2) {
      this.finish(ctx, this.pts);
      return true;
    }
    return false;
  }

  key(ctx: ToolContext, e: KeyboardEvent): boolean {
    if (e.key === "Enter" && this.pts.length >= 2) {
      this.finish(ctx, this.pts);
      return true;
    }
    return false;
  }

  preview(ctx: ToolContext, cursor: Point | null): Entity[] {
    if (!cursor || this.pts.length === 0) return [];
    const d = this.make(ctx, [...this.pts, cursor], PREVIEW_ID);
    return d ? [d] : [];
  }
}

/** Adds leader lines to an existing leader: click it, then each new arrow tip; Esc stops. */
export class LeaderAddTool implements Tool {
  readonly id: ToolId = "leaderadd";
  private target: DimensionEntity | null = null;

  prompt(): string {
    return this.target ? "Click the arrow tip of the new leader line - Esc finishes" : "Click the leader to add a line to";
  }

  busy(): boolean {
    return this.target !== null;
  }

  anchor(): Point | null {
    return null;
  }

  cancel(): void {
    this.target = null;
  }

  private current(ctx: ToolContext): DimensionEntity | null {
    if (!this.target) return null;
    const live = ctx.doc.get(this.target.id);
    return live && live.type === "dimension" ? live : this.target;
  }

  pick(ctx: ToolContext, p: Pick): void {
    if (!this.target) {
      const hit = ctx.hitTest(p.world).map((id) => ctx.doc.get(id)).find((x): x is DimensionEntity => x?.type === "dimension" && x.kind === "leader");
      if (hit) this.target = hit;
      return;
    }
    const cur = this.current(ctx);
    if (!cur) return;
    const next = addLeaderLine(cur, p.point);
    this.target = next;
    ctx.execute({ type: "update-entity", entity: next });
    ctx.redraw();
  }

  preview(ctx: ToolContext, cursor: Point | null): Entity[] {
    const cur = this.current(ctx);
    if (!cur || !cursor) return [];
    return [{ ...addLeaderLine(cur, cursor), id: PREVIEW_ID }];
  }
}

