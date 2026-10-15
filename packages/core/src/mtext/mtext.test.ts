/**
 * Why this matters: MTEXT is the rich text of every drawing. A parser that
 * drops a code, a layout that wraps differently from the box it reports, or a
 * kind that cannot be moved/scaled/exported silently corrupts annotations.
 */
import { describe, expect, it } from "vitest";
import type { MTextEntity } from "../entities";
import { explodeDimensions } from "../dimensions/explode";
import "../kinds/builtin";
import { getKind } from "../kinds/registry";
import { parseCode, toCode, diffToCommands } from "../sketchtext";
import { SketchDocument } from "../document";
import { entitiesToDxf } from "../dxfExport";
import { entitiesToSvgDocument } from "../svg";
import { layoutMText } from "./layout";
import { mtextPlain, parseMtext, serializeMtext } from "./parse";
import { explodeMText } from "./explode";

const mt = (over: Partial<MTextEntity> = {}): MTextEntity => ({
  id: "m1",
  type: "mtext",
  at: { x: 10, y: 20 },
  width: 0,
  attachment: 1,
  text: "Hello",
  height: 2,
  rotation: 0,
  ...over,
});

describe("MTEXT codes", () => {
  it("reads formatting, paragraphs, stacks and symbols", () => {
    const p = parseMtext("{\\fArial|b1|i0;Bold}\\PNext \\L under\\l %%c10 \\S1/2; \\U+00B1");
    expect(p).toHaveLength(2);
    expect(p[0].runs[0]).toMatchObject({ kind: "text", text: "Bold", fmt: { bold: true, font: "Arial" } });
    expect(mtextPlain("a\\Pb")).toBe("a\nb");
    expect(mtextPlain("%%c10 \\U+00B1 \\~x")).toBe("\u00d810 \u00b1 \u00a0x");
    expect(mtextPlain("\\S1/2;")).toBe("1/2");
    const stack = p[1].runs.find((r) => r.kind === "stack");
    expect(stack).toMatchObject({ top: "1", bottom: "2", bar: "/" });
  });

  it("round-trips parse -> serialize -> parse", () => {
    const src = "{\\fArial|b1|i1|c0|p0;\\C1;Hi}\\P{\\H2x;big} \\Sa#b; \\c255;\\\\ \\{ x\\}";
    const once = parseMtext(src);
    expect(parseMtext(serializeMtext(once))).toEqual(once);
  });

  it("survives malformed input without throwing", () => {
    for (const bad of ["", "\\", "\\C", "\\C;", "{", "}}}", "\\S/;", "\\Sno bar;", "\\H;x", "\\U+12", "%%", "{\\L{\\O", "\\f", "\\q\\z"]) {
      expect(() => parseMtext(bad)).not.toThrow();
      expect(() => layoutMText(mt({ text: bad }))).not.toThrow();
    }
  });
});

describe("MTEXT layout", () => {
  it("wraps at the box width and never exceeds it", () => {
    const e = mt({ text: "aaa bbb ccc ddd eee", width: 12 });
    const lay = layoutMText(e);
    const lines = new Set(lay.runs.map((r) => r.at.y));
    expect(lines.size).toBeGreaterThan(1);
    expect(lay.width).toBe(12);
    const unwrapped = layoutMText(mt({ text: "aaa bbb ccc ddd eee" }));
    expect(new Set(unwrapped.runs.map((r) => r.at.y)).size).toBe(1);
  });

  it("starts a new line per paragraph and honours attachment", () => {
    const top = layoutMText(mt({ text: "a\\Pb", attachment: 1 }));
    expect(top.runs[0].at.y).toBeLessThan(20);
    expect(top.runs[0].at.y).toBeGreaterThan(top.runs[1].at.y);
    const bottom = layoutMText(mt({ text: "a\\Pb", attachment: 7 }));
    expect(Math.min(...bottom.box.map((p) => p.y))).toBeCloseTo(20, 6);
    const right = layoutMText(mt({ attachment: 3 }));
    expect(Math.max(...right.box.map((p) => p.x))).toBeCloseTo(10, 6);
    const mid = layoutMText(mt({ attachment: 5 }));
    expect((Math.min(...mid.box.map((p) => p.y)) + Math.max(...mid.box.map((p) => p.y))) / 2).toBeCloseTo(20, 6);
  });

  it("draws underline and fraction bars as segments, an empty text as a box", () => {
    expect(layoutMText(mt({ text: "\\Lunder\\l" })).lines).toHaveLength(1);
    expect(layoutMText(mt({ text: "\\S1/2;" })).lines).toHaveLength(1);
    expect(layoutMText(mt({ text: "\\S1^2;" })).lines).toHaveLength(0);
    const empty = layoutMText(mt({ text: "" }));
    expect(empty.runs).toHaveLength(0);
    expect(empty.box).toHaveLength(4);
  });

  it("rotates about the insertion point", () => {
    const a = layoutMText(mt({ rotation: Math.PI / 2, text: "ab" }));
    expect(a.runs[0].rotation).toBeCloseTo(Math.PI / 2, 9);
    expect(a.runs[0].at.x).toBeCloseTo(10 + 2, 6); // first baseline sits 'height' below the top; rotated 90 deg it is to the right
  });
});

describe("MTEXT kind", () => {
  const kind = getKind("mtext")!;
  it("tessellates to the box and bounds contain it", () => {
    const e = mt({ text: "abc\\Pdef", width: 10 });
    const runs = kind.tessellate(e, 0.1);
    const b = kind.bounds!(e)!;
    for (const p of runs.flat()) {
      expect(p.x).toBeGreaterThanOrEqual(b.minX - 1e-9);
      expect(p.y).toBeLessThanOrEqual(b.maxY + 1e-9);
    }
  });

  it("transforms by a similarity and refuses a mirror", () => {
    const e = mt({ width: 8 });
    const t = kind.transform!(e, [2, 0, 0, 2, 5, 0]) as MTextEntity;
    expect(t).toMatchObject({ at: { x: 25, y: 40 }, height: 4, width: 16, id: "m1" });
    expect(kind.transform!(e, [-1, 0, 0, 1, 0, 0])).toBeNull();
  });

  it("hit-tests inside the box and moves/resizes by grips", () => {
    const e = mt({ text: "hello", width: 20 });
    expect(kind.hitDistance!(e, { x: 12, y: 18 })).toBe(0);
    expect(kind.hitDistance!(e, { x: 100, y: 100 })).toBeGreaterThan(50);
    const grips = kind.grips!(e);
    expect(grips).toHaveLength(2);
    const moved = kind.applyGrip!(e, grips[0], { x: 0, y: 0 }) as MTextEntity;
    expect(moved.at).toEqual({ x: 0, y: 0 });
    const wide = kind.applyGrip!(e, grips[1], { x: 40, y: 18 }) as MTextEntity;
    expect(wide.width).toBeCloseTo(30, 9);
    expect(kind.grips!(mt())).toHaveLength(1);
  });
});

describe("MTEXT through writers", () => {
  it("explodes to text runs + decoration lines + background", () => {
    const e = mt({ text: "A \\Lb\\l", background: { color: "#ffff00" } });
    const parts = explodeMText(e);
    expect(parts.some((p) => p.type === "hatch")).toBe(true);
    expect(parts.filter((p) => p.type === "text").length).toBeGreaterThan(0);
    expect(parts.some((p) => p.type === "polyline")).toBe(true);
    expect(explodeDimensions([e]).every((p) => p.type !== "mtext")).toBe(true);
  });

  it("appears in R12 DXF and SVG as the visible text", () => {
    const e = mt({ text: "Wrap me please", width: 15 });
    const dxf = entitiesToDxf([e]);
    expect(dxf).toContain("TEXT");
    expect(dxf).toContain("Wrap");
    expect(dxf).not.toContain("MTEXT");
    expect(entitiesToSvgDocument([e])).toContain("Wrap");
  });

  it("round-trips sketch code and keeps style/spacing on edit", () => {
    const e = mt({ text: "a\\Pb {\\C1;x}", width: 9, attachment: 5, rotation: Math.PI / 2, style: "Notes", lineSpacing: 1.5 });
    const doc = new SketchDocument();
    doc._put(e);
    const code = toCode(doc);
    expect(code).toContain("mtext");
    const parsed = parseCode(code);
    expect(parsed.errors).toEqual([]);
    const edited = code.replace("h 2", "h 3");
    const cmds = diffToCommands(doc, parseCode(edited).entities);
    const upd = cmds.find((c) => c.type === "update-entity");
    expect(upd).toBeTruthy();
    const u = (upd as { entity: MTextEntity }).entity;
    expect(u).toMatchObject({ id: "m1", height: 3, width: 9, attachment: 5, style: "Notes", lineSpacing: 1.5, text: e.text });
  });
});
