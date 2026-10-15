/**
 * F-09 — the one table of file formats Sketchor knows. The Open dialogs,
 * the file browser's picker and mime types, "can this be saved back" and the
 * model/drawing split all read it, and `formats.test.ts` checks that the
 * places that can't import it (tauri.conf.json fileAssociations, the Explorer
 * thumbnailer's EXTENSIONS) still agree with it. Add a format here first.
 */

export type FormatKind = "2d" | "3d";

export interface FormatInfo {
  /** Lowercase extensions without the dot; the first is canonical. */
  ext: readonly string[];
  kind: FormatKind;
  label: string;
  mime: string;
  /** Sketchor can write this format back out. */
  writable: boolean;
  /** Registered as an OS file association (tauri.conf.json). */
  association: boolean;
  /** Explorer/Finder thumbnails come from the native shell extension. */
  nativeThumbnail: boolean;
}

export const FORMATS: readonly FormatInfo[] = [
  { ext: ["dxf"], kind: "2d", label: "DXF drawing", mime: "application/dxf", writable: true, association: true, nativeThumbnail: true },
  { ext: ["svg"], kind: "2d", label: "SVG drawing", mime: "image/svg+xml", writable: true, association: true, nativeThumbnail: false },
  { ext: ["dwg"], kind: "2d", label: "DWG drawing", mime: "application/acad", writable: false, association: true, nativeThumbnail: false },
  // EPS/AI: own PostScript-subset importer (core/eps, F-01); import-only (export is F-02).
  { ext: ["eps"], kind: "2d", label: "EPS drawing", mime: "application/postscript", writable: true, association: true, nativeThumbnail: true },
  { ext: ["ai"], kind: "2d", label: "Illustrator drawing", mime: "application/illustrator", writable: false, association: true, nativeThumbnail: true },
  { ext: ["step", "stp"], kind: "3d", label: "STEP model", mime: "model/step", writable: false, association: true, nativeThumbnail: true },
  { ext: ["iges", "igs"], kind: "3d", label: "IGES model", mime: "model/iges", writable: false, association: true, nativeThumbnail: true },
  // Mesh formats (F-05): read in the model worker; OS association and Explorer thumbnails are not wired yet.
  { ext: ["stl"], kind: "3d", label: "STL mesh", mime: "model/stl", writable: false, association: false, nativeThumbnail: false },
  { ext: ["obj"], kind: "3d", label: "OBJ mesh", mime: "model/obj", writable: false, association: false, nativeThumbnail: false },
  { ext: ["3mf"], kind: "3d", label: "3MF model", mime: "model/3mf", writable: false, association: false, nativeThumbnail: false },
  { ext: ["gltf", "glb"], kind: "3d", label: "glTF model", mime: "model/gltf-binary", writable: false, association: false, nativeThumbnail: false },
  { ext: ["ply"], kind: "3d", label: "PLY mesh", mime: "model/ply", writable: false, association: false, nativeThumbnail: false },
];

const extOf = (name: string): string => name.split(/[\\/]/).pop()!.split(".").slice(1).pop()?.toLowerCase() ?? "";

/** The format a file name belongs to, or null if Sketchor doesn't open it. */
export function formatOf(name: string): FormatInfo | null {
  const e = extOf(name);
  return FORMATS.find((f) => f.ext.includes(e)) ?? null;
}

export const allExtensions = (pred: (f: FormatInfo) => boolean = () => true): string[] =>
  FORMATS.filter(pred).flatMap((f) => [...f.ext]);

/** `accept` string for an `<input type=file>`: ".dxf,.svg,…". */
export const acceptList = (pred?: (f: FormatInfo) => boolean): string =>
  allExtensions(pred).map((e) => `.${e}`).join(",");

/** MIME for a file name (drag-out, save pickers); DXF is the fallback like before. */
export const mimeOf = (name: string): string => formatOf(name)?.mime ?? "application/dxf";

/** Formats the file browser's "add files" input takes (not DWG, which needs the converter path). */
export const browserAddFilter = (f: FormatInfo): boolean => f.ext[0] !== "dwg";
