//! Minimal ASCII DXF parsing + shape model, mirroring the TypeScript
//! parser in `@sketchor/core`. Arcs and polylines are approximated with
//! line segments. Kept dependency-free so it is easy to audit.
//!
//! Shared by the Windows Explorer thumbnailer (`dxf-thumbnailer`, which
//! rasterises the shapes with GDI) and the macOS Quick Look extension
//! (`dxf-quicklook`, which draws them with Core Graphics). Both consume the
//! same `parse` + `project` here so previews agree across platforms.
//!
//! F-04: static blocks are evaluated (INSERT: translate/rotate/scale, arrays,
//! nesting), a DIMENSION is drawn from its anonymous `*D` block, and a HATCH
//! becomes a faint even-odd tint plus its outline. The TypeScript side
//! (`dxfToSvg`) does the same; `tests/parity.dxf` pins both to one set of
//! bounds.

use std::collections::HashMap;

#[derive(Clone, Copy)]
pub struct Pt {
    pub x: f64,
    pub y: f64,
}

pub enum Shape {
    Line(Pt, Pt),
    Circle(Pt, f64),
    /// A hatch region: rings filled even-odd with a faint tint. The outline is
    /// also emitted as `Line`s, so a consumer that ignores `Fill` (the macOS
    /// Quick Look FFI) still shows the boundary.
    Fill(Vec<Vec<Pt>>),
}

struct Raw {
    kind: String,
    pairs: Vec<(i32, String)>,
}

/// A BLOCK definition: its base point and the records between BLOCK and ENDBLK.
struct Block {
    base: Pt,
    raws: Vec<Raw>,
}

const MAX_DEPTH: usize = 8;
/// Stops a hostile INSERT array / nesting from exhausting memory.
const MAX_SHAPES: usize = 2_000_000;

fn tokenize(text: &str) -> Vec<(i32, String)> {
    let lines: Vec<&str> = text.lines().collect();
    let mut out = Vec::new();
    let mut i = 0;
    while i + 1 < lines.len() {
        if let Ok(code) = lines[i].trim().parse::<i32>() {
            out.push((code, lines[i + 1].to_string()));
        }
        i += 2;
    }
    out
}

/// Splits the file into ENTITIES records and the BLOCKS section's definitions.
fn collect(pairs: &[(i32, String)]) -> (Vec<Raw>, HashMap<String, Block>) {
    let mut entities = Vec::new();
    let mut block_raws = Vec::new();
    let mut section = "";
    let mut current: Option<Raw> = None;

    fn flush(current: &mut Option<Raw>, section: &str, e: &mut Vec<Raw>, b: &mut Vec<Raw>) {
        if let Some(c) = current.take() {
            match section {
                "ENTITIES" => e.push(c),
                "BLOCKS" => b.push(c),
                _ => {}
            }
        }
    }

    let mut i = 0;
    while i < pairs.len() {
        let (code, value) = &pairs[i];
        let v = value.trim();
        if *code == 0 && v == "SECTION" {
            flush(&mut current, section, &mut entities, &mut block_raws);
            let name = pairs.get(i + 1).map(|p| p.1.trim()).unwrap_or("");
            section = match name {
                "ENTITIES" => "ENTITIES",
                "BLOCKS" => "BLOCKS",
                _ => "",
            };
            i += 2; // the section's own name pair
            continue;
        } else if *code == 0 && v == "ENDSEC" {
            flush(&mut current, section, &mut entities, &mut block_raws);
            section = "";
        } else if section == "ENTITIES" || section == "BLOCKS" {
            if *code == 0 {
                flush(&mut current, section, &mut entities, &mut block_raws);
                current = Some(Raw {
                    kind: v.to_uppercase(),
                    pairs: Vec::new(),
                });
            } else if let Some(c) = current.as_mut() {
                c.pairs.push((*code, value.clone()));
            }
        }
        i += 1;
    }
    flush(&mut current, section, &mut entities, &mut block_raws);

    let mut blocks: HashMap<String, Block> = HashMap::new();
    let mut open: Option<(String, Block)> = None;
    for r in block_raws {
        match r.kind.as_str() {
            "BLOCK" => {
                let name = r
                    .pairs
                    .iter()
                    .find(|(c, _)| *c == 2)
                    .map(|(_, v)| v.trim().to_uppercase())
                    .unwrap_or_default();
                let base = Pt {
                    x: num(&r, 10, 0.0),
                    y: num(&r, 20, 0.0),
                };
                open = Some((name, Block { base, raws: Vec::new() }));
            }
            "ENDBLK" => {
                if let Some((n, b)) = open.take() {
                    blocks.entry(n).or_insert(b);
                }
            }
            _ => {
                if let Some((_, b)) = open.as_mut() {
                    b.raws.push(r);
                }
            }
        }
    }
    (entities, blocks)
}

fn num(raw: &Raw, code: i32, fallback: f64) -> f64 {
    raw.pairs
        .iter()
        .find(|(c, _)| *c == code)
        .and_then(|(_, v)| v.trim().parse::<f64>().ok())
        .unwrap_or(fallback)
}

fn nums(raw: &Raw, code: i32) -> Vec<f64> {
    raw.pairs
        .iter()
        .filter(|(c, _)| *c == code)
        .filter_map(|(_, v)| v.trim().parse::<f64>().ok())
        .collect()
}

fn arc_to_lines(cx: f64, cy: f64, r: f64, a0deg: f64, a1deg: f64, out: &mut Vec<Shape>) {
    let a0 = a0deg.to_radians();
    let mut sweep = (a1deg - a0deg).rem_euclid(360.0);
    if sweep == 0.0 {
        sweep = 360.0;
    }
    let steps = ((sweep / 6.0).ceil() as i32).clamp(2, 64);
    let mut prev = Pt {
        x: cx + r * a0.cos(),
        y: cy + r * a0.sin(),
    };
    for i in 1..=steps {
        let a = a0 + sweep.to_radians() * (i as f64 / steps as f64);
        let p = Pt {
            x: cx + r * a.cos(),
            y: cy + r * a.sin(),
        };
        out.push(Shape::Line(prev, p));
        prev = p;
    }
}

/// Rotate, scale (about the block base) and translate a block's shapes to an insertion point.
fn place(shapes: &[Shape], base: Pt, at: Pt, sx: f64, sy: f64, rot: f64, out: &mut Vec<Shape>) {
    let (c, s) = (rot.cos(), rot.sin());
    let m = |p: &Pt| {
        let (x, y) = ((p.x - base.x) * sx, (p.y - base.y) * sy);
        Pt {
            x: at.x + x * c - y * s,
            y: at.y + x * s + y * c,
        }
    };
    for sh in shapes {
        out.push(match sh {
            Shape::Line(a, b) => Shape::Line(m(a), m(b)),
            // Under non-uniform scale a circle is an ellipse; the geometric-mean radius is close enough for a thumbnail.
            Shape::Circle(ctr, r) => Shape::Circle(m(ctr), r * (sx * sy).abs().sqrt()),
            Shape::Fill(rings) => Shape::Fill(rings.iter().map(|r| r.iter().map(m).collect()).collect()),
        });
    }
}

/// HATCH boundary loops (polyline paths and line/arc edge paths) as rings.
/// A loop containing an ellipse or spline edge is dropped (the outline is unreadable here).
fn hatch_rings(raw: &Raw) -> Vec<Vec<Pt>> {
    let p = &raw.pairs;
    let n = |i: usize| p[i].1.trim().parse::<f64>().unwrap_or(0.0);
    let end = p.iter().position(|(c, _)| *c == 75 || *c == 98).unwrap_or(p.len());
    let mut i = p.iter().position(|(c, _)| *c == 91).map(|k| k + 1).unwrap_or(end);
    let mut rings = Vec::new();
    while i < end {
        if p[i].0 != 92 {
            i += 1;
            continue;
        }
        let flags = n(i) as i64;
        i += 1;
        let mut ring: Vec<Pt> = Vec::new();
        while i < end && p[i].0 != 93 {
            i += 1;
        }
        let count = if i < end { n(i).max(0.0) as usize } else { 0 };
        i += 1;
        if flags & 2 != 0 {
            // Polyline path: 10/20 (+42 bulge) per vertex; bulges are drawn straight.
            let (mut x, mut have_x) = (0.0, false);
            let mut taken = 0;
            while i < end && taken < count.min(1_000_000) {
                match p[i].0 {
                    10 => {
                        x = n(i);
                        have_x = true;
                    }
                    20 if have_x => {
                        ring.push(Pt { x, y: n(i) });
                        have_x = false;
                        taken += 1;
                    }
                    _ => {}
                }
                i += 1;
            }
        } else {
            // Edge path: per edge a 72 type (1 line, 2 arc, 3 ellipse, 4 spline).
            let mut ok = true;
            for _ in 0..count.min(100_000) {
                while i < end && p[i].0 != 72 {
                    i += 1;
                }
                if i >= end {
                    break;
                }
                let kind = n(i) as i64;
                i += 1;
                let from = i;
                while i < end && p[i].0 != 72 && p[i].0 != 97 && p[i].0 != 92 {
                    i += 1;
                }
                let seg = &p[from..i];
                let g = |code: i32| seg.iter().find(|(c, _)| *c == code).and_then(|(_, v)| v.trim().parse::<f64>().ok());
                match kind {
                    1 => {
                        let a = Pt { x: g(10).unwrap_or(0.0), y: g(20).unwrap_or(0.0) };
                        let b = Pt { x: g(11).unwrap_or(0.0), y: g(21).unwrap_or(0.0) };
                        if ring.is_empty() {
                            ring.push(a);
                        }
                        ring.push(b);
                    }
                    2 => {
                        let (cx, cy, r) = (g(10).unwrap_or(0.0), g(20).unwrap_or(0.0), g(40).unwrap_or(0.0));
                        let (a0, a1) = (g(50).unwrap_or(0.0), g(51).unwrap_or(360.0));
                        let ccw = g(73).unwrap_or(1.0) != 0.0;
                        let mut sweep = if ccw { (a1 - a0).rem_euclid(360.0) } else { -((a0 - a1).rem_euclid(360.0)) };
                        if sweep == 0.0 {
                            sweep = 360.0;
                        }
                        let steps = ((sweep.abs() / 6.0).ceil() as i32).clamp(2, 64);
                        for k in 0..=steps {
                            let a = (a0 + sweep * (k as f64 / steps as f64)).to_radians();
                            if !(k == 0 && !ring.is_empty()) {
                                ring.push(Pt { x: cx + r * a.cos(), y: cy + r * a.sin() });
                            }
                        }
                    }
                    _ => ok = false,
                }
            }
            if !ok {
                ring.clear();
            }
        }
        if ring.len() > 2 {
            rings.push(ring);
        }
    }
    rings
}

pub fn parse(text: &str) -> Vec<Shape> {
    let (raws, blocks) = collect(&tokenize(text));
    let mut out = Vec::new();
    convert(&raws, &blocks, 0, &mut out);
    out
}

fn convert(raws: &[Raw], blocks: &HashMap<String, Block>, depth: usize, out: &mut Vec<Shape>) {
    // Legacy POLYLINE/VERTEX stitching state.
    let mut poly: Option<Vec<Pt>> = None;
    let mut poly_closed = false;
    let flush_poly = |poly: &mut Option<Vec<Pt>>, closed: &mut bool, out: &mut Vec<Shape>| {
        if let Some(v) = poly.take() {
            if v.len() > 1 {
                for i in 0..v.len() - 1 {
                    out.push(Shape::Line(v[i], v[i + 1]));
                }
                if *closed && v.len() > 2 {
                    out.push(Shape::Line(v[v.len() - 1], v[0]));
                }
            }
        }
        *closed = false;
    };

    for raw in raws {
        match raw.kind.as_str() {
            "LINE" => out.push(Shape::Line(
                Pt {
                    x: num(raw, 10, 0.0),
                    y: num(raw, 20, 0.0),
                },
                Pt {
                    x: num(raw, 11, 0.0),
                    y: num(raw, 21, 0.0),
                },
            )),
            "CIRCLE" => {
                let r = num(raw, 40, 0.0);
                if r > 0.0 {
                    out.push(Shape::Circle(
                        Pt {
                            x: num(raw, 10, 0.0),
                            y: num(raw, 20, 0.0),
                        },
                        r,
                    ));
                }
            }
            "ARC" => {
                let r = num(raw, 40, 0.0);
                if r > 0.0 {
                    arc_to_lines(
                        num(raw, 10, 0.0),
                        num(raw, 20, 0.0),
                        r,
                        num(raw, 50, 0.0),
                        num(raw, 51, 0.0),
                        out,
                    );
                }
            }
            "LWPOLYLINE" => {
                let xs = nums(raw, 10);
                let ys = nums(raw, 20);
                let closed = (num(raw, 70, 0.0) as i64) & 1 == 1;
                let n = xs.len().min(ys.len());
                let verts: Vec<Pt> = (0..n).map(|i| Pt { x: xs[i], y: ys[i] }).collect();
                for i in 0..verts.len().saturating_sub(1) {
                    out.push(Shape::Line(verts[i], verts[i + 1]));
                }
                if closed && verts.len() > 2 {
                    out.push(Shape::Line(verts[verts.len() - 1], verts[0]));
                }
            }
            "POLYLINE" => {
                flush_poly(&mut poly, &mut poly_closed, out);
                poly = Some(Vec::new());
                poly_closed = (num(raw, 70, 0.0) as i64) & 1 == 1;
            }
            "VERTEX" => {
                if let Some(v) = poly.as_mut() {
                    v.push(Pt {
                        x: num(raw, 10, 0.0),
                        y: num(raw, 20, 0.0),
                    });
                }
            }
            "SEQEND" => flush_poly(&mut poly, &mut poly_closed, out),
            "HATCH" => {
                let rings = hatch_rings(raw);
                if !rings.is_empty() {
                    for ring in &rings {
                        for i in 0..ring.len() {
                            out.push(Shape::Line(ring[i], ring[(i + 1) % ring.len()]));
                        }
                    }
                    out.push(Shape::Fill(rings));
                }
            }
            "INSERT" | "DIMENSION" => {
                let name = raw
                    .pairs
                    .iter()
                    .find(|(c, _)| *c == 2)
                    .map(|(_, v)| v.trim().to_uppercase())
                    .unwrap_or_default();
                let Some(block) = blocks.get(&name) else { continue };
                if depth >= MAX_DEPTH || out.len() >= MAX_SHAPES {
                    continue;
                }
                let mut body = Vec::new();
                convert(&block.raws, blocks, depth + 1, &mut body);
                if raw.kind == "DIMENSION" {
                    // The `*D` block is already in world coordinates.
                    place(&body, block.base, block.base, 1.0, 1.0, 0.0, out);
                    continue;
                }
                let at = Pt { x: num(raw, 10, 0.0), y: num(raw, 20, 0.0) };
                let nz = |v: f64| if v == 0.0 { 1.0 } else { v };
                let (sx, sy) = (nz(num(raw, 41, 1.0)), nz(num(raw, 42, 1.0)));
                let rot = num(raw, 50, 0.0).to_radians();
                let cols = (num(raw, 70, 1.0) as i64).clamp(1, 1000);
                let rows = (num(raw, 71, 1.0) as i64).clamp(1, 1000);
                let (dc, dr) = (num(raw, 44, 0.0), num(raw, 45, 0.0));
                let (c, s) = (rot.cos(), rot.sin());
                'arr: for ci in 0..cols {
                    for ri in 0..rows {
                        if out.len() >= MAX_SHAPES {
                            break 'arr;
                        }
                        let (ox, oy) = (ci as f64 * dc, ri as f64 * dr);
                        let pos = Pt { x: at.x + ox * c - oy * s, y: at.y + ox * s + oy * c };
                        place(&body, block.base, pos, sx, sy, rot, out);
                    }
                }
            }
            _ => {}
        }
    }
    flush_poly(&mut poly, &mut poly_closed, out);
}

pub struct Bounds {
    pub min_x: f64,
    pub min_y: f64,
    pub max_x: f64,
    pub max_y: f64,
}

pub fn bounds(shapes: &[Shape]) -> Option<Bounds> {
    let mut b = Bounds {
        min_x: f64::INFINITY,
        min_y: f64::INFINITY,
        max_x: f64::NEG_INFINITY,
        max_y: f64::NEG_INFINITY,
    };
    let mut acc = |x: f64, y: f64| {
        b.min_x = b.min_x.min(x);
        b.min_y = b.min_y.min(y);
        b.max_x = b.max_x.max(x);
        b.max_y = b.max_y.max(y);
    };
    for s in shapes {
        match s {
            Shape::Line(a, c) => {
                acc(a.x, a.y);
                acc(c.x, c.y);
            }
            Shape::Circle(c, r) => {
                acc(c.x - r, c.y - r);
                acc(c.x + r, c.y + r);
            }
            Shape::Fill(rings) => {
                for p in rings.iter().flatten() {
                    acc(p.x, p.y);
                }
            }
        }
    }
    if b.min_x.is_finite() {
        Some(b)
    } else {
        None
    }
}

/// A line/circle in raster space: origin top-left, Y increasing downward,
/// already fitted into the `size`x`size` box. Consumers just stroke these.
#[derive(Clone, Copy)]
pub struct ProjLine {
    pub x1: f64,
    pub y1: f64,
    pub x2: f64,
    pub y2: f64,
}

#[derive(Clone, Copy)]
pub struct ProjCircle {
    pub cx: f64,
    pub cy: f64,
    pub r: f64,
}

pub struct Projection {
    pub lines: Vec<ProjLine>,
    pub circles: Vec<ProjCircle>,
    /// Hatch regions: even-odd rings of raster-space points.
    pub fills: Vec<Vec<Vec<(f64, f64)>>>,
}

/// Fit shapes into a `size`x`size` box with `pad` px of margin, flipping
/// world-Y-up to raster-Y-down. This is the same scale/offset math the GDI
/// rasteriser (`dxf-thumbnailer/src/render.rs`) and the SVG thumbnailer
/// (`@sketchor/core` `entitiesToSvg`) use, lifted here so every platform's
/// preview lands identically. Returns empty when there is nothing to draw.
pub fn project(shapes: &[Shape], size: f64, pad: f64) -> Projection {
    let mut lines = Vec::new();
    let mut circles = Vec::new();
    let mut fills = Vec::new();
    let Some(b) = bounds(shapes) else {
        return Projection { lines, circles, fills };
    };
    let w = (b.max_x - b.min_x).max(1e-6);
    let h = (b.max_y - b.min_y).max(1e-6);
    let scale = ((size - pad * 2.0) / w).min((size - pad * 2.0) / h);
    let off_x = (size - w * scale) / 2.0;
    let off_y = (size - h * scale) / 2.0;
    let sx = |x: f64| off_x + (x - b.min_x) * scale;
    let sy = |y: f64| off_y + (b.max_y - y) * scale; // Y down
    for s in shapes {
        match s {
            Shape::Line(a, c) => lines.push(ProjLine {
                x1: sx(a.x),
                y1: sy(a.y),
                x2: sx(c.x),
                y2: sy(c.y),
            }),
            Shape::Circle(c, r) => circles.push(ProjCircle {
                cx: sx(c.x),
                cy: sy(c.y),
                r: r * scale,
            }),
            Shape::Fill(rings) => fills.push(
                rings
                    .iter()
                    .map(|r| r.iter().map(|p| (sx(p.x), sy(p.y))).collect())
                    .collect(),
            ),
        }
    }
    Projection { lines, circles, fills }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The same file `packages/core/src/dxfThumbnailParity.test.ts` reads: both
    /// sides must agree on the drawing's extents.
    const PARITY: &str = include_str!("../tests/parity.dxf");

    #[test]
    fn parity_bounds_match_typescript() {
        let shapes = parse(PARITY);
        let b = bounds(&shapes).unwrap();
        let near = |a: f64, b: f64| (a - b).abs() < 1e-6;
        assert!(near(b.min_x, 0.0) && near(b.max_x, 100.0), "x {} {}", b.min_x, b.max_x);
        assert!(near(b.min_y, -2.0) && near(b.max_y, 70.0), "y {} {}", b.min_y, b.max_y);
    }

    #[test]
    fn insert_hatch_and_dimension_are_drawn() {
        let shapes = parse(PARITY);
        assert!(shapes.iter().any(|s| matches!(s, Shape::Fill(_))));
        // 2 inserted block lines + 1 dimension-block line + 4 hatch outline lines
        let lines = shapes.iter().filter(|s| matches!(s, Shape::Line(..))).count();
        assert_eq!(lines, 7);
        let proj = project(&shapes, 128.0, 10.0);
        assert_eq!(proj.fills.len(), 1);
        assert_eq!(proj.fills[0][0].len(), 4);
    }

    #[test]
    fn self_referencing_block_terminates() {
        let dxf = "0\nSECTION\n2\nBLOCKS\n0\nBLOCK\n2\nA\n10\n0\n20\n0\n0\nINSERT\n2\nA\n10\n1\n20\n0\n0\nLINE\n10\n0\n20\n0\n11\n1\n21\n1\n0\nENDBLK\n0\nENDSEC\n0\nSECTION\n2\nENTITIES\n0\nINSERT\n2\nA\n10\n0\n20\n0\n0\nENDSEC\n0\nEOF\n";
        let shapes = parse(dxf);
        assert!(shapes.len() <= 20);
    }

    #[test]
    fn missing_block_and_garbage_do_not_panic() {
        assert!(parse("0\nSECTION\n2\nENTITIES\n0\nINSERT\n2\nNOPE\n0\nENDSEC\n").is_empty());
        assert!(parse("not a dxf at all").is_empty());
        let _ = parse("0\nSECTION\n2\nENTITIES\n0\nHATCH\n91\n9\n92\n2\n93\n5\n10\n1\n0\nENDSEC\n");
    }
}
