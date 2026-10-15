import type { DimKind, DimensionEntity, Entity, EntityId, HatchLoop, SplineEntity } from "./entities";
import { insertLine, insertSameGeometry, parseInsertLine, type ParsedInsert } from "./blocks/insertCode";
import { hatchLine, hatchSameGeometry, parseHatchLine, type ParsedHatch } from "./hatch/hatchCode";
import { loopFromPoints } from "./hatch/loops";
import { newEntityId } from "./entities";
import { isFullEllipse } from "./ellipse";
import { clampedUniformKnots, interpolateNurbs, isValidNurbs } from "./nurbs";
import type { SketchDocument } from "./document";
import type { Command } from "./commands";

/**
 * Sketch code: a human-readable, line-oriented text form of the document.
 *
 *   sketch v1
 *
 *   line L1 from (0, 0) to (100, 0)
 *   circle C1 at (50, 25) r 20
 *
 * The same text is the manipulation surface for AI agents: they edit the
 * code, `parseCode` + `diffToCommands` turn the edit into ordinary
 * undoable commands. The grammar reserves `param`, `constraint` and `dim`
 * for the upcoming parametric layer:
 *
 *   param width = 40
 *   constraint tangent L1 C1
 *   dim L1 length = width
 */

export const SKETCH_HEADER = "sketch v1";

const RESERVED = ["param", "constraint", "dim"];

const NUM = String.raw`[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?`;
const LINE_RE = new RegExp(
  String.raw`^line\s+([A-Za-z_]\w*)\s+from\s*\(\s*(${NUM})\s*,\s*(${NUM})\s*\)\s*to\s*\(\s*(${NUM})\s*,\s*(${NUM})\s*\)$`,
);
const CIRCLE_RE = new RegExp(
  String.raw`^circle\s+([A-Za-z_]\w*)\s+at\s*\(\s*(${NUM})\s*,\s*(${NUM})\s*\)\s*r\s+(${NUM})$`,
);
const ARC_RE = new RegExp(
  String.raw`^arc\s+([A-Za-z_]\w*)\s+at\s*\(\s*(${NUM})\s*,\s*(${NUM})\s*\)\s*r\s+(${NUM})\s+from\s+(${NUM})\s+to\s+(${NUM})(\s+cw)?$`,
);
const POINT_RE = new RegExp(
  String.raw`^point\s+([A-Za-z_]\w*)\s+at\s*\(\s*(${NUM})\s*,\s*(${NUM})\s*\)$`,
);
// Note: sketch code doesn't express per-segment bulge — a polyline with
// curved (bulged) segments round-trips through code with those segments
// straightened, same as how layers already aren't expressed in code.
// Angles are the ellipse's *parametric* angles in degrees (a point is centre + major·cos t + minor·sin t), omitted = full.
const ELLIPSE_RE = new RegExp(
  String.raw`^ellipse\s+([A-Za-z_]\w*)\s+at\s*\(\s*(${NUM})\s*,\s*(${NUM})\s*\)\s*major\s*\(\s*(${NUM})\s*,\s*(${NUM})\s*\)\s*ratio\s+(${NUM})(?:\s+from\s+(${NUM})\s+to\s+(${NUM}))?$`,
);
// spline NAME degree N fit|cv (x, y) ... [knots k ...] [weights w ...] [closed] — parsed by hand (see parseSpline).
const SPLINE_HEAD_RE = /^spline\s+([A-Za-z_]\w*)\s+degree\s+(\d+)\s+(fit|cv)\s+(.*)$/;
const POINT_PAIR = String.raw`\(\s*${NUM}\s*,\s*${NUM}\s*\)`;
const POLYLINE_RE = new RegExp(
  String.raw`^polyline\s+(?<name>[A-Za-z_]\w*)\s+pts\s+(?<pts>(?:${POINT_PAIR}\s*)+)(?<closed>closed)?$`,
);
const POINT_PAIR_CAPTURE = new RegExp(String.raw`\(\s*(${NUM})\s*,\s*(${NUM})\s*\)`, "g");
const TEXT_RE = new RegExp(
  String.raw`^text\s+([A-Za-z_]\w*)\s+at\s*\(\s*(${NUM})\s*,\s*(${NUM})\s*\)\s+("(?:[^"\\]|\\.)*")\s+h\s+(${NUM})(?:\s+rot\s+(${NUM}))?$`,
);
// D-04: `mtext NAME at (x, y) "codes" h H [w WIDTH] [rot DEG] [attach 1-9]` (text keeps MTEXT codes; style, spacing, background are carried over on edit).
const MTEXT_RE = new RegExp(
  String.raw`^mtext\s+([A-Za-z_]\w*)\s+at\s*\(\s*(${NUM})\s*,\s*(${NUM})\s*\)\s+("(?:[^"\\]|\\.)*")\s+h\s+(${NUM})(?:\s+w\s+(${NUM}))?(?:\s+rot\s+(${NUM}))?(?:\s+attach\s+([1-9]))?$`,
);
// Note: sketch code carries an image's position/size/rotation only — it has
// no way to author the actual pixel data, so a new `image` line (one that
// doesn't match an existing image by name) is a no-op rather than creating a
// broken, imageless entity. See diffToCommands.
const IMAGE_RE = new RegExp(
  String.raw`^image\s+([A-Za-z_]\w*)\s+at\s*\(\s*(${NUM})\s*,\s*(${NUM})\s*\)\s+(${NUM})x(${NUM})(?:\s+rot\s+(${NUM}))?$`,
);

function fmt(n: number): string {
  const rounded = Math.round(n * 10000) / 10000;
  return String(Object.is(rounded, -0) ? 0 : rounded);
}

/**
 * Stable display names for every entity. Explicit `entity.name` wins;
 * unnamed entities get L1/C1... in insertion order, skipping taken names.
 */
export function assignNames(doc: SketchDocument): Map<EntityId, string> {
  const names = new Map<EntityId, string>();
  const used = new Set<string>();
  for (const e of doc.all()) {
    if (e.name) {
      names.set(e.id, e.name);
      used.add(e.name);
    }
  }
  const counters: Record<Entity["type"], number> = { line: 1, circle: 1, arc: 1, point: 1, ellipse: 1, spline: 1, hatch: 1, insert: 1, polyline: 1, text: 1, image: 1, dimension: 1, mtext: 1 };
  for (const e of doc.all()) {
    if (names.has(e.id)) continue;
    const prefix = NAME_PREFIX[e.type];
    let i = counters[e.type];
    while (used.has(prefix + i)) i += 1;
    counters[e.type] = i + 1;
    names.set(e.id, prefix + i);
    used.add(prefix + i);
  }
  return names;
}

const NAME_PREFIX: Record<Entity["type"], string> = { line: "L", circle: "C", arc: "A", point: "P", ellipse: "E", spline: "S", hatch: "H", insert: "I", polyline: "PL", text: "T", image: "IMG", dimension: "D", mtext: "MT" };

/** Next free name for a newly drawn entity (used by the tools). */
export function nextEntityName(doc: SketchDocument, type: Entity["type"]): string {
  const used = new Set(assignNames(doc).values());
  const prefix = NAME_PREFIX[type];
  let i = 1;
  while (used.has(prefix + i)) i += 1;
  return prefix + i;
}

const toDeg = (rad: number) => (rad * 180) / Math.PI;

/** Knots and weights keep six decimals — they are not lengths, and rounding them harder bends the curve. */
const fmt6 = (n: number): string => String(Math.round(n * 1e6) / 1e6);

function splineLine(name: string, e: SplineEntity): string {
  const pts = (list: { x: number; y: number }[]) => list.map((p) => `(${fmt(p.x)}, ${fmt(p.y)})`).join(" ");
  if (e.fitPoints) {
    const tan = (word: string, v: { x: number; y: number } | undefined) => (v ? ` ${word} (${fmt(v.x)}, ${fmt(v.y)})` : "");
    return `spline ${name} degree ${e.degree} fit ${pts(e.fitPoints)}${tan("start", e.startTangent)}${tan("end", e.endTangent)}${e.closed ? " closed" : ""}`;
  }
  const uniform = clampedUniformKnots(e.controlPoints.length, e.degree);
  const stdKnots = e.knots.length === uniform.length && e.knots.every((k, i) => Math.abs(k - uniform[i]) < 1e-9);
  return (
    `spline ${name} degree ${e.degree} cv ${pts(e.controlPoints)}` +
    (stdKnots ? "" : ` knots ${e.knots.map(fmt6).join(" ")}`) +
    (e.weights && e.weights.some((w) => w !== 1) ? ` weights ${e.weights.map(fmt6).join(" ")}` : "") +
    (e.closed ? " closed" : "")
  );
}

/** Builds a spline from a `spline …` line's tail, or returns the reason it can't. */
function parseSpline(name: string, degree: number, mode: string, rest: string): ParsedEntity | string {
  const keyAt = (word: string): number => {
    const m = new RegExp(String.raw`(?:^|\s)${word}(?=\s|$)`).exec(rest);
    return m ? m.index : -1;
  };
  const cuts = ["knots", "weights", "start", "end", "closed"].map((w) => [w, keyAt(w)] as const).filter(([, i]) => i >= 0).sort((a, b) => a[1] - b[1]);
  const section = (word: string): string | null => {
    const i = cuts.findIndex(([w]) => w === word);
    if (i < 0) return null;
    const from = cuts[i][1] + word.length + 1;
    return rest.slice(from, i + 1 < cuts.length ? cuts[i + 1][1] : rest.length).trim();
  };
  const pointsText = rest.slice(0, cuts.length > 0 ? cuts[0][1] : rest.length);
  const points: { x: number; y: number }[] = [];
  POINT_PAIR_CAPTURE.lastIndex = 0;
  let pm: RegExpExecArray | null;
  while ((pm = POINT_PAIR_CAPTURE.exec(pointsText))) points.push({ x: Number(pm[1]), y: Number(pm[2]) });
  const leftover = pointsText.replace(POINT_PAIR_CAPTURE, "").trim();
  if (leftover !== "") return `unexpected '${leftover}' in the spline's points`;
  const numbers = (text: string | null): number[] | null => (text === null ? null : text === "" ? [] : text.split(/\s+/).map(Number));
  const knots = numbers(section("knots"));
  const weights = numbers(section("weights"));
  if ((knots && knots.some(Number.isNaN)) || (weights && weights.some(Number.isNaN))) return "knots and weights must be numbers";
  const closed = keyAt("closed") >= 0;
  if (degree < 1 || degree > 11) return "spline degree must be between 1 and 11";
  if (mode === "fit") {
    if (knots || weights) return "a fit spline takes no knots or weights (they are derived)";
    const vec = (word: string): { x: number; y: number } | undefined | string => {
      const text = section(word);
      if (text === null) return undefined;
      POINT_PAIR_CAPTURE.lastIndex = 0;
      const m = POINT_PAIR_CAPTURE.exec(text);
      return m ? { x: Number(m[1]), y: Number(m[2]) } : `'${word}' needs a (dx, dy) handle vector`;
    };
    const startTangent = vec("start");
    const endTangent = vec("end");
    if (typeof startTangent === "string") return startTangent;
    if (typeof endTangent === "string") return endTangent;
    const fitted = interpolateNurbs(points, degree, closed ? undefined : { start: startTangent, end: endTangent });
    if (!fitted) return "a fit spline needs at least two distinct points";
    return { type: "spline", name, data: { ...fitted, fitPoints: points, ...(startTangent ? { startTangent } : {}), ...(endTangent ? { endTangent } : {}), closed } };
  }
  if (points.length < degree + 1) return `a degree ${degree} spline needs at least ${degree + 1} control points`;
  const data = {
    degree,
    controlPoints: points,
    knots: knots ?? clampedUniformKnots(points.length, degree),
    ...(weights ? { weights } : {}),
  };
  if (!isValidNurbs(data)) return "the spline's knots/weights are not valid (need control points + degree + 1 non-decreasing knots, one positive weight per point)";
  return { type: "spline", name, data: { ...data, closed } };
}

export function toCode(doc: SketchDocument): string {
  const names = assignNames(doc);
  const out: string[] = [SKETCH_HEADER, ""];
  for (const e of doc.all()) {
    const name = names.get(e.id)!;
    if (e.type === "line") {
      out.push(
        `line ${name} from (${fmt(e.a.x)}, ${fmt(e.a.y)}) to (${fmt(e.b.x)}, ${fmt(e.b.y)})`,
      );
    } else if (e.type === "circle") {
      out.push(
        `circle ${name} at (${fmt(e.center.x)}, ${fmt(e.center.y)}) r ${fmt(e.radius)}`,
      );
    } else if (e.type === "arc") {
      out.push(
        `arc ${name} at (${fmt(e.center.x)}, ${fmt(e.center.y)}) r ${fmt(e.radius)} ` +
          `from ${fmt(toDeg(e.startAngle))} to ${fmt(toDeg(e.endAngle))}${e.ccw ? "" : " cw"}`,
      );
    } else if (e.type === "point") {
      out.push(`point ${name} at (${fmt(e.p.x)}, ${fmt(e.p.y)})`);
    } else if (e.type === "ellipse") {
      const full = isFullEllipse(e);
      out.push(
        `ellipse ${name} at (${fmt(e.center.x)}, ${fmt(e.center.y)}) major (${fmt(e.majorAxis.x)}, ${fmt(e.majorAxis.y)}) ratio ${fmt(e.ratio)}` +
          (full ? "" : ` from ${fmt(toDeg(e.start))} to ${fmt(toDeg(e.end))}`),
      );
    } else if (e.type === "spline") {
      out.push(splineLine(name, e));
    } else if (e.type === "hatch") {
      out.push(hatchLine(name, e));
    } else if (e.type === "insert") {
      out.push(insertLine(name, e));
    } else if (e.type === "text") {
      out.push(
        `text ${name} at (${fmt(e.at.x)}, ${fmt(e.at.y)}) ${JSON.stringify(e.text)} h ${fmt(e.height)}` +
          (e.rotation ? ` rot ${fmt(toDeg(e.rotation))}` : ""),
      );
    } else if (e.type === "mtext") {
      out.push(
        `mtext ${name} at (${fmt(e.at.x)}, ${fmt(e.at.y)}) ${JSON.stringify(e.text)} h ${fmt(e.height)}` +
          (e.width ? ` w ${fmt(e.width)}` : "") +
          (e.rotation ? ` rot ${fmt(toDeg(e.rotation))}` : "") +
          (e.attachment !== 1 ? ` attach ${e.attachment}` : ""),
      );
    } else if (e.type === "dimension") {
      out.push(dimensionLine(name, e));
    } else if (e.type === "image") {
      out.push(
        `image ${name} at (${fmt(e.insert.x)}, ${fmt(e.insert.y)}) ${fmt(e.width)}x${fmt(e.height)}` +
          (e.rotation ? ` rot ${fmt(toDeg(e.rotation))}` : ""),
      );
    } else if (e.type === "polyline") {
      const pts = e.points.map((p) => `(${fmt(p.x)}, ${fmt(p.y)})`).join(" ");
      out.push(`polyline ${name} pts ${pts}${e.closed ? " closed" : ""}`);
    }
  }
  return out.join("\n") + "\n";
}

/** An entity as written in code — identified by name, not by internal id. */
export type ParsedEntity =
  | { type: "line"; name: string; a: { x: number; y: number }; b: { x: number; y: number } }
  | { type: "circle"; name: string; center: { x: number; y: number }; radius: number }
  | {
      type: "arc";
      name: string;
      center: { x: number; y: number };
      radius: number;
      startAngle: number;
      endAngle: number;
      ccw: boolean;
    }
  | { type: "point"; name: string; p: { x: number; y: number } }
  | {
      type: "ellipse";
      name: string;
      center: { x: number; y: number };
      majorAxis: { x: number; y: number };
      ratio: number;
      start: number;
      end: number;
    }
  | { type: "spline"; name: string; data: Omit<SplineEntity, "id" | "type" | "name" | "layer"> }
  | ParsedHatch
  | ParsedInsert
  | { type: "polyline"; name: string; points: { x: number; y: number }[]; closed: boolean }
  | { type: "text"; name: string; at: { x: number; y: number }; text: string; height: number; rotation: number }
  | { type: "image"; name: string; insert: { x: number; y: number }; width: number; height: number; rotation: number }
  | { type: "mtext"; name: string; at: { x: number; y: number }; text: string; height: number; rotation: number; width: number; attachment: number }
  | ParsedDimension;

/** D-02a: a dimension as written in code (angles in degrees there, radians here). Associations (`refs`, `target`) are not expressible and are carried over on edit. */
export interface ParsedDimension {
  type: "dimension";
  name: string;
  kind: DimKind;
  pts: { x: number; y: number }[];
  angle?: number;
  axis?: "x" | "y";
  textPos?: { x: number; y: number };
  textOverride?: string;
  style?: string;
  scale?: number;
  driving: boolean;
  value?: number;
}

const DIM_KINDS: readonly DimKind[] = ["linear", "aligned", "angular2l", "angular3p", "radial", "diametric", "arclength", "ordinate", "jogged"];
const DIM_HEAD_RE = /^dimension\s+([A-Za-z_]\w*)\s+([a-z0-9]+)\s*(.*)$/;
const ANGULAR_KINDS = new Set<DimKind>(["angular2l", "angular3p"]);

/** Points each dimension kind needs. */
const DIM_POINTS: Record<DimKind, number> = { linear: 3, aligned: 3, angular2l: 5, angular3p: 4, radial: 2, diametric: 2, arclength: 4, ordinate: 3, jogged: 3 };

function parseDimension(row: string): ParsedDimension | string {
  const head = DIM_HEAD_RE.exec(row);
  if (!head) return "dimension NAME KIND (x, y) ... [angle DEG] [axis x|y] [textat (x, y)] [text \"...\"] [style NAME] [scale K] [driving VALUE]";
  const kind = head[2] as DimKind;
  if (!DIM_KINDS.includes(kind)) return `unknown dimension kind '${head[2]}' (${DIM_KINDS.join(", ")})`;
  let rest = head[3];
  const take = (re: RegExp): RegExpExecArray | null => {
    const m = re.exec(rest);
    if (m) rest = (rest.slice(0, m.index) + " " + rest.slice(m.index + m[0].length)).trim();
    return m;
  };
  const textM = take(/(?:^|\s)text\s+("(?:[^"\\]|\\.)*")/);
  let textOverride: string | undefined;
  if (textM) {
    try {
      textOverride = JSON.parse(textM[1]) as string;
    } catch {
      return "dimension text must be a quoted string";
    }
  }
  const textAt = take(new RegExp(String.raw`(?:^|\s)textat\s*\(\s*(${NUM})\s*,\s*(${NUM})\s*\)`));
  const angle = take(new RegExp(String.raw`(?:^|\s)angle\s+(${NUM})`));
  const axis = take(/(?:^|\s)axis\s+(x|y)(?=\s|$)/);
  const style = take(/(?:^|\s)style\s+(\S+)/);
  const scale = take(new RegExp(String.raw`(?:^|\s)scale\s+(${NUM})`));
  const driving = take(new RegExp(String.raw`(?:^|\s)driving\s+(${NUM})`));
  const pts: { x: number; y: number }[] = [];
  POINT_PAIR_CAPTURE.lastIndex = 0;
  let pm: RegExpExecArray | null;
  while ((pm = POINT_PAIR_CAPTURE.exec(rest))) pts.push({ x: Number(pm[1]), y: Number(pm[2]) });
  const leftover = rest.replace(POINT_PAIR_CAPTURE, "").trim();
  if (leftover !== "") return `unexpected '${leftover}' in the dimension`;
  if (pts.length < DIM_POINTS[kind]) return `a ${kind} dimension needs ${DIM_POINTS[kind]} points`;
  const toRad = (d: number) => (d * Math.PI) / 180;
  return {
    type: "dimension",
    name: head[1],
    kind,
    pts: pts.slice(0, DIM_POINTS[kind]),
    ...(angle ? { angle: toRad(Number(angle[1])) } : {}),
    ...(axis ? { axis: axis[1] as "x" | "y" } : {}),
    ...(textAt ? { textPos: { x: Number(textAt[1]), y: Number(textAt[2]) } } : {}),
    ...(textOverride !== undefined ? { textOverride } : {}),
    ...(style ? { style: style[1] } : {}),
    ...(scale ? { scale: Number(scale[1]) } : {}),
    driving: !!driving,
    ...(driving ? { value: ANGULAR_KINDS.has(kind) ? toRad(Number(driving[1])) : Number(driving[1]) } : {}),
  };
}

function dimensionLine(name: string, e: DimensionEntity): string {
  const f = (p: { x: number; y: number }) => `(${fmt(p.x)}, ${fmt(p.y)})`;
  const deg = (r: number) => fmt((r * 180) / Math.PI);
  return (
    `dimension ${name} ${e.kind} ${e.defPoints.map(f).join(" ")}` +
    (e.angle ? ` angle ${deg(e.angle)}` : "") +
    (e.axis ? ` axis ${e.axis}` : "") +
    (e.textPos ? ` textat ${f(e.textPos)}` : "") +
    (e.textOverride ? ` text ${JSON.stringify(e.textOverride)}` : "") +
    (e.style ? ` style ${e.style}` : "") +
    (e.scale && e.scale !== 1 ? ` scale ${fmt(e.scale)}` : "") +
    (e.driving && e.value !== undefined ? ` driving ${ANGULAR_KINDS.has(e.kind) ? deg(e.value) : fmt(e.value)}` : "")
  );
}

export interface ParseIssue {
  line: number;
  message: string;
}

export function parseCode(text: string): { entities: ParsedEntity[]; errors: ParseIssue[] } {
  const entities: ParsedEntity[] = [];
  const errors: ParseIssue[] = [];
  const seenNames = new Set<string>();

  const rows = text.split(/\r?\n/);
  for (let i = 0; i < rows.length; i++) {
    const lineNo = i + 1;
    const row = rows[i].trim();
    if (row === "" || row.startsWith("#") || row === SKETCH_HEADER) continue;

    const keyword = row.split(/\s+/, 1)[0].toLowerCase();
    if (RESERVED.includes(keyword)) {
      errors.push({
        line: lineNo,
        message: `'${keyword}' is reserved for the parametric layer and not supported yet`,
      });
      continue;
    }

    let parsed: ParsedEntity | null = null;
    let match = row.match(LINE_RE);
    if (match) {
      parsed = {
        type: "line",
        name: match[1],
        a: { x: Number(match[2]), y: Number(match[3]) },
        b: { x: Number(match[4]), y: Number(match[5]) },
      };
    } else if ((match = row.match(CIRCLE_RE))) {
      const radius = Number(match[4]);
      if (radius <= 0) {
        errors.push({ line: lineNo, message: "circle radius must be positive" });
        continue;
      }
      parsed = {
        type: "circle",
        name: match[1],
        center: { x: Number(match[2]), y: Number(match[3]) },
        radius,
      };
    } else if ((match = row.match(ARC_RE))) {
      const radius = Number(match[4]);
      if (radius <= 0) {
        errors.push({ line: lineNo, message: "arc radius must be positive" });
        continue;
      }
      parsed = {
        type: "arc",
        name: match[1],
        center: { x: Number(match[2]), y: Number(match[3]) },
        radius,
        startAngle: (Number(match[5]) * Math.PI) / 180,
        endAngle: (Number(match[6]) * Math.PI) / 180,
        ccw: !match[7],
      };
    } else if ((match = row.match(ELLIPSE_RE))) {
      const major = { x: Number(match[4]), y: Number(match[5]) };
      const ratio = Number(match[6]);
      if (Math.hypot(major.x, major.y) <= 0) {
        errors.push({ line: lineNo, message: "ellipse major axis must not be zero-length" });
        continue;
      }
      if (!(ratio > 0 && ratio <= 1)) {
        errors.push({ line: lineNo, message: "ellipse ratio (minor/major) must be above 0 and at most 1" });
        continue;
      }
      parsed = {
        type: "ellipse",
        name: match[1],
        center: { x: Number(match[2]), y: Number(match[3]) },
        majorAxis: major,
        ratio,
        start: match[7] === undefined ? 0 : (Number(match[7]) * Math.PI) / 180,
        end: match[8] === undefined ? Math.PI * 2 : (Number(match[8]) * Math.PI) / 180,
      };
    } else if ((match = row.match(SPLINE_HEAD_RE))) {
      const built = parseSpline(match[1], Number(match[2]), match[3], match[4]);
      if (typeof built === "string") {
        errors.push({ line: lineNo, message: built });
        continue;
      }
      parsed = built;
    } else if (keyword === "insert") {
      const built = parseInsertLine(row);
      if (typeof built === "string") {
        errors.push({ line: lineNo, message: built });
        continue;
      }
      parsed = built;
    } else if (keyword === "hatch") {
      const built = parseHatchLine(row);
      if (typeof built === "string") {
        errors.push({ line: lineNo, message: built });
        continue;
      }
      parsed = built;
    } else if ((match = row.match(POINT_RE))) {
      parsed = { type: "point", name: match[1], p: { x: Number(match[2]), y: Number(match[3]) } };
    } else if ((match = row.match(TEXT_RE))) {
      const height = Number(match[5]);
      if (height <= 0) {
        errors.push({ line: lineNo, message: "text height must be positive" });
        continue;
      }
      let content = "";
      try {
        content = JSON.parse(match[4]) as string;
      } catch {
        errors.push({ line: lineNo, message: "text content must be a quoted string" });
        continue;
      }
      parsed = {
        type: "text",
        name: match[1],
        at: { x: Number(match[2]), y: Number(match[3]) },
        text: content,
        height,
        rotation: match[6] ? (Number(match[6]) * Math.PI) / 180 : 0,
      };
    } else if ((match = row.match(MTEXT_RE))) {
      const height = Number(match[5]);
      let content = "";
      try {
        content = JSON.parse(match[4]) as string;
      } catch {
        errors.push({ line: lineNo, message: "mtext content must be a quoted string" });
        continue;
      }
      if (!(height > 0)) {
        errors.push({ line: lineNo, message: "mtext height must be positive" });
        continue;
      }
      parsed = {
        type: "mtext",
        name: match[1],
        at: { x: Number(match[2]), y: Number(match[3]) },
        text: content,
        height,
        width: match[6] ? Number(match[6]) : 0,
        rotation: match[7] ? (Number(match[7]) * Math.PI) / 180 : 0,
        attachment: match[8] ? Number(match[8]) : 1,
      };
    } else if ((match = row.match(IMAGE_RE))) {
      const width = Number(match[4]);
      const height = Number(match[5]);
      if (width <= 0 || height <= 0) {
        errors.push({ line: lineNo, message: "image width/height must be positive" });
        continue;
      }
      parsed = {
        type: "image",
        name: match[1],
        insert: { x: Number(match[2]), y: Number(match[3]) },
        width,
        height,
        rotation: match[6] ? (Number(match[6]) * Math.PI) / 180 : 0,
      };
    } else if ((match = row.match(POLYLINE_RE))) {
      const points: { x: number; y: number }[] = [];
      POINT_PAIR_CAPTURE.lastIndex = 0;
      let pm: RegExpExecArray | null;
      while ((pm = POINT_PAIR_CAPTURE.exec(match.groups!.pts))) {
        points.push({ x: Number(pm[1]), y: Number(pm[2]) });
      }
      if (points.length < 2) {
        errors.push({ line: lineNo, message: "polyline needs at least 2 points" });
        continue;
      }
      parsed = { type: "polyline", name: match.groups!.name, points, closed: !!match.groups!.closed };
    } else if (keyword === "dimension") {
      const r = parseDimension(row);
      if (typeof r === "string") {
        errors.push({ line: lineNo, message: r });
        continue;
      }
      parsed = r;
    }

    if (!parsed) {
      const known = ["line", "circle", "arc", "point", "ellipse", "spline", "hatch", "insert", "polyline", "text", "mtext", "image", "dimension"];
      errors.push({
        line: lineNo,
        message: known.includes(keyword)
          ? `could not parse ${keyword} — expected: ` +
            (keyword === "line"
              ? "line NAME from (x, y) to (x, y)"
              : keyword === "circle"
                ? "circle NAME at (x, y) r RADIUS"
                : keyword === "arc"
                  ? "arc NAME at (x, y) r RADIUS from DEG to DEG [cw]"
                  : keyword === "point"
                    ? "point NAME at (x, y)"
                    : keyword === "spline"
                      ? "spline NAME degree N fit (x, y) ... [start (dx, dy)] [end (dx, dy)] | cv (x, y) ... [knots k ...] [weights w ...] [closed]"
                    : keyword === "ellipse"
                      ? "ellipse NAME at (x, y) major (dx, dy) ratio R [from DEG to DEG]"
                    : keyword === "text"
                      ? 'text NAME at (x, y) "content" h HEIGHT [rot DEG]'
                      : keyword === "mtext"
                        ? 'mtext NAME at (x, y) "content" h HEIGHT [w WIDTH] [rot DEG] [attach 1-9]'
                      : keyword === "image"
                        ? "image NAME at (x, y) WIDTHxHEIGHT [rot DEG]"
                        : "polyline NAME pts (x, y) (x, y) ... [closed]")
          : `unknown statement '${keyword}'`,
      });
      continue;
    }

    if (seenNames.has(parsed.name)) {
      errors.push({ line: lineNo, message: `duplicate name '${parsed.name}'` });
      continue;
    }
    seenNames.add(parsed.name);
    entities.push(parsed);
  }
  return { entities, errors };
}

const EPS = 1e-9;

function sameGeometry(existing: Entity, parsed: ParsedEntity): boolean {
  if (existing.type !== parsed.type) return false;
  if (existing.type === "line" && parsed.type === "line") {
    return (
      Math.abs(existing.a.x - parsed.a.x) < EPS &&
      Math.abs(existing.a.y - parsed.a.y) < EPS &&
      Math.abs(existing.b.x - parsed.b.x) < EPS &&
      Math.abs(existing.b.y - parsed.b.y) < EPS
    );
  }
  if (existing.type === "circle" && parsed.type === "circle") {
    return (
      Math.abs(existing.center.x - parsed.center.x) < EPS &&
      Math.abs(existing.center.y - parsed.center.y) < EPS &&
      Math.abs(existing.radius - parsed.radius) < EPS
    );
  }
  if (existing.type === "arc" && parsed.type === "arc") {
    return (
      Math.abs(existing.center.x - parsed.center.x) < EPS &&
      Math.abs(existing.center.y - parsed.center.y) < EPS &&
      Math.abs(existing.radius - parsed.radius) < EPS &&
      Math.abs(existing.startAngle - parsed.startAngle) < EPS &&
      Math.abs(existing.endAngle - parsed.endAngle) < EPS &&
      existing.ccw === parsed.ccw
    );
  }
  if (existing.type === "spline" && parsed.type === "spline") {
    // Code carries 4 decimals, so compare to that, not to 1e-9.
    const near = (a: number, b: number) => Math.abs(a - b) < 1e-4;
    const d = parsed.data;
    const ptsSame = (a: { x: number; y: number }[] | undefined, b: { x: number; y: number }[] | undefined) =>
      (a === undefined) === (b === undefined) && (!a || (a.length === b!.length && a.every((p, i) => near(p.x, b![i].x) && near(p.y, b![i].y))));
    return (
      existing.degree === d.degree &&
      existing.closed === d.closed &&
      ptsSame(existing.fitPoints, d.fitPoints) &&
      ptsSame(existing.startTangent && [existing.startTangent], d.startTangent && [d.startTangent]) &&
      ptsSame(existing.endTangent && [existing.endTangent], d.endTangent && [d.endTangent]) &&
      (existing.fitPoints !== undefined || ptsSame(existing.controlPoints, d.controlPoints)) &&
      existing.knots.length === d.knots.length &&
      (existing.fitPoints !== undefined || existing.knots.every((k, i) => Math.abs(k - d.knots[i]) < 1e-6)) &&
      (existing.fitPoints !== undefined || (existing.weights ?? []).every((w, i) => Math.abs(w - (d.weights?.[i] ?? 1)) < 1e-6))
    );
  }
  if (existing.type === "ellipse" && parsed.type === "ellipse") {
    return (
      Math.abs(existing.center.x - parsed.center.x) < EPS &&
      Math.abs(existing.center.y - parsed.center.y) < EPS &&
      Math.abs(existing.majorAxis.x - parsed.majorAxis.x) < EPS &&
      Math.abs(existing.majorAxis.y - parsed.majorAxis.y) < EPS &&
      Math.abs(existing.ratio - parsed.ratio) < EPS &&
      Math.abs(existing.start - parsed.start) < EPS &&
      Math.abs(existing.end - parsed.end) < EPS
    );
  }
  if (existing.type === "hatch" && parsed.type === "hatch") return hatchSameGeometry(existing, parsed);
  if (existing.type === "insert" && parsed.type === "insert") return insertSameGeometry(existing, parsed);
  if (existing.type === "point" && parsed.type === "point") {
    return Math.abs(existing.p.x - parsed.p.x) < EPS && Math.abs(existing.p.y - parsed.p.y) < EPS;
  }
  if (existing.type === "polyline" && parsed.type === "polyline") {
    return (
      existing.closed === parsed.closed &&
      existing.points.length === parsed.points.length &&
      existing.points.every(
        (p, i) => Math.abs(p.x - parsed.points[i].x) < EPS && Math.abs(p.y - parsed.points[i].y) < EPS,
      )
    );
  }
  if (existing.type === "dimension" && parsed.type === "dimension") {
    const near = (a: number | undefined, b: number | undefined) => (a === undefined || b === undefined ? a === b : Math.abs(a - b) < EPS);
    return (
      existing.kind === parsed.kind &&
      existing.defPoints.length === parsed.pts.length &&
      existing.defPoints.every((p, i) => Math.abs(p.x - parsed.pts[i].x) < EPS && Math.abs(p.y - parsed.pts[i].y) < EPS) &&
      near(existing.angle ?? 0, parsed.angle ?? 0) &&
      existing.axis === parsed.axis &&
      (existing.textPos === undefined) === (parsed.textPos === undefined) &&
      (!existing.textPos || !parsed.textPos || (Math.abs(existing.textPos.x - parsed.textPos.x) < EPS && Math.abs(existing.textPos.y - parsed.textPos.y) < EPS)) &&
      (existing.textOverride ?? "") === (parsed.textOverride ?? "") &&
      existing.style === parsed.style &&
      near(existing.scale ?? 1, parsed.scale ?? 1) &&
      existing.driving === parsed.driving &&
      near(existing.driving ? existing.value : undefined, parsed.driving ? parsed.value : undefined)
    );
  }
  if (existing.type === "mtext" && parsed.type === "mtext") {
    return (
      existing.text === parsed.text &&
      Math.abs(existing.at.x - parsed.at.x) < EPS &&
      Math.abs(existing.at.y - parsed.at.y) < EPS &&
      Math.abs(existing.height - parsed.height) < EPS &&
      Math.abs(existing.width - parsed.width) < EPS &&
      Math.abs(existing.rotation - parsed.rotation) < EPS &&
      existing.attachment === parsed.attachment
    );
  }
  if (existing.type === "text" && parsed.type === "text") {
    return (
      existing.text === parsed.text &&
      Math.abs(existing.at.x - parsed.at.x) < EPS &&
      Math.abs(existing.at.y - parsed.at.y) < EPS &&
      Math.abs(existing.height - parsed.height) < EPS &&
      Math.abs(existing.rotation - parsed.rotation) < EPS
    );
  }
  if (existing.type === "image" && parsed.type === "image") {
    return (
      Math.abs(existing.insert.x - parsed.insert.x) < EPS &&
      Math.abs(existing.insert.y - parsed.insert.y) < EPS &&
      Math.abs(existing.width - parsed.width) < EPS &&
      Math.abs(existing.height - parsed.height) < EPS &&
      Math.abs(existing.rotation - parsed.rotation) < EPS
    );
  }
  return false;
}

/**
 * `bulges` only applies when re-emitting an existing polyline whose points
 * came back unchanged apart from being re-typed in code — sketch code itself
 * never specifies bulge. `imageDataUrl` is the same idea for an image's pixel
 * data: sketch code carries only its position/size/rotation, so updating an
 * existing image must carry its `dataUrl` forward from the entity being
 * replaced. Never called to *create* a new image (see diffToCommands).
 */
export function toEntity(parsed: ParsedEntity, id: EntityId, layer?: string, bulges?: number[], imageDataUrl?: string, hatchLoops?: HatchLoop[]): Entity {
  const layerProp = layer ? { layer } : {};
  switch (parsed.type) {
    case "insert":
      return {
        id,
        type: "insert",
        name: parsed.name,
        ...layerProp,
        block: parsed.block,
        insert: parsed.at,
        scale: parsed.scale,
        rotation: parsed.rotation,
        attributes: {},
        ...(parsed.array ? { array: parsed.array } : {}),
      };
    case "hatch":
      return {
        id,
        type: "hatch",
        name: parsed.name,
        ...layerProp,
        loops: parsed.boundary ? parsed.boundary.map(loopFromPoints) : (hatchLoops ?? []),
        paint: parsed.paint,
        style: parsed.style,
      };
    case "line":
      return { id, type: "line", name: parsed.name, ...layerProp, a: parsed.a, b: parsed.b };
    case "circle":
      return {
        id,
        type: "circle",
        name: parsed.name,
        ...layerProp,
        center: parsed.center,
        radius: parsed.radius,
      };
    case "arc":
      return {
        id,
        type: "arc",
        name: parsed.name,
        ...layerProp,
        center: parsed.center,
        radius: parsed.radius,
        startAngle: parsed.startAngle,
        endAngle: parsed.endAngle,
        ccw: parsed.ccw,
      };
    case "point":
      return { id, type: "point", name: parsed.name, ...layerProp, p: parsed.p };
    case "spline":
      return { id, type: "spline", name: parsed.name, ...layerProp, ...parsed.data };
    case "ellipse":
      return {
        id,
        type: "ellipse",
        name: parsed.name,
        ...layerProp,
        center: parsed.center,
        majorAxis: parsed.majorAxis,
        ratio: parsed.ratio,
        start: parsed.start,
        end: parsed.end,
      };
    case "dimension":
      return {
        id,
        type: "dimension",
        name: parsed.name,
        ...layerProp,
        kind: parsed.kind,
        defPoints: parsed.pts,
        ...(parsed.angle !== undefined ? { angle: parsed.angle } : {}),
        ...(parsed.axis ? { axis: parsed.axis } : {}),
        ...(parsed.textPos ? { textPos: parsed.textPos } : {}),
        ...(parsed.textOverride !== undefined ? { textOverride: parsed.textOverride } : {}),
        ...(parsed.style ? { style: parsed.style } : {}),
        ...(parsed.scale !== undefined ? { scale: parsed.scale } : {}),
        driving: parsed.driving,
        ...(parsed.value !== undefined ? { value: parsed.value } : {}),
      };
    case "mtext":
      return {
        id,
        type: "mtext",
        name: parsed.name,
        ...layerProp,
        at: parsed.at,
        text: parsed.text,
        height: parsed.height,
        width: parsed.width,
        rotation: parsed.rotation,
        attachment: parsed.attachment,
      };
    case "text":
      return {
        id,
        type: "text",
        name: parsed.name,
        ...layerProp,
        at: parsed.at,
        text: parsed.text,
        height: parsed.height,
        rotation: parsed.rotation,
      };
    case "polyline":
      return {
        id,
        type: "polyline",
        name: parsed.name,
        ...layerProp,
        points: parsed.points,
        closed: parsed.closed,
        ...(bulges ? { bulges } : {}),
      };
    case "image":
      return {
        id,
        type: "image",
        name: parsed.name,
        ...layerProp,
        insert: parsed.insert,
        width: parsed.width,
        height: parsed.height,
        rotation: parsed.rotation,
        dataUrl: imageDataUrl ?? "",
      };
  }
}

/**
 * Computes the commands that transform the document into the parsed code.
 * Entities are matched by display name; unmatched names are added,
 * missing ones deleted, changed ones updated in place (same id).
 */
export function diffToCommands(doc: SketchDocument, parsed: ParsedEntity[]): Command[] {
  const names = assignNames(doc);
  const byName = new Map<string, Entity>();
  for (const e of doc.all()) byName.set(names.get(e.id)!, e);

  const commands: Command[] = [];
  const keep = new Set<string>();

  for (const p of parsed) {
    const existing = byName.get(p.name);
    if (existing) {
      keep.add(p.name);
      if (!sameGeometry(existing, p) || existing.name !== p.name) {
        // Preserve the entity's layer (and a polyline's bulges, or an image's
        // pixel data) — sketch code doesn't express any of those.
        const updated = toEntity(
          p,
          existing.id,
          existing.layer,
          existing.type === "polyline" ? existing.bulges : undefined,
          existing.type === "image" ? existing.dataUrl : undefined,
          existing.type === "hatch" ? existing.loops : undefined,
        );
        if (existing.type === "insert" && updated.type === "insert") {
          // Code carries neither attribute values nor dynamic-block params: keep them.
          updated.attributes = existing.attributes;
          if (existing.params !== undefined) updated.params = existing.params;
        }
        if (existing.type === "hatch" && updated.type === "hatch") {
          // Code carries neither a pattern's own line families nor association/background: keep them.
          const ex = existing.paint;
          if (ex.kind === "pattern" && updated.paint.kind === "pattern" && ex.name === updated.paint.name && ex.def) updated.paint.def = ex.def;
          if (ex.kind === "gradient" && updated.paint.kind === "gradient") {
            if (ex.centered !== undefined) updated.paint.centered = ex.centered;
            if (ex.shift !== undefined) updated.paint.shift = ex.shift;
          }
          if (existing.associative !== undefined) updated.associative = existing.associative;
          if (existing.sources) updated.sources = existing.sources;
          if (existing.boundaryLost) updated.boundaryLost = existing.boundaryLost;
          if (existing.drawOrder !== undefined) updated.drawOrder = existing.drawOrder;
          if (existing.backgroundColor !== undefined) updated.backgroundColor = existing.backgroundColor;
          if (existing.transparency !== undefined) updated.transparency = existing.transparency;
        }
        // Sketch code has no word for colour, fill, linetype, lineweight,
        // construction, or a line's infinite flag — carry all of them over
        // from the entity being replaced, the same way layer/bulges/image
        // data already are above (CLAUDE.md's rule for a new entity field:
        // "the DSL can't express it, so an edit must carry it over").
        if (existing.color !== undefined) updated.color = existing.color;
        if ("fill" in existing && existing.fill !== undefined) updated.fill = existing.fill;
        if (existing.linetype !== undefined) updated.linetype = existing.linetype;
        if (existing.lineweight !== undefined) updated.lineweight = existing.lineweight;
        if (existing.construction !== undefined) updated.construction = existing.construction;
        if (existing.type === "line" && existing.infinite && updated.type === "line") updated.infinite = true;
        if (existing.type === "dimension" && updated.type === "dimension") {
          // Code carries neither the associations to geometry nor style overrides / expressions: keep them.
          if (existing.refs) updated.refs = existing.refs;
          if (existing.target) updated.target = existing.target;
          if (existing.targets) updated.targets = existing.targets;
          if (existing.overrides) updated.overrides = existing.overrides;
          if (existing.expression) updated.expression = existing.expression;
        }
        if (existing.type === "mtext" && updated.type === "mtext") {
          for (const k of ["style", "lineSpacing", "background"] as const) {
            if (existing[k] !== undefined) (updated as unknown as Record<string, unknown>)[k] = existing[k];
          }
        }
        if (existing.type === "text" && updated.type === "text") {
          // D-01: style, alignment, width factor and oblique have no sketch-code word either.
          for (const k of ["style", "halign", "valign", "widthFactor", "oblique"] as const) {
            if (existing[k] !== undefined) (updated as unknown as Record<string, unknown>)[k] = existing[k];
          }
        }
        commands.push({ type: "update-entity", entity: updated });
      }
    } else if (p.type === "hatch" && !p.boundary) {
      // `loops N` describes curved boundaries code cannot author: nothing to create.
    } else if (p.type !== "image") {
      // An image can't be created from sketch code — it has no way to author
      // pixel data — so a new `image` line that doesn't match an existing
      // image by name is silently ignored rather than adding a broken,
      // imageless entity. Placing an image is the Image tool's job.
      commands.push({ type: "add-entity", entity: toEntity(p, newEntityId()) });
    }
  }

  const removed = [...byName.entries()]
    .filter(([name]) => !keep.has(name))
    .map(([, e]) => e.id);
  if (removed.length > 0) {
    commands.push({ type: "delete-entities", ids: removed });
  }
  return commands;
}
