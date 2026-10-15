import { useMemo, Fragment, lazy, Suspense, useEffect, useState } from "react";
import { CONSTRAINT_LABELS, freeEndpointEntityIds, setFieldContext } from "@sketchor/core";
import { bus, doc, entityMeasurement, getSessions, isModelSession, measurementText, TOOL_HINTS, useApp, type ToolId } from "./state/store";
import { useTouchMode } from "./touchMode";
import { SnapPopover } from "./SnapPopover";
import { SelectByPopover } from "./SelectByPopover";
import { POLAR_INCREMENTS, useTracking } from "./tools/tracking";
import { activeSaveTarget, openDrawing, overlayDrawing, saveCurrent, saveDrawing } from "./io/drawingFile";
import { DISPLAY_UNITS, formatLength, type DisplayUnit } from "./units";
import { Viewport } from "./viewport/Viewport";
import { CodePanel } from "./code/CodePanel";
import { FileExplorerPanel } from "./browser/FileExplorerPanel";
import { DiagnosticsPanel } from "./heal/DiagnosticsPanel";
import { DuplicatesPanel } from "./heal/DuplicatesPanel";
import { ImportReportBanner } from "./dxf/ImportReportBanner";
import { LayerPanel } from "./layers/LayerPanel";
import { PropertiesPanel } from "./properties/PropertiesPanel";
import { ConstraintPanel } from "./constraints/ConstraintPanel";
import { VariablesPanel } from "./constraints/VariablesPanel";
import { PatternPanel } from "./pattern/PatternPanel";
import { HatchPanel } from "./fill/HatchPanel";
import { BlockPanel } from "./blocks/BlockPanel";
import { BlockEditBar } from "./blocks/BlockEditBar";
import { InsertPanel } from "./blocks/InsertPanel";
import { BlockLibraryPanel } from "./blocks/BlockLibraryPanel";
import { AttdefPanel } from "./blocks/AttdefPanel";
import { AttEditDialog } from "./blocks/AttEditDialog";
import { TextPanel } from "./text/TextPanel";
import { printDrawing } from "./print/printDrawing";
import { PluginCommandPalette } from "./plugins/PluginCommandPalette";
import { ShortcutsPanel } from "./ShortcutsPanel";
import { DimStyleManager } from "./dimstyles/DimStyleManager";
import { MTextEditor } from "./mtext/MTextEditor";
import { RebindPopover } from "./RebindPopover";
import { bindingLabel, matchesBinding, useKeybindings } from "./keybindings";
import { PluginPanels } from "./plugins/PluginPanels";
import { PluginsPanel } from "./plugins/PluginsPanel";
import { listActions, listExporters, onRegistriesChange, runCommand, runExporter, runGenerator } from "./plugins/host/registries";
import { StraightenPanel } from "./viewport/StraightenPanel";
import { TabStrip } from "./tabs/TabStrip";

// The 3D viewer pulls in three.js; it's loaded only once a model tab exists.
const ModelViewport = lazy(() => import("./model3d/ModelViewport").then((m) => ({ default: m.ModelViewport })));
const StructurePanel = lazy(() => import("./model3d/StructurePanel").then((m) => ({ default: m.StructurePanel })));
import { UpdateBanner, UpdateButton } from "./update/UpdatePanel";
import { MetricsNotice } from "./metrics/MetricsNotice";
import { openExternal } from "./update/updateService";
import { useTheme } from "./theme/themeStore";
import { ThemePicker } from "./theme/ThemePicker";
import { useThemeDrop } from "./theme/useThemeDrop";
import { useDrawingDrop } from "./io/useDrawingDrop";

/**
 * The project's home page, opened by the logo in the toolbar. Must stay
 * inside the opener scope in src-tauri/capabilities/default.json — the
 * desktop build refuses any URL that isn't listed there.
 */
const SKETCHOR_SITE = "https://sketchor.sergioalexo.com/";

const S = { stroke: "currentColor", strokeWidth: 2, fill: "none", strokeLinecap: "round", strokeLinejoin: "round" } as const;

/** `divider: true` draws a separator before the entry (draw tools | modify tools | view). */
const TOOLS: { id: ToolId; label: string; keyHint: string; icon: JSX.Element; divider?: boolean }[] = [
  {
    id: "select",
    label: "Select",
    keyHint: "V",
    icon: (
      <svg viewBox="0 0 24 24" width="20" height="20">
        <path d="M6 3l12 9-5.2 1L15 19l-2.6 1.2-2.2-6L6 17z" fill="currentColor" />
      </svg>
    ),
  },
  {
    id: "line",
    label: "Line",
    keyHint: "L",
    icon: (
      <svg viewBox="0 0 24 24" width="20" height="20">
        <path d="M4 20L20 4" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
        <circle cx="4" cy="20" r="2.4" fill="currentColor" />
        <circle cx="20" cy="4" r="2.4" fill="currentColor" />
      </svg>
    ),
  },
  {
    id: "polyline",
    label: "Polyline",
    keyHint: "W",
    icon: (
      <svg viewBox="0 0 24 24" width="20" height="20">
        <path d="M3 18l5-9 5 5 8-9" stroke="currentColor" strokeWidth="2" fill="none" strokeLinecap="round" strokeLinejoin="round" />
        <circle cx="3" cy="18" r="2" fill="currentColor" />
        <circle cx="8" cy="9" r="2" fill="currentColor" />
        <circle cx="13" cy="14" r="2" fill="currentColor" />
        <circle cx="21" cy="5" r="2" fill="currentColor" />
      </svg>
    ),
  },
  {
    id: "rectangle",
    label: "Rectangle",
    keyHint: "R",
    icon: (
      <svg viewBox="0 0 24 24" width="20" height="20">
        <rect x="4" y="6" width="16" height="12" stroke="currentColor" strokeWidth="2" fill="none" />
      </svg>
    ),
  },
  {
    id: "circle",
    label: "Circle",
    keyHint: "C",
    icon: (
      <svg viewBox="0 0 24 24" width="20" height="20">
        <circle cx="12" cy="12" r="8" stroke="currentColor" strokeWidth="2" fill="none" />
        <circle cx="12" cy="12" r="1.6" fill="currentColor" />
      </svg>
    ),
  },
  {
    id: "arc",
    label: "Arc",
    keyHint: "A",
    icon: (
      <svg viewBox="0 0 24 24" width="20" height="20">
        <path d="M4 18A9 9 0 0 1 20 12" stroke="currentColor" strokeWidth="2" fill="none" strokeLinecap="round" />
        <circle cx="4" cy="18" r="1.6" fill="currentColor" />
        <circle cx="20" cy="12" r="1.6" fill="currentColor" />
        <circle cx="10.5" cy="11.8" r="1.6" fill="currentColor" />
      </svg>
    ),
  },
  {
    id: "ellipse",
    label: "Ellipse",
    keyHint: "E",
    icon: (
      <svg viewBox="0 0 24 24" width="20" height="20">
        <ellipse cx="12" cy="12" rx="9" ry="5.5" transform="rotate(-25 12 12)" stroke="currentColor" strokeWidth="2" fill="none" />
        <circle cx="12" cy="12" r="1.6" fill="currentColor" />
      </svg>
    ),
  },
  {
    id: "spline",
    label: "Spline",
    keyHint: "S",
    icon: (
      <svg viewBox="0 0 24 24" width="20" height="20">
        <path d="M3 17C8 3 12 21 21 7" stroke="currentColor" strokeWidth="2" fill="none" strokeLinecap="round" />
        <circle cx="3" cy="17" r="1.6" fill="currentColor" />
        <circle cx="21" cy="7" r="1.6" fill="currentColor" />
      </svg>
    ),
  },
  {
    id: "polygon",
    label: "Polygon",
    keyHint: "",
    icon: (
      <svg viewBox="0 0 24 24" width="20" height="20">
        <path d="M12 3l7.8 5.7-3 9.3H7.2l-3-9.3z" {...S} />
      </svg>
    ),
  },
  {
    id: "slot",
    label: "Slot",
    keyHint: "",
    icon: (
      <svg viewBox="0 0 24 24" width="20" height="20">
        <path d="M8 8h8a4 4 0 010 8H8a4 4 0 010-8z" {...S} />
        <path d="M8 12h.01M16 12h.01" {...S} strokeWidth="2.6" />
      </svg>
    ),
  },
  {
    id: "point",
    label: "Point",
    keyHint: "P",
    icon: (
      <svg viewBox="0 0 24 24" width="20" height="20">
        <path d="M12 4v6M12 14v6M4 12h6M14 12h6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
      </svg>
    ),
  },
  {
    id: "image",
    label: "Image",
    keyHint: "I",
    icon: (
      <svg viewBox="0 0 24 24" width="20" height="20">
        <rect x="3" y="4" width="18" height="16" rx="1.5" stroke="currentColor" strokeWidth="2" fill="none" />
        <circle cx="8.5" cy="9.5" r="1.6" stroke="currentColor" strokeWidth="1.6" fill="none" />
        <path d="M4 17l5.5-5.5 3 3L17 9.5l3.5 3.5" stroke="currentColor" strokeWidth="2" fill="none" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    ),
  },
  {
    id: "measure",
    label: "Measure",
    keyHint: "M",
    icon: (
      <svg viewBox="0 0 24 24" width="20" height="20">
        <path
          d="M3 15L15 3l6 6L9 21z"
          stroke="currentColor"
          strokeWidth="2"
          fill="none"
          strokeLinejoin="round"
        />
        <path
          d="M14 4l2 2M11 7l2 2M8 10l2 2M5 13l2 2"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinecap="round"
        />
      </svg>
    ),
  },
  {
    id: "straighten",
    label: "Straighten",
    keyHint: "T",
    icon: (
      <svg viewBox="0 0 24 24" width="20" height="20">
        <path
          d="M4 17L15 6M15 6h-5M15 6v5"
          stroke="currentColor"
          strokeWidth="2"
          fill="none"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        <path d="M4 20h16" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
      </svg>
    ),
  },
  {
    id: "fill",
    label: "Hatch",
    keyHint: "H",
    icon: (
      <svg viewBox="0 0 24 24" width="20" height="20">
        <path
          d="M5 12L12 5l6 6-7 7z"
          stroke="currentColor"
          strokeWidth="1.8"
          fill="none"
          strokeLinejoin="round"
        />
        <path d="M5 12h9" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
        <path d="M19 15c0 1.7 1.5 3 1.5 3s1.5-1.3 1.5-3-1.5-2-1.5-2-1.5.3-1.5 2z" fill="currentColor" />
      </svg>
    ),
  },
  {
    id: "text",
    label: "Text",
    keyHint: "X",
    icon: (
      <svg viewBox="0 0 24 24" width="20" height="20">
        <path d="M5 6h14M12 6v13M9 19h6" stroke="currentColor" strokeWidth="2" fill="none" strokeLinecap="round" />
      </svg>
    ),
  },
  {
    id: "mtext",
    label: "Multiline text",
    keyHint: "",
    icon: (
      <svg viewBox="0 0 24 24" width="20" height="20">
        <path d="M4 6h10M9 6v8M6 14h6M15 10h5M15 14h5M4 19h16" stroke="currentColor" strokeWidth="1.8" fill="none" strokeLinecap="round" />
      </svg>
    ),
  },
  {
    id: "dim",
    label: "Dimension",
    keyHint: "D",
    icon: (
      <svg viewBox="0 0 24 24" width="20" height="20">
        <path d="M4 8v8M20 8v8M4 12h16" stroke="currentColor" strokeWidth="2" fill="none" strokeLinecap="round" />
        <path d="M4 12l3-2M4 12l3 2M20 12l-3-2M20 12l-3 2" stroke="currentColor" strokeWidth="1.6" fill="none" strokeLinecap="round" />
      </svg>
    ),
  },
  {
    id: "pan",
    label: "Pan",
    keyHint: "",
    icon: (
      <svg viewBox="0 0 24 24" width="20" height="20">
        <path
          d="M8 12V5.5a1.5 1.5 0 013 0V11m0-6.5v-1a1.5 1.5 0 013 0V11m0-5a1.5 1.5 0 013 0v5m0-3a1.5 1.5 0 013 0v6c0 4-2.5 7-6.5 7S8 18 6 15l-2.2-3.3a1.4 1.4 0 012.3-1.6L8 12"
          stroke="currentColor"
          strokeWidth="1.8"
          fill="none"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    ),
  },
  {
    id: "move",
    label: "Move",
    keyHint: "",
    divider: true,
    icon: (
      <svg viewBox="0 0 24 24" width="20" height="20">
        <path d="M12 3v18M3 12h18M12 3l-3 3M12 3l3 3M12 21l-3-3M12 21l3-3M3 12l3-3M3 12l3 3M21 12l-3-3M21 12l-3 3" {...S} />
      </svg>
    ),
  },
  {
    id: "copy",
    label: "Copy",
    keyHint: "",
    icon: (
      <svg viewBox="0 0 24 24" width="20" height="20">
        <rect x="3" y="3" width="12" height="12" rx="1.5" {...S} />
        <path d="M9 21h10a2 2 0 002-2V9" {...S} strokeDasharray="3 2" />
      </svg>
    ),
  },
  {
    id: "rotate",
    label: "Rotate",
    keyHint: "",
    icon: (
      <svg viewBox="0 0 24 24" width="20" height="20">
        <path d="M20 12a8 8 0 11-2.3-5.7" {...S} />
        <path d="M20 3v5h-5" {...S} />
        <circle cx="12" cy="12" r="1.4" fill="currentColor" />
      </svg>
    ),
  },
  {
    id: "scale",
    label: "Scale",
    keyHint: "",
    icon: (
      <svg viewBox="0 0 24 24" width="20" height="20">
        <rect x="3" y="11" width="10" height="10" rx="1" {...S} />
        <path d="M13 11L21 3M21 3h-6M21 3v6" {...S} />
      </svg>
    ),
  },
  {
    id: "mirror",
    label: "Mirror",
    keyHint: "",
    icon: (
      <svg viewBox="0 0 24 24" width="20" height="20">
        <path d="M12 2v20" {...S} strokeDasharray="3 2" />
        <path d="M9 6L3 18h6zM15 6l6 12h-6z" {...S} />
      </svg>
    ),
  },
  {
    id: "trim",
    label: "Trim",
    keyHint: "",
    divider: true,
    icon: (
      <svg viewBox="0 0 24 24" width="20" height="20">
        <path d="M3 8h18M3 16h18" {...S} />
        <path d="M12 3v5M12 16v5" {...S} />
        <path d="M12 8v8" {...S} strokeDasharray="2 2" opacity="0.5" />
        <path d="M9 10l6 4M15 10l-6 4" {...S} strokeWidth="1.5" />
      </svg>
    ),
  },
  {
    id: "split",
    label: "Split",
    keyHint: "",
    icon: (
      <svg viewBox="0 0 24 24" width="20" height="20">
        <path d="M3 12h7M14 12h7" {...S} />
        <path d="M12 6v12" {...S} strokeDasharray="2 2" />
        <circle cx="12" cy="12" r="1.6" fill="currentColor" />
      </svg>
    ),
  },
  {
    id: "fillet",
    label: "Fillet",
    keyHint: "",
    icon: (
      <svg viewBox="0 0 24 24" width="20" height="20">
        <path d="M4 20V11a7 7 0 017-7h9" {...S} />
        <path d="M4 6V4h2M18 20h2v-2" {...S} strokeWidth="1.4" opacity="0.5" />
      </svg>
    ),
  },
  {
    id: "chamfer",
    label: "Chamfer",
    keyHint: "",
    icon: (
      <svg viewBox="0 0 24 24" width="20" height="20">
        <path d="M4 20V11l7-7h9" {...S} />
      </svg>
    ),
  },
  {
    id: "offset",
    label: "Offset",
    keyHint: "",
    icon: (
      <svg viewBox="0 0 24 24" width="20" height="20">
        <path d="M4 20V8a4 4 0 014-4h12" {...S} />
        <path d="M9 20v-9a2 2 0 012-2h9" {...S} strokeDasharray="3 2" />
      </svg>
    ),
  },
  {
    id: "insert",
    label: "Insert block",
    keyHint: "",
    icon: (
      <svg viewBox="0 0 24 24" width="20" height="20">
        <rect x="9" y="9" width="11" height="11" rx="1" {...S} />
        <path d="M4 4h5M6.5 1.5v5" {...S} />
        <path d="M5 13v7h4" {...S} strokeDasharray="2 2" />
      </svg>
    ),
  },
  {
    id: "attdef",
    label: "Attribute definition (in the block editor)",
    keyHint: "",
    icon: (
      <svg viewBox="0 0 24 24" width="20" height="20">
        <path d="M5 19l5-14 5 14M7 14h6" {...S} />
        <path d="M18 8h3M19.5 6.5v3" {...S} />
      </svg>
    ),
  },
  {
    id: "block",
    label: "Create block",
    keyHint: "B",
    icon: (
      <svg viewBox="0 0 24 24" width="20" height="20">
        <rect x="4" y="4" width="16" height="16" rx="1" {...S} strokeDasharray="3 2" />
        <path d="M9 12h6M12 9v6" {...S} />
      </svg>
    ),
  },
  {
    id: "divide",
    label: "Divide",
    keyHint: "",
    icon: (
      <svg viewBox="0 0 24 24" width="20" height="20">
        <path d="M3 12h18" {...S} />
        <path d="M8 9v6M12 9v6M16 9v6" {...S} strokeWidth="1.6" />
      </svg>
    ),
  },
  {
    id: "align",
    label: "Align",
    keyHint: "",
    icon: (
      <svg viewBox="0 0 24 24" width="20" height="20">
        <path d="M4 18l6-8 4 3 6-9" {...S} opacity="0.5" />
        <path d="M4 20h16" {...S} />
        <circle cx="4" cy="18" r="1.6" fill="currentColor" />
        <circle cx="20" cy="4" r="1.6" fill="currentColor" />
      </svg>
    ),
  },
  {
    id: "lengthen",
    label: "Lengthen",
    keyHint: "",
    icon: (
      <svg viewBox="0 0 24 24" width="20" height="20">
        <path d="M4 12h9" {...S} />
        <path d="M13 12h7" {...S} strokeDasharray="3 2" />
        <path d="M17 9l3 3-3 3" {...S} />
      </svg>
    ),
  },
  {
    id: "stretch",
    label: "Stretch",
    keyHint: "",
    icon: (
      <svg viewBox="0 0 24 24" width="20" height="20">
        <path d="M4 8h10v8H4z" {...S} />
        <path d="M14 8h4v8h-4" {...S} strokeDasharray="3 2" />
        <path d="M18 12h3m-2-2l2 2-2 2" {...S} />
      </svg>
    ),
  },
  {
    id: "match",
    label: "Match",
    keyHint: "",
    icon: (
      <svg viewBox="0 0 24 24" width="20" height="20">
        <path d="M14 4l6 6-8 8-6-6z" {...S} />
        <path d="M6 12l-2 2 4 4 2-2" {...S} />
        <path d="M4 20h4" {...S} />
      </svg>
    ),
  },
];

/**
 * The tool buttons. On the left as a vertical rail by default; in touch
 * mode (see touchMode.ts) the same list is rendered along the bottom as big
 * labelled buttons that a thumb can hit.
 */
function ToolRail({
  layout,
  rebind,
}: {
  layout: "side" | "bottom";
  rebind: (actionId: string) => (e: React.MouseEvent) => void;
}) {
  const tool = useApp((s) => s.tool);
  const setTool = useApp((s) => s.setTool);
  const keyBindings = useKeybindings((s) => s.bindings);
  return (
    <nav className={`toolrail ${layout}`} data-testid={layout === "bottom" ? "toolrail-bottom" : "toolrail"}>
      {TOOLS.map((t) => {
        const bound = bindingLabel(keyBindings[`tool.${t.id}`]);
        return (
          <Fragment key={t.id}>
            {t.divider && <span className="toolrail-sep" />}
            <button
              className={`tool ${tool === t.id ? "active" : ""}`}
              title={`${t.label}${bound ? ` (${bound})` : ""} — right-click to change shortcut`}
              data-testid={`tool-${t.id}`}
              onClick={() => setTool(t.id)}
              onContextMenu={rebind(`tool.${t.id}`)}
            >
              {t.icon}
              {layout === "bottom" ? (
                <span className="tool-label">{t.label}</span>
              ) : (
                <span className="keyhint">{bound || t.keyHint}</span>
              )}
            </button>
          </Fragment>
        );
      })}
    </nav>
  );
}

/**
 * Runs a plugin-contributed exporter and downloads its output. Plugin IO sits
 * alongside the built-in DXF/SVG saves; unlike those it isn't bound to a save
 * target (no round-trip file handle), so it always triggers a fresh download.
 */
async function exportViaPlugin(id: string, ext: string): Promise<void> {
  const { setSaveNotice } = useApp.getState();
  try {
    const text = await runExporter(id);
    const target = activeSaveTarget();
    const base = (target?.name ?? "drawing").replace(/\.(dxf|svg|dwg)$/i, "");
    const blob = new Blob([text], { type: "image/svg+xml" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${base}.${ext}`;
    a.click();
    URL.revokeObjectURL(url);
    setSaveNotice({ kind: "saved", message: `Exported ${base}.${ext}`, at: Date.now() });
  } catch (err) {
    setSaveNotice({ kind: "error", message: `Export failed: ${err instanceof Error ? err.message : String(err)}`, at: Date.now() });
  }
}

export function App() {
  const tool = useApp((s) => s.tool);
  const setTool = useApp((s) => s.setTool);
  const cursor = useApp((s) => s.cursor);
  const zoom = useApp((s) => s.zoom);
  const revision = useApp((s) => s.revision);
  const selection = useApp((s) => s.selection);
  const measurement = useApp((s) => s.measurement);
  const pinnedMeasurements = useApp((s) => s.pinnedMeasurements);
  const pinMeasurement = useApp((s) => s.pinMeasurement);
  const clearPinnedMeasurements = useApp((s) => s.clearPinnedMeasurements);
  const referenceEdgeId = useApp((s) => s.referenceEdgeId);
  useThemeDrop();
  useDrawingDrop();
  const saveNotice = useApp((s) => s.saveNotice);
  const setSaveNotice = useApp((s) => s.setSaveNotice);

  // A save confirmation is transient — clear it a few seconds after it lands.
  useEffect(() => {
    if (!saveNotice) return;
    const t = setTimeout(() => setSaveNotice(null), saveNotice.kind === "error" ? 8000 : 3000);
    return () => clearTimeout(t);
  }, [saveNotice, setSaveNotice]);
  const [showCode, setShowCode] = useState(false);
  const [showLayers, setShowLayers] = useState(true);
  const [showProps, setShowProps] = useState(false);
  const [showConstraints, setShowConstraints] = useState(false);
  const [showVariables, setShowVariables] = useState(false);
  const [showBlocks, setShowBlocks] = useState(false);
  const [showDiag, setShowDiag] = useState(false);
  const [showDup, setShowDup] = useState(false);
  const [showPattern, setShowPattern] = useState(false);
  const [showPlugins, setShowPlugins] = useState(false);
  const [showSaveMenu, setShowSaveMenu] = useState(false);
  const [showUpdateMenu, setShowUpdateMenu] = useState(false);
  const [showPluginMenu, setShowPluginMenu] = useState(false);
  const [showPalette, setShowPalette] = useState(false);
  const [showShortcuts, setShowShortcuts] = useState(false);
  const [showThemeMenu, setShowThemeMenu] = useState(false);
  const themeSetting = useTheme((s) => s.setting);
  const touchMode = useTouchMode((s) => s.enabled);
  const toggleTouchMode = useTouchMode((s) => s.toggle);
  const prompt = useApp((s) => s.prompt);
  const ortho = useTracking((s) => s.ortho);
  const polar = useTracking((s) => s.polar);
  const polarIncrement = useTracking((s) => s.polarIncrement);
  const toggleOrtho = useTracking((s) => s.toggleOrtho);
  const togglePolar = useTracking((s) => s.togglePolar);
  const otrack = useTracking((s) => s.otrack);
  const autoConstrain = useApp((s) => s.autoConstrain);
  const setAutoConstrain = useApp((s) => s.setAutoConstrain);
  const drawingMode = useApp((s) => s.drawingMode);
  const setDrawingMode = useApp((s) => s.setDrawingMode);
  const commandLine = useApp((s) => s.commandLine);
  const toggleCommandLine = useApp((s) => s.toggleCommandLine);
  // The solver's verdict on the current sketch (T-40); null until the
  // drawing has constraints. Re-read on every revision, like the entity count.
  const solve = useMemo(() => bus.lastSolve, [revision]); // eslint-disable-line react-hooks/exhaustive-deps
  // Constraint ids mean nothing to a reader; the tooltip names their kinds.
  const constraintName = (id: string) => {
    const c = doc.getConstraint(id);
    return c ? CONSTRAINT_LABELS[c.type] : id;
  };
  const toggleOtrack = useTracking((s) => s.toggleOtrack);
  const setPolarIncrement = useTracking((s) => s.setPolarIncrement);
  const [rebindTarget, setRebindTarget] = useState<{ actionId: string; x: number; y: number } | null>(null);
  const keyBindings = useKeybindings((s) => s.bindings);
  // Right-click any bindable toolbar button to reassign its shortcut.
  const rebind = (actionId: string) => (e: React.MouseEvent) => {
    e.preventDefault();
    setRebindTarget({ actionId, x: e.clientX, y: e.clientY });
  };
  const withKey = (label: string, actionId: string) => {
    const key = bindingLabel(keyBindings[actionId]);
    return key ? `${label} (${key})` : label;
  };
  // Bumped when plugins load/unload, so the export menu re-reads its list.
  const [pluginVersion, setPluginVersion] = useState(0);
  const showFiles = useApp((s) => s.fileBrowserVisible);
  const setShowFiles = useApp((s) => s.setFileBrowserVisible);
  const showConnectivityHint = useApp((s) => s.showConnectivityHint);
  const setShowConnectivityHint = useApp((s) => s.setShowConnectivityHint);
  const showClosedRegions = useApp((s) => s.showClosedRegions);
  const setShowClosedRegions = useApp((s) => s.setShowClosedRegions);
  const displayUnit = useApp((s) => s.displayUnit);
  const setDisplayUnit = useApp((s) => s.setDisplayUnit);

  // App-level shortcuts that don't belong to the canvas (Viewport.tsx owns
  // those): the command palette and the toolbar toggles that have a
  // rebindable — but by default unbound — shortcut (see keybindings.ts).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      if (target.tagName === "INPUT" || target.tagName === "TEXTAREA") return;
      if (matchesBinding(e, "app.commandPalette")) {
        e.preventDefault();
        setShowPalette((v) => !v);
      } else if (matchesBinding(e, "app.toggleProperties")) {
        e.preventDefault();
        setShowProps((v) => !v);
      } else if (matchesBinding(e, "app.toggleConstraints")) {
        e.preventDefault();
        setShowConstraints((v) => !v);
      } else if (matchesBinding(e, "app.toggleBlocks")) {
        e.preventDefault();
        setShowBlocks((v) => !v);
      } else if (matchesBinding(e, "app.toggleLayers")) {
        e.preventDefault();
        setShowLayers((v) => !v);
      } else if (matchesBinding(e, "app.toggleCode")) {
        e.preventDefault();
        setShowCode((v) => !v);
      } else if (matchesBinding(e, "app.truckNesting")) {
        e.preventDefault();
        void runCommand("truck-nesting.open");
      } else if (matchesBinding(e, "app.shortcuts")) {
        e.preventDefault();
        setShowShortcuts(true);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Warn before closing the browser tab/window (or the desktop window, which
  // is the same underlying page-unload event) if any tab has unsaved
  // changes — in-app tab close already prompts via closeTab()'s own confirm.
  useEffect(() => {
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      if (!getSessions().some((s) => s.dirty)) return;
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, []);

  // Refresh plugin-derived menus (export list) as plugins load/unload.
  useEffect(() => onRegistriesChange(() => setPluginVersion((v) => v + 1)), []);

  // Close the Save-format, update and plugin popovers on an outside click.
  useEffect(() => {
    if (!showSaveMenu && !showUpdateMenu && !showPluginMenu && !showThemeMenu) return;
    const onClick = (e: MouseEvent) => {
      if ((e.target as HTMLElement).closest(".action-menu-wrap")) return;
      setShowSaveMenu(false);
      setShowUpdateMenu(false);
      setShowPluginMenu(false);
      setShowThemeMenu(false);
    };
    document.addEventListener("click", onClick);
    return () => document.removeEventListener("click", onClick);
  }, [showSaveMenu, showUpdateMenu, showPluginMenu, showThemeMenu]);

  // Which real file a plain Save would overwrite. Subscribing to
  // `sessionsVersion` is what makes it refresh: the binding itself lives in
  // drawingFile.ts, but every event that changes it (opening a file, Save As,
  // switching tabs) bumps that counter.
  useApp((s) => s.sessionsVersion);
  const saveTarget = activeSaveTarget();
  const activeSessionId = useApp((s) => s.activeSessionId);
  const activeSession = getSessions().find((s) => s.id === activeSessionId);
  // A STEP/IGES tab swaps the drawing canvas for the 3D viewer (see model3d/).
  const hatchTinted = useApp((s) => s.hatchTinted);
  const modelTab = isModelSession(activeSession);
  // Attribute fields ({{filename}}) read the file name of the drawing being worked on (a block-editor tab uses its drawing's).
  const fileNameForFields = activeSession?.blockEdit ? getSessions().find((s) => s.id === activeSession.blockEdit?.parentId)?.name : activeSession?.name;
  useEffect(() => {
    if (fileNameForFields) setFieldContext({ filename: fileNameForFields });
    useApp.setState((s) => ({ revision: s.revision + 1 }));
  }, [fileNameForFields]);

  const referenceEdge = referenceEdgeId ? doc.get(referenceEdgeId) : null;
  const referenceAngleDeg =
    referenceEdge?.type === "line" ? (Math.atan2(referenceEdge.b.y - referenceEdge.a.y, referenceEdge.b.x - referenceEdge.a.x) * 180) / Math.PI : null;

  const [justCopied, setJustCopied] = useState(false);
  const copyMeasurement = () => {
    if (!measurement) return;
    void navigator.clipboard.writeText(measurementText(measurement, displayUnit, referenceAngleDeg)).then(() => {
      setJustCopied(true);
      setTimeout(() => setJustCopied(false), 1200);
    });
  };

  // Recomputed every render (cheap, matches the entity-count footer pattern below); `revision` forces the re-render.
  const freeEndpointCount = showConnectivityHint ? freeEndpointEntityIds(doc).size : 0;

  // `revision` (read via the hook above) forces this to recompute after edits/undo.
  const selectionLabel = (ids: string[]): string => {
    if (ids.length === 0) return "";
    const counts = new Map<string, number>();
    for (const id of ids) {
      const e = doc.get(id);
      if (e) counts.set(e.type, (counts.get(e.type) ?? 0) + 1);
    }
    if (counts.size === 1) {
      const [[type, n]] = counts;
      return ids.length === 1 ? `1 ${type} selected` : `${n} ${type}s selected`;
    }
    const parts = [...counts.entries()].map(([type, n]) => `${n} ${type}${n > 1 ? "s" : ""}`);
    return `${ids.length} selected (${parts.join(", ")})`;
  };

  // Selecting exactly one line/circle/arc/polyline (with the select tool,
  // not the measure tool) shows its size right there — no tool switch
  // needed just to read a length off the drawing.
  const selectedSingle = selection.length === 1 ? doc.get(selection[0]) : null;
  const selectionMeasurement = selectedSingle ? entityMeasurement(selectedSingle) : null;
  const [justCopiedSelection, setJustCopiedSelection] = useState(false);
  const copySelectionMeasurement = () => {
    if (!selectionMeasurement) return;
    void navigator.clipboard.writeText(measurementText(selectionMeasurement, displayUnit)).then(() => {
      setJustCopiedSelection(true);
      setTimeout(() => setJustCopiedSelection(false), 1200);
    });
  };

  return (
    <div className={`app ${touchMode ? "touch" : ""}`}>
      <header className="topbar">
        <button
          className="brand"
          type="button"
          title="Open sketchor.sergioalexo.com"
          data-testid="brand-link"
          onClick={() => void openExternal(SKETCHOR_SITE)}
        >
          <svg viewBox="0 0 24 24" width="18" height="18">
            <path
              d="M4 18L11 5l3.5 6.5L18 6l2 12"
              stroke="currentColor"
              strokeWidth="2.2"
              fill="none"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
          Sketchor
        </button>
        <div className="topbar-actions">
          <button
            className="action"
            title={withKey("Open DXF / SVG / DWG drawing — right-click to change shortcut", "file.open")}
            data-testid="open-file"
            onClick={() => void openDrawing()}
            onContextMenu={rebind("file.open")}
          >
            <svg viewBox="0 0 24 24" width="18" height="18">
              <path
                d="M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2z"
                stroke="currentColor"
                strokeWidth="2"
                fill="none"
                strokeLinejoin="round"
              />
            </svg>
          </button>
          <button
            className="action"
            title="Overlay a DXF / SVG / DWG onto the current drawing, on its own layer — for comparing two revisions"
            data-testid="overlay-file"
            onClick={() => void overlayDrawing()}
          >
            <svg viewBox="0 0 24 24" width="18" height="18">
              <rect x="3" y="7" width="13" height="13" rx="1.5" stroke="currentColor" strokeWidth="2" fill="none" />
              <rect x="8" y="4" width="13" height="13" rx="1.5" stroke="currentColor" strokeWidth="2" fill="none" opacity="0.6" />
            </svg>
          </button>
          <div className="action-menu-wrap">
            <button
              className="action"
              title={withKey(
                saveTarget
                  ? `Save to ${saveTarget.name} — or Save As / Save a Copy (right-click to change shortcut)`
                  : "Save — this drawing has no file yet, so Save will ask where to put it (right-click to change shortcut)",
                "file.save",
              )}
              data-testid="save-file"
              onClick={() => {
                setShowUpdateMenu(false);
                setShowSaveMenu((v) => !v);
              }}
              onContextMenu={rebind("file.save")}
            >
              <svg viewBox="0 0 24 24" width="18" height="18">
                <path
                  d="M5 3h11l3 3v13a2 2 0 01-2 2H5a2 2 0 01-2-2V5a2 2 0 012-2z"
                  stroke="currentColor"
                  strokeWidth="2"
                  fill="none"
                  strokeLinejoin="round"
                />
                <path d="M8 3v5h6V3M8 21v-6h8v6" stroke="currentColor" strokeWidth="2" fill="none" strokeLinejoin="round" />
              </svg>
            </button>
            {showSaveMenu && (
              <div className="action-menu" data-testid="save-menu">
                <div className="action-menu-caption" data-testid="save-target">
                  {saveTarget ? saveTarget.name : "Not saved to a file yet"}
                </div>
                <button
                  className="action-menu-default"
                  data-testid="save-now"
                  onClick={() => {
                    setShowSaveMenu(false);
                    void saveCurrent();
                  }}
                >
                  {saveTarget ? `Save to ${saveTarget.name}` : "Save..."}
                </button>
                <button
                  data-testid="save-as-dxf"
                  onClick={() => {
                    setShowSaveMenu(false);
                    void saveDrawing("dxf", undefined, "save-as");
                  }}
                >
                  Save As DXF 2018...
                </button>
                <button
                  data-testid="save-as-dxf-r12"
                  onClick={() => {
                    setShowSaveMenu(false);
                    void saveDrawing("dxf-r12", undefined, "save-as");
                  }}
                >
                  Save As DXF R12 (simple geometry, for CAM)...
                </button>
                <button
                  data-testid="save-as-dxf-r12-blocks"
                  onClick={() => {
                    setShowSaveMenu(false);
                    void saveDrawing("dxf-r12-blocks", undefined, "save-as");
                  }}
                >
                  Save As DXF R12 (keep blocks)...
                </button>
                <button
                  data-testid="save-as-svg"
                  onClick={() => {
                    setShowSaveMenu(false);
                    void saveDrawing("svg", undefined, "save-as");
                  }}
                >
                  Save As SVG...
                </button>
                <button
                  data-testid="save-as-svg-laser"
                  onClick={() => {
                    setShowSaveMenu(false);
                    void saveDrawing("svg-laser", undefined, "save-as");
                  }}
                >
                  Save As SVG for laser / CAM...
                </button>
                <button
                  data-testid="save-as-eps"
                  onClick={() => {
                    setShowSaveMenu(false);
                    void saveDrawing("eps", undefined, "save-as");
                  }}
                >
                  Save As EPS...
                </button>
                <button
                  data-testid="save-as-eps-preview"
                  onClick={() => {
                    setShowSaveMenu(false);
                    void saveDrawing("eps-preview", undefined, "save-as");
                  }}
                >
                  Save As EPS with TIFF preview...
                </button>
                <button
                  data-testid="save-copy-dxf"
                  onClick={() => {
                    setShowSaveMenu(false);
                    void saveDrawing("dxf", undefined, "save-copy");
                  }}
                >
                  Save a Copy as DXF 2018...
                </button>
                <button
                  data-testid="save-copy-dxf-r12"
                  onClick={() => {
                    setShowSaveMenu(false);
                    void saveDrawing("dxf-r12", undefined, "save-copy");
                  }}
                >
                  Save a Copy as DXF R12...
                </button>
                <button
                  data-testid="save-copy-dxf-r12-blocks"
                  onClick={() => {
                    setShowSaveMenu(false);
                    void saveDrawing("dxf-r12-blocks", undefined, "save-copy");
                  }}
                >
                  Save a Copy as DXF R12 (keep blocks)...
                </button>
                <button
                  data-testid="save-copy-svg"
                  onClick={() => {
                    setShowSaveMenu(false);
                    void saveDrawing("svg", undefined, "save-copy");
                  }}
                >
                  Save a Copy as SVG...
                </button>
                <button
                  data-testid="save-copy-svg-laser"
                  onClick={() => {
                    setShowSaveMenu(false);
                    void saveDrawing("svg-laser", undefined, "save-copy");
                  }}
                >
                  Save a Copy as SVG for laser / CAM...
                </button>
                <button
                  data-testid="save-copy-eps"
                  onClick={() => {
                    setShowSaveMenu(false);
                    void saveDrawing("eps", undefined, "save-copy");
                  }}
                >
                  Save a Copy as EPS...
                </button>
                <button
                  data-testid="save-copy-eps-preview"
                  onClick={() => {
                    setShowSaveMenu(false);
                    void saveDrawing("eps-preview", undefined, "save-copy");
                  }}
                >
                  Save a Copy as EPS with TIFF preview...
                </button>
                {listExporters().length > 0 && <div className="action-menu-sep" data-plugin-rev={pluginVersion} />}
                {listExporters().map((exp) => (
                  <button
                    key={exp.id}
                    data-testid={`plugin-export-${exp.id}`}
                    onClick={() => {
                      setShowSaveMenu(false);
                      void exportViaPlugin(exp.id, exp.extensions[0] ?? "txt");
                    }}
                  >
                    Export as {exp.title}...
                  </button>
                ))}
              </div>
            )}
          </div>
          <button
            className="action"
            title={withKey("Print / Save as PDF — right-click to change shortcut", "file.print")}
            data-testid="print"
            onClick={() => printDrawing()}
            onContextMenu={rebind("file.print")}
          >
            <svg viewBox="0 0 24 24" width="18" height="18">
              <path
                d="M6 9V3h12v6M6 18H4a2 2 0 01-2-2v-4a2 2 0 012-2h16a2 2 0 012 2v4a2 2 0 01-2 2h-2M6 14h12v7H6z"
                stroke="currentColor"
                strokeWidth="2"
                fill="none"
                strokeLinejoin="round"
              />
            </svg>
          </button>
          <div className="action-sep" />
          <button
            className="action"
            title={withKey("Undo — right-click to change shortcut", "edit.undo")}
            disabled={!bus.canUndo}
            data-testid="undo"
            onClick={() => bus.undo()}
            onContextMenu={rebind("edit.undo")}
          >
            <svg viewBox="0 0 24 24" width="18" height="18">
              <path
                d="M8 6L3 11l5 5M3.5 11H15a5 5 0 010 10h-3"
                stroke="currentColor"
                strokeWidth="2"
                fill="none"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </button>
          <button
            className="action"
            title={withKey("Redo — right-click to change shortcut", "edit.redo")}
            disabled={!bus.canRedo}
            data-testid="redo"
            onClick={() => bus.redo()}
            onContextMenu={rebind("edit.redo")}
          >
            <svg viewBox="0 0 24 24" width="18" height="18">
              <path
                d="M16 6l5 5-5 5M20.5 11H9a5 5 0 000 10h3"
                stroke="currentColor"
                strokeWidth="2"
                fill="none"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </button>
          <UpdateButton
            open={showUpdateMenu}
            onToggle={() => {
              setShowSaveMenu(false);
              setShowUpdateMenu((v) => !v);
            }}
          />
          <div className="action-sep" />
          <button
            className={`action ${showProps ? "toggled" : ""}`}
            title={withKey("Toggle properties panel — edit the selection's coordinates, radius, angles, text, layer and colour — right-click to add a shortcut", "app.toggleProperties")}
            data-testid="toggle-properties"
            onClick={() => setShowProps((v) => !v)}
            onContextMenu={rebind("app.toggleProperties")}
          >
            <svg viewBox="0 0 24 24" width="18" height="18">
              <path d="M4 6h16M4 12h10M4 18h13" stroke="currentColor" strokeWidth="1.8" fill="none" strokeLinecap="round" />
              <path d="M17 11l3 1-3 1z" fill="currentColor" />
            </svg>
          </button>
          <button
            className={`action ${showBlocks ? "toggled" : ""}`}
            title={withKey("Toggle block library panel - blocks in this drawing and your saved library - right-click to add a shortcut", "app.toggleBlocks")}
            data-testid="toggle-blocks"
            onClick={() => setShowBlocks((v) => !v)}
            onContextMenu={rebind("app.toggleBlocks")}
          >
            <svg viewBox="0 0 24 24" width="18" height="18">
              <rect x="4" y="4" width="16" height="16" rx="1.5" stroke="currentColor" strokeWidth="1.8" fill="none" strokeDasharray="3 2" />
              <path d="M9 12h6M12 9v6" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
            </svg>
          </button>
          <button
            className={`action ${showConstraints ? "toggled" : ""}`}
            title={withKey(
              "Toggle constraints panel — apply a constraint to the selection, and see what the sketch already has — right-click to add a shortcut",
              "app.toggleConstraints",
            )}
            data-testid="toggle-constraints"
            onClick={() => setShowConstraints((v) => !v)}
            onContextMenu={rebind("app.toggleConstraints")}
          >
            <svg viewBox="0 0 24 24" width="18" height="18">
              <path d="M5 19L19 5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
              <circle cx="5" cy="19" r="2.4" stroke="currentColor" strokeWidth="1.8" fill="none" />
              <circle cx="19" cy="5" r="2.4" stroke="currentColor" strokeWidth="1.8" fill="none" />
              <path d="M13 19h6M16 16v6" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
            </svg>
          </button>
          <button
            className={`action ${showVariables ? "toggled" : ""}`}
            title="Toggle variables panel — named parameters that dimensions can use in expressions"
            data-testid="toggle-variables"
            onClick={() => setShowVariables((v) => !v)}
          >
            <span style={{ fontWeight: 700, fontSize: 13 }}>x=</span>
          </button>
          <button
            className={`action ${showLayers ? "toggled" : ""}`}
            title={withKey(
              modelTab ? "Toggle structure panel — right-click to add a shortcut" : "Toggle layers panel — right-click to add a shortcut",
              "app.toggleLayers",
            )}
            data-testid="toggle-layers"
            onClick={() => setShowLayers((v) => !v)}
            onContextMenu={rebind("app.toggleLayers")}
          >
            <svg viewBox="0 0 24 24" width="18" height="18">
              <path
                d="M12 3l9 5-9 5-9-5 9-5zM3 13l9 5 9-5M3 17l9 5 9-5"
                stroke="currentColor"
                strokeWidth="1.8"
                fill="none"
                strokeLinejoin="round"
              />
            </svg>
          </button>
          <button
            className={`action ${showCode ? "toggled" : ""}`}
            title={withKey("Toggle sketch code panel — right-click to add a shortcut", "app.toggleCode")}
            data-testid="toggle-code"
            onClick={() => setShowCode((v) => !v)}
            onContextMenu={rebind("app.toggleCode")}
          >
            <svg viewBox="0 0 24 24" width="18" height="18">
              <path
                d="M9 6l-6 6 6 6M15 6l6 6-6 6"
                stroke="currentColor"
                strokeWidth="2"
                fill="none"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </button>
          <button
            className={`action ${showDiag ? "toggled" : ""}`}
            title="Toggle diagnostics (find & heal unjointed lines)"
            data-testid="toggle-diagnostics"
            onClick={() => setShowDiag((v) => !v)}
          >
            <svg viewBox="0 0 24 24" width="18" height="18">
              <path
                d="M12 2v6M12 16v6M2 12h6M16 12h6"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
              />
              <circle cx="12" cy="12" r="4" stroke="currentColor" strokeWidth="2" fill="none" />
            </svg>
          </button>
          <button
            className={`action ${showDup ? "toggled" : ""}`}
            title="Toggle duplicate/overlap detection (double circles, overlapping lines, line crossings)"
            data-testid="toggle-duplicates"
            onClick={() => setShowDup((v) => !v)}
          >
            <svg viewBox="0 0 24 24" width="18" height="18">
              <circle cx="9" cy="12" r="6" stroke="currentColor" strokeWidth="2" fill="none" />
              <circle cx="15" cy="12" r="6" stroke="currentColor" strokeWidth="2" fill="none" />
            </svg>
          </button>
          <button
            className={`action ${showPattern ? "toggled" : ""}`}
            title="Toggle pattern panel (repeat the selection in a grid or circle)"
            data-testid="toggle-pattern"
            onClick={() => setShowPattern((v) => !v)}
          >
            <svg viewBox="0 0 24 24" width="18" height="18">
              <circle cx="6" cy="6" r="2.2" fill="currentColor" />
              <circle cx="12" cy="6" r="2.2" fill="currentColor" />
              <circle cx="18" cy="6" r="2.2" fill="currentColor" />
              <circle cx="6" cy="12" r="2.2" fill="currentColor" />
              <circle cx="12" cy="12" r="2.2" fill="currentColor" />
              <circle cx="18" cy="12" r="2.2" fill="currentColor" />
              <circle cx="6" cy="18" r="2.2" fill="currentColor" />
              <circle cx="12" cy="18" r="2.2" fill="currentColor" />
              <circle cx="18" cy="18" r="2.2" fill="currentColor" />
            </svg>
          </button>
          <div className="action-menu-wrap">
            <button
              className={`action ${showPluginMenu ? "toggled" : ""}`}
              title="Plugins — run a plugin command or manage installed plugins"
              data-testid="plugin-menu"
              onClick={() => {
                setShowSaveMenu(false);
                setShowUpdateMenu(false);
                setShowPluginMenu((v) => !v);
              }}
            >
              <svg viewBox="0 0 24 24" width="18" height="18">
                <path
                  d="M10 3v4M14 3v4M6 7h12v5a6 6 0 01-12 0zM12 18v3"
                  stroke="currentColor"
                  strokeWidth="2"
                  fill="none"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            </button>
            {showPluginMenu && (
              <div className="action-menu" data-testid="plugin-menu-list" data-plugin-rev={pluginVersion}>
                <div className="action-menu-caption">Plugin commands</div>
                {listActions().length === 0 ? (
                  <div className="action-menu-caption" style={{ opacity: 0.6 }}>
                    No plugin commands — install a plugin below.
                  </div>
                ) : (
                  listActions().map((a) => (
                    <button
                      key={a.id}
                      data-testid={`plugin-cmd-${a.id}`}
                      onClick={() => {
                        setShowPluginMenu(false);
                        if (a.kind === "command") void runCommand(a.id);
                        else void runGenerator(a.id);
                      }}
                    >
                      {a.title}
                      {a.kind === "generator" && <span style={{ opacity: 0.5 }}> (selection)</span>}
                    </button>
                  ))
                )}
                <div className="action-menu-sep" />
                <button
                  data-testid="plugin-menu-manage"
                  onClick={() => {
                    setShowPluginMenu(false);
                    setShowPlugins(true);
                  }}
                >
                  Manage plugins…
                </button>
              </div>
            )}
          </div>
          <button
            className={`action ${showFiles ? "toggled" : ""}`}
            title="Toggle file browser"
            data-testid="toggle-file-browser"
            onClick={() => setShowFiles(!showFiles)}
          >
            <svg viewBox="0 0 24 24" width="18" height="18">
              <path
                d="M3 6a2 2 0 012-2h4l2 2h6a2 2 0 012 2v1H3zM3 9h18v9a2 2 0 01-2 2H5a2 2 0 01-2-2z"
                stroke="currentColor"
                strokeWidth="2"
                fill="none"
                strokeLinejoin="round"
              />
            </svg>
          </button>
          <button
            className={`action ${showConnectivityHint ? "toggled" : ""}`}
            title="Toggle connectivity hint — endpoints with nothing joined to them turn blue. This is NOT real constraint status (no solver yet), just a free-endpoint heuristic."
            data-testid="toggle-connectivity-hint"
            onClick={() => setShowConnectivityHint(!showConnectivityHint)}
          >
            <svg viewBox="0 0 24 24" width="18" height="18">
              <path
                d="M4 18L10 8l4 5 6-9"
                stroke="currentColor"
                strokeWidth="2"
                fill="none"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
              <circle cx="4" cy="18" r="1.8" fill="currentColor" />
              <circle cx="20" cy="4" r="1.8" fill="currentColor" />
            </svg>
          </button>
          <button
            className={`action ${showClosedRegions ? "toggled" : ""}`}
            title="Toggle closed-area highlight — tints any closed loop of lines/arcs/circles so you can see the profile is actually closed"
            data-testid="toggle-closed-regions"
            onClick={() => setShowClosedRegions(!showClosedRegions)}
          >
            <svg viewBox="0 0 24 24" width="18" height="18">
              <rect
                x="4"
                y="4"
                width="16"
                height="16"
                rx="2"
                stroke="currentColor"
                strokeWidth="2"
                fill="currentColor"
                fillOpacity="0.25"
              />
            </svg>
          </button>
          <div className="action-sep" />
          <button
            className="action"
            title={withKey("Truck Load Planner — right-click to add a shortcut", "app.truckNesting")}
            data-testid="truck-nesting-open"
            onClick={() => void runCommand("truck-nesting.open")}
            onContextMenu={rebind("app.truckNesting")}
          >
            <svg viewBox="0 0 24 24" width="18" height="18">
              <path
                d="M2 8h10v9H2zM12 11h5l4 4v2h-3M12 11v6h3M6 20a1.6 1.6 0 100-3.2 1.6 1.6 0 000 3.2zM17 20a1.6 1.6 0 100-3.2 1.6 1.6 0 000 3.2z"
                stroke="currentColor"
                strokeWidth="1.6"
                fill="none"
                strokeLinejoin="round"
              />
            </svg>
          </button>
          <button
            className={`action ${touchMode ? "toggled" : ""}`}
            title={
              touchMode
                ? "Touch mode is on: big tool buttons along the bottom. Click to switch back to the compact desktop layout"
                : "Touch mode: big finger-sized tool buttons along the bottom of the screen"
            }
            data-testid="toggle-touch-mode"
            onClick={toggleTouchMode}
          >
            <svg viewBox="0 0 24 24" width="18" height="18">
              <path
                d="M9 11V4.5a1.5 1.5 0 013 0V11m0-4a1.5 1.5 0 013 0v4m0-2a1.5 1.5 0 013 0v5.5c0 3.6-2.4 6.5-6 6.5-2.6 0-4-1.5-5.2-3.5L5 14.6a1.4 1.4 0 012.2-1.7L9 15"
                stroke="currentColor"
                strokeWidth="1.8"
                fill="none"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </button>
          <button
            className="action"
            title={withKey("Keyboard shortcuts — right-click to add a shortcut", "app.shortcuts")}
            data-testid="toggle-shortcuts"
            onClick={() => setShowShortcuts(true)}
            onContextMenu={rebind("app.shortcuts")}
          >
            <svg viewBox="0 0 24 24" width="18" height="18">
              <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="2" fill="none" />
              <path
                d="M9.5 9a2.5 2.5 0 114 2c-.6.6-1.5 1-1.5 2.2"
                stroke="currentColor"
                strokeWidth="2"
                fill="none"
                strokeLinecap="round"
              />
              <circle cx="12" cy="17" r="1.1" fill="currentColor" />
            </svg>
          </button>
          <div className="action-menu-wrap">
            <button
              className="action"
              title={`Theme: ${themeSetting} — click to change`}
              data-testid="toggle-theme-menu"
              onClick={() => setShowThemeMenu((v) => !v)}
            >
              <svg viewBox="0 0 24 24" width="18" height="18">
                <path
                  d="M12 3a9 9 0 100 18c.8 0 1-.6.6-1.2-.5-.7-.8-1.5-.6-2.3.3-1 1.3-1.5 2.3-1.5h1.9c2 0 3.3-2.1 2.4-3.9C17.3 9.4 15 8 12 8a6 6 0 00-5 2.7"
                  stroke="currentColor"
                  strokeWidth="1.8"
                  fill="none"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
                <circle cx="8.5" cy="10.5" r="1" fill="currentColor" />
                <circle cx="12" cy="7" r="1" fill="currentColor" />
              </svg>
            </button>
            {showThemeMenu && <ThemePicker onClose={() => setShowThemeMenu(false)} />}
          </div>
        </div>
        <div className="hint">{TOOL_HINTS[tool]}</div>
      </header>

      <UpdateBanner />
      <MetricsNotice />
      <ImportReportBanner />

      <div className="body">
        {!touchMode && <ToolRail layout="side" rebind={rebind} />}
        <FileExplorerPanel hidden={!showFiles} onClose={() => setShowFiles(false)} />
        {/* Plugin panels dock on the left, next to the file browser. */}
        {showPlugins && <PluginsPanel onClose={() => setShowPlugins(false)} />}
        <PluginPanels />
        <div className="center">
          <TabStrip />
          <main className="stage">
            {modelTab && activeSession ? (
              <Suspense fallback={<div className="model-stage" />}>
                <ModelViewport session={activeSession} />
              </Suspense>
            ) : (
              <>
                <Viewport />
                {tool === "straighten" && <StraightenPanel />}
                {tool === "fill" && <HatchPanel />}
                {tool === "block" && <BlockPanel />}
                {tool === "insert" && <InsertPanel />}
                {tool === "attdef" && <AttdefPanel />}
                <AttEditDialog />
                <BlockEditBar />
                {tool === "text" && <TextPanel />}
              </>
            )}
          </main>
        </div>
        {showDiag && <DiagnosticsPanel onClose={() => setShowDiag(false)} />}
        {showDup && <DuplicatesPanel onClose={() => setShowDup(false)} />}
        {showPattern && <PatternPanel onClose={() => setShowPattern(false)} />}
        {showCode && <CodePanel />}
        {showProps && !modelTab && <PropertiesPanel onClose={() => setShowProps(false)} />}
        {showConstraints && !modelTab && <ConstraintPanel onClose={() => setShowConstraints(false)} />}
        {showVariables && !modelTab && <VariablesPanel onClose={() => setShowVariables(false)} />}
        {showBlocks && !modelTab && <BlockLibraryPanel onClose={() => setShowBlocks(false)} />}
        {/* Rightmost panel: layers for a drawing, the assembly structure for a model. */}
        {showLayers &&
          (modelTab && activeSession?.model ? (
            <Suspense fallback={<aside className="layerpanel" />}>
              <StructurePanel model={activeSession.model} />
            </Suspense>
          ) : (
            !modelTab && <LayerPanel />
          ))}
      </div>

      {/* Touch mode: the drawing tools sit along the bottom edge, where thumbs are. A model tab has its own. */}
      {touchMode && !modelTab && <ToolRail layout="bottom" rebind={rebind} />}

      <footer className="statusbar" data-revision={revision}>
        <span data-testid="coords">
          {cursor ? `${formatLength(cursor.x, displayUnit)}, ${formatLength(cursor.y, displayUnit)}` : "--, --"}
        </span>
        <span>{Math.round(zoom * 100)}%</span>
        {hatchTinted && (
          <span data-testid="hatch-tinted" title="Hatch lines closer than a few pixels (or too many to draw) are shown as an average tone; zoom in to see the pattern">
            Hatch shown as tint
          </span>
        )}
        <select
          className="unit-select"
          data-testid="unit-select"
          title="Display unit"
          value={displayUnit}
          onChange={(e) => setDisplayUnit(e.target.value as DisplayUnit)}
        >
          {DISPLAY_UNITS.map((u) => (
            <option key={u.id} value={u.id}>
              {u.label}
            </option>
          ))}
        </select>
        {!modelTab && (
          <span className="tracking-toggles" data-testid="tracking-toggles">
            <button
              className={`tracking-toggle ${ortho ? "active" : ""}`}
              title={withKey("Ortho: constrain the next point to 0/90/180/270° from the last one — Shift held does the same temporarily", "view.ortho")}
              data-testid="toggle-ortho"
              onClick={toggleOrtho}
              onContextMenu={rebind("view.ortho")}
            >
              ORTHO
            </button>
            <button
              className={`tracking-toggle ${polar ? "active" : ""}`}
              title={withKey("Polar tracking: snap the next point to angle increments from the last one", "view.polar")}
              data-testid="toggle-polar"
              onClick={togglePolar}
              onContextMenu={rebind("view.polar")}
            >
              POLAR
            </button>
            <button
              className={`tracking-toggle ${otrack ? "active" : ""}`}
              title={withKey(
                "Object snap tracking: hover a corner or centre to acquire it, then line up with it from anywhere",
                "view.otrack",
              )}
              data-testid="toggle-otrack"
              onClick={toggleOtrack}
              onContextMenu={rebind("view.otrack")}
            >
              TRACK
            </button>
            <button
              className={`tracking-toggle ${autoConstrain ? "active" : ""}`}
              title="Auto-constraints: while drawing, snaps add coincident / horizontal / vertical / midpoint / perpendicular / tangent constraints (hold Ctrl to suppress)"
              data-testid="toggle-autocon"
              onClick={() => setAutoConstrain(!autoConstrain)}
            >
              AUTOCON
            </button>
            <button
              className={`tracking-toggle ${drawingMode === "sketch" ? "active" : ""}`}
              title="Sketch mode (auto-constraints on, dimensions driving) vs Drafting mode (AutoCAD feel: off, annotation)"
              data-testid="toggle-drawing-mode"
              onClick={() => setDrawingMode(drawingMode === "sketch" ? "drafting" : "sketch")}
            >
              {drawingMode === "sketch" ? "SKETCH" : "DRAFT"}
            </button>
            <SnapPopover />
            <SelectByPopover />
            <button
              className={`tracking-toggle ${commandLine ? "active" : ""}`}
              title={withKey("Command line: type tool aliases, commands and coordinates", "view.commandLine")}
              data-testid="toggle-command-line"
              onClick={toggleCommandLine}
              onContextMenu={rebind("view.commandLine")}
            >
              CMD
            </button>
            {polar && (
              <select
                className="unit-select"
                title="Polar increment"
                data-testid="polar-increment"
                value={polarIncrement}
                onChange={(e) => setPolarIncrement(Number(e.target.value))}
              >
                {POLAR_INCREMENTS.map((deg) => (
                  <option key={deg} value={deg}>
                    {deg}°
                  </option>
                ))}
              </select>
            )}
          </span>
        )}
        <span data-testid="entity-count">{modelTab ? "3D model (view-only)" : `${doc.all().length} entities`}</span>
        {!modelTab && solve && (
          <span
            className={`solve-state ${solve.status}`}
            data-testid="solve-state"
            title={
              solve.status === "over-constrained"
                ? `These constraints can't all hold at once: ${solve.conflicts.map(constraintName).join(", ")}`
                : solve.status === "fully-constrained"
                  ? "Fully constrained — every degree of freedom is accounted for"
                  : `${solve.dof} degree${solve.dof === 1 ? "" : "s"} of freedom left${solve.redundant.length > 0 ? ` · redundant: ${solve.redundant.map(constraintName).join(", ")}` : ""}`
            }
          >
            {solve.status === "over-constrained"
              ? `⚠ ${solve.conflicts.length} conflicting`
              : solve.status === "fully-constrained"
                ? "fully constrained"
                : `${solve.dof} DOF`}
          </span>
        )}
        {prompt && !modelTab && (
          <span className="tool-prompt" data-testid="tool-prompt">
            {prompt}
          </span>
        )}
        {saveNotice && (
          <span
            className={saveNotice.kind === "error" ? "save-notice error" : "save-notice"}
            data-testid="save-notice"
          >
            {saveNotice.message}
          </span>
        )}
        <span data-testid="selection-hint">{selectionLabel(selection)}</span>
        {selectionMeasurement && (
          <button
            type="button"
            className="measure-readout selection-readout"
            title="Click to copy"
            data-testid="selection-measure-readout"
            onClick={copySelectionMeasurement}
          >
            {justCopiedSelection ? "Copied" : measurementText(selectionMeasurement, displayUnit)}
          </button>
        )}
        {measurement && (
          <span className="measure-readout" data-testid="measure-readout">
            {measurementText(measurement, displayUnit, referenceAngleDeg)}
            <button
              className="measure-copy"
              title="Copy measurement (Ctrl+C)"
              data-testid="measure-copy"
              onClick={copyMeasurement}
            >
              {justCopied ? "Copied" : "Copy"}
            </button>
            <button
              className="measure-copy"
              title="Pin this measurement so it stays on screen (Enter)"
              data-testid="measure-pin"
              onClick={pinMeasurement}
            >
              Pin
            </button>
          </span>
        )}
        {pinnedMeasurements.length > 0 && (
          <span className="measure-readout" data-testid="measure-pinned-count">
            {pinnedMeasurements.length} pinned
            <button
              className="measure-copy"
              title="Clear pinned measurements"
              data-testid="measure-clear-pins"
              onClick={clearPinnedMeasurements}
            >
              Clear
            </button>
          </span>
        )}
        {showConnectivityHint && (
          <span
            className="connectivity-readout"
            data-testid="connectivity-readout"
            title="Free-endpoint heuristic, not real constraint status — see the toggle's tooltip"
          >
            {freeEndpointCount === 0 ? "No free endpoints (hint)" : `${freeEndpointCount} with a free endpoint (hint)`}
          </span>
        )}
      </footer>

      <PluginCommandPalette open={showPalette} onClose={() => setShowPalette(false)} />
      <DimStyleManager />
      <MTextEditor />
      <ShortcutsPanel open={showShortcuts} onClose={() => setShowShortcuts(false)} />
      {rebindTarget && (
        <RebindPopover
          actionId={rebindTarget.actionId}
          x={rebindTarget.x}
          y={rebindTarget.y}
          onClose={() => setRebindTarget(null)}
        />
      )}
    </div>
  );
}
