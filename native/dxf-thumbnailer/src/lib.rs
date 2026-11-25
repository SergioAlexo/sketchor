//! Windows Explorer thumbnail provider for `.dxf` drawings, `.svg` (resvg —
//! see native/svg-raster), `.eps`/`.ai` (the embedded TIFF preview — see
//! eps.rs) and `.step`/`.iges` 3D models.
//!
//! Implements an in-process COM server exposing `IThumbnailProvider`
//! (initialised via `IInitializeWithFile`). Explorer calls `GetThumbnail`;
//! for a DXF we parse it and rasterise it to an HBITMAP with GDI, for a
//! model we serve the preview Sketchor rendered (or a text-level wireframe
//! when there is none yet — see model.rs). Shares the rendering intent (dark
//! background, light strokes, fit-to-box) with the Sketchor web thumbnails.
//!
//! Build:   cargo build --release
//! Register (admin): regsvr32 dxf_thumbnailer.dll
//! Unregister:       regsvr32 /u dxf_thumbnailer.dll

pub mod eps;
pub mod model;
pub mod render;

use std::ffi::c_void;
use std::sync::atomic::{AtomicI32, Ordering};

use windows::core::{implement, IUnknown, Interface, GUID, HRESULT, PCWSTR};
use windows::Win32::Foundation::{
    BOOL, CLASS_E_CLASSNOTAVAILABLE, CLASS_E_NOAGGREGATION, E_INVALIDARG, E_NOINTERFACE,
    E_UNEXPECTED, HMODULE, S_FALSE, S_OK,
};
use windows::Win32::System::Com::{IClassFactory, IClassFactory_Impl};
use windows::Win32::System::LibraryLoader::GetModuleFileNameW;
use windows::Win32::UI::Shell::PropertiesSystem::{
    IInitializeWithFile, IInitializeWithFile_Impl,
};
use windows::Win32::UI::Shell::{
    IThumbnailProvider, IThumbnailProvider_Impl, WTSAT_RGB, WTS_ALPHATYPE,
};

use std::cell::RefCell;

// CLSID for this provider: {6F9E2A31-7C4B-4D8E-9A1F-2B3C4D5E6F70}
const CLSID_DXF_THUMB: GUID = GUID::from_u128(0x6f9e2a31_7c4b_4d8e_9a1f_2b3c4d5e6f70);
// Shell's IThumbnailProvider category GUID under .ext\ShellEx.
const SHELLEX_THUMB: &str = "{E357FCCD-A995-4576-B01F-234630154E96}";

/// LockServer count plus live provider instances: `DllCanUnloadNow` must say
/// no while any object exists, or Explorer's periodic CoFreeUnusedLibraries
/// would unmap the code under a thumbnail that is still being drawn. Getting
/// this right is also what lets an updated DLL take effect without a
/// sign-out — Explorer drops the idle old module and loads the new file.
static LOCKS: AtomicI32 = AtomicI32::new(0);
static mut MODULE: HMODULE = HMODULE(std::ptr::null_mut());

/* ----------------------------- provider ----------------------------- */

#[implement(IThumbnailProvider, IInitializeWithFile)]
struct DxfThumb {
    path: RefCell<Option<String>>,
}

impl DxfThumb {
    fn new() -> Self {
        LOCKS.fetch_add(1, Ordering::SeqCst);
        DxfThumb { path: RefCell::new(None) }
    }
}

impl Drop for DxfThumb {
    fn drop(&mut self) {
        LOCKS.fetch_sub(1, Ordering::SeqCst);
    }
}

impl IInitializeWithFile_Impl for DxfThumb_Impl {
    fn Initialize(&self, pszfilepath: &PCWSTR, _grfmode: u32) -> windows::core::Result<()> {
        let path = unsafe { pszfilepath.to_string() }.map_err(|_| E_INVALIDARG)?;
        trace(&format!("initialize {path}"));
        *self.path.borrow_mut() = Some(path);
        Ok(())
    }
}

impl IThumbnailProvider_Impl for DxfThumb_Impl {
    fn GetThumbnail(
        &self,
        cx: u32,
        phbmp: *mut windows::Win32::Graphics::Gdi::HBITMAP,
        pdwalpha: *mut WTS_ALPHATYPE,
    ) -> windows::core::Result<()> {
        if phbmp.is_null() {
            return Err(E_INVALIDARG.into());
        }
        let path = self
            .path
            .borrow()
            .clone()
            .ok_or_else(|| windows::core::Error::from(E_UNEXPECTED))?;
        let hbmp = thumbnail_for(&path, cx.max(16)).ok_or_else(|| windows::core::Error::from(E_UNEXPECTED))?;
        unsafe {
            *phbmp = hbmp;
            if !pdwalpha.is_null() {
                *pdwalpha = WTSAT_RGB;
            }
        }
        Ok(())
    }
}

/// Opt-in trace for diagnosing "no preview in Explorer": create an empty
/// `%LOCALAPPDATA%\Sketchor	humb-debug.log` and every request the shell
/// makes gets appended to it (path, size, which tier answered). Explorer
/// gives no other signal about what a thumbnail handler did.
fn trace(msg: &str) {
    let Some(dir) = model::cache_dir().and_then(|d| d.parent().map(|p| p.to_path_buf())) else { return };
    let log = dir.join("thumb-debug.log");
    if !log.exists() {
        return;
    }
    use std::io::Write;
    if let Ok(mut f) = std::fs::OpenOptions::new().append(true).open(log) {
        let _ = writeln!(f, "[pid {}] {msg}", std::process::id());
    }
}

/// Renders the thumbnail for a file of any supported kind, or None when
/// there is nothing to show (Explorer then falls back to the icon).
fn thumbnail_for(path: &str, size: u32) -> Option<windows::Win32::Graphics::Gdi::HBITMAP> {
    trace(&format!("request {size}px {path}"));
    if eps::is_eps(path) {
        let p = eps::preview(path);
        trace(&format!("  eps preview {}", if p.is_some() { "found" } else { "none" }));
        let p = p?;
        return render::bitmap_from_rgba(&p.rgba, p.size, size).ok();
    }
    if svg_raster::is_svg(path) {
        // SV-07: the preview Sketchor rendered for this exact file when there is one (tier 1), else resvg (tier 2).
        if std::fs::metadata(path).map(|m| m.len() as usize > svg_raster::MAX_SVG_BYTES).unwrap_or(true) {
            trace("  svg missing or too big");
            return None;
        }
        let bytes = std::fs::read(path).ok()?;
        if let Some(p) = model::sidecar(&bytes) {
            trace(&format!("  svg sidecar {}px", p.size));
            return render::bitmap_from_rgba(&p.rgba, p.size, size).ok();
        }
        let r = svg_raster::render_svg(&bytes, size.clamp(16, 1024));
        trace(&format!("  svg resvg {}", if r.is_some() { "ok" } else { "nothing drawn" }));
        let r = r?;
        return render::bitmap_from_rgba(&r.rgba, r.size, size).ok();
    }
    if model::is_model(path) {
        let bytes = match std::fs::read(path) {
            Ok(b) => b,
            Err(e) => {
                trace(&format!("  read failed: {e}"));
                return None;
            }
        };
        if let Some(p) = model::sidecar(&bytes) {
            let r = render::bitmap_from_rgba(&p.rgba, p.size, size);
            trace(&format!("  sidecar {}px -> {}", p.size, if r.is_ok() { "ok" } else { "bitmap failed" }));
            return r.ok();
        }
        let text = String::from_utf8_lossy(&bytes);
        let shapes = model::wireframe(path, &text);
        trace(&format!("  no sidecar; wireframe {} segments", shapes.len()));
        if shapes.is_empty() {
            return None;
        }
        let r = render::render_thumbnail(&shapes, size);
        trace(&format!("  render -> {}", if r.is_ok() { "ok" } else { "failed" }));
        return r.ok();
    }
    let text = std::fs::read_to_string(path).ok()?;
    let shapes = dxf_parse::parse(&text);
    let r = render::render_thumbnail(&shapes, size);
    trace(&format!("  dxf {} shapes -> {}", shapes.len(), if r.is_ok() { "ok" } else { "failed" }));
    r.ok()
}

/* --------------------------- class factory -------------------------- */

#[implement(IClassFactory)]
struct Factory;

impl IClassFactory_Impl for Factory_Impl {
    fn CreateInstance(
        &self,
        punkouter: Option<&IUnknown>,
        riid: *const GUID,
        ppvobject: *mut *mut c_void,
    ) -> windows::core::Result<()> {
        unsafe {
            if !ppvobject.is_null() {
                *ppvobject = std::ptr::null_mut();
            }
        }
        if punkouter.is_some() {
            return Err(CLASS_E_NOAGGREGATION.into());
        }
        let provider: IUnknown = DxfThumb::new().into();
        let hr = unsafe { provider.query(riid, ppvobject) };
        trace(&format!("create-instance riid={:?} -> {:?}", unsafe { *riid }, hr));
        hr.ok()
    }

    fn LockServer(&self, flock: BOOL) -> windows::core::Result<()> {
        if flock.as_bool() {
            LOCKS.fetch_add(1, Ordering::SeqCst);
        } else {
            LOCKS.fetch_sub(1, Ordering::SeqCst);
        }
        Ok(())
    }
}

/* ------------------------------ exports ----------------------------- */

#[no_mangle]
extern "system" fn DllMain(hinst: HMODULE, reason: u32, _reserved: *mut c_void) -> BOOL {
    // DLL_PROCESS_ATTACH == 1
    if reason == 1 {
        unsafe { MODULE = hinst };
    }
    true.into()
}

#[no_mangle]
extern "system" fn DllGetClassObject(
    rclsid: *const GUID,
    riid: *const GUID,
    ppv: *mut *mut c_void,
) -> HRESULT {
    unsafe {
        if ppv.is_null() {
            return E_INVALIDARG;
        }
        *ppv = std::ptr::null_mut();
        trace(&format!("get-class-object clsid={:?} riid={:?}", *rclsid, *riid));
        if *rclsid != CLSID_DXF_THUMB {
            return CLASS_E_CLASSNOTAVAILABLE;
        }
        let factory: IClassFactory = Factory.into();
        match factory.query(riid, ppv) {
            S_OK => S_OK,
            _ => E_NOINTERFACE,
        }
    }
}

#[no_mangle]
extern "system" fn DllCanUnloadNow() -> HRESULT {
    if LOCKS.load(Ordering::SeqCst) == 0 {
        S_OK
    } else {
        S_FALSE
    }
}

fn module_path() -> String {
    let mut buf = [0u16; 260];
    let len = unsafe { GetModuleFileNameW(MODULE, &mut buf) } as usize;
    String::from_utf16_lossy(&buf[..len])
}

#[no_mangle]
extern "system" fn DllRegisterServer() -> HRESULT {
    let clsid = format!("{{{:?}}}", CLSID_DXF_THUMB);
    let dll = module_path();
    if register(&clsid, &dll).is_err() {
        return E_UNEXPECTED;
    }
    S_OK
}

#[no_mangle]
extern "system" fn DllUnregisterServer() -> HRESULT {
    let clsid = format!("{{{:?}}}", CLSID_DXF_THUMB);
    let _ = unregister(&clsid);
    S_OK
}

/* --------------------------- registration --------------------------- */

use windows::core::PCWSTR as RegStr;
use windows::Win32::System::Registry::{
    RegCloseKey, RegCreateKeyExW, RegDeleteTreeW, RegSetValueExW, HKEY, HKEY_CURRENT_USER,
    KEY_WRITE, REG_DWORD, REG_OPTION_NON_VOLATILE, REG_SZ,
};

fn wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}

/// Per-user class-registration root. We register under `HKCU\Software\Classes`
/// rather than `HKEY_CLASSES_ROOT`: `.dxf` and `CLSID` already exist in the
/// machine-wide HKLM hive, so a non-elevated `HKCR` write resolves toward HKLM
/// and fails with ACCESS_DENIED (regsvr32 exit 5) — silently dropping the
/// handler. HKCU always succeeds and Explorer merges it into HKCR at read time.
fn classes(path: &str) -> String {
    format!("Software\\Classes\\{path}")
}

fn create_key(path: &str) -> Result<HKEY, ()> {
    let mut hkey = HKEY::default();
    let p = wide(&classes(path));
    let rc = unsafe {
        RegCreateKeyExW(
            HKEY_CURRENT_USER,
            RegStr(p.as_ptr()),
            0,
            RegStr::null(),
            REG_OPTION_NON_VOLATILE,
            KEY_WRITE,
            None,
            &mut hkey,
            None,
        )
    };
    if rc.is_ok() {
        Ok(hkey)
    } else {
        Err(())
    }
}

fn set_string(path: &str, name: Option<&str>, value: &str) -> Result<(), ()> {
    let hkey = create_key(path)?;
    let val = wide(value);
    let bytes = unsafe {
        std::slice::from_raw_parts(val.as_ptr() as *const u8, val.len() * 2)
    };
    let name_w = name.map(wide);
    let name_ptr = name_w
        .as_ref()
        .map(|n| RegStr(n.as_ptr()))
        .unwrap_or(RegStr::null());
    let rc = unsafe { RegSetValueExW(hkey, name_ptr, 0, REG_SZ, Some(bytes)) };
    unsafe { let _ = RegCloseKey(hkey); };
    if rc.is_ok() {
        Ok(())
    } else {
        Err(())
    }
}

fn set_dword(path: &str, name: &str, value: u32) -> Result<(), ()> {
    let hkey = create_key(path)?;
    let bytes = value.to_ne_bytes();
    let name_w = wide(name);
    let rc = unsafe {
        RegSetValueExW(hkey, RegStr(name_w.as_ptr()), 0, REG_DWORD, Some(&bytes))
    };
    unsafe { let _ = RegCloseKey(hkey); };
    if rc.is_ok() {
        Ok(())
    } else {
        Err(())
    }
}

/// Extensions this provider handles. STEP/IGES previews come from the
/// sidecar cache or the wireframe fallback — see model.rs; EPS/AI from the
/// file's own TIFF preview — see eps.rs.
const EXTENSIONS: [&str; 8] = [".dxf", ".step", ".stp", ".iges", ".igs", ".eps", ".ai", ".svg"];
/// SV-07: extensions other programs commonly preview (PowerToys, Inkscape for
/// SVG). These are registered only under `SystemFileAssociations`, which the
/// shell consults after `<ext>\ShellEx` — so an installed SVG handler keeps
/// winning and uninstalling Sketchor never deletes its keys.
const SYSASSOC_ONLY: [&str; 1] = [".svg"];

fn register(clsid: &str, dll: &str) -> Result<(), ()> {
    let base = format!("CLSID\\{clsid}");
    set_string(&base, None, "Sketchor Thumbnail Provider")?;
    let inproc = format!("{base}\\InprocServer32");
    set_string(&inproc, None, dll)?;
    set_string(&inproc, Some("ThreadingModel"), "Apartment")?;
    // Allow IInitializeWithFile (file path) instead of stream isolation.
    set_dword(&base, "DisableProcessIsolation", 1)?;
    // Associate each extension with this thumbnail provider. Register at the
    // extension level and under SystemFileAssociations (the shell consults
    // both, and the latter survives even if another app owns the ProgID).
    for ext in EXTENSIONS {
        if !SYSASSOC_ONLY.contains(&ext) {
            set_string(&format!("{ext}\\ShellEx\\{SHELLEX_THUMB}"), None, clsid)?;
        }
        set_string(
            &format!("SystemFileAssociations\\{ext}\\ShellEx\\{SHELLEX_THUMB}"),
            None,
            clsid,
        )?;
    }
    Ok(())
}

fn unregister(clsid: &str) -> Result<(), ()> {
    let base = wide(&classes(&format!("CLSID\\{clsid}")));
    unsafe {
        let _ = RegDeleteTreeW(HKEY_CURRENT_USER, RegStr(base.as_ptr()));
    }
    for ext in EXTENSIONS {
        let assoc = wide(&classes(&format!("{ext}\\ShellEx\\{SHELLEX_THUMB}")));
        let sysassoc = wide(&classes(&format!(
            "SystemFileAssociations\\{ext}\\ShellEx\\{SHELLEX_THUMB}"
        )));
        unsafe {
            if !SYSASSOC_ONLY.contains(&ext) {
                let _ = RegDeleteTreeW(HKEY_CURRENT_USER, RegStr(assoc.as_ptr()));
            }
            let _ = RegDeleteTreeW(HKEY_CURRENT_USER, RegStr(sysassoc.as_ptr()));
        }
    }
    Ok(())
}
