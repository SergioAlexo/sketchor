/**
 * The plugin contract: the framework-free types and validators shared by the
 * host (`apps/web`) and the authoring SDK (`@sketchor/plugin-sdk`). No runtime
 * sandbox lives here — only the boundary. See `docs/plugin-architecture.md` §6.
 */
export * from "./capabilities";
export * from "./readModel";
export * from "./manifest";
export * from "./hostApi";
export * from "./signing";
export * from "./themeBundle";
export * from "./patternBundle";
export * from "./blockBundle";
