// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import "./kinds/builtin";
import { entitiesToSvgDocument, LASER_LAYER_COLORS, parseSvgText } from "./svg";
import type { ArcEntity, CircleEntity, Entity, LineEntity, PointEntity, PolylineEntity, TextEntity } from "./entities";

/**
 * SV-05: what a laser/CAM shop and Inkscape get from "Save as SVG". If layers
 * stop being layers, or a laser file carries fills/text/colour noise, the job
 * is cut wrong — and nobody sees it until the part is on the bed.
 */

const doc = (entities: Entity[], opts: Parameters<typeof entitiesToSvgDocument>[1] = {}): Document => new DOMParser().parseFromString(entitiesToSvgDocument(entities, { padding: 0, ...opts }), "image/svg+xml");
const line = (id: string, layer?: string): LineEntity => ({ id, type: "line", a: { x: 0, y: 0 }, b: { x: 10, y: 0 }, ...(layer ? { layer } : {}) });
const arc = (ccw: boolean, a0 = 0, a1 = Math.PI / 2): ArcEntity => ({ id: "a", type: "arc", center: { x: 5, y: 5 }, radius: 10, startAngle: a0, endAngle: a1, ccw });

describe("SVG export: layers", () => {
  it("writes each layer as an Inkscape layer (groupmode + label) that is well-formed XML", () => {
    const d = doc([line("1", "Cut"), line("2", "Etch & <engrave>")]);
    expect(d.querySelector("parsererror")).toBeNull();
    const layers = Array.from(d.querySelectorAll("g[inkscape\\:groupmode='layer']"));
    expect(layers.map((g) => g.getAttribute("inkscape:label"))).toEqual(["Cut", "Etch & <engrave>"]);
  });

  it("layer names survive a round trip through the Inkscape attributes alone", () => {
    const text = entitiesToSvgDocument([line("1", "Cut"), line("2", "Holes")], { padding: 0 }).replace(/ data-layer="[^"]*"/g, "");
    expect(parseSvgText(text).entities.map((e) => e.layer)).toEqual(["Cut", "Holes"]);
  });
});

describe("SVG export: exact curves", () => {
  it("an arc is one A command, not a tessellation", () => {
    const d = doc([arc(true)]).querySelector("path")!.getAttribute("d")!;
    expect(d).toMatch(/^M[\d. -]+ A10 10 0 0 0 [\d. -]+$/);
  });

  it("a clockwise arc flips the sweep flag; more than a half turn sets large-arc", () => {
    expect(doc([arc(false, Math.PI / 2, 0)]).querySelector("path")!.getAttribute("d")).toMatch(/A10 10 0 0 1 /);
    expect(doc([arc(true, 0, (3 * Math.PI) / 2)]).querySelector("path")!.getAttribute("d")).toMatch(/A10 10 0 1 0 /);
  });

  it("a full-turn arc is two halves (A with equal endpoints draws nothing)", () => {
    const d = doc([arc(true, 0, 2 * Math.PI - 1e-12)]).querySelector("path")!.getAttribute("d")!;
    expect(d.match(/A/g)).toHaveLength(2);
  });

  it("an exported arc re-imports on the same circle, endpoints exact", () => {
    for (const ccw of [true, false]) {
      const back = parseSvgText(entitiesToSvgDocument([arc(ccw)], { padding: 0 })).entities[0] as PolylineEntity;
      const pts = back.points;
      // every sample is 10 from one common centre: solve it from three samples
      const [p, q, r] = [pts[0], pts[Math.floor(pts.length / 2)], pts[pts.length - 1]];
      const dd = 2 * (p.x * (q.y - r.y) + q.x * (r.y - p.y) + r.x * (p.y - q.y));
      const ux = ((p.x ** 2 + p.y ** 2) * (q.y - r.y) + (q.x ** 2 + q.y ** 2) * (r.y - p.y) + (r.x ** 2 + r.y ** 2) * (p.y - q.y)) / dd;
      const uy = ((p.x ** 2 + p.y ** 2) * (r.x - q.x) + (q.x ** 2 + q.y ** 2) * (p.x - r.x) + (r.x ** 2 + r.y ** 2) * (q.x - p.x)) / dd;
      for (const s of pts) expect(Math.hypot(s.x - ux, s.y - uy)).toBeCloseTo(10, 3);
    }
  });

  it("a bulged polyline segment is an A command too", () => {
    const pl: PolylineEntity = { id: "p", type: "polyline", points: [{ x: 0, y: 0 }, { x: 10, y: 0 }], bulges: [0.5], closed: false } as PolylineEntity;
    expect(doc([pl]).querySelector("path")!.getAttribute("d")).toMatch(/A[\d.]+ [\d.]+ 0 0 [01] /);
  });
});

describe("SVG export: lineweight", () => {
  it("writes lineweight as stroke-width in mm", () => {
    const e = { ...line("1"), lineweight: 0.35 };
    expect(doc([e]).querySelector("line")!.getAttribute("stroke-width")).toBe("0.35");
    expect(doc([line("1")]).querySelector("line")!.hasAttribute("stroke-width")).toBe(false);
  });

  it("round-trips: lineweight, colour and linetype come back", () => {
    const e = { ...line("1"), b: { x: 10, y: 10 }, lineweight: 0.5, color: "#ff0000", linetype: "DASHED" };
    const back = parseSvgText(entitiesToSvgDocument([e], { padding: 0 })).entities[0] as LineEntity;
    expect(back).toMatchObject({ lineweight: 0.5, color: "#ff0000", linetype: "DASHED" });
  });

  it("scales the dasharray by the entity's own linetype scale (DASHED is 6/3 mm)", () => {
    const dash = (e: LineEntity) => doc([e]).querySelector("line")!.getAttribute("stroke-dasharray");
    expect(dash({ ...line("1"), linetype: "DASHED" })).toBe("6 3");
    expect(dash({ ...line("1"), linetype: "DASHED", linetypeScale: 2.5 })).toBe("15 7.5");
  });
});

describe("SVG export: Laser / CAM mode", () => {
  const circle: CircleEntity = { id: "c", type: "circle", center: { x: 5, y: 5 }, radius: 3, color: "#123456", fill: "#abcdef", linetype: "DASHED", lineweight: 1, layer: "Holes" };
  const text: TextEntity = { id: "t", type: "text", at: { x: 0, y: 0 }, text: "label", height: 3, rotation: 0 };
  const point: PointEntity = { id: "p", type: "point", p: { x: 1, y: 1 } };
  const construction = { ...line("k"), construction: true } as LineEntity;
  const laser = (es: Entity[]): Document => doc(es, { mode: "laser" });

  it("hairline strokes, no fills, no dashes, no per-entity colour or weight", () => {
    const d = laser([circle]);
    expect(d.documentElement.getAttribute("stroke-width")).toBe("0.01");
    const c = d.querySelector("circle")!;
    for (const a of ["fill", "fill-opacity", "stroke-dasharray", "stroke-width", "stroke"]) expect(c.hasAttribute(a)).toBe(false);
  });

  it("omits text, points and construction geometry", () => {
    const d = laser([line("1"), text, point, construction]);
    expect(d.querySelectorAll("text, circle")).toHaveLength(0);
    expect(d.querySelectorAll("line")).toHaveLength(1);
  });

  it("gives each layer exactly one distinct stroke colour", () => {
    const d = laser([line("1", "A"), { ...line("2", "A"), color: "#ff00ff" }, line("3", "B"), line("4", "C")]);
    const groups = Array.from(d.querySelectorAll("g[inkscape\\:groupmode='layer']"));
    expect(groups.map((g) => g.getAttribute("stroke"))).toEqual(LASER_LAYER_COLORS.slice(0, 3));
    expect(d.querySelectorAll("line[stroke]")).toHaveLength(0);
  });

  it("document mode (default) keeps colour, fill, dashes and text", () => {
    const d = doc([circle, text]);
    const c = d.querySelector("circle")!;
    expect(c.getAttribute("stroke")).toBe("#123456");
    expect(c.getAttribute("fill")).toBe("#abcdef");
    expect(c.hasAttribute("stroke-dasharray")).toBe(true);
    expect(d.querySelector("text")).not.toBeNull();
  });

  it("still states the true physical size", () => {
    expect(laser([line("1")]).documentElement.getAttribute("width")).toBe("10mm");
  });

  it("an empty drawing is still a valid document", () => {
    expect(laser([]).querySelector("parsererror")).toBeNull();
  });
});
