/**
 * Which button or shortcut was used — the `action` event.
 *
 * Buttons are recognised by their `data-testid`, which every toolbar and
 * panel button already carries for the UI tests, so nothing in the
 * components is touched. `TRACKED_BUTTONS` is a whitelist: a click on any
 * element that isn't in it is ignored. Ids the app builds at runtime are
 * handled by `TRACKED_PREFIXES`, one rule per family, and each rule either
 * keeps a suffix that is an app constant (a tool, a snap kind, a constraint
 * kind — checked against the real lists, so `snap-popover` and
 * `constraint-panel` don't slip through as kinds) or drops it because it is
 * the user's words or someone's private plugin (`layer-<name>`,
 * `structure-part-<name>`, `install-<plugin id>`). Anything with no rule —
 * `tab-<id>`, `file-explorer-tag-<tag>`, `structure-part-<name>` — stays
 * uncounted.
 *
 * Shortcuts are recognised the same way the app dispatches them — through
 * `matchesBinding` against the rebindable `ACTIONS` — so a rebound key is
 * still counted under its action. A few bindings are mode-dependent in the
 * app (toggle-construction only while idle, say), so this can overcount
 * those by a keypress that did nothing; it's a usage signal, not an audit.
 * `COMMAND_LINE_ACTIONS` closes the fourth dispatch path: the command line
 * reports the action it resolved to, never the line that was typed.
 *
 * Where a button and a shortcut do the same thing they report the *same*
 * action id (`view.ortho`, `app.toggleProperties`, ...) and are told apart
 * by `source` — one series per feature, split by how it was reached.
 *
 * `actions.test.ts` checks every id in the table against the components, so
 * a renamed test id fails a test instead of silently zeroing a chart.
 */

import { CONSTRAINT_LABELS } from "@sketchor/core";
import { ACTIONS, matchesBinding } from "../keybindings";
import { SNAP_KIND_LABELS } from "../tools/snapSettings";
import type { AppCommandId } from "../tools/commandLine";

/** `data-testid` -> action id. Keep the ids stable: they're chart series. */
export const TRACKED_BUTTONS: Record<string, string> = {
  // Top bar: files
  "open-file": "file.open",
  "overlay-file": "file.overlay",
  "save-file": "file.saveMenu",
  "save-now": "file.save",
  "save-as-dxf": "file.saveAs.dxf",
  "save-as-svg": "file.saveAs.svg",
  "save-as-eps": "file.saveAs.eps",
  "save-copy-eps": "file.saveCopy.eps",
  "save-copy-dxf": "file.saveCopy.dxf",
  "save-copy-svg": "file.saveCopy.svg",
  print: "file.print",
  undo: "edit.undo",
  redo: "edit.redo",
  // Top bar: panels and windows
  "toggle-layers": "app.toggleLayers",
  "toggle-properties": "app.toggleProperties",
  "toggle-constraints": "app.toggleConstraints",
  "toggle-blocks": "app.toggleBlocks",
  "toggle-code": "app.toggleCode",
  "toggle-diagnostics": "app.toggleDiagnostics",
  "toggle-duplicates": "app.toggleDuplicates",
  "toggle-pattern": "app.togglePattern",
  "plugin-menu": "app.pluginMenu",
  "plugin-menu-manage": "app.plugins",
  "toggle-file-browser": "app.toggleFileBrowser",
  "toggle-connectivity-hint": "view.connectivityHint",
  "toggle-closed-regions": "view.closedRegions",
  "truck-nesting-open": "app.truckNesting",
  "toggle-shortcuts": "app.shortcuts",
  "toggle-touch-mode": "app.touchMode",
  "check-updates": "app.updateMenu",
  "brand-link": "app.site",
  // Status bar: the drafting aids, and the popovers they open
  "toggle-ortho": "view.ortho",
  "toggle-polar": "view.polar",
  "toggle-otrack": "view.otrack",
  "toggle-command-line": "view.commandLine",
  "toggle-snaps": "view.snapMenu",
  "toggle-select-by": "edit.selectBy",
  "select-by-apply": "edit.selectByApply",
  // Update popover / banner
  "update-check": "update.check",
  "update-now": "update.install",
  "banner-update-now": "update.install",
  "update-restart": "update.restart",
  "banner-restart": "update.restart",
  "update-auto": "update.auto",
  // Panels
  "diag-rescan": "heal.rescan",
  "diag-fix-one": "heal.fixOne",
  "diag-fix-all": "heal.fixAll",
  "dup-rescan": "duplicates.rescan",
  "dup-fix-one": "duplicates.fixOne",
  "dup-fix-all": "duplicates.fixAll",
  "pattern-kind-rect": "pattern.kindRect",
  "pattern-kind-circular": "pattern.kindCircular",
  "pattern-rotate": "pattern.rotate",
  "pattern-apply": "pattern.apply",
  "straighten-apply": "straighten.apply",
  "hatch-convert": "hatch.convertFills",
  "code-apply": "code.apply",
  "toggle-glyphs": "constraints.glyphs",
  "prop-closed": "properties.closed",
  "prop-dashed": "properties.construction",
  "prop-linetype": "properties.linetype",
  "prop-lineweight": "properties.lineweight",
  "prop-reverse": "properties.reverse",
  "prop-vertices-toggle": "properties.vertices",
  "layer-add": "layers.add",
  "layer-clean-empty": "layers.cleanEmpty",
  "layer-flatten": "layers.flatten",
  "measure-pin": "measure.pin",
  "measure-copy": "measure.copy",
  "measure-clear-pins": "measure.clearPins",
  // The file browser
  "file-explorer-open-folder": "files.openFolder",
  "file-explorer-add-files": "files.addFiles",
  "file-explorer-export-selected": "files.exportSelected",
  "file-explorer-view-grid": "files.viewGrid",
  "file-explorer-view-list": "files.viewList",
  "file-explorer-sort-name": "files.sortName",
  "file-explorer-sort-date": "files.sortDate",
  "file-explorer-tags-clear": "files.tagsClear",
  // Plugins
  "install-plugin": "plugins.install",
  "install-approve": "plugins.installApprove",
  "plugins-tab-installed": "plugins.tabInstalled",
  "plugins-tab-browse": "plugins.tabBrowse",
  // The 3D viewer: toolbar, and the structure panel's context menu
  "model-view-iso": "model.viewIso",
  "model-view-top": "model.viewTop",
  "model-view-front": "model.viewFront",
  "model-view-right": "model.viewRight",
  "model-fit": "model.fit",
  "model-edges": "model.edges",
  "model-isolate": "model.isolate",
  "model-hide": "model.hide",
  "model-show-all": "model.showAll",
  "structure-show-all": "model.showAll",
  "structure-menu-isolate": "model.isolate",
  "structure-menu-hide": "model.hide",
  "structure-menu-zoom": "model.zoomTo",
  "structure-menu-show-all": "model.showAll",
};

const SNAP_KINDS = new Set<string>(SNAP_KIND_LABELS.map((k) => k.id));
/** Every tool the rail can show, from the same `ToolId` union the rail renders. */
const TOOL_IDS = new Set<string>(ACTIONS.filter((a) => a.id.startsWith("tool.")).map((a) => a.id.slice("tool.".length)));

/** "point-on-curve" -> "pointOnCurve", so a kind can be an id segment. */
const camel = (s: string): string => s.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());

/** Only counts a plugin's row button, not one of the app's own `install-*`/`update-*` ids. */
const byPluginId =
  (action: string) =>
  (suffix: string): string | null =>
    // Plugin ids are reverse-DNS ("com.acme.gear-generator", see manifest.ts),
    // so the dot tells a plugin apart from "install-prompt" or "update-banner"
    // — and the id itself is dropped either way.
    suffix.includes(".") ? action : null;

/**
 * Rules for the ids the app builds at runtime, tried in order, so a specific
 * prefix must come before the family it sits in (`constraint-remove-` before
 * `constraint-`). A rule returning null means "not this family" and the id
 * goes uncounted.
 */
export const TRACKED_PREFIXES: [prefix: string, action: (suffix: string) => string | null][] = [
  // Tool ids are constants (TOOLS in App.tsx), so the suffix is safe — but
  // it has to be one of them, or the status bar's "tool-prompt" becomes a tool.
  ["tool-", (s) => (TOOL_IDS.has(s) ? `tool.${s}` : null)],
  // Plugin ids aren't: count the export/command, not which plugin's.
  ["plugin-export-", () => "file.exportPlugin"],
  ["plugin-cmd-", () => "plugin.command"],
  // Constraints: the kinds are core constants, the row ids are document ids.
  ["constraint-remove-", () => "constraints.remove"],
  ["constraint-row-", () => "constraints.select"],
  ["constraint-", (s) => (s in CONSTRAINT_LABELS ? `constraints.apply.${camel(s)}` : null)],
  // Snap kinds are constants too (SNAP_KIND_LABELS).
  ["snap-", (s) => (SNAP_KINDS.has(s) ? `snap.${camel(s)}` : null)],
  // Which entity types someone filtered by is more detail than this needs.
  ["select-by-type-", () => "edit.selectByType"],
  // Layer names are the user's words — keep the verb, drop the name.
  ["layer-toggle-", () => "layers.visibility"],
  ["layer-lock-", () => "layers.lock"],
  ["layer-delete-", () => "layers.delete"],
  // Polyline vertex rows: the suffix is a row index.
  ["prop-vertex-add-", () => "properties.vertexAdd"],
  ["prop-vertex-arc-", () => "properties.vertexArc"],
  ["prop-vertex-remove-", () => "properties.vertexRemove"],
  // The fill palette's swatches, and the file browser's column headers.
  ["hatch-swatch-", () => "hatch.swatch"],
  ["file-explorer-col-", () => "files.sortColumn"],
  // Plugin rows in the manage/browse lists.
  ["uninstall-", byPluginId("plugins.uninstall")],
  ["install-", byPluginId("plugins.installRegistry")],
  ["update-", byPluginId("plugins.updateRegistry")],
];

/** Maps a clicked element's test id to an action id, or null to ignore it. */
export function actionForTestId(testId: string): string | null {
  const exact = TRACKED_BUTTONS[testId];
  if (exact) return exact;
  for (const [prefix, action] of TRACKED_PREFIXES) {
    if (testId.startsWith(prefix)) {
      const id = action(testId.slice(prefix.length));
      if (id) return id;
    }
  }
  return null;
}

/** The action a click landed on: the nearest ancestor with a tracked test id. */
export function actionForClick(target: EventTarget | null): string | null {
  const el = target as { closest?: (sel: string) => Element | null } | null;
  const hit = el?.closest?.("[data-testid]");
  const id = hit?.getAttribute("data-testid");
  return id ? actionForTestId(id) : null;
}

type KeyLike = { ctrlKey: boolean; metaKey: boolean; altKey: boolean; shiftKey: boolean; key: string };

/**
 * The action a keydown fires, by the same rules as the app's handlers:
 * nothing while typing in a field, and "mouse.*" bindings are modifiers
 * held during a click, not shortcuts.
 */
export function actionForKeydown(e: KeyLike, targetTagName: string): string | null {
  if (targetTagName === "INPUT" || targetTagName === "TEXTAREA") return null;
  for (const a of ACTIONS) {
    if (a.id.startsWith("mouse.")) continue;
    if (matchesBinding(e, a.id)) return a.id;
  }
  return null;
}

/**
 * What a typed command counts as. The command line's own ids are bare words
 * (`selectAll`), so they're mapped onto the action ids a button or a shortcut
 * would report — the same series, a different `source`. `actions.test.ts`
 * checks every alias the command line accepts is in here.
 */
export const COMMAND_LINE_ACTIONS: Record<AppCommandId, string> = {
  undo: "edit.undo",
  redo: "edit.redo",
  delete: "edit.delete",
  selectAll: "edit.selectAll",
  invertSelection: "edit.invertSelection",
  selectSimilar: "edit.selectSimilar",
  join: "edit.join",
  explode: "edit.explode",
  simplify: "edit.simplify",
  group: "edit.group",
  ungroup: "edit.ungroup",
  fit: "view.fit",
  zoomPrevious: "view.zoomPrevious",
  relativeZero: "edit.relativeZero",
  save: "file.save",
  open: "file.open",
  cancel: "edit.cancel",
  blockEdit: "block.edit",
  blockSave: "block.save",
  blockClose: "block.close",
  attEdit: "block.attedit",
  attExport: "block.attout",
  dimStyles: "dim.styles",
  dimTextReset: "dim.textReset",
  dimTextLeader: "dim.textLeader",
  dimFlip: "dim.flipArrows",
  dimSpace: "dim.space",
  dimOblique: "dim.oblique",
  dimRestyle: "dim.restyle",
  dimReassoc: "dim.reassociate",
};

/** "palette"/"command-line" are sent by their own components; the listeners here only see the other two. */
export type ActionSource = "button" | "key" | "palette" | "command-line";

/** Installs the document-wide listeners. No-op outside a browser. Returns the uninstaller. */
export function installActionTracking(report: (id: string, source: ActionSource) => void): () => void {
  if (typeof document === "undefined") return () => undefined;
  const onClick = (e: MouseEvent) => {
    const id = actionForClick(e.target);
    if (id) report(id, "button");
  };
  const onKey = (e: KeyboardEvent) => {
    const id = actionForKeydown(e, (e.target as HTMLElement | null)?.tagName ?? "");
    if (id) report(id, "key");
  };
  document.addEventListener("click", onClick);
  window.addEventListener("keydown", onKey);
  return () => {
    document.removeEventListener("click", onClick);
    window.removeEventListener("keydown", onKey);
  };
}
