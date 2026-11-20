# @sketchor/embed

`<sketchor-view>` — a drop-in, animated preview of a CAD file, drawn by
Sketchor's own 3D renderer (the same one a Sketchor model tab uses).

```html
<script type="module" src="/sketchor-embed/sketchor-embed.js"></script>

<sketchor-view src="/models/bracket.glb" autoplay></sketchor-view>
```

The element is sized by the page (`aspect-ratio: 4/3` by default — set
`width`/`height` or CSS). Before it scrolls into view it costs ~6 kB; three.js
and the parsers are a lazy chunk fetched when the first preview loads.

**Formats today:** glTF/GLB, STL, OBJ, PLY, 3MF. STEP/IGES, DXF, SVG and other
2D formats show a card that opens the file in Sketchor instead (roadmap E-01).
Draco-compressed glTF works; meshopt-compressed glTF isn't supported yet.

## Auto-upgrade (no new markup)

Add `data-auto` to the script tag and mark existing links or images:

```html
<script type="module" src="/sketchor-embed/sketchor-embed.js" data-auto></script>

<a href="/files/bracket.glb" data-sketchor>Bracket</a>
<img src="/img/bracket.png" data-sketchor-src="/files/bracket.glb" alt="Bracket">
```

Each becomes a `<sketchor-view>` for the same file, labelled by the link text
or `alt`, keeping `id`/`class`/`style`/`width`/`height`. Any attribute below
passes through as `data-sketchor-<name>` (`data-sketchor-motion="none"`,
`data-sketchor-autoplay`). Links to files with no recognisable extension are
left alone unless `data-sketchor-format` names one. Content added later is
upgraded too. `<html data-sketchor-auto>` also switches it on, and
`upgrade(root)` is exported for doing it by hand.

## Attributes

| Attribute | Values | Default |
| --- | --- | --- |
| `src` | URL of the file (cross-origin hosts must send CORS headers) | — |
| `format` | force a format (`glb`, `stl`, …) instead of sniffing | sniffed |
| `autoplay` | start the turntable when loaded (ignored under reduced motion) | off |
| `motion` | `turntable`, `none` | `turntable` |
| `background` | any CSS colour, or `transparent` | Sketchor stage grey |
| `controls` | `minimal` (play + full view), `none` | `minimal` |
| `full-url` | `auto` (Sketchor web app `?open=`), `none`, or a URL | `auto` |
| `logo` | `on`, `off` | `on` |
| `theme` | `auto` (page `color-scheme`, else the visitor's preference), `dark`, `light`, a built-in theme id (`blueprint`, `nord`, `paper`, `solarized-light`, …) or the URL of a `.sketchor-theme.json` | `auto` |
| `up` | `auto` (glTF Y-up, others Z-up), `y`, `z` | `auto` |
| `max-size` | download limit in MB | `25` |
| `loading` | `lazy` (when near the viewport), `eager` | `lazy` |
| `label` | accessible name / title in full view | file name |

CSS custom properties on the element: `--sketchor-accent`, `--sketchor-bg`,
`--sketchor-radius` — they always win over `theme`. A theme file is validated
(colour values only, 64 kB max) and must be served with CORS when it's on
another host; one that fails falls back to `auto` with a console warning. Parts: `stage`, `canvas`, `play-button`, `full-button`,
`logo`, `full-bar`, `open-link`, `status`.

## API

```js
const el = document.querySelector("sketchor-view");
el.play(); el.pause(); el.reset(); el.fit();
await el.load(fileOrBlobOrUrl, "name.stl");
el.addEventListener("load", (e) => console.log(e.detail.parts));
el.addEventListener("error", (e) => console.warn(e.detail.message));
```

Keyboard (element focused): Space/Enter play/pause, `F` full view, Esc closes it.
Drag orbits; in full view the wheel zooms and right-drag pans.

## Build / develop

```bash
npm run build --workspace @sketchor/embed   # -> packages/embed/dist (self-host the whole folder)
npm run dev --workspace @sketchor/embed     # demo page: ?src=<url> or drop files
```

MIT licensed.
