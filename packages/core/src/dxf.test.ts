import { describe, expect, it } from "vitest";
import "./kinds/builtin";
import { boundsOf, dxfToSvg, entitiesToSvg, parseDxf, type DxfParseOptions } from "./dxf";
import { ellipsePointAt, isFullEllipse } from "./ellipse";
import { distToNurbs, nurbsDomain, nurbsPointAt } from "./nurbs";
import type { ArcEntity, CircleEntity, EllipseEntity, Entity, SplineEntity, LineEntity, PointEntity, PolylineEntity, TextEntity, MTextEntity } from "./entities";
import { mtextPlain } from "./mtext/parse";

/**
 * The DXF importer — the widest surface in the codebase and the one fed by
 * files nobody here wrote. It has to turn real drawings into entities
 * (including the constructs with no direct equivalent: ellipses, splines,
 * text and block references), report what it couldn't take rather than
 * dropping it silently, and never hang or throw on a malformed file.
 */

/* ------------------------------ DXF builders ----------------------------- */

type Pair = [number, string | number];

const rec = (type: string, pairs: Pair[]): string =>
  `0\n${type}\n` + pairs.map(([code, value]) => `${code}\n${value}\n`).join("");

const section = (name: string, body: string): string => `0\nSECTION\n2\n${name}\n${body}0\nENDSEC\n`;

const dxf = (...sections: string[]): string => sections.join("") + "0\nEOF\n";

const entitiesOnly = (body: string): string => dxf(section("ENTITIES", body));

const header = (insUnits: number): string =>
  section("HEADER", `9\n$ACADVER\n1\nAC1009\n9\n$INSUNITS\n70\n${insUnits}\n`);

const block = (name: string, base: [number, number], body: string): string =>
  rec("BLOCK", [[2, name], [10, base[0]], [20, base[1]]]) + body + rec("ENDBLK", []);

const parse = (text: string, options?: DxfParseOptions) => parseDxf(text, options);
const entitiesOf = (text: string): Entity[] => parseDxf(text).entities;

const closeTo = (p: { x: number; y: number }, x: number, y: number, digits = 9) => {
  expect(p.x).toBeCloseTo(x, digits);
  expect(p.y).toBeCloseTo(y, digits);
};

/* -------------------------------- basics --------------------------------- */

describe("primitive entities", () => {
  it("reads a LINE with its layer", () => {
    const [e] = entitiesOf(entitiesOnly(rec("LINE", [[8, "walls"], [10, 1], [20, 2], [11, 3], [21, 4]]))) as LineEntity[];
    expect(e).toMatchObject({ type: "line", layer: "walls", a: { x: 1, y: 2 }, b: { x: 3, y: 4 } });
  });

  it("defaults a missing or empty layer to 0", () => {
    const [a, b] = entitiesOf(
      entitiesOnly(rec("LINE", [[10, 0], [20, 0], [11, 1], [21, 1]]) + rec("LINE", [[8, ""], [10, 0], [20, 0], [11, 1], [21, 1]])),
    );
    expect(a.layer).toBe("0");
    expect(b.layer).toBe("0");
  });

  it("reads a CIRCLE and drops one with a non-positive radius", () => {
    const [e] = entitiesOf(entitiesOnly(rec("CIRCLE", [[10, 5], [20, 6], [40, 7]]))) as CircleEntity[];
    expect(e).toMatchObject({ type: "circle", center: { x: 5, y: 6 }, radius: 7 });
    expect(entitiesOf(entitiesOnly(rec("CIRCLE", [[10, 0], [20, 0], [40, 0]])))).toEqual([]);
  });

  it("reads an ARC as degrees swept counterclockwise from code 50 to 51", () => {
    const [e] = entitiesOf(entitiesOnly(rec("ARC", [[10, 0], [20, 0], [40, 10], [50, 90], [51, 180]]))) as ArcEntity[];
    expect(e.type).toBe("arc");
    expect(e.ccw).toBe(true);
    expect(e.startAngle).toBeCloseTo(Math.PI / 2, 12);
    expect(e.endAngle).toBeCloseTo(Math.PI, 12);
  });

  it("drops an ARC with a non-positive radius", () => {
    expect(entitiesOf(entitiesOnly(rec("ARC", [[10, 0], [20, 0], [40, -1], [50, 0], [51, 90]])))).toEqual([]);
  });

  it("reads a POINT", () => {
    const [e] = entitiesOf(entitiesOnly(rec("POINT", [[10, -4], [20, 8]]))) as PointEntity[];
    expect(e).toMatchObject({ type: "point", p: { x: -4, y: 8 } });
  });
});

describe("LWPOLYLINE", () => {
  const verts = (pts: [number, number, number?][]): Pair[] =>
    pts.flatMap(([x, y, bulge]) => (bulge === undefined ? ([[10, x], [20, y]] as Pair[]) : ([[10, x], [20, y], [42, bulge]] as Pair[])));

  it("reads vertices and the closed flag from code 70", () => {
    const open = entitiesOf(entitiesOnly(rec("LWPOLYLINE", [[90, 3], ...verts([[0, 0], [10, 0], [10, 10]])])))[0] as PolylineEntity;
    expect(open.points).toEqual([{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }]);
    expect(open.closed).toBe(false);

    const closed = entitiesOf(
      entitiesOnly(rec("LWPOLYLINE", [[90, 3], [70, 1], ...verts([[0, 0], [10, 0], [10, 10]])])),
    )[0] as PolylineEntity;
    expect(closed.closed).toBe(true);
  });

  it("treats only bit 1 of code 70 as the closed flag", () => {
    const plinegen = entitiesOf(entitiesOnly(rec("LWPOLYLINE", [[70, 128], ...verts([[0, 0], [1, 1]])])))[0] as PolylineEntity;
    expect(plinegen.closed).toBe(false);
  });

  it("keeps each vertex's bulge with the segment leaving it", () => {
    const open = entitiesOf(
      entitiesOnly(rec("LWPOLYLINE", [[90, 3], ...verts([[0, 0, 0.5], [10, 0, -0.25], [10, 10, 9]])])),
    )[0] as PolylineEntity;
    // Open: the last vertex's bulge has no segment to own, so it is dropped.
    expect(open.bulges).toEqual([0.5, -0.25]);

    const closed = entitiesOf(
      entitiesOnly(rec("LWPOLYLINE", [[70, 1], ...verts([[0, 0, 0.5], [10, 0, -0.25], [10, 10, 0.75]])])),
    )[0] as PolylineEntity;
    // Closed: the last bulge belongs to the closing segment.
    expect(closed.bulges).toEqual([0.5, -0.25, 0.75]);
  });

  it("omits the bulges array entirely when every segment is straight", () => {
    const e = entitiesOf(entitiesOnly(rec("LWPOLYLINE", [...verts([[0, 0, 0], [1, 1, 0]])])))[0] as PolylineEntity;
    expect(e.bulges).toBeUndefined();
  });

  it("ignores a polyline with fewer than two vertices", () => {
    expect(entitiesOf(entitiesOnly(rec("LWPOLYLINE", [[90, 1], [10, 5], [20, 5]])))).toEqual([]);
  });
});

describe("legacy POLYLINE / VERTEX / SEQEND", () => {
  it("stitches a vertex run into one polyline", () => {
    const text = entitiesOnly(
      rec("POLYLINE", [[8, "legacy"], [70, 1]]) +
        rec("VERTEX", [[10, 0], [20, 0]]) +
        rec("VERTEX", [[10, 10], [20, 0], [42, 0.5]]) +
        rec("VERTEX", [[10, 10], [20, 10]]) +
        rec("SEQEND", []),
    );
    const [e] = entitiesOf(text) as PolylineEntity[];
    expect(e).toMatchObject({ type: "polyline", layer: "legacy", closed: true });
    expect(e.points).toHaveLength(3);
    expect(e.bulges).toEqual([0, 0.5, 0]);
  });

  it("handles two runs and an unterminated final run", () => {
    const run = (x: number) =>
      rec("POLYLINE", []) + rec("VERTEX", [[10, x], [20, 0]]) + rec("VERTEX", [[10, x + 1], [20, 0]]);
    const [a, b] = entitiesOf(entitiesOnly(run(0) + rec("SEQEND", []) + run(50))) as PolylineEntity[];
    expect(a.points[0]).toEqual({ x: 0, y: 0 });
    expect(b.points[0]).toEqual({ x: 50, y: 0 });
  });

  it("does not warn about the sub-records it consumes", () => {
    const text = entitiesOnly(
      rec("POLYLINE", []) + rec("VERTEX", [[10, 0], [20, 0]]) + rec("VERTEX", [[10, 1], [20, 1]]) + rec("SEQEND", []),
    );
    expect(parse(text).warnings).toEqual([]);
  });
});

describe("ELLIPSE", () => {
  it("imports a full ellipse as one exact ellipse entity", () => {
    // Major axis (10, 0) from the centre, ratio 0.5 -> 10 x 5 half-axes.
    const text = entitiesOnly(rec("ELLIPSE", [[10, 0], [20, 0], [11, 10], [21, 0], [40, 0.5], [41, 0], [42, 2 * Math.PI]]));
    const [e] = entitiesOf(text) as EllipseEntity[];
    expect(e.type).toBe("ellipse");
    expect(e.ratio).toBe(0.5);
    expect(isFullEllipse(e)).toBe(true);
    const b = boundsOf([e])!;
    expect(b.minX).toBeCloseTo(-10, 6);
    expect(b.maxX).toBeCloseTo(10, 6);
    expect(b.minY).toBeCloseTo(-5, 6);
    expect(b.maxY).toBeCloseTo(5, 6);
  });

  it("honours the major axis rotation", () => {
    // Major axis straight up: the 10-unit half-axis is now vertical.
    const text = entitiesOnly(rec("ELLIPSE", [[10, 0], [20, 0], [11, 0], [21, 10], [40, 0.5], [41, 0], [42, 2 * Math.PI]]));
    const b = boundsOf(entitiesOf(text))!;
    expect(b.maxY).toBeCloseTo(10, 6);
    expect(b.maxX).toBeCloseTo(5, 6);
  });

  it("keeps a partial sweep as an elliptical arc", () => {
    const text = entitiesOnly(rec("ELLIPSE", [[10, 0], [20, 0], [11, 10], [21, 0], [40, 1], [41, 0], [42, Math.PI / 2]]));
    const [e] = entitiesOf(text) as EllipseEntity[];
    expect(isFullEllipse(e)).toBe(false);
    closeTo(ellipsePointAt(e, e.start), 10, 0, 6);
    closeTo(ellipsePointAt(e, e.end), 0, 10, 6);
  });

  it("reads a ratio above 1 as the same curve with the axes swapped", () => {
    // Axis (4, 0), ratio 2 -> the vertical half-axis is 8.
    const text = entitiesOnly(rec("ELLIPSE", [[10, 0], [20, 0], [11, 4], [21, 0], [40, 2], [41, 0], [42, 2 * Math.PI]]));
    const [e] = entitiesOf(text) as EllipseEntity[];
    expect(e.ratio).toBeCloseTo(0.5, 9);
    const b = boundsOf([e])!;
    expect(b.maxY).toBeCloseTo(8, 6);
    expect(b.maxX).toBeCloseTo(4, 6);
  });

  it("ignores a degenerate ellipse with no major axis", () => {
    expect(entitiesOf(entitiesOnly(rec("ELLIPSE", [[10, 0], [20, 0], [11, 0], [21, 0], [40, 0.5]])))).toEqual([]);
  });
});

describe("SPLINE", () => {
  const ctrl = (pts: [number, number][]): Pair[] => pts.flatMap(([x, y]) => [[10, x], [20, y]] as Pair[]);

  const asSpline = (text: string) => entitiesOf(text)[0] as SplineEntity;
  const pts = (e: SplineEntity, n = 200) => {
    const [lo, hi] = nurbsDomain(e);
    return Array.from({ length: n + 1 }, (_, i) => nurbsPointAt(e, lo + ((hi - lo) * i) / n));
  };

  it("imports as one real spline that starts and ends on the end control points", () => {
    const e = asSpline(entitiesOnly(rec("SPLINE", [[71, 3], ...ctrl([[0, 0], [10, 20], [30, 20], [40, 0]])])));
    expect(e.type).toBe("spline");
    expect(e.degree).toBe(3);
    expect(e.controlPoints).toHaveLength(4);
    const p = pts(e);
    closeTo(p[0], 0, 0, 6);
    closeTo(p[p.length - 1], 40, 0, 6);
    // A cubic stays inside its control polygon's convex hull.
    const b = boundsOf([e])!;
    expect(b.maxY).toBeGreaterThan(0);
    expect(b.maxY).toBeLessThanOrEqual(20);
  });

  it("uses supplied knots when they are the right length and falls back when they aren't", () => {
    const points = ctrl([[0, 0], [5, 10], [10, 0]]);
    const good = asSpline(entitiesOnly(rec("SPLINE", [[71, 2], ...points, [40, 0], [40, 0], [40, 0], [40, 1], [40, 1], [40, 1]])));
    const malformed = asSpline(entitiesOnly(rec("SPLINE", [[71, 2], ...points, [40, 0], [40, 1]])));
    expect(malformed.knots).toEqual(good.knots);
    expect(malformed.controlPoints).toEqual(good.controlPoints);
  });

  it("keeps weights: a heavier control point pulls the curve toward it", () => {
    const points = ctrl([[0, 0], [5, 10], [10, 0]]);
    const plain = asSpline(entitiesOnly(rec("SPLINE", [[71, 2], ...points])));
    const weighted = asSpline(entitiesOnly(rec("SPLINE", [[71, 2], ...points, [41, 1], [41, 10], [41, 1]])));
    expect(weighted.weights).toEqual([1, 10, 1]);
    const apex = (e: SplineEntity) => Math.max(...pts(e).map((p) => p.y));
    expect(apex(plain)).toBeCloseTo(5, 6); // quadratic Bezier midpoint
    expect(apex(weighted)).toBeGreaterThan(apex(plain));
    expect(apex(weighted)).toBeLessThan(10);
  });

  it("clamps the degree to what the control points support", () => {
    // Degree 3 with only two control points is impossible; it degrades to a line.
    const e = asSpline(entitiesOnly(rec("SPLINE", [[71, 3], ...ctrl([[0, 0], [10, 0]])])));
    expect(e.degree).toBe(1);
    const p = pts(e);
    closeTo(p[0], 0, 0, 6);
    closeTo(p[p.length - 1], 10, 0, 6);
  });

  it("a spline with only fit points is interpolated through them", () => {
    const fit = [[0, 0], [10, 8], [25, 3], [40, -6]] as [number, number][];
    const e = asSpline(entitiesOnly(rec("SPLINE", [[71, 3], [74, 4], ...fit.flatMap(([x, y]) => [[11, x], [21, y]] as Pair[])])));
    expect(e.type).toBe("spline");
    expect(e.fitPoints).toHaveLength(4);
    for (const [x, y] of fit) expect(distToNurbs(e, { x, y })).toBeLessThan(1e-6);
  });

  it("keeps the closed flag and any fit points that came with the control points", () => {
    const e = asSpline(entitiesOnly(rec("SPLINE", [[70, 1], [71, 2], ...ctrl([[0, 0], [5, 10], [10, 0]]), [11, 0], [21, 0], [11, 10], [21, 0]])));
    expect(e.closed).toBe(true);
    expect(e.fitPoints).toHaveLength(2);
  });

  it("ignores a spline with fewer than two control points", () => {
    expect(entitiesOf(entitiesOnly(rec("SPLINE", [[71, 3], [10, 0], [20, 0]])))).toEqual([]);
  });
});

describe("TEXT and MTEXT", () => {
  // Text imports as a real, editable `text` entity — the string is kept
  // verbatim; the insertion point, height (code 40) and rotation (code 50)
  // carry over. It is no longer lowered to stroke geometry.
  const textRec = (content: string, pairs: Pair[] = []) =>
    entitiesOnly(rec("TEXT", [[10, 0], [20, 0], [40, 10], [1, content], ...pairs]));
  const mtextRec = (pairs: Pair[]) => entitiesOnly(rec("MTEXT", [[10, 0], [20, 0], [40, 10], ...pairs]));

  it("imports TEXT as one text entity at the insertion point", () => {
    const [e] = entitiesOf(textRec("Hello 3")) as TextEntity[];
    expect(e.type).toBe("text");
    expect(e.text).toBe("Hello 3");
    closeTo(e.at, 0, 0);
    expect(e.height).toBe(10);
    expect(e.rotation).toBe(0);
  });

  it("reads rotation from code 50 as degrees, stored in radians", () => {
    const [e] = entitiesOf(textRec("I", [[50, 90]])) as TextEntity[];
    expect(e.rotation).toBeCloseTo(Math.PI / 2, 9);
  });

  it("keeps the string verbatim and drops an empty one", () => {
    expect((entitiesOf(textRec("iI§"))[0] as TextEntity).text).toBe("iI§");
    expect(entitiesOf(textRec(""))).toEqual([]);
  });

  it("falls back to a default height when code 40 is missing or zero", () => {
    const [e] = entitiesOf(entitiesOnly(rec("TEXT", [[10, 0], [20, 0], [40, 0], [1, "I"]]))) as TextEntity[];
    expect(e.height).toBeCloseTo(2.5, 9);
  });

  it("keeps MTEXT formatting codes on an mtext entity (D-04)", () => {
    const [e] = entitiesOf(mtextRec([[1, "{\\C1;red} text"], [41, 30], [71, 5]])) as MTextEntity[];
    expect(e.type).toBe("mtext");
    expect(e.text).toBe("{\\C1;red} text");
    expect(e.width).toBe(30);
    expect(e.attachment).toBe(5);
    expect(mtextPlain(e.text)).toBe("red text");
  });

  it("joins MTEXT continuation groups (code 3) ahead of code 1", () => {
    const [e] = entitiesOf(mtextRec([[3, "AB"], [1, "CD"]])) as MTextEntity[];
    expect(e.text).toBe("ABCD");
  });

  it("keeps an MTEXT paragraph break as a paragraph", () => {
    const [e] = entitiesOf(mtextRec([[1, "one\\Ptwo"]])) as MTextEntity[];
    expect(mtextPlain(e.text)).toBe("one\ntwo");
  });
});

describe("INSERT and BLOCKS", () => {
  const withBlocks = (blocks: string, entities: string) => dxf(section("BLOCKS", blocks), section("ENTITIES", entities));
  const unitLine = rec("LINE", [[10, 0], [20, 0], [11, 10], [21, 0]]);
  // These pin the in-place expansion (thumbnails and `blocks: "explode"`); kept blocks are covered in blocks/dxfBlocks.test.ts.
  const parseExploded = (text: string) => parseDxf(text, { blocks: "explode" });
  const explodedEntities = (text: string): Entity[] => parseExploded(text).entities;

  it("places a block body at the insertion point", () => {
    const text = withBlocks(block("SQ", [0, 0], unitLine), rec("INSERT", [[2, "SQ"], [10, 100], [20, 50]]));
    const [e] = explodedEntities(text) as LineEntity[];
    closeTo(e.a, 100, 50);
    closeTo(e.b, 110, 50);
  });

  it("subtracts the block's base point", () => {
    const body = rec("LINE", [[10, 5], [20, 0], [11, 15], [21, 0]]);
    const [e] = explodedEntities(withBlocks(block("SQ", [5, 0], body), rec("INSERT", [[2, "SQ"], [10, 100], [20, 50]]))) as LineEntity[];
    closeTo(e.a, 100, 50);
    closeTo(e.b, 110, 50);
  });

  it("applies rotation and scale", () => {
    const rotated = explodedEntities(
      withBlocks(block("SQ", [0, 0], unitLine), rec("INSERT", [[2, "SQ"], [10, 0], [20, 0], [50, 90]])),
    )[0] as LineEntity;
    closeTo(rotated.b, 0, 10);

    const scaled = explodedEntities(
      withBlocks(block("SQ", [0, 0], unitLine), rec("INSERT", [[2, "SQ"], [10, 0], [20, 0], [41, 2], [42, 2]])),
    )[0] as LineEntity;
    closeTo(scaled.b, 20, 0);
  });

  it("approximates a non-uniformly scaled circle and warns", () => {
    const body = rec("CIRCLE", [[10, 0], [20, 0], [40, 10]]);
    const result = parseExploded(withBlocks(block("B", [0, 0], body), rec("INSERT", [[2, "B"], [10, 0], [20, 0], [41, 4], [42, 1]])));
    expect((result.entities[0] as CircleEntity).radius).toBeCloseTo(20, 9); // geometric mean of 4x and 1x
    expect(result.warnings).toEqual(["a block was inserted with non-uniform scale — its circles/arcs are approximated as circular"]);
  });

  it("flips an arc's sweep and a polyline's bulges when one axis is mirrored", () => {
    const body =
      rec("ARC", [[10, 0], [20, 0], [40, 5], [50, 0], [51, 90]]) +
      rec("LWPOLYLINE", [[70, 1], [10, 0], [20, 0], [42, 0.5], [10, 10], [20, 0], [42, 0], [10, 10], [20, 10], [42, 0]]);
    const entities = explodedEntities(withBlocks(block("B", [0, 0], body), rec("INSERT", [[2, "B"], [10, 0], [20, 0], [41, -1], [42, 1]])));
    expect((entities[0] as ArcEntity).ccw).toBe(false);
    expect((entities[1] as PolylineEntity).bulges).toEqual([-0.5, -0, -0]);
  });

  it("stamps the rectangular array a single INSERT can describe", () => {
    const text = withBlocks(
      block("SQ", [0, 0], unitLine),
      rec("INSERT", [[2, "SQ"], [10, 0], [20, 0], [70, 3], [71, 2], [44, 100], [45, 50]]),
    );
    const entities = explodedEntities(text) as LineEntity[];
    expect(entities).toHaveLength(6);
    expect(entities.map((e) => [e.a.x, e.a.y])).toEqual([
      [0, 0],
      [0, 50],
      [100, 0],
      [100, 50],
      [200, 0],
      [200, 50],
    ]);
  });

  it("gives every stamped copy a fresh id", () => {
    const text = withBlocks(block("SQ", [0, 0], unitLine), rec("INSERT", [[2, "SQ"], [10, 0], [20, 0], [70, 4]]));
    const ids = explodedEntities(text).map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("expands nested blocks", () => {
    const blocks = block("INNER", [0, 0], unitLine) + block("OUTER", [0, 0], rec("INSERT", [[2, "INNER"], [10, 10], [20, 0]]));
    const [e] = explodedEntities(withBlocks(blocks, rec("INSERT", [[2, "OUTER"], [10, 100], [20, 0]]))) as LineEntity[];
    closeTo(e.a, 110, 0);
    closeTo(e.b, 120, 0);
  });

  it("lets block geometry on layer 0 inherit the INSERT's layer, but keeps its own otherwise", () => {
    const body = rec("LINE", [[8, "0"], [10, 0], [20, 0], [11, 1], [21, 0]]) + rec("LINE", [[8, "inner"], [10, 0], [20, 0], [11, 1], [21, 0]]);
    const entities = explodedEntities(withBlocks(block("B", [0, 0], body), rec("INSERT", [[2, "B"], [8, "parts"], [10, 0], [20, 0]])));
    expect(entities.map((e) => e.layer)).toEqual(["parts", "inner"]);
  });

  it("warns about a reference to a missing block definition", () => {
    const result = parseExploded(entitiesOnly(rec("INSERT", [[2, "GHOST"], [10, 0], [20, 0]])));
    expect(result.entities).toEqual([]);
    expect(result.warnings).toEqual(["a block reference points at a missing block definition ('GHOST')"]);
  });

  it("breaks a self-referencing block instead of recursing forever", () => {
    const blocks = block("LOOP", [0, 0], unitLine + rec("INSERT", [[2, "LOOP"], [10, 10], [20, 0]]));
    const result = parseExploded(withBlocks(blocks, rec("INSERT", [[2, "LOOP"], [10, 0], [20, 0]])));
    expect(result.entities).toHaveLength(1);
    expect(result.warnings).toContain("block 'LOOP' inserts itself — skipped to avoid infinite nesting");
  });

  it("stops expanding past the nesting depth cap", () => {
    const depth = 12;
    const chain = Array.from({ length: depth }, (_, i) =>
      block(`B${i}`, [0, 0], i === depth - 1 ? unitLine : rec("INSERT", [[2, `B${i + 1}`], [10, 0], [20, 0]])),
    ).join("");
    const result = parseExploded(withBlocks(chain, rec("INSERT", [[2, "B0"], [10, 0], [20, 0]])));
    expect(result.warnings).toContain("blocks nested deeper than 8 levels were not expanded");
    expect(result.entities).toEqual([]);
  });
});

describe("$INSUNITS", () => {
  const oneMetreLine = section("ENTITIES", rec("LINE", [[10, 0], [20, 0], [11, 1], [21, 0]]));

  it("reports the declared code, or 0 when the file doesn't say", () => {
    expect(parse(dxf(header(4), oneMetreLine)).insUnits).toBe(4);
    expect(parse(dxf(oneMetreLine)).insUnits).toBe(0);
  });

  it("rescales coordinates to millimetres for every mapped unit", () => {
    for (const [code, mm] of [[1, 25.4], [2, 304.8], [4, 1], [5, 10], [6, 1000]] as const) {
      const [e] = parse(dxf(header(code), oneMetreLine)).entities as LineEntity[];
      expect(e.b.x).toBeCloseTo(mm, 9);
    }
  });

  it("leaves coordinates untouched for an unspecified or unknown code", () => {
    for (const code of [0, 99]) {
      const [e] = parse(dxf(header(code), oneMetreLine)).entities as LineEntity[];
      expect(e.b.x).toBe(1);
    }
  });

  it("scales every unit code the DXF spec defines", () => {
    const expected: [number, number][] = [
      [3, 1609344], [7, 1e6], [8, 25.4e-6], [9, 0.0254], [10, 914.4], [11, 1e-7], [12, 1e-6],
      [13, 1e-3], [14, 100], [15, 1e4], [16, 1e5], [21, 304.8006096], [22, 25.4000508], [23, 914.4018288],
    ];
    for (const [code, mm] of expected) {
      const r = parse(dxf(header(code), oneMetreLine));
      expect(r.unitSource).toBe("insunits");
      expect((r.entities[0] as LineEntity).b.x / mm).toBeCloseTo(1, 6);
    }
  });

  /** A HEADER with the given `[name, code, value]` variables (after an `$ACADVER`). */
  const headerVars = (...vars: [string, number, number | string][]): string =>
    section("HEADER", ["9", "$ACADVER", "1", "AC1014", ...vars.flatMap(([n, c, v]) => ["9", n, String(c), String(v)])].join("\n") + "\n");

  it("falls back to $MEASUREMENT when $INSUNITS is missing or unitless", () => {
    const imperial = parse(dxf(headerVars(["$MEASUREMENT", 70, 0]), oneMetreLine));
    expect(imperial).toMatchObject({ insUnits: 1, unitSource: "measurement" });
    expect((imperial.entities[0] as LineEntity).b.x).toBeCloseTo(25.4, 9);
    expect(parse(dxf(headerVars(["$INSUNITS", 70, 0], ["$MEASUREMENT", 70, 0]), oneMetreLine)).insUnits).toBe(1);
    expect(parse(dxf(headerVars(["$MEASUREMENT", 70, 1]), oneMetreLine)).insUnits).toBe(4);
    // An explicit $INSUNITS always beats $MEASUREMENT.
    expect(parse(dxf(headerVars(["$INSUNITS", 70, 4], ["$MEASUREMENT", 70, 0]), oneMetreLine)).insUnits).toBe(4);
  });

  it("guesses from template defaults when no unit variable exists, and says so", () => {
    // Values straight from AutoCAD's acad.dwt (imperial) and acadiso.dwt (metric).
    const imperial = parse(dxf(headerVars(["$DIMTXT", 40, 0.18], ["$DIMALTF", 40, 25.4]), oneMetreLine));
    expect(imperial).toMatchObject({ insUnits: 1, unitSource: "inferred" });
    expect((imperial.entities[0] as LineEntity).b.x).toBeCloseTo(25.4, 9);
    const metric = parse(dxf(headerVars(["$DIMTXT", 40, 2.5], ["$TEXTSIZE", 40, 2.5]), oneMetreLine));
    expect(metric).toMatchObject({ insUnits: 4, unitSource: "inferred" });
    // Conflicting hints are not a guess.
    const mixed = parse(dxf(headerVars(["$DIMTXT", 40, 0.18], ["$TEXTSIZE", 40, 2.5]), oneMetreLine));
    expect(mixed.unitSource).toBe("none");
  });

  it("reads a 'millimetre' file whose $DIMALTF is 1000 as metres, and flags it", () => {
    // Real production files: declared mm, metric template, DIMALTF 1000 — the
    // parts are 0.3 mm as mm and a sensible 12" as metres.
    for (const vars of [
      [["$INSUNITS", 70, 4], ["$DIMALTF", 40, 1000]],
      [["$MEASUREMENT", 70, 1], ["$DIMALTF", 40, 1000.0]],
    ] as [string, number, number][][]) {
      const r = parse(dxf(headerVars(...vars), oneMetreLine));
      expect(r).toMatchObject({ insUnits: 6, unitSource: "conflict" });
      expect((r.entities[0] as LineEntity).b.x).toBeCloseTo(1000, 9);
    }
    // A normal metric file (DIMALTF 0.03937) stays millimetres.
    expect(parse(dxf(headerVars(["$INSUNITS", 70, 4], ["$DIMALTF", 40, 0.03937]), oneMetreLine)).unitSource).toBe("insunits");
  });

  it("reads a file with no unit hint in the caller's assumed unit", () => {
    const r = parse(dxf(oneMetreLine), { assumeUnits: 1 });
    expect(r).toMatchObject({ insUnits: 1, unitSource: "none" });
    expect((r.entities[0] as LineEntity).b.x).toBeCloseTo(25.4, 9);
    // A declared unit is never overridden by the assumption.
    expect(parse(dxf(header(4), oneMetreLine), { assumeUnits: 1 }).insUnits).toBe(4);
  });

  it("reads a (here empty) binary DXF instead of refusing it (X-11), and warns when the bytes were lost to text decoding", () => {
    expect(parse("AutoCAD Binary DXF" + String.fromCharCode(13, 10, 26, 0)).entities).toEqual([]);
    expect(parse("AutoCAD Binary DXFЖ").warnings[0]).toMatch(/binary DXF/);
  });

  it("scales radii and block-placed geometry too", () => {
    const text = dxf(header(1), section("ENTITIES", rec("CIRCLE", [[10, 0], [20, 0], [40, 2]])));
    expect((parse(text).entities[0] as CircleEntity).radius).toBeCloseTo(50.8, 9);
  });
});

describe("import report and warnings", () => {
  it("splits entity types into parsed and skipped buckets", () => {
    const text = entitiesOnly(
      rec("LINE", [[10, 0], [20, 0], [11, 1], [21, 1]]) +
        rec("LINE", [[10, 0], [20, 0], [11, 2], [21, 2]]) +
        rec("LEADER", [[10, 0]]) +
        rec("LEADER", [[10, 1]]) +
        rec("DIMENSION", [[10, 0]]),
    );
    const { report } = parse(text);
    expect(report.parsed).toEqual([{ type: "LINE", count: 2 }]);
    expect(report.skipped).toEqual([
      { type: "LEADER", count: 2 },
      { type: "DIMENSION", count: 1 },
    ]);
  });

  it("sorts parsed types by name and skipped types by how many were lost", () => {
    const text = entitiesOnly(
      rec("POINT", [[10, 0], [20, 0]]) +
        rec("CIRCLE", [[10, 0], [20, 0], [40, 1]]) +
        rec("HELIX", []) +
        rec("LEADER", []) +
        rec("LEADER", []),
    );
    const { report } = parse(text);
    expect(report.parsed.map((p) => p.type)).toEqual(["CIRCLE", "POINT"]);
    expect(report.skipped.map((p) => p.type)).toEqual(["LEADER", "HELIX"]);
  });

  it("leaves records that carry no geometry out of both buckets", () => {
    const text = entitiesOnly(
      rec("POLYLINE", []) +
        rec("VERTEX", [[10, 0], [20, 0]]) +
        rec("VERTEX", [[10, 1], [20, 1]]) +
        rec("SEQEND", []) +
        rec("VIEWPORT", []),
    );
    const { report } = parse(text);
    expect(report.parsed).toEqual([{ type: "POLYLINE", count: 1 }]);
    expect(report.skipped).toEqual([]);
  });

  it("reports each unsupported type once however many records there were", () => {
    const text = entitiesOnly(rec("DIMENSION", []) + rec("DIMENSION", []) + rec("DIMENSION", []));
    expect(parse(text).warnings).toEqual(["unsupported entity: DIMENSION"]);
  });
});

describe("malformed and unusual files", () => {
  it("returns an empty result for empty or junk input", () => {
    for (const text of ["", "\n", "not a dxf at all", "0\n"]) {
      const result = parse(text);
      expect(result.entities).toEqual([]);
      expect(result.report).toEqual({ parsed: [], skipped: [] });
      expect(result.insUnits).toBe(0);
    }
  });

  it("still reads entities from a file truncated before ENDSEC and EOF", () => {
    const text = `0\nSECTION\n2\nENTITIES\n${rec("LINE", [[10, 0], [20, 0], [11, 5], [21, 5]])}`;
    expect(entitiesOf(text)).toHaveLength(1);
  });

  it("accepts CRLF and bare-CR line endings", () => {
    const text = entitiesOnly(rec("LINE", [[10, 0], [20, 0], [11, 5], [21, 5]]));
    expect(entitiesOf(text.replace(/\n/g, "\r\n"))).toHaveLength(1);
    expect(entitiesOf(text.replace(/\n/g, "\r"))).toHaveLength(1);
  });

  it("ignores records outside the ENTITIES section", () => {
    const text = dxf(section("OBJECTS", rec("LINE", [[10, 0], [20, 0], [11, 5], [21, 5]])), section("ENTITIES", ""));
    expect(entitiesOf(text)).toEqual([]);
  });

  it("tolerates missing coordinate groups by defaulting them to zero", () => {
    const [e] = entitiesOf(entitiesOnly(rec("LINE", [[10, 5]]))) as LineEntity[];
    expect(e.a).toEqual({ x: 5, y: 0 });
    expect(e.b).toEqual({ x: 0, y: 0 });
  });
});

describe("boundsOf", () => {
  it("returns null when there is nothing to bound", () => {
    expect(boundsOf([])).toBeNull();
  });

  it("bounds lines and points by their coordinates", () => {
    const entities: Entity[] = [
      { id: "l", type: "line", a: { x: -5, y: 0 }, b: { x: 10, y: 3 } },
      { id: "p", type: "point", p: { x: 2, y: -8 } },
    ];
    expect(boundsOf(entities)).toEqual({ minX: -5, minY: -8, maxX: 10, maxY: 3 });
  });

  it("bounds a circle by its extremes, not its centre", () => {
    const c: CircleEntity = { id: "c", type: "circle", center: { x: 10, y: 10 }, radius: 4 };
    expect(boundsOf([c])).toEqual({ minX: 6, minY: 6, maxX: 14, maxY: 14 });
  });

  it("includes the axis extremes an arc sweeps through, not just its endpoints", () => {
    // A 0 -> 180 arc of radius 10 tops out at y = 10, well past both endpoints.
    const a: ArcEntity = { id: "a", type: "arc", center: { x: 0, y: 0 }, radius: 10, startAngle: 0, endAngle: Math.PI, ccw: true };
    const b = boundsOf([a])!;
    expect(b.maxY).toBeCloseTo(10, 9);
    expect(b.minY).toBeCloseTo(0, 9);
    expect(b.minX).toBeCloseTo(-10, 9);
  });

  it("includes the bulge of a curved polyline segment", () => {
    const straight: PolylineEntity = {
      id: "s",
      type: "polyline",
      points: [{ x: 0, y: 0 }, { x: 10, y: 0 }],
      closed: false,
    };
    expect(boundsOf([straight])).toEqual({ minX: 0, minY: 0, maxX: 10, maxY: 0 });

    // Bulge is signed counterclockwise, so a positive half turn along a
    // left-to-right chord swings *below* it, and a negative one above.
    expect(boundsOf([{ ...straight, bulges: [1] }])!.minY).toBeCloseTo(-5, 9);
    expect(boundsOf([{ ...straight, bulges: [-1] }])!.maxY).toBeCloseTo(5, 9);
  });
});

describe("thumbnail SVG", () => {
  const lineEntity: LineEntity = { id: "l", type: "line", a: { x: 0, y: 0 }, b: { x: 10, y: 10 } };

  it("produces a well-formed square SVG at the requested size", () => {
    const svg = entitiesToSvg([lineEntity], { size: 64 });
    expect(svg.startsWith("<svg xmlns=")).toBe(true);
    expect(svg.endsWith("</svg>")).toBe(true);
    expect(svg).toContain('width="64" height="64" viewBox="0 0 64 64"');
    expect(svg).toContain("<line ");
  });

  it("honours the stroke and background options", () => {
    const svg = entitiesToSvg([lineEntity], { stroke: "#ff0000", background: "#ffffff" });
    expect(svg).toContain('fill="#ffffff"');
    expect(svg).toContain('stroke="#ff0000"');
  });

  it("still renders a background for an empty drawing", () => {
    const svg = entitiesToSvg([]);
    expect(svg).toContain("<rect ");
    expect(svg).toContain("></g></svg>");
  });

  it("uses the right primitive per entity type", () => {
    const arcEntity: ArcEntity = { id: "a", type: "arc", center: { x: 0, y: 0 }, radius: 5, startAngle: 0, endAngle: 1, ccw: true };
    const circleEntity: CircleEntity = { id: "c", type: "circle", center: { x: 0, y: 0 }, radius: 5 };
    expect(entitiesToSvg([circleEntity])).toContain("<circle ");
    expect(entitiesToSvg([arcEntity])).toContain("<path ");
  });

  it("keeps the drawing inside the padded box", () => {
    const size = 100;
    const pad = 10;
    const svg = entitiesToSvg([{ id: "l", type: "line", a: { x: 0, y: 0 }, b: { x: 1000, y: 500 } }], { size, padding: pad });
    const coords = [...svg.matchAll(/[xy][12]="(-?[\d.]+)"/g)].map((m) => Number(m[1]));
    expect(Math.min(...coords)).toBeGreaterThanOrEqual(pad - 0.01);
    expect(Math.max(...coords)).toBeLessThanOrEqual(size - pad + 0.01);
  });

  it("renders DXF text straight through", () => {
    const svg = dxfToSvg(entitiesOnly(rec("CIRCLE", [[10, 0], [20, 0], [40, 5]])));
    expect(svg).toContain("<circle ");
  });
});

describe("X-04: entity colour", () => {
  it("reads an ACI colour (group 62) as its palette hex", () => {
    const [e] = entitiesOf(entitiesOnly(rec("LINE", [[10, 0], [20, 0], [11, 1], [21, 1], [62, 1]]))) as LineEntity[];
    expect(e.color).toBe("#ff0000"); // ACI 1 = red
  });

  it("prefers true colour (group 420) over the ACI fallback when both are present", () => {
    const [e] = entitiesOf(
      entitiesOnly(rec("LINE", [[10, 0], [20, 0], [11, 1], [21, 1], [62, 1], [420, 0x5b96ff]])),
    ) as LineEntity[];
    expect(e.color).toBe("#5b96ff");
  });

  it("leaves colour unset for BYLAYER (62) or BYBLOCK (0)", () => {
    const [a] = entitiesOf(entitiesOnly(rec("LINE", [[10, 0], [20, 0], [11, 1], [21, 1], [62, 256]]))) as LineEntity[];
    const [b] = entitiesOf(entitiesOnly(rec("LINE", [[10, 0], [20, 0], [11, 1], [21, 1], [62, 0]]))) as LineEntity[];
    expect(a.color).toBeUndefined();
    expect(b.color).toBeUndefined();
  });

  it("leaves colour unset when neither group is present", () => {
    const [e] = entitiesOf(entitiesOnly(rec("LINE", [[10, 0], [20, 0], [11, 1], [21, 1]]))) as LineEntity[];
    expect(e.color).toBeUndefined();
  });
});
