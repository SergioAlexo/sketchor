import { describe, expect, it } from "vitest";
import { SketchDocument } from "./document";
import { assignNames, diffToCommands, nextEntityName, parseCode, SKETCH_HEADER, toCode } from "./sketchtext";
import type { Command } from "./commands";
import type { ArcEntity, CircleEntity, Entity, ImageEntity, LineEntity, PointEntity, PolylineEntity } from "./entities";

/**
 * Sketch code is the AI-facing surface: `window.sketchor.toCode()` /
 * `applyCode(text)` run straight through these functions, and `diffToCommands`
 * turns an arbitrary text edit into ordinary undoable commands. Two things
 * matter most — that a round-trip through text doesn't move geometry, and that
 * the diff matches by *name* so an edit updates an entity in place (same id,
 * layer and bulges kept) rather than deleting and re-adding it.
 */

const HALF_PI = Math.PI / 2;

const line = (id: string, name?: string): LineEntity => ({
  id,
  type: "line",
  ...(name ? { name } : {}),
  a: { x: 0, y: 0 },
  b: { x: 100, y: 0 },
});

function docWith(...entities: Entity[]): SketchDocument {
  const doc = new SketchDocument();
  for (const e of entities) doc._put(e);
  return doc;
}

/** Applies `commands` to `doc` the way the command bus would, for idempotence checks. */
function applyAll(doc: SketchDocument, commands: Command[]): void {
  for (const c of commands) {
    if (c.type === "add-entity" || c.type === "update-entity") doc._put(c.entity);
    else if (c.type === "delete-entities") for (const id of c.ids) doc._remove(id);
  }
}

const bodyOf = (text: string): string[] =>
  text
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l !== "" && l !== SKETCH_HEADER);

describe("toCode", () => {
  it("writes a header and one statement per entity", () => {
    const doc = docWith(line("e1", "L1"), { id: "e2", type: "circle", name: "C1", center: { x: 50, y: 25 }, radius: 20 } as CircleEntity);
    const text = toCode(doc);
    expect(text.startsWith(`${SKETCH_HEADER}\n`)).toBe(true);
    expect(text.endsWith("\n")).toBe(true);
    expect(bodyOf(text)).toEqual(["line L1 from (0, 0) to (100, 0)", "circle C1 at (50, 25) r 20"]);
  });

  it("writes arcs in degrees and marks clockwise sweeps", () => {
    const ccw: ArcEntity = { id: "a", type: "arc", name: "A1", center: { x: 0, y: 0 }, radius: 10, startAngle: 0, endAngle: HALF_PI, ccw: true };
    expect(bodyOf(toCode(docWith(ccw)))).toEqual(["arc A1 at (0, 0) r 10 from 0 to 90"]);
    expect(bodyOf(toCode(docWith({ ...ccw, ccw: false })))).toEqual(["arc A1 at (0, 0) r 10 from 0 to 90 cw"]);
  });

  it("writes points and polylines, flagging closed ones", () => {
    const p: PointEntity = { id: "p", type: "point", name: "P1", p: { x: 1, y: 2 } };
    const pl: PolylineEntity = {
      id: "pl",
      type: "polyline",
      name: "PL1",
      points: [{ x: 0, y: 0 }, { x: 5, y: 0 }, { x: 5, y: 5 }],
      closed: true,
    };
    expect(bodyOf(toCode(docWith(p, pl)))).toEqual([
      "point P1 at (1, 2)",
      "polyline PL1 pts (0, 0) (5, 0) (5, 5) closed",
    ]);
    expect(bodyOf(toCode(docWith({ ...pl, closed: false })))).toEqual(["polyline PL1 pts (0, 0) (5, 0) (5, 5)"]);
  });

  it("writes an image's position, size and (when non-zero) rotation, never its pixel data", () => {
    const img: ImageEntity = {
      id: "i",
      type: "image",
      name: "IMG1",
      insert: { x: 1, y: 2 },
      width: 30,
      height: 15,
      rotation: 0,
      dataUrl: "data:image/png;base64,AAAA",
    };
    expect(bodyOf(toCode(docWith(img)))).toEqual(["image IMG1 at (1, 2) 30x15"]);
    expect(bodyOf(toCode(docWith({ ...img, rotation: HALF_PI })))).toEqual(["image IMG1 at (1, 2) 30x15 rot 90"]);
  });

  it("rounds to four decimals and never writes negative zero", () => {
    const e: PointEntity = { id: "p", type: "point", name: "P1", p: { x: 0.123456, y: -0 } };
    expect(bodyOf(toCode(docWith(e)))).toEqual(["point P1 at (0.1235, 0)"]);
  });
});

describe("assignNames / nextEntityName", () => {
  it("keeps explicit names and numbers the rest per type in insertion order", () => {
    const doc = docWith(
      line("e1"),
      { id: "e2", type: "circle", center: { x: 0, y: 0 }, radius: 1 } as CircleEntity,
      line("e3"),
    );
    const names = assignNames(doc);
    expect(names.get("e1")).toBe("L1");
    expect(names.get("e2")).toBe("C1");
    expect(names.get("e3")).toBe("L2");
  });

  it("skips a slot an explicit name has already taken", () => {
    const doc = docWith(line("e1"), line("e2", "L2"), line("e3"));
    const names = assignNames(doc);
    expect(names.get("e1")).toBe("L1");
    expect(names.get("e2")).toBe("L2");
    expect(names.get("e3")).toBe("L3");
  });

  it("offers the first free name for a new entity", () => {
    const doc = docWith(line("e1", "L1"), line("e2", "L3"));
    expect(nextEntityName(doc, "line")).toBe("L2");
    expect(nextEntityName(doc, "circle")).toBe("C1");
    expect(nextEntityName(new SketchDocument(), "polyline")).toBe("PL1");
  });
});

describe("parseCode round-trip", () => {
  it("reproduces every entity type's geometry through text", () => {
    const doc = docWith(
      { ...line("e1", "L1"), b: { x: 12.5, y: -7.25 } },
      { id: "e2", type: "circle", name: "C1", center: { x: 50, y: 25 }, radius: 20 } as CircleEntity,
      { id: "e3", type: "arc", name: "A1", center: { x: -3, y: 4 }, radius: 10, startAngle: 0, endAngle: HALF_PI, ccw: false } as ArcEntity,
      { id: "e4", type: "point", name: "P1", p: { x: 1.5, y: -2.5 } } as PointEntity,
      { id: "e5", type: "polyline", name: "PL1", points: [{ x: 0, y: 0 }, { x: 5, y: 0 }, { x: 5, y: 5 }], closed: true } as PolylineEntity,
    );

    const { entities, errors } = parseCode(toCode(doc));
    expect(errors).toEqual([]);
    expect(entities.map((e) => e.name)).toEqual(["L1", "C1", "A1", "P1", "PL1"]);

    const [l, c, a, p, pl] = entities;
    expect(l).toMatchObject({ type: "line", a: { x: 0, y: 0 }, b: { x: 12.5, y: -7.25 } });
    expect(c).toMatchObject({ type: "circle", center: { x: 50, y: 25 }, radius: 20 });
    expect(a).toMatchObject({ type: "arc", center: { x: -3, y: 4 }, radius: 10, ccw: false });
    expect((a as { startAngle: number }).startAngle).toBeCloseTo(0, 10);
    expect((a as { endAngle: number }).endAngle).toBeCloseTo(HALF_PI, 10);
    expect(p).toMatchObject({ type: "point", p: { x: 1.5, y: -2.5 } });
    expect(pl).toMatchObject({ type: "polyline", closed: true });
    expect((pl as { points: unknown }).points).toEqual([{ x: 0, y: 0 }, { x: 5, y: 0 }, { x: 5, y: 5 }]);
  });
});

describe("parseCode acceptances", () => {
  it("ignores the header, blank lines and # comments", () => {
    const { entities, errors } = parseCode(`${SKETCH_HEADER}\n\n# a comment\n\nline L1 from (0, 0) to (1, 1)\n`);
    expect(errors).toEqual([]);
    expect(entities).toHaveLength(1);
  });

  it("accepts signed, decimal and scientific numbers, and loose spacing", () => {
    const { entities, errors } = parseCode("line  L1  from ( -1.5 , +2 )  to ( 1e2 , .5 )");
    expect(errors).toEqual([]);
    expect(entities[0]).toMatchObject({ a: { x: -1.5, y: 2 }, b: { x: 100, y: 0.5 } });
  });

  it("tolerates CRLF line endings", () => {
    const { entities, errors } = parseCode(`${SKETCH_HEADER}\r\nline L1 from (0, 0) to (1, 1)\r\n`);
    expect(errors).toEqual([]);
    expect(entities).toHaveLength(1);
  });

  it("returns nothing for empty text", () => {
    expect(parseCode("")).toEqual({ entities: [], errors: [] });
  });
});

describe("parseCode rejections", () => {
  const firstError = (text: string) => parseCode(text).errors[0];

  it("reserves the parametric keywords with the offending line number", () => {
    const text = `${SKETCH_HEADER}\nline L1 from (0, 0) to (1, 1)\nparam width = 40`;
    const err = firstError(text);
    expect(err.line).toBe(3);
    expect(err.message).toContain("reserved for the parametric layer");
    for (const kw of ["constraint tangent L1 C1", "dim L1 length = 5"]) {
      expect(firstError(kw).message).toContain("reserved");
    }
    // The valid statement alongside it still parses.
    expect(parseCode(text).entities).toHaveLength(1);
  });

  it("names an unknown statement", () => {
    expect(firstError("rectangle R1 at (0, 0)").message).toBe("unknown statement 'rectangle'");
  });

  it("explains the expected form of a malformed statement", () => {
    expect(firstError("line L1 from (0, 0)").message).toContain("line NAME from (x, y) to (x, y)");
    expect(firstError("circle C1 at (0, 0)").message).toContain("circle NAME at (x, y) r RADIUS");
    expect(firstError("arc A1 at (0, 0) r 5").message).toContain("arc NAME at (x, y) r RADIUS from DEG to DEG [cw]");
    expect(firstError("point P1").message).toContain("point NAME at (x, y)");
    expect(firstError("polyline PL1").message).toContain("polyline NAME pts (x, y) (x, y) ... [closed]");
  });

  it("rejects a non-positive radius", () => {
    expect(firstError("circle C1 at (0, 0) r 0").message).toBe("circle radius must be positive");
    expect(firstError("circle C1 at (0, 0) r -3").message).toBe("circle radius must be positive");
    expect(firstError("arc A1 at (0, 0) r -3 from 0 to 90").message).toBe("arc radius must be positive");
  });

  it("rejects a polyline with fewer than two points", () => {
    expect(firstError("polyline PL1 pts (0, 0)").message).toBe("polyline needs at least 2 points");
  });

  it("rejects a duplicate name and keeps the first definition", () => {
    const { entities, errors } = parseCode("line L1 from (0, 0) to (1, 1)\nline L1 from (5, 5) to (6, 6)");
    expect(errors).toEqual([{ line: 2, message: "duplicate name 'L1'" }]);
    expect(entities).toHaveLength(1);
    expect(entities[0]).toMatchObject({ a: { x: 0, y: 0 } });
  });

  it("reports every bad line and still returns the good ones", () => {
    const { entities, errors } = parseCode(
      `${SKETCH_HEADER}\nline L1 from (0, 0) to (1, 1)\nnonsense\ncircle C1 at (0, 0) r 5\nalso bad`,
    );
    expect(entities.map((e) => e.name)).toEqual(["L1", "C1"]);
    expect(errors.map((e) => e.line)).toEqual([3, 5]);
  });
});

describe("diffToCommands", () => {
  it("produces nothing when named entities come back unchanged", () => {
    const doc = docWith(line("e1", "L1"), { id: "e2", type: "circle", name: "C1", center: { x: 1, y: 2 }, radius: 3 } as CircleEntity);
    expect(diffToCommands(doc, parseCode(toCode(doc)).entities)).toEqual([]);
  });

  it("stamps an auto-assigned name onto an unnamed entity once, then settles", () => {
    // Unnamed entities are displayed as L1/C1/...; re-applying the code the
    // view showed writes that display name back, and is a no-op thereafter.
    const doc = docWith(line("e1"));
    const first = diffToCommands(doc, parseCode(toCode(doc)).entities);
    expect(first).toHaveLength(1);
    expect(first[0]).toMatchObject({ type: "update-entity", entity: { id: "e1", name: "L1", a: { x: 0, y: 0 } } });

    applyAll(doc, first);
    expect(diffToCommands(doc, parseCode(toCode(doc)).entities)).toEqual([]);
  });

  it("updates in place, keeping the entity's id", () => {
    const doc = docWith(line("e1", "L1"));
    const cmds = diffToCommands(doc, parseCode("line L1 from (0, 0) to (250, 0)").entities);
    expect(cmds).toHaveLength(1);
    expect(cmds[0]).toMatchObject({ type: "update-entity", entity: { id: "e1", b: { x: 250, y: 0 } } });
  });

  it("carries colour, fill, linetype, lineweight, linetype scale and construction through a code-driven geometry edit (Z-04)", () => {
    // None of these are expressible in sketch code, so a text edit that only
    // changes the endpoint must not silently drop them (CLAUDE.md's rule for
    // any new entity field the DSL can't express).
    const doc = docWith({
      ...line("e1", "L1"),
      color: "#ff0000",
      linetype: "CENTER",
      lineweight: 0.5,
      linetypeScale: 4,
      construction: true,
    });
    const cmds = diffToCommands(doc, parseCode("line L1 from (0, 0) to (250, 0)").entities);
    expect(cmds).toHaveLength(1);
    expect(cmds[0]).toMatchObject({
      type: "update-entity",
      entity: { id: "e1", b: { x: 250, y: 0 }, color: "#ff0000", linetype: "CENTER", lineweight: 0.5, linetypeScale: 4, construction: true },
    });
  });

  it("adds an entity for a name the document doesn't have", () => {
    const doc = docWith(line("e1", "L1"));
    const cmds = diffToCommands(doc, parseCode("line L1 from (0, 0) to (100, 0)\ncircle C1 at (5, 5) r 2").entities);
    expect(cmds).toHaveLength(1);
    expect(cmds[0].type).toBe("add-entity");
    const added = (cmds[0] as Extract<Command, { type: "add-entity" }>).entity;
    expect(added).toMatchObject({ type: "circle", name: "C1", radius: 2 });
    expect(added.id).not.toBe("e1");
  });

  it("collects every dropped name into a single delete", () => {
    const doc = docWith(line("e1", "L1"), line("e2", "L2"), line("e3", "L3"));
    const cmds = diffToCommands(doc, parseCode("line L2 from (0, 0) to (100, 0)").entities);
    expect(cmds).toEqual([{ type: "delete-entities", ids: ["e1", "e3"] }]);
  });

  it("produces nothing at all for empty code against an empty document", () => {
    expect(diffToCommands(new SketchDocument(), [])).toEqual([]);
  });

  it("preserves the layer, which sketch code doesn't express", () => {
    const doc = docWith({ ...line("e1", "L1"), layer: "walls" });
    const cmds = diffToCommands(doc, parseCode("line L1 from (0, 0) to (250, 0)").entities);
    expect(cmds[0]).toMatchObject({ type: "update-entity", entity: { layer: "walls" } });
  });

  it("preserves a polyline's bulges across an edit", () => {
    const pl: PolylineEntity = {
      id: "e1",
      type: "polyline",
      name: "PL1",
      points: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }],
      bulges: [0, 0.5, 0],
      closed: true,
    };
    const cmds = diffToCommands(docWith(pl), parseCode("polyline PL1 pts (0, 0) (20, 0) (20, 20) closed").entities);
    expect(cmds[0]).toMatchObject({
      type: "update-entity",
      entity: { id: "e1", bulges: [0, 0.5, 0], points: [{ x: 0, y: 0 }, { x: 20, y: 0 }, { x: 20, y: 20 }] },
    });
  });

  it("preserves an image's pixel data across a position/size edit", () => {
    const img: ImageEntity = {
      id: "e1",
      name: "IMG1",
      type: "image",
      insert: { x: 0, y: 0 },
      width: 10,
      height: 10,
      rotation: 0,
      dataUrl: "data:image/png;base64,AAAA",
    };
    const cmds = diffToCommands(docWith(img), parseCode("image IMG1 at (5, 5) 20x20").entities);
    expect(cmds[0]).toMatchObject({
      type: "update-entity",
      entity: { id: "e1", insert: { x: 5, y: 5 }, width: 20, height: 20, dataUrl: "data:image/png;base64,AAAA" },
    });
  });

  it("ignores a new `image` line — sketch code has no way to author pixel data, so nothing is created", () => {
    const doc = docWith(line("e1", "L1"));
    const cmds = diffToCommands(doc, parseCode("line L1 from (0, 0) to (100, 0)\nimage IMG1 at (0, 0) 10x10").entities);
    expect(cmds).toEqual([]);
  });

  it("straightens a bulged polyline that arrives as a new entity (the documented lossiness)", () => {
    const pl: PolylineEntity = {
      id: "e1",
      type: "polyline",
      name: "PL1",
      points: [{ x: 0, y: 0 }, { x: 10, y: 0 }],
      bulges: [1],
      closed: false,
    };
    // Round-tripping the text into a document that has never seen PL1: bulge
    // isn't expressible in code, so the copy comes back straight.
    const cmds = diffToCommands(new SketchDocument(), parseCode(toCode(docWith(pl))).entities);
    const added = (cmds[0] as Extract<Command, { type: "add-entity" }>).entity as PolylineEntity;
    expect(added.bulges).toBeUndefined();
    expect(added.points).toEqual(pl.points);
  });

  it("mixes add, update and delete in one edit", () => {
    const doc = docWith(line("e1", "L1"), line("e2", "L2"));
    const cmds = diffToCommands(doc, parseCode("line L1 from (0, 0) to (5, 5)\npoint P1 at (9, 9)").entities);
    expect(cmds.map((c) => c.type)).toEqual(["update-entity", "add-entity", "delete-entities"]);
    expect(cmds[2]).toEqual({ type: "delete-entities", ids: ["e2"] });
  });
});
