import { Logo } from "@/components/icons";
import { REPO_URL } from "@/lib/release";

/** The sticky top bar, shared by the landing page, /embed and /themes. */
export default function SiteHeader() {
  return (
    <header className="top">
      <div className="wrap">
        <a className="brand" href="/" aria-label="Sketchor home">
          <Logo />
          Sketchor
        </a>
        <nav aria-label="Main">
          <a href="/themes" className="hide-sm">Themes</a>
          <a href="/embed" className="hide-sm">Embed</a>
          <a href={REPO_URL} target="_blank" rel="noopener">GitHub</a>
          <a href="/app" className="solid">Open app</a>
        </nav>
      </div>
    </header>
  );
}
