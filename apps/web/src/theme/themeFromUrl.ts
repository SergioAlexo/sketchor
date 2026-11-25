import { useApp } from "../state/store";
import { installThemeBundle } from "./installedThemes";
import { parseThemeFileText } from "./themeFileInstall";
import { themeTarget, withoutThemeParam } from "./themeTarget";
import { useTheme } from "./themeStore";

/**
 * TH-05/TH-07: `/app?theme=<id | url>` — the theme gallery's "Open in
 * Sketchor" link. A shipped theme is switched to straight away. A theme file
 * is fetched (the host must allow CORS unless it is this site), validated by
 * the same gate as a dropped file, and installed only after the same confirm
 * dialog. The parameter is then dropped from the address bar so a reload
 * doesn't ask again.
 */
export async function initThemeFromUrl(): Promise<void> {
  const target = themeTarget(window.location.search, window.location.origin);
  if (!target) return;
  try {
    history.replaceState(history.state, "", window.location.pathname + withoutThemeParam(window.location.search) + window.location.hash);
  } catch {
    // a sandboxed frame can refuse; the link still works, it just stays in the address bar
  }
  const notice = useApp.getState().setSaveNotice;
  if (target.kind === "setting") {
    useTheme.getState().setSetting(target.setting);
    notice({ kind: "saved", message: `Switched to the ${target.name} theme`, at: Date.now() });
    return;
  }
  const host = new URL(target.url).host;
  try {
    const res = await fetch(target.url, { mode: "cors" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const r = parseThemeFileText(await res.text());
    if (!r.ok) throw new Error(r.reason);
    const names = r.titles.join(", ");
    if (!window.confirm(`Install the theme ${names} from ${host} and switch to it?\n\nThemes only change colours and can't run code.`)) return;
    const installed = installThemeBundle(r.bundle);
    if (!installed.ok) throw new Error(installed.reason);
    useTheme.getState().setSetting(`custom:${installed.themes[0].key}`);
    notice({ kind: "saved", message: `Installed theme ${names}`, at: Date.now() });
  } catch (err) {
    notice({ kind: "error", message: `The theme from ${host} could not be installed (${(err as Error).message})`, at: Date.now() });
  }
}
