import type { Entity, ViewportEntity } from "../entities";
import { entityXdataText } from "../sketchorData";
import { paperSizeMm, type LayoutRecord } from "../layouts/types";
import { entityHead } from "./entities";
import { pair } from "./write";

/**
 * L-07: the AC1032 side of layouts. A layout is a `LAYOUT` object (plot settings + tab order) pointing at a
 * block record: the first one at `*Paper_Space`, the others at `*Paper_Space0`, `*Paper_Space1`, ... Each sheet
 * starts with the overall paper viewport (id 1), then our own viewports (ids 2...). Paper dimensions are in
 * millimetres whatever the plot units (that is how PLOTSETTINGS stores them); paper-space coordinates are
 * in file units, like model space (see `entitiesToDxf2018`).
 */

export interface LayoutWritePlan {
  layout: LayoutRecord;
  /** Position among the layouts (0 = the one that owns `*Paper_Space`). */
  index: number;
  blockName: string;
  record: string;
  begin: string;
  end: string;
  object: string;
  /** Handle of the overall paper viewport (the layout's "last active viewport"). */
  overall: string;
}

export function paperBlockName(index: number): string {
  return index === 0 ? "*Paper_Space" : `*Paper_Space${index - 1}`;
}

/** AutoCAD's paper-size label for the plot settings (group 4). */
export function paperSizeLabel(layout: LayoutRecord): string {
  const { w, h } = paperSizeMm(layout.paper);
  const dims = `${w.toFixed(2)}_x_${h.toFixed(2)}_MM`;
  const key = layout.paper.size;
  if (/^A\d$/.test(key)) return `ISO_${key}_(${dims})`;
  return `User_(${dims})`;
}

const f = (v: number) => (Number.isFinite(v) ? v : 0);

export function layoutObjectText(plan: LayoutWritePlan, ownerDict: string, inchUnits: boolean): string {
  const { layout } = plan;
  const { w, h } = paperSizeMm(layout.paper);
  const k = layout.paper.units === "in" ? 25.4 : 1;
  const m = layout.margins;
  const ps = layout.plotSettings;
  const flags = 16 | 32 | 128 | 256 | (ps.scaleLineweights ? 64 : 0) | (ps.center ? 4 : 0);
  const sheet = ps.plotStyle === "monochrome" ? "monochrome.ctb" : ps.plotStyle === "grayscale" ? "Grayscale.ctb" : "";
  return (
    `0\nLAYOUT\n5\n${plan.object}\n330\n${ownerDict}\n100\nAcDbPlotSettings\n` +
    `1\n\n2\nnone_device\n4\n${paperSizeLabel(layout)}\n6\n\n` +
    pair(40, f(m.left * k)) + pair(41, f(m.bottom * k)) + pair(42, f(m.right * k)) + pair(43, f(m.top * k)) +
    pair(44, w) + pair(45, h) + pair(46, 0) + pair(47, 0) + pair(48, 0) + pair(49, 0) +
    pair(140, 0) + pair(141, 0) + pair(142, 1) + pair(143, 1) +
    `70\n${flags}\n72\n${inchUnits ? 0 : 1}\n73\n0\n74\n${ps.plotArea === "extents" ? 1 : 5}\n7\n${sheet}\n75\n16\n76\n0\n77\n2\n78\n300\n` +
    pair(147, 1) + pair(148, 0) + pair(149, 0) +
    `100\nAcDbLayout\n1\n${layout.name}\n70\n1\n71\n${plan.index + 1}\n` +
    pair(10, 0) + pair(20, 0) + pair(11, w) + pair(21, h) +
    pair(12, 0) + pair(22, 0) + pair(32, 0) +
    pair(14, 0) + pair(24, 0) + pair(34, 0) + pair(15, w) + pair(25, h) + pair(35, 0) +
    pair(146, 0) + pair(13, 0) + pair(23, 0) + pair(33, 0) +
    pair(16, 1) + pair(26, 0) + pair(36, 0) + pair(17, 0) + pair(27, 1) + pair(37, 0) +
    `76\n0\n330\n${plan.record}\n331\n${plan.overall}\n`
  );
}

/** The status-flag bits of group 90 that matter here. */
export const VP_LOCKED = 16384;
export const VP_NON_RECTANGULAR = 65536;

/** Everything a VIEWPORT record needs that is not on the entity itself. */
export interface ViewportWriteInfo {
  id: number;
  /** Stacking/status value for group 68 (1 = the overall viewport, 2+ = ours). */
  status: number;
  /** Handles of the LAYER records frozen in the window. */
  frozen: string[];
  /** Handle of the entity holding the clip polygon, when there is one. */
  clip?: string;
  /** File units per mm: how the entity's mm values become file units. */
  scale: number;
}

function vpBody(centerX: number, centerY: number, w: number, h: number, viewX: number, viewY: number, viewHeight: number, info: ViewportWriteInfo, flags: number, frozen: string[], clip: string | undefined): string {
  return (
    `100\nAcDbViewport\n` +
    pair(10, centerX) + pair(20, centerY) + pair(30, 0) + pair(40, w) + pair(41, h) +
    `68\n${info.status}\n69\n${info.id}\n` +
    pair(12, viewX) + pair(22, viewY) +
    pair(13, 0) + pair(23, 0) + pair(14, 10) + pair(24, 10) + pair(15, 10) + pair(25, 10) +
    pair(16, 0) + pair(26, 0) + pair(36, 1) + pair(17, 0) + pair(27, 0) + pair(37, 0) +
    pair(42, 50) + pair(43, 0) + pair(44, 0) + pair(45, viewHeight) + pair(50, 0) + pair(51, 0) +
    `72\n1000\n` +
    frozen.map((hnd) => `331\n${hnd}\n`).join("") +
    `90\n${flags}\n` +
    (clip ? `340\n${clip}\n` : "") +
    `1\n\n281\n0\n71\n0\n74\n0\n`
  );
}

/** A layout's own paper viewport (id 1): the whole sheet, no model view. */
export function overallViewportText(handle: string, owner: string, layout: LayoutRecord, scale: number): string {
  const { w, h } = paperSizeMm(layout.paper);
  const file = { id: 1, status: 1, frozen: [], scale };
  return `0\nVIEWPORT\n5\n${handle}\n330\n${owner}\n100\nAcDbEntity\n8\n0\n` + vpBody((w / 2) * scale, (h / 2) * scale, w * scale, h * scale, (w / 2) * scale, (h / 2) * scale, h * scale, file, 0, [], undefined);
}

/**
 * One of our viewports. `e` is in mm (paper and model alike); `info.scale` is file units per mm. Group 45 (view height,
 * model units) is what fixes the scale: paper height / view height.
 */
export function viewportEntityText(e: ViewportEntity, handle: string, owner: string, info: ViewportWriteInfo): string {
  const k = info.scale;
  const flags = (e.locked ? VP_LOCKED : 0) | (info.clip ? VP_NON_RECTANGULAR : 0);
  return (
    `0\nVIEWPORT\n` +
    entityHead(handle, owner, e as unknown as Entity) +
    vpBody(e.center.x * k, e.center.y * k, e.width * k, e.height * k, e.viewCenter.x * k, e.viewCenter.y * k, (e.height / e.scale) * k, info, flags, info.frozen, info.clip) +
    entityXdataText(e)
  );
}

