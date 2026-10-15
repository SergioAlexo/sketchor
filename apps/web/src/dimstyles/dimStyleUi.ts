import { create } from "zustand";

/** Whether the dimension style manager is open (opened by the `dimstyle` command or the Dimension menu). */
export const useDimStyleUi = create<{ open: boolean; setOpen: (open: boolean) => void }>((set) => ({
  open: false,
  setOpen: (open) => set({ open }),
}));
