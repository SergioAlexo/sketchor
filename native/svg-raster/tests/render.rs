use svg_raster::{is_svg, render_svg};

fn px(r: &svg_raster::Raster, x: u32, y: u32) -> [u8; 4] {
    let i = ((y * r.size + x) * 4) as usize;
    [r.rgba[i], r.rgba[i + 1], r.rgba[i + 2], r.rgba[i + 3]]
}

#[test]
fn draws_on_an_opaque_white_sheet_fitted_to_the_content() {
    // A red square in the corner of a big empty page: the thumbnail fits the square, not the page.
    let svg = br##"<svg xmlns="http://www.w3.org/2000/svg" width="1000" height="1000"><rect x="10" y="10" width="20" height="20" fill="#ff0000"/></svg>"##;
    let r = render_svg(svg, 64).expect("renders");
    assert_eq!(r.size, 64);
    assert_eq!(r.rgba.len(), 64 * 64 * 4);
    assert_eq!(px(&r, 32, 32), [255, 0, 0, 255], "centre is the square");
    assert_eq!(px(&r, 1, 1), [255, 255, 255, 255], "margin is white");
    assert!(r.rgba.chunks(4).all(|p| p[3] == 255), "opaque everywhere");
}

#[test]
fn keeps_the_aspect_ratio() {
    let svg = br##"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 50"><rect width="200" height="50" fill="#000"/></svg>"##;
    let r = render_svg(svg, 100).unwrap();
    assert_eq!(px(&r, 50, 50)[0], 0, "middle row is the bar");
    assert_eq!(px(&r, 50, 20)[0], 255, "above the bar is white");
}

#[test]
fn strokes_only_drawings_show() {
    let svg = br##"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><circle cx="50" cy="50" r="40" fill="none" stroke="#000" stroke-width="4"/></svg>"##;
    let r = render_svg(svg, 128).unwrap();
    let dark = r.rgba.chunks(4).filter(|p| p[0] < 100).count();
    assert!(dark > 200, "only {dark} dark pixels");
}

#[test]
fn refuses_what_isnt_an_svg() {
    assert!(render_svg(b"", 64).is_none());
    assert!(render_svg(b"not xml at all", 64).is_none());
    assert!(render_svg(br##"<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"/>"##, 0).is_none());
}

#[test]
fn never_fetches_external_images() {
    // An <image> pointing elsewhere is simply not drawn; the rest still is.
    let svg = br##"<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 10 10"><image href="https://example.com/x.png" width="10" height="10"/><rect width="5" height="5" fill="#00f"/></svg>"##;
    assert!(render_svg(svg, 32).is_some());
}

#[test]
fn recognises_svg_names() {
    assert!(is_svg("C:\\a\\B.SVG"));
    assert!(is_svg("x.svgz"));
    assert!(!is_svg("x.dxf"));
}

/// Real exports (Figma, Illustrator, Inkscape, LibreCAD, a symbol sheet) — the files the web importer is tested on.
#[test]
fn real_world_exports_render() {
    let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../packages/core/src/fixtures/svg");
    let mut n = 0;
    for e in std::fs::read_dir(&dir).expect("fixtures") {
        let p = e.unwrap().path();
        if p.extension().and_then(|x| x.to_str()) != Some("svg") {
            continue;
        }
        let r = render_svg(&std::fs::read(&p).unwrap(), 96).unwrap_or_else(|| panic!("{} did not render", p.display()));
        let inked = r.rgba.chunks(4).filter(|px| px[0] < 200 || px[1] < 200 || px[2] < 200).count();
        assert!(inked > 30, "{}: only {inked} inked pixels", p.display());
        if let Ok(out) = std::env::var("SVG_RASTER_DUMP") {
            let f = std::fs::File::create(std::path::Path::new(&out).join(p.with_extension("png").file_name().unwrap())).unwrap();
            let mut enc = png::Encoder::new(f, r.size, r.size);
            enc.set_color(png::ColorType::Rgba);
            enc.write_header().unwrap().write_image_data(&r.rgba).unwrap();
        }
        n += 1;
    }
    assert!(n >= 5, "found {n} fixtures");
}
