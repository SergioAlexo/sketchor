import type { Command, DimensionEntity, EntityId, SketchDocument } from "@sketchor/core";
import {
  dimensionsOf,
  flipDimArrows,
  layoutOf,
  moveDimText,
  obliqueDim,
  reassociateDim,
  resetDimText,
  restyleDim,
  spaceDimensions,
  updateCommands,
} from "@sketchor/core";
import type { AppCommandId } from "./commandLine";

/**
 * D-09: the command-line dimension editors (DIMTEXT reset, leader, flip, DIMSPACE,
 * oblique, update, reassociate). Each acts on the dimensions in the selection and
 * returns ONE command, so a user action is one undo step. The deciding is in core
 * (`dimensions/edit.ts`); this only reads the selection and the typed argument.
 */

export type DimEditId = Extract<AppCommandId, "dimTextReset" | "dimTextLeader" | "dimFlip" | "dimSpace" | "dimOblique" | "dimRestyle" | "dimReassoc">;

export interface DimEditResult {
  command: Command | null;
  /** The line echoed in the command bar. */
  message: string;
}

export function isDimEdit(id: AppCommandId): id is DimEditId {
  return id === "dimTextReset" || id === "dimTextLeader" || id === "dimFlip" || id === "dimSpace" || id === "dimOblique" || id === "dimRestyle" || id === "dimReassoc";
}

const none = (message: string): DimEditResult => ({ command: null, message });

export function runDimEdit(doc: SketchDocument, selection: readonly EntityId[], id: DimEditId, argument?: string): DimEditResult {
  const dims = dimensionsOf(selection.map((i) => doc.get(i)));
  if (dims.length === 0) return none("select one or more dimensions first");
  const finish = (after: DimensionEntity[], done: string, nothing: string): DimEditResult => {
    const command = updateCommands(dims, after);
    return command ? { command, message: done } : none(nothing);
  };
  switch (id) {
    case "dimTextReset":
      return finish(dims.map(resetDimText), "text reset", "text is already in place");
    case "dimTextLeader":
      return finish(
        dims.map((d) => {
          if (d.textLeader) return moveDimText(d, d.textPos ?? { x: 0, y: 0 }, false);
          const at = d.textPos ?? layoutOf(d).text?.at;
          return at ? moveDimText(d, at, true) : d;
        }),
        "text leader toggled",
        "these dimensions have no text to lead to",
      );
    case "dimFlip":
      return finish(dims.map(flipDimArrows), "arrows flipped", "nothing to flip");
    case "dimSpace": {
      const raw = argument?.trim();
      const spacing = raw === undefined || raw === "" ? 8 : Number(raw);
      if (!Number.isFinite(spacing) || spacing < 0) return none("dimspace: give a spacing in mm (0 lines them up)");
      // The first selected dimension is the base the others are counted from.
      return finish(spaceDimensions(dims, spacing, dims[0].id), "dimensions spaced", "need two or more parallel linear dimensions");
    }
    case "dimOblique": {
      const raw = argument?.trim();
      const angle = raw === undefined || raw === "" || raw === "0" || raw.toLowerCase() === "none" ? null : (Number(raw) * Math.PI) / 180;
      if (angle !== null && !Number.isFinite(angle)) return none("dimoblique: give an angle in degrees, or 'none'");
      return finish(dims.map((d) => obliqueDim(d, angle)), angle === null ? "extension lines square again" : "extension lines slanted", "only linear and aligned dimensions can be oblique");
    }
    case "dimRestyle":
      return finish(dims.map((d) => restyleDim(d, doc.settings.currentDimStyle || undefined)), "updated to the current style", "already in the current style");
    case "dimReassoc": {
      const all = doc.all();
      return finish(dims.map((d) => reassociateDim(d, all) ?? d), "re-attached to the geometry", "found no geometry under these dimensions");
    }
  }
}
