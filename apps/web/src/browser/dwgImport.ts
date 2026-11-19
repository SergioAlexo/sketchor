/**
 * DWG import via @mlightcad/libredwg-web (GNU LibreDWG compiled to
 * WebAssembly). This is a GPL-3.0 dependency — see NOTICE.md at the repo
 * root. Read-only: the published package ships with DWG *writing* disabled
 * to keep the wasm binary smaller, so there is no "save as DWG" here.
 *
 * Rather than walking LibreDWG's low-level object graph ourselves, we use
 * its built-in `dwg_write_dxf` to convert straight to DXF text and hand
 * that to Sketchor's own battle-tested DXF parser — one entity converter
 * to maintain instead of two.
 *
 * The wasm binary is served from /wasm (copied from the package into
 * apps/web/public/wasm — see that folder's README) rather than resolved
 * relative to node_modules, so it survives a production Vite build
 * regardless of deployment base path.
 */

/** Shown when LibreDWG can't convert a file. */
export const DWG_UNREADABLE = "could not read this DWG file (unsupported version or corrupt data)";

interface LibreDwgInstance {
  dwg_write_dxf(fileContent: ArrayBuffer): Uint8Array | null;
}

let libredwgPromise: Promise<LibreDwgInstance> | null = null;

async function getLibreDwg(): Promise<LibreDwgInstance> {
  if (!libredwgPromise) {
    libredwgPromise = import("@mlightcad/libredwg-web").then(({ LibreDwg }) => {
      // BASE_URL is "./" for the desktop/portable build and "/app/" when the site serves the app under /app.
      const wasmDir = new URL(`${import.meta.env.BASE_URL}wasm`, document.baseURI).href;
      return LibreDwg.create(wasmDir) as Promise<LibreDwgInstance>;
    });
  }
  return libredwgPromise;
}

/**
 * Converts a DWG file's raw bytes to DXF text (see module doc above), or null
 * if LibreDWG can't read it. Callers hand the text to the normal DXF import,
 * so a DWG gets exactly the same unit detection as a DXF.
 */
export async function dwgToDxfText(buffer: ArrayBuffer): Promise<string | null> {
  const libredwg = await getLibreDwg();
  const dxfBytes = libredwg.dwg_write_dxf(buffer);
  if (!dxfBytes || dxfBytes.length === 0) return null;
  return new TextDecoder("utf-8").decode(dxfBytes);
}
