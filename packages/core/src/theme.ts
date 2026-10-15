/**
 * Z-03: theme tokens. Two consumers that used to hard-code colour
 * independently — `viewport/renderer.ts`'s `COLORS` object and
 * `styles.css`'s `:root` variables — now both read from one `ThemeTokens`
 * value, so a theme (built-in or, later, a TH-01 theme plugin) changes
 * every surface at once instead of three.
 *
 * `DEFAULT_DARK` is byte-identical to today's hard-coded values (the
 * renderer's old `COLORS`, `styles.css`'s old `:root`, and
 * `model3d/modelScene.ts`'s old `STAGE_BACKGROUND`/`EDGE_COLOR`/
 * `SELECT_COLOR`) — switching the app to read through this module must not
 * change a single pixel of the existing dark theme.
 *
 * `model3d` is deliberately the *same* object in both themes: a part with
 * no explicit colour gets one baked into its mesh at import time
 * (`buildModel.ts`'s `DEFAULT_COLOR`, a light gray) and isn't re-baked when
 * the theme changes, so a light stage would wash it out. Real per-theme 3D
 * colour needs that baked-colour architecture to change first — out of
 * scope here, tracked informally alongside Z-03 rather than under a new id.
 */

export interface UiTokens {
  bg: string;
  panel: string;
  border: string;
  text: string;
  textDim: string;
  accent: string;
  accentSoft: string;
  danger: string;
}

export interface CanvasTokens {
  bg: string;
  gridMinor: string;
  gridMajor: string;
  axis: string;
  entity: string;
  selected: string;
  preview: string;
  snap: string;
  handle: string;
  measure: string;
  hover: string;
  measureLabelBg: string;
  reference: string;
  connectivityHint: string;
  windowSelect: string;
  crossingSelect: string;
  closedRegionFill: string;
  duplicateMarker: string;
  crossingMarker: string;
  /** T-44: geometry the constraints leave free to move. */
  dofUnder: string;
  /** T-44: geometry held by constraints that cannot all hold. */
  dofConflict: string;
  origin: string;
  originOff: string;
  axisX: string;
  axisY: string;
}

export interface Model3dTokens {
  bg: string;
  edge: string;
  highlight: string;
  hover: string;
}

/** Reserved for a future syntax-highlighted sketch-code view (no consumer reads this yet). */
export interface CodeTokens {
  keyword: string;
  number: string;
  comment: string;
  error: string;
}

export interface FontTokens {
  ui?: string;
  mono?: string;
}

export interface ThemeTokens {
  ui: UiTokens;
  canvas: CanvasTokens;
  model3d: Model3dTokens;
  code: CodeTokens;
  fonts?: FontTokens;
}

export type ThemeMode = "dark" | "light";

const MODEL3D: Model3dTokens = {
  bg: "#17181c",
  edge: "#1c1d21",
  highlight: "#5a8dff",
  // SELECT_COLOR washed 45% toward white — see the old ModelViewport.tsx HOVER_RGB formula.
  hover: "#a4c0ff",
};

const CODE_DARK: CodeTokens = {
  keyword: "#61afef",
  number: "#d19a66",
  comment: "#6b7280",
  error: "#e06c75",
};

const CODE_LIGHT: CodeTokens = {
  keyword: "#1a73c7",
  number: "#a35a00",
  comment: "#6b7280",
  error: "#c0392b",
};

export const DEFAULT_DARK: ThemeTokens = {
  ui: {
    bg: "#1e2025",
    panel: "#24262c",
    border: "#33363e",
    text: "#e8e9ec",
    textDim: "#9a9da6",
    accent: "#3574f0",
    accentSoft: "#2c3d63",
    danger: "#e06c75",
  },
  canvas: {
    bg: "#17181c",
    gridMinor: "#212329",
    gridMajor: "#2b2e36",
    axis: "#3d4250",
    entity: "#e8e9ec",
    selected: "#5b96ff",
    preview: "#5b96ff",
    snap: "#ffb02e",
    handle: "#5b96ff",
    measure: "#5ad1c5",
    hover: "#8fd9ff",
    measureLabelBg: "#0c2b28",
    reference: "#ff5c5c",
    connectivityHint: "#4d7ac7",
    windowSelect: "#5b96ff",
    crossingSelect: "#5adc7a",
    closedRegionFill: "rgba(180, 190, 205, 0.16)",
    duplicateMarker: "#f0b968",
    crossingMarker: "#c77dff",
    dofUnder: "#38b6ff",
    dofConflict: "#ff4d4d",
    origin: "#9aa4b8",
    originOff: "#4a5165",
    axisX: "#e06c75",
    axisY: "#7ec96f",
  },
  model3d: MODEL3D,
  code: CODE_DARK,
};

export const DEFAULT_LIGHT: ThemeTokens = {
  ui: {
    bg: "#f3f4f6",
    panel: "#ffffff",
    border: "#d6d9de",
    text: "#1c1e22",
    textDim: "#6b7280",
    accent: "#2f63d6",
    accentSoft: "#dce6fb",
    danger: "#c0392b",
  },
  canvas: {
    bg: "#fbfbfc",
    gridMinor: "#e5e7eb",
    gridMajor: "#d3d6db",
    axis: "#b7bcc6",
    // DXF colour 7 convention: the default entity colour inverts with the theme (black on white here, white on black in dark).
    entity: "#202329",
    selected: "#2f63d6",
    preview: "#2f63d6",
    snap: "#b56a00",
    handle: "#2f63d6",
    measure: "#0f8f82",
    hover: "#2e9bdb",
    measureLabelBg: "#e3f7f4",
    reference: "#d1383f",
    connectivityHint: "#3f66a8",
    windowSelect: "#2f63d6",
    crossingSelect: "#2f9e4f",
    closedRegionFill: "rgba(60, 70, 90, 0.08)",
    duplicateMarker: "#b5731f",
    crossingMarker: "#7a3fc2",
    dofUnder: "#0b6fd0",
    dofConflict: "#d02020",
    origin: "#4b4f5a",
    originOff: "#b7bcc6",
    axisX: "#c0392b",
    axisY: "#2e7d32",
  },
  model3d: MODEL3D,
  code: CODE_LIGHT,
};

export function defaultTheme(mode: ThemeMode): ThemeTokens {
  return mode === "light" ? DEFAULT_LIGHT : DEFAULT_DARK;
}
