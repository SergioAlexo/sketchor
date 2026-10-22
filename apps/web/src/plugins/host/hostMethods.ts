import {
  projectDocument,
  type Command,
  type DisplayUnitInfo,
  type PickedFolder,
  type PrintFolderInfo,
  type SaveFileFilter,
  type SaveFileResult,
  type UiShowOptions,
} from "@sketchor/core";
import { bus, doc, openNamedTab, useApp } from "../../state/store";
import { factorFromMm, type DisplayUnit } from "../../units";
import { hidePanel, postToPanel, showPanel, subscribeToPanel } from "./uiManager";
import { printHtml } from "../../print/printHtml";
import { listDirectory, readPickedFile, type DirHandleLike } from "./pickedFolder";
import { autosaveEnabled, autosaveFolderLabel, pickAutosaveFolder, setAutosaveEnabled, supportsAutosave } from "../../io/autosaveFolder";

/** The autosave folder, as the plugin-facing {@link PrintFolderInfo}. */
function printFolderInfo(): PrintFolderInfo {
  const folder = autosaveFolderLabel();
  return { supported: supportsAutosave(), folder, enabled: autosaveEnabled() && folder !== null };
}

// Minimal shape of the File System Access API's save side, declared locally
// (as `io/drawingFile.ts` does for its own use) so we don't need the
// `@types/wicg-file-system-access` package. Unlike that module's own local
// type, `write` here also accepts binary data — a plugin's `ui.saveFile` can
// save more than text.
interface SaveFilePickerType {
  description?: string;
  accept: Record<string, string[]>;
}
interface SaveWritable {
  write(data: Uint8Array | string): Promise<void>;
  close(): Promise<void>;
}
interface SaveFileHandle {
  name: string;
  createWritable(): Promise<SaveWritable>;
}
interface WindowWithSaveDialog extends Window {
  showSaveFilePicker?(opts: { suggestedName?: string; types?: SaveFilePickerType[] }): Promise<SaveFileHandle>;
}

/**
 * `ui.saveFile` (host API 0.8.0): opens a save-as dialog for `data`. Reuses
 * the same File System Access API `io/drawingFile.ts`'s `saveDrawing` does —
 * that already works inside Tauri's WebView2 too, so there's no separate
 * native-dialog path for desktop. Falls back to a `<a download>` click where
 * the API is missing (older/non-Chromium browsers).
 */
async function hostSaveFile(name: string, data: Uint8Array | string, filters?: SaveFileFilter[]): Promise<SaveFileResult> {
  const w = window as WindowWithSaveDialog;
  if (typeof w.showSaveFilePicker === "function") {
    try {
      const handle = await w.showSaveFilePicker({
        suggestedName: name,
        types: filters?.map((f) => ({ description: f.description, accept: f.accept })),
      });
      const writable = await handle.createWritable();
      await writable.write(data);
      await writable.close();
      return { saved: true, name: handle.name };
    } catch (err) {
      // The user dismissing the picker throws AbortError — treat as a cancel.
      if ((err as DOMException)?.name === "AbortError") return { saved: false };
      throw err;
    }
  }

  // Uint8Array<ArrayBufferLike> vs. BlobPart's Uint8Array<ArrayBuffer> is a
  // TS lib-typing artifact (SharedArrayBuffer backing is never actually
  // possible here) — Blob accepts a Uint8Array at runtime regardless.
  const blob = new Blob([data as BlobPart]);
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
  return { saved: true, name };
}

/** The folder each plugin last picked with `ui.pickFolder` - the only place `ui.readPickedFile` can read. */
const pickedRoots = new Map<string, DirHandleLike>();

/**
 * `ui.pickFolder` (host API 0.9.0): `showDirectoryPicker` works in Tauri's
 * WebView2 as well (same reasoning as `hostSaveFile`), so desktop needs no
 * Rust command. Cancel resolves null.
 */
async function hostPickFolder(pluginId: string): Promise<PickedFolder | null> {
  const w = window as unknown as { showDirectoryPicker?: (o?: { mode?: "read" }) => Promise<DirHandleLike & { name: string }> };
  if (typeof w.showDirectoryPicker !== "function") throw new Error("Folder picking isn't supported in this browser");
  let dir: DirHandleLike & { name: string };
  try {
    dir = await w.showDirectoryPicker({ mode: "read" });
  } catch (err) {
    if ((err as DOMException)?.name === "AbortError") return null;
    throw err;
  }
  pickedRoots.set(pluginId, dir);
  const { files, truncated } = await listDirectory(dir);
  return { name: dir.name, files, ...(truncated ? { truncated: true } : {}) };
}

/** The current display unit as the plugin-facing {@link DisplayUnitInfo}. */
function currentDisplayUnit(): DisplayUnitInfo {
  const unit = useApp.getState().displayUnit as DisplayUnit;
  return { unit, perMm: factorFromMm(unit), label: unit };
}

/**
 * The actual host-side implementations behind each RPC method. These run on the
 * main thread with real access to the document, command bus, and selection —
 * the only place plugin intents become state changes. Every entry here is
 * reached *after* {@link ../host/capabilityGuard.assertCapability} has passed.
 */

export interface HostContext {
  /** Manifest id — namespaces this plugin's storage. */
  readonly pluginId: string;
}

const COMMAND_TYPES = new Set<Command["type"]>([
  "add-entity",
  "delete-entities",
  "move-entities",
  "update-entity",
  "transform-entities",
  "group-entities",
  "ungroup",
  "add-constraint",
  "remove-constraint",
  "batch",
]);

/** Untrusted input from the sandbox — reject anything that isn't a known command. */
export function assertCommands(value: unknown): asserts value is Command[] {
  if (!Array.isArray(value)) throw new Error("commands must be an array");
  for (const c of value) {
    if (!c || typeof c !== "object" || !COMMAND_TYPES.has((c as { type?: Command["type"] }).type as Command["type"])) {
      throw new Error(`invalid command: ${JSON.stringify(c)}`);
    }
    if ((c as Command).type === "batch") assertCommands((c as { commands: unknown }).commands);
  }
}

/** Request/response methods. */
export async function dispatchCall(ctx: HostContext, method: string, args: unknown[]): Promise<unknown> {
  switch (method) {
    case "document.read":
      return projectDocument(doc);

    case "document.apply": {
      const commands = args[0];
      assertCommands(commands);
      // Collapse the plugin's whole action into one undo step.
      if (commands.length > 0) {
        bus.execute({ type: "batch", commands });
        // A plugin can introduce a new layer (e.g. the load planner's "Load
        // Plan"); surface it in the layer panel like any first-party edit would.
        useApp.getState().syncLayersFromDoc();
      }
      return doc.revision;
    }

    case "selection.read":
      return useApp.getState().selection;

    case "storage.get":
      return readStorage(ctx.pluginId, String(args[0]));
    case "storage.set":
      writeStorage(ctx.pluginId, String(args[0]), args[1]);
      return undefined;
    case "storage.delete":
      localStorage.removeItem(storageKey(ctx.pluginId, String(args[0])));
      return undefined;
    case "storage.keys":
      return storageKeys(ctx.pluginId);

    case "network.fetch":
      return hostFetch(String(args[0]), args[1] as RequestInit | undefined);

    case "filesystem.readFile":
      return desktopReadFile(String(args[0]));
    case "filesystem.writeFile":
      return desktopWriteFile(String(args[0]), String(args[1]));

    case "ui.show":
      showPanel(ctx.pluginId, String(args[0] ?? ""), args[1] as UiShowOptions | undefined);
      return undefined;
    case "ui.hide":
      hidePanel(ctx.pluginId);
      return undefined;

    case "ui.printFolder":
      return printFolderInfo();
    case "ui.pickPrintFolder": {
      // Runs inside the click that came up from the panel iframe: the picker
      // needs that transient activation, and so does the write that follows.
      const folder = await pickAutosaveFolder();
      // Choosing a folder *is* the request to file copies there — asking the
      // user to then also tick a box would be a second answer to one question.
      if (folder) setAutosaveEnabled(true);
      return printFolderInfo();
    }
    case "ui.saveFile": {
      // Runs inside the click that came up from the panel iframe, same as
      // ui.pickPrintFolder above — the save picker needs that transient
      // activation too.
      const data = args[1] as Uint8Array | string;
      return hostSaveFile(String(args[0]), data, args[2] as SaveFileFilter[] | undefined);
    }

    case "ui.pickFolder":
      // Inside the click from the panel iframe, like ui.saveFile.
      return hostPickFolder(ctx.pluginId);
    case "ui.readPickedFile": {
      const root = pickedRoots.get(ctx.pluginId);
      if (!root) throw new Error("No folder picked - call ui.pickFolder first");
      return readPickedFile(root, String(args[0]), args[1] === "bytes" ? "bytes" : "text");
    }

    case "app.displayUnit":
      return currentDisplayUnit();

    case "app.openDocumentTab": {
      const commands = args[1] ?? [];
      assertCommands(commands);
      openNamedTab(String(args[0] ?? "Plugin").slice(0, 120) || "Plugin");
      // `bus`/`doc` are live bindings: they now point at the new tab.
      if (commands.length > 0) {
        bus.execute({ type: "batch", commands });
        useApp.getState().syncLayersFromDoc();
      }
      useApp.getState().requestFit();
      return undefined;
    }

    default:
      throw new Error(`Unhandled call method "${method}"`);
  }
}

/** Event-stream methods. Returns an unsubscribe function. */
export function dispatchSubscribe(
  ctx: HostContext,
  method: string,
  _args: unknown[],
  emit: (payload: unknown) => void,
): () => void {
  switch (method) {
    case "document.onChange":
      return bus.onChange(() => emit(projectDocument(doc)));

    case "selection.onChange":
      return useApp.subscribe((state, prev) => {
        if (state.selection !== prev.selection) emit(state.selection);
      });

    case "app.onDisplayUnitChange":
      return useApp.subscribe((state, prev) => {
        if (state.displayUnit !== prev.displayUnit) emit(currentDisplayUnit());
      });

    case "ui.onMessage":
      return subscribeToPanel(ctx.pluginId, (message) => emit(message));

    default:
      throw new Error(`Unhandled subscribe method "${method}"`);
  }
}

/** Fire-and-forget methods. */
export function dispatchPost(ctx: HostContext, method: string, args: unknown[]): void {
  switch (method) {
    case "ui.notify": {
      const message = String(args[0]);
      window.dispatchEvent(new CustomEvent("sketchor:plugin-notify", { detail: { message, options: args[1] } }));
      // eslint-disable-next-line no-console
      console.info(`[plugin] ${message}`);
      return;
    }
    case "ui.postMessage":
      postToPanel(ctx.pluginId, args[0]);
      return;
    case "ui.print": {
      // args[1] is an optional { fileName, pdf } — what the autosaved copy is
      // called, and the sheet as a PDF to file instead of an HTML copy. A
      // plugin that passes neither still prints as before.
      const opts = args[1];
      const read = <T>(key: string, ok: (v: unknown) => boolean): T | undefined =>
        opts && typeof opts === "object" && ok((opts as Record<string, unknown>)[key])
          ? ((opts as Record<string, T>)[key] as T)
          : undefined;
      const fileName = read<string>("fileName", (v) => typeof v === "string");
      const pdf = read<Uint8Array>("pdf", (v) => v instanceof Uint8Array);
      printHtml(String(args[0]), { fileName, pdf });
      return;
    }
    default:
      throw new Error(`Unhandled post method "${method}"`);
  }
}

// --- storage (localStorage, namespaced per plugin) ---

function storageKey(pluginId: string, key: string): string {
  return `sketchor.plugin.${pluginId}.${key}`;
}

function readStorage(pluginId: string, key: string): unknown {
  const raw = localStorage.getItem(storageKey(pluginId, key));
  if (raw === null) return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

function writeStorage(pluginId: string, key: string, value: unknown): void {
  localStorage.setItem(storageKey(pluginId, key), JSON.stringify(value ?? null));
}

function storageKeys(pluginId: string): string[] {
  const prefix = storageKey(pluginId, "");
  const out: string[] = [];
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (k && k.startsWith(prefix)) out.push(k.slice(prefix.length));
  }
  return out;
}

// --- network ---

// --- filesystem (desktop only, via the existing Tauri commands) ---

function isDesktop(): boolean {
  return typeof window !== "undefined" && "__TAURI__" in window;
}

async function desktopReadFile(path: string): Promise<string> {
  if (!isDesktop()) throw new Error("filesystem is only available in the desktop app");
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<string>("read_drawing_file", { path });
}

async function desktopWriteFile(path: string, contents: string): Promise<void> {
  if (!isDesktop()) throw new Error("filesystem is only available in the desktop app");
  const { invoke } = await import("@tauri-apps/api/core");
  await invoke("write_drawing_file", { path, contents });
}

async function hostFetch(url: string, init: RequestInit | undefined): Promise<{
  status: number;
  ok: boolean;
  headers: Record<string, string>;
  text: string;
}> {
  const res = await fetch(url, init);
  const headers: Record<string, string> = {};
  res.headers.forEach((v, k) => (headers[k] = v));
  return { status: res.status, ok: res.ok, headers, text: await res.text() };
}
