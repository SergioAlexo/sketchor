"use client";

import { useEffect } from "react";

declare module "react" {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace JSX {
    interface IntrinsicElements {
      "sketchor-view": { src: string; autoplay?: ""; label?: string; class?: string };
    }
  }
}

const SRC = "/embed/sketchor-embed.js";

/** A live `<sketchor-view>` — the site dogfoods the embed it documents. */
export default function EmbedDemo({ src, label }: { src: string; label: string }) {
  useEffect(() => {
    if (customElements.get("sketchor-view") || document.querySelector(`script[src="${SRC}"]`)) return;
    const s = document.createElement("script");
    s.type = "module";
    s.src = SRC;
    document.head.appendChild(s);
  }, []);
  return <sketchor-view src={src} label={label} autoplay="" />;
}
