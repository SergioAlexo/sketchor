"use client";

import { useEffect } from "react";
import { ensureEmbedScript } from "./embedScript";

/** The iframe endpoint's whole page: one `<sketchor-view>` filling the frame. */
export default function EmbedFrame({ attrs }: { attrs: Record<string, string> }) {
  useEffect(ensureEmbedScript, []);
  return (
    <div className="embed-frame">
      <sketchor-view {...attrs} loading="eager" />
    </div>
  );
}
