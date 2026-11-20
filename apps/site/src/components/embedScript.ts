declare module "react" {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace JSX {
    interface IntrinsicElements {
      // Attributes are validated where they're built (lib/embedFrame.ts); the element ignores unknown ones.
      "sketchor-view": Record<string, string | undefined> & { className?: string; style?: React.CSSProperties };
    }
  }
}

export const EMBED_SCRIPT = "/embed/sketchor-embed.js";

/** Adds the embed module to the page once; the element upgrades when it arrives. */
export function ensureEmbedScript(): void {
  if (customElements.get("sketchor-view") || document.querySelector(`script[src="${EMBED_SCRIPT}"]`)) return;
  const s = document.createElement("script");
  s.type = "module";
  s.src = EMBED_SCRIPT;
  document.head.appendChild(s);
}
