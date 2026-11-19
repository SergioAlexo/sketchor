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
Draco/meshopt-compressed glTF isn't supported yet — export uncompressed.

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
| `up` | `auto` (glTF Y-up, others Z-up), `y`, `z` | `auto` |
| `max-size` | download limit in MB | `25` |
| `loading` | `lazy` (when near the viewport), `eager` | `lazy` |
| `label` | accessible name / title in full view | file name |

CSS custom properties on the element: `--sketchor-accent`, `--sketchor-bg`,
`--sketchor-radius`. Parts: `stage`, `canvas`, `play-button`, `full-button`,
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
