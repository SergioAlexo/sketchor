/**
 * L-09: a sheet-template plugin bundle - manifest plus the `.dxf` / `.sketchor` files it names, no code. A template
 * file is an ordinary drawing that has at least one layout (paper size, title block, viewports...). Like theme, pattern
 * and block bundles it is data (parsed, never executed), so it installs without a signature. `planFromTemplate` turns
 * one into commands for a document: the layouts, their paper-space entities with fresh ids, and any block the sheet
 * uses that the drawing lacks - one undo step.
 */
import type { Command } from "../commands";
import { SketchDocument } from "../document";
import { parseDxf } from "../dxf";
import { newEntityId, type Entity, type ViewportEntity } from "../entities";
import type { BlockDefinition } from "../blocks/types";
import { LAYOUTS_TABLE, layoutEntities, layoutList, modelEntities, spaceOf, type LayoutRecord } from "../layouts/types";
import { modelFrameBounds } from "../layouts/fromModel";
import { fitViewportView } from "../layouts/viewport";
import { isLayoutTemplatesOnly, validateManifest, type PluginManifest } from "./manifest";

export interface LayoutTemplateBundle {
  /** Raw `manifest.json` text. */
  manifest: string;
  /** File text keyed by the bundle-relative path the manifest names. */
  templates: Record<string, string>;
}

/** A parsed template: the layouts of its file, what is drawn on them, and the blocks they use. */
export interface LayoutTemplate {
  title: string;
  file: string;
  layouts: LayoutRecord[];
  /** Paper-space entities of every layout (`space` = that layout's name). */
  entities: Entity[];
  blocks: BlockDefinition[];
}

export type LayoutTemplateBundleResult =
  | { ok: true; manifest: PluginManifest; templates: LayoutTemplate[]; warnings: string[] }
  | { ok: false; errors: string[] };

const MAX_FILE_BYTES = 4 * 1024 * 1024;
const MAX_FILES = 16;
const MAX_LAYOUTS = 12;

export function isLayoutTemplateBundle(v: unknown): v is LayoutTemplateBundle {
  const b = v as Partial<LayoutTemplateBundle> | null;
  return !!b && typeof b === "object" && typeof b.manifest === "string" && typeof b.templates === "object" && b.templates !== null && !("code" in b);
}

function templateOfFile(file: string, title: string, text: string, warnings: string[]): LayoutTemplate | null {
  try {
    if (/\.sketchor$/i.test(file)) {
      const src = SketchDocument.fromJSON(JSON.parse(text));
      const layouts = layoutList(src);
      return { title, file, layouts: structuredClone(layouts), entities: layouts.flatMap((l) => structuredClone(layoutEntities(src, l.name))), blocks: structuredClone(src.records("blocks") as BlockDefinition[]) };
    }
    const r = parseDxf(text, { blocks: "keep" });
    for (const w of r.warnings.slice(0, 5)) warnings.push(`${file}: ${w}`);
    return { title, file, layouts: structuredClone(r.layouts), entities: structuredClone(r.paperEntities), blocks: structuredClone(r.blocks) };
  } catch {
    warnings.push(`${file}: could not be read`);
    return null;
  }
}

/** Validates a layout-template bundle end to end; a file with no layout is an error (it would offer an empty template). */
export function loadLayoutTemplateBundle(bundle: LayoutTemplateBundle): LayoutTemplateBundleResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(bundle.manifest);
  } catch {
    return { ok: false, errors: ["manifest.json is not valid JSON"] };
  }
  const v = validateManifest(parsed);
  if (!v.ok) return { ok: false, errors: v.errors };
  const manifest = v.manifest;
  if (!isLayoutTemplatesOnly(manifest)) return { ok: false, errors: ["this bundle contains code, permissions or other contributions - only signed plugin bundles may do that"] };
  const entries = manifest.contributes!.layoutTemplates!;
  if (entries.length > MAX_FILES) return { ok: false, errors: [`a plugin may contribute at most ${MAX_FILES} templates`] };
  const errors: string[] = [];
  const warnings: string[] = [];
  const templates: LayoutTemplate[] = [];
  for (const c of entries) {
    const text = Object.prototype.hasOwnProperty.call(bundle.templates, c.file) ? bundle.templates[c.file] : undefined;
    if (typeof text !== "string") {
      errors.push(`${c.file}: listed in the manifest but missing from the bundle`);
      continue;
    }
    if (text.length > MAX_FILE_BYTES) {
      errors.push(`${c.file}: larger than ${MAX_FILE_BYTES / 1024 / 1024} MB`);
      continue;
    }
    const t = templateOfFile(c.file, c.title.trim(), text, warnings);
    if (!t) {
      errors.push(`${c.file}: could not be read`);
      continue;
    }
    if (t.layouts.length === 0) errors.push(`${c.file}: no layout found`);
    else if (t.layouts.length > MAX_LAYOUTS) errors.push(`${c.file}: more than ${MAX_LAYOUTS} layouts`);
    else templates.push(t);
  }
  return errors.length ? { ok: false, errors } : { ok: true, manifest, templates, warnings };
}

export interface TemplatePlan {
  layoutNames: string[];
  commands: Command[];
  warnings: string[];
}

export interface TemplateOptions {
  /** Name for the first layout (the others keep their own names); a taken name gets a numeric suffix. */
  name?: string;
  /** Point every template viewport at the drawing (largest standard scale that fits its window; default true). Off keeps the template's own view. */
  fit?: boolean;
  /** Frame these entities instead of the whole model when fitting. */
  ids?: readonly string[];
}

function freeName(doc: SketchDocument, taken: Set<string>, base: string): string {
  let n = base;
  for (let i = 2; doc.hasRecord(LAYOUTS_TABLE, n) || taken.has(n); i++) n = `${base} (${i})`;
  return n;
}

/**
 * The commands that add `template`'s layouts to `doc` (one batch). Entities get fresh ids and follow their layout
 * if it is renamed to avoid a clash; blocks the drawing already has are kept as they are (the drawing's own title
 * block wins when the name is taken). Null when the template has no layout.
 */
export function planFromTemplate(doc: SketchDocument, template: LayoutTemplate, opts: TemplateOptions = {}): TemplatePlan | null {
  if (template.layouts.length === 0) return null;
  const warnings: string[] = [];
  const commands: Command[] = [];
  for (const b of template.blocks) {
    if (doc.hasRecord("blocks", b.name)) continue;
    commands.push({ type: "put-table-record", table: "blocks", record: structuredClone(b) });
  }
  const renamed = new Map<string, string>();
  const taken = new Set<string>();
  template.layouts.forEach((l, i) => {
    const want = i === 0 && opts.name?.trim() ? opts.name.trim() : l.name;
    const name = freeName(doc, taken, want);
    if (name !== want) warnings.push(`Layout "${want}" exists; named it ${name}`);
    taken.add(name);
    renamed.set(l.name, name);
    commands.push({ type: "add-layout", layout: { ...structuredClone(l), name } as LayoutRecord });
  });
  const bounds = opts.fit === false ? null : modelFrameBounds(doc, opts.ids);
  for (const e of template.entities) {
    const space = spaceOf(e);
    const target = space ? renamed.get(space) : undefined;
    if (!target) continue; // not on one of the template's layouts
    let entity = { ...structuredClone(e), id: newEntityId(), space: target } as Entity;
    if (entity.type === "viewport" && bounds) {
      const view = fitViewportView(entity.width, entity.height, bounds);
      entity = { ...entity, viewCenter: view.center, scale: view.scale } as ViewportEntity;
      delete (entity as { annotationScale?: string }).annotationScale;
    }
    commands.push({ type: "add-entity", entity });
  }
  if (opts.fit !== false && !bounds && modelEntities(doc).length === 0) warnings.push("The drawing is empty; the viewports keep the template's own view");
  return { layoutNames: [...renamed.values()], commands: [{ type: "batch", commands }], warnings };
}
