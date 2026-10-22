import type { Command } from "../commands";
import type { EntityId } from "../entities";
import type { DocumentReadModel } from "./readModel";

/**
 * The Plugin Host API — the contract between a plugin (running in a sandbox)
 * and Sketchor. A plugin never touches this object directly: it lives on the
 * main thread; the `@sketchor/plugin-sdk` gives the plugin a typed proxy whose
 * calls are serialized across the RPC boundary. Every method here is therefore
 * async and traffics only in structured-cloneable data.
 *
 * Each sub-API is gated by a capability (see {@link ./capabilities}); calling
 * one the plugin wasn't granted rejects with a `CapabilityError`.
 *
 * This interface is **semver'd independently of the app** — see
 * {@link HOST_API_VERSION}. Additive changes are cheap; anything breaking is a
 * major bump, because installed third-party plugins can't be hot-patched.
 */
export interface PluginHostApi {
  /** The host API version this surface implements (see {@link HOST_API_VERSION}). */
  readonly apiVersion: string;
  readonly document: DocumentApi;
  readonly selection: SelectionApi;
  readonly storage: StorageApi;
  readonly network: NetworkApi;
  readonly filesystem: FilesystemApi;
  readonly ui: UiApi;
  /** Ambient, read-only host/UI state a plugin can react to (no permission). */
  readonly app: AppApi;
  /** Register handlers for the `commands`/`generators`/`io` a plugin contributes. */
  readonly commands: CommandsApi;
  readonly generators: GeneratorsApi;
  readonly io: IoApi;
}

/**
 * The app's current display unit. Stored document coordinates are always
 * millimetres; this is only how the user sees and types lengths, so a plugin
 * with its own dimension inputs (e.g. the load planner) can match the toolbar.
 */
export interface DisplayUnitInfo {
  /** The unit token shown in the toolbar dropdown. */
  unit: "mm" | "cm" | "m" | "in" | "ft";
  /** Multiply a millimetre value by this to get the displayed value; divide to go back. */
  perMm: number;
  /** Short label for UI (same as `unit` today, kept separate for future locale needs). */
  label: string;
}

/**
 * Ambient application state. Not gated by a capability — it's the same
 * read-only UI context the host chrome already shows the user, nothing a
 * plugin couldn't infer by other means. Mirrors {@link SelectionApi}'s shape.
 */
export interface AppApi {
  /** The current display unit and its millimetre conversion factor. */
  displayUnit(): Promise<DisplayUnitInfo>;
  /** Fires whenever the user changes the display unit. Returns an unsubscribe function. */
  onDisplayUnitChange(listener: (info: DisplayUnitInfo) => void): Promise<Unsubscribe>;
  /**
   * Requires `write-document`. Opens a NEW document tab named `name`, switches
   * to it, applies `commands` there as a single undo step and fits the view.
   * The source drawing is left untouched. Later `document.*` calls address
   * the new (now active) tab. Added in 0.10.0.
   */
  openDocumentTab(name: string, commands?: Command[]): Promise<void>;
}

export interface DocumentApi {
  /** Requires `read-document`. A fresh snapshot of the current document. */
  read(): Promise<DocumentReadModel>;
  /**
   * Requires `write-document`. Applies commands as a **single undo step** — the
   * host wraps them in one `batch` — and resolves to the new document revision.
   * An empty array is a no-op.
   */
  apply(commands: Command[]): Promise<number>;
  /**
   * Requires `read-document`. Subscribes to document changes; the listener gets
   * a fresh read-model after each mutation. Returns an unsubscribe function.
   */
  onChange(listener: (model: DocumentReadModel) => void): Promise<Unsubscribe>;
}

export interface SelectionApi {
  /** Requires `read-document`. The currently selected entity ids. */
  read(): Promise<EntityId[]>;
  /** Requires `read-document`. Fires whenever the selection changes. */
  onChange(listener: (ids: EntityId[]) => void): Promise<Unsubscribe>;
}

/** A per-plugin namespaced key/value store. Requires `storage`. */
export interface StorageApi {
  get(key: string): Promise<unknown>;
  set(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<void>;
  keys(): Promise<string[]>;
}

/** Host-mediated networking. Requires `network`. */
export interface NetworkApi {
  fetch(url: string, init?: PluginFetchInit): Promise<PluginFetchResponse>;
}

export interface PluginFetchInit {
  method?: string;
  headers?: Record<string, string>;
  /** Request body as text (binary bodies are out of scope for v1). */
  body?: string;
}

export interface PluginFetchResponse {
  status: number;
  ok: boolean;
  headers: Record<string, string>;
  text: string;
}

/**
 * Host-mediated file access. Requires `filesystem` and is **desktop only** —
 * backed by the Tauri `read_drawing_file` / `write_drawing_file` commands; on
 * the web every call rejects. See `docs/plugin-architecture.md` §9.
 */
export interface FilesystemApi {
  readFile(path: string): Promise<string>;
  writeFile(path: string, contents: string): Promise<void>;
}

/**
 * The plugin's UI panel (a sandboxed iframe), mirroring Figma's
 * `showUI` ↔ `figma.ui.onmessage`. Available to any plugin that declares a
 * `ui` entry in its manifest; no separate permission.
 */
export interface UiApi {
  /**
   * Mounts `html` as the plugin's panel — a sandboxed iframe docked in the host
   * UI, isolated from `window.sketchor`, the main DOM, and (via CSP) the network.
   * The panel talks back only by `postMessage`. Mirrors Figma's `showUI(html)`.
   */
  show(html: string, options?: UiShowOptions): Promise<void>;
  /** Hides the panel without unloading the plugin. */
  hide(): Promise<void>;
  /** Posts a message to the panel iframe (delivered as `event.data.pluginMessage`). */
  postMessage(message: unknown): void;
  /** Receives messages the panel posts back (its `parent.postMessage({ pluginMessage })`). */
  onMessage(listener: (message: unknown) => void): Promise<Unsubscribe>;
  /** Shows a transient host notification (toast). */
  notify(message: string, options?: NotifyOptions): void;
  /**
   * Prints `bodyHtml` via the host window's print dialog (the same mechanism
   * as the toolbar Print button), in-page rather than a popup — reliable in
   * both the browser and the desktop webview. `bodyHtml` is trusted markup
   * the plugin builds itself; escape any user-entered strings it contains.
   */
  print(bodyHtml: string, options?: PrintOptions): void;
  /** The folder printed copies are filed into, if the user has chosen one. */
  printFolder(): Promise<PrintFolderInfo>;
  /**
   * Asks the user for that folder (an OS picker) and remembers it. Must be
   * called from a real click — browsers only open the picker during a user
   * gesture, and the grant it returns is what later writes depend on.
   */
  pickPrintFolder(): Promise<PrintFolderInfo>;
  /**
   * Opens a save-as dialog for `data` (binary or text), suggesting `name`.
   * Like {@link pickPrintFolder}, must be called from a real click. Resolves
   * `{ saved: false }` if the user cancels the picker rather than rejecting,
   * so a plugin can tell "nothing happened" from a real failure.
   */
  saveFile(name: string, data: Uint8Array | string, filters?: SaveFileFilter[]): Promise<SaveFileResult>;
  /**
   * Opens an OS folder picker and lists every file under the chosen folder,
   * subfolders included (capped - see {@link PickedFolder.truncated}). Like
   * {@link pickPrintFolder}, must be called from a real click. Resolves `null`
   * if the user cancels. The plugin never sees a path: it gets the folder's
   * display name and `/`-separated paths relative to it, and can read those
   * files back through {@link readPickedFile}. Picking again replaces the
   * previous grant.
   */
  pickFolder(): Promise<PickedFolder | null>;
  /**
   * Reads one file of the folder last picked with {@link pickFolder}, by the
   * `relPath` it was listed under. `"text"` (default) decodes UTF-8; `"bytes"`
   * returns the raw `Uint8Array`. Rejects if nothing has been picked, the path
   * escapes the folder, or the file can no longer be read.
   */
  readPickedFile(relPath: string, as?: "text" | "bytes"): Promise<string | Uint8Array>;
}

/** One file of a {@link PickedFolder}. */
export interface PickedFile {
  /** Path relative to the picked folder, `/`-separated, no leading slash. */
  relPath: string;
  /** Size in bytes. */
  size: number;
}

export interface PickedFolder {
  /** The folder's display name (never its full path). */
  name: string;
  files: PickedFile[];
  /** True when the folder held more than the host's listing cap, so `files` is incomplete. */
  truncated?: boolean;
}

/** One entry of a save dialog's format filter, e.g. `{ description: "DXF", accept: { "application/dxf": [".dxf"] } }`. */
export interface SaveFileFilter {
  description: string;
  accept: Record<string, string[]>;
}

export interface SaveFileResult {
  saved: boolean;
  /** The name actually saved as, when `saved` is true. */
  name?: string;
}

export interface PrintOptions {
  /**
   * A name for the sheet, used when the host is set to save a copy of every
   * print into a folder (no extension, no path — the host sanitises it).
   */
  fileName?: string;
  /**
   * The same sheet as a PDF. When present it is what gets filed into the
   * autosave folder (`<fileName>.pdf`) instead of a standalone HTML copy —
   * the printer still gets `bodyHtml`, so the two are the same document by
   * construction.
   */
  pdf?: Uint8Array;
}

export interface PrintFolderInfo {
  /** False where the browser has no folder picker at all (Firefox, Safari). */
  supported: boolean;
  /** The chosen folder's display name, or null if there isn't one yet. */
  folder: string | null;
  /** Whether a copy is actually filed on each print. */
  enabled: boolean;
}

export interface UiShowOptions {
  title?: string;
  width?: number;
  height?: number;
}

export interface NotifyOptions {
  /** Milliseconds before auto-dismiss. */
  timeout?: number;
  /** Styles the toast as an error. */
  error?: boolean;
}

export type Unsubscribe = () => void;

/**
 * Contribution registration. Unlike the rest of this interface, `register` is
 * **synchronous and local** to the sandbox — it doesn't cross the RPC boundary.
 * The plugin declares each contribution in its manifest's `contributes` block
 * (so the host knows the id up front) and registers the handler here during
 * `activate`. The host later *invokes* the handler — when the user runs the
 * command, applies the generator, or picks the IO format — by messaging the
 * sandbox; only the handler's plain-data input and result cross the boundary.
 *
 * Capability enforcement is unchanged: a generator/importer's returned
 * `Command[]` is applied by the host through the same `write-document` gate as
 * {@link DocumentApi.apply}, and a command handler's own API calls are each
 * gated as usual. Registering a handler grants nothing by itself.
 */
export interface CommandsApi {
  /** Handle a contributed command (a palette/menu action). Matches a `contributes.commands[].id`. */
  register(id: string, handler: CommandHandler): void;
}

export interface GeneratorsApi {
  /** Handle a contributed generator (selection in → `Command[]` out). Matches a `contributes.generators[].id`. */
  register(id: string, handler: GeneratorHandler): void;
}

export interface IoApi {
  /** Handle export to a contributed IO format: read-model in → serialized text out. */
  registerExporter(id: string, handler: ExporterHandler): void;
  /** Handle import from a contributed IO format: file text in → `Command[]` out. */
  registerImporter(id: string, handler: ImporterHandler): void;
}

/** A contributed command handler. Runs its effect through the host API it was given in `activate`. */
export type CommandHandler = (ctx: CommandContext) => void | Promise<void>;
export interface CommandContext {
  /** Optional invocation payload (e.g. arguments from a caller). */
  readonly input?: unknown;
}

/**
 * A contributed generator: pure selection-in → `Command[]`-out. The host
 * applies the returned commands as a single undo step (requires
 * `write-document`) and never trusts the handler to mutate on its own.
 */
export type GeneratorHandler = (ctx: GeneratorContext) => Command[] | Promise<Command[]>;
export interface GeneratorContext {
  /** A fresh snapshot of the document (host-provided; requires `read-document`). */
  readonly document: DocumentReadModel;
  /** The entity ids selected when the generator was invoked. */
  readonly selection: EntityId[];
  /** Optional parameters for the generation (e.g. a pattern spec). */
  readonly input?: unknown;
}

/** A contributed exporter: the document read-model in, serialized text out. */
export type ExporterHandler = (ctx: ExporterContext) => string | Promise<string>;
export interface ExporterContext {
  readonly document: DocumentReadModel;
}

/** A contributed importer: file text in, `Command[]` out (applied by the host as one undo step). */
export type ImporterHandler = (ctx: ImporterContext) => Command[] | Promise<Command[]>;
export interface ImporterContext {
  readonly text: string;
}

/**
 * The host API contract version. Independent of the app version. A plugin's
 * `engines.sketchor` is a semver range checked against this at load time; an
 * incompatible plugin is refused rather than failing at runtime.
 *
 * 0.2.0 (Phase 2, additive) added the `commands`/`generators`/`io` contribution
 * registration surface. 0.3.0 (Phase 3) reshaped `ui.show(options)` into
 * `ui.show(html, options)` for the sandboxed-iframe panel — a breaking change to
 * the `ui` sub-API, hence the minor bump on a pre-1.0 line. 0.4.0 added the
 * ambient, permission-free {@link AppApi} (`app.displayUnit`) — additive.
 * 0.5.0 added `ui.print(bodyHtml)` — additive. 0.6.0 added its optional
 * `options.fileName`, which names the copy the host saves into the user's
 * chosen folder — additive again. 0.7.0 added `options.pdf` (the sheet as a
 * PDF, which is what the folder then receives) and the `ui.printFolder` /
 * `ui.pickPrintFolder` pair, so a plugin can offer that folder in its own
 * panel instead of only in the print bar — additive. 0.8.0 added
 * `ui.saveFile(name, data, filters)`, a save-as dialog a plugin can trigger
 * directly — additive. 0.9.0 added `ui.pickFolder()` / `ui.readPickedFile()`,
 * a folder picker that lists files (subfolders included) and reads them back
 * — additive. 0.10.0 added `app.openDocumentTab(name, commands)`, which opens a
 * new tab holding a plugin-built drawing (the nest result) — additive.
 */
export const HOST_API_VERSION = "0.10.0";
