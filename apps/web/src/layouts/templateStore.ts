import { isLayoutTemplateBundle, loadLayoutTemplateBundle, type LayoutTemplate, type LayoutTemplateBundle } from "@sketchor/core";

/**
 * L-09: installed sheet-template packs (layout-template plugin bundles), keyed by plugin id in localStorage - the
 * same shape as the block packs. Packs are data (re-validated on every load), so no signature is needed.
 */
const KEY = "sketchor.layoutTemplates.v1";

function readPacks(): Record<string, LayoutTemplateBundle> {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? "{}") as Record<string, unknown>;
    const out: Record<string, LayoutTemplateBundle> = {};
    for (const [id, b] of Object.entries(raw)) if (isLayoutTemplateBundle(b)) out[id] = b;
    return out;
  } catch {
    return {};
  }
}

function writePacks(packs: Record<string, LayoutTemplateBundle>): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(packs));
  } catch {
    /* storage unavailable (or full): the pack lasts for this session only */
  }
}

/** Every template of every installed pack, titled "Pack: title" when the pack offers several. */
export function loadContributedTemplates(): LayoutTemplate[] {
  const out: LayoutTemplate[] = [];
  for (const bundle of Object.values(readPacks())) {
    const r = loadLayoutTemplateBundle(bundle);
    if (r.ok) out.push(...r.templates);
  }
  return out;
}

export type InstallTemplatePackResult = { ok: true; id: string; count: number; warnings: string[] } | { ok: false; reason: string };

/** Installs a layout-template plugin bundle from its JSON text ({manifest, templates}); a re-install of the same plugin replaces it. */
export function installTemplatePack(text: string): InstallTemplatePackResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, reason: "That file isn't valid JSON." };
  }
  if (!isLayoutTemplateBundle(parsed)) return { ok: false, reason: "That isn't a Sketchor sheet-template pack ({manifest, templates})." };
  const r = loadLayoutTemplateBundle(parsed);
  if (!r.ok) return { ok: false, reason: r.errors.join("; ") };
  const packs = readPacks();
  packs[r.manifest.id] = parsed;
  writePacks(packs);
  return { ok: true, id: r.manifest.id, count: r.templates.length, warnings: r.warnings };
}
