import type { Permission, SignedBundle } from "@sketchor/core";
import { isNewer } from "../../update/updateService";
import { installBundle, type InstallPrompt, type InstallResult } from "./install";
import { getInstalled } from "./pluginStore";

/**
 * The plugin registry client — the marketplace's read side. The registry is a
 * static JSON index plus signed bundles served as plain files (GitHub release
 * assets or any CDN; no backend). Installing from the registry is exactly the
 * Phase 4 flow: fetch the bundle → verify signature → prompt → register. The
 * registry never grants trust; it only points at bundles.
 */

/** The default index location — overridable so a user can point at another registry. */
export const DEFAULT_REGISTRY_URL = `${import.meta.env.BASE_URL ?? "/"}sample-plugins/registry.json`;

export interface RegistryEntry {
  id: string;
  name: string;
  description?: string;
  publisher?: string;
  version: string;
  /** URL of the signed bundle JSON, relative to the index or absolute. */
  bundle: string;
  permissions?: Permission[];
}

export interface RegistryIndex {
  plugins: RegistryEntry[];
}

export interface RegistryListing extends RegistryEntry {
  /** The installed version, if any. */
  installedVersion?: string;
  /** True when installed and the registry offers a strictly newer version. */
  updateAvailable: boolean;
}

/** Fetches and lightly validates the registry index. */
export async function fetchRegistry(url: string = DEFAULT_REGISTRY_URL): Promise<RegistryEntry[]> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Registry fetch failed (${res.status})`);
  const index = (await res.json()) as RegistryIndex;
  if (!index || !Array.isArray(index.plugins)) throw new Error("Registry index is malformed");
  return index.plugins.filter((p) => p && typeof p.id === "string" && typeof p.bundle === "string");
}

/** Annotates registry entries with install/update status against the local store. */
export function withStatus(entries: RegistryEntry[]): RegistryListing[] {
  return entries.map((entry) => {
    const installed = getInstalled(entry.id);
    return {
      ...entry,
      installedVersion: installed?.manifest.version,
      updateAvailable: installed ? isNewer(entry.version, installed.manifest.version) : false,
    };
  });
}

/** Downloads an entry's signed bundle and runs it through the Phase 4 install flow. */
export async function installFromRegistry(
  entry: RegistryEntry,
  prompt: InstallPrompt,
  indexUrl: string = DEFAULT_REGISTRY_URL,
): Promise<InstallResult> {
  const bundleUrl = new URL(entry.bundle, new URL(indexUrl, location.href)).href;
  let bundle: SignedBundle;
  try {
    const res = await fetch(bundleUrl);
    if (!res.ok) return { ok: false, reason: `Bundle download failed (${res.status})` };
    bundle = (await res.json()) as SignedBundle;
  } catch (err) {
    return { ok: false, reason: `Bundle download failed: ${err instanceof Error ? err.message : String(err)}` };
  }
  return installBundle(bundle, prompt, "registry");
}
