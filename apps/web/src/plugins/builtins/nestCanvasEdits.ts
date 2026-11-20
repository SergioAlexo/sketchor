import { entityPoints, textWidth, translated, type Entity } from "@sketchor/core";
import type { LastNestPlacement } from "./nestReport";

/**
 * NF-08: the nest as it is on the canvas now. After nesting, the layout tab
 * is an ordinary drawing - the user can enter a sheet's group and drag or
 * rotate a part to make room, nudge it off a clamp, or move the whole sheet.
 * The report, DXF and G-code were built from the nest result, so they kept
 * printing and cutting the parts where the nester put them, not where the
 * user can see them.
 *
 * Every part on the canvas carries its placement's own entity ids
 * (`buildSideBySideLayout` translates them, which keeps the id), so a read of
 * the drawing finds them. Each part is taken back to sheet-local coordinates
 * relative to its sheet's outline - so dragging a whole sheet changes nothing
 * - and replaces the placement's geometry when it differs. Identical sheets
 * are drawn once ("Sheets 2-4"); an edit to that drawing applies to every
 * sheet of the group, matched by the placement's part / rotation / position,
 * which is what made the sheets identical. A part deleted from the canvas, or
 * a tab that is not the nest layout, leaves the placement as nested.
 */

export interface LayoutSheetRef {
  /** Index of the sheet drawn for this group (the group's first). */
  sheet: number;
  /** All the sheets the drawing stands for (identical sheets share one drawing). */
  indices: number[];
  outlineId: string;
  /** Where the outline's lower-left corner was put on the canvas. */
  origin: { x: number; y: number };
}

export interface CanvasEditResult {
  placements: LastNestPlacement[];
  /** Placements whose geometry changed (counting each sheet of a group). */
  moved: number;
  /** False when no sheet outline of this nest is in the drawing - another tab is active, or the layout was deleted. */
  found: boolean;
}

const EPS = 1e-6;

function minCorner(entities: readonly Entity[]): { x: number; y: number } | null {
  let x = Infinity, y = Infinity;
  for (const e of entities) for (const p of entityPoints(e)) {
    if (p.x < x) x = p.x;
    if (p.y < y) y = p.y;
  }
  return Number.isFinite(x) && Number.isFinite(y) ? { x, y } : null;
}

function samePoints(a: readonly Entity[], b: readonly Entity[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const pa = entityPoints(a[i]!), pb = entityPoints(b[i]!);
    if (pa.length !== pb.length) return false;
    for (let j = 0; j < pa.length; j++) if (Math.abs(pa[j]!.x - pb[j]!.x) > EPS || Math.abs(pa[j]!.y - pb[j]!.y) > EPS) return false;
  }
  return true;
}

/**
 * `keyOf` names a placement by what makes two sheets identical (part,
 * rotation, mirror, position on the sheet), so an edit to a group's drawing
 * reaches the same part on its other sheets.
 */
export function applyCanvasEdits(
  placements: readonly LastNestPlacement[],
  refs: readonly LayoutSheetRef[],
  doc: ReadonlyMap<string, Entity>,
  keyOf: (p: LastNestPlacement) => string,
): CanvasEditResult {
  let found = false;
  /** Per drawn sheet: placement key -> its geometry as on the canvas, sheet-local. */
  const editsBySheet = new Map<number, Map<string, { outer: Entity[]; holes: Entity[] }>>();
  const groupOf = new Map<number, number>();
  for (const ref of refs) {
    for (const i of ref.indices) groupOf.set(i, ref.sheet);
    const outline = doc.get(ref.outlineId);
    const now = outline ? minCorner([outline]) : null;
    if (!now) continue;
    found = true;
    // The outline's lower-left corner is (0,0) in sheet coordinates, wherever the sheet now sits on the canvas.
    const dx = -now.x, dy = -now.y;
    const edits = new Map<string, { outer: Entity[]; holes: Entity[] }>();
    for (const p of placements) {
      if (p.sheet !== ref.sheet) continue;
      const outer = p.outerEntities.map((e) => doc.get(e.id));
      const holes = p.holeEntities.map((e) => doc.get(e.id));
      if (outer.some((e) => !e) || holes.some((e) => !e)) continue; // deleted on the canvas: keep as nested
      const local = (list: (Entity | undefined)[], like: readonly Entity[]) => list.map((e, i) => ({ ...translated(e!, dx, dy), layer: like[i]!.layer }));
      const o = local(outer, p.outerEntities), h = local(holes, p.holeEntities);
      if (samePoints(o, p.outerEntities) && samePoints(h, p.holeEntities)) continue;
      edits.set(keyOf(p), { outer: o, holes: h });
    }
    editsBySheet.set(ref.sheet, edits);
  }

  let moved = 0;
  const out = placements.map((p) => {
    const drawn = groupOf.get(p.sheet);
    const edit = drawn === undefined ? undefined : editsBySheet.get(drawn)?.get(keyOf(p));
    if (!edit) return p;
    moved++;
    const pts = edit.outer.flatMap((e) => entityPoints(e));
    const xs = pts.map((q) => q.x), ys = pts.map((q) => q.y);
    const cx = (Math.min(...xs) + Math.max(...xs)) / 2, cy = (Math.min(...ys) + Math.max(...ys)) / 2;
    const h = p.label.height;
    return {
      ...p,
      // Each sheet keeps its own entity ids: the drawn sheet's are shared by the group, and one DXF of all sheets must not repeat a handle.
      outerEntities: edit.outer.map((e, i) => ({ ...e, id: p.outerEntities[i]?.id ?? `${e.id}-${p.id}` })),
      holeEntities: edit.holes.map((e, i) => ({ ...e, id: p.holeEntities[i]?.id ?? `${e.id}-${p.id}` })),
      label: { at: { x: cx - textWidth(String(p.number), h) / 2, y: cy - h / 2 }, height: h },
    };
  });
  return { placements: out, moved, found };
}
