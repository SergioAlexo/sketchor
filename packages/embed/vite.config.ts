import { defineConfig } from "vite";
import { fileURLToPath } from "node:url";

/**
 * E-01/E-08: one ES module (`dist/sketchor-embed.js`) that defines
 * `<sketchor-view>`. three.js, the mesh parsers and the shared renderer are a
 * lazy chunk (`dist/chunks/`) fetched only when an element actually loads a
 * file, so a page with previews below the fold pays a few kB up front.
 * Chunks are imported relative to the entry, so the whole `dist/` folder can
 * be self-hosted anywhere (the "site mirror" case).
 */
export default defineConfig({
  resolve: {
    alias: {
      "@sketchor/core": fileURLToPath(new URL("../core/src/index.ts", import.meta.url)),
    },
  },
  build: {
    target: "es2022",
    outDir: "dist",
    // public/ only holds local demo models for the dev page; never ship them.
    copyPublicDir: false,
    lib: {
      entry: fileURLToPath(new URL("./src/index.ts", import.meta.url)),
      formats: ["es"],
      fileName: () => "sketchor-embed.js",
    },
    rollupOptions: {
      output: { chunkFileNames: "chunks/[name]-[hash].js" },
    },
  },
});
