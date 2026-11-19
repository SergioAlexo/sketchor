import { formatOf } from "./formats";

/** E-06: pure half of `/app?open=<url>` — which URLs may be fetched (kept free of the store so it tests in node). */

/** The `open` URL, if the page was given one that is http(s) and names a format Sketchor reads. */
export function openTarget(search: string): { url: string; name: string } | null {
  const raw = new URLSearchParams(search).get("open");
  if (!raw) return null;
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") return null;
  const name = decodeURIComponent(u.pathname.split("/").pop() ?? "");
  if (!name || !formatOf(name)) return null;
  return { url: u.href, name };
}
