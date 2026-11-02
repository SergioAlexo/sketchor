import { explodeDimensions } from "./dimensions/explode";
import { blendWithWhite, hatchArt } from "./hatch/render";
import { isFullEllipse } from "./ellipse";
import type { ArcEntity, Entity, PolylineEntity } from "./entities";
import { polylineSegments } from "./entities";
import type { Point } from "./geometry";
import { arcPointAt, arcSweep, bulgeToArc } from "./geometry";
import { boundsOf } from "./dxf";
import { kindTessellate } from "./kinds/registry";
import type { PdfBuilder, PdfPoint } from "./pdf";
import { builtinLinetype } from "./linetypes";

/**
 * Draws entities onto a {@link PdfBuilder} page, scaled to fit a box — the PDF
 * counterpart of `entitiesToSvgDocument`, working from the same entity list
 * that `entitiesToDxf` writes. One geometry source, three renderings: the
 * canvas, the printed sheet, and the exported file.
 */

export interface PdfDrawBox {
  /** Page coordinates in points, Y down from the top-left. */
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface PdfDrawOptions {
  /** Colour for geometry that carries no colour of its own. */
  strokeColor?: string;
  /** Stroke width in points (default 0.5). */
  strokeWidth?: number;
  /**
   * Opacity is not used — PDF transparency needs an ExtGState, and a printed
   * plan wants solid colour anyway. Filled shapes are drawn solid, which is
   * also what makes the black/white labels on them legible.
   */
  fill?: boolean;
  /**
   * L-06: draw at a fixed mapping instead of fitting to the box: page x = ox + wx * scale, page y = oy - wy * scale
   * (a sheet printed 1:1, or the model seen through a viewport). The box is then unused.
   */
  fixed?: { scale: number; ox: number; oy: number };
  /** L-06: stroke width in points for an entity (true lineweights); undefined keeps `strokeWidth`. */
  widthOf?: (e: Entity) => number | undefined;
}

export interface PdfDrawResult {
  /** Points per world unit — what the geometry was scaled by to fit the box. */
  scale: number;
}

/**
 * Fits `entities` into `box` (preserving aspect ratio, centred) and draws them.
 * Returns the scale used, so a caller can annotate the result at the same size.
 */
export function drawEntitiesToPdf(
  pdf: PdfBuilder,
  entitiesIn: readonly Entity[],
  box: PdfDrawBox,
  opts: PdfDrawOptions = {},
): PdfDrawResult {
  const entities = explodeDimensions(entitiesIn as Entity[]);
  const stroke = opts.strokeColor ?? "#111111";
  const drawable = entities.filter((e) => !(e.type === "line" && e.infinite) && e.type !== "image");
  const fixed = opts.fixed;
  const b = fixed ? null : boundsOf(drawable as Entity[]);
  if (!fixed && !b) return { scale: 1 };

  const worldW = b ? Math.max(b.maxX - b.minX, 1e-6) : 1;
  const worldH = b ? Math.max(b.maxY - b.minY, 1e-6) : 1;
  const scale = fixed ? fixed.scale : Math.min(box.width / worldW, box.height / worldH);
  // Centre whatever slack the aspect-ratio difference leaves.
  const offsetX = box.x + (box.width - worldW * scale) / 2;
  const offsetY = box.y + (box.height - worldH * scale) / 2;
  // World Y grows up, page Y grows down.
  const at = (p: Point): PdfPoint =>
    fixed
      ? { x: fixed.ox + p.x * scale, y: fixed.oy - p.y * scale }
      : { x: offsetX + (p.x - b!.minX) * scale, y: offsetY + (b!.maxY - p.y) * scale };

  const width = opts.strokeWidth ?? 0.5;
  const paintOf = (e: Entity) => {
    const closed = e.type === "circle" || (e.type === "ellipse" && isFullEllipse(e)) || (e.type === "polyline" && e.closed);
    const fill = opts.fill !== false && closed && "fill" in e ? (e.fill as string | undefined) : undefined;
    // Real mm pattern, scaled from world to page units same as everything else here.
    const linePattern = "linetype" in e && e.linetype ? builtinLinetype(e.linetype).pattern : [];
    const dash = linePattern.length > 0 ? linePattern.map((v) => Math.max(Math.abs(v) * scale, 0.1)) : undefined;
    return { stroke: e.color ?? stroke, fill, width: opts.widthOf?.(e) ?? width, dash };
  };

  /** An arc as a run of short chords — the same tessellation the SVG export uses. */
  const arcPoints = (center: Point, radius: number, startAngle: number, endAngle: number, ccw: boolean): PdfPoint[] => {
    const sweep = arcSweep(startAngle, endAngle, ccw);
    const steps = Math.min(96, Math.max(2, Math.ceil((sweep / (2 * Math.PI)) * 96)));
    const pts: PdfPoint[] = [];
    for (let i = 0; i <= steps; i++) {
      const t = ccw ? startAngle + sweep * (i / steps) : startAngle - sweep * (i / steps);
      pts.push(at(arcPointAt(center, radius, t)));
    }
    return pts;
  };

  const polylinePoints = (e: PolylineEntity): PdfPoint[] => {
    const pts: PdfPoint[] = [];
    polylineSegments(e).forEach((seg, i) => {
      if (i === 0) pts.push(at(seg.a));
      const arc = bulgeToArc(seg.a, seg.b, seg.bulge);
      if (!arc) {
        pts.push(at(seg.b));
        return;
      }
      pts.push(...arcPoints(arc.center, arc.radius, arc.startAngle, arc.endAngle, arc.ccw).slice(1));
    });
    return pts;
  };

  for (const e of drawable) {
    const paint = paintOf(e);
    if (e.type === "line") {
      pdf.line(at(e.a), at(e.b), paint);
    } else if (e.type === "circle") {
      const c = at(e.center);
      pdf.circle(c.x, c.y, e.radius * scale, paint);
    } else if (e.type === "point") {
      const p = at(e.p);
      pdf.circle(p.x, p.y, width * 1.5, { fill: paint.stroke });
    } else if (e.type === "arc") {
      pdf.polyline(arcPoints(e.center, e.radius, (e as ArcEntity).startAngle, e.endAngle, e.ccw), paint);
    } else if (e.type === "text") {
      // The baseline start is `at` shifted by the vertical alignment (cap height ~0.7 em) along the text's own up axis.
      const lift = e.valign === "middle" ? -0.35 * e.height : e.valign === "top" ? -0.7 * e.height : 0;
      const p = at({ x: e.at.x - Math.sin(e.rotation) * lift, y: e.at.y + Math.cos(e.rotation) * lift });
      pdf.text(p.x, p.y, e.text, { size: e.height * scale, color: e.color ?? stroke, align: e.halign ?? "left", ...(e.rotation ? { rotation: e.rotation } : {}) });
    } else if (e.type === "polyline") {
      pdf.polyline(polylinePoints(e), paint, e.closed);
    } else if (e.type === "hatch") {
      // H-09: PDF here has no transparency, so a transparent hatch is blended toward the white paper instead.
      const art = hatchArt(e);
      if (!art) continue;
      const t = art.transparency;
      const rings = art.rings.map((ring) => ring.map(at));
      if (art.background) pdf.rings(rings, { fill: blendWithWhite(art.background, t) });
      const a = art.paint;
      if (a.kind === "solid") pdf.rings(rings, { fill: blendWithWhite(a.color, t) });
      else if (a.kind === "gradient") {
        const stops = a.spec.stops.map((s) => ({ t: s.t, color: blendWithWhite(s.color, t) }));
        const s = a.spec;
        if (s.kind === "linear") {
          const p1 = at({ x: s.x1, y: s.y1 });
          const p2 = at({ x: s.x2, y: s.y2 });
          pdf.shade(rings, { kind: "axial", x1: p1.x, y1: p1.y, x2: p2.x, y2: p2.y, stops });
        } else {
          const c = at({ x: s.cx, y: s.cy });
          const f = at({ x: s.fx, y: s.fy });
          pdf.shade(rings, { kind: "radial", cx: c.x, cy: c.y, r: s.r * scale, fx: f.x, fy: f.y, stops });
        }
      } else if (a.kind === "tint") {
        if (a.opacity > 0) pdf.rings(rings, { fill: blendWithWhite(e.color ?? stroke, 1 - a.opacity * (1 - t)) });
        else pdf.rings(rings, { stroke: paint.stroke, width: paint.width });
      } else {
        const col = blendWithWhite(e.color ?? stroke, t);
        const flat: number[] = [];
        for (let i = 0; i < a.segments.length; i += 2) {
          const q = at({ x: a.segments[i], y: a.segments[i + 1] });
          flat.push(q.x, q.y);
        }
        pdf.segments(flat, { stroke: col, width: Math.max(paint.width * 0.5, 0.1) });
        for (let i = 0; i < a.dots.length; i += 2) {
          const q = at({ x: a.dots[i], y: a.dots[i + 1] });
          pdf.circle(q.x, q.y, paint.width * 0.6, { fill: col });
        }
      }
    } else {
      // A kind outside the built-in seven (kinds/registry.ts): its tessellation, one path per run.
      for (const run of kindTessellate(e as Entity, 0.01)) {
        if (run.length < 2) continue;
        const closed = e.type === "ellipse" && isFullEllipse(e);
        pdf.polyline((closed ? run.slice(0, -1) : run).map(at), paint, closed);
      }
    }
  }

  return { scale };
}
