import type { Command } from "./commands";
import { SketchDocument } from "./document";
import { boundsOf } from "./dxf";
import { migrateDashedEntity, newEntityId, translated, type Entity, type EntityId } from "./entities";
import type { Point } from "./geometry";
import { newGroupId, type Group, type GroupId } from "./groups";
import { referencedBlocks } from "./blocks/evaluate";
import type { BlockDefinition } from "./blocks/types";
import { parseCode, toCode, toEntity } from "./sketchtext";

/**
 * Copy / paste (roadmap T-11). The clipboard text is the selection as
 * **sketch code** — readable, pasteable into a chat or a text editor, and
 * parseable back — followed by one `# sketchor …` comment line carrying
 * the same entities as JSON. The code is what people see; the JSON is what
 * keeps a paste lossless (layers, colours, bulges, images, groups), since
 * the DSL deliberately leaves those out. Text without the comment (typed
 * or AI-written sketch code) still pastes, via the parser.
 */

export interface ClipboardPayload {
  entities: Entity[];
  /** Groups whose members are all in `entities` (nested groups included), so a copied group pastes as a group. */
  groups: Group[];
  /** Definitions of the blocks the entities insert (nested ones included), so a paste into another drawing still shows them. */
  blocks?: BlockDefinition[];
}

const MARK = "# sketchor ";

/** The selection (expanded to whole groups) as clipboard text. Empty selection → empty string. */
export function serializeSelection(doc: SketchDocument, ids: readonly EntityId[]): string {
  const payload = payloadFor(doc, ids);
  if (payload.entities.length === 0) return "";
  const sub = new SketchDocument();
  for (const e of payload.entities) sub._put(e);
  return `${toCode(sub).trimEnd()}\n${MARK}${JSON.stringify(payload)}\n`;
}

/** Entities and fully-contained groups for a selection. */
export function payloadFor(doc: SketchDocument, ids: readonly EntityId[]): ClipboardPayload {
  const wanted = new Set(ids);
  const entities = doc.all().filter((e) => wanted.has(e.id));
  const groups = doc.groups().filter((g) => groupInside(doc, g, wanted, new Set()));
  const blocks = [...referencedBlocks(doc, entities)].map((n) => doc.getRecord("blocks", n) as BlockDefinition | undefined).filter((b): b is BlockDefinition => !!b);
  return { entities, groups, ...(blocks.length > 0 ? { blocks } : {}) };
}

function groupInside(doc: SketchDocument, g: Group, wanted: Set<EntityId>, seen: Set<GroupId>): boolean {
  if (seen.has(g.id)) return false;
  seen.add(g.id);
  return g.members.every((m) => {
    if (wanted.has(m)) return true;
    const sub = doc.getGroup(m);
    return !!sub && groupInside(doc, sub, wanted, seen);
  });
}

/** Reads clipboard text back: the JSON line when present, else parsed sketch code. Null when it holds neither. */
export function parseClipboard(text: string): ClipboardPayload | null {
  const line = text.split(/\r?\n/).find((l) => l.startsWith(MARK));
  if (line) {
    try {
      const raw = JSON.parse(line.slice(MARK.length)) as Partial<ClipboardPayload>;
      if (Array.isArray(raw.entities)) {
        // A clipboard payload copied before Z-04 may still carry the old `dashed` field.
        return {
          entities: raw.entities.filter(isEntityLike).map(migrateDashedEntity),
          groups: Array.isArray(raw.groups) ? raw.groups.filter(isGroupLike) : [],
          ...(Array.isArray(raw.blocks) ? { blocks: raw.blocks.filter((b): b is BlockDefinition => !!b && typeof b.name === "string" && Array.isArray(b.entities)) } : {}),
        };
      }
    } catch {
      /* fall through to the code parser */
    }
  }
  const { entities } = parseCode(text);
  const out = entities.filter((p) => p.type !== "image").map((p) => toEntity(p, newEntityId()));
  return out.length > 0 ? { entities: out, groups: [] } : null;
}

function isEntityLike(v: unknown): v is Entity {
  return !!v && typeof v === "object" && typeof (v as Entity).type === "string" && typeof (v as Entity).id === "string";
}

function isGroupLike(v: unknown): v is Group {
  return !!v && typeof v === "object" && typeof (v as Group).id === "string" && Array.isArray((v as Group).members);
}

/** Bottom-left of the payload's extents — the base point a paste is positioned by. */
export function payloadBase(payload: ClipboardPayload): Point | null {
  const bb = boundsOf(payload.entities);
  return bb ? { x: bb.minX, y: bb.minY } : null;
}

/**
 * Commands that add the payload to a document with fresh ids (and fresh
 * group ids, membership remapped), moved by `offset`. Names are dropped
 * so the sketch code hands out the next free ones. One batch = one undo.
 */
export function pasteCommands(payload: ClipboardPayload, offset: Point, into?: SketchDocument): { commands: Command[]; ids: EntityId[] } {
  const idMap = new Map<string, string>();
  const commands: Command[] = [];
  // Blocks the destination lacks come along (same-name blocks already there win — pasting never redefines).
  for (const b of payload.blocks ?? []) if (!into?.hasRecord("blocks", b.name)) commands.push({ type: "put-table-record", table: "blocks", record: b });
  const ids: EntityId[] = [];
  for (const e of payload.entities) idMap.set(e.id, newEntityId());
  for (const e of payload.entities) {
    const id = idMap.get(e.id)!;
    // A paste lands in the space being drawn in (the bus stamps it), not the space it was copied from.
    const { name: _dropped, space: _space, ...rest } = e as Entity & { space?: string };
    const moved = translated(rewireDimension({ ...rest, id } as Entity, idMap), offset.x, offset.y);
    commands.push({ type: "add-entity", entity: moved });
    ids.push(id);
  }
  // Groups: parents first so nested membership resolves; ids remapped.
  for (const g of payload.groups) idMap.set(g.id, newGroupId());
  const ordered = [...payload.groups].sort((a, b) => depth(a, payload.groups) - depth(b, payload.groups));
  for (const g of ordered) {
    const members = g.members.map((m) => idMap.get(m)).filter((m): m is string => !!m);
    if (members.length === 0) continue;
    const parent = g.parent ? idMap.get(g.parent) : undefined;
    commands.push({ type: "group-entities", groupId: idMap.get(g.id)!, ids: members, name: g.name, ...(parent ? { parent } : {}) });
  }
  return { commands, ids };
}

/** A pasted dimension follows the copies of the geometry it was attached to, or — when that geometry was not copied — keeps its def points and detaches. */
function rewireDimension(e: Entity, idMap: Map<string, string>): Entity {
  if (e.type !== "dimension") return e;
  const { refs, target, targets, ...rest } = e;
  const out = { ...rest } as typeof e;
  const mapped = (id: string) => idMap.get(id);
  if (refs && refs.every((r) => !r || mapped(r.entityId))) out.refs = refs.map((r) => (r ? { ...r, entityId: mapped(r.entityId)! } : r));
  if (target && mapped(target)) out.target = mapped(target)!;
  if (targets && mapped(targets[0]) && mapped(targets[1])) out.targets = [mapped(targets[0])!, mapped(targets[1])!];
  return out;
}

function depth(g: Group, all: Group[]): number {
  let d = 0;
  let cur: Group | undefined = g;
  const seen = new Set<GroupId>();
  while (cur?.parent && !seen.has(cur.id)) {
    seen.add(cur.id);
    cur = all.find((x) => x.id === cur!.parent);
    d += 1;
  }
  return d;
}
