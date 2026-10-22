/// <reference lib="webworker" />
import { contributionStore, createClient, type PluginModule } from "@sketchor/plugin-sdk";
import type { HostToWorker, WorkerToHost } from "../rpc/protocol";
import { serializeError } from "../rpc/protocol";
import { WorkerTransport } from "../rpc/workerTransport";

/**
 * The plugin sandbox entry. Runs in a Web Worker: no DOM, no `window.sketchor`,
 * no access to the host beyond the RPC transport. On `init` it loads the plugin
 * module, hands it a host-API client, and calls `activate`.
 *
 * Phase 1 loads only in-repo *builtin* plugins by id (Vite can statically
 * analyze these dynamic imports). Loading third-party bundles from a URL/blob
 * is the install flow in Phase 4.
 */
const BUILTINS: Record<string, () => Promise<{ default: PluginModule }>> = {
  "com.sketchor.test": () => import("../builtins/testPlugin"),
  "com.sketchor.pattern": () => import("../builtins/patternPlugin"),
  "com.sketchor.svg-export": () => import("../builtins/svgExportPlugin"),
  "com.sketchor.panel-demo": () => import("../builtins/panelDemoPlugin"),
  "com.sketchor.truck-nesting": () => import("../builtins/truckNestingPlugin"),
  "com.sketchor.gcode": () => import("../builtins/gcodePlugin"),
  "com.sketchor.nest": () => import("../builtins/nestPlugin"),
  "com.sketchor.sheet-nesting": () => import("../builtins/sheetNestingPlugin"),
};

const transport = new WorkerTransport();
const client = createClient(transport);
let active: PluginModule | null = null;

function send(msg: WorkerToHost): void {
  (self as unknown as Worker).postMessage(msg);
}

/**
 * Loads the plugin module: a first-party `builtinId` (statically analyzable
 * import) or an installed third-party `source` (already signature-verified by
 * the host) imported as an ES module from a blob URL. The blob runs in this
 * worker — no DOM, no `window.sketchor`, only the injected RPC client.
 */
async function loadModule(msg: Extract<HostToWorker, { kind: "init" }>): Promise<PluginModule> {
  if (msg.source !== undefined) {
    const url = URL.createObjectURL(new Blob([msg.source], { type: "text/javascript" }));
    try {
      return (await import(/* @vite-ignore */ url)).default as PluginModule;
    } finally {
      URL.revokeObjectURL(url);
    }
  }
  const loader = msg.builtinId ? BUILTINS[msg.builtinId] : undefined;
  if (!loader) throw new Error(`Unknown builtin plugin "${msg.builtinId}"`);
  return (await loader()).default;
}

self.addEventListener("message", async (e: MessageEvent) => {
  const msg = e.data as HostToWorker;
  if (msg.kind === "init") {
    try {
      active = await loadModule(msg);
      await active.activate(client);
      send({ kind: "activated", ok: true });
    } catch (err) {
      send({ kind: "activated", ok: false, error: serializeError(err) });
    }
    return;
  }
  if (msg.kind === "invoke") {
    try {
      const value = await runContribution(msg);
      send({ kind: "invoke-result", id: msg.id, ok: true, value });
    } catch (err) {
      send({ kind: "invoke-result", id: msg.id, ok: false, error: serializeError(err) });
    }
    return;
  }
  if (msg.kind === "deactivate") {
    try {
      await active?.deactivate?.();
    } finally {
      active = null;
      self.close();
    }
  }
});

/**
 * Runs one registered contribution handler. Read-model inputs (document,
 * selection) are fetched through the client, so they pass the same capability
 * gate as any other plugin call; the handler's plain-data result crosses back
 * to the host, which applies any returned commands under `write-document`.
 */
async function runContribution(
  msg: Extract<HostToWorker, { kind: "invoke" }>,
): Promise<unknown> {
  const store = contributionStore(client);
  switch (msg.contribution) {
    case "command": {
      const handler = store.commands.get(msg.contributionId);
      if (!handler) throw new Error(`No command handler registered for "${msg.contributionId}"`);
      await handler({ input: msg.input });
      return undefined;
    }
    case "generator": {
      const handler = store.generators.get(msg.contributionId);
      if (!handler) throw new Error(`No generator handler registered for "${msg.contributionId}"`);
      const [document, selection] = await Promise.all([client.document.read(), client.selection.read()]);
      return handler({ document, selection, input: msg.input });
    }
    case "exporter": {
      const handler = store.exporters.get(msg.contributionId);
      if (!handler) throw new Error(`No exporter registered for "${msg.contributionId}"`);
      const document = await client.document.read();
      return handler({ document });
    }
    case "importer": {
      const handler = store.importers.get(msg.contributionId);
      if (!handler) throw new Error(`No importer registered for "${msg.contributionId}"`);
      return handler({ text: String(msg.input ?? "") });
    }
  }
}

send({ kind: "ready" });
