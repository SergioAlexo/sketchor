import { create } from "zustand";
import { getLayout, spaceOf, type Entity, type LayoutRecord } from "@sketchor/core";
import { bus, doc, useApp } from "../state/store";

/**
 * Which space each document tab is looking at (L-02/L-03): model space or one
 * layout, and — inside a layout — whether a viewport is "entered" (MSPACE, the
 * model is live through it). This is UI state only: it is not saved with the
 * drawing and does not go through the command bus. The *drawing* effect of
 * being in a layout is `bus.activeSpace`, set here, which makes every new
 * entity land on the sheet.
 */

export interface SpaceState {
  /** The layout name, or null for model space. */
  layout: string | null;
  /** The viewport id whose model is being edited (MSPACE), or null for paper space. */
  mspace: string | null;
}

interface LayoutUi {
  bySession: Record<string, SpaceState>;
  set: (sessionId: string, state: SpaceState) => void;
}

const MODEL: SpaceState = { layout: null, mspace: null };

export const useLayoutUi = create<LayoutUi>((set) => ({
  bySession: {},
  set: (sessionId, state) => set((s) => ({ bySession: { ...s.bySession, [sessionId]: state } })),
}));

export function spaceStateOf(sessionId: string): SpaceState {
  return useLayoutUi.getState().bySession[sessionId] ?? MODEL;
}

/** The active tab's space (non-reactive). */
export function getSpaceState(): SpaceState {
  return spaceStateOf(useApp.getState().activeSessionId);
}

/** Reactive version for components. */
export function useSpaceState(): SpaceState {
  const id = useApp((s) => s.activeSessionId);
  return useLayoutUi((s) => s.bySession[id] ?? MODEL);
}

/** The active layout's record, or null in model space (or when the layout no longer exists). */
export function getActiveLayoutRecord(): LayoutRecord | null {
  const { layout } = getSpaceState();
  return layout ? (getLayout(doc, layout) ?? null) : null;
}

/** True when the entity is drawn/edited in the space the user is looking at. */
export function inActiveSpace(e: Entity): boolean {
  const { layout, mspace } = getSpaceState();
  // Entering a viewport edits the model; otherwise the layout's own (paper) entities.
  return mspace ? !spaceOf(e) : (spaceOf(e) ?? null) === layout;
}

/** Per-layout pan/zoom, remembered between visits: key `${sessionId}\u0000${layout}`. */
const layoutViews = new Map<string, { scale: number; ox: number; oy: number }>();
export function saveLayoutView(sessionId: string, layout: string, view: { scale: number; ox: number; oy: number }): void {
  layoutViews.set(`${sessionId}\u0000${layout}`, { ...view });
}
export function savedLayoutView(sessionId: string, layout: string): { scale: number; ox: number; oy: number } | null {
  return layoutViews.get(`${sessionId}\u0000${layout}`) ?? null;
}

/** Switches the active tab to a layout (or `null` = Model). Clears MSPACE and the selection. */
export function setActiveLayout(layout: string | null): void {
  const id = useApp.getState().activeSessionId;
  useLayoutUi.getState().set(id, { layout, mspace: null });
  bus.activeSpace = layout;
  useApp.getState().setSelection([]);
}

/** Enters (or with `null` leaves) a viewport's model space inside the current layout. */
export function setMspace(viewportId: string | null): void {
  const id = useApp.getState().activeSessionId;
  const cur = spaceStateOf(id);
  if (!cur.layout) return;
  useLayoutUi.getState().set(id, { layout: cur.layout, mspace: viewportId });
  // Model-space edits inside a viewport must not be stamped onto the sheet.
  bus.activeSpace = viewportId ? null : cur.layout;
  useApp.getState().setSelection([]);
}
