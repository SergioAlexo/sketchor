import { describe, expect, it } from "vitest";
import { entitiesToDxf } from "./dxfExport";
import { boundsOf, parseDxf } from "./dxf";
import { layerOf } from "./entities";
import { arcPointAt, arcSweep } from "./geometry";
import type { ArcEntity, CircleEntity, Entity, LineEntity, PointEntity, PolylineEntity } from "./entities";

/**
 * The DXF writer and its own parser, tested together: an export that a
 * re-import doesn't reproduce is silent data loss, and the file is the format
 * users hand to real CAD software.
 *
 * The pairing that gets the most attention is `insUnits` + `scale`. Entities
 * are always stored in millimetres, so writing a file tagged as inches means
 * scaling the numbers by 1/25.4 as well — tag without scale (or scale without
 * tag) and the drawing silently comes back 25.4x wrong.
 */

const HALF_PI = Math.PI / 2;

const line = (): LineEntity => ({ id: "l", type: "line", a: { x: 0, y: 0 }, b: { x: 100, y: 50 } });
const circle = (): CircleEntity => ({ id: "c", type: "circle", layer: "holes", center: { x: 20, y: 30 }, radius: 12.5 });
const arcCcw = (): ArcEntity => ({
  id: "a",
  type: "arc",
  center: { x: -10, y: 5 },
  radius: 8,
  startAngle: 0,
  endAngle: HALF_PI,
  ccw: true,
});
const point = (): PointEntity => ({ id: "p", type: "point", layer: "marks", p: { x: 7, y: -3 } });
const openPolyline = (): PolylineEntity => ({
  id: "pl",
  type: "polyline",
  points: [
    { x: 0, y: 0 },
    { x: 10, y: 0 },
    { x: 10, y: 10 },
  ],
  closed: false,
});
const bulgedClosed = (): PolylineEntity => ({
  id: "plb",
  type: "polyline",
  layer: "outline",
  points: [
    { x: 0, y: 0 },
    { x: 20, y: 0 },
    { x: 20, y: 20 },
  ],
  bulges: [0.5, 0, -0.25],
  closed: true,
});

/** The group-code pairs that follow a `9\n$NAME` header variable. */
function headerVar(dxf: string, name: string): { code: number; value: string }[] {
  const lines = dxf.split("\n");
  const at = lines.indexOf(name);
  expect(at).toBeGreaterThan(-1);
  const out: { code: number; value: string }[] = [];
  for (let i = at + 1; i + 1 < lines.length; i += 2) {
    const code = Number(lines[i]);
    if (code === 9 || code === 0) break;
    out.push({ code, value: lines[i + 1] });
  }
  return out;
}

/** Center, radius, sweep magnitude and the (unordered) endpoints — the curve itself, independent of traversal direction. */
function arcCurve(e: ArcEntity) {
  const ends = [
    arcPointAt(e.center, e.radius, e.startAngle),
    arcPointAt(e.center, e.radius, e.endAngle),
  ]
    .map((p) => `${p.x.toFixed(6)},${p.y.toFixed(6)}`)
    .sort();
  return {
    center: `${e.center.x.toFixed(6)},${e.center.y.toFixed(6)}`,
    radius: Number(e.radius.toFixed(6)),
    sweep: Number(arcSweep(e.startAngle, e.endAngle, e.ccw).toFixed(6)),
    ends,
  };
}

const reimport = (entities: Entity[], insUnits = 0, scale = 1): Entity[] =>
  parseDxf(entitiesToDxf(entities, insUnits, scale)).entities;

describe("file structure", () => {
  it("emits HEADER, TABLES, ENTITIES and EOF in order", () => {
    const text = entitiesToDxf([line()]);
    const order = ["2\nHEADER", "2\nTABLES", "2\nENTITIES", "0\nEOF"].map((s) => text.indexOf(s));
    expect(order.every((i) => i > -1)).toBe(true);
    expect([...order]).toEqual([...order].sort((a, b) => a - b));
    expect(text).toContain("9\n$ACADVER\n1\nAC1009");
  });

  it("writes numeric groups with an explicit decimal point", () => {
    // "10\n0" would be read as an integer by strict consumers; DXF convention is "0.0".
    const text = entitiesToDxf([line()]);
    expect(text).toContain("10\n0.0\n20\n0.0\n");
    expect(text).toContain("11\n100.0\n21\n50.0\n");
  });

  it("lists every layer in use exactly once", () => {
    const text = entitiesToDxf([line(), circle(), point(), { ...circle(), id: "c2" }]);
    const names = [...text.matchAll(/0\nLAYER\n2\n([^\n]+)\n/g)].map((m) => m[1]);
    expect(names).toEqual(["0", "holes", "marks"]);
    expect(text).toContain(`2\nLAYER\n70\n${names.length}\n`);
  });

  it("still declares layer 0 when there are no entities", () => {
    const text = entitiesToDxf([]);
    expect([...text.matchAll(/0\nLAYER\n2\n([^\n]+)\n/g)].map((m) => m[1])).toEqual(["0"]);
    expect(parseDxf(text).entities).toEqual([]);
  });

  it("writes extents that match boundsOf", () => {
    const entities = [line(), circle(), arcCcw()];
    const b = boundsOf(entities)!;
    const text = entitiesToDxf(entities);
    expect(headerVar(text, "$EXTMIN").map((p) => [p.code, Number(p.value)])).toEqual([
      [10, b.minX],
      [20, b.minY],
      [30, 0],
    ]);
    expect(headerVar(text, "$EXTMAX").slice(0, 2).map((p) => Number(p.value))).toEqual([b.maxX, b.maxY]);
  });

  it("writes zeroed extents for an empty drawing", () => {
    expect(headerVar(entitiesToDxf([]), "$EXTMIN").map((p) => p.value)).toEqual(["0.0", "0.0", "0.0"]);
  });
});

describe("round-trip through parseDxf", () => {
  it("preserves a line", () => {
    const [e] = reimport([line()]) as LineEntity[];
    expect(e.type).toBe("line");
    expect(e.a).toEqual({ x: 0, y: 0 });
    expect(e.b).toEqual({ x: 100, y: 50 });
  });

  it("preserves a circle and a point", () => {
    const [c, p] = reimport([circle(), point()]) as [CircleEntity, PointEntity];
    expect(c).toMatchObject({ type: "circle", center: { x: 20, y: 30 }, radius: 12.5 });
    expect(p).toMatchObject({ type: "point", p: { x: 7, y: -3 } });
  });

  it("preserves an arc's curve, and normalises a clockwise arc to counterclockwise", () => {
    // DXF ARC always sweeps CCW from code 50 to 51, so a CW arc comes back as
    // the same curve read the other way — identical geometry, flipped fields.
    const cw: ArcEntity = { ...arcCcw(), ccw: false };
    for (const original of [arcCcw(), cw]) {
      const [back] = reimport([original]) as ArcEntity[];
      expect(back.ccw).toBe(true);
      expect(arcCurve(back)).toEqual(arcCurve(original));
    }
  });

  it("preserves an open polyline and drops an all-straight bulges array", () => {
    const [e] = reimport([{ ...openPolyline(), bulges: [0, 0] }]) as PolylineEntity[];
    expect(e.points).toEqual(openPolyline().points);
    expect(e.closed).toBe(false);
    expect(e.bulges).toBeUndefined();
  });

  it("preserves a closed polyline's per-segment bulges", () => {
    const [e] = reimport([bulgedClosed()]) as PolylineEntity[];
    expect(e.closed).toBe(true);
    expect(e.points).toEqual(bulgedClosed().points);
    expect(e.bulges).toEqual([0.5, 0, -0.25]);
  });

  it("keeps an open polyline's bulges aligned with its segments", () => {
    const open: PolylineEntity = { ...openPolyline(), bulges: [0, 0.75] };
    const [e] = reimport([open]) as PolylineEntity[];
    expect(e.bulges).toEqual([0, 0.75]); // one per segment, not one per vertex
  });

  it("preserves layers, defaulting an unset layer to 0", () => {
    const back = reimport([line(), circle(), point(), bulgedClosed()]);
    expect(back.map(layerOf)).toEqual(["0", "holes", "marks", "outline"]);
  });

  it("assigns fresh ids rather than reusing the exported ones", () => {
    const back = reimport([line(), circle()]);
    expect(back.map((e) => e.id)).not.toContain("l");
    expect(new Set(back.map((e) => e.id)).size).toBe(2);
  });

  it("survives a full drawing without warnings or skipped types", () => {
    const entities = [line(), circle(), arcCcw(), point(), openPolyline(), bulgedClosed()];
    const result = parseDxf(entitiesToDxf(entities));
    expect(result.warnings).toEqual([]);
    expect(result.report.skipped).toEqual([]);
    expect(result.entities).toHaveLength(entities.length);
  });
});

describe("insUnits and scale", () => {
  it("tags the declared unit in the header", () => {
    expect(headerVar(entitiesToDxf([line()], 4), "$INSUNITS")).toEqual([{ code: 70, value: "4" }]);
    expect(headerVar(entitiesToDxf([line()]), "$INSUNITS")).toEqual([{ code: 70, value: "0" }]);
  });

  it("leaves numbers in millimetres by default", () => {
    const back = reimport([circle()]) as CircleEntity[];
    expect(back[0].radius).toBe(12.5);
  });

  it("round-trips millimetres through an inch-tagged file when scale matches", () => {
    // 254 mm is exactly 10 in, so the trip is lossless rather than merely close.
    const c: CircleEntity = { id: "c", type: "circle", center: { x: 254, y: 0 }, radius: 25.4 };
    const text = entitiesToDxf([c], 1, 1 / 25.4);
    expect(text).toContain("10\n10.0\n"); // written in inches
    expect(text).toContain("40\n1.0\n");

    const [back] = parseDxf(text).entities as CircleEntity[];
    expect(back.center.x).toBeCloseTo(254, 6); // scaled back to mm on import
    expect(back.radius).toBeCloseTo(25.4, 6);
  });

  it("round-trips through every unit this app maps, within the writer's precision", () => {
    // Coordinates are rounded to 6 decimals *in file units*, so the error back
    // in millimetres scales with the unit: half a micron for a mm file, but
    // ~1.5e-4 mm once the numbers are written as feet.
    const c: CircleEntity = { id: "c", type: "circle", center: { x: 1000, y: -500 }, radius: 254 };
    for (const [code, mmPerUnit] of [
      [1, 25.4],
      [2, 304.8],
      [4, 1],
      [5, 10],
      [6, 1000],
    ] as const) {
      const tolerance = 5e-7 * mmPerUnit;
      const [back] = parseDxf(entitiesToDxf([c], code, 1 / mmPerUnit)).entities as CircleEntity[];
      expect(Math.abs(back.center.x - 1000)).toBeLessThanOrEqual(tolerance);
      expect(Math.abs(back.center.y - -500)).toBeLessThanOrEqual(tolerance);
      expect(Math.abs(back.radius - 254)).toBeLessThanOrEqual(tolerance);
    }
  });

  it("comes back 25.4x too large when the unit is tagged but the numbers aren't scaled", () => {
    // The failure mode the scale parameter exists to prevent.
    const c: CircleEntity = { id: "c", type: "circle", center: { x: 0, y: 0 }, radius: 100 };
    const [back] = parseDxf(entitiesToDxf([c], 1)).entities as CircleEntity[];
    expect(back.radius).toBeCloseTo(2540, 6);
  });

  it("scales the extents it writes, not just the entities", () => {
    const c: CircleEntity = { id: "c", type: "circle", center: { x: 0, y: 0 }, radius: 25.4 };
    const ext = headerVar(entitiesToDxf([c], 1, 1 / 25.4), "$EXTMAX").map((p) => Number(p.value));
    expect(ext.slice(0, 2)).toEqual([1, 1]);
  });

  it("scales a polyline's coordinates but not its bulges", () => {
    const [back] = parseDxf(entitiesToDxf([bulgedClosed()], 4, 1)).entities as PolylineEntity[];
    expect(back.bulges).toEqual([0.5, 0, -0.25]);
  });
});

describe("X-04: colour", () => {
  it("writes an explicit colour as its nearest ACI (group 62) and round-trips it", () => {
    const e: LineEntity = { ...line(), color: "#ff0000" }; // an exact ACI 1 match
    const text = entitiesToDxf([e]);
    expect(text).toContain("\n62\n1\n");
    const [back] = parseDxf(text).entities as LineEntity[];
    expect(back.color).toBe("#ff0000");
  });

  it("approximates an arbitrary colour to its nearest ACI (R12 has no true colour)", () => {
    const e: CircleEntity = { ...circle(), color: "#5b96ff" };
    const [back] = parseDxf(entitiesToDxf([e])).entities as CircleEntity[];
    expect(back.color).toBeDefined();
    expect(back.color).not.toBe("#5b96ff"); // lossy on purpose — R12 can't carry an exact true colour
  });

  it("writes nothing (BYLAYER) for an entity with no explicit colour", () => {
    const text = entitiesToDxf([line()]);
    // The LAYER table entry legitimately carries its own "62\n7\n" (every
    // layer here is written as ACI 7) — scope the check to the entity body.
    const entitySection = text.slice(text.indexOf("0\nLINE"));
    expect(entitySection).not.toMatch(/\n62\n/);
    const [back] = parseDxf(text).entities as LineEntity[];
    expect(back.color).toBeUndefined();
  });
});

describe("Z-04: linetype and lineweight", () => {
  it("writes an LTYPE table entry and group 6 for a non-continuous linetype, and round-trips it", () => {
    const e: LineEntity = { ...line(), linetype: "CENTER" };
    const text = entitiesToDxf([e]);
    expect(text).toContain("0\nLTYPE\n2\nCENTER\n");
    const entitySection = text.slice(text.indexOf("0\nLINE"));
    expect(entitySection).toContain("6\nCENTER\n");
    const [back] = parseDxf(text).entities as LineEntity[];
    expect(back.linetype).toBe("CENTER");
  });

  it("writes lineweight as hundredths of a millimetre (group 370) and round-trips it", () => {
    const e: LineEntity = { ...line(), lineweight: 0.5 };
    const text = entitiesToDxf([e]);
    const entitySection = text.slice(text.indexOf("0\nLINE"));
    expect(entitySection).toContain("370\n50\n");
    const [back] = parseDxf(text).entities as LineEntity[];
    expect(back.lineweight).toBeCloseTo(0.5, 9);
  });

  it("never writes a per-entity linetype scale (group 48): R12 predates it, and a CAM reader may choke on it", () => {
    const text = entitiesToDxf([{ ...line(), linetype: "DASHED", linetypeScale: 5 }]);
    const entitySection = text.slice(text.indexOf("0\nLINE"));
    expect(entitySection).toContain("6\nDASHED\n");
    expect(entitySection).not.toMatch(/\n48\n/);
  });

  it("writes nothing (BYLAYER) for an entity with no explicit linetype/lineweight", () => {
    const text = entitiesToDxf([line()]);
    const entitySection = text.slice(text.indexOf("0\nLINE"));
    expect(entitySection).not.toMatch(/\n6\n/);
    expect(entitySection).not.toMatch(/\n370\n/);
    // CONTINUOUS is still declared in the LTYPE table — every file needs it.
    expect(text).toContain("0\nLTYPE\n2\nCONTINUOUS\n");
  });

  it("always includes CONTINUOUS in the LTYPE table even when nothing uses it", () => {
    const text = entitiesToDxf([]);
    expect(text).toContain("0\nLTYPE\n2\nCONTINUOUS\n");
  });
});
