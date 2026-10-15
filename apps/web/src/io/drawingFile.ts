import { type BlockDefinition, type ForeignRecord, type TextStyle, decodeDxfBytes, sizeWarning, entitiesToDxf, entitiesToDxf2018, entitiesToEps, entitiesToEpsFile, entitiesToSvgDocument, flattenInserts } from "@sketchor/core";
import { DWG_UNREADABLE, dwgToDxfText } from "../browser/dwgImport";
import { isModelFile, loadModel } from "../model3d/stepImport";
import { acceptList, allExtensions, formatOf } from "./formats";
import { importEpsBlob } from "./epsImport";
import {
  doc,
  finishSessionSave,
  getActiveSession,
  getSessions,
  importDxfText,
  importEntities,
  importEpsResult,
  importSvgText,
  overlayEpsResult,
  overlaySvgText,
  isModelSession,
  openIntoSession,
  saveBlockEdit,
  openModelIntoSession,
  overlayDxfText,
  overlayEntities,
  useApp,
} from "../state/store";
import { displayUnitToDxfCode, factorFromMm } from "../units";
import { reportError, track } from "../metrics/metrics";

/**
 * Save / open of Sketchor's supported drawing formats: DXF and SVG for
 * both directions, plus DWG import (read-only — see dwgImport.ts and
 * NOTICE.md for why there's no DWG export) and STEP/IGES 3D models
 * (view-only, in their own tab — see model3d/).
 *
 * Prefers the File System Access API (`showSaveFilePicker` / `showOpenFilePicker`),
 * which is available both in Chromium browsers and in Tauri's WebView2, so the
 * same code path serves the web app and the desktop shell. Falls back to a
 * download / hidden `<input type=file>` where the API is missing.
 */

export type SaveFormat = "dxf" | "dxf-r12" | "dxf-r12-blocks" | "svg" | "svg-laser" | "eps" | "eps-preview";

const SAVE_FORMAT: Record<SaveFormat, { mime: string; description: string }> = {
  dxf: { mime: "application/dxf", description: "DXF Drawing" },
  "dxf-r12": { mime: "application/dxf", description: "DXF R12 Drawing (CAM)" },
  "dxf-r12-blocks": { mime: "application/dxf", description: "DXF R12 Drawing (keeps blocks)" },
  svg: { mime: "image/svg+xml", description: "SVG Drawing" },
  "svg-laser": { mime: "image/svg+xml", description: "SVG for laser / CAM (hairlines, one colour per layer)" },
  eps: { mime: "application/postscript", description: "Encapsulated PostScript" },
  "eps-preview": { mime: "application/postscript", description: "Encapsulated PostScript with TIFF preview" },
};

/**
 * Which DXF flavour a plain "Save"/"Save As DXF" writes (X-01): AC1032
 * ("DXF 2018") by default — what modern CAD expects, with handles and
 * entity-name XDATA that round-trips through Sketchor itself — except a
 * file **opened** as R12 saves back as R12, since CAM/laser shops that hand
 * out R12 files generally want flat geometry back, not a format upgrade.
 * `dxf-r12` (an explicit "Save As DXF R12") always writes R12 regardless of
 * what the tab was opened from.
 */
const dxfSourceVersions = new Map<string, "r12" | "2018">();

/** Reads `$ACADVER` out of a DXF's HEADER section without a full parse. */
function detectDxfVersion(text: string): "r12" | "2018" {
  const m = text.match(/\$ACADVER\s*\n\s*1\s*\n\s*(AC\d+)/);
  // AC1009 and older are R12-and-earlier (all geometry, no handles/tables
  // worth preserving); anything from AC1012 (R13) on gets the modern writer.
  return m && m[1] <= "AC1009" ? "r12" : "2018";
}

/** Call after a DXF has been loaded into the active tab, so a later plain Save writes back in the same flavour. */
export function bindDxfVersion(text: string): void {
  dxfSourceVersions.set(activeSessionId(), detectDxfVersion(text));
}

// Minimal shape of the File System Access API we use — declared locally so we
// don't need the `@types/wicg-file-system-access` package. Supported by
// Chromium browsers and Tauri's WebView2.
interface PickerType {
  description?: string;
  accept: Record<string, string[]>;
}
interface FsWritable {
  write(data: string | Uint8Array): Promise<void>;
  close(): Promise<void>;
}
interface FsFileHandle {
  name: string;
  createWritable(): Promise<FsWritable>;
  getFile(): Promise<File>;
}
interface WindowWithFS extends Window {
  showSaveFilePicker?: (opts: {
    suggestedName?: string;
    types?: PickerType[];
  }) => Promise<FsFileHandle>;
  showOpenFilePicker?: (opts: {
    multiple?: boolean;
    types?: PickerType[];
  }) => Promise<FsFileHandle[]>;
}

const OPEN_TYPES: PickerType[] = [
  { description: "Drawing or 3D model", accept: { "application/octet-stream": allExtensions().map((e) => `.${e}`) } },
];
const OPEN_ACCEPT = acceptList();

function serialize(format: SaveFormat): string | Uint8Array {
  // B-08: real blocks go to AC1032 DXF, plain SVG and "DXF R12 (keeps blocks)". Plain R12 is what CAM/laser shops read flat
  // (and a tab opened from an R12 file saves back flat), laser SVG goes to software that does not follow <use>, and EPS has no
  // block concept, so those stay flattened on purpose.
  const blocks = doc.records("blocks") as BlockDefinition[];
  const r12 = format === "dxf-r12" || format === "dxf-r12-blocks" || (format === "dxf" && dxfSourceVersions.get(activeSessionId()) === "r12");
  const keepBlocks = blocks.length > 0 && (!r12 || format === "dxf-r12-blocks") && format !== "svg-laser" && format !== "eps" && format !== "eps-preview";
  const entities = keepBlocks ? doc.all() : flattenInserts(doc, doc.all());
  if (format === "eps" || format === "eps-preview") {
    // EPS has no blocks (flattened above). Text-only for plain EPS; the preview variant is a binary DOS-EPS file.
    const title = defaultSaveName(format).replace(/\.eps$/i, "");
    return format === "eps" ? entitiesToEps(entities, { title }) : entitiesToEpsFile(entities, { title, tiffPreview: true });
  }
  if (format === "dxf" || format === "dxf-r12" || format === "dxf-r12-blocks") {
    const displayUnit = useApp.getState().displayUnit;
    // Stored coordinates are always millimeters — rescale to match the
    // declared unit so the file's numbers represent real-world size.
    const insUnits = displayUnitToDxfCode(displayUnit);
    const scale = factorFromMm(displayUnit);
    return r12 ? entitiesToDxf(entities, insUnits, scale, keepBlocks ? blocks : undefined) : entitiesToDxf2018(entities, { insUnits, scale, textStyles: doc.records("textStyles") as TextStyle[], dimStyles: doc.records("dimStyles"), ...(doc.settings.currentDimStyle ? { currentDimStyle: doc.settings.currentDimStyle } : {}), ...(keepBlocks ? { blocks } : {}), groups: doc.groups(), constraints: doc.constraints(), params: doc.records("params"), foreign: doc.records("foreign") as ForeignRecord[] });
  }
  // True physical size: inches only when the tab works in inches/feet.
  const displayUnit = useApp.getState().displayUnit;
  return entitiesToSvgDocument(entities, { unit: displayUnit === "in" || displayUnit === "ft" ? "in" : "mm", mode: format === "svg-laser" ? "laser" : "document", ...(keepBlocks ? { blocks } : {}) });
}

/* ----------------------------- save targets ----------------------------- */

/**
 * The real file a tab is bound to, so a plain "Save" overwrites the drawing
 * the user actually opened instead of reprompting for a location.
 *
 * Two flavours, because a file reaches a tab two different ways:
 * - `handle` — picked through the File System Access API (Ctrl+O, Save As,
 *   or a folder chosen in the file browser on the web build).
 * - `path` — a native path from the desktop build: the file browser's folder
 *   listing and the OS file association both hand us a path, never a handle.
 *   Written back through the `write_drawing_file` Tauri command.
 *
 * Keyed by session id rather than stored on DocSession to avoid a circular
 * import (store.ts doesn't need to know about file handles).
 */
export type SaveTarget =
  | { kind: "handle"; handle: FsFileHandle; format: SaveFormat; name: string }
  | { kind: "path"; path: string; format: SaveFormat; name: string };

const saveTargets = new Map<string, SaveTarget>();

/** The format a filename implies, or null when it isn't something we can write (DWG, 3D models). */
function writableFormat(name: string): SaveFormat | null {
  const f = formatOf(name);
  if (f && !f.writable) return null; // DWG is import-only, 3D models are view-only
  return f?.ext[0] === "svg" ? "svg" : f?.ext[0] === "eps" ? "eps" : "dxf";
}

function activeSessionId(): string {
  return useApp.getState().activeSessionId;
}

/** The file the active tab would overwrite on a plain Save, or null if it has none yet. */
export function activeSaveTarget(): SaveTarget | null {
  return saveTargets.get(activeSessionId()) ?? null;
}

/**
 * Binds the active tab to a file opened by full native path (desktop file
 * browser, or a drawing opened from Explorer). Call after the drawing has
 * been loaded, so `activeSessionId` is the tab it landed in.
 */
export function bindSavePath(path: string, name = path.split(/[\\/]/).pop() ?? path): void {
  const format = writableFormat(name);
  if (!format) return;
  saveTargets.set(activeSessionId(), { kind: "path", path, format, name });
}

/** Binds the active tab to a File System Access handle (web file browser / pickers). */
export function bindSaveHandle(handle: FsFileHandle): void {
  const format = writableFormat(handle.name);
  if (!format) return;
  saveTargets.set(activeSessionId(), { kind: "handle", handle, format, name: handle.name });
}

function toBase64(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

async function writeTarget(target: SaveTarget, text: string | Uint8Array): Promise<void> {
  if (target.kind === "handle") {
    const writable = await target.handle.createWritable();
    await writable.write(text);
    await writable.close();
    return;
  }
  const { invoke } = await import("@tauri-apps/api/core");
  if (typeof text === "string") await invoke("write_drawing_file", { path: target.path, contents: text });
  else await invoke("write_drawing_bytes", { path: target.path, base64: toBase64(text) });
}

function noticeSaved(name: string): void {
  useApp.getState().setSaveNotice({ kind: "saved", message: `Saved ${name}`, at: Date.now() });
}

/**
 * - "save": overwrite the tab's bound file silently if there is one;
 *   otherwise behaves like "save-as" (nothing to overwrite yet).
 * - "save-as": always prompts for a location and becomes the tab's file for
 *   future plain saves.
 * - "save-copy": always prompts for a location but leaves the tab bound to
 *   whatever file it already had (a branch-off, not a switch).
 */
export type SaveMode = "save" | "save-as" | "save-copy";

/**
 * What the save dialog should be pre-filled with: the tab's own filename,
 * re-extensioned for the format being written, so saving an opened
 * `bracket.dxf` suggests `bracket.dxf` (or `bracket.svg`) rather than a
 * generic `drawing.dxf`. Falls back to `drawing.<fmt>` for a tab that has
 * never been named (an untouched "Untitled-1").
 */
/** The real file extension for a {@link SaveFormat} — "dxf" and "dxf-r12" are both plain `.dxf` files, "svg" and "svg-laser" both `.svg`. */
function fileExtension(format: SaveFormat): string {
  return format === "dxf-r12" || format === "dxf-r12-blocks" ? "dxf" : format === "svg-laser" ? "svg" : format === "eps-preview" ? "eps" : format;
}

function defaultSaveName(format: SaveFormat): string {
  const target = activeSaveTarget();
  const base = target?.name ?? getSessions().find((s) => s.id === activeSessionId() && s.named)?.name;
  const ext = fileExtension(format);
  if (!base) return `drawing.${ext}`;
  return `${base.replace(/\.(dxf|svg|dwg|eps|ai|step|stp|iges|igs)$/i, "")}.${ext}`;
}

/** Saves the current drawing as DXF or SVG. No-op if the location prompt is cancelled. */
export async function saveDrawing(format: SaveFormat, suggestedName?: string, mode: SaveMode = "save"): Promise<void> {
  if (getActiveSession().blockEdit && mode === "save") {
    // A block-editor tab saves into its drawing's block table (B-04), not to a file.
    const err = saveBlockEdit();
    if (err) useApp.getState().setSaveNotice({ kind: "error", message: err, at: Date.now() });
    return;
  }
  if (isModelSession(getActiveSession())) {
    // A model tab has no drawing behind it; saving would write an empty DXF.
    useApp.getState().setSaveNotice({ kind: "error", message: "3D models are view-only — nothing to save", at: Date.now() });
    return;
  }
  const text = serialize(format);
  const { mime, description } = SAVE_FORMAT[format];
  const w = window as WindowWithFS;
  const sessionId = activeSessionId();
  const name = suggestedName ?? defaultSaveName(format);

  if (mode === "save") {
    const target = saveTargets.get(sessionId);
    if (target && target.format === format) {
      try {
        await writeTarget(target, text);
        finishSessionSave(target.name);
        noticeSaved(target.name);
        track("file_saved", { format, mode });
        return;
      } catch (err) {
        // Target went stale (file moved/deleted, permission revoked). Say so
        // rather than silently reopening the picker, which looks like the save
        // was simply ignored.
        useApp.getState().setSaveNotice({
          kind: "error",
          message: `Couldn't write ${target.name} — choose a location`,
          at: Date.now(),
        });
        reportError(err, "save", { format, target: target.kind });
      }
    }
  }

  if (typeof w.showSaveFilePicker === "function") {
    try {
      const handle = await w.showSaveFilePicker({
        suggestedName: name,
        types: [{ description, accept: { [mime]: [`.${fileExtension(format)}`] } }],
      });
      await writeTarget({ kind: "handle", handle, format, name: handle.name }, text);
      if (mode !== "save-copy") {
        saveTargets.set(sessionId, { kind: "handle", handle, format, name: handle.name });
      }
      finishSessionSave(handle.name);
      noticeSaved(handle.name);
      track("file_saved", { format, mode });
    } catch (err) {
      // The user dismissing the picker throws AbortError — treat as a no-op.
      if ((err as DOMException)?.name !== "AbortError") throw err;
    }
    return;
  }

  // Fallback (no File System Access API): trigger a browser download — there's
  // no real file handle to keep, so every save here prompts a download regardless of mode.
  const blob = new Blob([text as BlobPart], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
  finishSessionSave(name);
  noticeSaved(name);
  track("file_saved", { format, mode });
}

/** Plain "Save": overwrites the active tab's bound file in its own format, defaulting to DXF if it has none. */
export async function saveCurrent(): Promise<void> {
  const target = activeSaveTarget();
  await saveDrawing(target?.format ?? "dxf", undefined, "save");
}

/** "Save As": always prompts, pre-filled with the current file's name, and rebinds the tab to the result. */
export async function saveAs(format: SaveFormat = activeSaveTarget()?.format ?? "dxf"): Promise<void> {
  await saveDrawing(format, undefined, "save-as");
}

/**
 * Opens a STEP/IGES model from its raw bytes in a 3D viewer tab. The tab
 * shows immediately and fills in when the (worker-side, cached) read
 * finishes. `buffer` is consumed.
 */
export function openModelBytes(name: string, buffer: ArrayBuffer): void {
  const loading = loadModel(name, buffer, "open");
  openModelIntoSession(name, loading);
  // Once it's in, make sure it has a preview — in the in-app cache and, on
  // the desktop, mirrored for Explorer's file icon (see modelThumbnail.ts).
  loading.then(
    (model) => import("../model3d/modelThumbnail").then(({ ensureThumbnail }) => ensureThumbnail(model)),
    () => undefined,
  ).catch(() => undefined);
}

// Debug / automation hook, alongside the drawing ones in state/store.ts.
window.sketchor.openModel = openModelBytes;

/** A DXF `File` as text, decoded as UTF-8 or its declared codepage (see `decodeDxfBytes`). */
export async function fileDxfText(file: File): Promise<string> {
  return decodeDxfBytes(new Uint8Array(await file.arrayBuffer()));
}

/** Loads a DXF/SVG/DWG `File` into a tab (opening or reusing one — see openIntoSession), or a STEP/IGES into a viewer tab. */
export async function loadDrawingFile(name: string, file: File): Promise<void> {
  await loadDrawingFileInner(name, file);
  // F-10: a big 2D file opens as usual, with a note on the import banner.
  const warn = isModelFile(name) ? null : sizeWarning(name, file.size);
  if (warn) {
    const app = useApp.getState();
    app.setFileWarnings([warn, ...app.fileWarnings]);
  }
}

async function loadDrawingFileInner(name: string, file: File): Promise<void> {
  if (isModelFile(name)) {
    openModelBytes(name, await file.arrayBuffer());
  } else if (/\.svg$/i.test(name)) {
    const text = await file.text();
    openIntoSession(name, () => importSvgText(text));
  } else if (/\.(eps|ai)$/i.test(name)) {
    const eps = await importEpsBlob(file);
    openIntoSession(name, () => importEpsResult(eps.entities, eps.warnings));
  } else if (/\.dwg$/i.test(name)) {
    const text = await dwgToDxfText(await file.arrayBuffer());
    openIntoSession(name, () => (text ? importDxfText(text) : importEntities([], [DWG_UNREADABLE])));
  } else {
    const text = await fileDxfText(file);
    openIntoSession(name, () => importDxfText(text));
    bindDxfVersion(text);
  }
}

/** Opens a DXF/SVG/DWG file into the canvas, or a STEP/IGES model into a viewer tab. No-op if cancelled. */
export async function openDrawing(): Promise<void> {
  const w = window as WindowWithFS;

  if (typeof w.showOpenFilePicker === "function") {
    try {
      const [handle] = await w.showOpenFilePicker({ multiple: false, types: OPEN_TYPES });
      if (!handle) return;
      const file = await handle.getFile();
      await loadDrawingFile(handle.name, file);
      // DWG has no export path (read-only), so bindSaveHandle ignores it and
      // Save falls through to a prompt.
      bindSaveHandle(handle);
    } catch (err) {
      if ((err as DOMException)?.name !== "AbortError") throw err;
    }
    return;
  }

  // Fallback: a hidden file input.
  await new Promise<void>((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = OPEN_ACCEPT;
    input.onchange = async () => {
      const file = input.files?.[0];
      if (file) await loadDrawingFile(file.name, file);
      resolve();
    };
    input.oncancel = () => resolve();
    input.click();
  });
}

/**
 * Overlays a DXF/SVG/DWG `File` onto the current drawing, on a new layer
 * named after the file — added geometry, not a replacement, so the tab's
 * own file binding and saved unit are untouched. Meant for comparing two
 * revisions of the same drawing: open the base one normally, then overlay
 * the other and toggle its layer to spot what changed.
 */
export async function overlayDrawingFile(name: string, file: File): Promise<{ count: number; warnings: string[]; layer: string }> {
  const label = name.replace(/\.(dxf|svg|dwg|eps|ai)$/i, "");
  if (isModelFile(name)) {
    const warnings = ["3D models open in their own tab and can't be overlaid on a drawing"];
    useApp.getState().setFileWarnings(warnings);
    return { count: 0, warnings, layer: label };
  }
  if (/\.svg$/i.test(name)) {
    const text = await file.text();
    return overlaySvgText(text, label);
  }
  if (/\.(eps|ai)$/i.test(name)) {
    const eps = await importEpsBlob(file);
    return overlayEpsResult(eps.entities, eps.warnings, label);
  }
  if (/\.dwg$/i.test(name)) {
    const text = await dwgToDxfText(await file.arrayBuffer());
    if (text) return overlayDxfText(text, label);
    useApp.getState().setFileWarnings([DWG_UNREADABLE]);
    return { ...overlayEntities([], label), warnings: [DWG_UNREADABLE] };
  }
  const text = await fileDxfText(file);
  return overlayDxfText(text, label);
}

/** Opens a file picker and overlays the chosen DXF/SVG/DWG onto the current drawing (see {@link overlayDrawingFile}). No-op if cancelled. */
export async function overlayDrawing(): Promise<{ count: number; warnings: string[]; layer: string } | null> {
  const w = window as WindowWithFS;

  if (typeof w.showOpenFilePicker === "function") {
    try {
      const [handle] = await w.showOpenFilePicker({ multiple: false, types: OPEN_TYPES });
      if (!handle) return null;
      const file = await handle.getFile();
      return await overlayDrawingFile(handle.name, file);
    } catch (err) {
      if ((err as DOMException)?.name !== "AbortError") throw err;
      return null;
    }
  }

  // Fallback: a hidden file input.
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = acceptList((f) => f.kind === "2d");
    input.onchange = async () => {
      const file = input.files?.[0];
      resolve(file ? await overlayDrawingFile(file.name, file) : null);
    };
    input.oncancel = () => resolve(null);
    input.click();
  });
}
