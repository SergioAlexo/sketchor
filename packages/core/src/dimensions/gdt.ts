import type { DimensionEntity } from "../entities";
import { newEntityId } from "../entities";
import { textToStrokes } from "../font";
import type { Point } from "../geometry";
import { pair } from "../dxfw/write";
import type { DimBuildOptions } from "./build";

/**
 * D-06: GD&T feature control frames. A frame is a `DimensionEntity` of kind
 * `tolerance`; its content lives in `textOverride` as plain, typeable text —
 * one row per line, cells split by `|`:
 *
 *     position|Ø0.5(M)|A|B(M)|C        symbol | tolerance | up to 3 datums
 *     flatness|0.05                    no datums
 *     position|Ø0.5(M)|A|B\n|Ø0.2|A    composite frame: a row with an empty symbol shares the symbol cell
 *
 * `Ø` is the diameter zone, `(M) (L) (S) (F) (P) (T) (U)` the circled modifiers
 * (MMC, LMC, RFS, free state, projected, tangent plane, unequal bilateral).
 * `layoutFcf` is the one pure layout (strokes only, so the canvas, SVG, PDF,
 * EPS and R12 all draw the same frame); `fcfToDxf` / `fcfFromDxf` convert to
 * the TOLERANCE record's `{\Fgdt;x}` / `%%v` / `^J` string.
 */

export interface GdtSymbol {
  key: string;
  label: string;
  /** Letter in AutoCAD's `gdt` font (best effort; unknown letters read back as no symbol). */
  letter: string;
}

/** The 14 characteristic symbols of ISO 1101 / ASME Y14.5. */
export const GDT_SYMBOLS: readonly GdtSymbol[] = [
  { key: "straightness", label: "Straightness", letter: "f" },
  { key: "flatness", label: "Flatness", letter: "c" },
  { key: "circularity", label: "Circularity", letter: "e" },
  { key: "cylindricity", label: "Cylindricity", letter: "g" },
  { key: "profile-line", label: "Profile of a line", letter: "k" },
  { key: "profile-surface", label: "Profile of a surface", letter: "d" },
  { key: "angularity", label: "Angularity", letter: "a" },
  { key: "perpendicularity", label: "Perpendicularity", letter: "b" },
  { key: "parallelism", label: "Parallelism", letter: "h" },
  { key: "position", label: "Position", letter: "j" },
  { key: "concentricity", label: "Concentricity", letter: "r" },
  { key: "symmetry", label: "Symmetry", letter: "i" },
  { key: "runout", label: "Circular runout", letter: "u" },
  { key: "total-runout", label: "Total runout", letter: "t" },
];

const SYMBOL_ALIASES: Record<string, string> = {
  pos: "position", tp: "position", straight: "straightness", flat: "flatness", circ: "circularity", round: "circularity", cyl: "cylindricity",
  pline: "profile-line", "profile-of-a-line": "profile-line", psurf: "profile-surface", profile: "profile-surface", "profile-of-a-surface": "profile-surface",
  ang: "angularity", perp: "perpendicularity", para: "parallelism", par: "parallelism", conc: "concentricity", sym: "symmetry",
  circularrunout: "runout", "circular-runout": "runout", trunout: "total-runout", totalrunout: "total-runout",
};

/** Canonical symbol key for a typed name or alias; null when it names none. */
export function gdtSymbolKey(name: string): string | null {
  const k = name.trim().toLowerCase().replace(/[\s_]+/g, "-");
  if (GDT_SYMBOLS.some((s) => s.key === k)) return k;
  const a = SYMBOL_ALIASES[k];
  return a ?? null;
}

export const FCF_MODIFIERS = ["M", "L", "S", "F", "P", "T", "U"] as const;

export type FcfItem = { kind: "dia" } | { kind: "mod"; ch: string } | { kind: "text"; text: string };
export interface FcfRow {
  /** Canonical symbol key, "" for none (a composite frame's lower rows), or the raw text when unknown. */
  symbol: string;
  /** Tolerance cell first, then datum cells. */
  cells: FcfItem[][];
}

function parseCell(s: string): FcfItem[] {
  const out: FcfItem[] = [];
  const re = /(Ø|⌀|%%[cC])|\(([A-Za-z])\)|([^()Ø⌀%]+|%)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s))) {
    if (m[1]) out.push({ kind: "dia" });
    else if (m[2]) out.push({ kind: "mod", ch: m[2].toUpperCase() });
    else {
      const t = m[3].trim();
      if (t) out.push({ kind: "text", text: t });
    }
  }
  return out;
}

/** Parses the frame text; never throws (an empty string is no rows). */
export function parseFcf(text: string | undefined): FcfRow[] {
  if (!text) return [];
  const rows: FcfRow[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (line.trim() === "" && rows.length > 0) continue;
    const parts = line.split("|");
    const sym = (parts[0] ?? "").trim();
    const key = sym === "" ? "" : (gdtSymbolKey(sym) ?? sym);
    rows.push({ symbol: key, cells: parts.slice(1, 5).map(parseCell) });
  }
  return rows;
}

/** Canonical text of parsed rows (what `parseFcf` reads back). */
export function fcfText(rows: readonly FcfRow[]): string {
  const cell = (c: FcfItem[]) => c.map((i) => (i.kind === "dia" ? "Ø" : i.kind === "mod" ? `(${i.ch})` : i.text)).join("");
  return rows.map((r) => [r.symbol, ...r.cells.map(cell)].join("|")).join("\n");
}

/**
 * The command line's typed form -> frame text. Tokens are space-separated:
 * `position Ø0.5(M) A B(M)`; `/` starts the next row of a composite frame
 * (`position Ø0.5 A / Ø0.2 A`). A leading token that names no symbol is taken
 * as the tolerance of a position frame. `*` is shorthand for the Ø.
 */
export function fcfFromTyped(typed: string): string {
  const rowsIn = typed.split("/").map((r) => r.trim().split(/\s+/).filter(Boolean));
  const rows: string[] = [];
  rowsIn.forEach((tokens, i) => {
    if (tokens.length === 0) return;
    let symbol = "";
    if (i === 0) {
      const key = gdtSymbolKey(tokens[0]);
      if (key) {
        symbol = key;
        tokens = tokens.slice(1);
      } else symbol = "position";
    }
    rows.push([symbol, ...tokens.map((t) => t.replace(/^\*/, "Ø"))].join("|"));
  });
  return rows.join("\n");
}

export function buildTolerance(content: string, at: Point, o: DimBuildOptions = {}): DimensionEntity {
  return {
    id: o.id ?? newEntityId(),
    type: "dimension",
    kind: "tolerance",
    defPoints: [{ x: at.x, y: at.y }],
    driving: false,
    textOverride: content,
    ...(o.layer && o.layer !== "0" ? { layer: o.layer } : {}),
    ...(o.style ? { style: o.style } : {}),
  };
}

// ---------------------------------------------------------------- DXF text

const modLetter = (ch: string) => ch.toLowerCase();

/** Frame text -> the TOLERANCE record's group-1 string. */
export function fcfToDxf(text: string | undefined): string {
  const tag = (l: string) => `{\\Fgdt;${l}}`;
  return parseFcf(text)
    .map((r) => {
      const sym = GDT_SYMBOLS.find((s) => s.key === r.symbol);
      const cells = r.cells.map((c) => c.map((i) => (i.kind === "dia" ? tag("n") : i.kind === "mod" ? tag(modLetter(i.ch)) : i.text)).join(""));
      return [sym ? tag(sym.letter) : "", ...cells].join("%%v");
    })
    .join("^J");
}

/** A TOLERANCE record's group-1 string -> frame text (best effort; never throws). */
export function fcfFromDxf(s: string): string {
  const cellText = (raw: string, first: boolean): string => {
    let out = "";
    let pos = 0;
    const re = /\{\\F[^;{}]*;([^{}]*)\}|%%[cC]/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(raw))) {
      out += raw.slice(pos, m.index);
      pos = m.index + m[0].length;
      if (m[0].startsWith("%%")) out += "Ø";
      else if (first) {
        const sym = GDT_SYMBOLS.find((x) => x.letter === m![1]);
        out += sym ? sym.key : "";
      } else if (m[1] === "n") out += "Ø";
      else if (m[1].length === 1) out += `(${m[1].toUpperCase()})`;
    }
    out += raw.slice(pos);
    return out.replace(/[{}]/g, "").trim();
  };
  return s
    .split(/\^J|\r?\n/)
    .map((line) => line.split(/%%[vV]/).map((c, i) => cellText(c, i === 0)).join("|"))
    .join("\n");
}

// ---------------------------------------------------------------- layout

const circle = (cx: number, cy: number, r: number, n = 28): Point[] => {
  const pts: Point[] = [];
  for (let i = 0; i <= n; i++) pts.push({ x: cx + r * Math.cos((i / n) * Math.PI * 2), y: cy + r * Math.sin((i / n) * Math.PI * 2) });
  return pts;
};
const arc = (cx: number, cy: number, r: number, a0: number, a1: number, n = 16): Point[] => {
  const pts: Point[] = [];
  for (let i = 0; i <= n; i++) pts.push({ x: cx + r * Math.cos(a0 + ((a1 - a0) * i) / n), y: cy + r * Math.sin(a0 + ((a1 - a0) * i) / n) });
  return pts;
};
const P = (x: number, y: number): Point => ({ x, y });

/** Stroke picture of a characteristic symbol, centred on the origin, fitting a box of about ±r. */
export function gdtSymbolStrokes(key: string, r: number): Point[][] {
  switch (key) {
    case "straightness":
      return [[P(-r, 0), P(r, 0)]];
    case "flatness":
      return [[P(-r, -0.4 * r), P(0.45 * r, -0.4 * r), P(r, 0.4 * r), P(-0.45 * r, 0.4 * r), P(-r, -0.4 * r)]];
    case "circularity":
      return [circle(0, 0, 0.8 * r)];
    case "cylindricity": {
      const rho = 0.5 * r;
      const d = P(Math.cos(Math.PI / 3), Math.sin(Math.PI / 3));
      const n = P(-d.y, d.x);
      const line = (s: number): Point[] => [P(s * rho * n.x - 0.95 * r * d.x, s * rho * n.y - 0.95 * r * d.y), P(s * rho * n.x + 0.95 * r * d.x, s * rho * n.y + 0.95 * r * d.y)];
      return [circle(0, 0, rho), line(1), line(-1)];
    }
    case "profile-line":
      return [arc(0, -0.4 * r, 0.9 * r, Math.PI, 0)];
    case "profile-surface": {
      const a = arc(0, -0.4 * r, 0.9 * r, Math.PI, 0);
      return [[...a, a[0]]];
    }
    case "angularity":
      return [[P(-r, -0.6 * r), P(r, -0.6 * r)], [P(-r, -0.6 * r), P(0.5 * r, 0.8 * r)]];
    case "perpendicularity":
      return [[P(-r, -0.7 * r), P(r, -0.7 * r)], [P(0, -0.7 * r), P(0, 0.7 * r)]];
    case "parallelism":
      return [[P(-0.55 * r, -0.7 * r), P(0.15 * r, 0.7 * r)], [P(-0.05 * r, -0.7 * r), P(0.65 * r, 0.7 * r)]];
    case "position":
      return [circle(0, 0, 0.55 * r), [P(-r, 0), P(r, 0)], [P(0, -r), P(0, r)]];
    case "concentricity":
      return [circle(0, 0, 0.9 * r), circle(0, 0, 0.5 * r)];
    case "symmetry":
      return [[P(-r, 0), P(r, 0)], [P(-0.7 * r, 0.5 * r), P(0.7 * r, 0.5 * r)], [P(-0.7 * r, -0.5 * r), P(0.7 * r, -0.5 * r)]];
    case "runout":
    case "total-runout": {
      const arrow = (dx: number, dy: number): Point[][] => [
        [P(-0.8 * r + dx, -0.8 * r + dy), P(0.7 * r + dx, 0.7 * r + dy)],
        [P(0.7 * r + dx, 0.15 * r + dy), P(0.7 * r + dx, 0.7 * r + dy), P(0.15 * r + dx, 0.7 * r + dy)],
      ];
      return key === "runout" ? arrow(0, 0) : [...arrow(-0.2 * r, 0.2 * r), ...arrow(0.2 * r, -0.2 * r)];
    }
    default:
      return [];
  }
}

/** Strokes of `text` (stroke font) with its left edge at `x` and vertically centred on `y`; also the advance width used. */
function textRun(text: string, x: number, y: number, h: number): { strokes: Point[][]; width: number } {
  const raw = textToStrokes(text, P(0, 0), h, 0);
  if (raw.length === 0) return { strokes: [], width: text.length * h * 0.55 };
  let minX = Infinity;
  let maxX = -Infinity;
  for (const s of raw) for (const p of s) {
    if (p.x < minX) minX = p.x;
    if (p.x > maxX) maxX = p.x;
  }
  return { strokes: raw.map((s) => s.map((p) => P(p.x - minX + x, p.y + y - h / 2))), width: maxX - minX };
}

interface Placed {
  width: number;
  draw: (x: number, y: number) => Point[][];
}

function placeItem(item: FcfItem, h: number): Placed {
  if (item.kind === "dia") {
    const r = 0.38 * h;
    return {
      width: 2 * r,
      draw: (x, y) => [circle(x + r, y, r), [P(x + r - 0.85 * r, y - 0.85 * r), P(x + r + 0.85 * r, y + 0.85 * r)]],
    };
  }
  if (item.kind === "mod") {
    const r = 0.5 * h;
    const lh = 0.62 * h;
    const lw = textRun(item.ch, 0, 0, lh).width;
    return {
      width: 2 * r,
      draw: (x, y) => [circle(x + r, y, r), ...textRun(item.ch, x + r - lw / 2, y, lh).strokes],
    };
  }
  const run = textRun(item.text, 0, 0, h);
  return { width: run.width, draw: (x, y) => textRun(item.text, x, y, h).strokes };
}

const GAP = 0.18;

/**
 * The frame as stroke runs in local coordinates: origin at the left edge,
 * middle of the first row, x along the frame, y up; rows stack downward. Cell
 * height is 2h. Returns the runs and the overall size.
 */
export function fcfLocalStrokes(rows: readonly FcfRow[], h: number): { runs: Point[][]; width: number; height: number } {
  if (rows.length === 0 || !(h > 0)) return { runs: [], width: 0, height: 0 };
  const H = 2 * h;
  const symW = H;
  const placed = rows.map((r) => r.cells.map((c) => c.map((i) => placeItem(i, h))));
  const contentW = (c: Placed[]) => c.reduce((s, p, i) => s + p.width + (i > 0 ? GAP * h : 0), 0);
  const ncols = Math.max(0, ...rows.map((r) => r.cells.length));
  const colW: number[] = [];
  for (let j = 0; j < ncols; j++) colW.push(Math.max(H, ...placed.map((r) => (r[j] ? contentW(r[j]) + h : 0))));
  const shared = rows.length > 1 && rows.slice(1).every((r) => !r.symbol);
  const runs: Point[][] = [];
  const rect = (x0: number, x1: number, top: number, bot: number) => runs.push([P(x0, top), P(x1, top), P(x1, bot), P(x0, bot), P(x0, top)]);
  const top0 = h;
  const bottom = h - rows.length * H;
  const rowTop = (i: number) => h - i * H;
  const symbolAt = (key: string, cy: number) => {
    for (const s of gdtSymbolStrokes(key, 0.6 * h)) runs.push(s.map((p) => P(p.x + symW / 2, p.y + cy)));
  };
  if (shared) {
    rect(0, symW, top0, bottom);
    symbolAt(rows[0].symbol, (top0 + bottom) / 2);
  }
  rows.forEach((r, i) => {
    const top = rowTop(i);
    const cy = top - h;
    const right = symW + colW.slice(0, r.cells.length).reduce((a, b) => a + b, 0);
    if (shared) rect(symW, right, top, top - H);
    else {
      rect(0, right, top, top - H);
      runs.push([P(symW, top), P(symW, top - H)]);
      if (r.symbol) symbolAt(r.symbol, cy);
    }
    let x = symW;
    r.cells.forEach((_, j) => {
      if (j > 0) runs.push([P(x, top), P(x, top - H)]);
      const items = placed[i][j];
      let cx = x + (colW[j] - contentW(items)) / 2;
      for (const it of items) {
        runs.push(...it.draw(cx, cy));
        cx += it.width + GAP * h;
      }
      x += colW[j];
    });
  });
  const width = symW + colW.reduce((a, b) => a + b, 0);
  return { runs, width, height: rows.length * H };
}

/** The frame placed in the drawing: `at` is the left edge of the first row's middle, `rotation` radians. */
export function layoutFcf(content: string | undefined, at: Point, h: number, rotation: number): Point[][] {
  const { runs } = fcfLocalStrokes(parseFcf(content), h);
  const cos = Math.cos(rotation);
  const sin = Math.sin(rotation);
  return runs.map((run) => run.map((p) => ({ x: at.x + p.x * cos - p.y * sin, y: at.y + p.x * sin + p.y * cos })));
}

// ---------------------------------------------------------------- DXF record

/** The groups of a TOLERANCE record after the common entity head (AC1032). `at` is already in file units. */
export function toleranceRecordText(e: DimensionEntity, style: string): string {
  const a = e.angle ?? 0;
  const at = e.defPoints[0];
  return (
    `100\nAcDbFcf\n` +
    pair(3, style) +
    pair(10, at.x) + pair(20, at.y) + pair(30, 0) +
    pair(1, fcfToDxf(e.textOverride)) +
    pair(11, Math.cos(a)) + pair(21, Math.sin(a)) + pair(31, 0)
  );
}

/** A TOLERANCE record as a `tolerance` dimension; null without an insertion point. */
export function toleranceFromRecord(pairs: readonly { code: number; value: string }[]): Omit<DimensionEntity, "id"> | null {
  const get = (code: number): string | undefined => pairs.find((p) => p.code === code)?.value;
  const x = Number(get(10));
  const y = Number(get(20));
  if (get(10) === undefined || get(20) === undefined || !Number.isFinite(x) || !Number.isFinite(y)) return null;
  const dx = Number(get(11) ?? 1);
  const dy = Number(get(21) ?? 0);
  const angle = Number.isFinite(dx) && Number.isFinite(dy) && Math.hypot(dx, dy) > 1e-12 ? Math.atan2(dy, dx) : 0;
  const style = get(3)?.trim();
  return {
    type: "dimension",
    kind: "tolerance",
    defPoints: [{ x, y }],
    driving: false,
    textOverride: fcfFromDxf(get(1) ?? ""),
    ...(Math.abs(angle) > 1e-12 ? { angle } : {}),
    ...(style && style !== "Standard" ? { style } : {}),
  };
}
