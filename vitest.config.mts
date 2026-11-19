import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

// Resolve the workspace packages to their TypeScript source, mirroring the app's
// tsconfig paths, so tests import the same code the app builds.
const core = fileURLToPath(new URL("./packages/core/src/index.ts", import.meta.url));
const embedThree = fileURLToPath(new URL("./packages/embed/src/three", import.meta.url));
const sdk = fileURLToPath(new URL("./packages/plugin-sdk/src/index.ts", import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      "@sketchor/core": core,
      "@sketchor/plugin-sdk": sdk,
      "@sketchor/embed/three": embedThree,
    },
  },
  test: {
    environment: "node",
    include: ["packages/**/*.test.ts", "apps/web/src/**/*.test.ts"],
  },
});
