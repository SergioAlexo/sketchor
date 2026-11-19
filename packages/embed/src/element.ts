import { CSS } from "./styles";
import {
  DEFAULT_MAX_MB,
  SKETCHOR_SITE,
  fetchBytes,
  fileNameFromSrc,
  resolveFullUrl,
  sniffFormat,
} from "./load";
import type { Stage } from "./viewer";

type ViewerModule = typeof import("./viewer");
let viewerModule: Promise<ViewerModule> | null = null;
/** three.js + parsers, fetched once per page, on the first element that needs them. */
const loadViewer = (): Promise<ViewerModule> => (viewerModule ??= import("./viewer"));

const ICON_PLAY = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5.5v13l10.5-6.5z" fill="currentColor"/></svg>`;
const ICON_PAUSE = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 5h3.6v14H7zM13.4 5H17v14h-3.6z" fill="currentColor"/></svg>`;
const ICON_EXPAND = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" stroke="currentColor" stroke-width="2.2" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
const ICON_CLOSE = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/></svg>`;
const LOGO = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 18L11 5l3.5 6.5L18 6l2 12" stroke="currentColor" stroke-width="2.6" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

const TEMPLATE = `
<style>${CSS}</style>
<div class="stage" part="stage">
  <canvas part="canvas" aria-hidden="true"></canvas>
  <div class="vignette"></div>
  <div class="status" part="status" role="status">
    <div class="spinner"></div>
    <div class="card"><strong class="msg"></strong><span class="detail"></span><a class="btn open-err" target="_blank" rel="noopener">Open in Sketchor ↗</a></div>
  </div>
  <div class="bar" part="full-bar"><span class="name"></span><a class="btn open" part="open-link" target="_blank" rel="noopener">Open in Sketchor ↗</a></div>
  <span class="hint">Drag to orbit · scroll to zoom · right-drag to pan</span>
  <button class="play" part="play-button" type="button" aria-label="Play">${ICON_PLAY}</button>
  <button class="full" part="full-button" type="button" aria-label="Full view">${ICON_EXPAND}</button>
  <a class="logo" part="logo" href="${SKETCHOR_SITE}" target="_blank" rel="noopener" aria-label="Made with Sketchor">${LOGO}Sketchor</a>
</div>`;

type State = "empty" | "loading" | "idle" | "playing" | "paused" | "error";

/**
 * `<sketchor-view src="part.glb" autoplay>` — an animated, orbitable preview
 * of a CAD file, drawn by Sketchor's own 3D renderer.
 *
 * Attributes: `src`, `format`, `autoplay`, `motion` (`turntable` | `none`),
 * `background` (CSS colour or `transparent`), `controls` (`minimal` | `none`),
 * `full-url` (`auto` | `none` | URL), `logo` (`on` | `off`), `up` (`auto` |
 * `y` | `z`), `max-size` (MB), `loading` (`lazy` | `eager`), `label`.
 * Methods: `play()`, `pause()`, `reset()`, `fit()`, `load(src)`.
 * Events: `load`, `error`, `play`, `pause`.
 */
export class SketchorView extends HTMLElement {
  static observedAttributes = ["src", "background", "full-url", "label", "up", "format"];

  private root: ShadowRoot;
  private canvas: HTMLCanvasElement;
  private stage: Stage | null = null;
  private state: State = "empty";
  private loadToken = 0;
  private abort: AbortController | null = null;
  private io: IntersectionObserver | null = null;
  private ro: ResizeObserver | null = null;
  private seen = false;
  private savedOverflow = "";
  private connected = false;
  private reducedMotion = typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

  constructor() {
    super();
    this.root = this.attachShadow({ mode: "open" });
    this.root.innerHTML = TEMPLATE;
    this.canvas = this.root.querySelector("canvas")!;
    this.$(".play").addEventListener("click", (e) => {
      e.stopPropagation();
      this.toggle();
    });
    this.$(".full").addEventListener("click", (e) => {
      e.stopPropagation();
      void this.toggleFull();
    });
    this.addEventListener("keydown", (e) => {
      if (e.target !== this) return;
      if (e.key === " " || e.key === "Enter") {
        e.preventDefault();
        this.toggle();
      } else if (e.key === "f" || e.key === "F") void this.toggleFull();
      else if (e.key === "Escape" && this.hasAttribute("data-full")) void this.toggleFull(false);
    });
    this.addEventListener("pointermove", (e) => {
      const r = this.getBoundingClientRect();
      this.stage?.setPointer({ x: ((e.clientX - r.left) / r.width) * 2 - 1, y: ((e.clientY - r.top) / r.height) * 2 - 1 });
    });
    this.addEventListener("pointerleave", () => this.stage?.setPointer(null));
    document.addEventListener("fullscreenchange", () => {
      if (document.fullscreenElement !== this && this.hasAttribute("data-full") && !this.classList.contains("sk-overlay")) this.exitFull();
    });
    document.addEventListener("visibilitychange", () => this.stage?.setVisible(!document.hidden && this.seen));
  }

  connectedCallback(): void {
    this.connected = true;
    if (!this.hasAttribute("tabindex")) this.tabIndex = 0;
    if (!this.hasAttribute("role")) this.setAttribute("role", "img");
    this.updateLabel();
    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(this);
    this.io = new IntersectionObserver(
      ([e]) => {
        this.seen = e.isIntersecting;
        this.stage?.setVisible(e.isIntersecting && !document.hidden);
        if (e.isIntersecting && this.state === "empty") void this.startLoad();
      },
      { rootMargin: "200px" },
    );
    this.io.observe(this);
    if (this.getAttribute("loading") === "eager") void this.startLoad();
  }

  disconnectedCallback(): void {
    this.connected = false;
    this.io?.disconnect();
    this.ro?.disconnect();
    this.abort?.abort();
    this.stage?.dispose();
    this.stage = null;
    this.setState("empty");
    this.removeAttribute("data-ready");
  }

  attributeChangedCallback(name: string, old: string | null, value: string | null): void {
    if (old === value) return;
    if (name === "label") this.updateLabel();
    if (name === "full-url") this.updateLinks();
    if ((name === "src" || name === "background" || name === "up" || name === "format") && this.connected && this.state !== "empty") void this.startLoad();
  }

  /* ------------------------------- public API ------------------------------- */

  play(): void {
    if (!this.stage || this.state === "playing" || this.getAttribute("motion") === "none") return;
    this.stage.setPlaying(true);
    this.setState("playing");
    this.dispatchEvent(new Event("play"));
  }

  pause(): void {
    if (!this.stage || this.state !== "playing") return;
    this.stage.setPlaying(false);
    this.setState("paused");
    this.dispatchEvent(new Event("pause"));
  }

  reset(): void {
    this.pause();
    this.stage?.reset();
  }

  fit(): void {
    this.stage?.fit();
  }

  /** Loads a different file (URL, Blob or bytes) without touching the `src` attribute. */
  async load(source: string | Blob | ArrayBuffer | Uint8Array, name?: string): Promise<void> {
    await this.startLoad(source, name);
  }

  /* -------------------------------- internals ------------------------------- */

  private $<T extends Element = HTMLElement>(sel: string): T {
    return this.root.querySelector(sel) as T;
  }

  private toggle(): void {
    if (this.state === "playing") this.pause();
    else this.play();
  }

  private setState(s: State): void {
    this.state = s;
    this.setAttribute("data-state", s);
    const playBtn = this.$(".play");
    playBtn.innerHTML = s === "playing" ? ICON_PAUSE : ICON_PLAY;
    playBtn.setAttribute("aria-label", s === "playing" ? "Pause" : "Play");
  }

  private updateLabel(): void {
    const src = this.getAttribute("src");
    const label = this.getAttribute("label") || (src ? `3D model ${fileNameFromSrc(src)}` : "3D model");
    this.setAttribute("aria-label", label);
    this.$(".name").textContent = this.getAttribute("label") || (src ? fileNameFromSrc(src) : "");
  }

  private absoluteSrc(): string | null {
    const src = this.getAttribute("src");
    if (!src) return null;
    try {
      return new URL(src, document.baseURI).href;
    } catch {
      return null;
    }
  }

  private updateLinks(): void {
    const href = resolveFullUrl(this.getAttribute("full-url"), this.absoluteSrc());
    for (const a of this.root.querySelectorAll<HTMLAnchorElement>("a.open, a.open-err")) {
      if (href) {
        a.href = href;
        a.style.display = "";
      } else a.style.display = "none";
    }
  }

  private resize(): void {
    const r = this.getBoundingClientRect();
    this.stage?.resize(r.width, r.height);
  }

  private async startLoad(source?: string | Blob | ArrayBuffer | Uint8Array, nameHint?: string): Promise<void> {
    const token = ++this.loadToken;
    this.abort?.abort();
    this.abort = new AbortController();
    this.updateLinks();
    const src = source ?? this.getAttribute("src");
    if (!src) {
      this.setState("empty");
      return;
    }
    const name = nameHint ?? (typeof src === "string" ? fileNameFromSrc(src) : src instanceof File ? src.name : "model");
    this.setState("loading");
    this.removeAttribute("data-ready");
    try {
      const maxMb = Number(this.getAttribute("max-size")) || DEFAULT_MAX_MB;
      const bytes =
        typeof src === "string"
          ? await fetchBytes(src, maxMb * 1048576, this.abort.signal)
          : src instanceof Blob
            ? new Uint8Array(await src.arrayBuffer())
            : src instanceof Uint8Array
              ? src
              : new Uint8Array(src);
      if (token !== this.loadToken) return;

      const verdict = sniffFormat(name, bytes, this.getAttribute("format"));
      if (verdict.kind === "app-only") throw new EmbedError(`.${verdict.ext.toUpperCase()} files open in Sketchor`, "This preview shows 3D meshes (glTF, GLB, STL, OBJ, PLY, 3MF) for now.");
      if (verdict.kind === "unknown") throw new EmbedError("Unrecognised file type", `${name} isn't a format the preview can read.`);

      const viewer = await loadViewer();
      const upAttr = this.getAttribute("up");
      const up = upAttr === "y" || upAttr === "z" ? upAttr : "auto";
      const model = await viewer.parseModel(bytes, name, verdict.format, up);
      if (token !== this.loadToken || !this.connected) return;

      this.stage?.dispose();
      const bg = this.getAttribute("background");
      this.stage = new viewer.Stage(this.canvas, {
        background: bg === "transparent" ? null : bg || "",
        reducedMotion: this.reducedMotion,
      });
      this.resize();
      this.stage.setModel(model);
      this.stage.setVisible(this.seen && !document.hidden);
      this.stage.renderOnce();
      this.setState("idle");
      this.setAttribute("data-ready", "");
      this.dispatchEvent(new CustomEvent("load", { detail: { name, parts: model.parts.length } }));
      if (this.hasAttribute("autoplay") && !this.reducedMotion) this.play();
    } catch (err) {
      if (token !== this.loadToken || (err as Error)?.name === "AbortError") return;
      const e = err instanceof EmbedError ? err : new EmbedError("Preview unavailable", (err as Error)?.message ?? String(err));
      this.$(".msg").textContent = e.message;
      this.$(".detail").textContent = e.detail;
      this.setState("error");
      this.dispatchEvent(new CustomEvent("error", { detail: { message: `${e.message}: ${e.detail}` } }));
    }
  }

  private async toggleFull(force?: boolean): Promise<void> {
    const entering = force ?? !this.hasAttribute("data-full");
    if (!entering) {
      if (document.fullscreenElement === this) await document.exitFullscreen().catch(() => {});
      this.exitFull();
      return;
    }
    this.setAttribute("data-full", "");
    this.$(".full").innerHTML = ICON_CLOSE;
    this.$(".full").setAttribute("aria-label", "Close full view");
    this.stage?.setInteractive(true);
    try {
      if (!this.requestFullscreen) throw new Error("no fullscreen");
      await this.requestFullscreen();
    } catch {
      // iOS Safari and sandboxed iframes: a fixed overlay does the same job.
      this.classList.add("sk-overlay");
      this.savedOverflow = document.documentElement.style.overflow;
      document.documentElement.style.overflow = "hidden";
    }
    this.focus();
    requestAnimationFrame(() => this.resize());
  }

  private exitFull(): void {
    this.removeAttribute("data-full");
    if (this.classList.contains("sk-overlay")) {
      this.classList.remove("sk-overlay");
      document.documentElement.style.overflow = this.savedOverflow;
    }
    this.$(".full").innerHTML = ICON_EXPAND;
    this.$(".full").setAttribute("aria-label", "Full view");
    this.stage?.setInteractive(false);
    this.stage?.fit();
    requestAnimationFrame(() => this.resize());
  }
}

class EmbedError extends Error {
  constructor(message: string, readonly detail: string) {
    super(message);
  }
}
