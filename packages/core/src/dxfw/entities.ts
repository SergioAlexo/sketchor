import type { HatchEntity, ArcEntity, CircleEntity, EllipseEntity, Entity, SplineEntity, ImageEntity, LineEntity, PointEntity, PolylineEntity, TextEntity, MTextEntity } from "../entities";
import { imageCorners, layerOf } from "../entities";
import { dist } from "../geometry";
import { ellipseSweep, isFullEllipse } from "../ellipse";
import { kindTessellate } from "../kinds/registry";
import { aciToHex, hexToRgb, nearestAci } from "../aci";
import { H_ALIGN_CODE, V_ALIGN_CODE } from "../textStyle";
import { n, pair } from "./write";
import { entityXdataText } from "../sketchorData";
import { hatchDxfPairs, type OutPair } from "../hatch/hatchDxf";

const RAD_TO_DEG = 180 / Math.PI;

/**
 * X-04: color 62 (ACI, the nearest palette match — always written, so a
 * reader that ignores true colour still gets *a* colour) plus true colour
 * 420 (exact 0xRRGGBB) when the nearest ACI isn't already an exact match,
 * so the common case (a CSS colour that happens to be one of the 256
 * palette entries) doesn't carry a redundant group. R12 can't do this — no
 * 420 — so its writer (`dxfExport.ts`) only ever has the ACI fallback.
 */
function colorGroups(e: Entity): string {
  if (!e.color) return "";
  const rgb = hexToRgb(e.color);
  if (!rgb) return ""; // a named CSS colour or similar — ACI/true-colour have no representation for it
  const aci = nearestAci(e.color);
  const trueColorInt = (rgb[0] << 16) | (rgb[1] << 8) | rgb[2];
  const aciIsExact = aciToHex(aci) === `#${trueColorInt.toString(16).padStart(6, "0")}`;
  // 62 and 420 are integer groups — unlike pair()'s coordinates/radii, they must NOT get n()'s ".0" suffix.
  return `62\n${aci}\n` + (aciIsExact ? "" : `420\n${trueColorInt}\n`);
}

/** Z-04: linetype (group 6, BYLAYER when absent) and lineweight (group 370, hundredths of a millimetre, BYLAYER when absent). */
function linetypeGroups(e: Entity): string {
  const lt = e.linetype ? `6\n${e.linetype}\n` : "";
  const lw = e.lineweight !== undefined ? `370\n${Math.round(e.lineweight * 100)}\n` : "";
  return lt + lw;
}

/**
 * `5`/`330`/`100 AcDbEntity` + layer + colour + linetype/lineweight — the
 * common head every AC1032 entity record opens with, before its
 * subclass-specific groups.
 */
export function entityHead(handle: string, owner: string, e: Entity): string {
  return `5\n${handle}\n330\n${owner}\n100\nAcDbEntity\n8\n${layerOf(e)}\n${colorGroups(e)}${linetypeGroups(e)}`;
}

export function lineEntity2018(e: LineEntity, handle: string, owner: string): string {
  return (
    `0\nLINE\n` +
    entityHead(handle, owner, e) +
    `100\nAcDbLine\n` +
    pair(10, e.a.x) + pair(20, e.a.y) + pair(30, 0) +
    pair(11, e.b.x) + pair(21, e.b.y) + pair(31, 0) +
    entityXdataText(e)
  );
}

export function circleEntity2018(e: CircleEntity, handle: string, owner: string): string {
  return (
    `0\nCIRCLE\n` +
    entityHead(handle, owner, e) +
    `100\nAcDbCircle\n` +
    pair(10, e.center.x) + pair(20, e.center.y) + pair(30, 0) +
    pair(40, e.radius) +
    entityXdataText(e)
  );
}

export function arcEntity2018(e: ArcEntity, handle: string, owner: string): string {
  // DXF ARC always sweeps counterclockwise from code 50 to 51; a clockwise
  // arc is the same curve read the other way, so swap the endpoints.
  const startDeg = (e.ccw ? e.startAngle : e.endAngle) * RAD_TO_DEG;
  const endDeg = (e.ccw ? e.endAngle : e.startAngle) * RAD_TO_DEG;
  return (
    `0\nARC\n` +
    entityHead(handle, owner, e) +
    `100\nAcDbCircle\n` +
    pair(10, e.center.x) + pair(20, e.center.y) + pair(30, 0) +
    pair(40, e.radius) +
    `100\nAcDbArc\n` +
    pair(50, startDeg) + pair(51, endDeg) +
    entityXdataText(e)
  );
}

/** A parametric angle or ratio at full double precision — 6 decimals would turn a full ellipse's 2π into "almost full". */
const hi = (code: number, v: number): string => `${code}
${Number.isInteger(v) ? `${v}.0` : String(+v.toPrecision(15))}
`;

export function ellipseEntity2018(e: EllipseEntity, handle: string, owner: string): string {
  const full = isFullEllipse(e);
  return (
    `0
ELLIPSE
` +
    entityHead(handle, owner, e) +
    `100
AcDbEllipse
` +
    pair(10, e.center.x) + pair(20, e.center.y) + pair(30, 0) +
    pair(11, e.majorAxis.x) + pair(21, e.majorAxis.y) + pair(31, 0) +
    pair(210, 0) + pair(220, 0) + pair(230, 1) +
    hi(40, e.ratio) +
    hi(41, full ? 0 : e.start) + hi(42, full ? Math.PI * 2 : e.start + ellipseSweep(e)) +
    entityXdataText(e)
  );
}

export function splineEntity2018(e: SplineEntity, handle: string, owner: string): string {
  const rational = e.weights !== undefined && e.weights.some((x) => x !== 1);
  const flags = 8 + (e.closed ? 1 : 0) + (rational ? 4 : 0);
  const fit = e.fitPoints ?? [];
  return (
    `0\nSPLINE\n` +
    entityHead(handle, owner, e) +
    `100\nAcDbSpline\n` +
    pair(210, 0) + pair(220, 0) + pair(230, 1) +
    `70\n${flags}\n71\n${e.degree}\n72\n${e.knots.length}\n73\n${e.controlPoints.length}\n74\n${fit.length}\n` +
    hi(42, 1e-7) + hi(43, 1e-7) + (fit.length > 0 ? hi(44, 1e-10) : "") +
    (fit.length > 0 && e.startTangent ? hi(12, e.startTangent.x) + hi(22, e.startTangent.y) + hi(32, 0) : "") +
    (fit.length > 0 && e.endTangent ? hi(13, e.endTangent.x) + hi(23, e.endTangent.y) + hi(33, 0) : "") +
    e.knots.map((k) => hi(40, k)).join("") +
    (rational ? e.weights!.map((x) => hi(41, x)).join("") : "") +
    e.controlPoints.map((c) => hi(10, c.x) + hi(20, c.y) + hi(30, 0)).join("") +
    fit.map((c) => hi(11, c.x) + hi(21, c.y) + hi(31, 0)).join("") +
    entityXdataText(e)
  );
}

export function pointEntity2018(e: PointEntity, handle: string, owner: string): string {
  return (
    `0\nPOINT\n` +
    entityHead(handle, owner, e) +
    `100\nAcDbPoint\n` +
    pair(10, e.p.x) + pair(20, e.p.y) + pair(30, 0) +
    entityXdataText(e)
  );
}

/** As LWPOLYLINE (the inverse of dxf.ts's `lwpolylineVertices`/`emitPolylineWithBulges`). */
export function polylineEntity2018(e: PolylineEntity, handle: string, owner: string): string {
  const verts = e.points
    .map((p, i) => pair(10, p.x) + pair(20, p.y) + pair(42, e.bulges?.[i] ?? 0))
    .join("");
  return (
    `0\nLWPOLYLINE\n` +
    entityHead(handle, owner, e) +
    `100\nAcDbPolyline\n` +
    `90\n${e.points.length}\n` +
    `70\n${e.closed ? 1 : 0}\n` +
    verts +
    entityXdataText(e)
  );
}

/** 72/73 plus the alignment point (11): DXF ignores group 11 unless an alignment is set, so write it only then. */
function textAlignGroups(e: TextEntity): string {
  const h = H_ALIGN_CODE[e.halign ?? "left"];
  const v = V_ALIGN_CODE[e.valign ?? "baseline"];
  return h || v ? `72\n${h}\n` + pair(11, e.at.x) + pair(21, e.at.y) + pair(31, 0) + `73\n${v}\n` : "";
}

export function textEntity2018(e: TextEntity, handle: string, owner: string): string {
  return (
    `0\nTEXT\n` +
    entityHead(handle, owner, e) +
    `100\nAcDbText\n` +
    pair(10, e.at.x) + pair(20, e.at.y) + pair(30, 0) +
    pair(40, e.height) +
    pair(1, e.text) +
    (e.rotation ? pair(50, (e.rotation * 180) / Math.PI) : "") +
    (e.widthFactor && e.widthFactor !== 1 ? pair(41, e.widthFactor) : "") +
    (e.oblique ? pair(51, e.oblique) : "") +
    pair(7, e.style || "Standard") +
    textAlignGroups(e) +
    `100\nAcDbText\n` +
    entityXdataText(e)
  );
}

/** D-10: a real MTEXT record - codes verbatim (chunks of 250 in group 3, the rest in group 1), wrap width, attachment, spacing, background mask. */
export function mtextEntity2018(e: MTextEntity, handle: string, owner: string): string {
  const chunks: string[] = [];
  let rest = e.text;
  while ([...rest].length > 250) {
    const head = [...rest].slice(0, 250).join("");
    // Never split an escape: a trailing lone backslash moves to the next chunk.
    const cut = head.endsWith("\\") && !head.endsWith("\\\\") ? head.slice(0, -1) : head;
    chunks.push(cut);
    rest = rest.slice(cut.length);
  }
  const bg = e.background;
  const rgb = bg?.color ? hexToRgb(bg.color) : null;
  return (
    `0\nMTEXT\n` +
    entityHead(handle, owner, e) +
    `100\nAcDbMText\n` +
    pair(10, e.at.x) + pair(20, e.at.y) + pair(30, 0) +
    pair(40, e.height) +
    (e.width > 0 ? pair(41, e.width) : "") +
    pair(71, Math.min(9, Math.max(1, Math.round(e.attachment || 1)))) +
    pair(72, 1) +
    chunks.map((c) => pair(3, c)).join("") +
    pair(1, rest) +
    pair(7, e.style || "Standard") +
    (e.rotation ? pair(50, (e.rotation * 180) / Math.PI) : "") +
    (e.lineSpacing && e.lineSpacing !== 1 ? pair(73, 1) + pair(44, e.lineSpacing) : "") +
    (bg
      ? pair(90, rgb ? 1 : 2) + pair(45, bg.scale ?? 1.5) + (rgb ? pair(63, nearestAci(bg.color!)) + pair(421, (rgb[0] << 16) | (rgb[1] << 8) | rgb[2]) : pair(63, 0))
      : "") +
    entityXdataText(e)
  );
}

/**
 * DXF's IMAGE entity references an external raster file through a separate
 * IMAGEDEF object — there's no way to embed pixels inline — and a true
 * round trip needs a sidecar PNG the caller writes next to the DXF (desktop:
 * a native path; web: a second File System Access write). That plumbing is
 * X-01 follow-up (image sidecar export isn't wired into any save path yet),
 * so for now an image keeps exporting as a labelled placeholder box, same as
 * the R12 writer — position/size/rotation survive, the picture doesn't.
 */
export function imageEntity2018(e: ImageEntity, handle: string, owner: string, nextHandle: () => string): string {
  const corners = imageCorners(e);
  const verts = corners.map((p) => pair(10, p.x) + pair(20, p.y) + pair(42, 0)).join("");
  const box =
    `0\nLWPOLYLINE\n` +
    entityHead(handle, owner, e) +
    `100\nAcDbPolyline\n` +
    `90\n${corners.length}\n70\n1\n` +
    verts +
    entityXdataText(e);
  const labelHeight = Math.min(e.width, e.height) * 0.08 || 1;
  const label =
    `0\nTEXT\n` +
    entityHead(nextHandle(), owner, e) +
    `100\nAcDbText\n` +
    pair(10, e.insert.x) + pair(20, e.insert.y) + pair(30, 0) +
    pair(40, labelHeight) +
    pair(1, `[image${e.name ? " " + e.name : ""}]`) +
    pair(7, "Standard") +
    `100\nAcDbText\n`;
  return box + label;
}

export function hatchEntity2018(e: HatchEntity, handle: string, owner: string): string {
  const { head, body } = hatchDxfPairs(e);
  const fmt = ([code, v, kind]: OutPair): string => `${code}\n${kind === "f" ? n(v as number) : kind === "i" ? String(Math.round(v as number)) : v}\n`;
  // A solid fill takes the entity colour in DXF, so the paint colour travels there.
  const headOwner: HatchEntity = e.paint.kind === "solid" ? { ...e, color: e.paint.color } : e;
  return `0\nHATCH\n` + entityHead(handle, owner, headOwner) + head.map(fmt).join("") + `100\nAcDbHatch\n` + body.map(fmt).join("") + entityXdataText(e);
}

/**
 * One entity as AC1032 record(s). `nextHandle`/`owner` let a multi-record
 * entity (image) or a kind outside the built-in seven (tessellated to
 * polylines, each needing its own handle) allocate as many handles as they
 * need.
 */
export function entityDxf2018(e: Entity, handle: string, owner: string, nextHandle: () => string): string {
  switch (e.type) {
    case "line":
      return lineEntity2018(e, handle, owner);
    case "circle":
      return circleEntity2018(e, handle, owner);
    case "arc":
      return arcEntity2018(e, handle, owner);
    case "point":
      return pointEntity2018(e, handle, owner);
    case "ellipse":
      return ellipseEntity2018(e, handle, owner);
    case "spline":
      return splineEntity2018(e, handle, owner);
    case "polyline":
      return polylineEntity2018(e, handle, owner);
    case "text":
      return textEntity2018(e, handle, owner);
    case "mtext":
      return mtextEntity2018(e, handle, owner);
    case "image":
      return imageEntity2018(e, handle, owner, nextHandle);
    case "hatch":
      return hatchEntity2018(e, handle, owner);
    default:
      // A kind outside the built-in seven (kinds/registry.ts): write its
      // tessellation as polylines, same fallback as the R12 writer.
      return kindTessellate(e as Entity, 0.01)
        .filter((run) => run.length >= 2)
        .map((run, i) => {
          const closed = run.length > 2 && dist(run[0], run[run.length - 1]) < 1e-9;
          const poly: PolylineEntity = {
            id: (e as Entity).id,
            type: "polyline",
            layer: (e as Entity).layer,
            color: (e as Entity).color,
            points: closed ? run.slice(0, -1) : run,
            closed,
          };
          return polylineEntity2018(poly, i === 0 ? handle : nextHandle(), owner);
        })
        .join("");
  }
}

// Re-exported so dxfw/index.ts doesn't need a second import of these tiny helpers.
export { n, pair };
