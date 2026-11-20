import type { Metadata } from "next";
import EmbedDocs from "@/components/EmbedDocs";
import EmbedFrame from "@/components/EmbedFrame";
import { frameAttrs, frameUrl } from "@/lib/embedFrame";

/**
 * E-02 iframe endpoint: `/embed?src=<file URL>&motion=…&theme=…` is a
 * full-bleed preview for sites that can't run <script> (CMSs, Notion via
 * oEmbed). Without `src` it is the embed docs page and configurator (E-09).
 */

type Search = Promise<Record<string, string | string[] | undefined>>;

export async function generateMetadata({ searchParams }: { searchParams: Search }): Promise<Metadata> {
  const params = await searchParams;
  if (params.src === undefined) {
    return {
      title: "Embed 3D models on any page — Sketchor",
      description: "<sketchor-view>: an animated, orbitable 3D preview for any website. One script tag, an iframe, or oEmbed. Free and MIT licensed.",
      alternates: { canonical: "/embed" },
    };
  }
  const r = frameAttrs(params);
  if (!r.ok) return { title: "Sketchor embed", robots: { index: false } };
  return {
    title: r.attrs.label ?? "3D preview — Sketchor",
    robots: { index: false, follow: false },
    // oEmbed discovery: a consumer handed this page's URL finds the JSON endpoint here.
    alternates: { types: { "application/json+oembed": `/oembed?url=${encodeURIComponent(frameUrl(r.attrs))}` } },
  };
}

export default async function EmbedPage({ searchParams }: { searchParams: Search }) {
  const params = await searchParams;
  if (params.src === undefined) return <EmbedDocs />;
  const r = frameAttrs(params);
  if (!r.ok) {
    return (
      <main className="embed-frame embed-frame-error">
        <p>
          This Sketchor preview link is broken ({r.error}). It should look like <code>/embed?src=https://…/model.glb</code>.
        </p>
      </main>
    );
  }
  return (
    <>
      {r.attrs.background === "transparent" && <style>{"html,body{background:transparent!important}"}</style>}
      <EmbedFrame attrs={r.attrs} />
    </>
  );
}
