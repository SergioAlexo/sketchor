import { create } from "zustand";

/**
 * User-rebindable keyboard shortcuts. Every action a toolbar button performs
 * (a tool switch, undo, save, print, ...) has a stable id here; the actual key
 * combo is data the user can change — via the Shortcuts panel or by
 * right-clicking the button — not a literal comparison buried in a keydown
 * handler. `Viewport.tsx`'s global keydown listener and `App.tsx`'s toolbar
 * buttons both read the current binding through {@link matchesBinding} /
 * {@link useKeybindings} instead of hard-coding a key.
 *
 * A handful of keys stay hard-coded on purpose because they're mode-dependent
 * rather than a single command: Escape, Delete/Backspace-to-delete-selection,
 * and the in-progress-polyline keys (Enter/C/Backspace while drawing).
 */
export interface ActionDef {
  id: string;
  label: string;
  group: string;
}

export const ACTIONS: ActionDef[] = [
  { id: "tool.select", label: "Select tool", group: "Tools" },
  { id: "tool.line", label: "Line tool", group: "Tools" },
  { id: "tool.polyline", label: "Polyline tool", group: "Tools" },
  { id: "tool.rectangle", label: "Rectangle tool", group: "Tools" },
  { id: "tool.circle", label: "Circle tool", group: "Tools" },
  { id: "tool.arc", label: "Arc tool", group: "Tools" },
  { id: "tool.ellipse", label: "Ellipse tool", group: "Tools" },
  { id: "tool.spline", label: "Spline tool", group: "Tools" },
  { id: "tool.polygon", label: "Polygon tool", group: "Tools" },
  { id: "tool.slot", label: "Slot tool", group: "Tools" },
  { id: "tool.point", label: "Point tool", group: "Tools" },
  { id: "tool.image", label: "Image tool", group: "Tools" },
  { id: "tool.measure", label: "Measure tool", group: "Tools" },
  { id: "tool.straighten", label: "Straighten tool", group: "Tools" },
  { id: "tool.fill", label: "Hatch tool", group: "Tools" },
  { id: "tool.text", label: "Text tool", group: "Tools" },
  { id: "tool.dim", label: "Dimension tool", group: "Tools" },
  { id: "tool.pan", label: "Pan tool (one-finger pan on touch screens)", group: "Tools" },
  { id: "tool.move", label: "Move tool", group: "Modify" },
  { id: "tool.copy", label: "Copy tool", group: "Modify" },
  { id: "tool.rotate", label: "Rotate tool", group: "Modify" },
  { id: "tool.scale", label: "Scale tool", group: "Modify" },
  { id: "tool.mirror", label: "Mirror tool", group: "Modify" },
  { id: "tool.trim", label: "Trim / extend tool", group: "Modify" },
  { id: "tool.split", label: "Split tool", group: "Modify" },
  { id: "tool.fillet", label: "Fillet tool", group: "Modify" },
  { id: "tool.chamfer", label: "Chamfer tool", group: "Modify" },
  { id: "tool.offset", label: "Offset tool", group: "Modify" },
  { id: "tool.block", label: "Create block tool", group: "Modify" },
  { id: "tool.insert", label: "Insert block tool", group: "Modify" },
  { id: "tool.divide", label: "Divide tool (points along an entity)", group: "Modify" },
  { id: "tool.align", label: "Align tool (two source points to two targets)", group: "Modify" },
  { id: "tool.lengthen", label: "Lengthen tool", group: "Modify" },
  { id: "tool.match", label: "Match properties tool", group: "Modify" },
  { id: "tool.stretch", label: "Stretch tool", group: "Modify" },
  { id: "edit.join", label: "Join selected lines/arcs into a polyline", group: "Modify" },
  { id: "edit.explode", label: "Explode selected polylines into lines/arcs", group: "Modify" },
  { id: "edit.simplify", label: "Simplify selected polylines (fewer points, real arcs)", group: "Modify" },
  { id: "edit.selectAll", label: "Select all", group: "Edit" },
  { id: "edit.invertSelection", label: "Invert selection", group: "Edit" },
  { id: "edit.selectSimilar", label: "Select similar (same type, layer, colour)", group: "Edit" },
  { id: "edit.selectBy", label: "Select by type / layer / colour", group: "Edit" },
  { id: "view.otrack", label: "Object snap tracking", group: "View" },
  { id: "view.commandLine", label: "Command line", group: "View" },
  { id: "view.toggleUpAxis", label: "3D: toggle Z-up / Y-up", group: "View" },
  { id: "edit.relativeZero", label: "Set relative zero at the cursor", group: "Edit" },
  { id: "view.zoomWindow", label: "Zoom window (two corners)", group: "View" },
  { id: "view.zoomPrevious", label: "Zoom previous", group: "View" },
  { id: "edit.toggleConstruction", label: "Toggle construction line", group: "Edit" },
  { id: "file.open", label: "Open drawing", group: "File" },
  { id: "file.save", label: "Save", group: "File" },
  { id: "file.print", label: "Print / Save as PDF", group: "File" },
  { id: "file.closeTab", label: "Close tab", group: "File" },
  { id: "edit.undo", label: "Undo", group: "Edit" },
  { id: "edit.redo", label: "Redo", group: "Edit" },
  { id: "edit.copy", label: "Copy selection (as sketch code)", group: "Edit" },
  { id: "edit.cut", label: "Cut selection", group: "Edit" },
  { id: "edit.paste", label: "Paste at the cursor", group: "Edit" },
  { id: "edit.pasteInPlace", label: "Paste in place", group: "Edit" },
  { id: "edit.duplicate", label: "Duplicate (offset by one grid step)", group: "Edit" },
  { id: "edit.group", label: "Group selection", group: "Edit" },
  { id: "edit.ungroup", label: "Ungroup selection", group: "Edit" },
  { id: "view.fit", label: "Fit view to selection", group: "View" },
  { id: "view.ortho", label: "Ortho mode (constrain to 0/90°)", group: "View" },
  { id: "view.polar", label: "Polar tracking (snap to angle increments)", group: "View" },
  { id: "app.commandPalette", label: "Command palette", group: "App" },
  { id: "app.truckNesting", label: "Truck Load Planner", group: "App" },
  { id: "app.sheetNest", label: "Sheet Metal Nest", group: "App" },
  { id: "app.shortcuts", label: "Keyboard shortcuts", group: "App" },
  { id: "app.toggleLayers", label: "Toggle layers panel", group: "App" },
  { id: "app.toggleProperties", label: "Toggle properties panel", group: "App" },
  { id: "app.toggleCode", label: "Toggle sketch code panel", group: "App" },
  { id: "app.toggleConstraints", label: "Toggle constraints panel", group: "App" },
  { id: "app.toggleBlocks", label: "Toggle block library panel", group: "App" },
  { id: "mouse.addToSelection", label: "Add to selection on click", group: "Mouse" },
  { id: "mouse.freeMove", label: "Disable snapping while dragging", group: "Mouse" },
];

/**
 * Fixed mouse/keyboard behavior that isn't exposed as a rebindable action —
 * either because it's mode-dependent (Escape, Delete) rather than a single
 * command, or because it's a raw mouse gesture (which button, which wheel)
 * rather than a modifier this app's capture UI can record. Listed in the
 * Shortcuts panel for reference alongside the rebindable ones above.
 */
export const FIXED_SHORTCUTS: { label: string; description: string }[] = [
  { label: "Middle- or right-drag", description: "Pan the view, from any tool, without losing an in-progress line/polyline" },
  { label: "Mouse wheel", description: "Zoom in/out, centered on the cursor" },
  { label: "Two fingers (touch)", description: "Pan and pinch-zoom, from any tool, without losing an in-progress line/polyline" },
  { label: "Double-tap (touch)", description: "Fit the drawing — or the tapped entity — to the screen" },
  { label: "Drag left → right on empty canvas", description: "Window-select — picks only what's fully inside the box" },
  { label: "Drag right → left on empty canvas", description: "Crossing-select — also picks anything the box merely touches" },
  { label: "Alt-drag", description: "Lasso-select a freehand loop (left → right takes only what's inside, right → left also what it touches)" },
  { label: "Ctrl+Alt-drag", description: "Fence-select — an open stroke that takes everything it crosses" },
  { label: "Click the same spot again", description: "Cycle through overlapping entities, with a list of what else is under the cursor" },
  { label: "Escape", description: "Cancel whatever's half-drawn, clear the selection, and return to the select tool" },
  { label: "Delete / Backspace", description: "Delete the current selection (not while a polyline is mid-draw)" },
  { label: "Arrow keys", description: "Nudge the selection by one grid step (Shift: ten steps)" },
  { label: "Enter", description: "Finish a polyline, apply the straighten tool, or pin a measurement — whichever is active" },
  { label: "Typing a number while drawing", description: "Opens the coordinate box: 100 (length toward the cursor), 100<45 (polar), 50,20 (absolute), @50,20 (relative); units like 4in or 2'6\" accepted" },
  { label: "Shift while drawing", description: "Temporary ortho — the next point is constrained to 0/90/180/270°" },
];

export const DEFAULT_BINDINGS: Record<string, string> = {
  "tool.select": "v",
  "tool.line": "l",
  "tool.polyline": "w",
  "tool.rectangle": "r",
  "tool.circle": "c",
  "tool.arc": "a",
  "tool.ellipse": "e",
  "tool.spline": "s",
  "tool.polygon": "",
  "tool.slot": "",
  "tool.point": "p",
  "tool.image": "i",
  "tool.measure": "m",
  "tool.straighten": "t",
  "tool.fill": "h",
  "tool.text": "x",
  "tool.dim": "d",
  "tool.pan": "",
  "tool.move": "shift+m",
  "tool.copy": "shift+d",
  "tool.rotate": "shift+r",
  "tool.scale": "shift+s",
  "tool.mirror": "shift+i",
  "tool.trim": "shift+t",
  "tool.split": "shift+b",
  "tool.fillet": "shift+f",
  "tool.chamfer": "",
  "tool.offset": "shift+o",
  "tool.block": "b",
  "tool.insert": "",
  "tool.divide": "",
  "tool.align": "shift+a",
  "tool.lengthen": "shift+l",
  "tool.match": "",
  "tool.stretch": "shift+e",
  "edit.join": "j",
  "edit.explode": "ctrl+e",
  "edit.simplify": "shift+p",
  "edit.selectAll": "ctrl+a",
  "edit.invertSelection": "ctrl+i",
  "edit.selectSimilar": "ctrl+shift+a",
  "edit.selectBy": "",
  "view.otrack": "f11",
  "view.toggleUpAxis": "shift+u",
  "view.commandLine": "ctrl+9",
  "edit.relativeZero": "",
  "view.zoomWindow": "z",
  "view.zoomPrevious": "shift+z",
  "edit.toggleConstruction": "shift+c",
  "file.open": "ctrl+o",
  "file.save": "ctrl+s",
  "file.print": "ctrl+p",
  "file.closeTab": "ctrl+w",
  "edit.undo": "ctrl+z",
  "edit.redo": "ctrl+y",
  "edit.copy": "ctrl+c",
  "edit.cut": "ctrl+x",
  "edit.paste": "ctrl+v",
  "edit.pasteInPlace": "ctrl+shift+v",
  "edit.duplicate": "ctrl+d",
  "edit.group": "g",
  "edit.ungroup": "u",
  "view.fit": "f",
  "view.ortho": "f8",
  "view.polar": "f10",
  "app.commandPalette": "ctrl+k",
  "app.truckNesting": "",
  "app.sheetNest": "",
  "app.shortcuts": "",
  "app.toggleLayers": "",
  "app.toggleProperties": "ctrl+1",
  "app.toggleCode": "",
  "app.toggleConstraints": "ctrl+2",
  "app.toggleBlocks": "ctrl+3",
  "mouse.addToSelection": "shift",
  "mouse.freeMove": "ctrl",
};

/** The bare modifier names a "mouse.*" action's combo can hold. */
const MODIFIER_COMBOS: Record<string, string> = { Shift: "shift", Control: "ctrl", Alt: "alt" };

/** True while `e` is one of the modifier keydowns a "mouse.*" binding can capture (Shift/Control/Alt). */
export function modifierComboFor(key: string): string | null {
  return MODIFIER_COMBOS[key] ?? null;
}

const STORAGE_KEY = "sketchor.keybindings.v1";

function loadBindings(): Record<string, string> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULT_BINDINGS };
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const out = { ...DEFAULT_BINDINGS };
    for (const [k, v] of Object.entries(parsed)) if (typeof v === "string") out[k] = v;
    return out;
  } catch {
    return { ...DEFAULT_BINDINGS };
  }
}

function saveBindings(bindings: Record<string, string>): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(bindings));
  } catch {
    /* storage unavailable — bindings just won't survive a reload */
  }
}

interface KeybindingsState {
  bindings: Record<string, string>;
  setBinding: (id: string, combo: string) => void;
  clearBinding: (id: string) => void;
  resetBinding: (id: string) => void;
}

export const useKeybindings = create<KeybindingsState>((set, get) => ({
  bindings: loadBindings(),
  setBinding: (id, combo) => {
    // A combo can only be bound to one action at a time — stealing it from
    // whoever had it avoids two buttons silently fighting over one key.
    const bindings = { ...get().bindings };
    for (const k of Object.keys(bindings)) if (k !== id && bindings[k] === combo && combo !== "") bindings[k] = "";
    bindings[id] = combo;
    saveBindings(bindings);
    set({ bindings });
  },
  clearBinding: (id) => {
    const bindings = { ...get().bindings, [id]: "" };
    saveBindings(bindings);
    set({ bindings });
  },
  resetBinding: (id) => {
    const bindings = { ...get().bindings, [id]: DEFAULT_BINDINGS[id] ?? "" };
    saveBindings(bindings);
    set({ bindings });
  },
}));

const MODIFIER_KEYS = new Set(["control", "meta", "alt", "shift"]);

/**
 * Canonical combo string for a keyboard event, e.g. "ctrl+shift+z". Cmd and
 * Ctrl are treated as the same binding so one combo works on every platform.
 */
export function comboFromEvent(e: { ctrlKey: boolean; metaKey: boolean; altKey: boolean; shiftKey: boolean; key: string }): string {
  const parts: string[] = [];
  if (e.ctrlKey || e.metaKey) parts.push("ctrl");
  if (e.altKey) parts.push("alt");
  if (e.shiftKey) parts.push("shift");
  const key = e.key.toLowerCase();
  if (!MODIFIER_KEYS.has(key)) parts.push(key === " " ? "space" : key);
  return parts.join("+");
}

/** True if `e` matches the currently bound combo for `actionId` (false when unbound). */
export function matchesBinding(e: { ctrlKey: boolean; metaKey: boolean; altKey: boolean; shiftKey: boolean; key: string }, actionId: string): boolean {
  const combo = useKeybindings.getState().bindings[actionId];
  if (!combo) return false;
  return comboFromEvent(e) === combo;
}

/**
 * True if the modifier state on `e` (a mouse/pointer event, not a keydown)
 * matches the bound modifier for a "mouse.*" action — e.g. is the
 * "add to selection" modifier currently held during this click. Unlike
 * {@link matchesBinding}, this reads live modifier flags rather than a key
 * that was just pressed, since a mouse action is "held while clicking", not
 * "this key fired".
 */
export function matchesModifier(
  e: { ctrlKey: boolean; metaKey: boolean; altKey: boolean; shiftKey: boolean },
  actionId: string,
): boolean {
  const combo = useKeybindings.getState().bindings[actionId];
  if (!combo) return false;
  if (combo === "shift") return e.shiftKey;
  if (combo === "ctrl") return e.ctrlKey || e.metaKey;
  if (combo === "alt") return e.altKey;
  if (combo === "meta") return e.metaKey;
  return false;
}

/** Human-readable form of a combo string for display ("ctrl+shift+z" -> "Ctrl+Shift+Z"). */
export function bindingLabel(combo: string | undefined): string {
  if (!combo) return "";
  return combo
    .split("+")
    .map((p) => (p.length === 1 ? p.toUpperCase() : p[0].toUpperCase() + p.slice(1)))
    .join("+");
}
