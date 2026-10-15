import type { Command, Entity, LineEntity, Point, PolylineEntity } from "@sketchor/core";
import {
  alignTransform,
  applyAlign,
  chamferLines,
  dist,
  extendTo,
  lengthen,
  filletAllCorners,
  filletConstraints,
  offsetConstraints,
  filletCurves,
  filletLines,
  filletPolylineCorner,
  kindHitDistance,
  layerOf,
  newEntityId,
  offsetEntity,
  pointsAlong,
  stretchEntities,
  transformed,
  splitAt,
  trimAt,
  trimHatch,
} from "@sketchor/core";
import { hiddenLayerSet } from "../state/store";
import { associativeOn } from "./autoConstrain";
import { parseLength } from "./typedInput";
import type { Pick, Tool, ToolContext } from "./tool";

/**
 * The geometry-editing tools (roadmap T-15/T-16/T-17): trim/extend, split,
 * fillet, chamfer, offset. The maths is @sketchor/core's intersect.ts,
 * fillet.ts and offset.ts; these classes only pick entities and points and
 * turn the result into one undoable batch (delete the original, add what
 * replaces it).
 */

/** Entities on visible layers — the boundaries trim/extend consider, in AutoCAD's quick-trim spirit (everything counts). */
function visible(ctx: ToolContext): Entity[] {
  const hidden = hiddenLayerSet();
  return ctx.doc.all().filter((e) => !hidden.has(layerOf(e)));
}

/** The visible entity under a world point, if any (group-agnostic — editing works on the piece you clicked). */
function entityAt(ctx: ToolContext, world: Point): Entity | null {
  const ids = ctx.hitTest(world);
  if (ids.length === 0) return null;
  // hitTest expands to the group; the member actually under the cursor is
  // the nearest of them.
  let best: { e: Entity; d: number } | null = null;
  for (const id of ids) {
    const e = ctx.doc.get(id);
    if (!e) continue;
    const d = distanceTo(e, world);
    if (!best || d < best.d) best = { e, d };
  }
  return best?.e ?? null;
}

function distanceTo(e: Entity, p: Point): number {
  // Cheap and good enough to pick among group members: distance to the nearest defining point.
  switch (e.type) {
    case "line":
      return Math.min(dist(p, e.a), dist(p, e.b), pointToSegment(p, e.a, e.b));
    case "circle":
      return Math.abs(dist(p, e.center) - e.radius);
    case "arc":
      return Math.abs(dist(p, e.center) - e.radius);
    case "polyline":
      return Math.min(...e.points.map((q, i) => pointToSegment(p, q, e.points[(i + 1) % e.points.length])));
    default:
      return kindHitDistance(e, p);
  }
}

function pointToSegment(p: Point, a: Point, b: Point): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const l2 = dx * dx + dy * dy;
  const t = l2 > 0 ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2)) : 0;
  return dist(p, { x: a.x + dx * t, y: a.y + dy * t });
}

/** Replaces `original` with `pieces` (fresh ids, names left to the sketch code) in one undo step. */
function replaceWith(ctx: ToolContext, original: Entity, pieces: Entity[]): void {
  const commands: Command[] = [{ type: "delete-entities", ids: [original.id] }];
  for (const p of pieces) {
    const { name: _dropped, ...rest } = p;
    commands.push({ type: "add-entity", entity: { ...rest, id: newEntityId() } as Entity });
  }
  ctx.commit(commands);
}

/* ------------------------------ trim / extend ----------------------------- */

/**
 * Quick trim (AutoCAD 2021+): every visible entity is a cutting edge; click
 * the piece to remove. Shift-click near an end of a line or arc extends it
 * to the first thing in its way instead. Repeats until Esc.
 */
export class TrimTool implements Tool {
  readonly id = "trim" as const;
  private message: string | null = null;

  prompt(): string {
    return this.message ?? "Trim: click the piece to remove (everything visible cuts) — Shift-click near an end to extend it instead";
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

  pick(ctx: ToolContext, p: Pick): void {
    this.message = null;
    const target = entityAt(ctx, p.world);
    if (!target) return;
    const others = visible(ctx);
    if (p.shiftKey) {
      const extended = extendTo(target, others, p.world);
      if (!extended) {
        this.message = "Nothing in the way to extend to — Shift-click nearer the end that should grow, toward a boundary";
        return;
      }
      ctx.execute({ type: "update-entity", entity: extended });
      return;
    }
    if (target.type === "hatch") {
      // H-08: the cutters divide the hatch; the piece under the click goes, the rest stay as hatches.
      const pieces = trimHatch(target, others, p.world);
      if (!pieces) {
        this.message = "Nothing cuts this hatch here - it needs a boundary or line crossing it to be trimmed";
        return;
      }
      ctx.commit([{ type: "delete-entities", ids: [target.id] }, ...pieces.map((entity): Command => ({ type: "add-entity", entity }))]);
      return;
    }
    const result = trimAt(target, others, p.world);
    if (!result) {
      this.message = "Nothing cuts this entity here — it needs to cross something to be trimmed";
      return;
    }
    replaceWith(ctx, target, result.pieces);
  }

  preview(): Entity[] {
    return [];
  }
}

/** Split: click a point on an entity to cut it there into two (a circle opens into an arc). */
export class SplitTool implements Tool {
  readonly id = "split" as const;
  prompt(): string {
    return "Split: click the point on a line, arc, circle or polyline where it should be cut";
  }
  busy(): boolean {
    return false;
  }
  anchor(): Point | null {
    return null;
  }
  cancel(): void {}
  pick(ctx: ToolContext, p: Pick): void {
    const target = entityAt(ctx, p.world);
    if (!target) return;
    const pieces = splitAt(target, p.point);
    if (!pieces) return;
    replaceWith(ctx, target, pieces);
  }
  preview(): Entity[] {
    return [];
  }
}

/* --------------------------------- fillet -------------------------------- */

/**
 * Fillet: type the radius (remembered; 0 = corner join), then click two
 * lines — the halves you click on are the halves that stay. Clicking a
 * polyline near a vertex rounds that corner; Enter rounds every corner of
 * the selected polylines.
 */
export class FilletTool implements Tool {
  readonly id = "fillet" as const;
  radius = 0;
  private first: { entity: Entity; at: Point } | null = null;
  private message: string | null = null;

  prompt(): string {
    if (this.message) return this.message;
    const r = this.radius > 0 ? `radius ${fmt(this.radius)}` : "radius 0 (sharp corner)";
    if (this.first) return `Fillet (${r}): click the second line on the side to keep — or type a new radius`;
    return `Fillet (${r}): type a radius, then click the first line on the side to keep — or click a polyline corner (Enter rounds every corner of the selected polylines)`;
  }
  busy(): boolean {
    return this.first !== null;
  }
  anchor(): Point | null {
    return null;
  }
  cancel(): void {
    this.first = null;
    this.message = null;
  }

  typed(ctx: ToolContext, text: string): boolean {
    const r = parseLength(text, ctx.displayUnit());
    if (r === null || r < 0) return false;
    this.radius = r;
    this.message = null;
    return true;
  }

  key(ctx: ToolContext, e: KeyboardEvent): boolean {
    if (e.key !== "Enter" || e.ctrlKey || e.metaKey || e.altKey) return false;
    // Round every corner of the selected polylines.
    const targets = ctx
      .selection()
      .map((id) => ctx.doc.get(id))
      .filter((en): en is PolylineEntity => !!en && en.type === "polyline");
    if (targets.length === 0 || this.radius <= 0) {
      this.message = targets.length === 0 ? "Select a polyline first, then Enter rounds all its corners" : "Type a radius first";
      return true;
    }
    ctx.commit(targets.map((pl): Command => ({ type: "update-entity", entity: filletAllCorners(pl, this.radius) })));
    this.message = null;
    return true;
  }

  pick(ctx: ToolContext, p: Pick): void {
    this.message = null;
    const target = entityAt(ctx, p.world);
    if (!target) return;
    if (target.type === "polyline") {
      const vertex = nearestVertex(target, p.world);
      if (vertex === null) return;
      if (this.radius <= 0) {
        this.message = "Type a radius to round a polyline corner";
        return;
      }
      const rounded = filletPolylineCorner(target, vertex, this.radius);
      if (!rounded) {
        this.message = "That corner can't take this radius (leg too short, already an arc, or an open end)";
        return;
      }
      ctx.execute({ type: "update-entity", entity: rounded });
      this.first = null;
      return;
    }
    if (target.type !== "line" && target.type !== "arc" && target.type !== "circle" && target.type !== "ellipse" && target.type !== "spline") {
      this.message = "Fillet works between lines, arcs, circles, ellipses and splines, or on a polyline corner";
      return;
    }
    if (!this.first) {
      this.first = { entity: target, at: p.world };
      return;
    }
    if (this.first.entity.id === target.id) return;
    if (this.first.entity.type !== "line" || target.type !== "line") {
      const c = filletCurves(this.first.entity, target, this.radius, this.first.at, p.world);
      if (!c) {
        this.message = "Can't fillet these: no tangent circle of that radius touches both";
        this.first = null;
        return;
      }
      const cmds: Command[] = [];
      if (c.first !== this.first.entity) cmds.push({ type: "update-entity", entity: c.first });
      if (c.second !== target) cmds.push({ type: "update-entity", entity: c.second });
      if (c.arc) cmds.push({ type: "add-entity", entity: { ...c.arc, id: newEntityId() } });
      ctx.commit(cmds);
      this.first = null;
      return;
    }
    const r = filletLines(this.first.entity, target, this.radius, this.first.at, p.world);
    if (!r) {
      this.message = "Can't fillet these: parallel lines, or the radius is too large for them";
      this.first = null;
      return;
    }
    const commands: Command[] = [
      { type: "update-entity", entity: r.line1 },
      { type: "update-entity", entity: r.line2 },
    ];
    const arc = r.arc ? { ...r.arc, id: newEntityId() } : null;
    if (arc) commands.push({ type: "add-entity", entity: arc });
    // T-46: tangent + coincident (+ radius dimension) so the corner stays rounded when the lines move.
    if (associativeOn())
      for (const constraint of filletConstraints(r.line1, r.line2, arc, true)) commands.push({ type: "add-constraint", constraint });
    ctx.commit(commands);
    this.first = null;
  }

  preview(): Entity[] {
    return [];
  }
}

/** Chamfer: type the distance (one value, used on both lines), then click two lines. */
export class ChamferTool implements Tool {
  readonly id = "chamfer" as const;
  distance = 0;
  private first: { entity: LineEntity; at: Point } | null = null;
  private message: string | null = null;

  prompt(): string {
    if (this.message) return this.message;
    const d = `distance ${fmt(this.distance)}`;
    return this.first ? `Chamfer (${d}): click the second line on the side to keep` : `Chamfer (${d}): type a distance, then click the first line on the side to keep`;
  }
  busy(): boolean {
    return this.first !== null;
  }
  anchor(): Point | null {
    return null;
  }
  cancel(): void {
    this.first = null;
    this.message = null;
  }
  typed(ctx: ToolContext, text: string): boolean {
    const d = parseLength(text, ctx.displayUnit());
    if (d === null || d < 0) return false;
    this.distance = d;
    this.message = null;
    return true;
  }
  pick(ctx: ToolContext, p: Pick): void {
    this.message = null;
    const target = entityAt(ctx, p.world);
    if (!target || target.type !== "line") {
      if (target) this.message = "Chamfer works between two lines";
      return;
    }
    if (!this.first) {
      this.first = { entity: target, at: p.world };
      return;
    }
    if (this.first.entity.id === target.id) return;
    if (this.distance <= 0) {
      this.message = "Type a chamfer distance first";
      return;
    }
    const r = chamferLines(this.first.entity, target, this.distance, this.distance, this.first.at, p.world);
    if (!r || !r.chamfer) {
      this.message = "Can't chamfer these: parallel lines, or the distance is too large for them";
      this.first = null;
      return;
    }
    ctx.commit([
      { type: "update-entity", entity: r.line1 },
      { type: "update-entity", entity: r.line2 },
      { type: "add-entity", entity: { ...r.chamfer, id: newEntityId() } },
    ]);
    this.first = null;
  }
  preview(): Entity[] {
    return [];
  }
}

function nearestVertex(pl: PolylineEntity, p: Point): number | null {
  let best = -1;
  let bestD = Infinity;
  pl.points.forEach((q, i) => {
    const d = dist(q, p);
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  });
  return best >= 0 ? best : null;
}

/* --------------------------------- offset -------------------------------- */

/**
 * Offset: type the distance (remembered), click an entity, then click the
 * side the copy goes on. Repeats until Esc. The preview follows the cursor
 * so the side is obvious before committing.
 */
export class OffsetTool implements Tool {
  readonly id = "offset" as const;
  distance = 0;
  private target: Entity | null = null;
  private message: string | null = null;

  prompt(): string {
    if (this.message) return this.message;
    const d = this.distance > 0 ? `distance ${fmt(this.distance)}` : "no distance yet";
    if (this.target) return `Offset (${d}): click the side the copy goes on`;
    return `Offset (${d}): type the distance, then click the entity to offset`;
  }
  busy(): boolean {
    return this.target !== null;
  }
  anchor(): Point | null {
    return null;
  }
  cancel(): void {
    this.target = null;
    this.message = null;
  }
  typed(ctx: ToolContext, text: string): boolean {
    const d = parseLength(text, ctx.displayUnit());
    if (d === null || d <= 0) return false;
    this.distance = d;
    this.message = null;
    return true;
  }
  pick(ctx: ToolContext, p: Pick): void {
    this.message = null;
    if (!this.target) {
      if (this.distance <= 0) {
        this.message = "Type the offset distance first";
        return;
      }
      const e = entityAt(ctx, p.world);
      if (!e) return;
      if (!["line", "circle", "arc", "polyline"].includes(e.type)) {
        this.message = "Offset works on lines, arcs, circles and polylines";
        return;
      }
      this.target = e;
      return;
    }
    const copy = offsetEntity(this.target, this.distance, p.world);
    if (!copy) {
      this.message = "That offset collapses the shape — try a smaller distance or the other side";
      this.target = null;
      return;
    }
    const { name: _dropped, ...rest } = copy;
    const added = { ...rest, id: newEntityId() } as Entity;
    const offsetCmds: Command[] = [{ type: "add-entity", entity: added }];
    if (associativeOn())
      for (const constraint of offsetConstraints(this.target, added)) offsetCmds.push({ type: "add-constraint", constraint });
    ctx.commit(offsetCmds);
    this.target = null;
  }
  preview(_ctx: ToolContext, cursor: Point | null): Entity[] {
    if (!this.target || !cursor) return [];
    const copy = offsetEntity(this.target, this.distance, cursor);
    return copy ? [{ ...copy, id: "preview" }] : [];
  }
}

/* ------------------------------ zoom window ------------------------------ */

/** Zoom window (T-29): two corners, then back to the select tool. */
export class ZoomWindowTool implements Tool {
  readonly id = "zoom" as const;
  private first: Point | null = null;
  prompt(): string {
    return this.first ? "Specify the opposite corner of the area to zoom into" : "Zoom window: specify the first corner";
  }
  busy(): boolean {
    return this.first !== null;
  }
  anchor(): Point | null {
    return null;
  }
  cancel(): void {
    this.first = null;
  }
  pick(ctx: ToolContext, p: Pick): void {
    if (!this.first) {
      this.first = p.world;
      return;
    }
    const a = this.first;
    const b = p.world;
    this.first = null;
    if (Math.abs(a.x - b.x) < 1e-9 || Math.abs(a.y - b.y) < 1e-9) return;
    ctx.zoomTo(Math.min(a.x, b.x), Math.min(a.y, b.y), Math.max(a.x, b.x), Math.max(a.y, b.y));
    ctx.setTool("select");
  }
  preview(_ctx: ToolContext, cursor: Point | null): Entity[] {
    if (!this.first || !cursor) return [];
    const a = this.first;
    return [{ id: "preview", type: "polyline", points: [a, { x: cursor.x, y: a.y }, cursor, { x: a.x, y: cursor.y }], closed: true }];
  }
}

/* --------------------------------- divide -------------------------------- */

/**
 * Divide / measure (T-19): type how many equal parts (a plain integer) or a
 * spacing (a length with a unit, or a decimal), then click the entity;
 * point entities mark the divisions, on the entity's layer.
 */
export class DivideTool implements Tool {
  readonly id = "divide" as const;
  private divisions = 2;
  private spacing = 0;
  private message: string | null = null;
  prompt(): string {
    if (this.message) return this.message;
    const how = this.spacing > 0 ? `every ${fmt(this.spacing)}` : `${this.divisions} equal parts`;
    return `Divide (${how}): type a count or a spacing, then click a line, arc, circle or polyline`;
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
    const t = text.trim();
    if (/^\d+$/.test(t)) {
      const n = Number(t);
      if (n < 2 || n > 10000) return false;
      this.divisions = n;
      this.spacing = 0;
      return true;
    }
    const d = parseLength(t, ctx.displayUnit());
    if (d === null || d <= 0) return false;
    this.spacing = d;
    return true;
  }
  pick(ctx: ToolContext, p: Pick): void {
    this.message = null;
    const target = entityAt(ctx, p.world);
    if (!target) return;
    const points = pointsAlong(target, this.spacing > 0 ? { spacing: this.spacing } : { divisions: this.divisions });
    if (points.length === 0) {
      this.message = "Nothing to divide here";
      return;
    }
    const layer = target.layer !== undefined ? { layer: target.layer } : {};
    ctx.commit(points.map((pt): Command => ({ type: "add-entity", entity: { id: newEntityId(), type: "point", ...layer, p: pt } })));
  }
  preview(): Entity[] {
    return [];
  }
}

/* ---------------------------------- align --------------------------------- */

/**
 * Align (T-24): with a selection, pick two source points and two target
 * points; the selection is moved and rotated so the first pair coincide
 * and the second source point lies toward the second target. Ctrl-click
 * the last point to scale as well, so both pairs coincide exactly.
 */
export class AlignTool implements Tool {
  readonly id = "align" as const;
  private picks: Point[] = [];

  prompt(ctx: ToolContext): string {
    if (ctx.selection().length === 0) return "Align: select what to align first (click an object)";
    const n = this.picks.length;
    return [
      "Align: specify the first source point (on the selection)",
      "Specify its destination",
      "Specify the second source point",
      "Specify its destination (Ctrl-click to scale so both pairs match exactly)",
    ][n];
  }
  busy(): boolean {
    return this.picks.length > 0;
  }
  anchor(): Point | null {
    // Destination picks measure from their source point (typed @dx,dy moves it by that).
    return this.picks.length % 2 === 1 ? this.picks[this.picks.length - 1] : null;
  }
  cancel(): void {
    this.picks = [];
  }
  pick(ctx: ToolContext, p: Pick): void {
    if (ctx.selection().length === 0) {
      const hit = ctx.hitTest(p.world);
      if (hit.length > 0) ctx.setSelection(hit);
      return;
    }
    this.picks.push(p.point);
    if (this.picks.length < 4) return;
    const [s1, t1, s2, t2] = this.picks;
    const t = alignTransform(s1, s2, t1, t2, p.ctrlKey);
    this.picks = [];
    if (!t) return;
    ctx.execute({ type: "transform-entities", ids: ctx.selection(), pivot: t.pivot, dx: t.dx, dy: t.dy, rotation: t.rotation, scale: t.scale });
  }
  preview(ctx: ToolContext, cursor: Point | null): Entity[] {
    if (!cursor || this.picks.length === 0) return [];
    const guide = (a: Point, b: Point): Entity => ({ id: "preview-guide", type: "line", a, b });
    const [s1, t1, s2] = this.picks;
    if (this.picks.length === 1) return [guide(s1, cursor)];
    if (this.picks.length === 2) return [guide(s1, t1)];
    if (this.picks.length === 3) {
      const t = alignTransform(s1, s2, t1, cursor, false);
      if (!t) return [guide(s1, t1), guide(s2, cursor)];
      const ids = new Set(ctx.selection());
      return [guide(s1, t1), guide(s2, cursor), ...ctx.doc.all().filter((e) => ids.has(e.id)).map((e) => transformed(e, t.pivot, t.dx, t.dy, t.rotation, t.scale))];
    }
    return [];
  }
}

/* -------------------------------- lengthen -------------------------------- */

/**
 * Lengthen (T-23): type how much — `+5` / `-5` (delta), `40` (new total
 * length), `150%` — then click a line or arc near the end to change.
 */
export class LengthenTool implements Tool {
  readonly id = "lengthen" as const;
  private mode: { kind: "delta" | "total" | "percent"; value: number } = { kind: "delta", value: 10 };
  private message: string | null = null;

  prompt(): string {
    if (this.message) return this.message;
    const m = this.mode;
    const how = m.kind === "percent" ? `to ${m.value}%` : m.kind === "total" ? `to ${fmt(m.value)} total` : `by ${m.value >= 0 ? "+" : ""}${fmt(m.value)}`;
    return `Lengthen (${how}): type +delta, -delta, a total length or a percentage, then click a line or arc near the end to change`;
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
    const t = text.trim();
    if (t.endsWith("%")) {
      const v = Number(t.slice(0, -1));
      if (!Number.isFinite(v) || v <= 0) return false;
      this.mode = { kind: "percent", value: v };
      return true;
    }
    const signed = t.startsWith("+") || t.startsWith("-");
    const v = parseLength(signed ? t.slice(1) : t, ctx.displayUnit());
    if (v === null || v <= 0) return false;
    this.mode = signed ? { kind: "delta", value: t.startsWith("-") ? -v : v } : { kind: "total", value: v };
    this.message = null;
    return true;
  }
  pick(ctx: ToolContext, p: Pick): void {
    this.message = null;
    const target = entityAt(ctx, p.world);
    if (!target) return;
    const out = lengthen(target, this.mode, p.world);
    if (!out) {
      this.message = "Can't lengthen that: closed shape, or the change would remove it entirely";
      return;
    }
    ctx.execute({ type: "update-entity", entity: out });
  }
  preview(): Entity[] {
    return [];
  }
}

/* --------------------------------- stretch -------------------------------- */

/**
 * Stretch (T-18): two corners of a crossing box, then a base point and a
 * destination (or a typed @dx,dy). Every defining point inside the box
 * moves; the rest stay — the two-click "make this bracket 20 longer".
 */
export class StretchTool implements Tool {
  readonly id = "stretch" as const;
  private picks: Point[] = [];

  prompt(): string {
    return [
      "Stretch: specify the first corner of the crossing box (around the ends to move)",
      "Specify the opposite corner",
      "Specify the base point",
      "Specify the destination — or type @dx,dy / a distance",
    ][this.picks.length];
  }
  busy(): boolean {
    return this.picks.length > 0;
  }
  anchor(): Point | null {
    return this.picks.length === 3 ? this.picks[2] : null;
  }
  cancel(): void {
    this.picks = [];
  }
  pick(ctx: ToolContext, p: Pick): void {
    if (this.picks.length < 2) {
      this.picks.push(p.world);
      return;
    }
    this.picks.push(p.point);
    if (this.picks.length < 4) return;
    const [c1, c2, base, to] = this.picks;
    this.picks = [];
    const dx = to.x - base.x;
    const dy = to.y - base.y;
    if (dx === 0 && dy === 0) return;
    const changed = stretchEntities(visible(ctx), this.box(c1, c2), dx, dy);
    if (changed.length === 0) return;
    ctx.commit(changed.map((entity): Command => ({ type: "update-entity", entity })));
  }
  preview(ctx: ToolContext, cursor: Point | null): Entity[] {
    if (!cursor || this.picks.length === 0) return [];
    const [c1, c2, base] = this.picks;
    if (this.picks.length === 1) return [rectPreview(c1, cursor)];
    const box = rectPreview(c1, c2);
    if (this.picks.length === 2) return [box];
    const dx = cursor.x - base.x;
    const dy = cursor.y - base.y;
    return [box, ...stretchEntities(visible(ctx), this.box(c1, c2), dx, dy).map((e) => ({ ...e, id: `preview-${e.id}` }))];
  }
  private box(a: Point, b: Point) {
    return { minX: Math.min(a.x, b.x), minY: Math.min(a.y, b.y), maxX: Math.max(a.x, b.x), maxY: Math.max(a.y, b.y) };
  }
}

function rectPreview(a: Point, b: Point): Entity {
  return { id: "preview-box", type: "polyline", points: [a, { x: b.x, y: a.y }, b, { x: a.x, y: b.y }], closed: true };
}

/* ----------------------------- match properties ---------------------------- */

/** Match properties (T-26): click a source entity, then every entity that should take its layer, colour and construction flag. */
export class MatchTool implements Tool {
  readonly id = "match" as const;
  private source: Entity | null = null;

  prompt(): string {
    return this.source
      ? `Match: click the entities that should take ${describeProps(this.source)} (Esc when done)`
      : "Match properties: click the source entity";
  }
  busy(): boolean {
    return this.source !== null;
  }
  anchor(): Point | null {
    return null;
  }
  cancel(): void {
    this.source = null;
  }
  pick(ctx: ToolContext, p: Pick): void {
    const target = entityAt(ctx, p.world);
    if (!target) return;
    if (!this.source) {
      this.source = target;
      return;
    }
    if (target.id === this.source.id) return;
    const next = { ...target } as unknown as Record<string, unknown>;
    for (const key of ["layer", "color", "linetype", "lineweight", "construction"] as const) {
      const v = (this.source as unknown as Record<string, unknown>)[key];
      if (v === undefined) delete next[key];
      else next[key] = v;
    }
    ctx.execute({ type: "update-entity", entity: next as unknown as Entity });
  }
  preview(): Entity[] {
    return [];
  }
}

function describeProps(e: Entity): string {
  const parts = [`layer ${layerOf(e)}`];
  if (e.color) parts.push(`colour ${e.color}`);
  if (e.linetype) parts.push(`linetype ${e.linetype}`);
  if (e.construction) parts.push("construction");
  return parts.join(", ");
}

function fmt(v: number): string {
  return Number.isInteger(v) ? String(v) : v.toFixed(3).replace(/0+$/, "").replace(/\.$/, "");
}
