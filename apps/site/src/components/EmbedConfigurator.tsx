"use client";

import { useEffect, useMemo, useState } from "react";
import { SITE } from "@/lib/embedFrame";
import { embedSnippet, type EmbedOptions, type SnippetMode } from "@/lib/embedSnippet";
import { ensureEmbedScript } from "./embedScript";

const SAMPLES: [string, string][] = [
  ["Sheet-metal bracket (GLB)", "/models/bracket.glb"],
  ["Flange plate drawing (DXF)", "/models/flange-plate.dxf"],
];
const THEMES = ["auto", "dark", "light", "blueprint", "nord", "paper", "solarized-dark", "solarized-light", "high-contrast", "classic-cad", "monokai"];
const MODES: [SnippetMode, string][] = [
  ["element", "Script + element"],
  ["auto", "Auto-upgrade a link"],
  ["iframe", "iframe (no scripts)"],
];

/**
 * E-09: pick a file and settings, watch a live `<sketchor-view>`, copy the
 * snippet. The preview is the real element; the snippet comes from
 * lib/embedSnippet.ts, which is tested against the iframe endpoint's parser.
 */
export default function EmbedConfigurator() {
  useEffect(ensureEmbedScript, []);
  const [sample, setSample] = useState(SAMPLES[0][1]);
  const [custom, setCustom] = useState("");
  const [autoplay, setAutoplay] = useState(true);
  const [motion, setMotion] = useState("turntable");
  const [theme, setTheme] = useState("auto");
  const [bg, setBg] = useState("");
  const [logo, setLogo] = useState(true);
  const [controls, setControls] = useState(true);
  const [label, setLabel] = useState("");
  const [mode, setMode] = useState<SnippetMode>("element");
  const [copied, setCopied] = useState(false);

  const src = custom.trim() || `${SITE}${sample}`;
  // The live preview loads the sample from this origin (works in dev and on preview deploys).
  const previewSrc = custom.trim() || sample;

  const opts: EmbedOptions = {
    src,
    autoplay: autoplay ? "" : undefined,
    motion,
    theme,
    background: bg.trim() || undefined,
    logo: logo ? "on" : "off",
    controls: controls ? "minimal" : "none",
    label: label.trim() || undefined,
  };
  const snippet = useMemo(() => embedSnippet(mode, opts), [mode, JSON.stringify(opts)]); // eslint-disable-line react-hooks/exhaustive-deps

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(snippet);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      setCopied(false);
    }
  };

  // autoplay and motion are read when a file loads, so a change remounts the preview.
  const previewKey = `${previewSrc}|${autoplay}|${motion}`;
  const previewAttrs: Record<string, string> = { src: previewSrc, motion, theme, logo: logo ? "on" : "off", controls: controls ? "minimal" : "none" };
  if (autoplay) previewAttrs.autoplay = "";
  if (bg.trim()) previewAttrs.background = bg.trim();
  if (label.trim()) previewAttrs.label = label.trim();

  return (
    <div className="configurator">
      <div className="config-preview">
        <sketchor-view key={previewKey} {...previewAttrs} />
      </div>
      <form className="config-form" onSubmit={(e) => e.preventDefault()}>
        <label>
          File
          <select value={sample} onChange={(e) => setSample(e.target.value)} disabled={!!custom.trim()}>
            {SAMPLES.map(([name, path]) => (
              <option key={path} value={path}>
                {name}
              </option>
            ))}
          </select>
        </label>
        <label>
          …or your file&apos;s URL
          <input type="url" placeholder="https://your.site/part.glb" value={custom} onChange={(e) => setCustom(e.target.value)} />
        </label>
        <label>
          Theme
          <select value={theme} onChange={(e) => setTheme(e.target.value)}>
            {THEMES.map((t) => (
              <option key={t}>{t}</option>
            ))}
          </select>
        </label>
        <label>
          Motion
          <select value={motion} onChange={(e) => setMotion(e.target.value)}>
            <option value="turntable">turntable (3D) / float (2D)</option>
            <option value="float">float (2D)</option>
            <option value="draw">draw (2D)</option>
            <option value="none">none</option>
          </select>
        </label>
        <label>
          Background
          <input placeholder="theme default, #fff, transparent" value={bg} onChange={(e) => setBg(e.target.value)} />
        </label>
        <label>
          Label
          <input placeholder="file name" value={label} onChange={(e) => setLabel(e.target.value)} />
        </label>
        <div className="config-checks">
          <label><input type="checkbox" checked={autoplay} onChange={(e) => setAutoplay(e.target.checked)} /> autoplay</label>
          <label><input type="checkbox" checked={controls} onChange={(e) => setControls(e.target.checked)} /> controls</label>
          <label><input type="checkbox" checked={logo} onChange={(e) => setLogo(e.target.checked)} /> logo</label>
        </div>
      </form>
      <div className="config-snippet">
        <div className="config-tabs" role="tablist">
          {MODES.map(([m, name]) => (
            <button key={m} type="button" role="tab" aria-selected={mode === m} className={mode === m ? "on" : ""} onClick={() => setMode(m)}>
              {name}
            </button>
          ))}
          <button type="button" className="copy" onClick={copy}>
            {copied ? "Copied" : "Copy"}
          </button>
        </div>
        <pre className="snippet">{snippet}</pre>
      </div>
    </div>
  );
}
