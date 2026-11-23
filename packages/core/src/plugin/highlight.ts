import type { Point } from "../geometry";

/** One canvas marker a plugin puts on the drawing through `ui.highlight` (NF-03b): a ringed point in world units (mm), optionally labelled. */
export interface HighlightMark {
  at: Point;
  /** Short text beside the marker; the host keeps the first {@link MAX_HIGHLIGHT_LABEL} characters. */
  label?: string;
  /**
   * A closed outline (world mm) drawn tinted over the drawing instead of the
   * ringed point - e.g. a nested part that overlaps another one. At most
   * {@link MAX_HIGHLIGHT_OUTLINE_POINTS} points; fewer than 3 valid points drops it.
   */
  outline?: Point[];
  /** Colour of the mark: "error" (red, the default for an outline) or "warn" (orange). A plain point keeps the host's marker colour. */
  tone?: "error" | "warn";
}

export const MAX_HIGHLIGHT_MARKS = 500;
export const MAX_HIGHLIGHT_LABEL = 40;
export const MAX_HIGHLIGHT_OUTLINE_POINTS = 2000;
/** Across all marks of one call, so a plugin cannot hand the renderer millions of vertices. */
export const MAX_HIGHLIGHT_TOTAL_POINTS = 50000;

const finitePoint = (v: unknown): v is Point => {
  if (!v || typeof v !== "object") return false;
  const { x, y } = v as { x?: unknown; y?: unknown };
  return typeof x === "number" && typeof y === "number" && Number.isFinite(x) && Number.isFinite(y) && Math.abs(x) <= 1e9 && Math.abs(y) <= 1e9;
};

/**
 * What the host accepts from a plugin's `ui.highlight(marks)`. Plugin input is
 * untrusted: anything that isn't a finite point (within the ±1e9 every importer
 * also filters to) is dropped, a label must already be a string and is
 * stripped of control characters, trimmed and capped, and at most
 * {@link MAX_HIGHLIGHT_MARKS} survive. An outline keeps only its finite
 * points, capped per mark and across the call. Anything but an array means "clear".
 */
export function sanitizeHighlightMarks(value: unknown): HighlightMark[] {
  if (!Array.isArray(value)) return [];
  const out: HighlightMark[] = [];
  let budget = MAX_HIGHLIGHT_TOTAL_POINTS;
  for (const m of value) {
    if (out.length >= MAX_HIGHLIGHT_MARKS) break;
    if (!m || typeof m !== "object") continue;
    const at = (m as { at?: unknown }).at;
    if (!at || typeof at !== "object") continue;
    const { x, y } = at as { x?: unknown; y?: unknown };
    if (typeof x !== "number" || typeof y !== "number" || !Number.isFinite(x) || !Number.isFinite(y) || Math.abs(x) > 1e9 || Math.abs(y) > 1e9) continue;
    const raw = (m as { label?: unknown }).label;
    // eslint-disable-next-line no-control-regex
    const label = typeof raw === "string" ? raw.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, MAX_HIGHLIGHT_LABEL) : "";
    const mark: HighlightMark = label ? { at: { x, y }, label } : { at: { x, y } };
    const rawOutline = (m as { outline?: unknown }).outline;
    if (Array.isArray(rawOutline)) {
      const pts = rawOutline.slice(0, MAX_HIGHLIGHT_OUTLINE_POINTS).filter(finitePoint).map((p) => ({ x: p.x, y: p.y }));
      if (pts.length >= 3 && pts.length <= budget) {
        mark.outline = pts;
        budget -= pts.length;
      }
    }
    const tone = (m as { tone?: unknown }).tone;
    if (tone === "error" || tone === "warn") mark.tone = tone;
    out.push(mark);
  }
  return out;
}
