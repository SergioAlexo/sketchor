import type { Entity } from "../entities";
import { entityPoints, polylineSegments, textWidth } from "../entities";
import { bulgeToArc } from "../geometry";
import { kindTessellate } from "../kinds/registry";
import { insertContents } from "../kinds/insert";
import { builtinLinetype, effectiveLtscale, screenDashPattern } from "../linetypes";
import { layoutMText } from "../mtext/layout";
import { layoutOf } from "../dimensions/resolve";
import type { TableRecord } from "../tables";
import { canvasFontFamily, resolveTextLook } from "../textStyle";
import { GREEK_TEXT_PX } from "./cull";
import { drawHatchEntity } from "./hatch";
import { worldToScreen, type View } from "./view";

/**
 * E-01: Canvas 2D drawing of one entity, shared by the app's viewport, the
 * embed (`<sketchor-view>` 2D) and anything else that draws a drawing. Pure
 * apart from the canvas: everything the app used to read from its own
 * module state (theme colours, the document's text styles, decoded images)
 * comes in through {@link DrawEnv}.
 */
export interface DrawEnv {
  /** The default entity colour (theme `canvas.entity`). An insert part keeps its own colour only while the insert is drawn in this one. */
  ink: string;
  /** The canvas background (theme `canvas.bg`), behind MTEXT with a background mask. */
  bg: string;
  /** D-01: a text style by name (the document's `textStyles` table). */
  textStyle?: (name: string) => TableRecord | undefined;
  /** A decoded bitmap for an image entity, or null while it isn't ready (a dashed frame is drawn instead). */
  image?: (dataUrl: string) => CanvasImageSource | null;
}

/** Traces `pts` (world) into the current path, screen-mapped. */
function tracePath(ctx: CanvasRenderingContext2D, view: View, pts: readonly { x: number; y: number }[], close = false): void {
  pts.forEach((pt, i) => {
    const s = worldToScreen(view, pt);
    if (i === 0) ctx.moveTo(s.x, s.y);
    else ctx.lineTo(s.x, s.y);
  });
  if (close) ctx.closePath();
}

/**
 * Draws `entity` in `color`. `linetypeName` is BYLAYER-resolved by a caller
 * that has a document to resolve against; transient, document-less entities
 * (tool and grip previews) fall back to the entity's own linetype.
 */
export function drawEntity(
  ctx: CanvasRenderingContext2D,
  view: View,
  entity: Entity,
  color: string,
  lineWidth: number,
  env: DrawEnv,
  linetypeName: string | undefined = entity.linetype,
  ltscale = 1,
): void {
  ctx.strokeStyle = color;
  ctx.lineWidth = lineWidth;

  if (entity.type === "insert") {
    // B-01: draw what the block stands for; a sub-entity keeps its own colour unless the instance is highlighted.
    const plain = color === (entity.color ?? env.ink);
    for (const part of insertContents(entity)) {
      if (part.fill) drawFillHatch(ctx, view, part, part.fill);
      drawEntity(ctx, view, part, plain ? (part.color ?? color) : color, lineWidth, env, part.linetype ?? linetypeName, ltscale);
    }
    return;
  }

  if (entity.type === "hatch") {
    drawHatchEntity(ctx, view, entity, color, lineWidth);
    return;
  }

  if (entity.type === "text") {
    const p = worldToScreen(view, entity.at);
    const px = entity.height * view.scale;
    if (px < GREEK_TEXT_PX) {
      // Greeked: a faint stroke where the string sits, so a zoomed-out sheet keeps its texture without drawing glyphs nobody can read.
      const w = textWidth(entity.text, entity.height) * view.scale;
      const x0 = entity.halign === "center" ? -w / 2 : entity.halign === "right" ? -w : 0;
      const yMid = entity.valign === "top" ? px / 2 : entity.valign === "middle" ? 0 : -px / 2;
      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.rotate(-entity.rotation);
      ctx.globalAlpha *= 0.6;
      ctx.strokeStyle = color;
      ctx.lineWidth = Math.max(0.5, px * 0.6);
      ctx.beginPath();
      ctx.moveTo(x0, yMid);
      ctx.lineTo(x0 + w, yMid);
      ctx.stroke();
      ctx.restore();
      return;
    }
    ctx.save();
    ctx.translate(p.x, p.y);
    ctx.rotate(-entity.rotation); // world CCW → screen CW
    ctx.fillStyle = color;
    // D-01: the named style's font/shape, with the entity's own overrides on top.
    const look = resolveTextLook(entity, env.textStyle);
    ctx.textBaseline = entity.valign === "middle" ? "middle" : entity.valign === "top" ? "top" : entity.valign === "bottom" ? "bottom" : "alphabetic";
    ctx.textAlign = entity.halign ?? "left";
    ctx.font = `${Math.max(1, entity.height * view.scale)}px ${canvasFontFamily(look.font)}`;
    if (look.oblique) ctx.transform(1, 0, -Math.tan((look.oblique * Math.PI) / 180), 1, 0, 0);
    if (look.widthFactor !== 1 || look.backwards || look.upsideDown) {
      ctx.scale(look.widthFactor * (look.backwards ? -1 : 1), look.upsideDown ? -1 : 1);
    }
    ctx.fillText(entity.text, 0, 0);
    ctx.restore();
    return;
  }

  if (entity.type === "mtext") {
    // D-04: the same layout the exporters use (core mtext/layout.ts) - runs at baseline positions, rules as segments.
    const lay = layoutMText(entity);
    if (entity.background) {
      ctx.fillStyle = entity.background.color ?? env.bg;
      ctx.beginPath();
      tracePath(ctx, view, lay.box, true);
      ctx.fill();
    }
    const look = resolveTextLook({ style: entity.style } as never, env.textStyle);
    ctx.textBaseline = "alphabetic";
    ctx.textAlign = "left";
    for (const r of lay.runs) {
      const p = worldToScreen(view, r.at);
      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.rotate(-r.rotation);
      ctx.fillStyle = r.color && r.color.startsWith("#") ? r.color : color;
      const family = r.font && !/^sketchor/i.test(r.font) ? `"${r.font}", ${canvasFontFamily(look.font)}` : canvasFontFamily(look.font);
      ctx.font = `${r.italic ? "italic " : ""}${r.bold ? "bold " : ""}${Math.max(1, r.height * view.scale)}px ${family}`;
      const wf = (r.widthFactor ?? 1) * look.widthFactor;
      if (wf !== 1) ctx.scale(wf, 1);
      ctx.fillText(r.text, 0, 0);
      ctx.restore();
    }
    ctx.strokeStyle = color;
    ctx.lineWidth = Math.max(1, entity.height * view.scale * 0.06);
    ctx.setLineDash([]);
    for (const seg of lay.lines) {
      ctx.beginPath();
      tracePath(ctx, view, seg);
      ctx.stroke();
    }
    return;
  }

  if (entity.type === "dimension") {
    // D-02a: the same layout the exporters use (core dimensions/layout.ts) — strokes, filled arrow heads, centred text.
    const layout = layoutOf(entity);
    ctx.strokeStyle = color;
    ctx.fillStyle = color;
    ctx.lineWidth = lineWidth;
    ctx.setLineDash([]);
    for (const run of layout.lines) {
      ctx.beginPath();
      tracePath(ctx, view, run);
      ctx.stroke();
    }
    for (const poly of layout.fills) {
      ctx.beginPath();
      tracePath(ctx, view, poly, true);
      ctx.fill();
    }
    if (layout.text && layout.text.text) {
      const p = worldToScreen(view, layout.text.at);
      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.rotate(-layout.text.rotation);
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.font = `${Math.max(1, layout.text.height * view.scale)}px ui-sans-serif, system-ui, sans-serif`;
      ctx.fillText(layout.text.text, 0, 0);
      ctx.restore();
    }
    return;
  }

  if (entity.type === "image") {
    const p = worldToScreen(view, entity.insert);
    const w = entity.width * view.scale;
    const h = entity.height * view.scale;
    ctx.save();
    ctx.translate(p.x, p.y);
    ctx.rotate(-entity.rotation); // world CCW → screen CW
    const img = env.image?.(entity.dataUrl) ?? null;
    if (img) {
      // `insert` is the bottom-left corner; canvas Y grows down, so the image
      // spans upward (negative local y) from the origin.
      ctx.drawImage(img, 0, -h, w, h);
    } else {
      ctx.strokeStyle = color;
      ctx.setLineDash([4, 3]);
      ctx.strokeRect(0, -h, w, h);
      ctx.setLineDash([]);
    }
    ctx.restore();
    return;
  }

  // Infinite construction lines always draw dashed, regardless of linetype — they're a drawing aid, not real geometry.
  ctx.setLineDash(
    entity.type === "line" && entity.infinite ? [6, 4] : screenDashPattern(builtinLinetype(linetypeName).pattern, effectiveLtscale(ltscale, entity), view.scale),
  );
  ctx.beginPath();
  if (entity.type === "line") {
    let a = worldToScreen(view, entity.a);
    let b = worldToScreen(view, entity.b);
    if (entity.infinite) {
      // Extend far past any screen the canvas could be; the browser clips the rest.
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const l = Math.hypot(dx, dy) || 1;
      const reach = 1e5;
      const ux = (dx / l) * reach;
      const uy = (dy / l) * reach;
      a = { x: a.x - ux, y: a.y - uy };
      b = { x: b.x + ux, y: b.y + uy };
    }
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
  } else if (entity.type === "circle") {
    const c = worldToScreen(view, entity.center);
    ctx.arc(c.x, c.y, entity.radius * view.scale, 0, Math.PI * 2);
  } else if (entity.type === "point") {
    // Fixed screen size regardless of zoom, like a CAD PDMODE marker.
    const p = worldToScreen(view, entity.p);
    ctx.moveTo(p.x - 5, p.y);
    ctx.lineTo(p.x + 5, p.y);
    ctx.moveTo(p.x, p.y - 5);
    ctx.lineTo(p.x, p.y + 5);
  } else if (entity.type === "arc") {
    // World angles increase CCW in a Y-up plane; screen Y is flipped, so
    // angles negate and the sweep direction flips (canvas's own
    // "counterclockwise" flag already matches our ccw once negated).
    const c = worldToScreen(view, entity.center);
    ctx.arc(c.x, c.y, entity.radius * view.scale, -entity.startAngle, -entity.endAngle, entity.ccw);
  } else if (entity.type !== "polyline") {
    // A kind outside the built-in seven (kinds/registry.ts): its tessellation to ~half a pixel.
    for (const run of kindTessellate(entity, 0.5 / view.scale)) tracePath(ctx, view, run);
  } else {
    // One continuous stroke through every vertex; a bulged segment draws as
    // its real arc rather than the straight chord.
    polylineSegments(entity).forEach((seg, i) => {
      const a = worldToScreen(view, seg.a);
      if (i === 0) ctx.moveTo(a.x, a.y);
      const bulgeArc = bulgeToArc(seg.a, seg.b, seg.bulge);
      if (!bulgeArc) {
        const b = worldToScreen(view, seg.b);
        ctx.lineTo(b.x, b.y);
        return;
      }
      const c = worldToScreen(view, bulgeArc.center);
      ctx.arc(c.x, c.y, bulgeArc.radius * view.scale, -bulgeArc.startAngle, -bulgeArc.endAngle, bulgeArc.ccw);
    });
    if (entity.closed) ctx.closePath();
  }
  ctx.stroke();
  ctx.setLineDash([]);
}

/**
 * An entity's `fill`: a closed shape (a `closed` polyline or a circle)
 * shaded with a 45° line hatch in `fill`. Clips to the shape and strokes
 * parallel diagonals across its screen bounding box — cheap,
 * resolution-independent, and reads as a fill without hiding the geometry
 * underneath. Anything else is left alone.
 */
export function drawFillHatch(ctx: CanvasRenderingContext2D, view: View, entity: Entity, fill: string): void {
  ctx.save();
  ctx.beginPath();
  if (entity.type === "circle") {
    const c = worldToScreen(view, entity.center);
    ctx.arc(c.x, c.y, entity.radius * view.scale, 0, Math.PI * 2);
  } else if (entity.type === "polyline" && entity.closed && entity.points.length >= 3) {
    tracePath(ctx, view, entity.points, true);
  } else {
    ctx.restore();
    return;
  }
  ctx.clip();

  const pts = entityPoints(entity).map((p) => worldToScreen(view, p));
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of pts) {
    minX = Math.min(minX, p.x);
    minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, p.x);
    maxY = Math.max(maxY, p.y);
  }
  const span = maxX - minX + (maxY - minY);
  const gap = 7;
  ctx.strokeStyle = fill;
  ctx.globalAlpha = 0.32;
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let d = -span; d <= span; d += gap) {
    ctx.moveTo(minX + d, minY);
    ctx.lineTo(minX + d + (maxY - minY), maxY);
  }
  ctx.stroke();
  ctx.restore();
}
