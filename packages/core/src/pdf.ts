/**
 * A minimal, dependency-free PDF 1.4 writer — enough to put a drawing and the
 * paperwork around it on paper, and nothing more.
 *
 * Why hand-rolled: the app already renders everything it prints from the same
 * entity list it writes to DXF, so the only thing missing was a container that
 * can be *written to a file without a dialog*. `window.print()` can produce a
 * PDF, but only through the OS dialog, where the user picks the folder every
 * time — which is exactly what an autosave folder exists to avoid. A PDF
 * library would be tens of thousands of lines for the subset used here: paths,
 * solid fills, and the base-14 Helvetica.
 *
 * Coordinates: PDF's own origin is bottom-left with Y up. Everything on this
 * class takes **page coordinates in points, Y down from the top-left**, because
 * every caller here is laying out a sheet, not a graph; the flip happens once,
 * on the way into the content stream.
 *
 * Text is Helvetica / Helvetica-Bold, WinAnsi — the two base-14 fonts every
 * reader has built in, so nothing is embedded and the file stays small.
 */

/** US Letter, portrait, in points (1/72"). */
export const PDF_LETTER = { width: 612, height: 792 } as const;
/** US Letter, landscape — the shape of a trailer. */
export const PDF_LETTER_LANDSCAPE = { width: 792, height: 612 } as const;

export interface PdfPageSize {
  width: number;
  height: number;
}

export interface PdfTextStyle {
  /** Font size in points (default 10). */
  size?: number;
  bold?: boolean;
  /** CSS-style `#rgb` / `#rrggbb` (default black). */
  color?: string;
  /** Where `x` sits relative to the string (default "left"). */
  align?: "left" | "center" | "right";
  /** Radians counter-clockwise about the anchor (default 0). */
  rotation?: number;
}

export interface PdfPaint {
  /** Fill colour, or omitted for no fill. */
  fill?: string;
  /** Stroke colour, or omitted for no stroke. */
  stroke?: string;
  /** Stroke width in points (default 0.6). */
  width?: number;
  /** Dash pattern in points, e.g. `[3, 2]`. */
  dash?: number[];
}

export interface PdfPoint {
  x: number;
  y: number;
}

/** Helvetica advance widths (1/1000 em) for codes 32–126 — the AFM values. */
const HELVETICA = [
  278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556, 556, 556, 556,
  556, 556, 556, 278, 278, 584, 584, 584, 556, 1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833,
  722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278, 278, 278, 469, 556, 333, 556, 556, 500, 556,
  556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556, 556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334,
  260, 334, 584,
];

/** Helvetica-Bold advance widths (1/1000 em) for codes 32–126. */
const HELVETICA_BOLD = [
  278, 333, 474, 556, 556, 889, 722, 238, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556, 556, 556, 556,
  556, 556, 556, 333, 333, 584, 584, 584, 611, 975, 722, 722, 722, 722, 667, 611, 778, 722, 278, 556, 722, 611, 833,
  722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 333, 278, 333, 584, 556, 333, 556, 611, 556, 611,
  556, 333, 611, 611, 278, 278, 556, 278, 889, 611, 611, 611, 611, 389, 556, 333, 611, 556, 778, 556, 556, 500, 389,
  280, 389, 584,
];

/** Advance width of `text` at `size`, in points. */
export function pdfTextWidth(text: string, size: number, bold = false): number {
  const table = bold ? HELVETICA_BOLD : HELVETICA;
  let mils = 0;
  for (const ch of text) {
    const code = ch.charCodeAt(0);
    mils += code >= 32 && code <= 126 ? table[code - 32] : 556;
  }
  return (mils / 1000) * size;
}

function num(n: number): string {
  if (!Number.isFinite(n)) return "0";
  const r = Math.round(n * 1000) / 1000;
  return String(Object.is(r, -0) ? 0 : r);
}

/** `#rgb` / `#rrggbb` as the three 0–1 components PDF wants. */
function rgb(color: string): [number, number, number] {
  const hex = color.trim().replace("#", "");
  const full = hex.length === 3 ? hex.split("").map((c) => c + c).join("") : hex;
  if (full.length !== 6) return [0, 0, 0];
  const v = (i: number) => parseInt(full.slice(i * 2, i * 2 + 2), 16) / 255;
  const out: [number, number, number] = [v(0), v(1), v(2)];
  return out.every((c) => Number.isFinite(c)) ? out : [0, 0, 0];
}

/** Drawing symbols WinAnsi has no code for, replaced by the nearest Helvetica glyph (D-11: dimension text carries them). */
const WINANSI_FALLBACK: Record<string, string> = {
  "⌀": "Ø", // diameter sign
  "∅": "Ø",
  "⌒": "^", // arc length
  "≈": "~",
  "≤": "<",
  "≥": ">",
  "△": "^",
  "−": "-",
};

/**
 * A string literal for a content stream. Escapes PDF's own delimiters and
 * drops anything outside the single-byte range to "?" — a load plan is job
 * numbers, cities and tags, and a mangled glyph beats a corrupt file.
 */
function literal(text: string): string {
  let out = "";
  for (const raw of text) {
    const ch = WINANSI_FALLBACK[raw] ?? raw;
    const code = ch.charCodeAt(0);
    if (ch === "(" || ch === ")" || ch === "\\") out += "\\" + ch;
    else if (code >= 32 && code <= 255) out += ch;
    else out += "?";
  }
  return "(" + out + ")";
}

/** The four-bezier approximation of a circle; 0.5523 is the classic magic constant. */
const KAPPA = 0.5522847498;

export class PdfBuilder {
  readonly width: number;
  readonly height: number;
  private readonly pages: string[] = [];
  private current: string[] = [];
  /** Gradient dictionaries (`/Sh1 << … >>`), shared by every page's resources. */
  private readonly shadings: string[] = [];

  constructor(size: PdfPageSize = PDF_LETTER) {
    this.width = size.width;
    this.height = size.height;
  }

  /** Finishes the current page and starts a blank one. */
  addPage(): void {
    this.pages.push(this.current.join("\n"));
    this.current = [];
  }

  /** How many pages the file has so far, counting the one in progress. */
  get pageCount(): number {
    return this.pages.length + 1;
  }

  /** PDF Y (up from the bottom) for a page Y (down from the top). */
  private ty(y: number): number {
    return this.height - y;
  }

  private paint(p: PdfPaint): string {
    const ops: string[] = [];
    if (p.fill) {
      const [r, g, b] = rgb(p.fill);
      ops.push(`${num(r)} ${num(g)} ${num(b)} rg`);
    }
    if (p.stroke) {
      const [r, g, b] = rgb(p.stroke);
      ops.push(`${num(r)} ${num(g)} ${num(b)} RG`);
      ops.push(`${num(p.width ?? 0.6)} w`);
      ops.push(p.dash && p.dash.length > 0 ? `[${p.dash.map(num).join(" ")}] 0 d` : "[] 0 d");
    }
    return ops.join("\n");
  }

  /** `f` / `S` / `B` — fill, stroke, or both, matching what the paint asks for. */
  private finish(p: PdfPaint): string {
    if (p.fill && p.stroke) return "B";
    if (p.fill) return "f";
    return "S";
  }

  line(a: PdfPoint, b: PdfPoint, paint: PdfPaint = { stroke: "#000000" }): void {
    const p: PdfPaint = { ...paint, stroke: paint.stroke ?? "#000000", fill: undefined };
    this.current.push(
      `q\n${this.paint(p)}\n${num(a.x)} ${num(this.ty(a.y))} m ${num(b.x)} ${num(this.ty(b.y))} l S\nQ`,
    );
  }

  rect(x: number, y: number, width: number, height: number, paint: PdfPaint): void {
    this.current.push(
      `q\n${this.paint(paint)}\n${num(x)} ${num(this.ty(y + height))} ${num(width)} ${num(height)} re ${this.finish(paint)}\nQ`,
    );
  }

  circle(cx: number, cy: number, r: number, paint: PdfPaint): void {
    const y = this.ty(cy);
    const k = r * KAPPA;
    const d =
      `${num(cx + r)} ${num(y)} m ` +
      `${num(cx + r)} ${num(y + k)} ${num(cx + k)} ${num(y + r)} ${num(cx)} ${num(y + r)} c ` +
      `${num(cx - k)} ${num(y + r)} ${num(cx - r)} ${num(y + k)} ${num(cx - r)} ${num(y)} c ` +
      `${num(cx - r)} ${num(y - k)} ${num(cx - k)} ${num(y - r)} ${num(cx)} ${num(y - r)} c ` +
      `${num(cx + k)} ${num(y - r)} ${num(cx + r)} ${num(y - k)} ${num(cx + r)} ${num(y)} c`;
    this.current.push(`q\n${this.paint(paint)}\n${d} ${this.finish(paint)}\nQ`);
  }

  /** An open or closed run of straight segments. */
  polyline(points: readonly PdfPoint[], paint: PdfPaint, close = false): void {
    if (points.length < 2) return;
    const parts = points.map((p, i) => `${num(p.x)} ${num(this.ty(p.y))} ${i === 0 ? "m" : "l"}`);
    if (close) parts.push("h");
    this.current.push(`q\n${this.paint(paint)}\n${parts.join(" ")} ${this.finish(paint)}\nQ`);
  }

  /** Several closed rings filled together with the even-odd rule (a region with islands), optionally outlined. */
  rings(rings: readonly (readonly PdfPoint[])[], paint: PdfPaint): void {
    const d = this.ringPath(rings);
    if (!d) return;
    const op = paint.fill && paint.stroke ? "B*" : paint.fill ? "f*" : "S";
    this.current.push(`q\n${this.paint(paint)}\n${d} ${op}\nQ`);
  }

  /** Many independent segments `[x1, y1, x2, y2, …]` (page coordinates) as one stroked path. */
  segments(flat: ArrayLike<number>, paint: PdfPaint): void {
    const parts: string[] = [];
    for (let i = 0; i + 3 < flat.length; i += 4) {
      parts.push(`${num(flat[i])} ${num(this.ty(flat[i + 1]))} m ${num(flat[i + 2])} ${num(this.ty(flat[i + 3]))} l`);
    }
    if (parts.length === 0) return;
    this.current.push(`q\n${this.paint({ ...paint, fill: undefined })}\n${parts.join(" ")} S\nQ`);
  }

  /**
   * Fills the rings (even-odd clip) with a gradient. Coordinates are page
   * coordinates (Y down). `radial` has a focus circle of radius 0 at (fx, fy).
   */
  shade(
    rings: readonly (readonly PdfPoint[])[],
    shading: { kind: "axial"; x1: number; y1: number; x2: number; y2: number; stops: { t: number; color: string }[] } | { kind: "radial"; cx: number; cy: number; r: number; fx: number; fy: number; stops: { t: number; color: string }[] },
  ): void {
    const d = this.ringPath(rings);
    if (!d || shading.stops.length < 2) return;
    const comp = (c: string): string => rgb(c).map((v) => num(v)).join(" ");
    const stops = [...shading.stops].sort((a, b) => a.t - b.t);
    const fns: string[] = [];
    const bounds: string[] = [];
    const encode: string[] = [];
    for (let i = 0; i + 1 < stops.length; i++) {
      fns.push(`<< /FunctionType 2 /Domain [0 1] /C0 [${comp(stops[i].color)}] /C1 [${comp(stops[i + 1].color)}] /N 1 >>`);
      if (i > 0) bounds.push(num(stops[i].t));
      encode.push("0 1");
    }
    const fn = `<< /FunctionType 3 /Domain [0 1] /Functions [${fns.join(" ")}] /Bounds [${bounds.join(" ")}] /Encode [${encode.join(" ")}] >>`;
    const coords =
      shading.kind === "axial"
        ? `${num(shading.x1)} ${num(this.ty(shading.y1))} ${num(shading.x2)} ${num(this.ty(shading.y2))}`
        : `${num(shading.fx)} ${num(this.ty(shading.fy))} 0 ${num(shading.cx)} ${num(this.ty(shading.cy))} ${num(shading.r)}`;
    const dict = `<< /ShadingType ${shading.kind === "axial" ? 2 : 3} /ColorSpace /DeviceRGB /Coords [${coords}] /Function ${fn} /Extend [true true] >>`;
    const name = `Sh${this.shadings.length + 1}`;
    this.shadings.push(`/${name} ${dict}`);
    this.current.push(`q\n${d} W* n\n/${name} sh\nQ`);
  }

  private ringPath(rings: readonly (readonly PdfPoint[])[]): string {
    const parts: string[] = [];
    for (const ring of rings) {
      if (ring.length < 3) continue;
      ring.forEach((p, i) => parts.push(`${num(p.x)} ${num(this.ty(p.y))} ${i === 0 ? "m" : "l"}`));
      parts.push("h");
    }
    return parts.join(" ");
  }

  /** `y` is the text baseline, measured down from the top of the page. */
  text(x: number, y: number, text: string, style: PdfTextStyle = {}): void {
    if (!text) return;
    const size = style.size ?? 10;
    const bold = style.bold === true;
    const [r, g, b] = rgb(style.color ?? "#000000");
    const w = pdfTextWidth(text, size, bold);
    const shift = style.align === "center" ? w / 2 : style.align === "right" ? w : 0;
    const rot = style.rotation ?? 0;
    const place = rot
      ? `${num(Math.cos(rot))} ${num(Math.sin(rot))} ${num(-Math.sin(rot))} ${num(Math.cos(rot))} ${num(x - shift * Math.cos(rot))} ${num(this.ty(y) - shift * Math.sin(rot))} Tm`
      : `${num(x - shift)} ${num(this.ty(y))} Td`;
    this.current.push(
      `q\nBT\n${num(r)} ${num(g)} ${num(b)} rg\n/${bold ? "F2" : "F1"} ${num(size)} Tf\n` +
        `${place}\n${literal(text)} Tj\nET\nQ`,
    );
  }

  /** Advance width of `text`, so a caller can centre or wrap before drawing. */
  measure(text: string, size: number, bold = false): number {
    return pdfTextWidth(text, size, bold);
  }

  /** The finished file. */
  bytes(): Uint8Array {
    const pages = [...this.pages, this.current.join("\n")];
    // Object numbering: 1 Catalog, 2 Pages, 3 Helvetica, 4 Helvetica-Bold,
    // then a Page + Contents pair per page.
    const objects: string[] = [];
    const kids = pages.map((_, i) => `${5 + i * 2} 0 R`).join(" ");
    objects.push(`<< /Type /Catalog /Pages 2 0 R >>`);
    objects.push(`<< /Type /Pages /Count ${pages.length} /Kids [${kids}] >>`);
    objects.push(`<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>`);
    objects.push(`<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>`);
    pages.forEach((content, i) => {
      objects.push(
        `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${num(this.width)} ${num(this.height)}] ` +
          `/Resources << /Font << /F1 3 0 R /F2 4 0 R >>${this.shadings.length > 0 ? ` /Shading << ${this.shadings.join(" ")} >>` : ""} >> /Contents ${6 + i * 2} 0 R >>`,
      );
      objects.push(`<< /Length ${content.length} >>\nstream\n${content}\nendstream`);
    });

    let out = "%PDF-1.4\n";
    const offsets: number[] = [];
    objects.forEach((body, i) => {
      offsets.push(out.length);
      out += `${i + 1} 0 obj\n${body}\nendobj\n`;
    });
    const xref = out.length;
    out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
    for (const off of offsets) out += `${String(off).padStart(10, "0")} 00000 n \n`;
    out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;

    // Every byte written above is Latin-1, so string length == byte length and
    // the xref offsets computed from it are correct.
    const bytes = new Uint8Array(out.length);
    for (let i = 0; i < out.length; i++) bytes[i] = out.charCodeAt(i) & 0xff;
    return bytes;
  }
}
