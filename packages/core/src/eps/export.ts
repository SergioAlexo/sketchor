import { explodeDimensions } from "../dimensions/explode";
/**
 * F-02 / SV-08 — EPS writer. DSC-conformant (`%!PS-Adobe-3.0 EPSF-3.0`,
 * `%%BoundingBox`/`%%HiResBoundingBox`, LanguageLevel 2) plain PostScript that
 * Illustrator, Inkscape, CorelDRAW and this package's own importer read.
 *
 * Geometry is exact where PostScript can say it: lines/polylines as `lineto`,
 * arcs and bulges as Béziers of at most 45° (radial error ≈ 4e-6 of the radius),
 * ellipses as Béziers, splines as their Bézier pieces, circles as four. Units:
 * 1 pt = 25.4/72 mm; the drawing is translated so its lower-left corner sits
 * at (0,0) — `%%SketchorOrigin` records the offset in mm so a round trip
 * through Sketchor puts it back. Optional DOS binary header with a TIFF
 * preview ({@link entitiesToEpsFile}, off by default) for old DTP software.
 */
import type { Entity, HatchEntity, PolylineEntity } from "../entities";
import { layerOf } from "../entities";
import type { Point } from "../geometry";
import { arcSweep, bulgeToArc } from "../geometry";
import { kindTessellate } from "../kinds/registry";
import { builtinLinetype, effectiveLtscale } from "../linetypes";
import { bezierPieces } from "../nurbs";
import { ellipsePointAt, ellipseSweep, minorAxisOf } from "../ellipse";
import { paintedPolygons } from "../hatch/loops";
import { boundsOf } from "../dxf";

const PT_PER_MM = 72 / 25.4;
const MAX_SEG = Math.PI / 4;

export interface EpsExportOptions {
  title?: string;
  creator?: string;
  /** Stroke width for entities without a lineweight, in mm (default hairline 0.1). */
  defaultLineweight?: number;
  /** Page margin around the geometry, in mm (default 0). */
  margin?: number;
  /** Prepend a DOS binary header with a TIFF preview — {@link entitiesToEpsFile} only. */
  tiffPreview?: boolean;
  /** Longest side of the preview, in pixels (default 256). */
  previewSize?: number;
}

const f6 = (v: number): string => {
  const s = (Math.round(v * 1e6) / 1e6).toString();
  return s === "-0" ? "0" : s;
};

const hexRgb = (c: string | undefined): [number, number, number] | null => {
  if (!c) return null;
  const m = /^#?([0-9a-f]{6})$/i.exec(c.trim());
  if (m) {
    const n = parseInt(m[1], 16);
    return [(n >> 16) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
  }
  const s = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/i.exec(c.trim());
  return s ? [parseInt(s[1] + s[1], 16) / 255, parseInt(s[2] + s[2], 16) / 255, parseInt(s[3] + s[3], 16) / 255] : null;
};

const psString = (s: string): string => "(" + s.replace(/[\\()]/g, (c) => "\\" + c).replace(/[^\x20-\x7e]/g, "?") + ")";

/** Cubic Bézier pieces of an arc from angle `a0` sweeping `sweep` (signed). */
function arcBeziers(c: Point, r: number, a0: number, sweep: number): [Point, Point, Point][] {
  const n = Math.max(1, Math.ceil(Math.abs(sweep) / MAX_SEG - 1e-9));
  const step = sweep / n;
  const k = (4 / 3) * Math.tan(step / 4);
  const out: [Point, Point, Point][] = [];
  for (let i = 0; i < n; i++) {
    const a = a0 + i * step;
    const b = a + step;
    out.push([
      { x: c.x + r * (Math.cos(a) - k * Math.sin(a)), y: c.y + r * (Math.sin(a) + k * Math.cos(a)) },
      { x: c.x + r * (Math.cos(b) + k * Math.sin(b)), y: c.y + r * (Math.sin(b) - k * Math.cos(b)) },
      { x: c.x + r * Math.cos(b), y: c.y + r * Math.sin(b) },
    ]);
  }
  return out;
}

/** Path as `[op, points]` steps in mm; `closed` when it ends with closepath. */
type Step = { op: "m"; p: Point } | { op: "l"; p: Point } | { op: "c"; p1: Point; p2: Point; p3: Point };
interface Sub {
  steps: Step[];
  closed: boolean;
}

function ellipseSubs(e: Extract<Entity, { type: "ellipse" }>): Sub[] {
  const sweep = ellipseSweep(e);
  const full = sweep >= Math.PI * 2 - 1e-9;
  const n = Math.max(1, Math.ceil(sweep / MAX_SEG - 1e-9));
  const step = sweep / n;
  const k = (4 / 3) * Math.tan(step / 4);
  const major = e.majorAxis;
  const minor = minorAxisOf(e);
  const at = (t: number, sgn: number): Point => {
    const c = Math.cos(t);
    const s = Math.sin(t);
    // point + sgn*k*tangent, tangent = d/dt (major cos + minor sin)
    return {
      x: e.center.x + major.x * c + minor.x * s + sgn * k * (-major.x * s + minor.x * c),
      y: e.center.y + major.y * c + minor.y * s + sgn * k * (-major.y * s + minor.y * c),
    };
  };
  const steps: Step[] = [{ op: "m", p: ellipsePointAt(e, e.start) }];
  for (let i = 0; i < n; i++) {
    const a = e.start + i * step;
    const b = a + step;
    steps.push({ op: "c", p1: at(a, 1), p2: at(b, -1), p3: ellipsePointAt(e, b) });
  }
  return [{ steps, closed: full }];
}

/** Subpaths (mm) for one entity, or null when it is drawn another way (text, hatch, point). */
function subpathsOf(e: Entity): Sub[] | null {
  switch (e.type) {
    case "line":
      return e.infinite ? [] : [{ steps: [{ op: "m", p: e.a }, { op: "l", p: e.b }], closed: false }];
    case "circle": {
      const steps: Step[] = [{ op: "m", p: { x: e.center.x + e.radius, y: e.center.y } }];
      for (const [p1, p2, p3] of arcBeziers(e.center, e.radius, 0, Math.PI * 2)) steps.push({ op: "c", p1, p2, p3 });
      return [{ steps, closed: true }];
    }
    case "arc": {
      const sweep = arcSweep(e.startAngle, e.endAngle, e.ccw) * (e.ccw ? 1 : -1);
      const steps: Step[] = [{ op: "m", p: { x: e.center.x + e.radius * Math.cos(e.startAngle), y: e.center.y + e.radius * Math.sin(e.startAngle) } }];
      for (const [p1, p2, p3] of arcBeziers(e.center, e.radius, e.startAngle, sweep)) steps.push({ op: "c", p1, p2, p3 });
      return [{ steps, closed: false }];
    }
    case "ellipse":
      return ellipseSubs(e);
    case "polyline": {
      const pts = e.points;
      if (pts.length < 2) return [];
      const steps: Step[] = [{ op: "m", p: pts[0] }];
      const n = e.closed ? pts.length : pts.length - 1;
      for (let i = 0; i < n; i++) {
        const a = pts[i];
        const b = pts[(i + 1) % pts.length];
        const arc = bulgeToArc(a, b, (e as PolylineEntity).bulges?.[i] ?? 0);
        if (!arc) {
          if (!(e.closed && i === n - 1 && Math.hypot(a.x - b.x, a.y - b.y) < 1e-12)) steps.push({ op: "l", p: b });
          continue;
        }
        const sweep = arcSweep(arc.startAngle, arc.endAngle, arc.ccw) * (arc.ccw ? 1 : -1);
        const pieces = arcBeziers(arc.center, arc.radius, arc.startAngle, sweep);
        pieces.forEach(([p1, p2, p3], k) => steps.push({ op: "c", p1, p2, p3: k === pieces.length - 1 ? b : p3 }));
      }
      return [{ steps, closed: e.closed }];
    }
    case "spline": {
      const pieces = !e.weights || e.weights.every((w) => w === 1) ? bezierPieces(e) : null;
      if (pieces && pieces.length && pieces.every((p) => p.points.length === 4)) {
        const steps: Step[] = [{ op: "m", p: pieces[0].points[0] }];
        for (const p of pieces) steps.push({ op: "c", p1: p.points[1], p2: p.points[2], p3: p.points[3] });
        return [{ steps, closed: !!e.closed }];
      }
      // rational / non-cubic / unclamped: a fine polyline instead
      const polys = kindTessellate(e, 0.005);
      return polys.filter((l) => l.length >= 2).map((l) => ({ steps: l.map((p, i) => ({ op: i === 0 ? ("m" as const) : ("l" as const), p })), closed: false }));
    }
    case "hatch":
    case "point":
    case "text":
    case "image":
    case "insert":
      return null;
  }
  return kindTessellate(e).filter((l) => l.length >= 2).map((l) => ({ steps: l.map((p, i) => ({ op: i === 0 ? ("m" as const) : ("l" as const), p })), closed: false }));
}

/** Drawing extent (mm) including text boxes and points, or null for nothing drawable. */
function extent(entities: Entity[]): { minX: number; minY: number; maxX: number; maxY: number } | null {
  const solid = entities.filter((e) => !(e.type === "line" && e.infinite) && e.type !== "image");
  const b = boundsOf(solid);
  return b ? { minX: b.minX, minY: b.minY, maxX: b.maxX, maxY: b.maxY } : null;
}

/** The EPS text for `entities` (inserts must already be flattened — see `flattenInserts`). */
export function entitiesToEps(entitiesIn: Entity[], opts: EpsExportOptions = {}): string {
  const entities = explodeDimensions(entitiesIn);
  const ext = extent(entities) ?? { minX: 0, minY: 0, maxX: 10, maxY: 10 };
  const margin = opts.margin ?? 0;
  const ox = ext.minX - margin;
  const oy = ext.minY - margin;
  const wMm = ext.maxX - ext.minX + 2 * margin;
  const hMm = ext.maxY - ext.minY + 2 * margin;
  const W = wMm * PT_PER_MM;
  const H = hMm * PT_PER_MM;
  const X = (p: Point): string => f6((p.x - ox) * PT_PER_MM);
  const Y = (p: Point): string => f6((p.y - oy) * PT_PER_MM);
  const out: string[] = [];
  const P = (s: string) => out.push(s);

  P("%!PS-Adobe-3.0 EPSF-3.0");
  P(`%%Creator: ${opts.creator ?? "Sketchor"}`);
  P(`%%Title: ${(opts.title ?? "drawing").replace(/[\r\n]/g, " ")}`);
  P(`%%BoundingBox: 0 0 ${Math.ceil(W - 1e-9)} ${Math.ceil(H - 1e-9)}`);
  P(`%%HiResBoundingBox: 0 0 ${f6(W)} ${f6(H)}`);
  P(`%%SketchorOrigin: ${f6(ox)} ${f6(oy)} mm`);
  P("%%LanguageLevel: 2");
  P("%%Pages: 1");
  P("%%EndComments");
  P("%%BeginProlog");
  P("/m {moveto} bind def /l {lineto} bind def /c {curveto} bind def /h {closepath} bind def");
  P("/S {stroke} bind def /F {fill} bind def /EF {eofill} bind def /rg {setrgbcolor} bind def /lw {setlinewidth} bind def");
  P("%%EndProlog");
  P("%%Page: 1 1");
  P("0 setlinecap 0 setlinejoin 10 setmiterlimit");

  const layers = new Map<string, Entity[]>();
  for (const e of entities) {
    const l = layerOf(e);
    if (!layers.has(l)) layers.set(l, []);
    layers.get(l)!.push(e);
  }
  const defLw = opts.defaultLineweight ?? 0.1;
  const setStroke = (e: Entity) => {
    const c = hexRgb((e as { color?: string }).color) ?? [0, 0, 0];
    const lw = (e as { lineweight?: number }).lineweight;
    P(`${f6(c[0])} ${f6(c[1])} ${f6(c[2])} rg ${f6((lw && lw > 0 ? lw : defLw) * PT_PER_MM)} lw`);
    const lt = builtinLinetype((e as { linetype?: string }).linetype);
    const k = effectiveLtscale(1, e);
    if (lt.pattern.length) P(`[${lt.pattern.map((v) => f6(Math.abs(v) * k * PT_PER_MM)).join(" ")}] 0 setdash`);
    else P("[] 0 setdash");
  };
  const pathOps = (subs: Sub[]): string => {
    const t: string[] = [];
    for (const s of subs) {
      for (const st of s.steps) {
        if (st.op === "m") t.push(`${X(st.p)} ${Y(st.p)} m`);
        else if (st.op === "l") t.push(`${X(st.p)} ${Y(st.p)} l`);
        else t.push(`${X(st.p1)} ${Y(st.p1)} ${X(st.p2)} ${Y(st.p2)} ${X(st.p3)} ${Y(st.p3)} c`);
      }
      if (s.closed) t.push("h");
    }
    return t.join("\n");
  };

  for (const [layer, list] of layers) {
    P(`%%Sketchor layer: ${layer.replace(/[\r\n]/g, " ")}`);
    for (const e of list) {
      if (e.type === "hatch") {
        const h = e as HatchEntity;
        if (h.paint.kind === "solid" || h.paint.kind === "gradient") {
          const polys = paintedPolygons(h, 0.01);
          const col = hexRgb(h.paint.kind === "solid" ? h.paint.color : h.paint.colors[0]) ?? [0, 0, 0];
          if (polys.length) {
            P("gsave");
            P(`${f6(col[0])} ${f6(col[1])} ${f6(col[2])} rg`);
            P("newpath");
            for (const poly of polys) {
              poly.forEach((p, i) => P(`${X(p)} ${Y(p)} ${i === 0 ? "m" : "l"}`));
              P("h");
            }
            P("EF");
            P("grestore");
          }
        } else {
          // pattern hatch: its boundary as a stroke (the pattern lines are not written)
          const polys = paintedPolygons(h, 0.01);
          if (polys.length) {
            P("gsave");
            setStroke(h);
            P("newpath");
            for (const poly of polys) {
              poly.forEach((p, i) => P(`${X(p)} ${Y(p)} ${i === 0 ? "m" : "l"}`));
              P("h");
            }
            P("S");
            P("grestore");
          }
        }
        continue;
      }
      if (e.type === "text") {
        const c = hexRgb(e.color) ?? [0, 0, 0];
        P("gsave");
        P(`${f6(c[0])} ${f6(c[1])} ${f6(c[2])} rg`);
        P(`/Helvetica findfont ${f6(e.height * PT_PER_MM)} scalefont setfont`);
        const lift = e.valign === "middle" ? -0.35 * e.height * PT_PER_MM : e.valign === "top" ? -0.7 * e.height * PT_PER_MM : 0;
        P(`${X(e.at)} ${Y(e.at)} translate ${f6((e.rotation * 180) / Math.PI)} rotate 0 ${f6(lift)} moveto`);
        P(e.halign === "center" ? `${psString(e.text)} dup stringwidth pop 2 div neg 0 rmoveto show` : e.halign === "right" ? `${psString(e.text)} dup stringwidth pop neg 0 rmoveto show` : `${psString(e.text)} show`);
        P("grestore");
        continue;
      }
      if (e.type === "point") {
        P("gsave");
        setStroke(e);
        P(`newpath ${X(e.p)} ${Y(e.p)} m 0 0 rlineto S`);
        P("grestore");
        continue;
      }
      if (e.type === "image" || e.type === "insert") continue;
      const subs = subpathsOf(e);
      if (!subs || !subs.length) continue;
      const fill = (e as { fill?: string }).fill;
      const closed = subs.every((s) => s.closed);
      P("gsave");
      P("newpath");
      const body = pathOps(subs);
      if (fill && closed) {
        const fc = hexRgb(fill) ?? [0, 0, 0];
        P(body);
        P(`gsave ${f6(fc[0])} ${f6(fc[1])} ${f6(fc[2])} rg F grestore`);
      }
      setStroke(e);
      if (fill && closed) P("newpath");
      P(body);
      P("S");
      P("grestore");
    }
  }
  P("showpage");
  P("%%Trailer");
  P("%%EOF");
  return out.join("\n") + "\n";
}

/* ------------------------------ TIFF preview ------------------------------ */

/** Uncompressed little-endian RGB TIFF. */
export function encodeTiffRgb(width: number, height: number, rgb: Uint8Array): Uint8Array {
  const entries: [number, number, number, number][] = [
    [254, 4, 1, 0], [256, 4, 1, width], [257, 4, 1, height], [258, 3, 3, 0], [259, 3, 1, 1], [262, 3, 1, 2], [273, 4, 1, 0],
    [277, 3, 1, 3], [278, 4, 1, height], [279, 4, 1, rgb.length], [282, 5, 1, 0], [283, 5, 1, 0], [284, 3, 1, 1], [296, 3, 1, 2],
  ];
  const ifdAt = 8 + rgb.length + (rgb.length & 1);
  const extra = ifdAt + 2 + entries.length * 12 + 4;
  const buf = new Uint8Array(extra + 6 + 16);
  const dv = new DataView(buf.buffer);
  buf.set([0x49, 0x49, 42, 0]);
  dv.setUint32(4, ifdAt, true);
  buf.set(rgb, 8);
  dv.setUint16(ifdAt, entries.length, true);
  entries.forEach(([tag, type, count, val], i) => {
    const o = ifdAt + 2 + i * 12;
    dv.setUint16(o, tag, true);
    dv.setUint16(o + 2, type, true);
    dv.setUint32(o + 4, count, true);
    if (tag === 258) dv.setUint32(o + 8, extra, true);
    else if (tag === 273) dv.setUint32(o + 8, 8, true);
    else if (tag === 282) dv.setUint32(o + 8, extra + 6, true);
    else if (tag === 283) dv.setUint32(o + 8, extra + 14, true);
    else if (type === 3) dv.setUint16(o + 8, val, true);
    else dv.setUint32(o + 8, val, true);
  });
  for (let k = 0; k < 3; k++) dv.setUint16(extra + k * 2, 8, true);
  dv.setUint32(extra + 6, 72, true);
  dv.setUint32(extra + 10, 1, true);
  dv.setUint32(extra + 14, 72, true);
  dv.setUint32(extra + 18, 1, true);
  return buf;
}

/** A small black-on-white outline rendering of the drawing, as TIFF bytes. */
export function renderPreviewTiff(entities: Entity[], size = 256): Uint8Array {
  const flat = entities.filter((e) => e.type !== "image" && !(e.type === "line" && e.infinite));
  const b = boundsOf(flat);
  const w0 = b ? Math.max(b.maxX - b.minX, 1e-9) : 1;
  const h0 = b ? Math.max(b.maxY - b.minY, 1e-9) : 1;
  const s = (size - 8) / Math.max(w0, h0);
  const W = Math.max(8, Math.round(w0 * s) + 8);
  const H = Math.max(8, Math.round(h0 * s) + 8);
  const rgb = new Uint8Array(W * H * 3).fill(255);
  const dot = (x: number, y: number) => {
    if (x < 0 || y < 0 || x >= W || y >= H) return;
    const o = (y * W + x) * 3;
    rgb[o] = rgb[o + 1] = rgb[o + 2] = 0;
  };
  if (b) {
    for (const e of flat) {
      for (const pl of kindTessellate(e)) {
        for (let i = 1; i < pl.length; i++) {
          const x0 = (pl[i - 1].x - b.minX) * s + 4;
          const y0 = H - 4 - (pl[i - 1].y - b.minY) * s;
          const x1 = (pl[i].x - b.minX) * s + 4;
          const y1 = H - 4 - (pl[i].y - b.minY) * s;
          const n = Math.ceil(Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0))) + 1;
          for (let k = 0; k <= n; k++) dot(Math.round(x0 + ((x1 - x0) * k) / n), Math.round(y0 + ((y1 - y0) * k) / n));
        }
      }
    }
  }
  return encodeTiffRgb(W, H, rgb);
}

/**
 * The `.eps` file as bytes. With `tiffPreview` it carries the DOS binary
 * header (`C5 D0 D3 C6`) and a TIFF preview after the PostScript, which is
 * what old DTP software shows for the placed file; without it, plain text.
 */
export function entitiesToEpsFile(entities: Entity[], opts: EpsExportOptions = {}): Uint8Array {
  const text = entitiesToEps(entities, opts);
  const ps = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) ps[i] = text.charCodeAt(i) & 255;
  if (!opts.tiffPreview) return ps;
  const tiff = renderPreviewTiff(entities, opts.previewSize ?? 256);
  const out = new Uint8Array(30 + ps.length + tiff.length);
  const dv = new DataView(out.buffer);
  out.set([0xc5, 0xd0, 0xd3, 0xc6]);
  dv.setUint32(4, 30, true);
  dv.setUint32(8, ps.length, true);
  dv.setUint32(12, 0, true);
  dv.setUint32(16, 0, true);
  dv.setUint32(20, 30 + ps.length, true);
  dv.setUint32(24, tiff.length, true);
  dv.setUint16(28, 0xffff, true);
  out.set(ps, 30);
  out.set(tiff, 30 + ps.length);
  return out;
}
