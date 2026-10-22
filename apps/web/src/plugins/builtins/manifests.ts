import { HOST_API_VERSION, type PluginManifest } from "@sketchor/core";

/**
 * Manifests for the in-repo first-party plugins. In Phase 1 a "builtin" was just
 * an id the worker could import; Phase 2 gives each a real {@link PluginManifest}
 * — the same shape a third-party plugin ships — so the host registers its
 * `contributes` block through the ordinary path. Third-party manifests loaded
 * from disk/registry (Phase 4/5) flow through the exact same registration.
 *
 * `engines.sketchor` is pinned to the current host API version so these exercise
 * the load-time compatibility check like any real plugin would.
 */
export const BUILTIN_MANIFESTS: PluginManifest[] = [
  {
    id: "com.sketchor.pattern",
    version: "1.0.0",
    name: "Pattern",
    description: "Repeat the selection in a grid or around a circle.",
    publisher: "Sketchor",
    engines: { sketchor: `^${HOST_API_VERSION}` },
    main: "patternPlugin.ts",
    contributes: {
      generators: [{ id: "pattern.array", title: "Pattern (array)" }],
    },
    permissions: ["read-document", "write-document"],
  },
  {
    id: "com.sketchor.panel-demo",
    version: "1.0.0",
    name: "Circle Maker",
    description: "Demo: a sandboxed-iframe panel that adds a circle through the worker.",
    publisher: "Sketchor",
    engines: { sketchor: `^${HOST_API_VERSION}` },
    main: "panelDemoPlugin.ts",
    ui: "panelDemo.html",
    contributes: {
      commands: [{ id: "panel-demo.open", title: "Circle Maker (panel)" }],
    },
    permissions: ["read-document", "write-document"],
  },
  {
    id: "com.sketchor.truck-nesting",
    version: "2.0.0",
    name: "Truck Load Planner",
    description: "Nest pallets into a trailer by delivery order and draw a colour-coded load plan.",
    publisher: "Sketchor",
    engines: { sketchor: `^${HOST_API_VERSION}` },
    main: "truckNestingPlugin.ts",
    ui: "truckNesting.html",
    contributes: {
      commands: [{ id: "truck-nesting.open", title: "Truck Load Planner (panel)" }],
    },
    permissions: ["read-document", "write-document", "storage"],
  },
  {
    id: "com.sketchor.svg-export",
    version: "1.0.0",
    name: "SVG Export",
    description: "Export the drawing as an SVG file.",
    publisher: "Sketchor",
    engines: { sketchor: `^${HOST_API_VERSION}` },
    main: "svgExportPlugin.ts",
    contributes: {
      io: [{ id: "svg", title: "SVG (plugin)", direction: ["export"], extensions: ["svg"] }],
    },
    permissions: ["read-document"],
  },
  {
    id: "com.sketchor.gcode",
    version: "1.0.0",
    name: "G-code Ripper",
    description: "Decode a CNC G-code program into drawing geometry.",
    publisher: "Sketchor",
    engines: { sketchor: `^${HOST_API_VERSION}` },
    main: "gcodePlugin.ts",
    ui: "gcode.html",
    contributes: {
      commands: [{ id: "gcode.import", title: "G-code Ripper (import)" }],
      io: [{ id: "gcode", title: "G-code", direction: ["import"], extensions: ["nc", "gcode", "tap", "ngc"] }],
    },
    permissions: ["write-document"],
  },
  {
    id: "com.sketchor.nest",
    version: "2.0.0",
    name: "Sheet Metal Nest",
    description: "True-shape nest parts with holes onto stock sheets, with per-part rotation and a multi-sheet inventory.",
    publisher: "Sketchor",
    engines: { sketchor: `^${HOST_API_VERSION}` },
    main: "nestPlugin.ts",
    ui: "nest.html",
    contributes: {
      commands: [{ id: "nest.open", title: "Sheet Metal Nest (panel)" }],
    },
    permissions: ["read-document", "write-document", "storage"],
  },
  {
    id: "com.sketchor.sheet-nesting",
    version: "1.0.0",
    name: "Sheet Nesting",
    description: "Raster-first sheet nesting with a true-shape option: materials, sheet stock, groups from a parts list, KPIs, DXF/ZIP and G-code.",
    publisher: "Sketchor",
    engines: { sketchor: `^${HOST_API_VERSION}` },
    main: "sheetNestingPlugin.ts",
    ui: "sheetNesting.html",
    contributes: {
      commands: [{ id: "sheet-nesting.open", title: "Sheet Nesting (panel)" }],
    },
    permissions: ["read-document", "write-document", "storage"],
  },
];
