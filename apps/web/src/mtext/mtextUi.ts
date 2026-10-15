import { create } from "zustand";
import type { MTextEntity, Point } from "@sketchor/core";

/** What the MTEXT editor is editing: a new entity at a point, or an existing one (`id`). */
export interface MTextDraft {
  id: string | null;
  at: Point;
  text: string;
  width: number;
  height: number;
  attachment: number;
  rotation: number;
}

export const useMTextUi = create<{ draft: MTextDraft | null; openNew: (at: Point, height: number) => void; openEdit: (e: MTextEntity) => void; close: () => void }>((set) => ({
  draft: null,
  openNew: (at, height) => set({ draft: { id: null, at, text: "", width: height * 20, height, attachment: 1, rotation: 0 } }),
  openEdit: (e) => set({ draft: { id: e.id, at: e.at, text: e.text, width: e.width, height: e.height, attachment: e.attachment, rotation: e.rotation } }),
  close: () => set({ draft: null }),
}));
