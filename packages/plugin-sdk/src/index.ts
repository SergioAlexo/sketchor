/**
 * `@sketchor/plugin-sdk` — the library a Sketchor plugin imports. It provides
 * the typed host-API proxy, entity/command builders, and the plugin entry
 * contract. It carries no sandbox or transport implementation of its own — the
 * host injects the {@link RpcTransport} at load time (Phase 1).
 *
 * The SDK version tracks the host API version (`HOST_API_VERSION`), so building
 * against a given SDK is building against a known host contract.
 *
 * A plugin's `main` module is expected to satisfy {@link PluginModule}:
 *
 * ```ts
 * import { add, circle, type PluginModule } from "@sketchor/plugin-sdk";
 *
 * const plugin: PluginModule = {
 *   async activate(sketchor) {
 *     const sel = await sketchor.selection.read();
 *     await sketchor.document.apply([add(circle({ x: 0, y: 0 }, 10))]);
 *   },
 * };
 * export default plugin;
 * ```
 */

export { createClient } from "./client";
export { contributionStore } from "./contributions";
export type { ContributionStore, ContributionKind } from "./contributions";
export type { RpcTransport } from "./transport";
export * from "./builders";

// Pure geometry helpers a generator needs to transform read-model entities into
// new ones. Framework-free and side-effect-free, so they're safe in the sandbox.
export {
  translated,
  transformed,
  rotated,
  rotatePoint,
  centroidOfEntities,
  patternCopyCount,
  newEntityId,
  entityPoints,
  textWidth,
  textCorners,
  linearDimension,
} from "@sketchor/core";

// Renderers a plugin needs to put *the geometry it drew* on paper, rather than
// redrawing the same plan a second way: both read the very entities that go
// into the DXF, so the sheet and the exported file can never drift apart.
export { entitiesToSvgDocument, drawEntitiesToPdf, PdfBuilder, PDF_LETTER, PDF_LETTER_LANDSCAPE, pdfTextWidth } from "@sketchor/core";
export type { SvgExportOptions, PdfDrawBox, PdfDrawOptions, PdfPageSize, PdfPaint, PdfTextStyle } from "@sketchor/core";

// Re-export the contract types authors need, so a plugin depends only on the SDK.
export type {
  PluginHostApi,
  DocumentApi,
  SelectionApi,
  StorageApi,
  NetworkApi,
  FilesystemApi,
  UiApi,
  AppApi,
  DisplayUnitInfo,
  DocumentReadModel,
  PluginManifest,
  PluginContributions,
  Permission,
  PluginFetchInit,
  PluginFetchResponse,
  UiShowOptions,
  PrintOptions,
  NotifyOptions,
  SaveFileFilter,
  SaveFileResult,
  PickedFile,
  PickedFolder,
  Unsubscribe,
  Command,
  Entity,
  EntityId,
  LineEntity,
  CircleEntity,
  ArcEntity,
  PointEntity,
  PolylineEntity,
  TextEntity,
  Point,
  LinearDimensionOptions,
  LinearDimension,
  // Contribution registration contract.
  CommandsApi,
  GeneratorsApi,
  IoApi,
  CommandHandler,
  CommandContext,
  GeneratorHandler,
  GeneratorContext,
  ExporterHandler,
  ExporterContext,
  ImporterHandler,
  ImporterContext,
  // Pattern generator types (for the first-party pattern plugin).
  PatternSpec,
  RectangularPattern,
  CircularPattern,
} from "@sketchor/core";

export { HOST_API_VERSION, PERMISSIONS, PALETTE, colorAt } from "@sketchor/core";

import type { PluginHostApi } from "@sketchor/core";

/**
 * The shape a plugin's `main` module exports (as its default export). The host
 * calls `activate` once, passing the client proxy, after the sandbox loads; it
 * calls `deactivate` (if present) on unload/uninstall.
 */
export interface PluginModule {
  activate(sketchor: PluginHostApi): void | Promise<void>;
  deactivate?(): void | Promise<void>;
}
