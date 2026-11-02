import { create } from "zustand";
import { ALL_SNAPS_ON, type SnapSettings } from "../viewport/snapping";

/**
 * Per-kind object snap switches (roadmap T-21), persisted like the
 * keybindings. All on by default — the tiering in findSnap keeps a busy
 * drawing usable — and the status-bar SNAP popover turns kinds off when
 * they get in the way (grid while tracing, on-line while picking corners).
 */

const STORAGE_KEY = "sketchor.snaps.v1";

export const SNAP_KIND_LABELS: { id: keyof SnapSettings; label: string; hint: string }[] = [
  { id: "endpoint", label: "Endpoint", hint: "Ends of lines and arcs, polyline vertices, image corners" },
  { id: "midpoint", label: "Midpoint", hint: "Middle of a line, arc or polyline segment" },
  { id: "center", label: "Center", hint: "Center of a circle or arc" },
  { id: "quadrant", label: "Quadrant", hint: "The 0°/90°/180°/270° points of a circle" },
  { id: "intersection", label: "Intersection", hint: "Where any two curves cross" },
  { id: "node", label: "Node", hint: "Point entities" },
  { id: "perpendicular", label: "Perpendicular", hint: "Foot of the perpendicular from the last point onto a line, arc or circle" },
  { id: "tangent", label: "Tangent", hint: "Where a line from the last point touches a circle or arc" },
  { id: "on-line", label: "Nearest", hint: "Nearest point along a line, arc or circle" },
  { id: "extension", label: "Extension", hint: "Along a line past its end" },
  { id: "apparent", label: "Apparent intersection", hint: "Where two lines that do not touch would cross if extended" },
  { id: "parallel", label: "Parallel", hint: "Hover a line, then draw parallel to it from the last point (needs TRACK)" },
  { id: "grid", label: "Grid", hint: "The adaptive grid, when nothing else is near" },
];

function load(): SnapSettings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...ALL_SNAPS_ON };
    const parsed = JSON.parse(raw) as Partial<Record<string, unknown>>;
    const out = { ...ALL_SNAPS_ON };
    for (const k of Object.keys(out) as (keyof SnapSettings)[]) {
      if (typeof parsed[k] === "boolean") out[k] = parsed[k] as boolean;
    }
    return out;
  } catch {
    return { ...ALL_SNAPS_ON };
  }
}

function save(s: SnapSettings): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(s));
  } catch {
    /* storage unavailable */
  }
}

interface SnapState {
  settings: SnapSettings;
  toggle: (kind: keyof SnapSettings) => void;
  setAll: (on: boolean) => void;
}

export const useSnapSettings = create<SnapState>((set, get) => ({
  settings: load(),
  toggle: (kind) => {
    const settings = { ...get().settings, [kind]: !get().settings[kind] };
    save(settings);
    set({ settings });
  },
  setAll: (on) => {
    const settings = { ...get().settings };
    for (const k of Object.keys(settings) as (keyof SnapSettings)[]) settings[k] = on;
    save(settings);
    set({ settings });
  },
}));
