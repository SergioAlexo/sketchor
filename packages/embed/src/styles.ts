/** Shadow-DOM styles: the host page's CSS can't reach in and ours can't leak out (E-02). */
export const CSS = `
:host {
  display: block;
  position: relative;
  aspect-ratio: 4 / 3;
  min-height: 120px;
  overflow: hidden;
  border-radius: var(--sketchor-radius, 12px);
  background: var(--sketchor-bg, var(--sk-stage, #17181c));
  color: var(--sk-fg, #e6e8ec);
  font: 500 12px/1.2 system-ui, -apple-system, "Segoe UI", sans-serif;
  contain: content;
  outline: none;
  -webkit-tap-highlight-color: transparent;
}
:host([background="transparent"]) { background: transparent; }
:host(:focus-visible) { box-shadow: 0 0 0 2px var(--sketchor-accent, var(--sk-accent, #5a8dff)); }
:host(.sk-overlay) {
  position: fixed !important;
  inset: 0 !important;
  z-index: 2147483000;
  width: 100vw !important;
  height: 100vh !important;
  aspect-ratio: auto;
  border-radius: 0;
}
:host(:fullscreen) { border-radius: 0; aspect-ratio: auto; }

.stage { position: absolute; inset: 0; }
canvas { display: block; width: 100%; height: 100%; touch-action: pan-y; cursor: grab; }
canvas:active { cursor: grabbing; }
:host([data-full]) canvas { touch-action: none; }
/* A drawing inline is a picture: nothing to drag, and the page keeps every gesture. */
:host([data-kind="2d"]:not([data-full])) canvas { cursor: default; touch-action: auto; }
:host([data-kind="2d"]) canvas { will-change: transform; }

.vignette {
  position: absolute; inset: 0; pointer-events: none;
  background: radial-gradient(ellipse at 50% 45%, transparent 55%, rgba(0,0,0,.28));
  transition: opacity .6s;
}
:host([data-theme="light"]) .vignette {
  background: radial-gradient(ellipse at 50% 45%, transparent 60%, rgba(0,0,0,.08));
}
:host([background="transparent"]) .vignette { display: none; }
:host([data-state="playing"]) .vignette { opacity: .5; }

button, a.btn {
  all: unset;
  box-sizing: border-box;
  cursor: pointer;
  display: grid;
  place-items: center;
  color: var(--sk-fg, #fff);
  background: color-mix(in srgb, var(--sk-chrome, #141519) 62%, transparent);
  border: 1px solid color-mix(in srgb, var(--sk-fg, #fff) 14%, transparent);
  backdrop-filter: blur(8px);
  -webkit-backdrop-filter: blur(8px);
  transition: opacity .25s, transform .25s, background .2s;
}
button:hover, a.btn:hover { background: var(--sketchor-accent, var(--sk-accent, #5a8dff)); border-color: transparent; color: #fff; }
button:focus-visible, a.btn:focus-visible { outline: 2px solid var(--sketchor-accent, var(--sk-accent, #5a8dff)); outline-offset: 2px; }

.play {
  position: absolute; left: 50%; top: 50%;
  width: 56px; height: 56px; margin: -28px 0 0 -28px;
  border-radius: 50%;
  opacity: 0;
}
.play svg { width: 22px; height: 22px; }
:host(:hover) .play, :host(:focus-within) .play, .play:focus-visible { opacity: 1; }
:host([data-state="idle"]) .play, :host([data-state="paused"]) .play { opacity: .92; }
:host([data-state="playing"]:hover) .play { opacity: .55; transform: scale(.82); }
@media (hover: none) { .play { opacity: .9; } :host([data-state="playing"]) .play { opacity: 0; pointer-events: none; } }

.full {
  position: absolute; top: 10px; right: 10px;
  width: 32px; height: 32px; border-radius: 9px;
  opacity: .0;
}
.full svg { width: 15px; height: 15px; }
:host(:hover) .full, :host(:focus-within) .full, .full:focus-visible { opacity: 1; }
@media (hover: none) { .full { opacity: .85; } }

.logo {
  all: unset;
  position: absolute; right: 10px; bottom: 9px;
  display: flex; align-items: center; gap: 5px;
  font-weight: 650; letter-spacing: .01em;
  color: var(--sk-fg, #fff); opacity: .35; cursor: pointer;
  transition: opacity .2s;
  text-shadow: 0 1px 2px color-mix(in srgb, var(--sk-stage, #000) 50%, transparent);
}
.logo svg { width: 13px; height: 13px; }
:host(:hover) .logo { opacity: .6; }
.logo:hover, .logo:focus-visible { opacity: 1; }
:host([logo="off"]) .logo { display: none; }

:host([controls="none"]) .play, :host([controls="none"]) .full { display: none; }

.bar {
  position: absolute; left: 12px; top: 12px; right: 56px;
  display: none; align-items: center; gap: 8px; flex-wrap: wrap;
}
:host([data-full]) .bar { display: flex; }
:host([data-full]) .full { opacity: 1; }
.bar .name { font-weight: 650; font-size: 13px; text-shadow: 0 1px 3px color-mix(in srgb, var(--sk-stage, #000) 70%, transparent); margin-right: 4px; }
.bar a.btn { display: inline-flex; gap: 6px; height: 30px; padding: 0 12px; border-radius: 999px; font-weight: 600; }
.hint { position: absolute; left: 12px; bottom: 10px; right: 120px; opacity: .55; display: none; }

.measure {
  position: absolute; right: 12px; bottom: 34px; max-width: min(360px, calc(100% - 24px));
  display: none; grid-template-columns: auto auto; gap: 4px 14px; align-items: baseline;
  padding: 10px 12px; border-radius: 10px;
  background: color-mix(in srgb, var(--sk-chrome, #141519) 82%, transparent);
  border: 1px solid color-mix(in srgb, var(--sk-fg, #fff) 14%, transparent);
  backdrop-filter: blur(8px); -webkit-backdrop-filter: blur(8px);
  font-variant-numeric: tabular-nums;
}
:host([data-full]) .measure.on { display: grid; }
.measure .k { color: var(--sk-dim, #9a9da6); }
.measure .v { font-weight: 650; text-align: right; white-space: nowrap; }
:host([data-full]) .hint { display: block; }

.status {
  position: absolute; inset: 0;
  display: none; place-items: center; text-align: center; padding: 16px;
}
:host([data-state="loading"]) .status, :host([data-state="error"]) .status { display: grid; }
:host([data-state="loading"]) .play, :host([data-state="error"]) .play,
:host([data-state="loading"]) .full, :host([data-state="error"]) .full { display: none; }
.spinner {
  width: 26px; height: 26px; border-radius: 50%;
  border: 2px solid color-mix(in srgb, var(--sk-fg, #fff) 15%, transparent); border-top-color: var(--sketchor-accent, var(--sk-accent, #5a8dff));
  animation: sk-spin .8s linear infinite;
}
@keyframes sk-spin { to { transform: rotate(360deg); } }
.card { max-width: 320px; display: none; gap: 10px; justify-items: center; line-height: 1.45; color: var(--sk-dim, #c9ced6); }
.card strong { color: var(--sk-fg, #fff); font-size: 13px; }
.card a.btn { display: inline-flex; height: 30px; padding: 0 12px; border-radius: 999px; font-weight: 600; }
:host([data-state="error"]) .card { display: grid; }
:host([data-state="error"]) .spinner { display: none; }

canvas { opacity: 0; transition: opacity .6s ease; }
:host([data-ready]) canvas { opacity: 1; }

@media (prefers-reduced-motion: reduce) {
  canvas, .play, .full, .vignette { transition: none; }
  .spinner { animation-duration: 2.4s; }
}
`;
