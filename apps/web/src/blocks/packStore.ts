import { isBlockBundle, loadBlockBundle, type BlockBundle, type ContributedBlock } from "@sketchor/core";

/**
 * B-24: installed block packs (blocks-only plugin bundles), keyed by plugin id
 * in localStorage — the same shape as the hatch pattern packs. Packs are data
 * (re-validated on every load), so no signature is needed.
 */
const KEY = "sketchor.blockPacks.v1";

function readPacks(): Record<string, BlockBundle> {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? "{}") as Record<string, unknown>;
    const out: Record<string, BlockBundle> = {};
    for (const [id, b] of Object.entries(raw)) if (isBlockBundle(b)) out[id] = b;
    return out;
  } catch {
    return {};
  }
}

function writePacks(packs: Record<string, BlockBundle>): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(packs));
  } catch {
    /* storage unavailable (or full): the pack lasts for this session only */
  }
}

/** Every block of every installed pack, with its category. */
export function loadContributedBlocks(): ContributedBlock[] {
  const out: ContributedBlock[] = [];
  for (const bundle of Object.values(readPacks())) {
    const r = loadBlockBundle(bundle);
    if (r.ok) out.push(...r.blocks);
  }
  return out;
}

export type InstallBlockPackResult = { ok: true; id: string; count: number; warnings: string[] } | { ok: false; reason: string };

/** Installs a blocks-only plugin bundle from its JSON text ({manifest, blocks}); a re-install of the same plugin replaces it. */
export function installBlockPack(text: string): InstallBlockPackResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, reason: "That file isn't valid JSON." };
  }
  if (!isBlockBundle(parsed)) return { ok: false, reason: "That isn't a Sketchor block pack ({manifest, blocks})." };
  const r = loadBlockBundle(parsed);
  if (!r.ok) return { ok: false, reason: r.errors.join("; ") };
  const packs = readPacks();
  packs[r.manifest.id] = parsed;
  writePacks(packs);
  return { ok: true, id: r.manifest.id, count: r.blocks.length, warnings: r.warnings };
}
