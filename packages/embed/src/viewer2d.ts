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
 * (wheel, at the cursor) and fit (double-click).
 */
import { SketchDocument } from "../../core/src/document";
import { withBlocks } from "../../core/src/blocks/context";
import type { Entity } from "../../core/src/entities";
import { drawEntities, entitiesBounds, fitToBounds, screenToWorld, zoomAt, type DrawEnv, type View } from "../../core/src/render2d/index";
import { atRest, spring, stepSpring, type Spring } from "./motion";
import { drawReveal, floatPose, tiltTransform } from "./motion2d";
import type { Drawing2D } from "./parse2d";

export type Motion2D = "float" | "draw" | "none";

export interface Stage2DOptions {
  /** CSS colour, or null for a transparent canvas over the host page. */
  background: string | null;
  /** Default entity colour (theme `canvas.entity`): white on dark, black on light, as ACI 7 is. */
  ink: string;
  reducedMotion: boolean;
  motion: Motion2D;
}

/** Fraction of the canvas kept clear around the fitted drawing. */
const FIT_PADDING = 0.08;
/** Past this many entities "draw" is skipped (redrawing a growing prefix every frame would stutter). */
const DRAW_MAX_ENTITIES = 20_000;

export class Stage2D {
  readonly kind = "2d" as const;
  /** Kept for the element's shared stage interface; 2D has no measure yet. */
  onMeasure: ((m: null) => void) | null = null;

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
  private drag: { x: number; y: number; view: View } | null = null;

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
    canvas.addEventListener("wheel", this.onWheel, { passive: false });
    canvas.addEventListener("dblclick", this.onDblClick);
  }

  /* ------------------------------- stage API ------------------------------- */

  setColors(background: string | null, ink?: string): void {
    this.opts = { ...this.opts, background, ink: ink ?? this.opts.ink };
    this.env = { ...this.env, ink: this.opts.ink, bg: background ?? "#ffffff" };
    this.bitmap = null;
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
    if (!full) this.userView = null;
    this.wake();
  }

  clearSelection(): boolean {
    return false;
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
    this.canvas.removeEventListener("wheel", this.onWheel);
    this.canvas.removeEventListener("dblclick", this.onDblClick);
    this.canvas.style.transform = "";
    this.bitmap = null;
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
    this.fitted = fitToBounds(bb, this.width, this.height, FIT_PADDING * 2);
    this.bitmap = null;
  }

  private image(url: string): CanvasImageSource | null {
    if (this.images.has(url)) return this.images.get(url) ?? null;
    this.images.set(url, null);
    const img = new Image();
    img.onload = () => {
      this.images.set(url, img);
      this.bitmap = null;
      this.wake();
    };
    img.src = url;
    return null;
  }

  /** Draws `entities` in `view` onto `ctx` (already scaled to CSS pixels). */
  private drawInto(ctx: CanvasRenderingContext2D, entities: readonly Entity[], view: View): void {
    withBlocks(this.host, () => drawEntities(ctx, entities, view, { width: this.width, height: this.height, env: this.env }));
  }

  private fittedBitmap(): HTMLCanvasElement {
    if (this.bitmap) return this.bitmap;
    const c = document.createElement("canvas");
    c.width = this.canvas.width;
    c.height = this.canvas.height;
    const g = c.getContext("2d")!;
    g.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    this.drawInto(g, this.entities, this.fitted);
    this.bitmap = c;
    return c;
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
      // Full view: live vectors, crisp at any zoom.
      ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
      this.drawInto(ctx, this.entities, this.currentView());
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
    if (!this.interactive) return;
    const p = this.local(e);
    this.drag = { x: p.x, y: p.y, view: this.currentView() };
    this.canvas.setPointerCapture?.(e.pointerId);
  };

  private onMove = (e: PointerEvent): void => {
    if (!this.drag) return;
    const p = this.local(e);
    const v = this.drag.view;
    this.userView = { scale: v.scale, ox: v.ox + p.x - this.drag.x, oy: v.oy + p.y - this.drag.y };
    this.wake();
  };

  private onUp = (e: PointerEvent): void => {
    if (!this.drag) return;
    this.drag = null;
    this.canvas.releasePointerCapture?.(e.pointerId);
  };

  private onWheel = (e: WheelEvent): void => {
    // Inline previews leave the wheel to the page; only full view zooms.
    if (!this.interactive) return;
    e.preventDefault();
    const factor = Math.exp(-e.deltaY * (e.deltaMode === 1 ? 0.05 : 0.0015));
    this.userView = zoomAt(this.currentView(), this.local(e), factor);
    this.wake();
  };

  private onDblClick = (e: MouseEvent): void => {
    if (!this.interactive) return;
    e.preventDefault();
    this.fit();
  };

  /** World point under a canvas position (for tests and future measure). */
  worldAt(x: number, y: number): { x: number; y: number } {
    return screenToWorld(this.currentView(), { x, y });
  }
}
