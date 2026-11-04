import type { Entity } from "../entities";
import type { Command } from "../commands";
import type { SketchDocument } from "../document";
import type { DocSettings } from "../tables";
import { parseScale } from "../layouts/viewport";

/**
 * D-08: annotative scaling. An annotative entity stores its *paper* size; seen at annotation scale `1:50`
 * (50 model units per paper unit) it is drawn 50 times larger. This module is the pure part: parsing scale
 * names, deciding what an entity looks like (or whether it shows) at a scale, and the edits that mark entities
 * annotative or add a scale. The renderer and the PDF plotter both call {@link annotatedFor}, so the canvas,
 * the viewport and the printed sheet agree.
 */

export const DEFAULT_ANNOTATION_SCALE = "1:1";

/** The list a new drawing offers (architectural forms included). */
export const DEFAULT_ANNOTATION_SCALES: readonly string[] = [
  "1:1", "1:2", "1:5", "1:10", "1:20", "1:25", "1:50", "1:100", "1:200", "1:500", "1:1000",
  "2:1", "5:1", "10:1",
  '1"=1\'-0"', '1/2"=1\'-0"', '1/4"=1\'-0"', '1/8"=1\'-0"',
];

/** The drawing's scale list: `settings.annotationScales` when set and non-empty, else the defaults. */
export function annotationScaleList(settings: DocSettings): string[] {
  const l = settings.annotationScales;
  const names = Array.isArray(l) ? l.filter((s): s is string => typeof s === "string") : [];
  return names.length > 0 ? names : [...DEFAULT_ANNOTATION_SCALES];
}

function num(text: string): number {
  const m = /^(\d+(?:\.\d+)?)\/(\d+(?:\.\d+)?)$/.exec(text);
  return m ? parseFloat(m[1]) / parseFloat(m[2]) : parseFloat(text);
}

/**
 * Paper units per model unit for a scale name: `1:50` -> 0.02, `2:1` -> 2, `1/4"=1'-0"` -> 1/48.
 * null when the text is not a scale.
 */
export function parseAnnotationScale(name: string): number | null {
  const plain = parseScale(name);
  if (plain !== null) return plain;
  const m = /^\s*(\d+(?:\.\d+)?(?:\/\d+(?:\.\d+)?)?)\s*"\s*=\s*(\d+(?:\.\d+)?)\s*'\s*(?:-?\s*(\d+(?:\.\d+)?)\s*")?\s*$/.exec(name);
  if (!m) return null;
  const paperIn = num(m[1]);
  const modelIn = parseFloat(m[2]) * 12 + (m[3] ? parseFloat(m[3]) : 0);
  return paperIn > 0 && modelIn > 0 ? paperIn / modelIn : null;
}

/** Model units per paper unit (the multiplier an annotative size gets); 1 for an unparsable name. */
export function annotationFactor(name: string | undefined): number {
  if (!name) return 1;
  const s = parseAnnotationScale(name);
  return s && s > 0 ? 1 / s : 1;
}

/** True when two names mean the same ratio (`1:50` and `1 : 50.0`), or are the same text. */
export function sameAnnotationScale(a: string, b: string): boolean {
  if (a === b) return true;
  const x = parseAnnotationScale(a);
  const y = parseAnnotationScale(b);
  return x !== null && y !== null && Math.abs(x - y) <= 1e-9 * Math.max(x, y);
}

/** The scale in force in model space. */
export function currentAnnotationScale(settings: DocSettings): string {
  return typeof settings.annotationScale === "string" && settings.annotationScale ? settings.annotationScale : DEFAULT_ANNOTATION_SCALE;
}

type Annotatable = Extract<Entity, { type: "text" | "mtext" | "hatch" | "insert" | "dimension" }>;

export function canBeAnnotative(e: Entity): e is Annotatable {
  return e.type === "text" || e.type === "mtext" || e.type === "hatch" || e.type === "insert" || e.type === "dimension";
}

export function isAnnotative(e: Entity): boolean {
  return canBeAnnotative(e) && e.annotative === true;
}

/** Does `e` support `scale`? A non-annotative entity, or one with no scale list, supports every scale. */
export function supportsScale(e: Entity, scale: string): boolean {
  if (!isAnnotative(e)) return true;
  const l = (e as Annotatable).annoScales;
  return !l || l.length === 0 || l.some((s) => sameAnnotationScale(s, scale));
}

/** The entity grown by `factor` (model units per paper unit) about its own anchor. Entities that cannot be annotative come back unchanged. */
export function scaledForAnnotation<T extends Entity>(e: T, factor: number): T {
  if (!(factor > 0) || !Number.isFinite(factor) || factor === 1) return e;
  const x = e as Entity;
  switch (x.type) {
    case "text":
      return { ...x, height: x.height * factor } as T;
    case "mtext":
      return { ...x, height: x.height * factor, width: x.width * factor } as T;
    case "hatch":
      return x.paint.kind === "pattern" ? ({ ...x, paint: { ...x.paint, scale: x.paint.scale * factor } } as T) : e;
    case "insert":
      return { ...x, scale: { x: x.scale.x * factor, y: x.scale.y * factor } } as T;
    case "dimension":
      return { ...x, scale: (x.scale && x.scale > 0 ? x.scale : 1) * factor } as T;
    default:
      return e;
  }
}

export interface AnnotatedForOptions {
  /** AutoCAD ANNOALLVISIBLE: show an object at its first supported scale even when the view's scale is not in its list (default: hide it). */
  allVisible?: boolean;
}

/**
 * What `e` looks like at annotation scale `scale`: the entity itself when it is not annotative, a resized copy
 * when it is, `null` when it does not support the scale (and `allVisible` is off).
 */
export function annotatedFor(e: Entity, scale: string, opts: AnnotatedForOptions = {}): Entity | null {
  if (!isAnnotative(e)) return e;
  if (supportsScale(e, scale)) return scaledForAnnotation(e, annotationFactor(scale));
  if (!opts.allVisible) return null;
  const own = (e as Annotatable).annoScales?.[0];
  return scaledForAnnotation(e, annotationFactor(own));
}

/** The annotation scale a viewport shows: its own name, else the name of its paper/model ratio. */
export function viewportAnnotationScale(vp: { annotationScale?: string; scale: number }): string {
  if (vp.annotationScale && parseAnnotationScale(vp.annotationScale) !== null) return vp.annotationScale;
  const s = vp.scale > 0 ? vp.scale : 1;
  const r = (n: number) => String(Math.round(n * 1000) / 1000);
  return s >= 1 ? `${r(s)}:1` : `1:${r(1 / s)}`;
}

/* --------------------------------- edits (pure) -------------------------------- */

/** Marks `e` annotative at `scale` (or clears the flag and its scale list). Entities that cannot be annotative come back unchanged. */
export function withAnnotative(e: Entity, on: boolean, scale: string): Entity {
  if (!canBeAnnotative(e)) return e;
  if (!on) {
    const { annotative, annoScales, ...rest } = e;
    void annotative;
    void annoScales;
    return rest as Entity;
  }
  return { ...e, annotative: true, annoScales: e.annoScales && e.annoScales.length > 0 ? e.annoScales : [scale] } as Entity;
}

/** "Add current scale": `e` also supports `scale`. Null when nothing would change (not annotative, or already supported). */
export function withScaleAdded(e: Entity, scale: string): Entity | null {
  if (!isAnnotative(e)) return null;
  const l = (e as Annotatable).annoScales;
  if (!l || l.length === 0) return null; // already every scale
  if (l.some((s) => sameAnnotationScale(s, scale))) return null;
  return { ...e, annoScales: [...l, scale] } as Entity;
}

/** The reverse: drops `scale` from the list. The last scale cannot be removed (the object would vanish everywhere); null then, and when it was not listed. */
export function withScaleRemoved(e: Entity, scale: string): Entity | null {
  if (!isAnnotative(e)) return null;
  const l = (e as Annotatable).annoScales;
  if (!l || l.length <= 1) return null;
  const rest = l.filter((s) => !sameAnnotationScale(s, scale));
  return rest.length === l.length || rest.length === 0 ? null : ({ ...e, annoScales: rest } as Entity);
}

function batch(commands: Command[]): Command[] {
  return commands.length ? [{ type: "batch", commands }] : [];
}

/** Command: set the flag on these entities (one undo step). */
export function setAnnotativeCommands(doc: SketchDocument, ids: readonly string[], on: boolean, scale: string = currentAnnotationScale(doc.settings)): Command[] {
  const out: Command[] = [];
  for (const id of ids) {
    const e = doc.get(id);
    if (!e || !canBeAnnotative(e) || isAnnotative(e) === on) continue;
    out.push({ type: "update-entity", entity: withAnnotative(e, on, scale) });
  }
  return batch(out);
}

/** Command: add `scale` to each selected annotative entity (one undo step). */
export function addScaleCommands(doc: SketchDocument, ids: readonly string[], scale: string = currentAnnotationScale(doc.settings)): Command[] {
  const out: Command[] = [];
  for (const id of ids) {
    const e = doc.get(id);
    const next = e && withScaleAdded(e, scale);
    if (next) out.push({ type: "update-entity", entity: next });
  }
  return batch(out);
}

/** Command: remove `scale` from each selected annotative entity. */
export function removeScaleCommands(doc: SketchDocument, ids: readonly string[], scale: string = currentAnnotationScale(doc.settings)): Command[] {
  const out: Command[] = [];
  for (const id of ids) {
    const e = doc.get(id);
    const next = e && withScaleRemoved(e, scale);
    if (next) out.push({ type: "update-entity", entity: next });
  }
  return batch(out);
}

/** Command: set the model-space annotation scale, adding it to the drawing's list when new. Refused (empty) for an unparsable name. */
export function setAnnotationScaleCommands(doc: SketchDocument, scale: string): Command[] {
  if (parseAnnotationScale(scale) === null) return [];
  const list = annotationScaleList(doc.settings);
  const patch: DocSettings = { annotationScale: scale };
  if (!list.some((s) => sameAnnotationScale(s, scale))) patch.annotationScales = [...list, scale];
  return [{ type: "set-settings", patch }];
}
