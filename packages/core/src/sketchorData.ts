import type { Group } from "./groups";
import type { Constraint } from "./constraints";
import type { TableRecord } from "./tables";

/**
 * X-08: the Sketchor-only data a DXF carries so Sketchor -> DXF -> Sketchor
 * is lossless. Two carriers, both under the `SKETCHOR` APPID/name:
 *  - per entity: `1001 SKETCHOR` XDATA with `1000` strings (name untagged for
 *    older readers, then `id=`, `fill=`, `construction=1`);
 *  - per document: one XRECORD (`SKETCHOR_DATA` in the root dictionary) with
 *    a JSON blob split over group-1 chunks (groups, constraints, params,
 *    per-block extras). Ids in it are the entity ids restored from XDATA.
 */

export interface EntityXdata {
  name?: string;
  id?: string;
  fill?: string;
  construction?: boolean;
}

export interface BlockExtras {
  explodable?: boolean;
  scaleUniformly?: boolean;
  description?: string;
  units?: number;
  dynamic?: unknown;
  constraints?: Constraint[];
}

export interface SketchorDocData {
  v: 1;
  groups?: Group[];
  constraints?: Constraint[];
  params?: TableRecord[];
  blocks?: Record<string, BlockExtras>;
  /** D-10: dimension fields DXF has no group for (associations, driving value, per-dimension overrides…), by entity id. */
  dims?: Record<string, Record<string, unknown>>;
  /** D-10: full `dimStyles` records (child styles, arrow kinds, colours…). */
  dimStyles?: TableRecord[];
}

export const SKETCHOR_DICT_KEY = "SKETCHOR_DATA";
const CHUNK = 1000;
const TAG = /^(id|fill|construction|name)=([\s\S]*)$/;

/** `1001 SKETCHOR` block for one entity, or "" when it has nothing Sketchor-specific. */
export function entityXdataText(e: { id?: string; name?: string; fill?: string; construction?: boolean }): string {
  const lines: string[] = [];
  if (e.name) lines.push(e.name);
  if (e.id) lines.push(`id=${e.id}`);
  if (e.fill) lines.push(`fill=${e.fill}`);
  if (e.construction) lines.push("construction=1");
  if (lines.length === 0) return "";
  return `1001\nSKETCHOR\n` + lines.map((l) => `1000\n${l.replace(/[\r\n]+/g, " ").slice(0, 250)}\n`).join("");
}

/** Reads the SKETCHOR XDATA group(s) out of a record's pairs. */
export function parseEntityXdata(pairs: readonly { code: number; value: string }[]): EntityXdata {
  const out: EntityXdata = {};
  const i = pairs.findIndex((p) => p.code === 1001 && p.value.trim() === "SKETCHOR");
  if (i === -1) return out;
  for (let j = i + 1; j < pairs.length && pairs[j].code !== 1001; j++) {
    if (pairs[j].code !== 1000) continue;
    const v = pairs[j].value;
    const m = TAG.exec(v);
    if (!m) {
      if (out.name === undefined) out.name = v; // legacy / untagged = the name
      continue;
    }
    if (m[1] === "id") out.id = m[2];
    else if (m[1] === "fill") out.fill = m[2];
    else if (m[1] === "construction") out.construction = m[2] === "1";
    else if (m[1] === "name") out.name = m[2];
  }
  return out;
}

/** JSON -> ASCII-only chunks (non-ASCII escaped so any DXF codepage survives). */
export function encodeDocData(data: SketchorDocData): string[] {
  const json = JSON.stringify(data).replace(/[\u007f-￿]/g, (c) => "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0"));
  const chunks: string[] = [];
  for (let i = 0; i < json.length; i += CHUNK) chunks.push(json.slice(i, i + CHUNK));
  return chunks;
}

export function decodeDocData(chunks: readonly string[]): SketchorDocData | null {
  try {
    const v = JSON.parse(chunks.join(""));
    return v && typeof v === "object" && v.v === 1 ? (v as SketchorDocData) : null;
  } catch {
    return null;
  }
}
