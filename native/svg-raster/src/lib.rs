//! SV-07: an SVG file as a square RGBA thumbnail, for the Windows Explorer
//! thumbnailer (Windows has no SVG thumbnails of its own). Pure Rust
//! ([resvg](https://github.com/linebender/resvg)), no Windows APIs, so it is
//! tested on any platform; the DLL turns the pixels into an HBITMAP.
//!
//! The drawing is fitted into the square with a margin and centred on an
//! opaque white sheet: SVGs mostly assume a white page (black strokes, no
//! background), and a thumbnail with alpha would show them on whatever
//! Explorer's background happens to be.

use resvg::{tiny_skia, usvg};

/// Straight (not premultiplied) RGBA, `size × size`, rows top to bottom.
pub struct Raster {
    pub rgba: Vec<u8>,
    pub size: u32,
}

/// Files larger than this aren't rasterised (Explorer asks for thumbnails of
/// whole folders; a 50 MB map shouldn't stall it). The icon shows instead.
pub const MAX_SVG_BYTES: usize = 32 * 1024 * 1024;

/// Fraction of the square kept clear on each side.
const MARGIN: f32 = 0.06;

/// Renders `data` (SVG, or gzip-compressed SVGZ) into a `size`-pixel square.
/// None when it isn't an SVG resvg can read, or it draws nothing.
pub fn render_svg(data: &[u8], size: u32) -> Option<Raster> {
    if data.is_empty() || data.len() > MAX_SVG_BYTES || size == 0 || size > 2048 {
        return None;
    }
    let mut opt = usvg::Options::default();
    // Never reach outside the file: no external images or stylesheets.
    opt.resources_dir = None;
    #[cfg(feature = "text")]
    opt.fontdb_mut().load_system_fonts();
    let tree = usvg::Tree::from_data(data, &opt).ok()?;

    // Fit the drawn content, not the declared page: a big empty artboard
    // would otherwise shrink the drawing to a speck.
    let (bx, by, bw, bh) = match tree.root().abs_stroke_bounding_box() {
        Some(bb) if bb.width() > 0.0 && bb.height() > 0.0 => (bb.x(), bb.y(), bb.width(), bb.height()),
        _ => {
            let s = tree.size();
            (0.0, 0.0, s.width(), s.height())
        }
    };
    if !(bw.is_finite() && bh.is_finite()) || bw <= 0.0 || bh <= 0.0 {
        return None;
    }

    let mut pixmap = tiny_skia::Pixmap::new(size, size)?;
    pixmap.fill(tiny_skia::Color::WHITE);
    let avail = size as f32 * (1.0 - 2.0 * MARGIN);
    let scale = (avail / bw).min(avail / bh);
    let tx = (size as f32 - bw * scale) / 2.0 - bx * scale;
    let ty = (size as f32 - bh * scale) / 2.0 - by * scale;
    let ts = tiny_skia::Transform::from_row(scale, 0.0, 0.0, scale, tx, ty);
    resvg::render(&tree, ts, &mut pixmap.as_mut());

    // tiny-skia is premultiplied; the sheet is opaque, so alpha is 255 and
    // the colours are already straight — copy as is.
    Some(Raster { rgba: pixmap.take(), size })
}

/// True for the file names this crate renders.
pub fn is_svg(path: &str) -> bool {
    let p = path.to_ascii_lowercase();
    p.ends_with(".svg") || p.ends_with(".svgz")
}
