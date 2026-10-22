import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useTheme } from "../theme/themeStore";
import { decodeDxfBytes, parseSvgText } from "@sketchor/core";
import { getSessions, importDxfText, importEpsResult, importSvgText, openIntoSession, useApp } from "../state/store";
import { TextCache, entryMatchesSaved, onFileSaved, type SavedFile } from "../io/savedFiles";
import { bindDxfVersion, bindSaveHandle, bindSavePath, fileDxfText, openModelBytes } from "../io/drawingFile";
import { isModelFile } from "../model3d/stepImport";
import { acceptList, browserAddFilter, mimeOf } from "../io/formats";
import { epsEntitiesToSvg, fileToSvg, isDrawingFile, isEpsFile, queueThumbnail } from "./thumbnail";
import { blobReader, epsThumbnailDataUrl, importEpsFromReader, tauriReader, type RangeReader } from "../io/epsImport";

interface Entry {
  name: string;
  /** Already-read content — skips the lazy read below. */
  text?: string;
  /** A picked `File` whose content is read on demand, so adding hundreds of files doesn't read them all upfront. */
  file?: File;
  /** Web folder browsing: a handle to lazily read the file's text. */
  handle?: FileSystemFileHandle;
  /** Desktop: a full path passed to the Rust `read_drawing_file` command. */
  path?: string;
  /** Last-modified time (ms epoch), when known. */
  mtime?: number;
  /** File size in bytes, when known. */
  size?: number;
  /** Bumped when the file is known to have changed on disk (a save); re-triggers the thumbnail. */
  rev?: number;
}

type SortMode = "name" | "date" | "size";
type SortDir = "asc" | "desc";
type ViewMode = "grid" | "list";

/** Default direction per column: names read A-Z, but dates and sizes are most useful largest/newest first. */
const DEFAULT_DIR: Record<SortMode, SortDir> = { name: "asc", date: "desc", size: "desc" };

function sortEntries(list: Entry[], mode: SortMode, dir: SortDir): Entry[] {
  const sign = dir === "asc" ? 1 : -1;
  return [...list].sort((a, b) => {
    if (mode === "date" || mode === "size") {
      const av = mode === "date" ? a.mtime : a.size;
      const bv = mode === "date" ? b.mtime : b.size;
      // Entries with no value (e.g. a desktop listing that couldn't stat the
      // file) always sink to the bottom rather than flipping with direction.
      if (av === undefined || bv === undefined) {
        if (av !== bv) return av === undefined ? 1 : -1;
      } else if (av !== bv) {
        return (av - bv) * sign;
      }
    }
    return a.name.localeCompare(b.name) * (mode === "name" ? sign : 1);
  });
}

function formatSize(bytes: number | undefined): string {
  if (bytes === undefined) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatDate(ms: number | undefined): string {
  if (ms === undefined) return "";
  return new Date(ms).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

interface TauriInvoke {
  core: { invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown> };
}

function tauri(): TauriInvoke | undefined {
  return (window as unknown as { __TAURI__?: TauriInvoke }).__TAURI__;
}

/** A range reader over an entry's bytes (EPS/AI are never read whole as text), or null when it has no readable source. */
async function entryReader(entry: Entry): Promise<RangeReader | null> {
  if (entry.file) return blobReader(entry.file);
  if (entry.handle) return blobReader(await entry.handle.getFile());
  if (entry.path) {
    const t = tauri();
    return t ? tauriReader(t.core.invoke, entry.path) : null;
  }
  return null;
}

async function readEntryText(entry: Entry): Promise<string> {
  if (entry.text !== undefined) return entry.text;
  if (isEpsFile(entry.name)) return ""; // binary: opened / previewed through entryReader
  const isDxf = /\.dxf$/i.test(entry.name);
  if (entry.file) return isDxf ? fileDxfText(entry.file) : entry.file.text();
  if (entry.handle) {
    const f = await entry.handle.getFile();
    return isDxf ? fileDxfText(f) : f.text();
  }
  if (entry.path) {
    const t = tauri();
    if (!t) return "";
    if (isDxf) {
      const bytes = (await t.core.invoke("read_file_bytes", { path: entry.path })) as ArrayBuffer;
      return decodeDxfBytes(new Uint8Array(bytes));
    }
    return (await t.core.invoke("read_drawing_file", { path: entry.path })) as string;
  }
  return "";
}

/**
 * Raw bytes of an entry, for 3D model files — read raw rather than through
 * the text path so the content hash (the model cache key) matches what the
 * Open dialog and desktop file association produce from the same file, and
 * so a STEP/IGES file with non-UTF-8 bytes (Latin-1 part names, common from
 * SolidWorks) doesn't fail outright the way `read_to_string` would.
 */
async function readEntryBytes(entry: Entry): Promise<ArrayBuffer> {
  if (entry.file) return entry.file.arrayBuffer();
  if (entry.handle) return (await entry.handle.getFile()).arrayBuffer();
  if (entry.path) {
    const t = tauri();
    if (!t) return new ArrayBuffer(0);
    return (await t.core.invoke("read_file_bytes", { path: entry.path })) as ArrayBuffer;
  }
  const text = await readEntryText(entry);
  return new TextEncoder().encode(text).buffer as ArrayBuffer;
}

async function openEntry(entry: Entry, text: string): Promise<void> {
  if (isEpsFile(entry.name)) {
    const reader = await entryReader(entry);
    const eps = reader ? await importEpsFromReader(reader) : { entities: [], warnings: ["the EPS/AI file could not be read"] };
    openIntoSession(entry.name, () => importEpsResult(eps.entities, eps.warnings));
    return;
  }
  if (isModelFile(entry.name)) {
    // View-only, opens in its own 3D tab; nothing to bind a Save to.
    openModelBytes(entry.name, await readEntryBytes(entry));
    return;
  }
  if (/\.svg$/i.test(entry.name)) {
    openIntoSession(entry.name, () => importSvgText(text));
  } else {
    openIntoSession(entry.name, () => importDxfText(text));
    bindDxfVersion(text);
  }
  // Bind the new tab to the file it came from, so Ctrl+S writes back here
  // instead of asking where to put it. Desktop entries carry a native path,
  // web entries a File System Access handle.
  if (entry.path) bindSavePath(entry.path, entry.name);
  else if (entry.handle) bindSaveHandle(entry.handle as unknown as Parameters<typeof bindSaveHandle>[0]);
}

/* ------------------------------- tagging -------------------------------- */

/**
 * File tags, persisted in localStorage keyed by the file's full path where we
 * have one (desktop) and by its name otherwise. A name-only key is the honest
 * limit of the browser build: the File System Access API's handles aren't a
 * durable identifier across sessions, so two same-named files from different
 * folders share tags there.
 */
const TAG_STORE_KEY = "sketchor.fileTags.v1";

/**
 * Windowed rendering for the file list.
 *
 * A library folder here can hold ten thousand drawings, and mounting a
 * component per file is what froze the app for seconds on open: React has to
 * reconcile 10k elements and each one starts its own IntersectionObserver for
 * its thumbnail. Only the rows within {@link OVERSCAN_PX} of the viewport are
 * rendered; the rest are stand-in padding above and below, so the scrollbar
 * still measures the whole folder and nothing about scrolling feels different.
 *
 * Row height and column count are **measured, not hardcoded** — the cards are
 * square (`aspect-ratio: 1`), so their height follows the panel's draggable
 * width, and no fixed number would survive a resize. Reading
 * `gridTemplateColumns` also makes the same hook serve the list view, where it
 * computes to `none` and so yields a single column.
 *
 * This does assume every item is the same height, which styles.css enforces by
 * clipping long names and the tag strip rather than letting them wrap. If that
 * ever stops being true the symptom is drift while scrolling, not a crash.
 */
const OVERSCAN_PX = 500;
/** Files whose metadata is read per yield when enumerating a folder in the browser build. */
const METADATA_BATCH = 250;
/** Rendered before anything has been measured — enough to measure from, cheap enough not to stall. */
const INITIAL_BATCH = 60;

function useWindowedItems(count: number) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const itemsRef = useRef<HTMLDivElement>(null);
  const observerRef = useRef<ResizeObserver | null>(null);
  const [metrics, setMetrics] = useState({ stride: 0, cols: 1 });
  const [scrollTop, setScrollTop] = useState(0);
  const [viewport, setViewport] = useState(0);

  /**
   * A callback ref, not a plain one plus an effect: the scroller only exists
   * once there are entries to show, and it is torn down and rebuilt when the
   * view mode flips. A mount-time effect would measure a element that isn't
   * there yet and leave the window sized by overscan alone.
   */
  const attachScroll = useCallback((el: HTMLDivElement | null) => {
    observerRef.current?.disconnect();
    observerRef.current = null;
    scrollRef.current = el;
    if (!el) return;
    setViewport(el.clientHeight);
    setScrollTop(el.scrollTop);
    if (typeof ResizeObserver === "undefined") return;
    observerRef.current = new ResizeObserver(() => setViewport(el.clientHeight));
    observerRef.current.observe(el);
  }, []);

  useEffect(() => () => observerRef.current?.disconnect(), []);

  const onScroll = () => {
    if (scrollRef.current) setScrollTop(scrollRef.current.scrollTop);
  };

  // Deliberately runs after every render: the panel resizes, the view mode
  // flips, and the measurement has to follow. It only sets state when a number
  // actually moved, so it settles in one extra pass instead of looping.
  useLayoutEffect(() => {
    // The viewport height is read here as well as from the ResizeObserver.
    // The observer delivers on an animation frame, so on the render where the
    // scroller first appears it hasn't reported yet — and a window sized from
    // a height of zero renders a couple of rows and leaves blanks below.
    const scroll = scrollRef.current;
    if (scroll && scroll.clientHeight !== viewport) setViewport(scroll.clientHeight);

    const items = itemsRef.current;
    const item = items?.querySelector<HTMLElement>("[data-vitem]");
    if (!items || !item) return;
    // The panel stays mounted under `display: none` when toggled off, where
    // every box measures zero. Taking that reading would leave the stride as
    // nothing but the row gap and blow the window up to hundreds of rows, so
    // a hidden panel keeps whatever was last measured.
    const itemHeight = item.getBoundingClientRect().height;
    if (itemHeight <= 0) return;

    const style = getComputedStyle(items);
    const cols = Math.max(1, style.gridTemplateColumns.split(" ").filter(Boolean).length);
    const stride = itemHeight + (parseFloat(style.rowGap) || 0);
    if (Math.abs(stride - metrics.stride) > 0.5 || cols !== metrics.cols) {
      setMetrics({ stride, cols });
    }
  });

  const { stride, cols } = metrics;
  if (stride <= 0) {
    // Nothing measured yet — render a first batch to measure against.
    return { attachScroll, itemsRef, onScroll, start: 0, end: Math.min(count, INITIAL_BATCH), padTop: 0, padBottom: 0 };
  }

  const rows = Math.ceil(count / cols);
  const firstRow = Math.min(Math.max(0, rows - 1), Math.max(0, Math.floor((scrollTop - OVERSCAN_PX) / stride)));
  const lastRow = Math.min(rows, Math.ceil((scrollTop + viewport + OVERSCAN_PX) / stride));
  return {
    attachScroll,
    itemsRef,
    onScroll,
    start: firstRow * cols,
    end: Math.min(count, lastRow * cols),
    padTop: firstRow * stride,
    padBottom: Math.max(0, (rows - lastRow) * stride),
  };
}

function tagKey(entry: Entry): string {
  return entry.path ?? entry.name;
}

function loadTags(): Record<string, string[]> {
  try {
    const raw = localStorage.getItem(TAG_STORE_KEY);
    return raw ? (JSON.parse(raw) as Record<string, string[]>) : {};
  } catch {
    return {}; // corrupt or unavailable storage — start clean rather than break the panel
  }
}

function saveTags(tags: Record<string, string[]>): void {
  try {
    localStorage.setItem(TAG_STORE_KEY, JSON.stringify(tags));
  } catch {
    // storage full or blocked: tags stay in memory for this session
  }
}

const MIME_FOR = mimeOf;

/**
 * Starts a drag carrying real files out of the panel.
 *
 * Two mechanisms, because drop targets read different things and no single
 * one covers both:
 *
 * - **Real `File` objects** on `dataTransfer.items`. This is what any *web*
 *   drop target (a chat's upload box, a file input, a drag-and-drop zone)
 *   reads via `dataTransfer.files`. Without these a web target sees no files
 *   at all and falls back to whatever text it can find — which is why a drag
 *   into a chat used to paste the filename instead of attaching the drawing.
 *   Supports any number of files.
 * - **`DownloadURL`**, which is what lets a drop onto the *OS* (Explorer, the
 *   desktop) actually write a file. It's Chromium-only (WebView2 included)
 *   and carries exactly one file, so it's set only for single-file drags.
 *
 * `text/plain` is deliberately NOT set: with files present, some targets
 * prefer the text flavor and would paste a filename over attaching the file.
 */
function startFileDrag(e: React.DragEvent, files: { name: string; text: string }[]): void {
  if (files.length === 0) return;
  const dt = e.dataTransfer;
  dt.effectAllowed = "copy";

  for (const f of files) {
    dt.items.add(new File([f.text], f.name, { type: MIME_FOR(f.name) }));
  }

  if (files.length === 1) {
    const { name, text } = files[0];
    const mime = MIME_FOR(name);
    const url = URL.createObjectURL(new Blob([text], { type: mime }));
    dt.setData("DownloadURL", `${mime}:${name}:${url}`);
    // The blob has to outlive the drag; a timeout is the only hook available
    // since there's no "drop completed on the OS" event.
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  }
}

const MIN_WIDTH = 160;
const MAX_WIDTH = 520;
const DEFAULT_WIDTH = 240;
/** How many files' contents to pre-read so dragging works without waiting; the rest load on hover/scroll. */
const PREFETCH_COUNT = 24;

/**
 * Left-dock "mini-Explorer" (R9): geometry thumbnails of every .dxf/.svg
 * drawing in a folder, click to open into a new tab. Reuses the same
 * dxfToSvg/entitiesToSvg headless renderer as the native Explorer
 * thumbnailer, so previews everywhere agree. Drag the right edge to resize.
 *
 * Folder access, in order of preference: on desktop, a directory (from a
 * file opened via Explorer/file-association) is read in Rust with no
 * sandbox limits; on the web, a one-time `showDirectoryPicker()` grant, or
 * (always available) picking individual files.
 *
 * Stays mounted even while toggled off (`hidden`, shown via CSS) — its
 * loaded entries/thumbnails are local state, so unmounting on every toggle
 * would throw them away and re-browse from scratch each time it's reopened.
 */
export function FileExplorerPanel({ hidden, onClose }: { hidden: boolean; onClose: () => void }) {
  const [entries, setEntries] = useState<Entry[]>([]);
  /** True while a folder is being enumerated — a big library takes a moment even off the main thread. */
  const [loading, setLoading] = useState(false);
  const [folderLabel, setFolderLabel] = useState<string | null>(null);
  const [width, setWidth] = useState(DEFAULT_WIDTH);
  const [sortMode, setSortMode] = useState<SortMode>("name");
  const [sortDir, setSortDir] = useState<SortDir>("asc");
  const [viewMode, setViewMode] = useState<ViewMode>("grid");
  const [query, setQuery] = useState("");
  const [tags, setTags] = useState<Record<string, string[]>>(loadTags);
  /** Tags currently filtering the list; empty means "show everything". */
  const [activeTags, setActiveTags] = useState<string[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  /**
   * File contents, cached per entry. Shared across the panel because a drag
   * starts synchronously — there's no chance to await a read once `dragstart`
   * fires, so every draggable file's text has to already be here.
   */
  const textCache = useRef(new TextCache());
  const entriesRef = useRef<Entry[]>([]);
  entriesRef.current = entries;
  const desktopDir = useApp((s) => s.fileBrowserDesktopDir);
  const activeSessionId = useApp((s) => s.activeSessionId);

  const supportsDirPicker = typeof (window as unknown as { showDirectoryPicker?: unknown }).showDirectoryPicker === "function";
  const isDesktop = !!tauri();

  const openFolder = async () => {
    try {
      const dir = await (
        window as unknown as { showDirectoryPicker: () => Promise<{ name: string; values: () => AsyncIterable<FileSystemHandle & { kind: string; name: string }> }> }
      ).showDirectoryPicker();
      setLoading(true);
      setFolderLabel(dir.name);
      const handles: FileSystemFileHandle[] = [];
      for await (const item of dir.values()) {
        if (item.kind === "file" && isDrawingFile(item.name)) {
          handles.push(item as unknown as FileSystemFileHandle);
        }
      }
      // Metadata only (not content) — per-file content still loads lazily.
      // Done in batches with a yield between them so enumerating a folder of
      // thousands leaves gaps for input and rendering instead of one long task.
      const list: Entry[] = [];
      for (let i = 0; i < handles.length; i += METADATA_BATCH) {
        const batch = await Promise.all(
          handles.slice(i, i + METADATA_BATCH).map(async (handle) => {
            try {
              const f = await handle.getFile();
              return { name: handle.name, handle, mtime: f.lastModified, size: f.size };
            } catch {
              return { name: handle.name, handle };
            }
          }),
        );
        list.push(...batch);
        await new Promise((r) => setTimeout(r, 0));
      }
      setEntries(list);
    } catch {
      // user cancelled the picker
    } finally {
      setLoading(false);
    }
  };

  const addFiles = async (files: FileList | null) => {
    if (!files) return;
    // Metadata only — contents are read lazily per file. Reading every picked
    // file upfront is what made adding a large library stall the app.
    const picked: Entry[] = Array.from(files)
      .filter((f) => isDrawingFile(f.name))
      .map((f) => ({ name: f.name, file: f, mtime: f.lastModified, size: f.size }));
    if (picked.length === 0) return;
    setEntries((prev) => {
      const byName = new Map(prev.map((e) => [e.name, e]));
      for (const p of picked) byName.set(p.name, p);
      return [...byName.values()];
    });
    setFolderLabel(null);
  };

  // Resize: drag the right-edge handle.
  const resizing = useRef(false);
  const onResizeStart = (e: React.PointerEvent) => {
    resizing.current = true;
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
  };
  const onResizeMove = (e: React.PointerEvent) => {
    if (!resizing.current) return;
    const panelLeft = (e.currentTarget as HTMLElement).parentElement!.getBoundingClientRect().left;
    const next = Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, e.clientX - panelLeft));
    setWidth(next);
  };
  const onResizeEnd = (e: React.PointerEvent) => {
    resizing.current = false;
    try {
      (e.target as HTMLElement).releasePointerCapture(e.pointerId);
    } catch {
      // already released
    }
  };

  // Desktop: a file opened from Explorer sets fileBrowserDesktopDir -> auto-load + reveal.
  useEffect(() => {
    if (!desktopDir) return;
    const t = tauri();
    if (!t) return;
    let cancelled = false;
    setLoading(true);
    t.core
      .invoke("list_drawings_in_dir", { dir: desktopDir })
      .then((res) => {
        if (cancelled) return;
        const list = (res as { name: string; path: string; mtime?: number | null; size?: number | null }[])
          .filter((e) => isDrawingFile(e.name))
          .map((e) => ({
            name: e.name,
            path: e.path,
            ...(e.mtime != null ? { mtime: e.mtime } : {}),
            ...(e.size != null ? { size: e.size } : {}),
          }));
        setEntries(list);
        setFolderLabel(desktopDir.split(/[/\\]/).filter(Boolean).pop() ?? desktopDir);
      })
      .catch(() => {
        // Best-effort: an older desktop build without the command, or a read error.
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [desktopDir]);

  // Ctrl+F focuses the panel's own search box, while it's visible, instead of the browser's page search.
  useEffect(() => {
    if (hidden) return;
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "f") {
        e.preventDefault();
        searchRef.current?.focus();
        searchRef.current?.select();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [hidden]);

  const tagsOf = (entry: Entry): string[] => tags[tagKey(entry)] ?? [];

  const setEntryTags = (entry: Entry, next: string[]) => {
    setTags((prev) => {
      const updated = { ...prev };
      if (next.length === 0) delete updated[tagKey(entry)];
      else updated[tagKey(entry)] = next;
      saveTags(updated);
      return updated;
    });
  };

  const addTagTo = (targets: Entry[], tag: string) => {
    const t = tag.trim();
    if (!t) return;
    setTags((prev) => {
      const updated = { ...prev };
      for (const entry of targets) {
        const key = tagKey(entry);
        const existing = updated[key] ?? [];
        if (!existing.includes(t)) updated[key] = [...existing, t];
      }
      saveTags(updated);
      return updated;
    });
  };

  /** Every tag in use, for the filter bar. */
  const allTags = [...new Set(entries.flatMap((e) => tagsOf(e)))].sort((a, b) => a.localeCompare(b));

  const toggleActiveTag = (tag: string) =>
    setActiveTags((prev) => (prev.includes(tag) ? prev.filter((t) => t !== tag) : [...prev, tag]));

  const q = query.trim().toLowerCase();
  // Memoised because it walks every entry: over a folder of thousands this
  // would otherwise re-filter and re-sort the lot on each keystroke, and on
  // every unrelated re-render of the panel.
  const displayEntries = useMemo(
    () =>
      sortEntries(
        entries.filter((e) => {
          if (q && !e.name.toLowerCase().includes(q)) return false;
          // Multiple active tags narrow rather than widen (an AND, like faceted search).
          if (activeTags.length > 0 && !activeTags.every((t) => (tags[tagKey(e)] ?? []).includes(t))) return false;
          return true;
        }),
        sortMode,
        sortDir,
      ),
    [entries, q, activeTags, tags, sortMode, sortDir],
  );

  const win = useWindowedItems(displayEntries.length);
  const visible = displayEntries.slice(win.start, win.end);

  /** Clicking a column re-sorts by it; clicking the active column flips direction. */
  const sortByColumn = (mode: SortMode) => {
    if (mode === sortMode) setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    else {
      setSortMode(mode);
      setSortDir(DEFAULT_DIR[mode]);
    }
  };

  const selectedEntries = displayEntries.filter((e) => selected.includes(tagKey(e)));

  /** Read-through accessor for an entry's text; every read populates the shared cache. */
  const textOf = (entry: Entry) => async (): Promise<string> => {
    const key = tagKey(entry);
    const hit = textCache.current.get(key);
    if (hit !== undefined) return hit;
    const gen = textCache.current.generation(key);
    const text = await readEntryText(entry);
    textCache.current.set(key, text, gen); // dropped if a save invalidated the entry mid-read
    return text;
  };

  /**
   * Always re-reads from disk (and refreshes the cache): used when opening, so
   * a stale cached copy — from a save, or an edit made outside the app — can
   * never be what gets loaded. If the content differs from what the card was
   * showing, the card is told to redraw its thumbnail.
   */
  const freshTextOf = (entry: Entry) => async (): Promise<string> => {
    const key = tagKey(entry);
    const before = textCache.current.get(key);
    textCache.current.invalidate(key);
    const gen = textCache.current.generation(key);
    const text = await readEntryText(entry);
    textCache.current.set(key, text, gen);
    if (before !== undefined && before !== text) bumpEntry(key, {});
    return text;
  };

  /** Patches one entry in place (new object, so memoised lists and thumbnail effects see the change) and bumps its `rev`. */
  const bumpEntry = (key: string, patch: Partial<Entry>) =>
    setEntries((prev) => prev.map((e) => (tagKey(e) === key ? { ...e, ...patch, rev: (e.rev ?? 0) + 1 } : e)));

  // A save (drawingFile.ts) just rewrote a file: drop every cached view of it
  // so thumbnails, drag-out and the size/date columns show the new content.
  useEffect(
    () =>
      onFileSaved((saved: SavedFile) => {
        void (async () => {
          for (const entry of entriesRef.current) {
            if (!(await entryMatchesSaved(entry, saved))) continue;
            const key = tagKey(entry);
            textCache.current.invalidate(key);
            const patch: Partial<Entry> = {};
            try {
              if (entry.handle) {
                const f = await entry.handle.getFile();
                patch.mtime = f.lastModified;
                patch.size = f.size;
              } else if (entry.path) {
                const t = tauri();
                const bytes = t ? ((await t.core.invoke("read_file_bytes", { path: entry.path })) as ArrayBuffer) : null;
                if (bytes) patch.size = bytes.byteLength;
                patch.mtime = Date.now();
              }
            } catch {
              // stat failed: the thumbnail/text still refresh, only the size/date columns stay as they were
            }
            bumpEntry(key, patch);
            if (!isEpsFile(entry.name) && !isModelFile(entry.name)) void warmText({ ...entry, ...patch });
          }
        })();
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  const warmText = async (entry: Entry): Promise<void> => {
    try {
      await textOf(entry)();
    } catch {
      // unreadable file: leave it uncached so it's simply excluded from a drag
    }
  };

  /**
   * Warm the first screenful of files in the background.
   *
   * `dragstart` is synchronous and can't wait for a read, so a file's content
   * has to already be cached when the drag begins. Hovering warms it (and
   * hover reliably precedes a mouse drag), but prefetching the top of the list
   * means the common case of a modest folder behaves as if everything were
   * loaded, without the stall of reading a large library upfront. Reads go
   * through the same queue as thumbnails, so this never blocks the canvas.
   */
  useEffect(() => {
    const cancels = entries.slice(0, PREFETCH_COUNT).map((entry) => queueThumbnail(() => warmText(entry)));
    return () => cancels.forEach((cancel) => cancel());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entries]);

  // Selecting files is the signal that they're about to be dragged or
  // exported, so pull their contents in now rather than at `dragstart`, which
  // is synchronous and can't wait for a read.
  useEffect(() => {
    for (const entry of entries.filter((e) => selected.includes(tagKey(e)))) void warmText(entry);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected]);

  /**
   * The files a drag should carry: the whole selection when the dragged item
   * is part of it, otherwise just the item itself. Entries whose text hasn't
   * been read yet are dropped rather than sent empty.
   */
  const dragPayload = (entry: Entry): { name: string; text: string }[] => {
    const group = (selected.includes(tagKey(entry)) ? selectedEntries : [entry]).filter((e) => !isEpsFile(e.name)); // binary: no text to carry
    return group
      .map((e) => ({ name: e.name, text: textCache.current.get(tagKey(e)) }))
      .filter((f): f is { name: string; text: string } => f.text !== undefined);
  };

  const onItemDragStart = (entry: Entry) => (e: React.DragEvent) => {
    const files = dragPayload(entry);
    if (files.length === 0) {
      e.preventDefault();
      void warmText(entry); // ready for the next attempt
      return;
    }
    startFileDrag(e, files);
  };

  /**
   * Pull a file's text in as soon as the pointer touches its row/card, so the
   * content is present by the time a drag actually starts. Hovering and
   * pressing both fire well before `dragstart`.
   */
  const onItemPointerHint = (entry: Entry) => () => void warmText(entry);

  const toggleSelected = (entry: Entry, additive: boolean) => {
    const key = tagKey(entry);
    setSelected((prev) =>
      additive ? (prev.includes(key) ? prev.filter((k) => k !== key) : [...prev, key]) : prev.includes(key) && prev.length === 1 ? [] : [key],
    );
  };

  /** Writes the current selection out as individual files (the multi-file counterpart to dragging one out). */
  const exportSelected = async () => {
    for (const entry of selectedEntries) {
      const body = isEpsFile(entry.name) ? await readEntryBytes(entry) : await readEntryText(entry);
      const url = URL.createObjectURL(new Blob([body], { type: MIME_FOR(entry.name) }));
      const a = document.createElement("a");
      a.href = url;
      a.download = entry.name;
      a.click();
      URL.revokeObjectURL(url);
    }
  };

  const tagSelected = () => {
    const tag = window.prompt(`Tag ${selectedEntries.length} file(s) as:`);
    if (tag) addTagTo(selectedEntries, tag);
  };

  const editTags = (entry: Entry) => {
    const next = window.prompt(`Tags for ${entry.name} (comma-separated):`, tagsOf(entry).join(", "));
    if (next !== null) setEntryTags(entry, next.split(",").map((t) => t.trim()).filter(Boolean));
  };

  return (
    <aside
      className="filexplorer"
      data-testid="file-explorer"
      style={{ width, display: hidden ? "none" : undefined }}
    >
      <div className="filexplorer-header">
        <span className="filexplorer-title">{folderLabel ?? "Files"}</span>
        <div className="filexplorer-actions">
          {(supportsDirPicker || isDesktop) && (
            <button className="btn ghost" onClick={openFolder} data-testid="file-explorer-open-folder">
              Open folder…
            </button>
          )}
          <button className="btn ghost" onClick={() => fileInputRef.current?.click()} data-testid="file-explorer-add-files">
            Add files…
          </button>
          <button className="btn ghost" onClick={onClose} title="Hide panel">
            ✕
          </button>
        </div>
        <input
          ref={fileInputRef}
          type="file"
          accept={acceptList(browserAddFilter)}
          multiple
          hidden
          onChange={(e) => void addFiles(e.target.files)}
        />
      </div>

      {entries.length > 0 && (
        <div className="filexplorer-toolbar">
          <input
            ref={searchRef}
            className="filexplorer-search"
            type="search"
            placeholder="Filter… (Ctrl+F)"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            data-testid="file-explorer-search"
          />
          {/* The list view sorts from its column headers; the grid has none, so it keeps a compact toggle. */}
          {viewMode === "grid" && (
            <div className="filexplorer-toggle" role="group" aria-label="Sort by">
              <button
                className={sortMode === "name" ? "active" : ""}
                onClick={() => sortByColumn("name")}
                title="Sort by name"
                data-testid="file-explorer-sort-name"
              >
                Name
              </button>
              <button
                className={sortMode === "date" ? "active" : ""}
                onClick={() => sortByColumn("date")}
                title="Sort by date modified"
                data-testid="file-explorer-sort-date"
              >
                Date
              </button>
            </div>
          )}
          <div className="filexplorer-toggle" role="group" aria-label="View">
            <button
              className={viewMode === "grid" ? "active" : ""}
              onClick={() => setViewMode("grid")}
              title="Grid view"
              data-testid="file-explorer-view-grid"
            >
              <GridIcon />
            </button>
            <button
              className={viewMode === "list" ? "active" : ""}
              onClick={() => setViewMode("list")}
              title="List view"
              data-testid="file-explorer-view-list"
            >
              <ListIcon />
            </button>
          </div>
        </div>
      )}

      {allTags.length > 0 && (
        <div className="filexplorer-tagbar" data-testid="file-explorer-tagbar">
          {allTags.map((tag) => (
            <button
              key={tag}
              className={`filetag ${activeTags.includes(tag) ? "active" : ""}`}
              onClick={() => toggleActiveTag(tag)}
              title={activeTags.includes(tag) ? `Stop filtering by "${tag}"` : `Show only files tagged "${tag}"`}
              data-testid={`file-explorer-tag-${tag}`}
            >
              {tag}
            </button>
          ))}
          {activeTags.length > 0 && (
            <button className="filetag clear" onClick={() => setActiveTags([])} data-testid="file-explorer-tags-clear">
              Clear
            </button>
          )}
        </div>
      )}

      {selectedEntries.length > 0 && (
        <div className="filexplorer-selbar" data-testid="file-explorer-selbar">
          <span>{selectedEntries.length} selected</span>
          <button className="btn ghost sm" onClick={tagSelected} data-testid="file-explorer-tag-selected">
            Tag…
          </button>
          <button className="btn ghost sm" onClick={() => void exportSelected()} data-testid="file-explorer-export-selected">
            Export
          </button>
          <button className="btn ghost sm" onClick={() => setSelected([])}>
            Clear
          </button>
        </div>
      )}

      {loading ? (
        <div className="filexplorer-loading" data-testid="file-explorer-loading">
          <span className="spinner" aria-hidden="true" />
          <span>Reading {folderLabel ?? "folder"}…</span>
        </div>
      ) : entries.length === 0 ? (
        <div className="filexplorer-empty">
          {isDesktop
            ? "Open a .dxf, .svg or .step file, or pick a folder, to browse its drawings and models."
            : supportsDirPicker
              ? "Use Open folder… or Add files… to browse drawings."
              : "Use Add files… to preview and open drawings."}
        </div>
      ) : displayEntries.length === 0 ? (
        <div className="filexplorer-empty">
          {query ? `No files match "${query}".` : "No files carry all of the selected tags."}
        </div>
      ) : viewMode === "grid" ? (
        <div className="filexplorer-scroll" ref={win.attachScroll} onScroll={win.onScroll}>
          <div
            className="filexplorer-grid"
            data-testid="file-explorer-grid"
            ref={win.itemsRef}
            style={{ paddingTop: win.padTop, paddingBottom: win.padBottom }}
          >
            {visible.map((entry) => (
              <FileCard
                key={tagKey(entry)}
                entry={entry}
                activeSessionId={activeSessionId}
                tags={tagsOf(entry)}
                reserveTags={allTags.length > 0}
                selected={selected.includes(tagKey(entry))}
                onToggleSelect={(additive) => toggleSelected(entry, additive)}
                onEditTags={() => editTags(entry)}
                onDragStart={onItemDragStart(entry)}
                onPointerHint={onItemPointerHint(entry)}
                getText={textOf(entry)}
                getFreshText={freshTextOf(entry)}
              />
            ))}
          </div>
        </div>
      ) : (
        <>
          {/* Outside the scroller, so the columns stay put while you scroll. */}
          <div className="filexplorer-list-head">
            <SortHeader label="Name" mode="name" active={sortMode} dir={sortDir} onSort={sortByColumn} />
            <SortHeader label="Modified" mode="date" active={sortMode} dir={sortDir} onSort={sortByColumn} />
            <SortHeader label="Size" mode="size" active={sortMode} dir={sortDir} onSort={sortByColumn} />
          </div>
          <div className="filexplorer-scroll" ref={win.attachScroll} onScroll={win.onScroll}>
            <div
              className="filexplorer-list"
              data-testid="file-explorer-list"
              ref={win.itemsRef}
              style={{ paddingTop: win.padTop, paddingBottom: win.padBottom }}
            >
              {visible.map((entry) => (
                <FileRow
                  key={tagKey(entry)}
                  entry={entry}
                  activeSessionId={activeSessionId}
                  tags={tagsOf(entry)}
                  reserveTags={false}
                  selected={selected.includes(tagKey(entry))}
                  onToggleSelect={(additive) => toggleSelected(entry, additive)}
                  onEditTags={() => editTags(entry)}
                  onDragStart={onItemDragStart(entry)}
                  onPointerHint={onItemPointerHint(entry)}
                  getText={textOf(entry)}
                getFreshText={freshTextOf(entry)}
                />
              ))}
            </div>
          </div>
        </>
      )}

      <div
        className="filexplorer-resize"
        onPointerDown={onResizeStart}
        onPointerMove={onResizeMove}
        onPointerUp={onResizeEnd}
        title="Drag to resize"
        data-testid="file-explorer-resize"
      />
    </aside>
  );
}

interface FileItemProps {
  entry: Entry;
  /**
   * Keep the tag row's space even when this file has no tags. Windowing
   * measures one card and assumes the rest match, so in a folder where
   * *anything* is tagged every card has to carry the row. Folders with no
   * tags at all stay compact.
   */
  reserveTags: boolean;
  activeSessionId: string;
  tags: string[];
  selected: boolean;
  onToggleSelect: (additive: boolean) => void;
  onEditTags: () => void;
  onDragStart: (e: React.DragEvent) => void;
  /** Called on hover/press to pre-read the file, so a drag has content ready. */
  onPointerHint: () => void;
  /** Read-through accessor for the file's text; fills the panel's shared cache. */
  getText: () => Promise<string>;
  /** Bypasses the cache and re-reads the file; used when opening it. */
  getFreshText: () => Promise<string>;
}

/** A clickable list-view column title; clicking the active one flips direction. */
function SortHeader({
  label,
  mode,
  active,
  dir,
  onSort,
}: {
  label: string;
  mode: SortMode;
  active: SortMode;
  dir: SortDir;
  onSort: (mode: SortMode) => void;
}) {
  const isActive = active === mode;
  return (
    <button
      className={`filexplorer-col ${isActive ? "active" : ""}`}
      onClick={() => onSort(mode)}
      title={`Sort by ${label.toLowerCase()}`}
      data-testid={`file-explorer-col-${mode}`}
    >
      {label}
      <span className="filexplorer-col-arrow">{isActive ? (dir === "asc" ? "▲" : "▼") : ""}</span>
    </button>
  );
}

/**
 * Lazily renders a geometry preview once the element scrolls into view.
 * Returns markup: an inline SVG for drawings, an `<img>` (isometric PNG)
 * for 3D models — see model3d/modelThumbnail.ts, loaded on first use.
 */
function useThumbnail(
  entry: Entry,
  getText: () => Promise<string>,
  size: number,
  ref: React.RefObject<HTMLElement>,
): string | null {
  const [svg, setSvg] = useState<string | null>(null);
  const canvasTheme = useTheme((s) => s.tokens.canvas);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    let done = false;
    let unmounted = false;
    let cancelQueued: (() => void) | null = null;
    const observer = new IntersectionObserver(
      (entries) => {
        if (!done && entries.some((e) => e.isIntersecting)) {
          done = true;
          observer.disconnect();
          // Reading and rasterising happens on the shared queue, so a folder
          // of hundreds of drawings fills in gradually instead of locking up
          // the app while every visible card parses at once.
          cancelQueued = queueThumbnail(async () => {
            if (isModelFile(entry.name)) {
              // The model parse runs in the worker pool (and is cached), so
              // it must not hold this serial queue: read the bytes here, hand
              // them off, and let the card fill in whenever the pool is done.
              // Several model previews then load in parallel instead of one
              // slow assembly stalling every card behind it.
              const fallback = `<span class="filecard-model-fallback">3D</span>`;
              try {
                const [{ thumbnailForModelFile }, bytes] = await Promise.all([
                  import("../model3d/modelThumbnail"),
                  readEntryBytes(entry),
                ]);
                void thumbnailForModelFile(entry.name, bytes).then(
                  (url) => {
                    if (!unmounted) setSvg(url ? `<img src="${url}" alt="" draggable="false" />` : fallback);
                  },
                  () => {
                    if (!unmounted) setSvg(fallback);
                  },
                );
              } catch {
                setSvg(fallback);
              }
              return;
            }
            if (isEpsFile(entry.name)) {
              // F-03: the file's own TIFF preview when it has one (instant, and what the author saw); else render the imported vectors.
              try {
                const reader = await entryReader(entry);
                if (!reader) throw new Error("no source");
                const url = await epsThumbnailDataUrl(reader, size * 3);
                if (url) setSvg(`<img src="${url}" alt="" draggable="false" />`);
                else {
                  const eps = await importEpsFromReader(reader);
                  setSvg(epsEntitiesToSvg(eps.entities, { size, background: canvasTheme.bg, stroke: canvasTheme.entity }));
                }
              } catch {
                setSvg(fileToSvg(entry.name, "", { size }));
              }
              return;
            }
            try {
              const text = await getText();
              setSvg(fileToSvg(entry.name, text, { size, background: canvasTheme.bg, stroke: canvasTheme.entity }));
            } catch {
              setSvg(fileToSvg(entry.name, "", { size }));
            }
          });
        }
      },
      { rootMargin: "200px" },
    );
    observer.observe(el);
    return () => {
      unmounted = true;
      observer.disconnect();
      cancelQueued?.();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entry.name, entry.rev, size, canvasTheme]);
  return svg;
}

function FileCard({ entry, activeSessionId, tags, reserveTags, selected, onToggleSelect, onEditTags, onDragStart, onPointerHint, getText, getFreshText }: FileItemProps) {
  const cardRef = useRef<HTMLButtonElement>(null);
  const svg = useThumbnail(entry, getText, 110, cardRef);

  const activeName = getSessions().find((s) => s.id === activeSessionId)?.name;
  const isActive = activeName === entry.name;

  // Model files read their own bytes inside openEntry; no need for the text.
  const handleOpen = async () => openEntry(entry, isModelFile(entry.name) ? "" : await getFreshText());

  return (
    <button
      className={`filecard ${isActive ? "active" : ""} ${selected ? "selected" : ""}`}
      data-testid="file-card"
      data-vitem=""
      title={`Open ${entry.name}${tags.length ? ` — tagged ${tags.join(", ")}` : ""}\nCtrl-click to select · drag out to copy the file · right-click to tag`}
      onClick={(e) => (e.ctrlKey || e.metaKey || e.shiftKey ? onToggleSelect(true) : void handleOpen())}
      onContextMenu={(e) => {
        e.preventDefault();
        onEditTags();
      }}
      draggable
      onDragStart={onDragStart}
      onPointerEnter={onPointerHint}
      onPointerDown={onPointerHint}
      ref={cardRef}
    >
      <span className="filecard-thumb">
        {svg ? <span dangerouslySetInnerHTML={{ __html: svg }} /> : <span className="filecard-placeholder" />}
      </span>
      <span className="filecard-name">{entry.name}</span>
      {(tags.length > 0 || reserveTags) && (
        <span className="filecard-tags">
          {tags.map((t) => (
            <span key={t} className="filetag mini">
              {t}
            </span>
          ))}
        </span>
      )}
    </button>
  );
}

function FileRow({ entry, activeSessionId, tags, selected, onToggleSelect, onEditTags, onDragStart, onPointerHint, getText, getFreshText }: FileItemProps) {
  // Rows put tags inline on a fixed-height line, so they need no reservation.
  const rowRef = useRef<HTMLButtonElement>(null);
  // A small geometry preview, so the list is still scannable by shape and not
  // just by filename. Rendering it also warms the shared text cache, which is
  // what makes a drag out of the list work on the first attempt.
  const svg = useThumbnail(entry, getText, 22, rowRef);
  const activeName = getSessions().find((s) => s.id === activeSessionId)?.name;
  const isActive = activeName === entry.name;

  // Model files read their own bytes inside openEntry; no need for the text.
  const handleOpen = async () => openEntry(entry, isModelFile(entry.name) ? "" : await getFreshText());

  return (
    <button
      ref={rowRef}
      className={`filerow ${isActive ? "active" : ""} ${selected ? "selected" : ""}`}
      data-testid="file-row"
      data-vitem=""
      title={`Open ${entry.name}${tags.length ? ` — tagged ${tags.join(", ")}` : ""}\nCtrl-click to select · drag out to copy the file · right-click to tag`}
      onClick={(e) => (e.ctrlKey || e.metaKey || e.shiftKey ? onToggleSelect(true) : void handleOpen())}
      onContextMenu={(e) => {
        e.preventDefault();
        onEditTags();
      }}
      draggable
      onDragStart={onDragStart}
      onPointerEnter={onPointerHint}
      onPointerDown={onPointerHint}
    >
      <span className="filerow-name">
        <span className="filerow-thumb" aria-hidden="true">
          {svg ? <span dangerouslySetInnerHTML={{ __html: svg }} /> : null}
        </span>
        <span className="filerow-label">{entry.name}</span>
        {tags.length > 0 && (
          <span className="filecard-tags">
            {tags.map((t) => (
              <span key={t} className="filetag mini">
                {t}
              </span>
            ))}
          </span>
        )}
      </span>
      <span className="filerow-date">{formatDate(entry.mtime)}</span>
      <span className="filerow-size">{formatSize(entry.size)}</span>
    </button>
  );
}

function GridIcon() {
  return (
    <svg viewBox="0 0 24 24" width="14" height="14">
      <rect x="3" y="3" width="8" height="8" rx="1.5" fill="currentColor" />
      <rect x="13" y="3" width="8" height="8" rx="1.5" fill="currentColor" />
      <rect x="3" y="13" width="8" height="8" rx="1.5" fill="currentColor" />
      <rect x="13" y="13" width="8" height="8" rx="1.5" fill="currentColor" />
    </svg>
  );
}

function ListIcon() {
  return (
    <svg viewBox="0 0 24 24" width="14" height="14">
      <rect x="3" y="4.5" width="18" height="2.5" rx="1" fill="currentColor" />
      <rect x="3" y="10.75" width="18" height="2.5" rx="1" fill="currentColor" />
      <rect x="3" y="17" width="18" height="2.5" rx="1" fill="currentColor" />
    </svg>
  );
}
