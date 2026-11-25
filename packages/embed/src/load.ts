/**
 * E-03: the dependency-free half of loading — what format a file is, what to
 * call it, where "Open in Sketchor" points, and fetching with a size cap.
 * Kept out of the lazy chunk so the element can decide (and show an error
 * card) before three.js or a parser is downloaded.
 */

export const SKETCHOR_APP = "https://sketchor.sergioalexo.com/app";
export const SKETCHOR_SITE = "https://sketchor.sergioalexo.com/";

/** 3D formats the embed can preview today: triangle meshes, read by the core parsers. */
export const PREVIEW_FORMATS = ["stl", "obj", "ply", "3mf", "gltf", "glb"] as const;
export type PreviewFormat = (typeof PREVIEW_FORMATS)[number];

/** E-01: 2D drawings, read by the core parsers and drawn by the shared Canvas 2D renderer (core render2d). */
export const DRAWING_FORMATS = ["dxf", "svg", "eps", "ai", "pdf"] as const;
export type DrawingFormat = (typeof DRAWING_FORMATS)[number];

/** Formats Sketchor opens that the embed does not draw yet (STEP/IGES/BREP/3DM need the OCCT wasm; DWG needs LibreDWG, which is GPL and stays out of the MIT embed). */
const APP_ONLY = new Set(["step", "stp", "iges", "igs", "brep", "brp", "3dm", "dwg"]);

export type FormatVerdict =
  | { kind: "preview"; format: PreviewFormat }
  | { kind: "drawing"; format: DrawingFormat }
  | { kind: "app-only"; ext: string }
  | { kind: "unknown" };

export function extensionOf(name: string): string {
  const base = name.split(/[?#]/)[0].split(/[\\/]/).pop() ?? "";
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : "";
}

/**
 * Decides by magic bytes first (a `.bin` that is really a GLB still works, a
 * `.stl` that is really a zip doesn't get fed to the STL reader), then by the
 * extension, then by an explicit `format` override.
 */
export function sniffFormat(name: string, bytes: Uint8Array | null, override?: string | null): FormatVerdict {
  const forced = override?.toLowerCase().replace(/^\./, "");
  if (forced) return verdictForExt(forced);
  if (bytes && bytes.length >= 4) {
    if (bytes[0] === 0x67 && bytes[1] === 0x6c && bytes[2] === 0x54 && bytes[3] === 0x46) return { kind: "preview", format: "glb" };
    const head = new TextDecoder().decode(bytes.subarray(0, Math.min(bytes.length, 512)));
    if (head.startsWith("ISO-10303-21")) return { kind: "app-only", ext: "step" };
    const ext = extensionOf(name);
    // A PDF (including an Illustrator 9+ .ai, which is a PDF inside) is read by the PDF importer.
    if (head.startsWith("%PDF-")) return { kind: "drawing", format: "pdf" };
    // PostScript, or a DOS EPS binary header (C5 D0 D3 C6).
    if (head.startsWith("%!PS") || (bytes[0] === 0xc5 && bytes[1] === 0xd0 && bytes[2] === 0xd3 && bytes[3] === 0xc6)) return { kind: "drawing", format: ext === "ai" ? "ai" : "eps" };
    if (head.startsWith("AutoCAD Binary DXF")) return { kind: "drawing", format: "dxf" };
    if (ext !== "svg" && /^\s*(<\?xml[^>]*>\s*)?(<!--[\s\S]*?-->\s*)*(<!DOCTYPE svg[^>]*>\s*)?<svg[\s>]/i.test(head)) return { kind: "drawing", format: "svg" };
    if (bytes[0] === 0x50 && bytes[1] === 0x4b && extensionOf(name) !== "3mf") {
      // A zip that isn't named .3mf: 3MF is the only zip the embed reads.
      return { kind: "preview", format: "3mf" };
    }
  }
  return verdictForExt(extensionOf(name));
}

function verdictForExt(ext: string): FormatVerdict {
  if ((PREVIEW_FORMATS as readonly string[]).includes(ext)) return { kind: "preview", format: ext as PreviewFormat };
  if ((DRAWING_FORMATS as readonly string[]).includes(ext)) return { kind: "drawing", format: ext as DrawingFormat };
  if (APP_ONLY.has(ext)) return { kind: "app-only", ext };
  return { kind: "unknown" };
}

/** A readable name for the file behind a URL ("ASM-4019.glb"), for messages and the model's title. */
export function fileNameFromSrc(src: string): string {
  try {
    const u = new URL(src, "https://x.invalid/");
    const last = decodeURIComponent(u.pathname.split("/").pop() ?? "");
    return last || "model";
  } catch {
    return "model";
  }
}

/**
 * The "Open in Sketchor" target. `auto` (or no attribute) hands the file's
 * absolute URL to the web app's `?open=` route; `none` hides the link; any
 * other value is used as given.
 */
export function resolveFullUrl(attr: string | null, absoluteSrc: string | null): string | null {
  const v = attr?.trim();
  if (v === "none") return null;
  if (v && v !== "auto") return v;
  return absoluteSrc ? `${SKETCHOR_APP}?open=${encodeURIComponent(absoluteSrc)}` : SKETCHOR_APP;
}

export const DEFAULT_MAX_MB = 25;

/** Fetches `url` into memory, refusing anything over `maxBytes` (checked against Content-Length and while streaming). */
export async function fetchBytes(url: string, maxBytes: number, signal?: AbortSignal): Promise<Uint8Array> {
  const res = await fetch(url, { signal, mode: "cors" });
  if (!res.ok) throw new Error(`the file could not be downloaded (HTTP ${res.status})`);
  const declared = Number(res.headers.get("content-length") ?? "0");
  if (declared > maxBytes) throw new Error(tooBig(maxBytes));
  if (!res.body) {
    const buf = new Uint8Array(await res.arrayBuffer());
    if (buf.byteLength > maxBytes) throw new Error(tooBig(maxBytes));
    return buf;
  }
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new Error(tooBig(maxBytes));
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let o = 0;
  for (const c of chunks) {
    out.set(c, o);
    o += c.byteLength;
  }
  return out;
}

function tooBig(maxBytes: number): string {
  return `the file is larger than the ${Math.round(maxBytes / 1048576)} MB preview limit`;
}
