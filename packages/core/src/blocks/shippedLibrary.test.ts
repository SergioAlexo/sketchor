/**
 * Why this matters (B-23): the shipped library is the first thing a user
 * drops into a drawing. A lookup row that mis-sizes a section, or a title
 * block whose border does not match its sheet size, is a wrong drawing that
 * looks right. Every block must evaluate cleanly in every state and every
 * lookup row must land on the nominal size it names.
 */
import { describe, expect, it } from "vitest";
import { boundsOf, parseDxf } from "../dxf";
import { entitiesToDxf2018 } from "../dxfw";
import "../kinds/builtin";
import { dynamicSpecOf, evaluateDynamic, type ParamValues } from "./dynamic";
import { FASTENER_SIZES, SHEET_SIZES, SHIPPED_CATEGORY, shippedBlocks, shippedLibrary } from "./shippedLibrary";

const byName = (n: string) => shippedBlocks().find((b) => b.name === n)!;
const size = (n: string, values: ParamValues) => {
  const b = boundsOf(evaluateDynamic(byName(n), values))!;
  return { w: b.maxX - b.minX, h: b.maxY - b.minY, ...b };
};

describe("shipped dynamic block library", () => {
  it("every block has a unique name, a category, unique entity ids and a valid spec", () => {
    const blocks = shippedBlocks();
    expect(new Set(blocks.map((b) => b.name)).size).toBe(blocks.length);
    for (const b of blocks) {
      expect(SHIPPED_CATEGORY[b.name], b.name).toBeTruthy();
      expect(dynamicSpecOf(b), b.name).toBeDefined();
      expect(new Set(b.entities.map((e) => e.id)).size, b.name).toBe(b.entities.length);
    }
    expect(shippedLibrary()).toHaveLength(blocks.length);
  });

  it("evaluates to finite geometry at defaults, in every visibility state and every lookup row", () => {
    for (const b of shippedBlocks()) {
      const spec = dynamicSpecOf(b)!;
      const cases: ParamValues[] = [{}];
      for (const s of spec.visibilityStates ?? []) for (const p of spec.params) if (p.kind === "visibility") cases.push({ [p.name]: s.name });
      for (const t of spec.lookup ?? []) for (const p of spec.params) if (p.kind === "lookup" && p.table === t.name) for (const r of t.rows) cases.push({ [p.name]: r.label });
      for (const p of spec.params) if (p.kind === "flip") cases.push({ [p.name]: 1 });
      for (const v of cases) {
        const body = evaluateDynamic(b, v);
        expect(body.length, `${b.name} ${JSON.stringify(v)}`).toBeGreaterThan(0);
        const bb = boundsOf(body)!;
        expect([bb.minX, bb.minY, bb.maxX, bb.maxY].every(Number.isFinite), `${b.name} ${JSON.stringify(v)}`).toBe(true);
      }
    }
  });

  it("I-beam, HSS and angle rows come out at their nominal dimensions", () => {
    for (const [label, H, B] of [["I-100", 100, 55], ["I-300", 300, 150], ["I-400", 400, 180]] as const) {
      const s = size("SK_BEAM_I", { Size: label });
      expect([s.h, s.w]).toEqual([expect.closeTo(H, 6), expect.closeTo(B, 6)]);
      expect(s.minX + s.maxX).toBeCloseTo(0, 6); // stays centred
    }
    for (const [label, H, B] of [["HSS 40x40x3", 40, 40], ["HSS 200x100x6", 200, 100]] as const) {
      const s = size("SK_HSS", { Size: label });
      expect([s.h, s.w]).toEqual([expect.closeTo(H, 6), expect.closeTo(B, 6)]);
    }
    for (const [label, A, B] of [["L50x50x5", 50, 50], ["L125x75x8", 125, 75], ["L150x100x12", 150, 100]] as const) {
      const s = size("SK_ANGLE", { Size: label });
      expect([s.w, s.h]).toEqual([expect.closeTo(A, 6), expect.closeTo(B, 6)]);
    }
    // wall thickness: the I-200 web is 5.6 wide (distinct points at x = +-2.8)
    const poly = evaluateDynamic(byName("SK_BEAM_I"), { Size: "I-200" })[0];
    expect(poly.type === "polyline" && poly.points.some((p) => Math.abs(p.x - 2.8) < 1e-6)).toBe(true);
  });

  it("sheet size rows match the nominal sheet; the title box stays at the origin", () => {
    for (const s of SHEET_SIZES) {
      const r = size("SK_TITLE_BLOCK", { Sheet: s.label });
      expect([r.w, r.h]).toEqual([expect.closeTo(s.w, 6), expect.closeTo(s.h, 6)]);
      expect(r.maxX).toBeCloseTo(0, 6);
      expect(r.minY).toBeCloseTo(0, 6);
    }
    const a0 = evaluateDynamic(byName("SK_TITLE_BLOCK"), { Sheet: "A0" });
    const box = a0.find((e) => e.id === "box")!;
    expect(box.type === "polyline" && Math.min(...box.points.map((p) => p.x))).toBeCloseTo(-190, 6);
    expect(byName("SK_TITLE_BLOCK").attributeDefs.map((a) => a.tag)).toContain("DWG_NO");
  });

  it("fasteners scale with the table and the length stays a multiple of the diameter", () => {
    const m10 = size("SK_BOLT_HEX", { Size: "M10" });
    const m20 = size("SK_BOLT_HEX", { Size: "M20" });
    expect(m20.h / m10.h).toBeCloseTo(2, 6);
    expect(FASTENER_SIZES.length).toBeGreaterThanOrEqual(20);
    // M10, length 8d: the shank tip sits 8d past the head face (head thickness 0.7d)
    const long = evaluateDynamic(byName("SK_BOLT_HEX"), { Size: "M10", Length: 8 });
    const tip = long.find((e) => e.id === "tip")!;
    expect(tip.type === "line" && tip.a.x).toBeCloseTo(7 + 80, 6);
    const m5 = evaluateDynamic(byName("SK_BOLT_HEX"), { Size: "M5", Length: 8 }).find((e) => e.id === "tip")!;
    expect(m5.type === "line" && m5.a.x).toBeCloseTo((7 + 80) / 2, 6);
    const w = size("SK_WASHER", { Size: "M12" });
    expect(w.w).toBeCloseTo(24, 6);
  });

  it("door: width scales, types show their own leaves, hinge flip mirrors", () => {
    const ids = (v: ParamValues) => evaluateDynamic(byName("SK_DOOR"), v).map((e) => e.id);
    expect(ids({ Type: "Single" })).toContain("leafS");
    expect(ids({ Type: "Single" })).not.toContain("leafDL");
    expect(ids({ Type: "Double" })).toContain("leafDR");
    expect(ids({ Type: "Sliding" })).toContain("slideB");
    const w1200 = size("SK_DOOR", { Type: "Single", Width: 1200 });
    expect(w1200.maxX - w1200.minX).toBeGreaterThan(size("SK_DOOR", { Type: "Single", Width: 900 }).w);
    const flipped = evaluateDynamic(byName("SK_DOOR"), { Type: "Single", Hinge: 1 }).find((e) => e.id === "leafS")!;
    expect(flipped.type === "line" && flipped.a.x).toBeCloseTo(900, 6);
  });

  it("B-27 round trip: the whole library through AC1032 DXF comes back with identical specs and the same evaluated geometry", () => {
    const defs = shippedBlocks();
    const back = parseDxf(entitiesToDxf2018([], { blocks: defs }));
    for (const d of defs) {
      const b = back.blocks.find((x) => x.name === d.name)!;
      expect(dynamicSpecOf(b), d.name).toEqual(dynamicSpecOf(d));
      expect(b.attributeDefs.map((a) => a.tag), d.name).toEqual(d.attributeDefs.map((a) => a.tag));
    }
    const a = boundsOf(evaluateDynamic(back.blocks.find((x) => x.name === "SK_BEAM_I")!, { Size: "I-300" }))!;
    const o = boundsOf(evaluateDynamic(byName("SK_BEAM_I"), { Size: "I-300" }))!;
    expect(a.maxY - a.minY).toBeCloseTo(o.maxY - o.minY, 4);
  });

  it("window width stretches and the mullion stays centred", () => {
    const body = evaluateDynamic(byName("SK_WINDOW"), { Type: "With mullion", Width: 1500 });
    const mull = body.find((e) => e.id === "mullion")!;
    expect(mull.type === "line" && mull.a.x).toBeCloseTo(750, 6);
    expect(boundsOf(body)!.maxX).toBeCloseTo(1500, 6);
  });
});
