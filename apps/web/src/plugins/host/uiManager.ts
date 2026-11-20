import type { UiShowOptions } from "@sketchor/core";

/**
 * Owns plugin **panel** state on the main thread — the bridge between the RPC
 * `ui.*` host methods (which run without any DOM) and the React panel container
 * that actually mounts a sandboxed iframe. The plugin's logic lives in its
 * worker; its UI lives in a separate `sandbox="allow-scripts"` iframe with an
 * opaque origin, so it can reach neither `window.sketchor` nor the host DOM. The
 * only channel between panel and plugin is `postMessage`, relayed here:
 *
 *   panel  ──postMessage({pluginMessage})──▶ host (this) ──▶ worker `ui.onMessage`
 *   worker `ui.postMessage` ──▶ host (this) ──postMessage({pluginMessage})──▶ panel
 *
 * A panel is identified by `event.source === iframe.contentWindow` — an opaque
 * sandboxed frame has `origin === "null"`, so source-matching, not origin, is
 * what safely attributes a message to a plugin.
 */

export interface PanelState {
  readonly pluginId: string;
  readonly html: string;
  readonly title: string;
  readonly width?: number;
  readonly height?: number;
}

type ChangeListener = () => void;
type PanelMessageListener = (message: unknown) => void;

const panels = new Map<string, PanelState>();
const frames = new Map<string, HTMLIFrameElement>();
const inbound = new Map<string, Set<PanelMessageListener>>();
const changeListeners = new Set<ChangeListener>();

let windowListenerAttached = false;

function emitChange(): void {
  for (const l of changeListeners) l();
}

/** React subscribes so it re-renders the panel dock when panels open/close. */
export function onPanelsChange(listener: ChangeListener): () => void {
  changeListeners.add(listener);
  return () => changeListeners.delete(listener);
}

export function listPanels(): PanelState[] {
  return [...panels.values()];
}

// --- called by the RPC host methods (per plugin) ---

export function showPanel(pluginId: string, html: string, options: UiShowOptions | undefined): void {
  ensureWindowListener();
  panels.set(pluginId, {
    pluginId,
    html,
    title: options?.title ?? pluginId,
    width: options?.width,
    height: options?.height,
  });
  emitChange();
}

export function isPanelOpen(pluginId: string): boolean {
  return panels.has(pluginId);
}

export function hidePanel(pluginId: string): void {
  if (panels.delete(pluginId)) emitChange();
}

/** Removes everything for a plugin (on unload). */
export function removePluginUi(pluginId: string): void {
  frames.delete(pluginId);
  inbound.delete(pluginId);
  hidePanel(pluginId);
}

/** Host → panel: deliver a worker message to the plugin's iframe. */
export function postToPanel(pluginId: string, message: unknown): void {
  frames.get(pluginId)?.contentWindow?.postMessage({ pluginMessage: message }, "*");
}

/** Worker subscribes (via `ui.onMessage`) to messages coming from its panel. */
export function subscribeToPanel(pluginId: string, listener: PanelMessageListener): () => void {
  let set = inbound.get(pluginId);
  if (!set) {
    set = new Set();
    inbound.set(pluginId, set);
  }
  set.add(listener);
  return () => inbound.get(pluginId)?.delete(listener);
}

// --- called by React ---

/** The panel iframe registers itself on mount so the manager can address it. */
export function registerFrame(pluginId: string, iframe: HTMLIFrameElement): () => void {
  frames.set(pluginId, iframe);
  return () => {
    if (frames.get(pluginId) === iframe) frames.delete(pluginId);
  };
}

// --- panel → host message routing ---

function ensureWindowListener(): void {
  if (windowListenerAttached || typeof window === "undefined") return;
  windowListenerAttached = true;
  window.addEventListener("message", (e: MessageEvent) => {
    // Attribute the message by matching the frame that sent it — the frame's
    // opaque origin ("null") can't be trusted, but its contentWindow identity can.
    for (const [pluginId, iframe] of frames) {
      if (e.source && e.source === iframe.contentWindow) {
        const data = e.data as { pluginMessage?: unknown } | undefined;
        if (data && "pluginMessage" in data) {
          for (const l of inbound.get(pluginId) ?? []) l(data.pluginMessage);
        }
        return;
      }
    }
  });
}
