# @sketchor/embed

`<sketchor-view>` — a drop-in, animated preview of a CAD file, drawn by
Sketchor's own renderers: the 3D renderer a Sketchor model tab uses, and the
Canvas 2D renderer of the drawing canvas (core `render2d`).

```html
<script type="module" src="/sketchor-embed/sketchor-embed.js"></script>

<sketchor-view src="/models/bracket.glb" autoplay></sketchor-view>
<sketchor-view src="/drawings/flange.dxf" motion="draw" autoplay></sketchor-view>
```

The element is sized by the page (`aspect-ratio: 4/3` by default — set
`width`/`height` or CSS). Before it scrolls into view it costs ~12 kB; the
renderer and parsers are lazy chunks fetched when the first preview loads —
three.js only for 3D, and each 2D importer only for its own format (a DXF page
downloads ~95 kB in all, never three.js).

**Formats today:**

- 3D: glTF/GLB, STL, OBJ, PLY, 3MF. Draco-compressed glTF works;
  meshopt-compressed glTF isn't supported yet.
- 2D: DXF (ASCII and binary, with blocks, hatches, dimensions, text and
  linetypes), SVG, EPS, Illustrator (`.ai`, PostScript or PDF-based) and PDF
  (first page). Lines take the theme's ink — white on dark, black on light —
  unless the file gives them a colour. Paper-space layouts aren't shown yet
  (model space only).
- STEP/IGES, BREP, 3DM and DWG show a card that opens the file in Sketchor.

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

## No scripts allowed? iframe and oEmbed

```html
<iframe src="https://sketchor.sergioalexo.com/embed?src=https://your.site/bracket.glb&theme=light"
        width="640" height="480" style="border:0" allow="fullscreen" allowfullscreen></iframe>
```

Query parameters are the attributes below. Pasting a model URL (or an
`/embed?src=` link) into Notion, WordPress or Discourse works through
`https://sketchor.sergioalexo.com/oembed?url=…`. The file must be served with
CORS, since the frame fetches it from the Sketchor site's origin.

## Attributes

| Attribute | Values | Default |
| --- | --- | --- |
| `src` | URL of the file (cross-origin hosts must send CORS headers) | — |
| `format` | force a format (`glb`, `stl`, …) instead of sniffing | sniffed |
| `autoplay` | start moving when loaded (ignored under reduced motion) | off |
| `motion` | 3D: `turntable`, `none`. 2D: `float` (slow drift + lean toward the pointer), `draw` (draws itself in, then floats), `none`; `turntable` floats | `turntable` / `float` |
| `background` | any CSS colour, or `transparent` | Sketchor stage grey |
| `controls` | `minimal` (play + full view), `none` | `minimal` |
| `full-url` | `auto` (Sketchor web app `?open=`), `none`, or a URL | `auto` |
| `logo` | `on`, `off` | `on` |
| `theme` | `auto` (page `color-scheme`, else the visitor's preference), `dark`, `light`, a built-in theme id (`blueprint`, `nord`, `paper`, `solarized-light`, …) or the URL of a `.sketchor-theme.json` | `auto` |
| `up` | `auto` (glTF Y-up, others Z-up), `y`, `z` | `auto` |
| `max-size` | download limit in MB | `25` |
| `loading` | `lazy` (when near the viewport), `eager` | `lazy` |
| `label` | accessible name / title in full view | file name |
| `cache` | `on` (parsed models kept in IndexedDB, keyed by file content), `off` | `on` |

CSS custom properties on the element: `--sketchor-accent`, `--sketchor-bg`,
`--sketchor-radius` — they always win over `theme`. A theme file is validated
(colour values only, 64 kB max) and must be served with CORS when it's on
another host; one that fails falls back to `auto` with a console warning. Parts: `stage`, `canvas`, `play-button`, `full-button`,
`logo`, `full-bar`, `open-link`, `status`, `measure`.

## API

```js
const el = document.querySelector("sketchor-view");
el.play(); el.pause(); el.reset(); el.fit();
await el.load(fileOrBlobOrUrl, "name.stl");
el.addEventListener("load", (e) => console.log(e.detail.parts));
el.addEventListener("error", (e) => console.warn(e.detail.message));
```

Keyboard (element focused): Space/Enter play/pause, `F` full view, Esc closes it.
Drag orbits; in full view the wheel zooms, right-drag pans, and a click measures:
a face gives its area, an edge its length or diameter, a vertex its position;
Shift-click a second for the distance and angle between them (mm). Esc clears
the measurement, then closes full view.

## Versions and hosting

- `https://sketchor.sergioalexo.com/embed/sketchor-embed.js` — always the latest build.
- `https://sketchor.sergioalexo.com/embed/v/<version>/sketchor-embed.js` — a pinned
  build that never changes (cached as immutable); `/embed/version.json` names the
  current version.
- npm: `@sketchor/embed` (ES module + `types/sketchor-embed.d.ts`; three.js is
  bundled, so there are no runtime dependencies). Publishing to npm is pending.
- Self-host: copy `dist/` anywhere; chunks load relative to the script.

The attribute API is the semver contract. `src/publicTypes.check.ts` fails the
build if the code stops matching the published declarations.

## Build / develop

```bash
npm run build --workspace @sketchor/embed   # -> packages/embed/dist (self-host the whole folder)
npm run dev --workspace @sketchor/embed     # demo page: ?src=<url> or drop files
# then /smoke.html (self-checking: every mesh format, play/pause, themes, error
# cards, cache, auto-upgrade), /themes.html and /auto.html
```

MIT licensed.
