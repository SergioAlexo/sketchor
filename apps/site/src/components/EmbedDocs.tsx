import EmbedConfigurator from "@/components/EmbedConfigurator";
import SiteHeader from "@/components/SiteHeader";
import { SITE } from "@/lib/embedFrame";
import { SCRIPT_URL } from "@/lib/embedSnippet";

const ATTRS: [string, string, string][] = [
  ["src", "URL of the file. Other hosts must send CORS headers.", "—"],
  ["autoplay", "Start moving once loaded (not under reduced motion).", "off"],
  ["motion", "3D: turntable · none. Drawings: float · draw (draws itself in, then floats) · none", "turntable / float"],
  ["theme", "auto (the page's color-scheme, else the visitor's) · dark · light · a built-in theme · a .sketchor-theme.json URL", "auto"],
  ["background", "Any CSS colour, or transparent.", "theme"],
  ["controls", "minimal (play + full view) · none", "minimal"],
  ["full-url", "auto (opens the file in the Sketchor web app) · none · a URL", "auto"],
  ["logo", "on · off", "on"],
  ["up", "auto (glTF Y-up, others Z-up) · y · z", "auto"],
  ["max-size", "Download limit in MB.", "25"],
  ["loading", "lazy (near the viewport) · eager", "lazy"],
  ["label", "Accessible name and full-view title.", "file name"],
  ["format", "Force a format (glb, stl, …) instead of sniffing.", "sniffed"],
];

const ELEMENT_SNIPPET = `<script type="module" src="${SCRIPT_URL}"></script>

<sketchor-view src="/parts/bracket.glb" autoplay style="width:100%"></sketchor-view>`;

const AUTO_SNIPPET = `<script type="module" src="${SCRIPT_URL}" data-auto></script>

<a href="/parts/bracket.glb" data-sketchor data-sketchor-theme="light">Bracket</a>
<img src="/img/arm.png" data-sketchor-src="/parts/arm.3mf" alt="Robot arm">`;

const IFRAME_SNIPPET = `<iframe src="${SITE}/embed?src=https%3A%2F%2Fyour.site%2Fbracket.glb&theme=light"
  width="640" height="480" style="border:0" allow="fullscreen" allowfullscreen></iframe>`;

const JS_SNIPPET = `const el = document.querySelector("sketchor-view");
el.play(); el.pause(); el.reset(); el.fit();
await el.load(fileOrBlobOrUrl, "part.stl");
el.addEventListener("load", (e) => console.log(e.detail.parts));
el.addEventListener("error", (e) => console.warn(e.detail.message));`;

/** E-09: `/embed` — what the embed is, a live configurator, and the reference. */
export default function EmbedDocs() {
  return (
    <>
      <SiteHeader />
      <main className="docs">
        <section className="docs-hero">
          <div className="wrap">
            <h1>Put 3D models and drawings on any page</h1>
            <p className="sub">
              <code>&lt;sketchor-view&gt;</code> is Sketchor&apos;s viewer as one web component. A 3D part turns on a turntable, leans
              toward the cursor, orbits when dragged, opens full screen — where a click measures faces, edges and the distance between them — and opens in Sketchor with one click.
              A DXF, SVG, EPS or PDF drawing floats, or draws itself in; in full view it pans, zooms, measures point to point with snapping and switches layers off. About 12 kB until a preview
              scrolls into view. MIT licensed.
            </p>
            <EmbedConfigurator />
          </div>
        </section>

        <section>
          <div className="wrap docs-body">
            <h2>Three ways to embed</h2>
            <h3>1 · Script tag and element</h3>
            <p>Add the module once per page, then one element per file. Size it like an image — it&apos;s 4:3 unless you say otherwise.</p>
            <pre className="snippet">{ELEMENT_SNIPPET}</pre>

            <h3>2 · Auto-upgrade existing links</h3>
            <p>
              Add <code>data-auto</code> to the script tag and <code>data-sketchor</code> to links or images you already have. Each becomes a
              preview of the same file, labelled by the link text or <code>alt</code>. Settings pass through as{" "}
              <code>data-sketchor-&lt;attribute&gt;</code>. Links whose format the embed can&apos;t recognise stay links.
            </p>
            <pre className="snippet">{AUTO_SNIPPET}</pre>

            <h3>3 · iframe and oEmbed (no scripts)</h3>
            <p>
              For a CMS that strips scripts, use the iframe endpoint — its query parameters are the attributes below. Notion, WordPress and
              Discourse turn a pasted model URL or <code>/embed?src=</code> link into a preview through the oEmbed endpoint{" "}
              <code>{SITE}/oembed?url=…</code>.
            </p>
            <pre className="snippet">{IFRAME_SNIPPET}</pre>

            <h2>Attributes</h2>
            <div className="table-scroll">
              <table className="attrs">
                <thead>
                  <tr>
                    <th>Attribute</th>
                    <th>Values</th>
                    <th>Default</th>
                  </tr>
                </thead>
                <tbody>
                  {ATTRS.map(([name, values, def]) => (
                    <tr key={name}>
                      <td>
                        <code>{name}</code>
                      </td>
                      <td>{values}</td>
                      <td>{def}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <h2>Styling</h2>
            <p>
              Set <code>--sketchor-bg</code>, <code>--sketchor-accent</code> and <code>--sketchor-radius</code> on the element; they always
              win over <code>theme</code>. Buttons are reachable with <code>::part(play-button)</code>, <code>full-button</code>,{" "}
              <code>logo</code>, <code>open-link</code>, <code>stage</code>, <code>canvas</code>, <code>measure</code>, <code>layers</code> and <code>status</code>. A theme file is
              validated (colour values only) and must be served with CORS from another host.
            </p>

            <h2>JavaScript</h2>
            <pre className="snippet">{JS_SNIPPET}</pre>

            <h2>Formats and hosting</h2>
            <p>
              Previews draw glTF / GLB (including Draco), STL, OBJ, PLY and 3MF in 3D, and DXF, SVG, EPS, AI and PDF drawings with the
              same renderer as the Sketchor canvas. STEP, IGES and DWG show a card that opens the file in Sketchor. Files on another host need <code>Access-Control-Allow-Origin</code>; files on your own site always
              work. To self-host, copy the package&apos;s <code>dist/</code> folder anywhere — chunks load relative to the script.
            </p>
            <p>
              <code>/embed/sketchor-embed.js</code> always serves the latest build. To pin one, use{" "}
              <code>/embed/v/&lt;version&gt;/sketchor-embed.js</code> — those files never change; <code>/embed/version.json</code> names the
              current version. TypeScript users get the element&apos;s types from <code>@sketchor/embed</code>.
            </p>
          </div>
        </section>
      </main>
    </>
  );
}
