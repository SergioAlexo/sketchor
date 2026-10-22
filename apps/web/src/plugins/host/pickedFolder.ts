/**
 * Pure folder walking and path resolution behind `ui.pickFolder` /
 * `ui.readPickedFile` (host API 0.9.0).
 *
 * Written against minimal handle shapes so it runs on real File System Access
 * handles in the app and on plain fakes in tests. The security-relevant part
 * is {@link splitRelPath}: a plugin supplies the path it wants to read, so
 * anything that could leave the picked folder is rejected before a handle is
 * touched.
 */

export interface FileLike {
  size: number;
  arrayBuffer(): Promise<ArrayBuffer>;
}
export interface FileHandleLike {
  kind: "file";
  name: string;
  getFile(): Promise<FileLike>;
}
export interface DirHandleLike {
  kind?: "directory";
  name?: string;
  values(): AsyncIterable<FileHandleLike | (DirHandleLike & { kind: "directory"; name: string })>;
  getDirectoryHandle(name: string): Promise<DirHandleLike>;
  getFileHandle(name: string): Promise<FileHandleLike>;
}

/** Listing caps, so a huge or cyclic tree (symlinks/junctions) cannot hang the host. */
export const MAX_FILES = 20000;
export const MAX_DEPTH = 16;

/** Lists every file under `root` (recursively, sorted by relPath). Unreadable entries are skipped, never thrown. */
export async function listDirectory(
  root: DirHandleLike,
  limits: { maxFiles?: number; maxDepth?: number } = {},
): Promise<{ files: { relPath: string; size: number }[]; truncated: boolean }> {
  const maxFiles = limits.maxFiles ?? MAX_FILES;
  const maxDepth = limits.maxDepth ?? MAX_DEPTH;
  const files: { relPath: string; size: number }[] = [];
  let truncated = false;

  const walk = async (dir: DirHandleLike, prefix: string, depth: number): Promise<void> => {
    try {
      for await (const item of dir.values()) {
        if (files.length >= maxFiles) {
          truncated = true;
          return;
        }
        if (item.kind === "file") {
          try {
            const f = await (item as FileHandleLike).getFile();
            files.push({ relPath: prefix + item.name, size: f.size });
          } catch {
            // vanished or locked: leave it out
          }
        } else if (item.kind === "directory") {
          if (depth >= maxDepth) {
            truncated = true;
            continue;
          }
          await walk(item as DirHandleLike, `${prefix}${item.name}/`, depth + 1);
          if (truncated && files.length >= maxFiles) return;
        }
      }
    } catch {
      // unreadable directory: skip it
    }
  };

  await walk(root, "", 0);
  files.sort((a, b) => (a.relPath < b.relPath ? -1 : a.relPath > b.relPath ? 1 : 0));
  return { files, truncated };
}

/**
 * Splits a plugin-supplied relative path into segments, or throws if it could
 * leave the picked folder: empty, absolute (leading slash, drive letter),
 * `.`/`..` segments, empty segments, or control characters. Accepts `\` as a
 * separator too.
 */
export function splitRelPath(relPath: string): string[] {
  if (typeof relPath !== "string" || relPath === "") throw new Error("Invalid path");
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f]/.test(relPath)) throw new Error("Invalid path");
  const norm = relPath.replace(/\\/g, "/");
  if (norm.startsWith("/") || /^[a-zA-Z]:/.test(norm)) throw new Error("Path must be relative to the picked folder");
  const parts = norm.split("/");
  for (const p of parts) {
    if (p === "" || p === "." || p === "..") throw new Error("Path must stay inside the picked folder");
  }
  return parts;
}

/** Reads a file under `root` by relative path; text is decoded as UTF-8 (a BOM is dropped). */
export async function readPickedFile(root: DirHandleLike, relPath: string, as: "text"): Promise<string>;
export async function readPickedFile(root: DirHandleLike, relPath: string, as: "bytes"): Promise<Uint8Array>;
export async function readPickedFile(root: DirHandleLike, relPath: string, as: "text" | "bytes"): Promise<string | Uint8Array>;
export async function readPickedFile(root: DirHandleLike, relPath: string, as: "text" | "bytes"): Promise<string | Uint8Array> {
  const parts = splitRelPath(relPath);
  let dir = root;
  for (const seg of parts.slice(0, -1)) dir = await dir.getDirectoryHandle(seg);
  const file = await (await dir.getFileHandle(parts[parts.length - 1])).getFile();
  const bytes = new Uint8Array(await file.arrayBuffer());
  return as === "bytes" ? bytes : new TextDecoder("utf-8").decode(bytes);
}
