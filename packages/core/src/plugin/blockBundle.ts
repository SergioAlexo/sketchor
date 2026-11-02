/**
 * B-24: a blocks-only plugin bundle — manifest plus the `.dxf` / `.sketchor`
 * files it names, no code. Like theme and pattern bundles it is data (the files
 * are parsed into block definitions, never executed), so the host reads,
 * validates and lists it directly and needs no signature. Dynamic blocks ride
 * along: a `.sketchor` file keeps the spec, a Sketchor-written DXF its SKETCHOR
 * record, and an AutoCAD dynamic block comes through the B-26 importer.
 */
import { SketchDocument } from "../document";
import { parseDxf } from "../dxf";
import type { Entity } from "../entities";
import { blockFromEntities, sanitizeBlockName, type LibraryEntry } from "../blocks/library";
import type { BlockDefinition } from "../blocks/types";
import { isBlocksOnly, validateManifest, type PluginManifest } from "./manifest";

export interface BlockBundle {
  /** Raw `manifest.json` text. */
  manifest: string;
  /** File text keyed by the bundle-relative path the manifest names. */
  blocks: Record<string, string>;
}

export interface ContributedBlock {
  category: string;
  entry: LibraryEntry;
}

export type BlockBundleResult =
  | { ok: true; manifest: PluginManifest; blocks: ContributedBlock[]; warnings: string[] }
  | { ok: false; errors: string[] };

const MAX_FILE_BYTES = 4 * 1024 * 1024;
const MAX_FILES = 32;
const MAX_BLOCKS = 500;

export function isBlockBundle(v: unknown): v is BlockBundle {
  const b = v as Partial<BlockBundle> | null;
  return !!b && typeof b === "object" && typeof b.manifest === "string" && typeof b.blocks === "object" && b.blocks !== null && !("code" in b);
}

/** The definition plus every block it nests (found among `defs`). */
function withDeps(def: BlockDefinition, byName: ReadonlyMap<string, BlockDefinition>): LibraryEntry {
  const seen = new Set<string>([def.name]);
  const deps: BlockDefinition[] = [];
  const walk = (list: readonly Entity[]): void => {
    for (const e of list) {
      if (e.type !== "insert" || seen.has(e.block)) continue;
      seen.add(e.block);
      const d = byName.get(e.block);
      if (!d) continue;
      deps.push(structuredClone(d));
      walk(d.entities);
    }
  };
  walk(def.entities);
  return { def: structuredClone(def), deps };
}

function blocksOfFile(file: string, text: string, warnings: string[]): LibraryEntry[] {
  const base = sanitizeBlockName(file.split("/").pop() ?? file);
  let defs: BlockDefinition[] = [];
  let loose: Entity[] = [];
  try {
    if (/\.sketchor$/i.test(file)) {
      const src = SketchDocument.fromJSON(JSON.parse(text));
      defs = (src.records("blocks") as BlockDefinition[]).map((d) => structuredClone(d));
      loose = src.all();
    } else {
      const r = parseDxf(text, { blocks: "keep" });
      defs = r.blocks;
      loose = r.entities;
      for (const w of r.warnings.slice(0, 5)) warnings.push(`${file}: ${w}`);
    }
  } catch {
    warnings.push(`${file}: could not be read`);
    return [];
  }
  const byName = new Map(defs.map((d) => [d.name, d] as const));
  if (defs.length > 0) {
    // Blocks only nested by another one are dependencies, not entries of their own.
    const nested = new Set<string>();
    for (const d of defs) for (const e of d.entities) if (e.type === "insert" && e.block !== d.name) nested.add(e.block);
    const tops = defs.filter((d) => !nested.has(d.name));
    return (tops.length > 0 ? tops : defs).map((d) => withDeps(d, byName));
  }
  if (loose.length === 0) {
    warnings.push(`${file}: no blocks or geometry found`);
    return [];
  }
  return [{ def: blockFromEntities(base, loose), deps: [] }];
}

/** Validates a blocks-only bundle end to end; every block comes back with its category (the contribution's, else the plugin name). */
export function loadBlockBundle(bundle: BlockBundle): BlockBundleResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(bundle.manifest);
  } catch {
    return { ok: false, errors: ["manifest.json is not valid JSON"] };
  }
  const v = validateManifest(parsed);
  if (!v.ok) return { ok: false, errors: v.errors };
  const manifest = v.manifest;
  if (!isBlocksOnly(manifest)) return { ok: false, errors: ["this bundle contains code, permissions or other contributions - only signed plugin bundles may do that"] };
  const entries = manifest.contributes!.blocks!;
  if (entries.length > MAX_FILES) return { ok: false, errors: [`a plugin may contribute at most ${MAX_FILES} block files`] };

  const errors: string[] = [];
  const warnings: string[] = [];
  const blocks: ContributedBlock[] = [];
  const seen = new Set<string>();
  for (const c of entries) {
    const text = Object.prototype.hasOwnProperty.call(bundle.blocks, c.file) ? bundle.blocks[c.file] : undefined;
    if (typeof text !== "string") {
      errors.push(`${c.file}: listed in the manifest but missing from the bundle`);
      continue;
    }
    if (text.length > MAX_FILE_BYTES) {
      errors.push(`${c.file}: larger than ${MAX_FILE_BYTES / 1024 / 1024} MB`);
      continue;
    }
    const found = blocksOfFile(c.file, text, warnings);
    if (found.length === 0) errors.push(`${c.file}: no block found`);
    for (const entry of found) {
      const key = entry.def.name.toUpperCase();
      if (seen.has(key)) {
        warnings.push(`${c.file}: ${entry.def.name} is defined twice, the first one is kept`);
        continue;
      }
      seen.add(key);
      blocks.push({ category: c.category?.trim() || manifest.name, entry });
    }
  }
  if (blocks.length > MAX_BLOCKS) errors.push(`a plugin may contribute at most ${MAX_BLOCKS} blocks`);
  return errors.length ? { ok: false, errors } : { ok: true, manifest, blocks, warnings };
}
