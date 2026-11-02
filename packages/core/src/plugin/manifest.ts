import type { Permission } from "./capabilities";
import { isPermission, PERMISSIONS } from "./capabilities";

/**
 * A plugin's `manifest.json`. The contract the host reads to decide whether it
 * can load a plugin (`engines.sketchor` vs. the host API version), what the
 * plugin contributes, and what permissions to prompt for. See
 * `docs/plugin-architecture.md` §5.
 */
export interface PluginManifest {
  /** Reverse-DNS unique id, e.g. "com.acme.gear-generator". */
  id: string;
  /** Plugin semver. */
  version: string;
  /** Display name. */
  name: string;
  description?: string;
  publisher?: string;
  /** Host-compatibility ranges. `sketchor` is a semver range over the host API version. */
  engines: { sketchor: string };
  /** Entry module for the plugin's logic (runs in the worker sandbox). Absent only on a theme-only plugin (TH-02). */
  main?: string;
  /** Optional entry HTML for a sandboxed-iframe UI panel. */
  ui?: string;
  contributes?: PluginContributions;
  permissions?: Permission[];
}

/** What a plugin adds to the host. Each kind is routed into a host registry. */
export interface PluginContributions {
  commands?: CommandContribution[];
  /** Selection-in → Command[]-out geometry generators (like the built-in pattern). */
  generators?: GeneratorContribution[];
  /** Import/export format handlers, listed next to the built-in DXF/SVG. */
  io?: IoContribution[];
  /** Sandboxed-iframe UI panels. */
  panels?: PanelContribution[];
  /**
   * Interactive drawing tools. Reserved for v2 — the viewport's tool loop must
   * be decoupled first (see `docs/plugin-v1-plan.md`). Declaring one in v1 is a
   * load-time error.
   */
  tools?: ToolContribution[];
  /** Colour themes (TH-02): data-only JSON files in the bundle, validated by `validateTheme`. */
  themes?: ThemeContribution[];
  /** Hatch patterns (H-06): data-only `.pat` files in the bundle, parsed by `parsePat`. */
  hatchPatterns?: HatchPatternContribution[];
  /** Block libraries (B-24): data-only `.dxf` / `.sketchor` files whose blocks join the "Sketchor library" panel. */
  blocks?: BlockContribution[];
}

export interface BlockContribution {
  /** Bundle-relative path of a `.dxf` or `.sketchor` file, e.g. "blocks/doors.dxf". Each named block in it becomes a library entry (a file with no blocks becomes one block). */
  file: string;
  /** Library category the blocks are listed under (default: the plugin's name). */
  category?: string;
}

export interface HatchPatternContribution {
  /** Bundle-relative path of the `.pat` file, e.g. "patterns/materials.pat". May hold several patterns. */
  file: string;
  /** Library category the patterns are listed under (default: the plugin's name). */
  category?: string;
}

export interface ThemeContribution {
  id: string;
  title: string;
  /** Bundle-relative path of the `.json` theme file, e.g. "themes/nord.json". */
  file: string;
}

export interface CommandContribution {
  /** Namespaced id, e.g. "gear.generate". */
  id: string;
  title: string;
  /** Optional icon token or data-URI. */
  icon?: string;
}

export interface GeneratorContribution {
  id: string;
  title: string;
  icon?: string;
}

export interface IoContribution {
  id: string;
  title: string;
  /** "import", "export", or both. */
  direction: ("import" | "export")[];
  /** File extensions this handler claims, without the dot, e.g. ["gcode"]. */
  extensions: string[];
}

export interface PanelContribution {
  id: string;
  title: string;
  icon?: string;
}

export interface ToolContribution {
  id: string;
  title: string;
  icon?: string;
}

export type ManifestValidation =
  | { ok: true; manifest: PluginManifest }
  | { ok: false; errors: string[] };

const ID_RE = /^[a-z0-9]+(?:[-.][a-z0-9]+)*$/i;
const SEMVER_RE = /^\d+\.\d+\.\d+(?:[-+].+)?$/;

/**
 * Validates an untrusted parsed-JSON value as a {@link PluginManifest}.
 * Hand-rolled so `@sketchor/core` stays dependency-free. Collects every problem
 * rather than throwing on the first, so an author sees all of them at once.
 */
export function validateManifest(value: unknown): ManifestValidation {
  const errors: string[] = [];
  const obj = isRecord(value) ? value : (errors.push("manifest must be an object"), {} as Record<string, unknown>);

  requireString(obj, "id", errors, ID_RE, "reverse-DNS style (letters, digits, '-' and '.')");
  requireString(obj, "version", errors, SEMVER_RE, "a semver like 1.2.0");
  requireString(obj, "name", errors);
  const themeOnly = isThemeOnly(obj as unknown as PluginManifest);
  if (themeOnly) {
    if (obj.main !== undefined) errors.push('a theme-only plugin must not declare "main"');
  } else if (!isPatternOnly(obj as unknown as PluginManifest) && !isBlocksOnly(obj as unknown as PluginManifest)) {
    requireString(obj, "main", errors);
  }
  optionalString(obj, "description", errors);
  optionalString(obj, "publisher", errors);
  optionalString(obj, "ui", errors);

  const engines = obj.engines;
  if (!isRecord(engines) || typeof engines.sketchor !== "string" || engines.sketchor.length === 0) {
    errors.push('"engines.sketchor" is required and must be a semver range string');
  }

  if (obj.permissions !== undefined) {
    if (!Array.isArray(obj.permissions)) {
      errors.push('"permissions" must be an array');
    } else {
      for (const p of obj.permissions) {
        if (!isPermission(p)) errors.push(`unknown permission "${String(p)}" (valid: ${PERMISSIONS.join(", ")})`);
      }
    }
  }

  const contributes = obj.contributes;
  if (contributes !== undefined) {
    if (!isRecord(contributes)) {
      errors.push('"contributes" must be an object');
    } else if (Array.isArray(contributes.tools) && contributes.tools.length > 0) {
      errors.push('"contributes.tools" is reserved for a future version and cannot be used yet');
    }
    if (isRecord(contributes) && contributes.themes !== undefined) validateThemeContributions(contributes.themes, errors);
    if (isRecord(contributes) && contributes.hatchPatterns !== undefined) validateHatchPatternContributions(contributes.hatchPatterns, errors);
    if (isRecord(contributes) && contributes.blocks !== undefined) validateBlockContributions(contributes.blocks, errors);
  }

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, manifest: value as PluginManifest };
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function requireString(
  obj: Record<string, unknown>,
  key: string,
  errors: string[],
  pattern?: RegExp,
  hint?: string,
): void {
  const v = obj[key];
  if (typeof v !== "string" || v.length === 0) {
    errors.push(`"${key}" is required and must be a non-empty string`);
    return;
  }
  if (pattern && !pattern.test(v)) errors.push(`"${key}" must be ${hint ?? `of the form ${pattern}`}`);
}

function optionalString(obj: Record<string, unknown>, key: string, errors: string[]): void {
  if (obj[key] !== undefined && typeof obj[key] !== "string") errors.push(`"${key}" must be a string when present`);
}

const THEME_ID_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;

function validateThemeContributions(v: unknown, errors: string[]): void {
  if (!Array.isArray(v)) {
    errors.push('"contributes.themes" must be an array');
    return;
  }
  const seen = new Set<string>();
  v.forEach((t, i) => {
    const at = `contributes.themes[${i}]`;
    if (!isRecord(t)) return void errors.push(`"${at}" must be an object`);
    if (typeof t.id !== "string" || !THEME_ID_RE.test(t.id)) errors.push(`"${at}.id" must be lowercase letters, digits, '.', '_' or '-'`);
    else if (seen.has(t.id)) errors.push(`"${at}.id" duplicates another theme id`);
    else seen.add(t.id);
    if (typeof t.title !== "string" || !t.title.trim()) errors.push(`"${at}.title" is required`);
    if (typeof t.file !== "string" || !isSafeBundlePath(t.file)) {
      errors.push(`"${at}.file" must be a relative .json path inside the bundle (no "..", no leading "/")`);
    }
  });
}

function validateHatchPatternContributions(v: unknown, errors: string[]): void {
  if (!Array.isArray(v)) {
    errors.push('"contributes.hatchPatterns" must be an array');
    return;
  }
  v.forEach((t, i) => {
    const at = `contributes.hatchPatterns[${i}]`;
    if (!isRecord(t)) return void errors.push(`"${at}" must be an object`);
    if (typeof t.file !== "string" || !isSafeBundlePath(t.file, "pat")) {
      errors.push(`"${at}.file" must be a relative .pat path inside the bundle (no "..", no leading "/")`);
    }
    if (t.category !== undefined && (typeof t.category !== "string" || !t.category.trim() || t.category.length > 40)) {
      errors.push(`"${at}.category" must be a short non-empty string when present`);
    }
  });
}

function validateBlockContributions(v: unknown, errors: string[]): void {
  if (!Array.isArray(v)) {
    errors.push('"contributes.blocks" must be an array');
    return;
  }
  v.forEach((t, i) => {
    const at = `contributes.blocks[${i}]`;
    if (!isRecord(t)) return void errors.push(`"${at}" must be an object`);
    if (typeof t.file !== "string" || !isSafeBundlePath(t.file, "block")) {
      errors.push(`"${at}.file" must be a relative .dxf or .sketchor path inside the bundle (no "..", no leading "/")`);
    }
    if (t.category !== undefined && (typeof t.category !== "string" || !t.category.trim() || t.category.length > 40)) {
      errors.push(`"${at}.category" must be a short non-empty string when present`);
    }
  });
}

/** A bundle-relative `.json` (or `.pat`; `.dxf`/`.sketchor` for "block") path that cannot climb out of the bundle. */
export function isSafeBundlePath(p: string, ext: "json" | "pat" | "block" = "json"): boolean {
  return (
    p.length <= 200 &&
    (ext === "pat" ? /\.pat$/i : ext === "block" ? /\.(dxf|sketchor)$/i : /\.json$/i).test(p) &&
    !p.startsWith("/") &&
    !p.includes("\\") &&
    !/^[a-z]:/i.test(p) &&
    p.split("/").every((seg) => seg !== "" && seg !== "." && seg !== "..")
  );
}

/**
 * A plugin that contributes themes and nothing that runs: no entry module, UI,
 * permissions, or other contribution kinds. Such a bundle is data, so it may be
 * installed unsigned (decided 2026-09-28); anything with code must be signed.
 */
export function isThemeOnly(m: Pick<PluginManifest, "contributes" | "main" | "ui" | "permissions">): boolean {
  const c = m.contributes;
  if (!c || !Array.isArray(c.themes) || c.themes.length === 0) return false;
  if (m.ui !== undefined || (m.permissions?.length ?? 0) > 0) return false;
  return Object.entries(c).every(([k, v]) => k === "themes" || (Array.isArray(v) && v.length === 0));
}

/** B-24: a plugin that contributes block libraries and nothing that runs. Data (a DXF/.sketchor is parsed, never executed), so it installs unsigned like a theme. */
export function isBlocksOnly(m: Pick<PluginManifest, "contributes" | "main" | "ui" | "permissions">): boolean {
  const c = m.contributes;
  if (!c || !Array.isArray(c.blocks) || c.blocks.length === 0) return false;
  if (m.main !== undefined || m.ui !== undefined || (m.permissions?.length ?? 0) > 0) return false;
  return Object.entries(c).every(([k, v]) => k === "blocks" || (Array.isArray(v) && v.length === 0));
}

/** H-06: a plugin that contributes hatch patterns and nothing that runs. Data, so it installs unsigned like a theme. */
export function isPatternOnly(m: Pick<PluginManifest, "contributes" | "main" | "ui" | "permissions">): boolean {
  const c = m.contributes;
  if (!c || !Array.isArray(c.hatchPatterns) || c.hatchPatterns.length === 0) return false;
  if (m.main !== undefined || m.ui !== undefined || (m.permissions?.length ?? 0) > 0) return false;
  return Object.entries(c).every(([k, v]) => k === "hatchPatterns" || (Array.isArray(v) && v.length === 0));
}
