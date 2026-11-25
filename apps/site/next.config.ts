import type { NextConfig } from "next";

const immutable = [{ key: "Cache-Control", value: "public, max-age=31536000, immutable" }];

const nextConfig: NextConfig = {
  async rewrites() {
    // The web app is a static Vite build in public/app (base "/app/"). Every
    // non-file path under /app is the single-page app's index.
    return [
      { source: "/app", destination: "/app/index.html" },
      { source: "/app/", destination: "/app/index.html" },
    ];
  },
  async headers() {
    return [
      // index.html must revalidate so a deploy reaches people; hashed assets never change.
      { source: "/app", headers: [{ key: "Cache-Control", value: "public, max-age=0, must-revalidate" }] },
      { source: "/app/assets/:path*", headers: immutable },
      { source: "/embed/chunks/:path*", headers: immutable },
      // E-08: a pinned version never changes; the unversioned /embed/sketchor-embed.js is "latest" and revalidates.
      { source: "/embed/v/:path*", headers: immutable },
      { source: "/embed/sketchor-embed.js", headers: [{ key: "Cache-Control", value: "public, max-age=300, must-revalidate" }] },
      // Cross-origin: other sites load the embed module and its chunks.
      { source: "/embed/:path*", headers: [{ key: "Access-Control-Allow-Origin", value: "*" }] },
      // TH-07: theme files are fetched by the desktop app, the embed on other sites and `/app?theme=` from anywhere.
      { source: "/themes/:path*", headers: [{ key: "Access-Control-Allow-Origin", value: "*" }] },
      // The DWG (LibreDWG) and STEP (OCCT) readers stream-compile their wasm, which needs the right MIME type.
      { source: "/app/:path*.wasm", headers: [{ key: "Content-Type", value: "application/wasm" }] },
    ];
  },
};

export default nextConfig;
