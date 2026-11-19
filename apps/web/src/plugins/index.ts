import {
  HOST_API_VERSION,
  PERMISSIONS,
  patternCommands,
  type GrantedCapabilities,
  type Permission,
  type PatternSpec,
  type PluginManifest,
} from "@sketchor/core";
import { doc, useApp } from "../state/store";
import { PluginHost } from "./host/PluginHost";
import { previewGenerator, registerContributions, runGenerator, unregisterContributions } from "./host/registries";
import { removePluginUi } from "./host/uiManager";
import { satisfiesHostApi } from "./host/engine";
import { listInstalled } from "./host/pluginStore";
import { BUILTIN_MANIFESTS } from "./builtins/manifests";

/**
 * Phase 2 plugin runtime entry. Loads plugins from their {@link PluginManifest},
 * registers what they contribute into the host registries (see
 * {@link ./host/registries}), and boots the first-party plugins so their
 * contributions are reachable from the UI (command palette + save/export menu).
 *
 * A manifest's `engines.sketchor` is checked against the host API version before
 * the worker starts — an incompatible plugin is refused at load, never at
 * runtime (see `docs/plugin-v1-plan.md`, "Cross-cutting: API versioning").
 */

const running = new Map<string, PluginHost>();

export interface LoadOptions {
  manifest: PluginManifest;
  /** An in-repo builtin id, or … */
  builtinId?: string;
  /** … a verified third-party bundle's JS source. Exactly one is required. */
  source?: string;
  permissions?: Permission[];
}

/**
 * Loads a plugin (builtin or a verified third-party bundle), granting the given
 * permissions, and registers its contributions. Rejects — before starting the
 * worker — if the manifest's `engines.sketchor` doesn't satisfy the host API.
 * Signature verification and the permission grant happen upstream in the install
 * flow ({@link ./host/install}); builtins are trusted by virtue of shipping in
 * the app.
 */
export async function loadPlugin(opts: LoadOptions): Promise<void> {
  const { manifest } = opts;
  const engine = manifest.engines?.sketchor ?? "";
  if (!satisfiesHostApi(engine)) {
    throw new Error(
      `Plugin "${manifest.id}" needs Sketchor plugin API ${engine}, but this host provides ${HOST_API_VERSION}`,
    );
  }

  stopPlugin(manifest.id);
  const granted: GrantedCapabilities = new Set(opts.permissions ?? manifest.permissions ?? []);
  const host = new PluginHost({
    pluginId: manifest.id,
    builtinId: opts.builtinId,
    source: opts.source,
    granted,
  });
  running.set(manifest.id, host);
  await host.load();
  registerContributions(host, manifest);
}

export function stopPlugin(pluginId: string): void {
  running.get(pluginId)?.dispose();
  running.delete(pluginId);
  unregisterContributions(pluginId);
  removePluginUi(pluginId);
}

/** Boots the in-repo first-party plugins. Called once at app start. */
export async function loadFirstPartyPlugins(): Promise<void> {
  await Promise.all(
    BUILTIN_MANIFESTS.map((m) =>
      loadPlugin({ manifest: m, builtinId: m.id }).catch((err) =>
        console.error(`[plugins] failed to load ${m.id}:`, err),
      ),
    ),
  );
}

/** Boots previously installed third-party plugins from the local store. */
export async function loadInstalledPlugins(): Promise<void> {
  await Promise.all(
    listInstalled().map((p) =>
      loadPlugin({ manifest: p.manifest, source: p.bundle.code, permissions: p.granted }).catch((err) =>
        console.error(`[plugins] failed to load installed ${p.manifest.id}:`, err),
      ),
    ),
  );
}

// --- dev handle & acceptance ---

const TEST_ID = "com.sketchor.test";

/**
 * Exposes `window.sketchorPlugins` for console-driven acceptance:
 *
 *   await sketchorPlugins.run()                  // Phase 1: draws a line, undoes in one step
 *   await sketchorPlugins.run(["read-document"]) // no write → apply() rejects
 *   sketchorPlugins.stop()
 *
 *   // Phase 2: the pattern plugin (loaded, not built-in) matches core geometry.
 *   sketchorPlugins.testPattern({ kind: "rectangular", columns: 3, rows: 2, columnSpacing: 40, rowSpacing: 30 })
 */
export function installPluginDevHandle(): void {
  const handle = {
    run: (permissions: Permission[] = ["read-document", "write-document"]) => {
      const testManifest: PluginManifest = {
        id: TEST_ID,
        version: "1.0.0",
        name: "Test",
        engines: { sketchor: `^${HOST_API_VERSION}` },
        main: "testPlugin.ts",
      };
      return loadPlugin({ manifest: testManifest, builtinId: TEST_ID, permissions });
    },
    stop: () => stopPlugin(TEST_ID),
    /**
     * Phase 2 acceptance: compares the pattern *plugin* generator's output —
     * produced in the worker, over the public API — against the built-in
     * `patternCommands` geometry, then applies it so it shows on the canvas.
     */
    testPattern: async (spec: PatternSpec) => {
      const selection = useApp.getState().selection;
      const expected = stripIds(patternCommands(doc, selection, spec));
      const pluginOutput = stripIds(await previewGenerator("pattern.array", spec));
      const match = JSON.stringify(expected) === JSON.stringify(pluginOutput);
      const added = await runGenerator("pattern.array", spec);
      console.info(
        `[plugins] pattern plugin added ${added} entities; geometry matches core patternCommands: ${match}`,
      );
      return { added, match };
    },
    /**
     * Phase 4 acceptance: fetch the committed signed sample bundle and run it
     * through the real install pipeline (auto-approving the prompt). Returns
     * `{ ok: true }` for the intact bundle; call `installSample(true)` to tamper
     * the code first and watch the signature check refuse it.
     */
    installSample: async (tamper = false) => {
      const res = await fetch(`${import.meta.env.BASE_URL}sample-plugins/hello.sketchor-plugin.json`);
      const bundle = (await res.json()) as import("@sketchor/core").SignedBundle;
      if (tamper) bundle.code += " // tampered";
      const { installBundle } = await import("./host/install");
      const result = await installBundle(bundle, async (info) => {
        console.info(`[plugins] install prompt: ${info.manifest.name} signed by ${info.fingerprint}`);
        return { approve: true, grantedPermissions: info.permissions };
      });
      console.info("[plugins] install result:", result);
      return result;
    },
    /** Phase 5: fetch the registry and show each plugin's install/update status. */
    browseRegistry: async () => {
      const { fetchRegistry, withStatus } = await import("./host/registry");
      const list = withStatus(await fetchRegistry());
      console.info("[plugins] registry:", list);
      return list;
    },
    PERMISSIONS,
  };
  (window as unknown as { sketchorPlugins: typeof handle }).sketchorPlugins = handle;
}

/** Drops entity ids so two runs are comparable by geometry alone (ids are freshly minted each time). */
function stripIds(commands: unknown[]): unknown {
  return JSON.parse(JSON.stringify(commands), (key, value) => (key === "id" ? undefined : value));
}
