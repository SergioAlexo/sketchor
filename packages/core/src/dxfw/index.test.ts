import { describe, expect, it } from "vitest";
import { entitiesToDxf2018 } from "./index";
import { parseDxf } from "../dxf";
import { layerOf } from "../entities";
import type { ArcEntity, CircleEntity, Entity, LineEntity, PointEntity, PolylineEntity, TextEntity } from "../entities";

/**
 * X-01: the AC1032 ("DXF 2018") writer, validated two ways — through
 * Sketchor's own parser (round-trip, including the SKETCHOR XDATA name that
 * R12 export always lost) and, offline during development, through
 * `ezdxf.audit()` (zero errors on every fixture here; not re-run in CI —
 * see X-02 for the harness that would).
 */

const line = (): LineEntity => ({ id: "l", type: "line", name: "L1", a: { x: 0, y: 0 }, b: { x: 100, y: 50 } });
const circle = (): CircleEntity => ({ id: "c", type: "circle", name: "C1", layer: "holes", center: { x: 20, y: 30 }, radius: 12.5 });
const arcCcw = (): ArcEntity => ({
  id: "a",
  type: "arc",
  name: "A1",
  center: { x: -10, y: 5 },
  radius: 8,
  startAngle: 0,
  endAngle: Math.PI / 2,
  ccw: true,
});
const point = (): PointEntity => ({ id: "p", type: "point", name: "P1", layer: "marks", p: { x: 7, y: -3 } });
const bulgedClosed = (): PolylineEntity => ({
  id: "pl",
  type: "polyline",
  name: "PL1",
  layer: "outline",
  points: [
    { x: 0, y: 0 },
    { x: 20, y: 0 },
    { x: 20, y: 20 },
  ],
  bulges: [0.5, 0, -0.25],
  closed: true,
});
const text = (): TextEntity => ({ id: "t", type: "text", name: "T1", at: { x: 5, y: 5 }, text: "Hello", height: 2.5, rotation: 0 });

const reimport = (entities: Entity[], opts?: Parameters<typeof entitiesToDxf2018>[1]): Entity[] =>
  parseDxf(entitiesToDxf2018(entities, opts)).entities;

describe("file structure", () => {
  it("writes AC1032 and every required section in order", () => {
    const text = entitiesToDxf2018([line()]);
    expect(text).toContain("9\n$ACADVER\n1\nAC1032\n");
    const order = [
      "2\nHEADER",
      "2\nCLASSES",
      "2\nTABLES",
      "2\nBLOCKS",
      "2\nENTITIES",
      "2\nOBJECTS",
      "0\nEOF",
    ].map((s) => text.indexOf(s));
    expect(order.every((i) => i > -1)).toBe(true);
    expect(order).toEqual([...order].sort((a, b) => a - b));
  });

  it("gives every table, block and entity record a handle and an owner pointer", () => {
    const text = entitiesToDxf2018([line(), circle()]);
    // Every ENTITIES record opens with "0\n<TYPE>\n5\n<handle>\n330\n<owner>".
    const entityRecords = [...text.matchAll(/0\n(LINE|CIRCLE)\n5\n([0-9A-F]+)\n330\n([0-9A-F]+)\n/g)];
    expect(entityRecords).toHaveLength(2);
    for (const [, , handle, owner] of entityRecords) {
      expect(handle.length).toBeGreaterThan(0);
      expect(owner.length).toBeGreaterThan(0);
    }
    // Handles are unique across the whole file.
    const allHandles = [...text.matchAll(/(?:^|\n)5\n([0-9A-F]+)\n/g)].map((m) => m[1]);
    expect(new Set(allHandles).size).toBe(allHandles.length);
  });

  it("registers the SKETCHOR APPID and tags every named entity's XDATA", () => {
    const text = entitiesToDxf2018([line()]);
    expect(text).toContain("2\nSKETCHOR\n70\n0\n");
    expect(text).toContain("1001\nSKETCHOR\n1000\nL1\n");
  });

  it("writes $HANDSEED past the highest handle actually used", () => {
    const text = entitiesToDxf2018([line(), circle(), arcCcw()]);
    const seedMatch = text.match(/9\n\$HANDSEED\n5\n([0-9A-F]+)\n/);
    expect(seedMatch).not.toBeNull();
    const seed = parseInt(seedMatch![1], 16);
    // Scan past HEADER so $HANDSEED's own value (not itself a handle) isn't counted.
    const body = text.slice(text.indexOf("0\nENDSEC\n"));
    const allHandles = [...body.matchAll(/(?:^|\n)5\n([0-9A-F]+)\n/g)].map((m) => parseInt(m[1], 16));
    expect(Math.max(...allHandles)).toBeLessThan(seed);
  });

  it("still produces a structurally valid file for an empty drawing", () => {
    const text = entitiesToDxf2018([]);
    expect(text).toContain("0\nEOF\n");
    expect(parseDxf(text).entities).toEqual([]);
  });
});

describe("round-trip through parseDxf", () => {
  it("preserves geometry and name for every built-in entity kind", () => {
    const entities = [line(), circle(), arcCcw(), point(), bulgedClosed(), text()];
    const back = reimport(entities);
    expect(back).toHaveLength(entities.length);
    expect(back.map((e) => e.name)).toEqual(entities.map((e) => e.name));
    expect(back.map(layerOf)).toEqual(entities.map(layerOf));

    const [l, c, a, p, pl] = back as [LineEntity, CircleEntity, ArcEntity, PointEntity, PolylineEntity];
    expect(l.a).toEqual({ x: 0, y: 0 });
    expect(l.b).toEqual({ x: 100, y: 50 });
    expect(c).toMatchObject({ center: { x: 20, y: 30 }, radius: 12.5 });
    expect(a.ccw).toBe(true);
    expect(p.p).toEqual({ x: 7, y: -3 });
    expect(pl.bulges).toEqual([0.5, 0, -0.25]);
  });

  it("drops the name when a parser produced more than one entity for a record (not applicable here, but asserts the single-record case stays precise)", () => {
    const [back] = reimport([line()]) as LineEntity[];
    expect(back.name).toBe("L1");
  });

  it("round-trips through a scaled, unit-tagged file", () => {
    const c: CircleEntity = { id: "c", type: "circle", name: "C1", center: { x: 254, y: 0 }, radius: 25.4 };
    const [back] = reimport([c], { insUnits: 1, scale: 1 / 25.4 }) as CircleEntity[];
    expect(back.center.x).toBeCloseTo(254, 6);
    expect(back.radius).toBeCloseTo(25.4, 6);
    expect(back.name).toBe("C1");
  });

  it("survives a full drawing without warnings or skipped types", () => {
    const entities = [line(), circle(), arcCcw(), point(), bulgedClosed(), text()];
    const result = parseDxf(entitiesToDxf2018(entities));
    expect(result.warnings).toEqual([]);
    expect(result.report.skipped).toEqual([]);
  });

  it("tags $MEASUREMENT metric for mm/cm/m and imperial otherwise, omitting it for an unspecified unit", () => {
    expect(entitiesToDxf2018([], { insUnits: 4 })).toContain("9\n$MEASUREMENT\n70\n1\n");
    expect(entitiesToDxf2018([], { insUnits: 1 })).toContain("9\n$MEASUREMENT\n70\n0\n");
    // insUnits=0 means "no real unit" — writing $MEASUREMENT would make our own
    // parser treat it as authoritative and misread the file as inches (see the
    // comment on `header()`), so it's left out entirely.
    expect(entitiesToDxf2018([], { insUnits: 0 })).not.toContain("$MEASUREMENT");
  });
});

describe("X-04: colour", () => {
  it("writes only the ACI fallback (no redundant true colour) for an exact palette match", () => {
    const e: LineEntity = { ...line(), color: "#ff0000" }; // ACI 1, exact
    const text = entitiesToDxf2018([e]);
    expect(text).toContain("\n62\n1\n");
    expect(text).not.toContain("\n420\n");
    const [back] = parseDxf(text).entities as LineEntity[];
    expect(back.color).toBe("#ff0000");
  });

  it("writes both the ACI fallback and an exact true colour (420) for an arbitrary colour", () => {
    const e: CircleEntity = { ...circle(), color: "#5b96ff" };
    const text = entitiesToDxf2018([e]);
    expect(text).toMatch(/\n62\n\d+\n/);
    const trueColorInt = (0x5b << 16) | (0x96 << 8) | 0xff;
    expect(text).toContain(`\n420\n${trueColorInt}\n`);
    // Unlike R12, the AC1032 round trip is lossless: the parser prefers 420 over 62.
    const [back] = parseDxf(text).entities as CircleEntity[];
    expect(back.color).toBe("#5b96ff");
  });

  it("writes nothing (BYLAYER) for an entity with no explicit colour", () => {
    const text = entitiesToDxf2018([line()]);
    const entitySection = text.slice(text.indexOf("0\nLINE"));
    expect(entitySection).not.toMatch(/\n62\n/);
    expect(entitySection).not.toMatch(/\n420\n/);
  });
});

describe("X-04: linetype and lineweight", () => {
  it("writes a handled LTYPE table entry and group 6 for a non-continuous linetype, and round-trips it", () => {
    const e: LineEntity = { ...line(), linetype: "HIDDEN" };
    const text = entitiesToDxf2018([e]);
    expect(text).toMatch(/0\nLTYPE\n5\n[0-9A-F]+\n330\n[0-9A-F]+\n100\nAcDbSymbolTableRecord\n100\nAcDbLinetypeTableRecord\n2\nHIDDEN\n/);
    const entitySection = text.slice(text.indexOf("0\nLINE"));
    expect(entitySection).toContain("6\nHIDDEN\n");
    const [back] = parseDxf(text).entities as LineEntity[];
    expect(back.linetype).toBe("HIDDEN");
  });

  it("writes lineweight as hundredths of a millimetre (group 370) and round-trips it", () => {
    const e: LineEntity = { ...line(), lineweight: 0.25 };
    const text = entitiesToDxf2018([e]);
    const entitySection = text.slice(text.indexOf("0\nLINE"));
    expect(entitySection).toContain("370\n25\n");
    const [back] = parseDxf(text).entities as LineEntity[];
    expect(back.lineweight).toBeCloseTo(0.25, 9);
  });

  it("writes nothing (BYLAYER) for an entity with no explicit linetype/lineweight, but still declares CONTINUOUS", () => {
    const text = entitiesToDxf2018([line()]);
    const entitySection = text.slice(text.indexOf("0\nLINE"));
    expect(entitySection).not.toMatch(/\n6\n/);
    expect(entitySection).not.toMatch(/\n370\n/);
    expect(text).toContain("2\nCONTINUOUS\n");
  });
});

describe("per-entity linetype scale (DXF group 48)", () => {
  /** The common AcDbEntity head of the first LINE record — where group 48 belongs. */
  const lineHead = (text: string): string => {
    const rec = text.slice(text.indexOf("0\nLINE"));
    return rec.slice(0, rec.indexOf("100\nAcDbLine\n"));
  };

  it("writes group 48 in the AcDbEntity head and round-trips it, alongside a linetype", () => {
    const e: LineEntity = { ...line(), linetype: "DASHED", linetypeScale: 2.5 };
    const text = entitiesToDxf2018([e]);
    expect(lineHead(text)).toContain("48\n2.5\n");
    const [back] = parseDxf(text).entities as LineEntity[];
    expect(back.linetype).toBe("DASHED");
    expect(back.linetypeScale).toBeCloseTo(2.5, 9);
  });

  it("writes no group 48 for the default scale, and an entity read back without one has no field at all", () => {
    for (const e of [line(), { ...line(), linetypeScale: 1 }]) {
      const text = entitiesToDxf2018([e]);
      expect(lineHead(text)).not.toMatch(/\n48\n/);
      expect((parseDxf(text).entities[0] as LineEntity).linetypeScale).toBeUndefined();
    }
  });

  it("keeps the scale through every entity type that carries a linetype", () => {
    const back = reimport([
      { ...circle(), linetypeScale: 4 },
      { ...arcCcw(), linetypeScale: 0.5 },
      { ...bulgedClosed(), linetypeScale: 3 },
    ]);
    expect(back.map((e) => e.linetypeScale)).toEqual([4, 0.5, 3]);
  });
});

describe("reading group 48 from other writers", () => {
  const dxfWith = (lineRecord: string): string => `0\nSECTION\n2\nENTITIES\n${lineRecord}0\nENDSEC\n0\nEOF\n`;

  it("reads it from the AcDbEntity subclass, and ignores a group 48 that belongs to another subclass", () => {
    const own = dxfWith("0\nLINE\n5\n2A\n100\nAcDbEntity\n8\n0\n6\nDASHED\n48\n3.0\n100\nAcDbLine\n10\n0\n20\n0\n30\n0\n11\n10\n21\n0\n31\n0\n");
    expect((parseDxf(own).entities[0] as LineEntity).linetypeScale).toBe(3);
    const elsewhere = dxfWith("0\nLINE\n5\n2A\n100\nAcDbEntity\n8\n0\n100\nAcDbLine\n48\n7.0\n10\n0\n20\n0\n30\n0\n11\n10\n21\n0\n31\n0\n");
    expect((parseDxf(elsewhere).entities[0] as LineEntity).linetypeScale).toBeUndefined();
  });

  it("reads it from a marker-less (R12-style) record, and drops a non-positive or garbage value", () => {
    const r12 = (v: string) => dxfWith(`0\nLINE\n8\n0\n48\n${v}\n10\n0\n20\n0\n11\n10\n21\n0\n`);
    expect((parseDxf(r12("0.25")).entities[0] as LineEntity).linetypeScale).toBe(0.25);
    for (const bad of ["0", "-2", "abc"]) expect((parseDxf(r12(bad)).entities[0] as LineEntity).linetypeScale).toBeUndefined();
  });
});
