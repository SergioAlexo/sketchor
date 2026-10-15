import { insertAttribRecords, attribFlags } from "../blocks/attributes";
import type { BlockDefinition } from "../blocks/types";
import type { Entity, InsertEntity } from "../entities";
import { layerOf } from "../entities";
import { entityHead } from "./entities";
import { pair } from "./write";
import { entityXdataText } from "../sketchorData";

/**
 * B-08: real blocks in the AC1032 writer. An INSERT names its BLOCK_RECORD;
 * the BLOCKS section carries each definition (base point, owner = its
 * record, ATTDEFs). Attribute values follow the INSERT as ATTRIB records
 * closed by SEQEND, exactly as AutoCAD writes them.
 */

const RAD_TO_DEG = 180 / Math.PI;

export interface BlockHandles {
  record: string;
  begin: string;
  end: string;
}

/** Handles for every definition, allocated up front so INSERTs and BLOCK_RECORDs can refer to each other. */
export function planBlockHandles(defs: readonly BlockDefinition[], alloc: () => string): Map<string, BlockHandles> {
  return new Map(defs.map((d) => [d.name, { record: alloc(), begin: alloc(), end: alloc() }] as const));
}

/** An INSERT, with its ATTRIBs and SEQEND when the block has non-constant attributes. */
export function insertEntity2018(e: InsertEntity, def: BlockDefinition, handle: string, owner: string, nextHandle: () => string): string {
  const attribs = insertAttribRecords(def, e);
  const arr = e.array && (e.array.cols > 1 || e.array.rows > 1) ? e.array : null;
  let out =
    `0\nINSERT\n` +
    entityHead(handle, owner, e) +
    `100\nAcDbBlockReference\n` +
    (attribs.length > 0 ? `66\n1\n` : "") +
    `2\n${e.block}\n` +
    pair(10, e.insert.x) + pair(20, e.insert.y) + pair(30, 0) +
    pair(41, e.scale.x) + pair(42, e.scale.y) + pair(43, 1) +
    pair(50, e.rotation * RAD_TO_DEG) +
    (arr ? `70\n${Math.round(arr.cols)}\n71\n${Math.round(arr.rows)}\n` + pair(44, arr.colSpacing) + pair(45, arr.rowSpacing) : "") +
    entityXdataText(e);
  if (attribs.length > 0) {
    for (const a of attribs) {
      out +=
        `0\nATTRIB\n` +
        entityHead(nextHandle(), owner, e) +
        `100\nAcDbText\n` +
        pair(10, a.at.x) + pair(20, a.at.y) + pair(30, 0) +
        pair(40, a.height) +
        `1\n${a.value}\n` +
        pair(50, a.rotation * RAD_TO_DEG) +
        `100\nAcDbAttribute\n` +
        `2\n${a.tag}\n70\n${a.flags}\n`;
    }
    out += `0\nSEQEND\n5\n${nextHandle()}\n330\n${owner}\n100\nAcDbEntity\n8\n${layerOf(e)}\n`;
  }
  return out;
}

function attdef2018(a: BlockDefinition["attributeDefs"][number], handle: string, owner: string): string {
  return (
    `0\nATTDEF\n5\n${handle}\n330\n${owner}\n100\nAcDbEntity\n8\n0\n` +
    `100\nAcDbText\n` +
    pair(10, a.at.x) + pair(20, a.at.y) + pair(30, 0) +
    pair(40, a.height) +
    `1\n${a.default ?? ""}\n` +
    pair(50, a.rotation * RAD_TO_DEG) +
    `100\nAcDbAttributeDefinition\n` +
    `3\n${a.prompt ?? a.tag}\n2\n${a.tag}\n70\n${attribFlags(a)}\n`
  );
}

/** The BLOCKS-section text of every definition. `write` emits one body entity (so nested INSERTs reuse the caller's insert writer). */
export function blockDefinitions2018(
  defs: readonly BlockDefinition[],
  handles: Map<string, BlockHandles>,
  alloc: () => string,
  write: (e: Entity, owner: string) => string,
): string {
  return defs
    .map((d) => {
      const h = handles.get(d.name)!;
      const body = d.entities.map((e) => write(e, h.record)).join("");
      const attdefs = d.attributeDefs.map((a) => attdef2018(a, alloc(), h.record)).join("");
      return (
        `0\nBLOCK\n5\n${h.begin}\n330\n${h.record}\n100\nAcDbEntity\n8\n0\n100\nAcDbBlockBegin\n` +
        `2\n${d.name}\n70\n${(d.name.startsWith("*D") ? 1 : 0) | (d.attributeDefs.length > 0 ? 2 : 0)}\n` +
        pair(10, d.basePoint.x) + pair(20, d.basePoint.y) + pair(30, 0) +
        `3\n${d.name}\n1\n\n` +
        body +
        attdefs +
        `0\nENDBLK\n5\n${h.end}\n330\n${h.record}\n100\nAcDbEntity\n8\n0\n100\nAcDbBlockEnd\n`
      );
    })
    .join("");
}

