import type { DimensionEntity, Entity, HatchEntity, PolylineEntity, TextEntity } from "../entities";
import { textToStrokes } from "../font";
import type { Point } from "../geometry";
import { activeDimHost, type DimHost } from "./context";
import type { DimText } from "./layout";
import { layoutOf } from "./resolve";
import { explodeMText } from "../mtext/explode";

/**
 * A dimension as ordinary entities — lines, filled arrow polygons and one
 * centred TEXT. This is what writers without a DIMENSION record (R12 DXF, SVG,
 * PDF, EPS) and EXPLODE use, so every rendering shows the same drawing the
 * canvas does. Ids are `<dim id>:<n>`.
 */
export function explodeDimension(e: DimensionEntity, host: DimHost | null = activeDimHost()): Entity[] {
  const layout = layoutOf(e, host);
  const base = {
    ...(e.layer !== undefined ? { layer: e.layer } : {}),
    ...(e.color !== undefined ? { color: e.color } : {}),
    ...(e.linetype !== undefined ? { linetype: e.linetype } : {}),
    ...(e.lineweight !== undefined ? { lineweight: e.lineweight } : {}),
  };
  const out: Entity[] = [];
  let n = 0;
  const poly = (pts: Point[], extra: Partial<PolylineEntity> = {}) => {
    if (pts.length < 2) return;
    const closed = pts.length > 2 && Math.hypot(pts[0].x - pts[pts.length - 1].x, pts[0].y - pts[pts.length - 1].y) < 1e-9;
    out.push({ id: `${e.id}:${n++}`, type: "polyline", ...base, points: closed ? pts.slice(0, -1) : pts, closed, ...extra });
  };
  for (const run of layout.lines) poly(run);
  // Arrow heads are SOLID fills, not a 30 % tint (what `fill` on a closed polyline means everywhere else), so they are solid hatches: opaque in SVG/PDF/EPS and a real HATCH in DXF.
  for (const run of layout.fills) {
    if (run.length < 3) continue;
    const ring = Math.hypot(run[0].x - run[run.length - 1].x, run[0].y - run[run.length - 1].y) < 1e-9 ? run.slice(0, -1) : run;
    const edges = ring.map((a, i) => ({ type: "line" as const, a, b: ring[(i + 1) % ring.length] }));
    out.push({ id: `${e.id}:${n++}`, type: "hatch", ...base, lineweight: 0, loops: [{ edges }], paint: { kind: "solid", color: e.color ?? "#000000" }, style: "normal" } as HatchEntity);
  }
  if (layout.text && layout.text.text) {
    const t: TextEntity = {
      id: `${e.id}:${n++}`,
      type: "text",
      ...(e.layer !== undefined ? { layer: e.layer } : {}),
      ...(e.color !== undefined ? { color: e.color } : {}),
      at: layout.text.at,
      text: layout.text.text,
      height: layout.text.height,
      rotation: layout.text.rotation,
      halign: "center",
      valign: "middle",
    };
    out.push(t);
  }
  return out;
}

/** Every dimension in `entities` replaced by its parts (other entities pass through). */
export function explodeDimensions(entities: readonly Entity[], host: DimHost | null = activeDimHost()): Entity[] {
  // D-04: MTEXT has no R12 / SVG / PDF form either, so it explodes through the same call.
  if (!entities.some((e) => e.type === "dimension" || e.type === "mtext")) return entities as Entity[];
  return entities.flatMap((e) => (e.type === "dimension" ? explodeDimension(e, host) : e.type === "mtext" ? explodeMText(e) : [e]));
}

/** The text as stroke-font polylines centred on the text box (for tessellation, so exports without text support still show it). */
export function dimTextStrokes(t: DimText): Point[][] {
  const raw = textToStrokes(t.text, { x: 0, y: 0 }, t.height, 0);
  if (raw.length === 0) return [];
  let minX = Infinity;
  let maxX = -Infinity;
  for (const s of raw) for (const p of s) {
    if (p.x < minX) minX = p.x;
    if (p.x > maxX) maxX = p.x;
  }
  const cx = (minX + maxX) / 2;
  const cos = Math.cos(t.rotation);
  const sin = Math.sin(t.rotation);
  return raw.map((s) =>
    s.map((p) => {
      const x = p.x - cx;
      const y = p.y - t.height / 2;
      return { x: t.at.x + x * cos - y * sin, y: t.at.y + x * sin + y * cos };
    }),
  );
}

/** The four corners of the text box (rotated). */
export function dimTextBox(t: DimText): Point[] {
  const hw = t.width / 2;
  const hh = t.height / 2;
  const cos = Math.cos(t.rotation);
  const sin = Math.sin(t.rotation);
  return [[-hw, -hh], [hw, -hh], [hw, hh], [-hw, hh]].map(([x, y]) => ({ x: t.at.x + x * cos - y * sin, y: t.at.y + x * sin + y * cos }));
}
