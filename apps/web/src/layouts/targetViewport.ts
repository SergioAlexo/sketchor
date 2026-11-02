import type { ViewportEntity } from "@sketchor/core";
import { doc, useApp } from "../state/store";
import { useSpaceState } from "./layoutState";

/**
 * The viewport the layout controls (scale, lock, per-viewport layer freeze) act on: the one entered
 * (MSPACE), else the single selected viewport, else the layout's only viewport. Reactive to the document.
 */
export function useTargetViewport(): ViewportEntity | null {
  useApp((s) => s.revision);
  const selection = useApp((s) => s.selection);
  const space = useSpaceState();
  if (!space.layout) return null;
  if (space.mspace) {
    const v = doc.get(space.mspace);
    return v && v.type === "viewport" ? v : null;
  }
  const picked = selection.map((id) => doc.get(id)).filter((e): e is ViewportEntity => !!e && e.type === "viewport");
  if (picked.length === 1) return picked[0];
  const all = doc.all().filter((e): e is ViewportEntity => e.type === "viewport" && e.space === space.layout);
  return all.length === 1 ? all[0] : null;
}
