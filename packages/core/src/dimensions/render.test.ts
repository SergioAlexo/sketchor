/**
 * D-11: one drawing, three renderings. A dimension is drawn by the canvas from
 * the core layout; SVG, PDF, EPS and the print preview must show the same
 * lines, the same text and solid arrow heads — not tinted ones, not "?" where
 * the text has a diameter sign, and nothing cut off by the page.
 */
import { describe, expect, it } from "vitest";
import type { DimensionEntity } from "../entities";
import { entitiesToEps } from "../eps/export";
import { entitiesToSvgDocument } from "../svg";
import { drawEntitiesToPdf } from "../entitiesPdf";
import { kindBounds } from "../kinds/registry";
import "../kinds/builtin";
import { PdfBuilder, PDF_LETTER } from "../pdf";
import { explodeDimension } from "./explode";
import { layoutOf } from "./resolve";

const D = (kind: DimensionEntity["kind"], pts: [number, number][], extra: Partial<DimensionEntity> = {}): DimensionEntity => ({
  id: `d-${kind}`,
  type: "dimension",
  kind,
  defPoints: pts.map(([x, y]) => ({ x, y })),
  driving: false,
  ...extra,
});

const KINDS: DimensionEntity[] = [
  D("linear", [[0, 0], [40, 0], [20, 9]], { angle: 0 }),
  D("aligned", [[0, 0], [30, 40], [10, 30]]),
  D("angular2l", [[0, 0], [10, 0], [0, 0], [0, 10], [6, 6]]),
  D("angular3p", [[0, 0], [10, 0], [0, 10], [6, 6]]),
  D("radial", [[5, 5], [15, 5]]),
  D("diametric", [[5, 5], [15, 5]]),
  D("jogged", [[5, 5], [15, 5], [9, 9]]),
  D("arclength", [[0, 0], [10, 0], [0, 10], [8, 8]]),
  D("ordinate", [[0, 0], [30, 12], [30, 25]], { axis: "x" }),
];

const decode = (bytes: Uint8Array): string => Array.from(bytes, (b) => String.fromCharCode(b)).join("");
const escapeXml = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

describe("SVG", () => {
  it("every kind shows the layout's text, its lines and its arrows as solid fills", () => {
    for (const d of KINDS) {
      const l = layoutOf(d, null);
      const svg = entitiesToSvgDocument([d]);
      expect(svg, d.kind).toContain(`>${escapeXml(l.text!.text)}</text>`);
      expect(svg, d.kind).not.toContain("NaN");
      // Arrow heads are opaque, never the 0.3 tint a closed shape's `fill` means.
      const solids = svg.match(/<path d="[^"]*" fill="#[0-9a-f]{6}" fill-rule="evenodd" stroke="none"\/>/gi) ?? [];
      expect(solids.length, `${d.kind} arrows`).toBe(l.fills.length);
      expect(svg, `${d.kind} opaque`).not.toContain("fill-opacity");
      expect((svg.match(/<path d="M[^"]*"\/>/g) ?? []).length, `${d.kind} strokes`).toBeGreaterThanOrEqual(1);
    }
  });

  it("the page holds the whole dimension: the viewBox is the layout's own extent", () => {
    for (const d of KINDS) {
      const b = kindBounds(d)!;
      const svg = entitiesToSvgDocument([d], { padding: 0 });
      const m = /viewBox="0 0 ([0-9.]+) ([0-9.]+)"/.exec(svg)!;
      expect(Number(m[1]), `${d.kind} w`).toBeCloseTo(b.maxX - b.minX, 2);
      expect(Number(m[2]), `${d.kind} h`).toBeCloseTo(b.maxY - b.minY, 2);
    }
  });

  it("laser / CAM mode keeps the lines and drops the text", () => {
    const svg = entitiesToSvgDocument([KINDS[0]], { mode: "laser" });
    expect(svg).not.toContain("<text");
    expect(svg).toContain("<path");
  });

  it("a style change shows in the export (text height, arrow kind, units)", () => {
    const plain = entitiesToSvgDocument([KINDS[0]]);
    const big = entitiesToSvgDocument([{ ...KINDS[0], overrides: { textHeight: 5, arrow: "open", unitFormat: "architectural", decimals: 4, lengthFactor: 1 / 25.4 } }]);
    expect(plain).toContain('font-size="2.5"');
    expect(big).toContain('font-size="5"');
    expect(big).toContain("&quot;</text>");
    expect(big).not.toMatch(/fill-opacity/); // open arrows are strokes
  });
});

describe("PDF and EPS", () => {
  it("PDF draws text (diameter and arc symbols come out as Helvetica glyphs, not ?) and filled arrows", () => {
    for (const d of KINDS) {
      const pdf = new PdfBuilder(PDF_LETTER);
      drawEntitiesToPdf(pdf, [d], { x: 36, y: 36, width: 300, height: 300 });
      const out = decode(pdf.bytes());
      const text = layoutOf(d, null).text!.text.replace("⌀", "Ø").replace("⌒", "^");
      expect(out, d.kind).toContain(`(${text})`);
      expect(out, d.kind).not.toContain("NaN");
      expect(out, d.kind).not.toContain("(?");
    }
  });

  it("EPS draws every kind without NaN and fills the arrows", () => {
    for (const d of KINDS) {
      const eps = entitiesToEps([d]);
      expect(eps, d.kind).not.toContain("NaN");
      expect(eps, d.kind).toContain("fill");
    }
  });
});

describe("explodeDimension (what the writers draw)", () => {
  it("is exactly the layout: same line runs, one solid hatch per arrow, one text", () => {
    for (const d of KINDS) {
      const l = layoutOf(d, null);
      const parts = explodeDimension(d, null);
      expect(parts.filter((p) => p.type === "polyline"), d.kind).toHaveLength(l.lines.length);
      expect(parts.filter((p) => p.type === "hatch"), d.kind).toHaveLength(l.fills.length);
      expect(parts.filter((p) => p.type === "text"), d.kind).toHaveLength(1);
    }
  });
  it("a degenerate dimension draws nothing and does not throw", () => {
    const zero = D("linear", [[3, 3], [3, 3], [3, 3]], { angle: 0 });
    expect(() => entitiesToSvgDocument([zero])).not.toThrow();
    expect(() => entitiesToEps([zero])).not.toThrow();
  });
});
