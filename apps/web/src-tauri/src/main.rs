#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use base64::Engine;
use std::path::Path;
use tauri::{AppHandle, Emitter, Manager};

/// Payload sent to the UI when a drawing is opened from the OS
/// (double-click, "Open with", or a file argument on launch). Text formats
/// (DXF, SVG) use `text`. DWG and 3D models are binary and travel as just a
/// `path`: the UI fetches the bytes itself via `read_file_bytes`, which
/// arrives as raw bytes over IPC rather than a base64 string doubling the
/// transfer size — see apps/web/src/dxf/desktopBridge.ts. `base64` is kept
/// on the wire (unset here) only so a UI briefly out of step with this
/// binary during an update still has a field to fall back to.
#[derive(serde::Serialize, Clone)]
struct OpenFile {
    name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    text: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    base64: Option<String>,
    /// The file's containing folder, so the UI can offer the in-app file
    /// browser (R9) pre-loaded with its sibling drawings.
    dir: String,
    /// The full path, so a plain "Save" can write straight back to the file
    /// that was double-clicked (see write_drawing_file), and so binary
    /// formats can be fetched via `read_file_bytes`.
    path: String,
}

/// Reads a `.dxf`, `.svg`, `.dwg`, or `.step`/`.iges` file and forwards its
/// content to the web UI, which loads it onto the canvas (or, for 3D models,
/// into a viewer tab). The event name selects how the UI interprets it.
/// Reading in Rust avoids needing filesystem permissions in the frontend.
fn emit_file(app: &AppHandle, path: &str) {
    let lower = path.to_lowercase();
    let (event, is_binary) = if lower.ends_with(".dxf") {
        // Path-only: the UI reads the bytes and picks UTF-8 or the file's
        // $DWGCODEPAGE (a Cyrillic 1251 file is not valid UTF-8).
        ("open-dxf", true)
    } else if lower.ends_with(".svg") {
        ("open-svg", false)
    } else if lower.ends_with(".dwg") {
        ("open-dwg", true)
    } else if lower.ends_with(".eps") || lower.ends_with(".ai") {
        ("open-eps", true)
    } else if is_model_path(&lower) {
        ("open-model", true)
    } else {
        return;
    };

    let p = Path::new(path);
    let name = p
        .file_name()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| "drawing".to_string());
    let dir = p
        .parent()
        .map(|d| d.to_string_lossy().to_string())
        .unwrap_or_default();

    if is_binary {
        // Existence check only — the bytes themselves are fetched by the UI
        // via read_file_bytes, once it has a worker/tab ready to receive them.
        if p.is_file() {
            let _ = app.emit(
                event,
                OpenFile { name, text: None, base64: None, dir, path: path.to_string() },
            );
        }
    } else if let Ok(text) = std::fs::read_to_string(path) {
        let _ = app.emit(
            event,
            OpenFile { name, text: Some(text), base64: None, dir, path: path.to_string() },
        );
    }
}

fn is_model_path(lower: &str) -> bool {
    lower.ends_with(".step") || lower.ends_with(".stp") || lower.ends_with(".iges") || lower.ends_with(".igs")
}

fn first_drawing_arg(args: &[String]) -> Option<String> {
    args.iter()
        .skip(1)
        .find(|a| {
            let l = a.to_lowercase();
            l.ends_with(".dxf") || l.ends_with(".svg") || l.ends_with(".dwg")
                || l.ends_with(".eps")
                || l.ends_with(".ai")
                || is_model_path(&l)
        })
        .cloned()
}

/// A drawing file found by `list_drawings_in_dir`, listed in the in-app file
/// browser (R9).
#[derive(serde::Serialize)]
struct DrawingEntry {
    name: String,
    path: String,
    /// Last-modified time in milliseconds since the Unix epoch, matching the
    /// browser's `File.lastModified` so the panel sorts both sources alike.
    /// `None` when the platform or filesystem can't report it.
    mtime: Option<f64>,
    /// Size in bytes, `None` if it couldn't be read.
    size: Option<f64>,
}

/// Lists `.dxf`/`.svg` drawings and `.step`/`.iges` models directly inside
/// `dir` (non-recursive), for the in-app file browser's left-dock panel.
/// Reads no file contents — those are fetched on demand per visible card via
/// `read_drawing_file`.
/// DWG isn't listed here — it's binary and import-only, opened via the Open
/// dialog or file association instead of the folder-browser grid.
///
/// Runs on the blocking pool rather than the main thread: a library folder of
/// ten thousand drawings means ten thousand `stat` calls, and on a cold cache
/// or a network share that is long enough to stall the window if it ran where
/// events are pumped.
#[tauri::command]
async fn list_drawings_in_dir(dir: String) -> Result<Vec<DrawingEntry>, String> {
    tauri::async_runtime::spawn_blocking(move || scan_drawings(&dir))
        .await
        .map_err(|e| e.to_string())?
}

fn scan_drawings(dir: &str) -> Result<Vec<DrawingEntry>, String> {
    let entries = std::fs::read_dir(dir).map_err(|e| e.to_string())?;
    let mut out = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        let lower = path.to_string_lossy().to_lowercase();
        if !(lower.ends_with(".dxf") || lower.ends_with(".svg") || lower.ends_with(".eps") || lower.ends_with(".ai") || is_model_path(&lower)) {
            continue;
        }
        let name = match path.file_name() {
            Some(n) => n.to_string_lossy().to_string(),
            None => continue,
        };
        // Metadata is best-effort: a file we can list but not stat still gets
        // shown, just without a date or size.
        let meta = entry.metadata().ok();
        let mtime = meta.as_ref().and_then(|m| m.modified().ok()).and_then(|t| {
            t.duration_since(std::time::UNIX_EPOCH)
                .ok()
                .map(|d| d.as_millis() as f64)
        });
        let size = meta.as_ref().map(|m| m.len() as f64);
        out.push(DrawingEntry {
            name,
            path: path.to_string_lossy().to_string(),
            mtime,
            size,
        });
    }
    Ok(out)
}

/// Reads one drawing file's text content by full path, for rendering its
/// thumbnail or opening it into a tab. Kept separate from the directory
/// listing so a folder of hundreds of files doesn't read them all upfront.
#[tauri::command]
fn read_drawing_file(path: String) -> Result<String, String> {
    // Bytes + lossy decode: a Latin-1 name in an SVG must not fail the whole read (F-10).
    let bytes = std::fs::read(&path).map_err(|e| e.to_string())?;
    Ok(match String::from_utf8(bytes) {
        Ok(s) => s,
        Err(e) => String::from_utf8_lossy(e.as_bytes()).into_owned(),
    })
}

/// Reads a file's raw bytes by full path, for binary formats (DWG, 3D
/// models) and for any file whose bytes might not be valid UTF-8 (STEP/IGES
/// are technically text, but SolidWorks and friends sometimes write Latin-1
/// names into them — `read_drawing_file`'s `read_to_string` would fail
/// outright on those). Returns a `tauri::ipc::Response`, which arrives in JS
/// as an `ArrayBuffer` rather than a string, so callers that need the exact
/// bytes (the model cache key is a hash of them) get them unchanged with no
/// base64 round trip inflating the transfer by a third. Runs on the blocking
/// pool like `list_drawings_in_dir` — a model file can be tens of megabytes.
#[tauri::command]
async fn read_file_bytes(path: String) -> Result<tauri::ipc::Response, String> {
    tauri::async_runtime::spawn_blocking(move || read_bytes(&path).map(tauri::ipc::Response::new))
        .await
        .map_err(|e| e.to_string())?
}

fn read_bytes(path: &str) -> Result<Vec<u8>, String> {
    std::fs::read(path).map_err(|e| e.to_string())
}

/// Reads `length` bytes starting at `offset` (fewer at the end of the file) as
/// an `ArrayBuffer`. EPS/AI import (F-01) needs only a header, a preview and,
/// for Illustrator files, the PostScript section — a Photoshop EPS can be
/// 260 MB of raster nobody wants shipped over IPC.
#[tauri::command]
async fn read_file_range(path: String, offset: u64, length: u64) -> Result<tauri::ipc::Response, String> {
    tauri::async_runtime::spawn_blocking(move || read_range(&path, offset, length).map(tauri::ipc::Response::new))
        .await
        .map_err(|e| e.to_string())?
}

fn read_range(path: &str, offset: u64, length: u64) -> Result<Vec<u8>, String> {
    use std::io::{Read, Seek, SeekFrom};
    let mut f = std::fs::File::open(path).map_err(|e| e.to_string())?;
    f.seek(SeekFrom::Start(offset)).map_err(|e| e.to_string())?;
    let mut buf = Vec::new();
    f.take(length).read_to_end(&mut buf).map_err(|e| e.to_string())?;
    Ok(buf)
}

/// Writes a drawing back to a full native path. The desktop file browser and
/// the OS file association hand the UI a path rather than a File System Access
/// handle, so a plain "Save" of a file opened that way needs this to overwrite
/// the original instead of reprompting for a location.
#[tauri::command]
fn write_drawing_file(path: String, contents: String) -> Result<(), String> {
    std::fs::write(&path, contents).map_err(|e| e.to_string())
}

/// Binary twin of `write_drawing_file` (EPS with a TIFF preview): the bytes
/// arrive base64-encoded so they survive the JSON IPC unchanged.
#[tauri::command]
fn write_drawing_bytes(path: String, base64: String) -> Result<(), String> {
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(base64.as_bytes())
        .map_err(|e| e.to_string())?;
    std::fs::write(&path, bytes).map_err(|e| e.to_string())
}

/// Where model previews are mirrored for the Explorer thumbnail handler.
/// Must agree with `cache_dir` in native/dxf-thumbnailer/src/model.rs:
/// `%LOCALAPPDATA%/Sketchor/thumbs`. None off Windows (no handler there).
fn thumbnail_cache_dir() -> Option<std::path::PathBuf> {
    let base = std::env::var_os("LOCALAPPDATA")?;
    Some(std::path::Path::new(&base).join("Sketchor").join("thumbs"))
}

/// Mirrors a rendered model preview (PNG, base64) to the thumbnail cache the
/// Explorer shell extension reads, keyed by the SHA-256 of the model file's
/// bytes — the same key the web side's own cache uses. Explorer then shows
/// the exact picture the app rendered instead of the DLL's wireframe
/// fallback. Idempotent; returns whether a file was written.
#[tauri::command]
fn write_thumbnail_cache(hash: String, png_base64: String) -> Result<bool, String> {
    if hash.len() != 64 || !hash.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err("bad hash".into());
    }
    let Some(dir) = thumbnail_cache_dir() else { return Ok(false) };
    let path = dir.join(format!("{hash}.png"));
    if path.exists() {
        return Ok(false);
    }
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(png_base64.as_bytes())
        .map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    // Write-then-rename so Explorer never reads a half-written PNG.
    let tmp = dir.join(format!("{hash}.tmp"));
    std::fs::write(&tmp, bytes).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, &path).map_err(|e| e.to_string())?;
    Ok(true)
}

/// Explorer (Windows 11) only consults a per-user thumbnail handler for an
/// extension when `HKLM\Software\Classes\<ext>\ShellEx\{thumbnail}` exists.
/// The per-user installer can't write HKLM, so the app offers the one-time
/// elevated step. These two commands back that: the first says whether it's
/// still needed, the second performs it (a UAC prompt) and re-checks.
/// Off Windows both report "not applicable".
///
/// `.eps`/`.ai` (F-03) usually already have another program's marker (Illustrator,
/// Acrobat): only *missing* keys are ever written, never overwritten.
const THUMB_MARKER_EXTS: [&str; 7] = [".step", ".stp", ".iges", ".igs", ".dxf", ".eps", ".ai"];
const SHELLEX_THUMB: &str = "{E357FCCD-A995-4576-B01F-234630154E96}";
const SKETCHOR_THUMB_CLSID: &str = "{6F9E2A31-7C4B-4D8E-9A1F-2B3C4D5E6F70}";

#[derive(serde::Serialize)]
struct ExplorerPreviewStatus {
    /// True on Windows when at least one marker key is missing.
    needs_elevation: bool,
    applicable: bool,
}

#[cfg(windows)]
fn missing_markers() -> Vec<&'static str> {
    use std::os::windows::process::CommandExt;
    THUMB_MARKER_EXTS
        .iter()
        .copied()
        .filter(|ext| {
            let key = format!(r"HKLM\Software\Classes\{ext}\ShellEx\{SHELLEX_THUMB}");
            // CREATE_NO_WINDOW: no console flash from reg.exe.
            !std::process::Command::new("reg")
                .args(["query", &key, "/ve"])
                .creation_flags(0x0800_0000)
                .output()
                .map(|o| o.status.success())
                .unwrap_or(false)
        })
        .collect()
}

#[cfg(windows)]
fn marker_missing() -> bool {
    !missing_markers().is_empty()
}

#[tauri::command]
fn explorer_previews_status() -> ExplorerPreviewStatus {
    #[cfg(windows)]
    {
        ExplorerPreviewStatus { needs_elevation: marker_missing(), applicable: true }
    }
    #[cfg(not(windows))]
    {
        ExplorerPreviewStatus { needs_elevation: false, applicable: false }
    }
}

/// The marker keys as a `.reg` file: one elevated `regedit /s` import (one
/// UAC prompt, shown as "Registry Editor", Microsoft-signed) covers every
/// extension. Exposed for the installer-side script and tests to share.
#[cfg(test)]
fn markers_reg_file() -> String {
    markers_reg_file_for(&THUMB_MARKER_EXTS)
}

#[cfg(any(windows, test))]
fn markers_reg_file_for(exts: &[&str]) -> String {
    let mut out = String::from("Windows Registry Editor Version 5.00\r\n");
    for ext in exts {
        out.push_str(&format!(
            "\r\n[HKEY_LOCAL_MACHINE\\Software\\Classes\\{ext}\\ShellEx\\{SHELLEX_THUMB}]\r\n@=\"{SKETCHOR_THUMB_CLSID}\"\r\n"
        ));
    }
    out
}

/// Creates the marker keys through an elevated `regedit /s` import (a UAC
/// prompt) and waits. Returns whether the keys are all present afterwards —
/// false when the user declined.
#[tauri::command]
fn enable_explorer_previews() -> Result<bool, String> {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        if !marker_missing() {
            return Ok(true);
        }
        let reg = std::env::temp_dir().join("sketchor-explorer-previews.reg");
        std::fs::write(&reg, markers_reg_file_for(&missing_markers())).map_err(|e| e.to_string())?;
        // Start-Process -Verb RunAs is the supported way to request elevation
        // from an unelevated process; -Wait so the re-check below is honest.
        let ps = format!(
            "Start-Process -FilePath regedit.exe -ArgumentList '/s \"{}\"' -Verb RunAs -Wait",
            reg.display()
        );
        // A declined prompt makes Start-Process throw; the re-check is what
        // we report either way, so the exit status itself is ignored.
        let _ = std::process::Command::new("powershell")
            .args(["-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-Command", &ps])
            .creation_flags(0x0800_0000)
            .status()
            .map_err(|e| e.to_string())?;
        let _ = std::fs::remove_file(&reg);
        if marker_missing() {
            return Ok(false);
        }
        // Tell Explorer the associations changed so open windows refresh.
        let _ = std::process::Command::new("powershell")
            .args([
                "-NoProfile",
                "-NonInteractive",
                "-WindowStyle",
                "Hidden",
                "-Command",
                "Add-Type -Name N -Namespace S -MemberDefinition '[DllImport(\"shell32.dll\")] public static extern void SHChangeNotify(int e, int f, IntPtr a, IntPtr b);'; [S.N]::SHChangeNotify(0x08000000, 0, [IntPtr]::Zero, [IntPtr]::Zero)",
            ])
            .creation_flags(0x0800_0000)
            .status();
        Ok(true)
    }
    #[cfg(not(windows))]
    {
        Ok(false)
    }
}

fn main() {
    tauri::Builder::default()
        // Opens URLs (release notes, the website behind the logo).
        .plugin(tauri_plugin_opener::init())
        // Signed in-app updates: the UI calls `check()` / `downloadAndInstall()`
        // and then `relaunch()` from the process plugin.
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        // A second launch (e.g. double-clicking another .dxf) forwards its
        // argv to the already-running window instead of opening a new one.
        .plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            if let Some(path) = first_drawing_arg(&argv) {
                emit_file(app, &path);
            }
            if let Some(win) = app.get_webview_window("main") {
                let _ = win.set_focus();
            }
        }))
        .invoke_handler(tauri::generate_handler![
            list_drawings_in_dir,
            read_drawing_file,
            read_file_bytes,
            read_file_range,
            write_drawing_file,
            write_drawing_bytes,
            write_thumbnail_cache,
            explorer_previews_status,
            enable_explorer_previews
        ])
        .setup(|app| {
            // Handle a file passed on the initial launch.
            if let Some(path) = first_drawing_arg(&std::env::args().collect::<Vec<_>>()) {
                let handle = app.handle().clone();
                // Give the webview a moment to register its event listener.
                std::thread::spawn(move || {
                    std::thread::sleep(std::time::Duration::from_millis(700));
                    emit_file(&handle, &path);
                });
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running Sketchor");
}

#[cfg(test)]
mod tests {
    use super::*;
    use base64::Engine;

    /// The sidecar cache is what Explorer's thumbnail handler reads; a key that
    /// isn't exactly the file hash, or a path that escapes the cache folder,
    /// would either hide previews or let a web page write outside it.
    #[test]
    fn thumbnail_cache_writes_once_under_the_hash_and_rejects_bad_keys() {
        let tmp = std::env::temp_dir().join(format!("sketchor-thumb-test-{}", std::process::id()));
        std::env::set_var("LOCALAPPDATA", &tmp);
        let png = base64::engine::general_purpose::STANDARD.encode(b"\x89PNG\r\n\x1a\nnot really");
        let hash = "e062355918f93e71fa391310ebbfc037a0c11f6436104f90b96fdbd737787d17".to_string();

        assert_eq!(write_thumbnail_cache(hash.clone(), png.clone()), Ok(true));
        let path = tmp.join("Sketchor").join("thumbs").join(format!("{hash}.png"));
        assert!(path.is_file());
        // Second write is a no-op (the file is content-addressed).
        assert_eq!(write_thumbnail_cache(hash.clone(), png.clone()), Ok(false));
        assert!(!tmp.join("Sketchor").join("thumbs").join(format!("{hash}.tmp")).exists());

        for bad in ["", "abc", "../../evil", &"z".repeat(64), &format!("{}/x", &hash[..61])] {
            assert!(write_thumbnail_cache(bad.to_string(), png.clone()).is_err(), "{bad}");
        }
        // A fresh key with undecodable data writes nothing (the existence
        // check above comes first on purpose — it is the cheap path).
        let other = "0".repeat(64);
        assert!(write_thumbnail_cache(other.clone(), "%%%not base64".into()).is_err());
        assert!(!tmp.join("Sketchor").join("thumbs").join(format!("{other}.png")).exists());
        let _ = std::fs::remove_dir_all(&tmp);
    }

    /// S-03: the old desktop-file-browser path read a model file with
    /// `read_to_string` and re-encoded it, which fails outright on a STEP
    /// file with non-UTF-8 bytes (Latin-1 part names are common from
    /// SolidWorks). `read_bytes` must return exactly what was written.
    #[test]
    fn read_bytes_round_trips_non_utf8_bytes_unchanged() {
        let tmp = std::env::temp_dir().join(format!("sketchor-bytes-test-{}", std::process::id()));
        let bytes: Vec<u8> = vec![0x53, 0x54, 0x45, 0x50, 0xE9, 0xFF, 0x00, 0x01, 0x02];
        std::fs::write(&tmp, &bytes).unwrap();
        let result = read_bytes(tmp.to_str().unwrap());
        let _ = std::fs::remove_file(&tmp);
        assert_eq!(result, Ok(bytes));
    }

    /// EPS/AI import reads only a header, a preview and the PostScript: a range
    /// past the end is shortened, never an error, and an offset past it is empty.
    #[test]
    fn read_range_returns_the_slice_and_clamps_at_the_end() {
        let tmp = std::env::temp_dir().join(format!("sketchor-range-test-{}", std::process::id()));
        std::fs::write(&tmp, [10u8, 11, 12, 13, 14, 15]).unwrap();
        let p = tmp.to_str().unwrap();
        let mid = read_range(p, 2, 3);
        let tail = read_range(p, 4, 100);
        let past = read_range(p, 99, 4);
        let _ = std::fs::remove_file(&tmp);
        assert_eq!(mid, Ok(vec![12, 13, 14]));
        assert_eq!(tail, Ok(vec![14, 15]));
        assert_eq!(past, Ok(vec![]));
    }

    /// The .reg import is the only way the markers get created on a user's
    /// machine; a malformed file imports nothing and Explorer silently keeps
    /// showing icons.
    #[test]
    fn markers_reg_file_covers_every_extension_in_regedit_syntax() {
        let reg = markers_reg_file();
        assert!(reg.starts_with("Windows Registry Editor Version 5.00\r\n"));
        for ext in THUMB_MARKER_EXTS {
            let expected = format!(
                "[HKEY_LOCAL_MACHINE\\Software\\Classes\\{ext}\\ShellEx\\{SHELLEX_THUMB}]\r\n@=\"{SKETCHOR_THUMB_CLSID}\""
            );
            assert!(reg.contains(&expected), "{ext}");
        }
    }
}
