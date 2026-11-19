import { useApp } from "../state/store";
import { loadDrawingFile } from "./drawingFile";
import { openTarget } from "./openTarget";

/**
 * E-06: `/app?open=<url>` — the embed's "Open in Sketchor" link. Fetches the
 * file (the host must allow CORS, as for the embed itself), names it after
 * the URL's last path segment, and opens it through the same path as a
 * dropped file. A note says where it came from: nothing is saved anywhere
 * until the user saves a copy.
 */

export async function initOpenFromUrl(): Promise<void> {
  const target = openTarget(window.location.search);
  if (!target) return;
  const app = useApp.getState();
  try {
    const res = await fetch(target.url, { mode: "cors" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const blob = await res.blob();
    await loadDrawingFile(target.name, new File([blob], target.name, { type: blob.type }));
    app.setSaveNotice({ kind: "saved", message: `Opened ${target.name} from ${new URL(target.url).host} — save to keep a copy`, at: Date.now() });
  } catch (err) {
    app.setSaveNotice({ kind: "error", message: `${target.name} from ${new URL(target.url).host} could not be opened (${(err as Error).message})`, at: Date.now() });
  }
}
