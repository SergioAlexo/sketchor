import type { DimensionEntity } from "../entities";
import type { Point } from "../geometry";
import { pair } from "../dxfw/write";
import { dimStyleFor, layoutOf } from "./resolve";
import { leaderPlainText, leaderSide } from "./leader";
import type { DimHost } from "./context";

/**
 * D-10: real DXF LEADER and MULTILEADER records for `leader` dimensions.
 *
 * A plain leader (one line, text or nothing) is a LEADER with an associated
 * MTEXT; a multileader or balloon is a MULTILEADER (CONTEXT_DATA with one
 * LEADER / LEADER_LINE per line) plus the MLEADERSTYLE object the writer adds.
 * Numbers are in the file's units: callers pass what {@link leaderDxfInfo} measured
 * (already multiplied by the output scale) and write the entity's own already
 * scaled points. Readers recompute the drawing from these; the exact Sketchor
 * fields (balloon shape, spline, branches, ...) ride the SKETCHOR record.
 */

export interface LeaderDxfInfo {
  style: string;
  /** Arrow head size, text height and landing length, file units. */
  arrow: number;
  textHeight: number;
  landing: number;
  /** Text box (file units): where its attach edge is and how wide it is. */
  textWidth: number;
  textAt: Point | null;
  /** The text as MTEXT codes. */
  text: string;
  /** +1 content to the right of the attach point, -1 left. */
  side: 1 | -1;
}

/** True for a leader a single LEADER record can carry (one line, no balloon). */
export function isPlainLeader(e: DimensionEntity): boolean {
  return !e.balloon && !(e.branches && e.branches.length > 0);
}

export function hasLeaderRecord(e: DimensionEntity): boolean {
  return e.kind === "leader" && e.defPoints.length >= 2 && e.defPoints.every((p) => Number.isFinite(p.x) && Number.isFinite(p.y));
}

/** Measures what the writer needs from the *unscaled* entity and its style; `scale` is the output unit factor. */
export function leaderDxfInfo(e: DimensionEntity, host: DimHost | null, scale: number): LeaderDxfInfo {
  const st = dimStyleFor(e, host);
  const k = (e.scale && e.scale > 0 ? e.scale : 1) * (st.scale > 0 ? st.scale : 1);
  const lay = layoutOf(e, host);
  const arrow = st.arrowSize * k;
  const text = leaderPlainText(e.textOverride);
  return {
    style: e.style || "Standard",
    arrow: arrow * scale,
    textHeight: st.textHeight * k * scale,
    landing: (e.landing !== undefined ? Math.max(0, e.landing) : 2 * arrow) * scale,
    textWidth: (lay.text?.width ?? 0) * scale,
    textAt: lay.text ? { x: lay.text.at.x * scale, y: lay.text.at.y * scale } : null,
    text: text ? (e.textOverride ?? "") : "",
    side: leaderSide(e.defPoints),
  };
}

const P3 = (code: number, p: { x: number; y: number }, z = 0): string => pair(code, p.x) + pair(code + 10, p.y) + pair(code + 20, z);

/** The LEADER body (after the entity head): vertices tip..attach, hookline, annotation handle. */
export function leaderRecordText(e: DimensionEntity, info: LeaderDxfInfo, annotationHandle: string | null): string {
  const pts = e.defPoints;
  return (
    `100\nAcDbLeader\n` +
    pair(3, info.style) +
    `71\n1\n` +
    `72\n${e.leaderSpline ? 1 : 0}\n` +
    `73\n${annotationHandle ? 0 : 3}\n` +
    `74\n${info.side > 0 ? 1 : 0}\n` +
    `75\n${info.landing > 0 && annotationHandle ? 1 : 0}\n` +
    pair(40, info.textHeight) +
    (info.textWidth > 0 ? pair(41, info.textWidth) : "") +
    `76\n${pts.length}\n` +
    pts.map((p) => P3(10, p)).join("") +
    (annotationHandle ? `340\n${annotationHandle}\n` : "") +
    P3(211, { x: info.side, y: 0 })
  );
}

/** MTEXT attachment (middle-left / middle-right) and insertion point for the text that goes with a LEADER. */
export function leaderTextPlacement(e: DimensionEntity, info: LeaderDxfInfo): { at: Point; attachment: number } {
  const attach = e.defPoints[e.defPoints.length - 1];
  const gap = Math.max(info.textHeight * 0.3, 0);
  return { at: { x: attach.x + info.side * (info.landing + gap), y: attach.y }, attachment: info.side > 0 ? 4 : 6 };
}

const ARGB_BYBLOCK = -1056964608;
const ARGB_BG = -939524096;

/** The MULTILEADER body (after the entity head). `styleHandle` is the MLEADERSTYLE object. */
export function mleaderRecordText(e: DimensionEntity, info: LeaderDxfInfo, styleHandle: string): string {
  const pts = e.defPoints;
  const attach = pts[pts.length - 1];
  const side = info.side;
  const lines: Point[][] = [pts.slice(0, -1), ...(e.branches ?? []).map((b) => b.slice())];
  const hasText = info.text !== "";
  const dog = info.landing;
  const textLoc = info.textAt
    ? { x: info.textAt.x - side * (e.balloon ? 0 : info.textWidth / 2), y: info.textAt.y }
    : { x: attach.x + side * dog, y: attach.y };
  const base = { x: attach.x + side * dog, y: attach.y };
  const leaderBlock =
    `302\nLEADER{\n290\n1\n291\n1\n` +
    P3(10, attach) +
    P3(11, { x: side, y: 0 }) +
    `90\n0\n` +
    pair(40, dog) +
    lines
      .map((l, i) => `304\nLEADER_LINE{\n` + l.map((p) => P3(10, p)).join("") + `91\n${i}\n92\n${ARGB_BYBLOCK}\n305\n}\n`)
      .join("") +
    `271\n0\n303\n}\n`;
  const context =
    `300\nCONTEXT_DATA{\n` +
    pair(40, 1) +
    P3(10, base) +
    pair(41, info.textHeight) +
    pair(140, info.arrow) +
    pair(145, 0) +
    `174\n2\n175\n2\n176\n${side > 0 ? 0 : 2}\n177\n0\n` +
    `290\n${hasText ? 1 : 0}\n` +
    (hasText ? pair(304, info.text.replace(/[\r\n]+/g, "\\P")) + P3(11, { x: 0, y: 0 }, 1) : "") +
    (hasText ? P3(12, textLoc) + P3(13, { x: 1, y: 0 }) + pair(42, 0) + pair(43, info.textWidth) + pair(44, info.textHeight) + pair(45, 1) : "") +
    `170\n1\n90\n${ARGB_BYBLOCK}\n171\n1\n172\n1\n91\n${ARGB_BG}\n141\n1.5\n92\n0\n291\n0\n292\n0\n173\n0\n293\n0\n` +
    pair(142, 0) + pair(143, 0) + `294\n0\n295\n1\n296\n0\n` +
    P3(110, { x: 0, y: 0 }) + P3(111, { x: 1, y: 0 }) + P3(112, { x: 0, y: 1 }) +
    `297\n0\n` +
    leaderBlock +
    `272\n9\n273\n9\n301\n}\n`;
  return (
    `100\nAcDbMLeader\n270\n2\n` +
    context +
    `340\n${styleHandle}\n` +
    `90\n2147483647\n170\n${e.leaderSpline ? 2 : 1}\n91\n${ARGB_BYBLOCK}\n171\n-2\n` +
    `290\n${dog > 0 ? 1 : 0}\n291\n${dog > 0 ? 1 : 0}\n` +
    pair(41, dog) +
    pair(42, info.arrow) +
    `172\n${hasText ? 2 : 0}\n` +
    `173\n2\n95\n2\n174\n1\n175\n0\n92\n${ARGB_BYBLOCK}\n292\n${e.balloon ? 1 : 0}\n93\n${ARGB_BYBLOCK}\n` +
    P3(10, { x: 1, y: 1 }, 1) +
    pair(43, 0) +
    `176\n0\n293\n0\n294\n0\n178\n0\n179\n1\n` +
    pair(45, 1) +
    `271\n0\n272\n9\n273\n9\n295\n0\n`
  );
}

/** The MLEADERSTYLE object (one: "Standard") and its dictionary, as OBJECTS text. */
export function mleaderStyleObjects(handles: { dict: string; style: string; rootDict: string }, textHeight: number, arrow: number): string {
  return (
    `0\nDICTIONARY\n5\n${handles.dict}\n330\n${handles.rootDict}\n100\nAcDbDictionary\n281\n1\n3\nStandard\n350\n${handles.style}\n` +
    `0\nMLEADERSTYLE\n5\n${handles.style}\n102\n{ACAD_REACTORS\n330\n${handles.dict}\n102\n}\n330\n${handles.dict}\n100\nAcDbMLeaderStyle\n` +
    `179\n2\n170\n1\n171\n1\n172\n0\n90\n2\n` +
    pair(40, 0) +
    pair(41, 0) +
    `173\n1\n91\n${ARGB_BYBLOCK}\n92\n-2\n290\n1\n` +
    pair(42, arrow) +
    `291\n1\n` +
    pair(43, arrow) +
    pair(3, "Standard") +
    pair(44, textHeight) +
    `300\n\n174\n1\n175\n1\n176\n0\n178\n1\n93\n${ARGB_BYBLOCK}\n` +
    pair(45, textHeight) +
    `292\n0\n297\n0\n` +
    pair(46, arrow) +
    `94\n${ARGB_BYBLOCK}\n` +
    pair(47, 1) +
    pair(49, 1) +
    pair(140, arrow) +
    `294\n1\n` +
    pair(141, 0) +
    `177\n0\n` +
    pair(142, 1) +
    `295\n0\n296\n0\n` +
    pair(143, arrow * 1.5) +
    `271\n0\n272\n9\n273\n9\n`
  );
}

/* ------------------------------ reading ------------------------------ */

export interface LeaderRecordReader {
  type: string;
  pairs: readonly { code: number; value: string }[];
}

const nz = (v: string | undefined, d = 0): number => {
  const x = v === undefined ? NaN : parseFloat(v);
  return Number.isFinite(x) ? x : d;
};

/** Vertices of a LEADER (group 10 / 20 pairs in order). */
function vertices(pairs: readonly { code: number; value: string }[]): Point[] {
  const out: Point[] = [];
  for (let i = 0; i < pairs.length; i++) {
    if (pairs[i].code !== 10) continue;
    const y = pairs[i + 1]?.code === 20 ? nz(pairs[i + 1].value) : NaN;
    if (Number.isFinite(y)) out.push({ x: nz(pairs[i].value), y });
  }
  return out;
}

/**
 * A LEADER as a `leader` dimension (file units; the caller rescales like any
 * dimension). `text` is the associated MTEXT/TEXT content when the record names
 * one. Null when it has fewer than two vertices.
 */
export function leaderFromRecord(rec: LeaderRecordReader, text: string): Omit<DimensionEntity, "id"> | null {
  const pts = vertices(rec.pairs);
  if (pts.length < 2) return null;
  const get = (code: number): string | undefined => rec.pairs.find((p) => p.code === code)?.value;
  const out: Omit<DimensionEntity, "id"> = { type: "dimension", kind: "leader", defPoints: pts, driving: false };
  const style = get(3);
  if (style) out.style = style;
  if (nz(get(72)) === 1) out.leaderSpline = true;
  const overrides: NonNullable<DimensionEntity["overrides"]> = {};
  if (nz(get(71), 1) === 0) overrides.leaderArrow = "none";
  const h = nz(get(40));
  if (h > 0) overrides.textHeight = h;
  if (Object.keys(overrides).length) out.overrides = overrides;
  if (nz(get(75)) === 0) out.landing = 0;
  if (nz(get(73)) !== 3 && text) out.textOverride = text;
  return out;
}

/** A MULTILEADER as a `leader` dimension: first line is the main one, the others become branches. Null without a usable line. */
export function mleaderFromRecord(rec: LeaderRecordReader): Omit<DimensionEntity, "id"> | null {
  const ps = rec.pairs;
  const ctxStart = ps.findIndex((p) => p.code === 300 && p.value.startsWith("CONTEXT_DATA"));
  const ctxEnd = ps.findIndex((p, i) => i > ctxStart && p.code === 301);
  if (ctxStart < 0) return null;
  const end = ctxEnd < 0 ? ps.length : ctxEnd;
  const firstLeader = ps.findIndex((p, i) => i > ctxStart && i < end && p.code === 302);
  const head = ps.slice(ctxStart + 1, firstLeader < 0 ? end : firstLeader);
  const after = ps.slice(end + 1);
  const val = (list: readonly { code: number; value: string }[], code: number): string | undefined => list.find((p) => p.code === code)?.value;
  // Walk the LEADER { } / LEADER_LINE { } nesting.
  let attach: Point | null = null;
  let dog = NaN;
  let sideX = 1;
  const lines: Point[][] = [];
  let cur: Point[] | null = null;
  let leaderSeen = false;
  let sawDogLen = false;
  for (let i = firstLeader < 0 ? end : firstLeader; i < end; i++) {
    const p = ps[i];
    if (p.code === 302) {
      leaderSeen = true;
      sawDogLen = false;
    } else if (p.code === 304 && p.value.startsWith("LEADER_LINE")) cur = [];
    else if (p.code === 305) {
      if (cur && cur.length) lines.push(cur);
      cur = null;
    } else if (p.code === 10 && ps[i + 1]?.code === 20) {
      const pt = { x: nz(p.value), y: nz(ps[i + 1].value) };
      if (cur) cur.push(pt);
      else if (leaderSeen && !attach) attach = pt;
    } else if (p.code === 11 && !cur && attach && sideX === 1 && leaderSeen) {
      sideX = nz(p.value) < 0 ? -1 : 1;
    } else if (p.code === 40 && !cur && leaderSeen && !sawDogLen) {
      dog = nz(p.value);
      sawDogLen = true;
    }
  }
  if (!attach || lines.length === 0) return null;
  const [main, ...rest] = lines;
  const out: Omit<DimensionEntity, "id"> = { type: "dimension", kind: "leader", defPoints: [...main, attach], driving: false };
  if (rest.length) out.branches = rest;
  if (nz(val(after, 170), 1) === 2) out.leaderSpline = true;
  const noDogleg = val(after, 291) === "0" || (Number.isFinite(dog) && dog <= 0);
  if (noDogleg) out.landing = 0;
  else if (Number.isFinite(dog) && dog > 0) out.landing = dog;
  const contentType = val(after, 172);
  const raw = head.find((p) => p.code === 304 && !p.value.startsWith("LEADER_LINE"))?.value;
  if (raw && contentType !== "0") out.textOverride = raw;
  const overrides: NonNullable<DimensionEntity["overrides"]> = {};
  const th = nz(val(head, 41));
  if (th > 0) overrides.textHeight = th;
  const ar = nz(val(head, 140));
  if (ar > 0) overrides.arrowSize = ar;
  if (Object.keys(overrides).length) out.overrides = overrides;
  void sideX;
  return out;
}

