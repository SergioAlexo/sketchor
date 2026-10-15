import type { ToolId } from "../state/store";

/**
 * The command line (roadmap T-08): the typed half of CAD, which AutoCAD
 * and LibreCAD users reach for before the toolbar. `l` starts a line,
 * `o 5` starts an offset of 5, `100,50` places a point, `u` undoes. It is
 * also the natural home for the AI assistant later — one text box that
 * already knows how to turn a string into an action.
 *
 * Pure: parsing is separate from doing, so the alias table can be tested
 * (and read) without a canvas. Aliases follow AutoCAD's where AutoCAD has
 * one, because that is what the muscle memory expects.
 */

export type AppCommandId =
  | "undo"
  | "redo"
  | "delete"
  | "selectAll"
  | "invertSelection"
  | "selectSimilar"
  | "join"
  | "explode"
  | "simplify"
  | "group"
  | "ungroup"
  | "fit"
  | "zoomPrevious"
  | "relativeZero"
  | "save"
  | "open"
  | "cancel"
  | "blockEdit"
  | "blockSave"
  | "blockClose"
  | "attEdit"
  | "attExport"
  | "dimStyles";

export type ParsedCommand =
  /** Activate a tool; `argument` is the rest of the line (a radius, a distance), passed on as typed input. */
  | { kind: "tool"; tool: ToolId; argument: string | null }
  | { kind: "app"; id: AppCommandId; argument?: string }
  /** Not a command — a coordinate or length for whatever tool is active. */
  | { kind: "point"; text: string }
  | { kind: "empty" }
  | { kind: "unknown"; text: string };

/**
 * Tool aliases, AutoCAD's where they exist (`l`, `pl`, `c`, `a`, `rec`,
 * `co`, `mi`, `ro`, `sc`, `o`, `tr`, `f`, `cha`, `s`, `div`), plus the full
 * tool name for everything.
 */
export const TOOL_ALIASES: Record<string, ToolId> = {
  // draw
  l: "line",
  line: "line",
  pl: "polyline",
  polyline: "polyline",
  rec: "rectangle",
  rect: "rectangle",
  rectangle: "rectangle",
  c: "circle",
  circle: "circle",
  a: "arc",
  arc: "arc",
  el: "ellipse",
  ellipse: "ellipse",
  spl: "spline",
  spline: "spline",
  spe: "splinedit",
  splinedit: "splinedit",
  rebuild: "splinedit",
  pol: "polygon",
  polygon: "polygon",
  slot: "slot",
  po: "point",
  point: "point",
  t: "text",
  text: "text",
  mt: "mtext",
  mtext: "mtext",
  dim: "dim",
  dimension: "dim",
  dli: "dimlinear",
  dimlinear: "dimlinear",
  dal: "dimaligned",
  dimaligned: "dimaligned",
  dan: "dimangular",
  dimangular: "dimangular",
  dra: "dimradial",
  dimradius: "dimradial",
  ddi: "dimdiametric",
  dimdiameter: "dimdiametric",
  dar: "dimarc",
  dimarc: "dimarc",
  dor: "dimordinate",
  dimordinate: "dimordinate",
  djo: "dimjogged",
  dimjogged: "dimjogged",
  dba: "dimbaseline",
  dimbaseline: "dimbaseline",
  dco: "dimcontinue",
  dimcontinue: "dimcontinue",
  qdim: "qdim",
  h: "fill",
  hatch: "fill",
  fill: "fill",
  img: "image",
  image: "image",
  // modify
  m: "move",
  move: "move",
  co: "copy",
  cp: "copy",
  copy: "copy",
  ro: "rotate",
  rotate: "rotate",
  sc: "scale",
  scale: "scale",
  mi: "mirror",
  mirror: "mirror",
  o: "offset",
  offset: "offset",
  tr: "trim",
  trim: "trim",
  br: "split",
  split: "split",
  f: "fillet",
  fillet: "fillet",
  cha: "chamfer",
  chamfer: "chamfer",
  s: "stretch",
  stretch: "stretch",
  len: "lengthen",
  lengthen: "lengthen",
  al: "align",
  align: "align",
  ma: "match",
  match: "match",
  div: "divide",
  b: "block",
  bbase: "blockbase",
  i: "insert",
  insert: "insert",
  att: "attdef",
  attdef: "attdef",
  block: "block",
  divide: "divide",
  // select / view / measure
  se: "select",
  select: "select",
  di: "measure",
  measure: "measure",
  pan: "pan",
  z: "zoom",
  zoom: "zoom",
  straighten: "straighten",
};

/** Commands that aren't tools: the things a toolbar button or a shortcut does. */
export const APP_ALIASES: Record<string, AppCommandId> = {
  u: "undo",
  undo: "undo",
  redo: "redo",
  e: "delete",
  erase: "delete",
  del: "delete",
  delete: "delete",
  all: "selectAll",
  selectall: "selectAll",
  invert: "invertSelection",
  similar: "selectSimilar",
  j: "join",
  join: "join",
  x: "explode",
  explode: "explode",
  simplify: "simplify",
  g: "group",
  group: "group",
  ung: "ungroup",
  ungroup: "ungroup",
  fit: "fit",
  ze: "fit",
  zp: "zoomPrevious",
  rz: "relativeZero",
  save: "save",
  open: "open",
  esc: "cancel",
  cancel: "cancel",
  bedit: "blockEdit",
  refedit: "blockEdit",
  bsave: "blockSave",
  bclose: "blockClose",
  attedit: "attEdit",
  ate: "attEdit",
  attout: "attExport",
  eattext: "attExport",
  dimstyle: "dimStyles",
  ddim: "dimStyles",
  dimstyles: "dimStyles",
};

/** Anything that looks like a coordinate or a measurement rather than a word. */
function looksNumeric(text: string): boolean {
  return /^[@\-.\d]/.test(text);
}

/**
 * Turns one line of input into an action. Case and surrounding space don't
 * matter; a word and its argument are split on the first run of spaces
 * (`o 5`, `f 2.5`), so a coordinate keeps its own commas and `<`.
 */
export function parseCommand(text: string): ParsedCommand {
  const trimmed = text.trim();
  if (trimmed === "") return { kind: "empty" };
  if (looksNumeric(trimmed)) return { kind: "point", text: trimmed };

  const match = /^(\S+)(?:\s+(.*))?$/.exec(trimmed);
  if (!match) return { kind: "unknown", text: trimmed };
  const word = match[1].toLowerCase();
  const argument = match[2]?.trim() || null;

  const app = APP_ALIASES[word];
  if (app) return argument ? { kind: "app", id: app, argument } : { kind: "app", id: app };
  const tool = TOOL_ALIASES[word];
  // `rebuild 8` is the spline-edit tool's own typed command, so the verb stays part of its argument.
  if (tool) return { kind: "tool", tool, argument: word === "rebuild" ? `rebuild${argument ? " " + argument : ""}` : argument };
  return { kind: "unknown", text: trimmed };
}

/** Alias completions for a prefix, alphabetical, for the hint row under the input. */
export function commandSuggestions(prefix: string, limit = 8): string[] {
  const p = prefix.trim().toLowerCase();
  if (p === "" || looksNumeric(p)) return [];
  const names = [...Object.keys(TOOL_ALIASES), ...Object.keys(APP_ALIASES)];
  return names
    .filter((n) => n.startsWith(p))
    .sort((a, b) => a.length - b.length || a.localeCompare(b))
    .slice(0, limit);
}

/**
 * Command history with the up/down walk every shell has: `index` is how far
 * back the user has stepped, -1 meaning "at the new, unsent line".
 */
export function recallHistory(history: readonly string[], index: number, direction: -1 | 1): { index: number; text: string } {
  // Up (-1) steps further back, down (+1) returns toward the new line.
  const next = Math.min(history.length - 1, Math.max(-1, index - direction));
  return { index: next, text: next < 0 ? "" : history[history.length - 1 - next] };
}

/** Appends to history, dropping an immediate repeat and capping the list. */
export function pushHistory(history: readonly string[], entry: string, limit = 50): string[] {
  const text = entry.trim();
  if (text === "") return [...history];
  if (history[history.length - 1] === text) return [...history];
  return [...history, text].slice(-limit);
}
