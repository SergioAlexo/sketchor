import { useApp } from "../state/store";

interface SavePickerWindow {
  showSaveFilePicker?: (opts: { suggestedName?: string; types?: { description: string; accept: Record<string, string[]> }[] }) => Promise<{
    name: string;
    createWritable(): Promise<{ write(data: BlobPart): Promise<void>; close(): Promise<void> }>;
  }>;
}

/**
 * F-11: saves bytes that aren't the tab's drawing (an exported mesh): the
 * browser's save dialog where there is one (Chromium, the desktop app's
 * webview), else a download. Says where it went. False when cancelled.
 */
export async function saveBytesAs(name: string, bytes: Uint8Array, type: { description: string; mime: string; ext: string }): Promise<boolean> {
  const w = window as unknown as SavePickerWindow;
  const notice = useApp.getState().setSaveNotice;
  if (typeof w.showSaveFilePicker === "function") {
    try {
      const handle = await w.showSaveFilePicker({ suggestedName: name, types: [{ description: type.description, accept: { [type.mime]: [`.${type.ext}`] } }] });
      const out = await handle.createWritable();
      await out.write(bytes as BlobPart);
      await out.close();
      notice({ kind: "saved", message: `Exported ${handle.name}`, at: Date.now() });
      return true;
    } catch (err) {
      if ((err as DOMException)?.name === "AbortError") return false;
      throw err;
    }
  }
  const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: type.mime }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
  notice({ kind: "saved", message: `Exported ${name}`, at: Date.now() });
  return true;
}
