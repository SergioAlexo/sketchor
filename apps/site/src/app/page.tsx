import EmbedDemo from "@/components/EmbedDemo";
import HeroCanvas from "@/components/HeroCanvas";
import SiteHeader from "@/components/SiteHeader";
import { Check, Code, Cube, Download, Folder, Layers, Ruler, Snap } from "@/components/icons";
import { bundledAppVersion, latestRelease, REPO_URL } from "@/lib/release";

export const revalidate = 3600;

const FEATURES = [
  {
    icon: <Folder />,
    title: "Opens the files you already have",
    body: "DXF, DWG and SVG import — including block references, splines, polyline bulges and ellipses — plus EPS, Illustrator and PDF vectors. Save back out as DXF or SVG.",
  },
  {
    icon: <Snap />,
    title: "Snapping that finds the right point",
    body: "Endpoints, centers, quadrants, intersections and nearest-point-on-curve, in priority order, so a corner is never shadowed by the line running through it.",
  },
  {
    icon: <Ruler />,
    title: "A measure tool worth using",
    body: "Point-to-point, arc length, area and perimeter, angles relative to a reference edge. Pin the readings you want to keep on screen.",
  },
  {
    icon: <Check />,
    title: "Finds what's wrong with a drawing",
    body: "Duplicate circles, overlapping lines, line crossings and endpoints that never joined up — flagged on the canvas, with a heal step where a fix is unambiguous.",
  },
  {
    icon: <Layers />,
    title: "Layers, tabs and overlays",
    body: "Open several drawings at once, and overlay one on another on its own layer to see exactly what changed between two revisions.",
  },
  {
    icon: <Code />,
    title: "Your drawing as text",
    body: "A readable sketch code panel — line L1 from (0,0) to (100,0) — that edits both ways. Every change runs through one undoable command bus, which is what the constraint solver and AI assistant plug into.",
  },
  {
    icon: <Cube />,
    title: "3D models, measured",
    body: "Open STEP, IGES, STL, OBJ, 3MF and glTF in a 3D tab: shaded parts with B-rep edges, an assembly tree, and click-to-measure lengths, diameters, areas and distances.",
  },
];

const FORMATS: [string, string][] = [
  ["DXF", "import & save"],
  ["SVG", "import & save"],
  ["DWG", "import"],
  ["EPS / AI", "import"],
  ["PDF", "import"],
  ["STEP / IGES", "view in 3D"],
  ["STL · OBJ · 3MF · glTF", "view in 3D"],
];

const EMBED_SNIPPET = `<script type="module"
  src="https://sketchor.sergioalexo.com/embed/sketchor-embed.js"></script>

<sketchor-view src="/models/bracket.glb" autoplay></sketchor-view>`;

export default async function Home() {
  const [rel, appVersion] = await Promise.all([latestRelease(), bundledAppVersion()]);
  return (
    <>
      <SiteHeader />

      <main>
        <div className="hero">
          <div className="wrap">
            <a className="badge" href={`${REPO_URL}/releases/tag/v${rel.version}`} target="_blank" rel="noopener">
              v{rel.version} is out
            </a>
            <h1>
              2D CAD that <em>opens instantly</em>
            </h1>
            <p className="lead">
              Sketchor is a modern 2D sketcher for the DXF and DWG files you already have. Install it on Windows, or just open it in your
              browser — no account, no licence, nothing to configure.
            </p>
            <div className="ctas">
              <a className="btn primary" href={rel.installer}>
                <Download />
                Download for Windows
              </a>
              <a className="btn" href="/app">
                Open in your browser
              </a>
            </div>
            <p className="meta">
              <span>Version {rel.version}</span>
              <span>{rel.sizeMb} MB</span>
              <span>Windows 10/11</span>
              <span>{rel.date}</span>
            </p>
            <HeroCanvas />
          </div>
        </div>

        <section>
          <div className="wrap">
            <h2>Built for real drawings, not demos</h2>
            <p className="sub">The features here exist because a drawing that came out of somebody else&apos;s CAD needed them.</p>
            <div className="grid">
              {FEATURES.map((f) => (
                <div className="card" key={f.title}>
                  <div className="icon">{f.icon}</div>
                  <h3>{f.title}</h3>
                  <p>{f.body}</p>
                </div>
              ))}
            </div>
          </div>
        </section>

        <section>
          <div className="wrap">
            <h2>Desktop or browser — same editor</h2>
            <p className="sub">Both run the identical drawing engine. The desktop build adds the things only a native app can do.</p>
            <div className="compare">
              <div className="card featured">
                <h3>Windows desktop</h3>
                <p className="small">
                  v{rel.version} installer · {rel.sizeMb} MB
                </p>
                <ul>
                  {["Full editor, offline", "Double-click a .dxf to open it", "Drawing and model thumbnails in Explorer", "Browse a folder of drawings in-app", "Updates itself — one click, no reinstall"].map((t) => (
                    <li key={t}><span className="y">✓</span>{t}</li>
                  ))}
                </ul>
                <a className="btn primary" href={rel.installer}>
                  <Download />
                  Download the installer
                </a>
              </div>
              <div className="card">
                <h3>In your browser</h3>
                <p className="small">Nothing to install{appVersion ? ` · running v${appVersion}` : ""}</p>
                <ul>
                  {["Full editor, same tools", "Opens and saves real files on your disk", "Drawings stay on your machine — nothing uploaded"].map((t) => (
                    <li key={t}><span className="y">✓</span>{t}</li>
                  ))}
                  {["No Explorer integration", "Needs Chrome or Edge for direct file saving"].map((t) => (
                    <li key={t} className="off"><span className="n">—</span>{t}</li>
                  ))}
                </ul>
                <a className="btn" href="/app">
                  Open Sketchor
                </a>
              </div>
            </div>
          </div>
        </section>

        <section>
          <div className="wrap">
            <h2>Formats</h2>
            <p className="sub">Import from the left, save to the right — and look at the 3D parts your drawings came from.</p>
            <div className="chips">
              {FORMATS.map(([name, what]) => (
                <span className="chip" key={name}>
                  <b>{name}</b> — {what}
                </span>
              ))}
            </div>
          </div>
        </section>

        <section id="embed">
          <div className="wrap embed-demo">
            <div>
              <h2>Put your models on any page</h2>
              <p className="sub" style={{ marginBottom: 0 }}>
                <code>&lt;sketchor-view&gt;</code> is Sketchor&apos;s 3D viewer as a single web component: drop in one script tag and your
                parts turn on a turntable, orbit under the cursor, open full screen — and open in Sketchor with one click. About 9 kB
                until a preview scrolls into view.
              </p>
              <pre className="snippet">{EMBED_SNIPPET}</pre>
              <p style={{ marginTop: 14 }}>
                <a className="btn" href="/embed">
                  Configurator and docs →
                </a>
              </p>
            </div>
            <EmbedDemo src="/models/bracket.glb" label="Sheet-metal bracket" />
          </div>
        </section>

        <section>
          <div className="wrap">
            <div className="free">
              <h2>Free now. Free forever.</h2>
              <p>
                No account, no licence key, no trial that quietly expires, and no tool held back behind a paid tier. Everything on this page
                is yours to use, on as many machines as you like, for as long as you like.
              </p>
              <p>
                One honest caveat: the AI features on the roadmap run on models that cost real money per request, so those may eventually
                carry a fee. The editor itself won&apos;t.
              </p>
            </div>
          </div>
        </section>
      </main>

      <footer>
        <div className="wrap">
          <span>
            Designed and built by{" "}
            <a href="https://tech.sergioalexo.com" target="_blank" rel="noopener">Sergio Alexo</a>.
          </span>
          <span>
            <a href={REPO_URL} target="_blank" rel="noopener">GitHub</a> ·{" "}
            <a href={`${REPO_URL}/releases`} target="_blank" rel="noopener">Releases</a> ·{" "}
            <a href="https://www.sergioalexo.com" target="_blank" rel="noopener">sergioalexo.com</a>
          </span>
        </div>
      </footer>
    </>
  );
}
