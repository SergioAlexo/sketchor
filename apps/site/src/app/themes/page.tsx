import type { Metadata } from "next";
import SiteHeader from "@/components/SiteHeader";
import ThemeGallery from "@/components/ThemeGallery";
import { REPO_URL } from "@/lib/release";
import { galleryThemes } from "@/lib/themes";

export const metadata: Metadata = {
  title: "Themes — Sketchor",
  description: "Colour themes for Sketchor, previewed live. Open one in the web app with a click or download the theme file.",
  alternates: { canonical: "/themes" },
};

const COMMUNITY_DIR = `${REPO_URL}/tree/main/apps/site/public/themes/community`;

/** TH-07: `/themes` — every theme Sketchor ships, plus community themes submitted by pull request. */
export default async function ThemesPage() {
  const themes = await galleryThemes();
  const community = themes.filter((t) => t.source === "community").length;
  return (
    <>
      <SiteHeader />
      <main className="docs">
        <section className="docs-hero">
          <div className="wrap">
            <h1>Themes</h1>
            <p className="sub">
              Every theme colours the whole app: panels, the drawing canvas and the 3D view. The previews below are live, drawn in each theme.
              <b> Open in Sketchor</b> switches the web app to that theme. <b>Download</b> gives you the file to drop onto the desktop app
              or pass on.
            </p>
            <ThemeGallery themes={themes} />
          </div>
        </section>

        <section>
          <div className="wrap docs-body">
            <h2>Make your own</h2>
            <p>
              In Sketchor, open the theme menu, choose <b>Customize current theme…</b> and change any colour. The editor checks contrast as
              you go and exports a <code>.sketchor-theme.json</code> file. Drop that file onto Sketchor to install it. Themes are colours
              only: they can&apos;t run code or reach the network.
            </p>
            <h2>Share it here</h2>
            <p>
              {community > 0 ? `${community} community theme${community === 1 ? "" : "s"} so far. ` : "No community themes yet. Yours could be the first. "}
              Add your file to{" "}
              <a href={COMMUNITY_DIR} target="_blank" rel="noopener">
                <code>apps/site/public/themes/community/</code>
              </a>{" "}
              in a pull request. The folder&apos;s README has the steps, and a test checks the file with the app&apos;s own validator. Once it&apos;s
              merged, the theme appears on this page.
            </p>
          </div>
        </section>
      </main>
    </>
  );
}
