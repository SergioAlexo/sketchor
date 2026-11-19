import React from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { initDesktopFileOpen } from "./dxf/desktopBridge";
import { initUpdateCheck } from "./update/updateService";
import { initExplorerPreviews } from "./desktop/explorerPreviews";
import { initMetrics } from "./metrics/metrics";
import { initFirstOpenDemo } from "./demo/firstOpen";
import { initOpenFromUrl } from "./io/openFromUrl";
import { installPluginDevHandle, loadFirstPartyPlugins, loadInstalledPlugins } from "./plugins";
import "./styles.css";

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);

// Wire up "open .dxf / .svg / .dwg from Explorer" when running as the desktop app.
initDesktopFileOpen();

// Look for a newer release shortly after launch. On the desktop this uses the
// signed Tauri updater (install in place); on the web it falls back to the
// public GitHub Releases API. Failures stay silent — see updateService.ts.
initUpdateCheck();

// Desktop: Explorer previews for model/drawing icons are on by default — a
// launch without the machine-wide markers asks Windows for them (one UAC
// prompt). No-op on the web. See desktop/explorerPreviews.ts.
initExplorerPreviews();

// Anonymous usage statistics (opt-out, first-launch notice). Inert unless a
// PostHog key is configured and this is a production build — see
// metrics/metrics.ts for exactly what is and isn't sent.
initMetrics();

// Plugin runtime: boot the first-party plugins (their contributions show up in
// the command palette and the export menu), and keep the console dev handle
// (window.sketchorPlugins) for the sandbox/pattern acceptance checks.
installPluginDevHandle();
void loadFirstPartyPlugins();
void loadInstalledPlugins();

// Web build, first open: show the built-in showcase drawing (?demo forces, ?blank skips).
initFirstOpenDemo();
// E-06: /app?open=<url> (the embed's "Open in Sketchor" link).
void initOpenFromUrl();
