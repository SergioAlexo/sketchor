import { explodeDimensions } from "./dimensions/explode";
import { activeDimHost, styleOnlyHost } from "./dimensions/context";
import { hatchArt } from "./hatch/render";
import type { HatchEntity, TextEntity, ArcEntity, CircleEntity, EllipseEntity, Entity, SplineEntity, ImageEntity, LineEntity, PolylineEntity } from "./entities";
import { layerOf, newEntityId, polylineSegments, textWidth } from "./entities";
import type { Point } from "./geometry";
import { arcPointAt, arcSweep, bulgeToArc, dist } from "./geometry";
import { boundsOf } from "./dxf";
import { builtinLinetype } from "./linetypes";
import { kindTessellate } from "./kinds/registry";
import { bezierPieces, tessellateNurbs } from "./nurbs";
import type { Declarations, StyleRule } from "./svgStyle";
import { INHERITED_PROPS, STYLE_PROPS, isBlack, nearestLinetype, paintColor, parseDashArray, parseDeclarations, parseFontSize, parseStyleSheet, parseUserLength } from "./svgStyle";
import type { BlockDefinition } from "./blocks/types";
import { attributeTexts, evaluateInsert, insertMatrix } from "./blocks/evaluate";
import { ellipsePointAt, ellipseSweep, isFullEllipse, transformEllipse } from "./ellipse";

/**
 * Full-fidelity SVG import/export — unlike dxf.ts's `entitiesToSvg` (a
 * small fixed-size thumbnail renderer), this maps world coordinates
 * 1:1 to SVG user units via a real viewBox, so exported files are
 * dimensionally accurate and re-importing one round-trips exactly.
 */

function fmt(x: number): string {
  const r = Math.round(x * 1e4) / 1e4;
  return String(Object.is(r, -0) ? 0 : r);
}

function escapeXml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/* -------------------------------- export -------------------------------- */

export interface SvgExportOptions {
  /**
   * B-08: block definitions (mm). Inserts naming one are written as a `<use>` of a shared `<symbol>` instead of being
   * expanded — lossless and far smaller for repeated parts. Without it, callers pass inserts through `flattenInserts`.
   */
  blocks?: readonly BlockDefinition[];
  /** World-unit margin added around the drawing's bounds. */
  padding?: number;
  strokeColor?: string;
  strokeWidth?: number;
  /**
   * How solid a closed shape's `fill` is drawn (default 0.3 — the geometry
   * still reads through it). A printed sheet passes 1: the load plan picks
   * black or white labels from the fill colour, which only works on solid.
   */
  fillOpacity?: number;
  /**
   * Unit of the root `width`/`height`, so the file opens at true size
   * (world units are mm; the viewBox stays in mm and the browser/Inkscape/
   * LightBurn scale it to the stated physical size). `"none"` writes bare
   * numbers (read as px) for SVG embedded inline in an HTML page whose CSS
   * sizes it. Default `"mm"`.
   */
  unit?: "mm" | "in" | "none";
  /**
   * `"document"` (default): the drawing as displayed — colours, fills, dashes,
   * lineweights, text. `"laser"` (SV-05): what LightBurn / Glowforge / RDWorks
   * expect — 0.01 mm hairline strokes, no fills, no dashes, no text, points or
   * construction geometry, and exactly one stroke colour per layer (so the
   * laser software's colour→operation mapping equals the drawing's layers).
   */
  mode?: "document" | "laser";
}

/** Distinct, well-separated layer colours for laser mode (the first few match LightBurn's default layer palette). */
export const LASER_LAYER_COLORS = ["#000000", "#0000ff", "#ff0000", "#00e000", "#d0d000", "#ff8000", "#00e0e0", "#ff00ff", "#b4b4b4", "#0000a0", "#a00000", "#00a000"];

/**
 * One circular arc as exact SVG `A` commands (no tessellation). World ccw is
 * SVG sweep-flag 0 (Y is flipped); an arc of a full turn is split in two
 * halves because `A` with coincident endpoints draws nothing.
 */
function arcCommands(center: Point, r: number, startAngle: number, sweep: number, ccw: boolean, toSvg: (p: Point) => Point): string {
  const dir = ccw ? 1 : -1;
  const flag = ccw ? 0 : 1;
  const pt = (t: number): string => {
    const p = toSvg(arcPointAt(center, r, t));
    return `${fmt(p.x)} ${fmt(p.y)}`;
  };
  const a = (span: number, t1: number): string => `A${fmt(r)} ${fmt(r)} 0 ${span > Math.PI ? 1 : 0} ${flag} ${pt(t1)}`;
  if (sweep > 2 * Math.PI - 1e-9) {
    return `${a(Math.PI, startAngle + dir * Math.PI)} ${a(Math.PI, startAngle + dir * 2 * Math.PI)}`;
  }
  return a(sweep, startAngle + dir * sweep);
}

/** An arc entity as an exact SVG path `d` attribute. */
function arcPathD(e: ArcEntity, toSvg: (p: Point) => Point): string {
  const sweep = arcSweep(e.startAngle, e.endAngle, e.ccw);
  const p = toSvg(arcPointAt(e.center, e.radius, e.startAngle));
  return `M${fmt(p.x)} ${fmt(p.y)} ${arcCommands(e.center, e.radius, e.startAngle, sweep, e.ccw, toSvg)}`;
}

/** A spline as exact Béziers (`C` for cubic, `Q` quadratic, `L` linear) when it is clamped and not rational, else its tessellation. */
function splinePathD(e: SplineEntity, toSvg: (p: Point) => Point): string {
  const pieces = !e.weights || e.weights.every((w) => w === 1) ? bezierPieces(e) : null;
  const f = (p: Point): string => {
    const q = toSvg(p);
    return `${fmt(q.x)} ${fmt(q.y)}`;
  };
  if (pieces && e.degree <= 3) {
    const cmd = e.degree === 3 ? "C" : e.degree === 2 ? "Q" : "L";
    const d = [`M${f(pieces[0].points[0])}`];
    for (const pc of pieces) d.push(`${cmd}${pc.points.slice(1).map(f).join(" ")}`);
    return d.join(" ");
  }
  return tessellateNurbs(e, 0.01).map((p, i) => `${i === 0 ? "M" : "L"}${f(p)}`).join(" ");
}

/** A full ellipse as `<ellipse>` (rotated about its centre), an elliptical arc as a path with an `A` command — both exact. */
function ellipseSvg(e: EllipseEntity, toSvg: (p: Point) => Point, attrs: string): string {
  const rx = Math.hypot(e.majorAxis.x, e.majorAxis.y);
  const ry = rx * e.ratio;
  const rotDeg = -(Math.atan2(e.majorAxis.y, e.majorAxis.x) * 180) / Math.PI; // Y flips, so the angle negates
  if (isFullEllipse(e)) {
    const c = toSvg(e.center);
    const rot = Math.abs(rotDeg) > 1e-9 ? ` transform="rotate(${fmt(rotDeg)} ${fmt(c.x)} ${fmt(c.y)})"` : "";
    return `<ellipse cx="${fmt(c.x)}" cy="${fmt(c.y)}" rx="${fmt(rx)}" ry="${fmt(ry)}"${rot}${attrs}/>`;
  }
  const sweep = ellipseSweep(e);
  const p0 = toSvg(ellipsePointAt(e, e.start));
  const p1 = toSvg(ellipsePointAt(e, e.start + sweep));
  const large = sweep > Math.PI ? 1 : 0;
  // World ccw is SVG sweep-flag 0 (Y is flipped).
  return `<path d="M${fmt(p0.x)} ${fmt(p0.y)} A${fmt(rx)} ${fmt(ry)} ${fmt(rotDeg)} ${large} 0 ${fmt(p1.x)} ${fmt(p1.y)}"${attrs}/>`;
}

/** A polyline's segments (straight or bulge-arc) as one SVG path `d` attribute. */
function polylinePathD(e: PolylineEntity, toSvg: (p: Point) => Point): string {
  const parts: string[] = [];
  polylineSegments(e).forEach((seg, i) => {
    const a = toSvg(seg.a);
    if (i === 0) parts.push(`M${fmt(a.x)} ${fmt(a.y)}`);
    const bulgeArc = bulgeToArc(seg.a, seg.b, seg.bulge);
    if (!bulgeArc) {
      const b = toSvg(seg.b);
      parts.push(`L${fmt(b.x)} ${fmt(b.y)}`);
      return;
    }
    const sweep = arcSweep(bulgeArc.startAngle, bulgeArc.endAngle, bulgeArc.ccw);
    parts.push(arcCommands(bulgeArc.center, bulgeArc.radius, bulgeArc.startAngle, sweep, bulgeArc.ccw, toSvg));
  });
  if (e.closed) parts.push("Z");
  return parts.join(" ");
}

/**
 * Renders entities to a real, dimensionally-accurate SVG document — one
 * `<g>` per layer, world units mapped 1:1 to the viewBox (Y flipped, since
 * SVG Y grows down and world Y grows up).
 */
export function entitiesToSvgDocument(entitiesIn: Entity[], optsIn: SvgExportOptions = {}): string {
  // D-02a: dimensions are drawn as their parts (lines, arrow fills, centred text) so SVG matches the canvas.
  const entities = explodeDimensions(entitiesIn);
  const blockHost = styleOnlyHost(activeDimHost());
  const opts: SvgExportOptions = optsIn.blocks?.some((d) => d.entities.some((e) => e.type === "dimension" || e.type === "mtext"))
    ? { ...optsIn, blocks: optsIn.blocks.map((d) => ({ ...d, entities: explodeDimensions(d.entities, blockHost) })) }
    : optsIn;
  const padding = opts.padding ?? 5;
  const laser = opts.mode === "laser";
  const stroke = opts.strokeColor ?? "#000000";
  const strokeWidth = laser ? 0.01 : (opts.strokeWidth ?? Math.max(0.2, padding / 20));
  const fillOpacity = opts.fillOpacity ?? 0.3;

  const blockDefs = new Map((opts.blocks ?? []).map((d) => [d.name, d] as const));
  const host = { getRecord: (_t: string, name: string) => blockDefs.get(name), tablesRevision: 0 };
  const flatForBounds = blockDefs.size === 0 ? entities : entities.flatMap((e) => (e.type === "insert" ? evaluateInsert(host, e) : [e]));
  const b = boundsOf(flatForBounds) ?? { minX: 0, minY: 0, maxX: 100, maxY: 100 };
  const minX = b.minX - padding;
  const minY = b.minY - padding;
  const width = Math.max(b.maxX - b.minX + padding * 2, 1e-6);
  const height = Math.max(b.maxY - b.minY + padding * 2, 1e-6);
  const toSvg = (p: Point): Point => ({ x: p.x - minX, y: minY + height - p.y });

  const byLayer = new Map<string, Entity[]>();
  for (const e of entities) {
    if (e.type === "line" && e.infinite) continue; // construction aid, not geometry
    if (laser && (e.type === "text" || e.type === "point" || e.type === "hatch" || ("construction" in e && e.construction))) continue;
    const l = layerOf(e);
    if (!byLayer.has(l)) byLayer.set(l, []);
    byLayer.get(l)!.push(e);
  }

  // Per-entity overrides of the document-level stroke/fill: `color` becomes a
  // stroke, and `fill` (closed shapes only) a low-opacity fill so the geometry
  // still reads through it.
  const paint = (e: Entity): string => {
    if (laser) return ""; // the layer group carries the one colour; hairline width is the root's
    const closed = e.type === "circle" || (e.type === "spline" && e.closed) || (e.type === "ellipse" && isFullEllipse(e)) || (e.type === "polyline" && e.closed);
    let out = "";
    if (e.color) out += ` stroke="${escapeXml(e.color)}"`;
    if (closed && "fill" in e && e.fill) out += ` fill="${escapeXml(e.fill)}" fill-opacity="${fmt(fillOpacity)}"`;
    // Real mm dash lengths (Z-04): SVG coordinates are already in world (mm)
    // units here, so the linetype's own pattern is the dasharray directly —
    // no LTSCALE (this function has no document/settings to read one from,
    // same limitation BYLAYER colour already has at this level).
    if ("lineweight" in e && e.lineweight && e.lineweight > 0) out += ` stroke-width="${fmt(e.lineweight)}"`;
    if ("linetype" in e && e.linetype) {
      const pattern = builtinLinetype(e.linetype).pattern;
      if (pattern.length > 0) out += ` stroke-dasharray="${pattern.map((v) => fmt(Math.max(Math.abs(v), 0.1))).join(" ")}"`;
    }
    return out;
  };

  // H-09: hatches. A pattern is explicit strokes (already clipped to the region), a solid a flat even-odd
  // path, a gradient a real <linearGradient>/<radialGradient>; transparency is group opacity.
  const gradDefs: string[] = [];
  let gradientIndex = 0;
  const hatchSvg = (h: HatchEntity, toSvg: (p: Point) => Point): string => {
    const art = hatchArt(h);
    const col = h.color ? escapeXml(h.color) : stroke;
    if (!art) return "";
    const d = art.rings.map((ring) => ring.map((q, i) => `${i === 0 ? "M" : "L"}${fmt(toSvg(q).x)} ${fmt(toSvg(q).y)}`).join(" ") + " Z").join(" ");
    const opacity = art.transparency > 0 ? ` opacity="${fmt(1 - art.transparency)}"` : "";
    const parts: string[] = [];
    if (art.background) parts.push(`<path d="${d}" fill="${escapeXml(art.background)}" fill-rule="evenodd" stroke="none"/>`);
    const a = art.paint;
    if (a.kind === "solid") parts.push(`<path d="${d}" fill="${escapeXml(a.color)}" fill-rule="evenodd" stroke="none"/>`);
    else if (a.kind === "gradient") {
      const id = `hatchgrad${++gradientIndex}`;
      const s = a.spec;
      const stops = s.stops.map((st) => `<stop offset="${fmt(st.t)}" stop-color="${escapeXml(st.color)}"/>`).join("");
      if (s.kind === "linear") {
        const p1 = toSvg({ x: s.x1, y: s.y1 });
        const p2 = toSvg({ x: s.x2, y: s.y2 });
        gradDefs.push(`<linearGradient id="${id}" gradientUnits="userSpaceOnUse" x1="${fmt(p1.x)}" y1="${fmt(p1.y)}" x2="${fmt(p2.x)}" y2="${fmt(p2.y)}">${stops}</linearGradient>`);
      } else {
        const c = toSvg({ x: s.cx, y: s.cy });
        const f = toSvg({ x: s.fx, y: s.fy });
        gradDefs.push(`<radialGradient id="${id}" gradientUnits="userSpaceOnUse" cx="${fmt(c.x)}" cy="${fmt(c.y)}" r="${fmt(s.r)}" fx="${fmt(f.x)}" fy="${fmt(f.y)}">${stops}</radialGradient>`);
      }
      parts.push(`<path d="${d}" fill="url(#${id})" fill-rule="evenodd" stroke="none"/>`);
    } else if (a.kind === "tint") {
      parts.push(a.opacity > 0 ? `<path d="${d}" fill="${col}" fill-opacity="${fmt(a.opacity)}" fill-rule="evenodd" stroke="none"/>` : `<path d="${d}"${paint(h)} fill="none"/>`);
    } else {
      const seg = a.segments;
      const dd: string[] = [];
      for (let i = 0; i < seg.length; i += 4) {
        const p1 = toSvg({ x: seg[i], y: seg[i + 1] });
        const p2 = toSvg({ x: seg[i + 2], y: seg[i + 3] });
        dd.push(`M${fmt(p1.x)} ${fmt(p1.y)}L${fmt(p2.x)} ${fmt(p2.y)}`);
      }
      const w = h.lineweight && h.lineweight > 0 ? fmt(h.lineweight) : fmt(Math.max(strokeWidth * 0.5, 0.05));
      if (dd.length > 0) parts.push(`<path d="${dd.join("")}" stroke="${col}" stroke-width="${w}" fill="none"/>`);
      const dots = a.dots;
      const dotPath: string[] = [];
      for (let i = 0; i < dots.length; i += 2) {
        const q = toSvg({ x: dots[i], y: dots[i + 1] });
        dotPath.push(`M${fmt(q.x)} ${fmt(q.y)}h0`);
      }
      if (dotPath.length > 0) parts.push(`<path d="${dotPath.join("")}" stroke="${col}" stroke-width="${fmt(Number(w) * 2)}" stroke-linecap="round" fill="none"/>`);
    }
    return parts.length > 1 || opacity ? `<g${opacity}>${parts.join("")}</g>` : parts.join("");
  };

  const usedBlocks = new Set<string>();
  // Draws one entity (in the coordinate frame `toSvg` maps to) into `body`; shared by the layer groups and the block symbols.
  const emitEntity = (e: Entity, toSvg: (p: Point) => Point, body: string[], useSymbols: boolean): void => {
    if (e.type === "insert") {
      const def = blockDefs.get(e.block);
      if (!def) return;
      usedBlocks.add(def.name);
      const arr = e.array;
      const cols = Math.max(1, Math.round(arr?.cols ?? 1));
      const rows = Math.max(1, Math.round(arr?.rows ?? 1));
      for (let c = 0; c < cols; c++) {
        for (let r = 0; r < rows; r++) {
          const m = insertMatrix(e, def.basePoint, c * (arr?.colSpacing ?? 0), r * (arr?.rowSpacing ?? 0));
          // symbol space is world space with Y negated; the use maps it to SVG space
          const t = useSymbols ? [m[0], -m[1], -m[2], m[3], m[4] - minX, minY + height - m[5]] : [m[0], -m[1], -m[2], m[3], m[4], -m[5]];
          body.push(`<use href="#blk-${escapeXml(def.name)}" transform="matrix(${t.map(fmt).join(" ")})"/>`);
        }
      }
      let n = 0;
      for (const t of attributeTexts(host, e, () => `attr-${n++}`)) emitEntity(t, toSvg, body, useSymbols);
      return;
    }
      if (e.type === "line") {
        const a = toSvg(e.a);
        const c = toSvg(e.b);
        body.push(`<line x1="${fmt(a.x)}" y1="${fmt(a.y)}" x2="${fmt(c.x)}" y2="${fmt(c.y)}"${paint(e)}/>`);
      } else if (e.type === "circle") {
        const center = toSvg(e.center);
        body.push(`<circle cx="${fmt(center.x)}" cy="${fmt(center.y)}" r="${fmt(e.radius)}"${paint(e)}/>`);
      } else if (e.type === "point") {
        // SVG has no native point primitive — a small filled dot stands in,
        // sized off stroke width (not to world scale) like a CAD PDMODE marker.
        const p = toSvg(e.p);
        body.push(`<circle cx="${fmt(p.x)}" cy="${fmt(p.y)}" r="${fmt(strokeWidth * 1.5)}" fill="${stroke}" stroke="none"/>`);
      } else if (e.type === "arc") {
        body.push(`<path d="${arcPathD(e, toSvg)}"${paint(e)}/>`);
      } else if (e.type === "text") {
        const p = toSvg(e.at);
        const rot = e.rotation ? ` transform="rotate(${fmt((-e.rotation * 180) / Math.PI)} ${fmt(p.x)} ${fmt(p.y)})"` : "";
        const col = e.color ? escapeXml(e.color) : stroke;
        const anchor = e.halign === "center" ? ' text-anchor="middle"' : e.halign === "right" ? ' text-anchor="end"' : "";
        const baseline = e.valign === "middle" ? ' dominant-baseline="central"' : e.valign === "top" ? ' dominant-baseline="hanging"' : "";
        body.push(
          `<text x="${fmt(p.x)}" y="${fmt(p.y)}" font-size="${fmt(e.height)}" fill="${col}" stroke="none"${anchor}${baseline}${rot}>${escapeXml(e.text)}</text>`,
        );
      } else if (e.type === "image") {
        // The un-rotated top-left corner (insert + (0, height) in world,
        // Y-up), mapped to SVG's Y-down space, plus a rotation transform
        // about the mapped insertion point — same recipe as the text case.
        const topLeft = toSvg({ x: e.insert.x, y: e.insert.y + e.height });
        const pivot = toSvg(e.insert);
        const rot = e.rotation ? ` transform="rotate(${fmt((-e.rotation * 180) / Math.PI)} ${fmt(pivot.x)} ${fmt(pivot.y)})"` : "";
        body.push(
          `<image x="${fmt(topLeft.x)}" y="${fmt(topLeft.y)}" width="${fmt(e.width)}" height="${fmt(e.height)}" ` +
            `href="${escapeXml(e.dataUrl)}" preserveAspectRatio="none"${rot}/>`,
        );
      } else if (e.type === "ellipse") {
        body.push(ellipseSvg(e, toSvg, paint(e)));
      } else if (e.type === "spline") {
        body.push(`<path d="${splinePathD(e, toSvg)}${e.closed ? " Z" : ""}"${paint(e)}/>`);
      } else if (e.type === "polyline") {
        body.push(`<path d="${polylinePathD(e, toSvg)}"${paint(e)}/>`);
      } else if (e.type === "hatch") {
        body.push(hatchSvg(e, toSvg));
      } else {
        // A kind outside the built-in seven (kinds/registry.ts): its tessellation, one path per run.
        for (const run of kindTessellate(e, 0.01)) {
          if (run.length < 2) continue;
          const d = run.map((q, i) => {
            const p = toSvg(q);
            return `${i === 0 ? "M" : "L"}${fmt(p.x)} ${fmt(p.y)}`;
          });
          body.push(`<path d="${d.join(" ")}"${paint(e as Entity)}/>`);
        }
      }
    
  };

  const groups: string[] = [];
  let layerIndex = 0;
  for (const [layer, ents] of byLayer) {
    const body: string[] = [];
    for (const e of ents) emitEntity(e, toSvg, body, true);
    // An Inkscape-compatible layer (groupmode + label), plus Sketchor's own data-layer for exact re-import.
    const colour = laser ? ` stroke="${LASER_LAYER_COLORS[layerIndex % LASER_LAYER_COLORS.length]}"` : "";
    layerIndex++;
    groups.push(`<g data-layer="${escapeXml(layer)}" inkscape:groupmode="layer" inkscape:label="${escapeXml(layer)}"${colour}>${body.join("")}</g>`);
  }

  // One <symbol> per block actually used (nested blocks discovered while drawing the symbols are queued too).
  const symbolDefs: string[] = [];
  const done = new Set<string>();
  const flipY = (p: Point): Point => ({ x: p.x, y: -p.y });
  for (let progress = true; progress; ) {
    progress = false;
    for (const name of [...usedBlocks]) {
      if (done.has(name)) continue;
      done.add(name);
      progress = true;
      const body: string[] = [];
      for (const e of blockDefs.get(name)!.entities) {
        if (e.type === "line" && e.infinite) continue;
        if (laser && (e.type === "text" || e.type === "point" || e.type === "hatch" || ("construction" in e && e.construction))) continue;
        emitEntity(e, flipY, body, false);
      }
      symbolDefs.push(`<symbol id="blk-${escapeXml(name)}" overflow="visible">${body.join("")}</symbol>`);
    }
  }

  const unit = opts.unit ?? "mm";
  const sizeOf = (mm: number): string => (unit === "in" ? `${fmt(mm / 25.4)}in` : unit === "mm" ? `${fmt(mm)}mm` : fmt(mm));
  return (
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<svg xmlns="http://www.w3.org/2000/svg" xmlns:inkscape="http://www.inkscape.org/namespaces/inkscape" width="${sizeOf(width)}" height="${sizeOf(height)}" ` +
    `viewBox="0 0 ${fmt(width)} ${fmt(height)}" stroke="${stroke}" stroke-width="${fmt(strokeWidth)}" fill="none">\n` +
    ((gradDefs.length + symbolDefs.length) > 0 ? `<defs>${[...gradDefs, ...symbolDefs].join("")}</defs>\n` : "") +
    `${groups.join("\n")}\n</svg>\n`
  );
}

/* -------------------------------- import -------------------------------- */

/** A 2D affine matrix [a, b, c, d, e, f], matching SVG's matrix(a,b,c,d,e,f) convention. */
type Mat = [number, number, number, number, number, number];
const IDENTITY: Mat = [1, 0, 0, 1, 0, 0];

function multiply(m1: Mat, m2: Mat): Mat {
  const [a1, b1, c1, d1, e1, f1] = m1;
  const [a2, b2, c2, d2, e2, f2] = m2;
  return [a1 * a2 + c1 * b2, b1 * a2 + d1 * b2, a1 * c2 + c1 * d2, b1 * c2 + d1 * d2, a1 * e2 + c1 * f2 + e1, b1 * e2 + d1 * f2 + f1];
}

function applyMat(m: Mat, x: number, y: number): Point {
  const [a, b, c, d, e, f] = m;
  return { x: a * x + c * y + e, y: b * x + d * y + f };
}

/** Approximate uniform scale factor of a matrix (for radii, which don't otherwise transform simply). */
function matScale(m: Mat): number {
  const [a, b, c, d] = m;
  return (Math.hypot(a, b) + Math.hypot(c, d)) / 2;
}

function parseTransform(attr: string | null): Mat {
  if (!attr) return IDENTITY;
  let m: Mat = IDENTITY;
  const re = /(\w+)\s*\(([^)]*)\)/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(attr))) {
    const fn = match[1];
    const args = match[2].split(/[\s,]+/).filter(Boolean).map(Number);
    let mm: Mat = IDENTITY;
    if (fn === "translate") mm = [1, 0, 0, 1, args[0] || 0, args[1] || 0];
    else if (fn === "scale") mm = [args[0] ?? 1, 0, 0, args[1] ?? args[0] ?? 1, 0, 0];
    else if (fn === "rotate") {
      const rad = ((args[0] || 0) * Math.PI) / 180;
      const cos = Math.cos(rad);
      const sin = Math.sin(rad);
      const rot: Mat = [cos, sin, -sin, cos, 0, 0];
      mm = args.length >= 3 ? multiply(multiply([1, 0, 0, 1, args[1], args[2]], rot), [1, 0, 0, 1, -args[1], -args[2]]) : rot;
    } else if (fn === "matrix" && args.length === 6) {
      mm = args as Mat;
    }
    m = multiply(m, mm);
  }
  return m;
}

/** SVG world Y grows down; ours grows up. Imported geometry is flipped once, at the point of use. */
function fromSvgPoint(p: Point): Point {
  return { x: p.x, y: -p.y };
}

/**
 * SVG elliptical-arc endpoint parameterization (SVG 1.1 spec, appendix
 * F.6.5): converts (start, rx, ry, rotation, largeArc, sweep, end) into
 * center + radii + angles, so the arc can be sampled into line segments.
 */
function arcEndpointToCenter(
  p0: Point,
  rxIn: number,
  ryIn: number,
  rotationDeg: number,
  largeArc: boolean,
  sweep: boolean,
  p1: Point,
): { cx: number; cy: number; rx: number; ry: number; theta1: number; dtheta: number; phi: number } | null {
  if (dist(p0, p1) < 1e-9) return null;
  const phi = (rotationDeg * Math.PI) / 180;
  const cosPhi = Math.cos(phi);
  const sinPhi = Math.sin(phi);
  const dx2 = (p0.x - p1.x) / 2;
  const dy2 = (p0.y - p1.y) / 2;
  const x1p = cosPhi * dx2 + sinPhi * dy2;
  const y1p = -sinPhi * dx2 + cosPhi * dy2;

  let rx = Math.abs(rxIn);
  let ry = Math.abs(ryIn);
  if (rx < 1e-9 || ry < 1e-9) return null;
  const lambda = (x1p * x1p) / (rx * rx) + (y1p * y1p) / (ry * ry);
  if (lambda > 1) {
    const s = Math.sqrt(lambda);
    rx *= s;
    ry *= s;
  }

  const sign = largeArc !== sweep ? 1 : -1;
  const num = Math.max(0, rx * rx * ry * ry - rx * rx * y1p * y1p - ry * ry * x1p * x1p);
  const den = rx * rx * y1p * y1p + ry * ry * x1p * x1p;
  const coef = den < 1e-12 ? 0 : sign * Math.sqrt(num / den);
  const cxp = (coef * rx * y1p) / ry;
  const cyp = (-coef * ry * x1p) / rx;

  const cx = cosPhi * cxp - sinPhi * cyp + (p0.x + p1.x) / 2;
  const cy = sinPhi * cxp + cosPhi * cyp + (p0.y + p1.y) / 2;

  const angle = (ux: number, uy: number, vx: number, vy: number): number => {
    const dot = ux * vx + uy * vy;
    const len = Math.hypot(ux, uy) * Math.hypot(vx, vy);
    let a = Math.acos(Math.min(1, Math.max(-1, dot / len)));
    if (ux * vy - uy * vx < 0) a = -a;
    return a;
  };

  const theta1 = angle(1, 0, (x1p - cxp) / rx, (y1p - cyp) / ry);
  let dtheta = angle((x1p - cxp) / rx, (y1p - cyp) / ry, (-x1p - cxp) / rx, (-y1p - cyp) / ry);
  if (!sweep && dtheta > 0) dtheta -= 2 * Math.PI;
  if (sweep && dtheta < 0) dtheta += 2 * Math.PI;

  return { cx, cy, rx, ry, theta1, dtheta, phi };
}

/**
 * Reads a path's `d` string one token at a time. A regex split can't do this
 * right: `1.5.5` is two numbers, `-.5e-3` is one, and an arc's two flags are
 * single characters that may run straight into the next number (`a1 1 0 0110 10`).
 */
class PathScanner {
  i = 0;
  constructor(private readonly s: string) {}

  private skipSeparators(): void {
    while (this.i < this.s.length && /[\s,]/.test(this.s[this.i])) this.i++;
  }
  atEnd(): boolean {
    this.skipSeparators();
    return this.i >= this.s.length;
  }
  /** The next command letter, or null when a number (implicit repeat) or the end is next. */
  command(): string | null {
    this.skipSeparators();
    const c = this.s[this.i];
    if (c !== undefined && /[a-zA-Z]/.test(c)) {
      this.i++;
      return c;
    }
    return null;
  }
  /** True when a number starts here (tells "repeat the command" from junk). */
  numberAhead(): boolean {
    this.skipSeparators();
    return /^[-+]?(\d|\.\d)/.test(this.s.slice(this.i, this.i + 3));
  }
  number(): number | null {
    this.skipSeparators();
    const m = /^[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?/.exec(this.s.slice(this.i));
    if (!m) return null;
    this.i += m[0].length;
    return parseFloat(m[0]);
  }
  flag(): number | null {
    this.skipSeparators();
    const c = this.s[this.i];
    if (c !== "0" && c !== "1") return null;
    this.i++;
    return c === "1" ? 1 : 0;
  }
  /** Skips to the next command letter — recovery after a malformed command. */
  skipToCommand(): void {
    while (this.i < this.s.length && !/[a-zA-Z]/.test(this.s[this.i])) this.i++;
  }
}

/** Number of arguments per path command (an arc's two flags count as one each). */
const PATH_ARGS: Record<string, number> = { M: 2, L: 2, H: 1, V: 1, Z: 0, C: 6, S: 4, Q: 4, T: 2, A: 7 };

/**
 * Parses an SVG path `d` attribute. M/L/H/V/Z and elliptical arcs (A) are
 * exact (arcs tessellated); C/S/Q/T Béziers, with S/T reflecting the previous
 * control point, become real cubic splines — a quadratic is degree-elevated,
 * which is exact. A malformed or unknown command adds
 * a warning and skips only that command, never the rest of the path.
 */
function parsePathD(d: string, m: Mat, layer: string | undefined, out: Entity[], warn: (msg: string) => void): void {
  const sc = new PathScanner(d);
  let cur: Point = { x: 0, y: 0 };
  let start: Point = { x: 0, y: 0 };
  let cmd = "";
  // The previous curve's last control point, for S/T reflection (only valid
  // straight after a cubic / quadratic respectively).
  let lastCubic: Point | null = null;
  let lastQuad: Point | null = null;

  // Each subpath (a run between M commands, or split by Z) becomes ONE
  // entity when it can: a polyline for lines/arcs, a spline (cubic Béziers
  // chained with triple knots — exact, no flattening) when it is all curves.
  // A subpath mixing both is emitted as its runs, in order, each exact.
  type Piece = { kind: "poly"; points: Point[] } | { kind: "bez"; points: Point[] };
  let pieces: Piece[] = [];
  let subpathClosed = false;
  const toWorld = (p: Point): Point => fromSvgPoint(applyMat(m, p.x, p.y));
  /** The piece of `kind` being built, started at the current point when the kind changes. */
  const piece = (kind: Piece["kind"]): Piece => {
    const last = pieces[pieces.length - 1];
    if (last && last.kind === kind) return last;
    const fresh: Piece = { kind, points: [toWorld(cur)] };
    pieces.push(fresh);
    return fresh;
  };
  const flush = () => {
    const done = pieces;
    pieces = [];
    const wasClosed = subpathClosed;
    subpathClosed = false;
    for (const pc of done) {
      if (pc.kind === "poly") {
        if (pc.points.length < 2) continue;
        const points = pc.points.slice();
        const closed = done.length === 1 && wasClosed && dist(points[0], points[points.length - 1]) < 1e-9;
        // A Z repeats the start point, and most exporters (ours included) also
        // write an explicit line back to it first — so drop *every* trailing
        // duplicate, not just one, or the shape keeps a zero-length segment.
        while (closed && points.length > 1 && dist(points[0], points[points.length - 1]) < 1e-9) points.pop();
        if (points.length >= 2) out.push({ id: newEntityId(), type: "polyline", ...(layer ? { layer } : {}), points, closed });
      } else {
        const n = (pc.points.length - 1) / 3;
        const degenerate = pc.points.every((p) => dist(p, pc.points[0]) < 1e-9);
        if (n < 1 || degenerate) continue;
        const knots = [0, 0, 0, 0];
        for (let k = 1; k < n; k++) knots.push(k, k, k);
        knots.push(n, n, n, n);
        const closed = done.length === 1 && wasClosed && dist(pc.points[0], pc.points[pc.points.length - 1]) < 1e-9;
        out.push({ id: newEntityId(), type: "spline", ...(layer ? { layer } : {}), degree: 3, controlPoints: pc.points, knots, closed });
      }
    }
  };
  const line = (to: Point) => {
    piece("poly").points.push(toWorld(to));
    cur = to;
  };
  /** Appends one cubic segment (quadratics are elevated to one) to the running spline. */
  const cubic = (p1: Point, p2: Point, p3: Point) => {
    piece("bez").points.push(toWorld(p1), toWorld(p2), toWorld(p3));
    cur = p3;
  };

  while (!sc.atEnd()) {
    const letter = sc.command();
    if (letter !== null) {
      cmd = letter;
    } else if (!cmd || cmd.toUpperCase() === "Z" || !sc.numberAhead()) {
      // A number with no command to repeat (or after Z), or stray punctuation.
      warn("a path had stray characters after a command — skipped");
      sc.skipToCommand();
      continue;
    }
    const C = cmd.toUpperCase();
    const argc = PATH_ARGS[C];
    if (argc === undefined) {
      warn(`a path used an unknown command "${cmd}" — that command was skipped`);
      sc.skipToCommand();
      cmd = "";
      continue;
    }
    const relative = cmd !== C;
    const args: number[] = [];
    for (let k = 0; k < argc; k++) {
      const v = C === "A" && (k === 3 || k === 4) ? sc.flag() : sc.number();
      if (v === null) break;
      args.push(v);
    }
    if (args.length < argc) {
      warn(`a path command "${cmd}" had missing or malformed arguments — that command was skipped`);
      sc.skipToCommand();
      cmd = "";
      continue;
    }
    const ox = relative ? cur.x : 0;
    const oy = relative ? cur.y : 0;
    const prevCubic = lastCubic;
    const prevQuad = lastQuad;
    lastCubic = null;
    lastQuad = null;
    switch (C) {
      case "M": {
        flush(); // a new subpath starts — the previous one is done
        cur = { x: ox + args[0], y: oy + args[1] };
        start = cur;
        cmd = relative ? "l" : "L"; // subsequent pairs are an implicit lineto
        break;
      }
      case "L":
        line({ x: ox + args[0], y: oy + args[1] });
        break;
      case "H":
        line({ x: ox + args[0], y: cur.y });
        break;
      case "V":
        line({ x: cur.x, y: oy + args[0] });
        break;
      case "Z": {
        subpathClosed = true;
        const last = pieces[pieces.length - 1];
        if (last?.kind === "bez" && dist(cur, start) > 1e-9) {
          // Close a curve run with its own straight cubic, so a closed curve stays one spline.
          const third = (a: Point, b: Point, t: number): Point => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
          cubic(third(cur, start, 1 / 3), third(cur, start, 2 / 3), start);
        } else line(start);
        break;
      }
      case "C": {
        const p2 = { x: ox + args[2], y: oy + args[3] };
        cubic({ x: ox + args[0], y: oy + args[1] }, p2, { x: ox + args[4], y: oy + args[5] });
        lastCubic = p2;
        break;
      }
      case "S": {
        const p1 = prevCubic ? { x: 2 * cur.x - prevCubic.x, y: 2 * cur.y - prevCubic.y } : cur;
        const p2 = { x: ox + args[0], y: oy + args[1] };
        cubic(p1, p2, { x: ox + args[2], y: oy + args[3] });
        lastCubic = p2;
        break;
      }
      case "Q":
      case "T": {
        const q: Point =
          C === "Q"
            ? { x: ox + args[0], y: oy + args[1] }
            : prevQuad
              ? { x: 2 * cur.x - prevQuad.x, y: 2 * cur.y - prevQuad.y }
              : cur;
        const e = C === "Q" ? { x: ox + args[2], y: oy + args[3] } : { x: ox + args[0], y: oy + args[1] };
        // Degree elevation: a quadratic is exactly the cubic with these controls.
        const c1 = { x: cur.x + (2 / 3) * (q.x - cur.x), y: cur.y + (2 / 3) * (q.y - cur.y) };
        const c2 = { x: e.x + (2 / 3) * (q.x - e.x), y: e.y + (2 / 3) * (q.y - e.y) };
        cubic(c1, c2, e);
        lastQuad = q;
        break;
      }
      case "A": {
        const [rx, ry, rot, la, sw] = args;
        const to = { x: ox + args[5], y: oy + args[6] };
        const params = arcEndpointToCenter(cur, rx, ry, rot, la !== 0, sw !== 0, to);
        if (!params) {
          line(to);
          break;
        }
        const steps = Math.min(96, Math.max(2, Math.ceil((Math.abs(params.dtheta) / (2 * Math.PI)) * 96)));
        for (let s = 1; s <= steps; s++) {
          const t = params.theta1 + params.dtheta * (s / steps);
          const ex = params.rx * Math.cos(t);
          const ey = params.ry * Math.sin(t);
          const cosPhi = Math.cos(params.phi);
          const sinPhi = Math.sin(params.phi);
          line({ x: params.cx + ex * cosPhi - ey * sinPhi, y: params.cy + ex * sinPhi + ey * cosPhi });
        }
        cur = to;
        break;
      }
    }
  }
  flush();
}

/** mm in one CSS pixel — what an SVG user unit is when the file gives no physical size. */
export const SVG_MM_PER_PX = 25.4 / 96;

/** Physical CSS units → mm. `null` for `%`, `auto`, font-relative units and junk (caller falls back). */
const MM_PER_CSS_UNIT: Record<string, number> = { "": SVG_MM_PER_PX, px: SVG_MM_PER_PX, mm: 1, cm: 10, q: 0.25, in: 25.4, pt: 25.4 / 72, pc: 25.4 / 6 };
/** Units that name a real-world size (px and unitless are only a 96 dpi convention). */
const PHYSICAL_UNITS = new Set(["mm", "cm", "q", "in", "pt", "pc"]);

function parseSvgLength(v: string | null): { mm: number; unit: string } | null {
  if (v === null) return null;
  const m = /^\s*([-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?)\s*([a-zA-Z%]*)\s*$/.exec(v);
  if (!m) return null;
  const unit = m[2].toLowerCase();
  const perUnit = MM_PER_CSS_UNIT[unit];
  const value = parseFloat(m[1]);
  if (perUnit === undefined || !(value > 0)) return null;
  return { mm: value * perUnit, unit };
}

/** How an SVG's user units relate to the real world, as read from its root element. */
export interface SvgUnits {
  /** Millimetres per user unit. Entities come back already scaled by this (world units are mm). */
  mmPerUserUnit: number;
  /**
   * `declared` — width/height carry a physical unit (mm, cm, in, pt, pc), so
   * the size is the author's. `assumed` — no physical size anywhere (unitless
   * or px, percentages, nothing at all), so it was read at 96 dpi like a
   * browser would; worth showing the user.
   */
  source: "declared" | "assumed";
  /** `$INSUNITS` code matching the declared unit (1 in, 4 mm, 5 cm), when there is one. */
  insUnits?: number;
}

/**
 * Root-element mapping from user units to millimetres: `width`/`height`
 * against `viewBox`, honouring `preserveAspectRatio` (uniform meet/slice with
 * alignment, or `none` for independent x/y scale). The matrix maps user
 * coordinates to viewport millimetres, Y still down.
 */
function svgViewport(root: Element): { mat: Mat; units: SvgUnits } {
  const assumed = (): { mat: Mat; units: SvgUnits } => ({
    mat: [SVG_MM_PER_PX, 0, 0, SVG_MM_PER_PX, 0, 0],
    units: { mmPerUserUnit: SVG_MM_PER_PX, source: "assumed" },
  });
  const w = parseSvgLength(root.getAttribute("width"));
  const h = parseSvgLength(root.getAttribute("height"));
  const vbNums = (root.getAttribute("viewBox") ?? "").trim().split(/[\s,]+/).map(Number);
  const hasVb = vbNums.length === 4 && vbNums.every(Number.isFinite) && vbNums[2] > 0 && vbNums[3] > 0;
  // Without a viewBox a user unit is one CSS px whatever width/height say.
  if (!hasVb) return assumed();
  const [minX, minY, vbW, vbH] = vbNums;

  // A missing dimension follows the viewBox's aspect ratio (SVG's `auto`).
  let wMm = w?.mm ?? null;
  let hMm = h?.mm ?? null;
  if (wMm !== null && hMm === null) hMm = (wMm * vbH) / vbW;
  else if (hMm !== null && wMm === null) wMm = (hMm * vbW) / vbH;
  if (wMm === null || hMm === null) {
    // No usable size at all: 1 user unit = 1 px, but the viewBox origin still applies.
    return { mat: [SVG_MM_PER_PX, 0, 0, SVG_MM_PER_PX, -minX * SVG_MM_PER_PX, -minY * SVG_MM_PER_PX], units: assumed().units };
  }

  const par = (root.getAttribute("preserveAspectRatio") ?? "").trim().split(/\s+/).filter((t) => t !== "defer");
  const align = par[0] ?? "xMidYMid";
  const slice = par[1] === "slice";
  const sx = wMm / vbW;
  const sy = hMm / vbH;
  const physical = (w !== null && PHYSICAL_UNITS.has(w.unit)) || (h !== null && PHYSICAL_UNITS.has(h.unit));
  const unitCode = (u: string | undefined): number | undefined => (u === "in" ? 1 : u === "cm" ? 5 : u === "mm" ? 4 : undefined);
  const declaredUnit = w && PHYSICAL_UNITS.has(w.unit) ? w.unit : h && PHYSICAL_UNITS.has(h.unit) ? h.unit : undefined;
  const meta = (mmPerUserUnit: number): SvgUnits => ({
    mmPerUserUnit,
    source: physical ? "declared" : "assumed",
    ...(unitCode(declaredUnit) !== undefined ? { insUnits: unitCode(declaredUnit) } : {}),
  });

  if (align === "none") {
    return { mat: [sx, 0, 0, sy, -minX * sx, -minY * sy], units: meta((sx + sy) / 2) };
  }
  const s = slice ? Math.max(sx, sy) : Math.min(sx, sy);
  const frac = (a: string): number => (a === "Min" ? 0 : a === "Max" ? 1 : 0.5);
  const ax = frac(align.slice(1, 4));
  const ay = frac(align.slice(5, 8));
  return { mat: [s, 0, 0, s, (wMm - vbW * s) * ax - minX * s, (hMm - vbH * s) * ay - minY * s], units: meta(s) };
}

export interface SvgImportResult {
  entities: Entity[];
  warnings: string[];
  /** How the file's user units map to mm — entities are already scaled. See {@link SvgUnits}. */
  units: SvgUnits;
  /** SV-04: one definition per `<symbol>` used with `{ blocks: "keep" }`; the matching `insert` entities are in `entities`. */
  blocks: BlockDefinition[];
}

export interface SvgImportOptions {
  /** "keep": a `<use>` of a `<symbol>` becomes an insert of a real block (when its placement is a similarity); default "explode" draws the geometry in place. */
  blocks?: "keep" | "explode";
}

function invertMat(m: Mat): Mat | null {
  const [a, b, c, d, e, f] = m;
  const det = a * d - b * c;
  if (!Number.isFinite(det) || Math.abs(det) < 1e-12) return null;
  return [d / det, -b / det, -c / det, a / det, (c * f - d * e) / det, (b * e - a * f) / det];
}

/** True when no number anywhere inside `v` is NaN or infinite. */
function allFinite(v: unknown): boolean {
  if (typeof v === "number") return Number.isFinite(v);
  if (Array.isArray(v)) return v.every(allFinite);
  if (v && typeof v === "object") return Object.values(v).every(allFinite);
  return true;
}

/** Element children via sibling links — linear everywhere (a live `children` collection is quadratic to copy in some DOMs). */
function elementChildren(el: Element): Element[] {
  const out: Element[] = [];
  for (let c = el.firstElementChild; c; c = c.nextElementSibling) out.push(c);
  return out;
}

/** Groups nested deeper than this are not walked (reported) — keeps a hostile file from overflowing the stack. */
const MAX_NESTING = 256;

/**
 * Parses SVG into entities: line/circle/ellipse/rect/polyline/polygon
 * exactly, paths incl. Béziers (as splines; arcs flattened).
 * Coordinates come back in mm: the root `width`/`height`/`viewBox` give the
 * real size when they name one, else 96 dpi is assumed (see {@link SvgUnits}).
 * Uses the browser's DOMParser (this module's one browser-API dependency).
 */
export function parseSvgText(text: string, options: SvgImportOptions = {}): SvgImportResult {
  const keepBlocks = options.blocks === "keep";
  const blockDefs: BlockDefinition[] = [];
  const blockCache = new Map<string, string>();
  const entities: Entity[] = [];
  const warnings: string[] = [];
  const doc = new DOMParser().parseFromString(text, "image/svg+xml");
  if (doc.querySelector("parsererror")) {
    warnings.push("the SVG could not be parsed (malformed XML)");
    return { entities, warnings, units: { mmPerUserUnit: SVG_MM_PER_PX, source: "assumed" }, blocks: [] };
  }

  const numAttr = (el: Element, name: string, fallback = 0): number => {
    const v = el.getAttribute(name);
    return v === null ? fallback : parseFloat(v) || fallback;
  };
  // Layers: Sketchor's own data-layer, Inkscape layer groups (label, else id),
  // and — only in an Adobe Illustrator file — each top-level <g id>.
  const illustrator = /Adobe Illustrator/i.test(text.slice(0, 4000));
  const decodeId = (id: string): string => id.replace(/_x([0-9A-Fa-f]{2,4})_/g, (_, h: string) => String.fromCharCode(parseInt(h, 16)));
  const layerOf = (el: Element): string | undefined => {
    for (let a: Element | null = el; a; a = a.parentElement) {
      const dl = a.getAttribute("data-layer");
      if (dl !== null) return dl;
      if (a.tagName.toLowerCase() === "g") {
        if (a.getAttribute("inkscape:groupmode") === "layer") return a.getAttribute("inkscape:label") || a.getAttribute("id") || undefined;
        if (illustrator && a.parentElement === doc.documentElement && a.getAttribute("id")) return decodeId(a.getAttribute("id")!);
      }
    }
    return undefined;
  };
  const byId = new Map<string, Element>();
  const pending: Element[] = [doc.documentElement];
  while (pending.length) {
    const e = pending.pop()!;
    const id = e.getAttribute("id");
    if (id && !byId.has(id)) byId.set(id, e);
    const kids = elementChildren(e);
    for (let i = kids.length - 1; i >= 0; i--) pending.push(kids[i]);
  }

  // SV-03: <style> sheets, ordered by specificity then source order (the
  // browser's own Element.matches does the selector matching).
  const rules: StyleRule[] = [];
  for (const st of Array.from(doc.getElementsByTagName("style"))) {
    const type = st.getAttribute("type");
    if (type && type !== "text/css") continue;
    rules.push(...parseStyleSheet(st.textContent ?? "", rules.length));
  }
  rules.sort((a, b) => a.specificity - b.specificity || a.order - b.order);

  /** Presentation attributes < matching rules < `style=""`, with the inherited properties flowing down from the parent. */
  const computeStyle = (el: Element, parent: Declarations): Declarations => {
    const decl: Declarations = {};
    for (const p of STYLE_PROPS) {
      const a = el.getAttribute(p);
      if (a !== null && a.trim()) decl[p] = a.trim();
    }
    for (const r of rules) {
      try {
        if (el.matches(r.selector)) Object.assign(decl, r.decls);
      } catch {
        /* a selector this engine can't parse never matches */
      }
    }
    Object.assign(decl, parseDeclarations(el.getAttribute("style") ?? ""));
    const out: Declarations = {};
    for (const p of INHERITED_PROPS) {
      const v = decl[p];
      if (v !== undefined && v !== "inherit") out[p] = v;
      else if (parent[p] !== undefined) out[p] = parent[p];
    }
    if (decl.display) out.display = decl.display;
    if (decl.opacity) out.opacity = decl.opacity;
    return out;
  };

  let hiddenCount = 0;
  const LEAF_TAGS = new Set(["line", "circle", "ellipse", "rect", "image", "polyline", "polygon", "path", "text"]);
  // Never drawn directly: <use> pulls from them (or they carry paint servers / effects we do not model).
  const NOT_RENDERED = new Set(["defs", "symbol", "clippath", "mask", "marker", "pattern", "lineargradient", "radialgradient", "style", "title", "desc", "metadata", "script", "filter", "foreignobject"]);
  let effectCount = 0;
  let useCount = 0;
  const useStack = new Set<Element>();
  const symbolIds = new Map<Element, number>();

  /**
   * SV-04: a `<use>` of a `<symbol>` as an insert of a real block. The body is walked once per (symbol, inherited style) at the
   * document's own viewport scale (symbol origin = base point) and each use becomes translate, rotate, scale of it. Returns false
   * when the placement has shear or the symbol draws nothing, so the caller expands geometry instead.
   */
  const placeAsBlock = (target: Element, um: Mat, cs: Declarations, layer: string | undefined, depth: number): boolean => {
    const vp = viewport.mat;
    const inv = invertMat(vp);
    if (!inv) return false;
    const [a0, b0, c0, d0, e0, f0] = multiply(um, inv);
    const A: Mat = [a0, -b0, -c0, d0, e0, -f0]; // body world (Y up) to instance world
    const sx = Math.hypot(A[0], A[1]);
    let sy = Math.hypot(A[2], A[3]);
    if (!(sx > 1e-9) || !(sy > 1e-9)) return false;
    if (Math.abs(A[0] * A[2] + A[1] * A[3]) > 1e-6 * sx * sy) return false;
    if (A[0] * A[3] - A[1] * A[2] < 0) sy = -sy;
    if (!symbolIds.has(target)) symbolIds.set(target, symbolIds.size);
    const key = `${symbolIds.get(target)}|${JSON.stringify(cs)}`;
    let name = blockCache.get(key);
    if (name === undefined) {
      const before = entities.length;
      walk(target, vp, computeStyle(target, cs), null, depth);
      const body = entities.splice(before).map((e) => {
        const { layer: _l, ...rest } = e as Entity & { layer?: string };
        return rest as Entity;
      });
      if (body.length === 0) return false;
      const base = target.getAttribute("id") || "symbol";
      let n = base;
      for (let i = 2; blockDefs.some((d) => d.name === n); i++) n = `${base}~${i}`;
      name = n;
      blockDefs.push({ name, basePoint: fromSvgPoint(applyMat(vp, 0, 0)), entities: body, attributeDefs: [], explodable: true, scaleUniformly: false });
      blockCache.set(key, name);
    }
    const def = blockDefs.find((d) => d.name === name)!;
    entities.push({
      id: newEntityId(),
      type: "insert",
      ...(layer ? { layer } : {}),
      block: name,
      insert: applyMat(A, def.basePoint.x, def.basePoint.y),
      scale: { x: sx, y: sy },
      rotation: Math.atan2(A[1], A[0]),
      attributes: {},
    });
    return true;
  };

  const firstNum = (el: Element, a: string): number | null => {
    const v = el.getAttribute(a);
    if (!v) return null;
    const n = parseFloat(v.trim().split(/[\s,]+/)[0]);
    return Number.isFinite(n) ? n : null;
  };

  /** <text>/<tspan> → one TextEntity per line (a tspan with its own x/y/dy starts a line). */
  const emitText = (el: Element, m: Mat, cs: Declarations, layer: string | undefined): void => {
    const h = (parseFontSize(cs["font-size"]) ?? 16) * matScale(m);
    if (!(h > 0)) return;
    const anchor = cs["text-anchor"];
    const lines: { x: number; y: number; text: string }[] = [];
    let cur: { x: number; y: number; text: string } | null = null;
    let penX = (firstNum(el, "x") ?? 0) + (firstNum(el, "dx") ?? 0);
    let penY = (firstNum(el, "y") ?? 0) + (firstNum(el, "dy") ?? 0);
    const visit = (node: Element, depth: number): void => {
      if (depth > 32) return;
      for (const n of Array.from(node.childNodes)) {
        if (n.nodeType === 3 || n.nodeType === 4) {
          if (!cur) {
            cur = { x: penX, y: penY, text: "" };
            lines.push(cur);
          }
          cur.text += n.nodeValue ?? "";
        } else if (n.nodeType === 1) {
          const t = n as Element;
          if (computeStyle(t, cs).display === "none") continue;
          const x = firstNum(t, "x");
          const y = firstNum(t, "y");
          const dy = firstNum(t, "dy");
          if (x !== null || y !== null || dy !== null) {
            penX = x ?? cur?.x ?? penX;
            penY = y ?? (cur?.y ?? penY) + (dy ?? 0);
            cur = null;
          }
          visit(t, depth + 1);
        }
      }
    };
    visit(el, 0);
    const rotation = -Math.atan2(m[1], m[0]) || 0;
    const fill = paintColor(cs.fill, cs.color);
    for (const line of lines) {
      const t = line.text.replace(/\s+/g, " ").trim();
      if (!t) continue;
      const w = textWidth(t, h);
      const shift = anchor === "middle" ? w / 2 : anchor === "end" ? w : 0;
      const p = fromSvgPoint(applyMat(m, line.x, line.y));
      entities.push({
        id: newEntityId(),
        type: "text",
        ...(layer ? { layer } : {}),
        ...(typeof fill === "string" && !isBlack(fill) ? { color: fill } : {}),
        at: { x: p.x - shift * Math.cos(rotation), y: p.y - shift * Math.sin(rotation) },
        text: t,
        height: h,
        rotation,
      } as TextEntity);
    }
  };

  /** Stroke → colour, fill → fill (closed shapes), dasharray → nearest linetype, stroke-width → lineweight (mm). */
  const applyStyle = (from: number, st: Declarations, m: Mat): void => {
    const cur = st.color;
    const stroke = paintColor(st.stroke, cur);
    const fill = paintColor(st.fill, cur);
    const scale = matScale(m);
    const width = parseUserLength(st["stroke-width"]);
    const dash = parseDashArray(st["stroke-dasharray"]);
    for (let i = from; i < entities.length; i++) {
      const e = entities[i];
      if (e.type === "image" || e.type === "text") continue;
      const rec = e as Entity & { color?: string; fill?: string; linetype?: string; lineweight?: number };
      if (typeof stroke === "string") {
        if (!isBlack(stroke)) rec.color = stroke;
      } else if (stroke === null && typeof fill === "string" && !isBlack(fill)) {
        rec.color = fill; // a fill-only shape: its outline takes the fill's colour
      }
      const closed = e.type === "circle" || (e.type === "polyline" && e.closed) || (e.type === "spline" && e.closed) || (e.type === "ellipse" && isFullEllipse(e));
      if (closed && typeof fill === "string") rec.fill = fill;
      if (width !== null && stroke !== null && width * scale > 0) rec.lineweight = Math.round(width * scale * 1000) / 1000;
      if (dash && stroke !== null) rec.linetype = nearestLinetype(dash.map((v) => v * scale));
    }
  };

  let tooDeep = false;
  const walk = (el: Element, parentMat: Mat, parentStyle: Declarations, forced?: string | null, depth = 0): void => walkList(elementChildren(el), parentMat, parentStyle, forced, depth + 1);

  /** `forced`: a layer imposed by a <use> (null = the default layer); undefined = read it off each element's ancestors. */
  const walkList = (children: Element[], parentMat: Mat, parentStyle: Declarations, forced?: string | null, depth = 0): void => {
    if (depth > MAX_NESTING) {
      tooDeep = true;
      return;
    }
    for (const child of children) {
      const tag = child.tagName.toLowerCase();
      if (NOT_RENDERED.has(tag)) continue;
      const m = multiply(parentMat, parseTransform(child.getAttribute("transform")));
      const layer = forced !== undefined ? (forced ?? undefined) : layerOf(child);
      const cs = computeStyle(child, parentStyle);
      if (/(^|;)\s*(clip-path|mask|filter)\s*:\s*(?!none)/.test(child.getAttribute("style") ?? "") || ["clip-path", "mask", "filter"].some((a) => (child.getAttribute(a) ?? "none") !== "none")) effectCount++;
      const leaf = LEAF_TAGS.has(tag);
      if (cs.display === "none") {
        if (leaf || tag === "g") hiddenCount++;
        continue;
      }
      const vis = cs.visibility;
      const strokeNone = cs.stroke !== undefined && paintColor(cs.stroke, cs.color) === null;
      const fillNone = cs.fill !== undefined && paintColor(cs.fill, cs.color) === null;
      if (leaf && (vis === "hidden" || vis === "collapse" || (strokeNone && fillNone))) {
        hiddenCount++;
        continue;
      }
      const before = entities.length;
      switch (tag) {
        case "line": {
          const a = applyMat(m, numAttr(child, "x1"), numAttr(child, "y1"));
          const b = applyMat(m, numAttr(child, "x2"), numAttr(child, "y2"));
          entities.push({
            id: newEntityId(),
            type: "line",
            ...(layer ? { layer } : {}),
            a: fromSvgPoint(a),
            b: fromSvgPoint(b),
          } as LineEntity);
          break;
        }
        case "circle": {
          const center = applyMat(m, numAttr(child, "cx"), numAttr(child, "cy"));
          const r = numAttr(child, "r") * matScale(m);
          if (r > 0) {
            entities.push({
              id: newEntityId(),
              type: "circle",
              ...(layer ? { layer } : {}),
              center: fromSvgPoint(center),
              radius: r,
            } as CircleEntity);
          }
          break;
        }
        case "ellipse": {
          const rx = numAttr(child, "rx");
          const ry = numAttr(child, "ry");
          if (rx <= 0 || ry <= 0) break;
          const [ma, mb, mc, md] = m;
          const similar = Math.abs(ma * mc + mb * md) < 1e-6 * (Math.hypot(ma, mb) * Math.hypot(mc, md) || 1) && Math.abs(Math.hypot(ma, mb) - Math.hypot(mc, md)) < 1e-6 * (Math.hypot(ma, mb) || 1);
          const cx = numAttr(child, "cx");
          const cy = numAttr(child, "cy");
          if (similar && Math.abs(rx - ry) <= Math.max(rx, ry) * 0.001) {
            entities.push({
              id: newEntityId(),
              type: "circle",
              ...(layer ? { layer } : {}),
              center: fromSvgPoint(applyMat(m, cx, cy)),
              radius: ((rx + ry) / 2) * matScale(m),
            } as CircleEntity);
            break;
          }
          // A real ellipse (C-03): the images of the two semi-diameters under the element's transform
          // are conjugate semi-diameters of the result, which transformEllipse turns into principal axes.
          const c0 = fromSvgPoint(applyMat(m, cx, cy));
          const u = fromSvgPoint(applyMat(m, cx + rx, cy));
          const v = fromSvgPoint(applyMat(m, cx, cy + ry));
          const g = transformEllipse(
            { center: { x: 0, y: 0 }, majorAxis: { x: 1, y: 0 }, ratio: 1, start: 0, end: Math.PI * 2 },
            [u.x - c0.x, u.y - c0.y, v.x - c0.x, v.y - c0.y, c0.x, c0.y],
          );
          if (g) entities.push({ id: newEntityId(), type: "ellipse", ...(layer ? { layer } : {}), ...g });
          break;
        }
        case "rect": {
          const x = numAttr(child, "x");
          const y = numAttr(child, "y");
          const w = numAttr(child, "width");
          const h = numAttr(child, "height");
          const corners: Point[] = [
            { x, y },
            { x: x + w, y },
            { x: x + w, y: y + h },
            { x, y: y + h },
          ].map((p) => fromSvgPoint(applyMat(m, p.x, p.y)));
          entities.push({
            id: newEntityId(),
            type: "polyline",
            ...(layer ? { layer } : {}),
            points: corners,
            closed: true,
          });
          break;
        }
        case "image": {
          const x = numAttr(child, "x");
          const y = numAttr(child, "y");
          const w = numAttr(child, "width");
          const h = numAttr(child, "height");
          const href = child.getAttribute("href") ?? child.getAttributeNS("http://www.w3.org/1999/xlink", "href");
          if (w > 0 && h > 0 && href) {
            if (!href.startsWith("data:")) {
              warnings.push("an <image> referencing an external file (not an embedded data: URI) was skipped");
              break;
            }
            const [ma, mb, mc, md] = m;
            const colScaleA = Math.hypot(ma, mb);
            const colScaleC = Math.hypot(mc, md);
            const orthogonalAndUniform =
              Math.abs(ma * mc + mb * md) < 1e-6 * (colScaleA * colScaleC || 1) &&
              Math.abs(colScaleA - colScaleC) < 1e-6 * (colScaleA || 1);
            if (!orthogonalAndUniform) {
              warnings.push("an <image> had a skewed or non-uniform transform — imported as a plain rotated rectangle");
            }
            entities.push({
              id: newEntityId(),
              type: "image",
              ...(layer ? { layer } : {}),
              // The un-rotated bottom-left corner in world (Y-up) is (x, y + h)
              // in SVG (Y-down) space — same recipe as export, run backwards.
              insert: fromSvgPoint(applyMat(m, x, y + h)),
              width: w * matScale(m),
              height: h * matScale(m),
              rotation: -Math.atan2(mb, ma),
              dataUrl: href,
            } as ImageEntity);
          }
          break;
        }
        case "polyline":
        case "polygon": {
          const raw = (child.getAttribute("points") ?? "").trim().split(/[\s,]+/).map(Number);
          const pts: Point[] = [];
          for (let k = 0; k + 1 < raw.length; k += 2) pts.push(fromSvgPoint(applyMat(m, raw[k], raw[k + 1])));
          if (pts.length >= 2) {
            entities.push({
              id: newEntityId(),
              type: "polyline",
              ...(layer ? { layer } : {}),
              points: pts,
              closed: child.tagName.toLowerCase() === "polygon",
            });
          }
          break;
        }
        case "path": {
          const d = child.getAttribute("d");
          if (d) parsePathD(d, m, layer, entities, (msg) => warnings.push(msg));
          break;
        }
        case "text":
          emitText(child, m, cs, layer);
          break;
        case "use": {
          const href = child.getAttribute("href") ?? child.getAttribute("xlink:href");
          const target = href && href.startsWith("#") ? byId.get(href.slice(1)) : undefined;
          if (!target) {
            warnings.push("a <use> referencing a missing or external element was skipped");
            break;
          }
          if (useStack.has(target)) {
            warnings.push("a <use> that references itself (a cycle) was skipped");
            break;
          }
          if (++useCount > 20000) {
            warnings.push("too many <use> instances — the rest were skipped");
            break;
          }
          let um = multiply(m, [1, 0, 0, 1, numAttr(child, "x"), numAttr(child, "y")]);
          useStack.add(target);
          try {
            const ttag = target.tagName.toLowerCase();
            if (ttag === "symbol" || ttag === "svg") {
              const vb = (target.getAttribute("viewBox") ?? "").trim().split(/[\s,]+/).map(Number);
              if (vb.length === 4 && vb.every(Number.isFinite) && vb[2] > 0 && vb[3] > 0) {
                const uw = parseUserLength(child.getAttribute("width") ?? target.getAttribute("width") ?? undefined);
                const uh = parseUserLength(child.getAttribute("height") ?? target.getAttribute("height") ?? undefined);
                const sc = uw && uh ? Math.min(uw / vb[2], uh / vb[3]) : 1;
                const ox = uw ? (uw - vb[2] * sc) / 2 : 0;
                const oy = uh ? (uh - vb[3] * sc) / 2 : 0;
                um = multiply(um, [sc, 0, 0, sc, ox - vb[0] * sc, oy - vb[1] * sc]);
              }
              if (!(keepBlocks && ttag === "symbol" && placeAsBlock(target, um, cs, layer, depth))) {
                walk(target, um, computeStyle(target, cs), layer ?? null, depth);
              }
            } else {
              walkList([target], um, cs, layer ?? null, depth + 1);
            }
          } finally {
            useStack.delete(target);
          }
          break;
        }
        case "g":
        case "svg":
          walk(child, m, cs, forced, depth);
          break;
        default:
          // Unknown element (<a>, <switch>, ...): not drawn itself, but its
          // children may be — walk them.
          walk(child, m, cs, forced, depth);
      }
      if (leaf && entities.length > before) applyStyle(before, cs, m);
    }
  };

  const viewport = svgViewport(doc.documentElement);
  walk(doc.documentElement, viewport.mat, computeStyle(doc.documentElement, {}));
  if (tooDeep) warnings.push(`groups nested deeper than ${MAX_NESTING} levels were skipped`);
  if (effectCount) warnings.push(`${effectCount} element${effectCount === 1 ? "" : "s"} with clip-path, mask or filter were imported without that effect`);
  if (hiddenCount) warnings.push(`${hiddenCount} hidden or invisible element${hiddenCount === 1 ? "" : "s"} (display:none, visibility:hidden, or no stroke and no fill) skipped`);
  const finite = entities.filter(allFinite);
  if (finite.length !== entities.length) warnings.push(`${entities.length - finite.length} element${entities.length - finite.length === 1 ? "" : "s"} with non-finite coordinates were skipped`);
  return { entities: finite, warnings: [...new Set(warnings)], units: viewport.units, blocks: blockDefs };
}
