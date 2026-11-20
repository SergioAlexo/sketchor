"use client";

import { useEffect } from "react";
import { ensureEmbedScript } from "./embedScript";

/** A live `<sketchor-view>` — the site dogfoods the embed it documents. */
export default function EmbedDemo({ src, label }: { src: string; label: string }) {
  useEffect(ensureEmbedScript, []);
  return <sketchor-view src={src} label={label} autoplay="" />;
}
