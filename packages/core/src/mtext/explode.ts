import type { Entity, HatchEntity, MTextEntity, PolylineEntity, TextEntity } from "../entities";
import { layoutMText } from "./layout";

/**
 * An MTEXT as ordinary entities - one TEXT per drawn run, polylines for
 * underline/overline/strike and fraction bars, and a solid HATCH when there is a
 * background mask. What writers without a real MTEXT record (R12 DXF, SVG, PDF,
 * EPS) use, so every rendering shows what the canvas shows. Ids are `<id>:<n>`.
 */
export function explodeMText(e: MTextEntity): Entity[] {
  const lay = layoutMText(e);
  const base = {
    ...(e.layer !== undefined ? { layer: e.layer } : {}),
    ...(e.color !== undefined ? { color: e.color } : {}),
  };
  const out: Entity[] = [];
  let n = 0;
  if (e.background) {
    const [a, b, c, d] = lay.box;
    const k = ((e.background.scale ?? 1.5) - 1) * e.height;
    const ex = { x: (b.x - a.x) / (Math.hypot(b.x - a.x, b.y - a.y) || 1), y: (b.y - a.y) / (Math.hypot(b.x - a.x, b.y - a.y) || 1) };
    const ey = { x: -ex.y, y: ex.x };
    const grow = (p: { x: number; y: number }, sx: number, sy: number) => ({ x: p.x + ex.x * sx * k + ey.x * sy * k, y: p.y + ex.y * sx * k + ey.y * sy * k });
    const ring = [grow(a, -1, -1), grow(b, 1, -1), grow(c, 1, 1), grow(d, -1, 1)];
    out.push({
      id: `${e.id}:${n++}`,
      type: "hatch",
      ...base,
      lineweight: 0,
      loops: [{ edges: ring.map((p, i) => ({ type: "line" as const, a: p, b: ring[(i + 1) % 4] })) }],
      paint: { kind: "solid", color: e.background.color ?? "#ffffff" },
      style: "normal",
    } as HatchEntity);
  }
  for (const r of lay.runs) {
    const t: TextEntity = {
      id: `${e.id}:${n++}`,
      type: "text",
      ...base,
      ...(r.color && r.color.startsWith("#") ? { color: r.color } : {}),
      at: r.at,
      text: r.text,
      height: r.height,
      rotation: r.rotation,
      ...(e.style ? { style: e.style } : {}),
      ...(r.widthFactor ? { widthFactor: r.widthFactor } : {}),
      ...(r.italic ? { oblique: 15 } : {}),
    };
    out.push(t);
  }
  for (const s of lay.lines) {
    out.push({ id: `${e.id}:${n++}`, type: "polyline", ...base, points: s, closed: false } as PolylineEntity);
  }
  return out;
}

/** Every MTEXT in `entities` replaced by its parts (other entities pass through). */
export function explodeMTexts(entities: readonly Entity[]): Entity[] {
  if (!entities.some((e) => e.type === "mtext")) return entities as Entity[];
  return entities.flatMap((e) => (e.type === "mtext" ? explodeMText(e) : [e]));
}
