"use client";

import { useEffect, useState } from "react";
import { ensureEmbedScript } from "./embedScript";
import type { GalleryTheme } from "@/lib/themes";

const SAMPLES = {
  drawing: { src: "/models/flange-plate.dxf", label: "Drawing" },
  model: { src: "/models/bracket.glb", label: "3D model" },
} as const;
type Sample = keyof typeof SAMPLES;

/**
 * TH-07: the theme cards. Each preview is a live `<sketchor-view>` in that
 * theme — the same drawing (or 3D part) in every card, so the colours are
 * what differs. Download hands out the theme file; "Open in Sketchor"
 * switches the web app to it (`/app?theme=`), installing a community theme
 * after the app's own confirm.
 */
export default function ThemeGallery({ themes }: { themes: GalleryTheme[] }) {
  useEffect(ensureEmbedScript, []);
  const [sample, setSample] = useState<Sample>("drawing");
  const s = SAMPLES[sample];
  return (
    <>
      <div className="config-tabs theme-sample" role="group" aria-label="Preview">
        {(Object.keys(SAMPLES) as Sample[]).map((k) => (
          <button key={k} type="button" className={k === sample ? "on" : ""} aria-pressed={k === sample} onClick={() => setSample(k)}>
            {SAMPLES[k].label}
          </button>
        ))}
      </div>
      <div className="theme-grid">
        {themes.map((t) => (
          <article key={`${t.source}:${t.id}`} className="theme-card" data-theme-id={t.id}>
            <sketchor-view
              // A new element per sample: switching src would re-theme the old one first.
              key={sample}
              src={s.src}
              theme={t.ref}
              label={`${t.name} theme — ${s.label.toLowerCase()} preview`}
              motion={sample === "drawing" ? "float" : "turntable"}
              logo="off"
              controls="minimal"
            />
            <div className="theme-card-body">
              <div className="theme-card-head">
                <h3>{t.name}</h3>
                <span className={`theme-tag ${t.source}`}>{t.source === "community" ? "Community" : t.base === "dark" ? "Dark" : "Light"}</span>
              </div>
              {t.author && <p className="theme-author">by {t.author}</p>}
              <div className="theme-swatches" aria-hidden="true">
                {t.swatches.map((c, i) => (
                  <span key={i} style={{ background: c }} />
                ))}
              </div>
              <div className="theme-actions">
                <a className="btn primary sm" href={`/app?theme=${encodeURIComponent(t.ref)}`}>
                  Open in Sketchor
                </a>
                {t.file ? (
                  <a className="btn sm" href={t.file} download>
                    Download
                  </a>
                ) : (
                  <span className="theme-default-note">Built in</span>
                )}
              </div>
            </div>
          </article>
        ))}
      </div>
    </>
  );
}
