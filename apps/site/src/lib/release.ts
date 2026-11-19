import { readFile } from "node:fs/promises";
import { join } from "node:path";

export const REPO = "SergioAlexo/sketchor";
export const REPO_URL = `https://github.com/${REPO}`;

export interface Release {
  version: string;
  /** Windows installer URL. */
  installer: string;
  sizeMb: string;
  date: string;
}

/** Shown if GitHub can't be reached at build time (rate limit, outage). */
const FALLBACK: Release = {
  version: "0.36.0",
  installer: `${REPO_URL}/releases/latest`,
  sizeMb: "8.2",
  date: "November 4, 2026",
};

/** Latest GitHub release with a Windows installer; revalidated hourly so a new tag shows up without a redeploy. */
export async function latestRelease(): Promise<Release> {
  try {
    const res = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, {
      headers: { Accept: "application/vnd.github+json" },
      next: { revalidate: 3600 },
    });
    if (!res.ok) return FALLBACK;
    const j = (await res.json()) as { tag_name: string; published_at: string; assets: { name: string; size: number; browser_download_url: string }[] };
    const exe = j.assets.find((a) => /x64-setup\.exe$/i.test(a.name));
    if (!exe) return FALLBACK;
    return {
      version: j.tag_name.replace(/^v/, ""),
      installer: exe.browser_download_url,
      sizeMb: (exe.size / 1048576).toFixed(1),
      date: new Date(j.published_at).toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric", timeZone: "UTC" }),
    };
  } catch {
    return FALLBACK;
  }
}

/** Version of the web app bundled under /app (written by scripts/bundle.mjs). */
export async function bundledAppVersion(): Promise<string | null> {
  try {
    const raw = await readFile(join(process.cwd(), "public", "app", "version.json"), "utf8");
    return (JSON.parse(raw) as { version: string }).version;
  } catch {
    return null;
  }
}
