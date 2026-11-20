/**
 * Z-04: named linetypes — DXF's `LTYPE` table, authored clean-room from the
 * ISO 128 line-type descriptions (long dash / short dash / dot proportions),
 * not copied from any vendor's `.lin` file. `pattern` is in millimetres at
 * `$LTSCALE` = 1, alternating dash (positive, pen down) and gap (negative,
 * pen up) — the DXF group-49 convention — with `0` standing for a dot (DXF
 * draws a dot as a zero-length dash). `[]` means solid/continuous.
 *
 * Only these nine ship built in; anything else (a `.lin` import — not yet
 * built, see the roadmap) becomes a record in the document's `linetypes`
 * table instead of a entry here.
 */
export interface LinetypePattern {
  name: string;
  description: string;
  pattern: readonly number[];
}

export const CONTINUOUS = "CONTINUOUS";

export const BUILTIN_LINETYPES: Readonly<Record<string, LinetypePattern>> = {
  CONTINUOUS: { name: "CONTINUOUS", description: "Solid line", pattern: [] },
  DASHED: { name: "DASHED", description: "Dashed", pattern: [6, -3] },
  HIDDEN: { name: "HIDDEN", description: "Hidden (short dashes)", pattern: [3, -1.5] },
  CENTER: { name: "CENTER", description: "Center (long, short)", pattern: [12, -3, 3, -3] },
  PHANTOM: { name: "PHANTOM", description: "Phantom (long, short, short)", pattern: [12, -3, 3, -3, 3, -3] },
  DOT: { name: "DOT", description: "Dot", pattern: [0, -3] },
  DASHDOT: { name: "DASHDOT", description: "Dash dot", pattern: [6, -3, 0, -3] },
  BORDER: { name: "BORDER", description: "Border (long, short, short)", pattern: [6, -3, 1.5, -3, 1.5, -3] },
  DIVIDE: { name: "DIVIDE", description: "Divide (long, dot, dot)", pattern: [12, -3, 0, -3, 0, -3] },
};

/** `name`'s pattern, falling back to CONTINUOUS for an unknown or absent (BYLAYER-not-yet-resolved) name — never throws on a custom/imported linetype it doesn't recognise. */
export function builtinLinetype(name: string | undefined): LinetypePattern {
  if (!name) return BUILTIN_LINETYPES[CONTINUOUS];
  return BUILTIN_LINETYPES[name] ?? BUILTIN_LINETYPES[CONTINUOUS];
}

/**
 * A world-space pattern (mm, see {@link LinetypePattern}) → `CanvasRenderingContext2D.setLineDash`
 * segments in **screen pixels**, honoring `$LTSCALE` and the current zoom.
 * `[]` (solid) both for a genuinely continuous linetype and as an LOD
 * fallback: once `$LTSCALE` and zoom have shrunk the pattern's period under
 * a few pixels, drawing it dashed would just be antialiasing noise, not a
 * readable dash — draw it solid instead, same as DXF viewers do.
 *
 * @param pxPerWorldUnit Screen pixels per world (mm) unit — a viewport's zoom.
 */
export function screenDashPattern(pattern: readonly number[], ltscale: number, pxPerWorldUnit: number): number[] {
  if (pattern.length === 0) return [];
  const factor = Math.max(ltscale, 1e-6) * pxPerWorldUnit;
  const px = pattern.map((v) => Math.max(Math.abs(v) * factor, v === 0 ? 1.5 : 0.5));
  const period = px.reduce((a, b) => a + b, 0);
  return period < 6 ? [] : px;
}

/** The scale a pattern is drawn at: the drawing's `$LTSCALE` times the entity's own `linetypeScale` (a missing, non-finite or non-positive one counts as 1, as AutoCAD reads group 48). */
export function effectiveLtscale(drawingLtscale: number, entity: { linetypeScale?: number }): number {
  const own = entity.linetypeScale;
  return drawingLtscale * (typeof own === "number" && Number.isFinite(own) && own > 0 ? own : 1);
}
