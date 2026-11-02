import { describe, expect, it } from "vitest";
import { SketchDocument } from "./document";
import type { Command } from "./commands";
import { CommandBus } from "./commands";
import { centroidOfEntities, type Entity, type LineEntity } from "./entities";
import { MAX_PATH_STATIONS, pathPatternCommands, pathPatternCopyCount, pathPatternStations, patternCommands, patternCopyCount, type PathPattern, type PatternSpec } from "./pattern";

/**
 * The array/pattern generator — the feature the first-party pattern *plugin*
 * mirrors over the public API (its output must match this exactly). These tests
 * pin the two things that matter: how many copies a spec makes, and that each
 * copy lands at the right offset, leaving the source untouched.
 */

function docWithLine(): { doc: SketchDocument; id: string } {
  const doc = new SketchDocument();
  const line: LineEntity = { id: "src", type: "line", a: { x: 0, y: 0 }, b: { x: 10, y: 0 } };
  doc._put(line);
  return { doc, id: "src" };
}

const added = (cmds: Command[]): LineEntity[] =>
  cmds.map((c) => {
    expect(c.type).toBe("add-entity");
    return (c as Extract<Command, { type: "add-entity" }>).entity as LineEntity;
  });

describe("patternCommands (rectangular)", () => {
  const spec: PatternSpec = { kind: "rectangular", columns: 3, rows: 2, columnSpacing: 50, rowSpacing: 30 };

  it("makes one copy per grid cell except the original", () => {
    const { doc, id } = docWithLine();
    const cmds = patternCommands(doc, [id], spec);
    expect(cmds).toHaveLength(5); // 3×2 = 6 instances, minus the source
    expect(patternCopyCount(spec, 1)).toBe(5);
  });

  it("offsets each copy by its column/row spacing and leaves the source in place", () => {
    const { doc, id } = docWithLine();
    const lines = added(patternCommands(doc, [id], spec));
    // Iteration is column-major, skipping cell (0,0): (0,1),(1,0),(1,1),(2,0),(2,1).
    expect(lines[0].a).toEqual({ x: 0, y: 30 }); // (col 0, row 1)
    expect(lines[1].a).toEqual({ x: 50, y: 0 }); // (col 1, row 0)
    expect(lines[4].a).toEqual({ x: 100, y: 30 }); // (col 2, row 1)
    expect(lines[4].b).toEqual({ x: 110, y: 30 });
    // Copies are genuinely new entities, not the source id.
    expect(lines.every((l) => l.id !== "src")).toBe(true);
  });

  it("produces nothing for an empty selection", () => {
    const { doc } = docWithLine();
    expect(patternCommands(doc, [], spec)).toHaveLength(0);
  });
});

describe("patternCommands (circular)", () => {
  it("spreads count-1 copies around a full turn", () => {
    const { doc, id } = docWithLine();
    const spec: PatternSpec = {
      kind: "circular",
      count: 4,
      center: { x: 0, y: 0 },
      totalAngle: 2 * Math.PI,
      rotateItems: true,
    };
    expect(patternCommands(doc, [id], spec)).toHaveLength(3);
    expect(patternCopyCount(spec, 1)).toBe(3);
  });
});

/**
 * Array along a path (T-35). What breaks in a drawing: a count that lands one
 * copy too many on a closed path (a duplicate stacked on the start), spacing
 * measured along a chord instead of the curve (arcs), copies that do not turn
 * with the path, a part that is not centred on its station, and an undo that
 * leaves some of the copies behind.
 */
describe("pathPatternCommands", () => {
  const P = (x: number, y: number) => ({ x, y });
  const sq = (id: string, cx: number, cy: number): Entity => ({
    id,
    type: "polyline",
    points: [P(cx - 1, cy - 1), P(cx + 1, cy - 1), P(cx + 1, cy + 1), P(cx - 1, cy + 1)],
    closed: true,
  });
  const centre = (e: Entity): { x: number; y: number } => centroidOfEntities([e]);
  const build = (path: Entity, ...sources: Entity[]) => {
    const doc = new SketchDocument();
    doc._put(path);
    for (const s of sources) doc._put(s);
    return doc;
  };
  const copies = (cmds: Command[]): Entity[] => cmds.filter((c) => c.type === "add-entity").map((c) => (c as Extract<Command, { type: "add-entity" }>).entity);
  const lineP: Entity = { id: "path", type: "line", a: P(0, 0), b: P(100, 0) };
  const spec = (over: Partial<PathPattern> = {}): PathPattern => ({ path: "path", mode: "count", count: 5, spacing: 25, align: false, ...over });

  it("count mode spreads stations from the path's start to its end, base point on each", () => {
    const doc = build(lineP, sq("s", 50, 30));
    const out = copies(pathPatternCommands(doc, ["s"], spec()));
    expect(out).toHaveLength(5);
    out.forEach((e, k) => {
      expect(centre(e).x).toBeCloseTo(25 * k, 9);
      expect(centre(e).y).toBeCloseTo(0, 9);
    });
    expect(pathPatternCopyCount(doc, spec(), 1)).toBe(5);
  });

  it("spacing mode places one every `spacing` and includes the end when it lands exactly on it", () => {
    const doc = build(lineP, sq("s", 0, 0));
    expect(copies(pathPatternCommands(doc, ["s"], spec({ mode: "spacing", spacing: 25 })))).toHaveLength(5);
    expect(copies(pathPatternCommands(doc, ["s"], spec({ mode: "spacing", spacing: 30 })))).toHaveLength(4); // 0 30 60 90
  });

  it("startOffset moves the first station along the path", () => {
    const doc = build(lineP, sq("s", 0, 0));
    const out = copies(pathPatternCommands(doc, ["s"], spec({ startOffset: 20, count: 3 })));
    expect(out.map((e) => Math.round(centre(e).x))).toEqual([20, 60, 100]);
  });

  it("a closed path divides by the count: no copy stacked on the start", () => {
    const circle: Entity = { id: "path", type: "circle", center: P(0, 0), radius: 10 };
    const doc = build(circle, sq("s", 10, 0));
    const out = copies(pathPatternCommands(doc, ["s"], spec({ count: 4 })));
    expect(out).toHaveLength(4);
    const pts = out.map((e) => centre(e)).map((p) => `${p.x.toFixed(6)},${p.y.toFixed(6)}`);
    expect(new Set(pts).size).toBe(4);
    for (const e of out) expect(Math.hypot(centre(e).x, centre(e).y)).toBeCloseTo(10, 6);
    // spacing mode on the closed circle: the start is not repeated at the end either
    const byLen = copies(pathPatternCommands(doc, ["s"], spec({ mode: "spacing", spacing: (2 * Math.PI * 10) / 8 })));
    expect(byLen).toHaveLength(8);
  });

  it("measures along the curve, not the chord: equal arc length between stations on an arc", () => {
    const arc: Entity = { id: "path", type: "arc", center: P(0, 0), radius: 20, startAngle: 0, endAngle: Math.PI, ccw: true };
    const doc = build(arc, sq("s", 20, 0));
    const out = copies(pathPatternCommands(doc, ["s"], spec({ mode: "spacing", spacing: 20 * (Math.PI / 4) })));
    expect(out).toHaveLength(5); // 0, 45, 90, 135, 180 degrees
    out.forEach((e, k) => {
      const a = (k * Math.PI) / 4;
      expect(centre(e).x).toBeCloseTo(20 * Math.cos(a), 6);
      expect(centre(e).y).toBeCloseTo(20 * Math.sin(a), 6);
    });
  });

  it("a clockwise arc is walked the other way round", () => {
    const arc: Entity = { id: "path", type: "arc", center: P(0, 0), radius: 20, startAngle: 0, endAngle: -Math.PI / 2, ccw: false };
    const doc = build(arc, sq("s", 20, 0));
    const out = copies(pathPatternCommands(doc, ["s"], spec({ count: 2 })));
    expect(centre(out[1]).x).toBeCloseTo(0, 6);
    expect(centre(out[1]).y).toBeCloseTo(-20, 6);
  });

  it("align turns each copy by how far the path has turned since the first station", () => {
    const L: Entity = { id: "path", type: "polyline", points: [P(0, 0), P(10, 0), P(10, 10)], closed: false };
    const bar: Entity = { id: "s", type: "line", a: P(-1, 0), b: P(1, 0) };
    const doc = build(L, bar);
    const out = copies(pathPatternCommands(doc, ["s"], spec({ count: 3, align: true }))) as LineEntity[];
    // stations: (0,0) heading east, (10,0) at the corner (the next leg: north), (10,10) north
    expect(out[0].b.x - out[0].a.x).toBeCloseTo(2, 9);
    expect(out[2].b.x - out[2].a.x).toBeCloseTo(0, 9);
    expect(out[2].b.y - out[2].a.y).toBeCloseTo(2, 9);
    // without align they all stay horizontal
    for (const e of copies(pathPatternCommands(doc, ["s"], spec({ count: 3 }))) as LineEntity[]) expect(e.b.y - e.a.y).toBeCloseTo(0, 9);
  });

  it("an explicit base point rides the path instead of the centroid", () => {
    const doc = build(lineP, sq("s", 50, 30));
    const out = copies(pathPatternCommands(doc, ["s"], spec({ count: 2, basePoint: P(49, 29) })));
    expect(centre(out[0]).x).toBeCloseTo(1, 9); // the corner sits on the path start
    expect(centre(out[0]).y).toBeCloseTo(1, 9);
  });

  it("leaves the originals alone, or deletes them with replaceSource; the path is never its own source", () => {
    const doc = build(lineP, sq("s", 0, 0));
    expect(pathPatternCommands(doc, ["s"], spec()).some((c) => c.type === "delete-entities")).toBe(false);
    const del = pathPatternCommands(doc, ["s", "path"], spec({ replaceSource: true })).find((c) => c.type === "delete-entities") as Extract<Command, { type: "delete-entities" }>;
    expect(del.ids).toEqual(["s"]);
  });

  it("copies are new entities (fresh ids, no names) and one undo removes them all", () => {
    const doc = build(lineP, { ...sq("s", 0, 0), name: "S1" });
    const bus = new CommandBus(doc);
    const before = doc.all().length;
    bus.execute({ type: "batch", commands: pathPatternCommands(doc, ["s"], spec({ replaceSource: true })) });
    expect(doc.get("s")).toBeUndefined();
    expect(doc.all().length).toBe(before - 1 + 5);
    expect(doc.all().filter((e) => e.name === "S1")).toHaveLength(0);
    bus.undo();
    expect(doc.all().length).toBe(before);
    expect(doc.get("s")).toBeDefined();
  });

  it("nothing for a missing path, a stroke-less path, no source, a bad spacing, or a zero-length path", () => {
    const doc = build(lineP, sq("s", 0, 0), { id: "pt", type: "point", p: P(1, 1) });
    expect(pathPatternCommands(doc, ["s"], spec({ path: "ghost" }))).toEqual([]);
    expect(pathPatternCommands(doc, ["s"], spec({ path: "pt" }))).toEqual([]);
    expect(pathPatternCommands(doc, [], spec())).toEqual([]);
    expect(pathPatternCommands(doc, ["ghost"], spec())).toEqual([]);
    expect(pathPatternCommands(doc, ["s"], spec({ mode: "spacing", spacing: 0 }))).toEqual([]);
    expect(pathPatternCommands(doc, ["s"], spec({ mode: "spacing", spacing: -5 }))).toEqual([]);
    const zero = build({ id: "path", type: "line", a: P(3, 3), b: P(3, 3) }, sq("s", 0, 0));
    expect(pathPatternCommands(zero, ["s"], spec())).toEqual([]);
    expect(pathPatternCopyCount(doc, spec({ path: "ghost" }), 3)).toBe(0);
  });

  it("caps the stations so a tiny spacing cannot freeze the app", () => {
    const doc = build(lineP, sq("s", 0, 0));
    expect(copies(pathPatternCommands(doc, ["s"], spec({ mode: "spacing", spacing: 1e-6 }))).length).toBe(MAX_PATH_STATIONS);
    expect(pathPatternStations({ curves: [{ kind: "segment", a: P(0, 0), b: P(1, 0) }], closed: false }, { mode: "count", count: 1e9, spacing: 0 }).length).toBe(MAX_PATH_STATIONS);
  });

  it("a single station is just the first point", () => {
    const doc = build(lineP, sq("s", 50, 30));
    const out = copies(pathPatternCommands(doc, ["s"], spec({ count: 1, startOffset: 10 })));
    expect(out).toHaveLength(1);
    expect(centre(out[0]).x).toBeCloseTo(10, 9);
  });
});
