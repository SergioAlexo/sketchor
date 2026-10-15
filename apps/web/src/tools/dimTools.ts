import type { DimensionEntity, Entity, LineEntity, Point, PointRef } from "@sketchor/core";
import {
  chainDimension,
  dimAngle3,
  dimBetweenPoints,
  dimOfArcLength,
  dimOfCircle,
  dimOfLine,
  dimOfTwoLines,
  dimOrdinate,
  dimStyleOf,
  nextEntityName,
  quickDimension,
  refAtPoint,
  type DimBuildOptions,
  type QDimMode,
} from "@sketchor/core";
import type { ToolId } from "../state/store";
import { type Pick, type Tool, type ToolContext } from "./tool";

/**
 * Dimension tools (D-02c). One state machine, parameterised by mode:
 *
 *  - `dim`      smart DIM: a line gives its length, a circle its diameter, an
 *               arc its radius, two lines the angle (or, parallel, the
 *               distance), two points a linear dimension. Every click after the
 *               object(s) places the dimension line.
 *  - explicit   DLI linear, DAL aligned, DAN angular, DRA radial, DDI diametric,
 *               DAR arc length, DOR ordinate, DJO jogged.
 *  - DBA / DCO  baseline / continue from an existing linear or aligned dimension.
 *  - QDIM       select geometry, Enter (or a click when something is already
 *               selected), then place the chain; B / C / O switch baseline,
 *               continued and ordinate while it is waiting for the placement.
 *
 * Which dimension a set of picks becomes is decided in core
 * (`dimensions/build.ts`, tested); this file only collects picks.
 */

export type DimMode = "smart" | "linear" | "aligned" | "angular" | "radial" | "diametric" | "arclength" | "ordinate" | "jogged" | "baseline" | "continue" | "qdim";

const PREVIEW_ID = "__dim_preview__";
/** Snap kinds that mean "this exact point", not "this entity". */
const POINT_SNAPS = new Set(["endpoint", "midpoint", "center", "quadrant", "intersection", "node", "origin"]);

type Stage =
  | { s: "first" }
  | { s: "line"; line: LineEntity }
  | { s: "lines"; a: LineEntity; b: LineEntity }
  | { s: "round"; entity: Entity }
  | { s: "pt2"; p1: Point; r1: PointRef | null }
  | { s: "pt3"; p1: Point; p2: Point; r1: PointRef | null; r2: PointRef | null }
  | { s: "ang3"; pts: Point[] }
  | { s: "ordinate" ; feature: Point }
  | { s: "chain"; prev: DimensionEntity }
  | { s: "qsel"; ents: Entity[] }
  | { s: "qplace"; ents: Entity[]; mode: QDimMode };

export class DimTool implements Tool {
  private st: Stage = { s: "first" };
  private qmode: QDimMode = "continued";

  constructor(readonly id: ToolId, private readonly mode: DimMode) {}

  /* ---- helpers ---- */

  private opts(ctx: ToolContext): DimBuildOptions {
    const style = ctx.doc.settings.currentDimStyle;
    return { layer: ctx.activeLayer(), ...(style ? { style } : {}) };
  }

  private spacing(ctx: ToolContext): number {
    const name = ctx.doc.settings.currentDimStyle;
    return dimStyleOf(name ? ctx.doc.getRecord("dimStyles", name) : undefined).baselineSpacing;
  }

  private refAt(ctx: ToolContext, p: Point): PointRef | null {
    return refAtPoint(ctx.doc.all(), p);
  }

  private hit(ctx: ToolContext, world: Point): Entity | undefined {
    for (const id of ctx.hitTest(world)) {
      const e = ctx.doc.get(id);
      if (e && e.type !== "hatch") return e;
    }
    return undefined;
  }

  private commit(ctx: ToolContext, dims: DimensionEntity[]): void {
    if (!dims.length) return;
    // Names count what is already in the drawing, so number the batch ourselves.
    const cmds = dims.map((d, i) => ({ type: "add-entity" as const, entity: { ...d, name: d.name ?? (i === 0 ? nextEntityName(ctx.doc, "dimension") : undefined) } }));
    if (cmds.length === 1) ctx.execute(cmds[0]);
    else ctx.commit(cmds);
  }

  private done(ctx: ToolContext): void {
    this.st = { s: "first" };
    ctx.redraw();
  }

  /* ---- Tool ---- */

  prompt(): string {
    const s = this.st;
    switch (s.s) {
      case "first":
        switch (this.mode) {
          case "smart": return "Dimension: click a line, circle, arc or point (click a second line for the angle between them)";
          case "linear": case "aligned": return "Dimension: click the first point, or a line to dimension its length";
          case "angular": return "Angle: click the first line (or the vertex for a three-point angle)";
          case "radial": case "diametric": case "jogged": case "arclength": return "Click a circle or arc";
          case "ordinate": return "Ordinate (from 0,0): click the feature point";
          case "baseline": case "continue": return "Click the linear dimension to continue from";
          case "qdim": return "Quick dimension: click objects, Enter when done";
        }
        break;
      case "line": return "Click to place the dimension line (click another line for the angle between them)";
      case "lines": case "round": case "pt3": return "Click to place the dimension";
      case "pt2": return "Click the second point";
      case "ang3": return s.pts.length === 1 ? "Click the first point of the angle" : s.pts.length === 2 ? "Click the second point of the angle" : "Click to place the angle arc";
      case "ordinate": return "Click the end of the leader";
      case "chain": return `${this.mode === "baseline" ? "Baseline" : "Continue"}: click the next point - Esc to finish`;
      case "qsel": return `Quick dimension: ${s.ents.length} object(s) - click more, Enter to place`;
      case "qplace": return `Click to place the chain (${s.mode}) - B baseline, C continued, O ordinate`;
    }
    return "";
  }

  busy(): boolean {
    return this.st.s !== "first";
  }

  anchor(): Point | null {
    const s = this.st;
    switch (s.s) {
      case "pt2": case "pt3": return s.p1;
      case "ang3": return s.pts[0];
      case "ordinate": return s.feature;
      default: return null;
    }
  }

  cancel(): void {
    this.st = { s: "first" };
  }

  pick(ctx: ToolContext, p: Pick): void {
    const o = this.opts(ctx);
    const s = this.st;
    const pointSnap = !!p.snap && POINT_SNAPS.has(p.snap.kind);
    switch (s.s) {
      case "first": return this.first(ctx, p, pointSnap);
      case "line": {
        const other = !p.shiftKey && !pointSnap ? this.hit(ctx, p.world) : undefined;
        const second = other && other.type === "line" && other.id !== s.line.id && this.mode !== "linear" && this.mode !== "aligned";
        if (second) {
          this.st = { s: "lines", a: s.line, b: other as LineEntity };
          return;
        }
        if (this.mode === "angular") return; // an angle needs a second line
        const l = s.line;
        const d =
          this.mode === "linear" || this.mode === "aligned"
            ? dimBetweenPoints(l.a, l.b, p.point, this.mode, o, [{ entityId: l.id, point: "a" }, { entityId: l.id, point: "b" }])
            : dimOfLine(l, p.point, o);
        this.commit(ctx, [d]);
        return this.done(ctx);
      }
      case "lines": {
        const d = dimOfTwoLines(s.a, s.b, p.point, o);
        if (d) this.commit(ctx, [d]);
        return this.done(ctx);
      }
      case "round": {
        const kind = this.mode === "radial" || this.mode === "diametric" || this.mode === "jogged" ? this.mode : undefined;
        const d = this.mode === "arclength" ? dimOfArcLength(s.entity, p.point, o) : dimOfCircle(s.entity, p.point, kind, o);
        if (d) this.commit(ctx, [d]);
        return this.done(ctx);
      }
      case "pt2": {
        this.st = { s: "pt3", p1: s.p1, p2: p.point, r1: s.r1, r2: this.refAt(ctx, p.point) };
        return;
      }
      case "pt3": {
        const mode = this.mode === "aligned" || p.altKey ? "aligned" : "linear";
        this.commit(ctx, [dimBetweenPoints(s.p1, s.p2, p.point, mode, o, [s.r1, s.r2])]);
        return this.done(ctx);
      }
      case "ang3": {
        if (s.pts.length < 3) {
          this.st = { s: "ang3", pts: [...s.pts, p.point] };
          return;
        }
        this.commit(ctx, [dimAngle3(s.pts[0], s.pts[1], s.pts[2], p.point, o)]);
        return this.done(ctx);
      }
      case "ordinate":
        this.commit(ctx, [dimOrdinate({ x: 0, y: 0 }, s.feature, p.point, undefined, o)]);
        return this.done(ctx);
      case "chain": {
        const next = chainDimension(s.prev, p.point, this.mode === "baseline" ? "baseline" : "continue", this.spacing(ctx), o, this.refAt(ctx, p.point));
        if (!next) return;
        this.commit(ctx, [next]);
        this.st = { s: "chain", prev: next };
        return;
      }
      case "qsel": {
        const e = this.hit(ctx, p.world);
        if (e && e.type !== "dimension" && !s.ents.some((x) => x.id === e.id)) this.st = { s: "qsel", ents: [...s.ents, e] };
        return;
      }
      case "qplace": {
        this.commit(ctx, quickDimension(s.ents, p.point, s.mode, this.spacing(ctx), "auto", o));
        return this.done(ctx);
      }
    }
  }

  private first(ctx: ToolContext, p: Pick, pointSnap: boolean): void {
    const e = pointSnap ? undefined : this.hit(ctx, p.world);
    const point = (): void => {
      this.st = { s: "pt2", p1: p.point, r1: this.refAt(ctx, p.point) };
    };
    switch (this.mode) {
      case "smart":
      case "linear":
      case "aligned":
        if (e?.type === "line") this.st = { s: "line", line: e };
        else if (e && (e.type === "circle" || e.type === "arc") && this.mode === "smart") this.st = { s: "round", entity: e };
        else point();
        return;
      case "angular":
        if (e?.type === "line") this.st = { s: "line", line: e };
        else this.st = { s: "ang3", pts: [p.point] };
        return;
      case "radial": case "diametric": case "jogged":
        if (e && (e.type === "circle" || e.type === "arc")) this.st = { s: "round", entity: e };
        return;
      case "arclength":
        if (e?.type === "arc") this.st = { s: "round", entity: e };
        return;
      case "ordinate":
        this.st = { s: "ordinate", feature: p.point };
        return;
      case "baseline": case "continue": {
        const d = ctx.hitTest(p.world).map((id) => ctx.doc.get(id)).find((x): x is DimensionEntity => x?.type === "dimension" && (x.kind === "linear" || x.kind === "aligned"));
        if (d) this.st = { s: "chain", prev: d };
        return;
      }
      case "qdim": {
        const sel = ctx.selection().map((id) => ctx.doc.get(id)).filter((x): x is Entity => !!x && x.type !== "dimension");
        if (sel.length) this.st = { s: "qplace", ents: sel, mode: this.qmode };
        else if (e && e.type !== "dimension") this.st = { s: "qsel", ents: [e] };
        return;
      }
    }
  }

  doubleClick(): boolean {
    return false;
  }

  key(ctx: ToolContext, e: KeyboardEvent): boolean {
    const s = this.st;
    if (e.key === "Enter") {
      if (s.s === "qsel" && s.ents.length) {
        this.st = { s: "qplace", ents: s.ents, mode: this.qmode };
        return true;
      }
      if (s.s === "chain") {
        this.done(ctx);
        return true;
      }
    }
    if (s.s === "qplace" && !e.ctrlKey && !e.metaKey && !e.altKey) {
      const k = e.key.toLowerCase();
      const m: QDimMode | null = k === "b" ? "baseline" : k === "c" ? "continued" : k === "o" ? "ordinate" : null;
      if (m) {
        this.qmode = m;
        this.st = { s: "qplace", ents: s.ents, mode: m };
        return true;
      }
    }
    return false;
  }

  preview(ctx: ToolContext, cursor: Point | null): Entity[] {
    if (!cursor) return [];
    const s = this.st;
    const o = { ...this.opts(ctx), id: PREVIEW_ID };
    let d: DimensionEntity | null = null;
    switch (s.s) {
      case "line": {
        const l = s.line;
        d = this.mode === "linear" || this.mode === "aligned" ? dimBetweenPoints(l.a, l.b, cursor, this.mode, o) : dimOfLine(l, cursor, o);
        break;
      }
      case "lines": d = dimOfTwoLines(s.a, s.b, cursor, o); break;
      case "round": d = this.mode === "arclength" ? dimOfArcLength(s.entity, cursor, o) : dimOfCircle(s.entity, cursor, this.mode === "radial" || this.mode === "diametric" || this.mode === "jogged" ? this.mode : undefined, o); break;
      case "pt3": d = dimBetweenPoints(s.p1, s.p2, cursor, this.mode === "aligned" ? "aligned" : "linear", o); break;
      case "ang3": d = s.pts.length === 3 ? dimAngle3(s.pts[0], s.pts[1], s.pts[2], cursor, o) : null; break;
      case "ordinate": d = dimOrdinate({ x: 0, y: 0 }, s.feature, cursor, undefined, o); break;
      case "chain": d = chainDimension(s.prev, cursor, this.mode === "baseline" ? "baseline" : "continue", this.spacing(ctx), o); break;
      case "qplace": return quickDimension(s.ents, cursor, s.mode, this.spacing(ctx), "auto", o).map((x, i) => ({ ...x, id: `${PREVIEW_ID}${i}` }));
      default: break;
    }
    return d ? [d] : [];
  }
}

