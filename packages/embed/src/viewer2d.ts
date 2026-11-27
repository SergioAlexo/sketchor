/**
 * E-01/E-05: the 2D half of `<sketchor-view>` — a DXF/SVG/EPS/PDF drawing
 * drawn by core's shared Canvas 2D renderer (`render2d`, the same code as
 * the app's viewport), with the embed's motion on top. Its own lazy chunk:
 * a page showing only drawings never downloads three.js.
 *
 * The idle look is the fitted drawing. Play eases in a slow "float" drift
 * and a lean toward the pointer; `motion="draw"` first puts the drawing on
 * screen in its own draw order. While floating, the drawing is a bitmap
 * redrawn under a transform each frame, so a big file costs one render, not
 * one per frame. Full view draws the vectors live and adds pan (drag), zoom
 * (wheel, at the cursor), fit (double-click), point-to-point measuring with
 * object snap (click, click) and layer toggles (E-06).
 */
import { SketchDocument } from "../../core/src/document";
import { withBlocks } from "../../core/src/blocks/context";
import type { Entity } from "../../core/src/entities";
import type { Point } from "../../core/src/geometry";
import { drawEntities, entitiesBounds, fitToBounds, screenToWorld, worldToScreen, zoomAt, type DrawEnv, type View } from "../../core/src/render2d/index";
import { buildSnapIndex, FIRST_POINT_PROMPT, measurePoints, nearestSnap, type Snap, type SnapIndex } from "./measure2d";
import { atRest, spring, stepSpring, type Spring } from "./motion";
import { drawReveal, floatPose, tiltTransform } from "./motion2d";
import type { Drawing2D } from "./parse2d";
import type { Measurement } from "./three/measure";

// The element reads the layer list through this chunk, so the entry script stays free of core code.
export { layerList } from "./measure2d";

export type Motion2D = "float" | "draw" | "none";

export interface Stage2DOptions {
  /** CSS colour, or null for a transparent canvas over the host page. */
  background: string | null;
  /** Default entity colour (theme `canvas.entity`): white on dark, black on light, as ACI 7 is. */
  ink: string;
  /** Measure line, picked points and snap markers. */
  accent: string;
  reducedMotion: boolean;
  motion: Motion2D;
  /** E-02 `fit-padding`: margin around the fitted drawing, a fraction of the smaller side (default 0.08). */
  fitPadding?: number;
}

/** Fraction of the canvas kept clear around the fitted drawing. */
const FIT_PADDING = 0.08;
/** Past this many entities "draw" is skipped (redrawing a growing prefix every frame would stutter). */
const DRAW_MAX_ENTITIES = 20_000;
/** A press that moves less than this (CSS px) is a click — a measure pick — rather than a pan. */
const CLICK_SLOP = 4;
/** How close (CSS px) the pointer has to be to a snap point to take it. */
const SNAP_PX = 10;
/** A second click this soon and this close to the first is a double-click (fit), not a second point. */
const DOUBLE_MS = 400;
const DOUBLE_PX = 6;

export class Stage2D {
  readonly kind = "2d" as const;
  /** E-06: the full-view readout changed (null = nothing measured). */
  onMeasure: ((m: Measurement | null) => void) | null = null;

  private ctx: CanvasRenderingContext2D;
  private width = 0;
  private height = 0;
  private dpr = 1;
  private drawing: Drawing2D | null = null;
  private entities: readonly Entity[] = [];
  private host = new SketchDocument();
  private env: DrawEnv;
  private images = new Map<string, HTMLImageElement | null>();

  /** The fitted view, and in full view the user's pan/zoom on top of it. */
  private fitted: View = { scale: 1, ox: 0, oy: 0 };
  private userView: View | null = null;
  /** The fitted drawing as a bitmap at device resolution; null = redraw it. */
  private bitmap: HTMLCanvasElement | null = null;
  /** Full view: the drawing as last rendered, so moving the pointer only repaints the measure overlay. */
  private live: { canvas: HTMLCanvasElement; view: View } | null = null;
  /** Layers the full view has switched off. */
  private hidden: ReadonlySet<string> = new Set();
  /** Built on the first pointer move in full view. */
  private snaps: SnapIndex | null = null;
  /** Measure: no point, the first, or both. */
  private picks: Point[] = [];
  private hover: { world: Point; snap: Snap | null } | null = null;
  private lastClick: { t: number; x: number; y: number; before: Point[] } | null = null;

  private intensity: Spring = spring(0, 36);
  private tiltX: Spring = spring(0, 30);
  private tiltY: Spring = spring(0, 30);
  private playing = false;
  private interactive = false;
  private visible = true;
  private raf = 0;
  private last = 0;
  private clock = 0;
  /** Seconds into "draw", or null when the drawing is shown whole. */
  private drawT: number | null = null;
  private drawn = false;
  private dirty = true;
  private drag: { x: number; y: number; view: View; moved: boolean } | null = null;

  constructor(private canvas: HTMLCanvasElement, private opts: Stage2DOptions) {
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("this browser cannot draw a 2D canvas");
    this.ctx = ctx;
    this.env = {
      ink: opts.ink,
      bg: opts.background ?? "#ffffff",
      textStyle: (name) => this.host.getRecord("textStyles", name),
      image: (url) => this.image(url),
    };
    canvas.addEventListener("pointerdown", this.onDown);
    canvas.addEventListener("pointermove", this.onMove);
    canvas.addEventListener("pointerup", this.onUp);
    canvas.addEventListener("pointercancel", this.onUp);
    canvas.addEventListener("pointerleave", this.onLeave);
    canvas.addEventListener("wheel", this.onWheel, { passive: false });
    canvas.addEventListener("dblclick", this.onDblClick);
  }

  /* ------------------------------- stage API ------------------------------- */

  setColors(background: string | null, ink?: string, accent?: string): void {
    this.opts = { ...this.opts, background, ink: ink ?? this.opts.ink, accent: accent ?? this.opts.accent };
    this.env = { ...this.env, ink: this.opts.ink, bg: background ?? "#ffffff" };
    this.invalidate();
    this.wake();
  }

  /** E-02: a new `fit-padding`; the fitted view moves, a user's pan/zoom in full view is kept. */
  setFitPadding(p: number): void {
    this.opts = { ...this.opts, fitPadding: p };
    this.refit();
    this.wake();
  }

  /** E-06: layers not drawn (and not snapped to). */
  setHiddenLayers(names: Iterable<string>): void {
    this.hidden = new Set(names);
    this.invalidate();
    if (this.hover) this.hover = this.hoverAt(worldToScreen(this.currentView(), this.hover.world));
    this.wake();
  }

  setDrawing(d: Drawing2D): void {
    this.drawing = d;
    this.entities = d.entities;
    // Inserts and texts resolve their blocks / styles by name against a document (B-07, D-01).
    this.host = new SketchDocument();
    for (const s of d.textStyles) this.host._putRecord("textStyles", s);
    for (const b of d.blocks) this.host._putRecord("blocks", b);
    this.drawn = false;
    this.drawT = null;
    this.hidden = new Set();
    this.snaps = null;
    this.picks = [];
    this.hover = null;
    this.fit();
  }

  fit(): void {
    this.userView = null;
    this.refit();
    this.wake();
  }

  reset(): void {
    this.intensity.x = this.intensity.v = 0;
    this.drawT = null;
    this.fit();
  }

  resize(width: number, height: number): void {
    if (width < 2 || height < 2) return;
    this.width = width;
    this.height = height;
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.canvas.width = Math.round(width * this.dpr);
    this.canvas.height = Math.round(height * this.dpr);
    this.refit();
    // Setting the size clears the canvas; paint now, so an off-screen element (no frames running) isn't left blank.
    this.paint();
    this.wake();
  }

  setPlaying(on: boolean): void {
    this.playing = on;
    // As in 3D, reduced motion only stops autoplay (the element) and the pointer lean (setPointer); an explicit play still moves.
    this.intensity.target = on ? 1 : 0;
    // "draw" plays once, the first time the drawing is played.
    if (on && !this.drawn && this.opts.motion === "draw" && this.entities.length <= DRAW_MAX_ENTITIES) this.drawT = 0;
    this.drawn = this.drawn || on;
    this.wake();
  }

  setInteractive(full: boolean): void {
    this.interactive = full;
    this.drag = null;
    this.hover = null;
    if (!full) {
      this.userView = null;
      this.clearSelection();
    }
    this.wake();
  }

  /** Drops the measurement; false when there was none (the element then closes full view on Esc). */
  clearSelection(): boolean {
    if (this.picks.length === 0) return false;
    this.picks = [];
    this.lastClick = null;
    this.onMeasure?.(null);
    this.wake();
    return true;
  }

  /** The measured points, in drawing units (tests read them). */
  measuredPoints(): Point[] {
    return this.picks.map((p) => ({ ...p }));
  }

  /** Pointer position over the element, -1…1 each way; null when it leaves. */
  setPointer(p: { x: number; y: number } | null): void {
    if (this.opts.reducedMotion) return;
    this.tiltX.target = p ? p.x : 0;
    this.tiltY.target = p ? p.y : 0;
    this.wake();
  }

  setVisible(on: boolean): void {
    this.visible = on;
    if (on) this.wake();
  }

  /** A still frame, for the idle look before play. */
  renderOnce(): void {
    this.paint();
  }

  dispose(): void {
    cancelAnimationFrame(this.raf);
    this.raf = 0;
    this.canvas.removeEventListener("pointerdown", this.onDown);
    this.canvas.removeEventListener("pointermove", this.onMove);
    this.canvas.removeEventListener("pointerup", this.onUp);
    this.canvas.removeEventListener("pointercancel", this.onUp);
    this.canvas.removeEventListener("pointerleave", this.onLeave);
    this.canvas.removeEventListener("wheel", this.onWheel);
    this.canvas.removeEventListener("dblclick", this.onDblClick);
    this.canvas.style.transform = "";
    this.invalidate();
    this.snaps = null;
    this.images.clear();
  }

  /** The view the drawing is shown in right now (tests and the demo page read it). */
  currentView(): View {
    return this.userView ?? this.fitted;
  }

  /* -------------------------------- drawing -------------------------------- */

  private refit(): void {
    // Inside the drawing's blocks, or an insert measures as its "missing block" marker.
    const bb = withBlocks(this.host, () => entitiesBounds(this.entities));
    if (!bb || this.width < 2) return;
    this.fitted = fitToBounds(bb, this.width, this.height, (this.opts.fitPadding ?? FIT_PADDING) * 2);
    this.invalidate();
  }

  /** Forget both rendered bitmaps (colours, layers, size or an image changed). */
  private invalidate(): void {
    this.bitmap = null;
    this.live = null;
  }

  private image(url: string): CanvasImageSource | null {
    if (this.images.has(url)) return this.images.get(url) ?? null;
    this.images.set(url, null);
    const img = new Image();
    img.onload = () => {
      this.images.set(url, img);
      this.invalidate();
      this.wake();
    };
    img.src = url;
    return null;
  }

  /** Draws `entities` in `view` onto `ctx` (already scaled to CSS pixels). */
  private drawInto(ctx: CanvasRenderingContext2D, entities: readonly Entity[], view: View): void {
    withBlocks(this.host, () => drawEntities(ctx, entities, view, { width: this.width, height: this.height, env: this.env, hiddenLayers: this.hidden }));
  }

  /** The drawing in `view` on a transparent canvas the size of the stage, at device resolution. */
  private renderBitmap(view: View, reuse?: HTMLCanvasElement): HTMLCanvasElement {
    const c = reuse && reuse.width === this.canvas.width && reuse.height === this.canvas.height ? reuse : document.createElement("canvas");
    c.width = this.canvas.width;
    c.height = this.canvas.height;
    const g = c.getContext("2d")!;
    g.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    this.drawInto(g, this.entities, view);
    return c;
  }

  private fittedBitmap(): HTMLCanvasElement {
    return (this.bitmap ??= this.renderBitmap(this.fitted));
  }

  private liveBitmap(): HTMLCanvasElement {
    const v = this.currentView();
    const l = this.live;
    if (l && l.view.scale === v.scale && l.view.ox === v.ox && l.view.oy === v.oy && l.canvas.width === this.canvas.width && l.canvas.height === this.canvas.height) return l.canvas;
    this.live = { canvas: this.renderBitmap(v, l?.canvas), view: { ...v } };
    return this.live.canvas;
  }

  private clear(): void {
    const ctx = this.ctx;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    if (this.opts.background === null) ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    else {
      ctx.fillStyle = this.opts.background;
      ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
    }
  }

  private paint(): void {
    if (!this.drawing || this.width < 2) return;
    const ctx = this.ctx;
    this.clear();
    if (this.interactive || this.userView) {
      // Full view: the vectors at the current pan/zoom (crisp at any zoom), the measure overlay on top.
      ctx.drawImage(this.liveBitmap(), 0, 0);
      ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
      if (this.interactive) this.drawOverlay(ctx);
      this.canvas.style.transform = "";
      return;
    }
    const k = Math.max(0, this.intensity.x);
    const pose = floatPose(this.clock, k);
    const cx = this.width / 2;
    const cy = this.height / 2;
    // translate(centre + drift) · rotate · scale · translate(-centre), in device pixels.
    const cos = Math.cos(pose.rot) * pose.zoom;
    const sin = Math.sin(pose.rot) * pose.zoom;
    const tx = cx + pose.dx * this.width - (cos * cx - sin * cy);
    const ty = cy + pose.dy * this.height - (sin * cx + cos * cy);
    const d = this.dpr;
    if (this.drawT !== null) {
      const r = drawReveal(this.drawT, this.entities.length);
      ctx.setTransform(cos * d, sin * d, -sin * d, cos * d, tx * d, ty * d);
      this.drawInto(ctx, this.entities.slice(0, r.shown), this.fitted);
      if (r.partial > 0 && r.shown < this.entities.length) {
        ctx.globalAlpha = r.partial;
        this.drawInto(ctx, [this.entities[r.shown]], this.fitted);
        ctx.globalAlpha = 1;
      }
      if (r.done) this.drawT = null;
    } else {
      ctx.setTransform(cos, sin, -sin, cos, tx * d, ty * d);
      ctx.drawImage(this.fittedBitmap(), 0, 0);
    }
    this.canvas.style.transform = k > 1e-3 ? tiltTransform(this.tiltX.x * k, this.tiltY.x * k) : "";
  }

  /** The measure line (rubber band while the second point is pending), picked points and the snap marker under the pointer. */
  private drawOverlay(ctx: CanvasRenderingContext2D): void {
    const v = this.currentView();
    const S = (p: Point) => worldToScreen(v, p);
    const hoverPt = this.hover ? (this.hover.snap?.point ?? this.hover.world) : null;
    const a = this.picks[0];
    const b = this.picks[1] ?? (a ? hoverPt : null);
    ctx.save();
    ctx.strokeStyle = ctx.fillStyle = this.opts.accent;
    ctx.lineWidth = 1.5;
    ctx.lineCap = "round";
    if (a && b) {
      const sa = S(a);
      const sb = S(b);
      ctx.setLineDash(this.picks.length < 2 ? [6, 4] : []);
      ctx.beginPath();
      ctx.moveTo(sa.x, sa.y);
      ctx.lineTo(sb.x, sb.y);
      ctx.stroke();
      ctx.setLineDash([]);
    }
    for (const p of this.picks) {
      const s = S(p);
      ctx.beginPath();
      ctx.arc(s.x, s.y, 3.5, 0, Math.PI * 2);
      ctx.fill();
    }
    const snap = this.hover?.snap;
    if (snap) {
      const s = S(snap.point);
      const r = 6;
      ctx.lineWidth = 1.75;
      ctx.beginPath();
      // The app's object-snap glyphs: square end, triangle mid, circle centre, diamond quadrant, cross node.
      if (snap.kind === "endpoint") ctx.rect(s.x - r, s.y - r, r * 2, r * 2);
      else if (snap.kind === "midpoint") {
        ctx.moveTo(s.x, s.y - r);
        ctx.lineTo(s.x + r, s.y + r * 0.8);
        ctx.lineTo(s.x - r, s.y + r * 0.8);
        ctx.closePath();
      } else if (snap.kind === "center") ctx.arc(s.x, s.y, r, 0, Math.PI * 2);
      else if (snap.kind === "quadrant") {
        ctx.moveTo(s.x, s.y - r);
        ctx.lineTo(s.x + r, s.y);
        ctx.lineTo(s.x, s.y + r);
        ctx.lineTo(s.x - r, s.y);
        ctx.closePath();
      } else {
        ctx.moveTo(s.x - r, s.y - r);
        ctx.lineTo(s.x + r, s.y + r);
        ctx.moveTo(s.x + r, s.y - r);
        ctx.lineTo(s.x - r, s.y + r);
      }
      ctx.stroke();
    }
    ctx.restore();
  }

  /** What the pointer at canvas position `p` would pick: the nearest visible snap point within reach, else the bare point. */
  private hoverAt(p: Point): { world: Point; snap: Snap | null } {
    const v = this.currentView();
    this.snaps ??= withBlocks(this.host, () => buildSnapIndex(this.entities));
    return { world: screenToWorld(v, p), snap: nearestSnap(this.snaps, screenToWorld(v, p), SNAP_PX / v.scale, this.hidden) };
  }

  private emitMeasure(): void {
    const [a, b] = this.picks;
    const hoverPt = this.hover ? (this.hover.snap?.point ?? this.hover.world) : null;
    if (!a) this.onMeasure?.(null);
    else if (b) this.onMeasure?.(measurePoints(a, b));
    else this.onMeasure?.(hoverPt ? measurePoints(a, hoverPt) : FIRST_POINT_PROMPT);
  }

  /** A click in full view: the first point, the second, or (after two) a new first. */
  private pick(p: Point): void {
    const now = performance.now();
    const lc = this.lastClick;
    if (lc && now - lc.t < DOUBLE_MS && Math.hypot(p.x - lc.x, p.y - lc.y) < DOUBLE_PX) {
      // The second click of a double-click (which fits): take back the first click's point instead of measuring nothing.
      this.picks = lc.before;
      this.lastClick = null;
    } else {
      const h = this.hoverAt(p);
      const pt = h.snap?.point ?? h.world;
      this.lastClick = { t: now, x: p.x, y: p.y, before: this.picks };
      this.picks = this.picks.length === 1 ? [this.picks[0], pt] : [pt];
      this.hover = h;
    }
    this.emitMeasure();
    this.wake();
  }

  /* --------------------------------- loop ---------------------------------- */

  private wake(): void {
    this.dirty = true;
    if (this.raf || !this.visible) return;
    this.last = performance.now();
    this.raf = requestAnimationFrame((t) => this.frame(t));
  }

  private frame(now: number): void {
    this.raf = 0;
    const dt = Math.min((now - this.last) / 1000, 0.1);
    this.last = now;
    stepSpring(this.intensity, dt);
    stepSpring(this.tiltX, dt);
    stepSpring(this.tiltY, dt);
    const k = Math.max(0, this.intensity.x);
    // The drift's clock only runs while there is drift, so pausing glides to rest and play resumes from there.
    this.clock += dt * Math.min(1, k * 4);
    if (this.drawT !== null) this.drawT += dt;
    this.paint();
    this.dirty = false;
    const moving = !this.interactive && (k > 1e-3 || !atRest(this.intensity) || this.drawT !== null || !atRest(this.tiltX) || !atRest(this.tiltY));
    if (this.visible && (moving || this.dirty)) this.raf = requestAnimationFrame((t) => this.frame(t));
  }

  /* ------------------------------ interaction ------------------------------ */

  private local(e: { clientX: number; clientY: number }): { x: number; y: number } {
    const r = this.canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  private onDown = (e: PointerEvent): void => {
    if (!this.interactive || e.button > 0) return;
    const p = this.local(e);
    this.drag = { x: p.x, y: p.y, view: this.currentView(), moved: false };
    try {
      this.canvas.setPointerCapture(e.pointerId);
    } catch {
      /* a synthetic or already-gone pointer: panning still works without capture */
    }
  };

  private onMove = (e: PointerEvent): void => {
    if (!this.interactive) return;
    const p = this.local(e);
    const d = this.drag;
    if (d && (d.moved || Math.hypot(p.x - d.x, p.y - d.y) > CLICK_SLOP)) {
      d.moved = true;
      this.hover = null;
      this.userView = { scale: d.view.scale, ox: d.view.ox + p.x - d.x, oy: d.view.oy + p.y - d.y };
    } else if (!d && e.pointerType !== "touch") {
      this.hover = this.hoverAt(p);
      if (this.picks.length === 1) this.emitMeasure();
    } else return;
    this.wake();
  };

  private onUp = (e: PointerEvent): void => {
    const d = this.drag;
    if (!d) return;
    this.drag = null;
    if (this.canvas.hasPointerCapture?.(e.pointerId)) this.canvas.releasePointerCapture(e.pointerId);
    if (!d.moved && e.type === "pointerup") this.pick(this.local(e));
  };

  private onLeave = (): void => {
    if (!this.hover || this.drag) return;
    this.hover = null;
    if (this.picks.length === 1) this.emitMeasure();
    this.wake();
  };

  private onWheel = (e: WheelEvent): void => {
    // Inline previews leave the wheel to the page; only full view zooms.
    if (!this.interactive) return;
    e.preventDefault();
    const factor = Math.exp(-e.deltaY * (e.deltaMode === 1 ? 0.05 : 0.0015));
    const p = this.local(e);
    this.userView = zoomAt(this.currentView(), p, factor);
    if (this.hover) {
      this.hover = this.hoverAt(p);
      if (this.picks.length === 1) this.emitMeasure();
    }
    this.wake();
  };

  private onDblClick = (e: MouseEvent): void => {
    if (!this.interactive) return;
    e.preventDefault();
    this.fit();
  };

  /** World point under a canvas position (tests read it). */
  worldAt(x: number, y: number): { x: number; y: number } {
    return screenToWorld(this.currentView(), { x, y });
  }
}
