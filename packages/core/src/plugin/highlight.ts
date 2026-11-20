import type { Point } from "../geometry";

/** One canvas marker a plugin puts on the drawing through `ui.highlight` (NF-03b): a ringed point in world units (mm), optionally labelled. */
export interface HighlightMark {
  at: Point;
  /** Short text beside the marker; the host keeps the first {@link MAX_HIGHLIGHT_LABEL} characters. */
  label?: string;
}

export const MAX_HIGHLIGHT_MARKS = 500;
export const MAX_HIGHLIGHT_LABEL = 40;

/**
 * What the host accepts from a plugin's `ui.highlight(marks)`. Plugin input is
 * untrusted: anything that isn't a finite point (within the ±1e9 every importer
 * also filters to) is dropped, a label must already be a string and is
 * stripped of control characters, trimmed and capped, and at most
 * {@link MAX_HIGHLIGHT_MARKS} survive. Anything but an array means "clear".
 */
export function sanitizeHighlightMarks(value: unknown): HighlightMark[] {
  if (!Array.isArray(value)) return [];
  const out: HighlightMark[] = [];
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
    out.push(label ? { at: { x, y }, label } : { at: { x, y } });
  }
  return out;
}
