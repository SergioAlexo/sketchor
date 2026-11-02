/**
 * Why this matters (B-26): AutoCAD drawings full of doors/windows/fasteners are
 * dynamic blocks. The `*U` geometry must always come in right (static), and
 * when the parameter objects map, the block should re-open live with the
 * instance's values. Hostile or partial files must degrade to static + a
 * warning, never throw. Fixtures here are synthetic (authored inline).
 */
import { describe, expect, it } from "vitest";
import { parseDxf } from "../dxf";
import "../kinds/builtin";
import { evaluateDynamic, dynamicSpecOf } from "./dynamic";
import { planDynamicImport } from "./dynamicImport";

type P = [number, string | number];
const rec = (...pairs: P[]): string => pairs.map(([c, v]) => `${c}\n${v}`).join("\n");
const line = (h: string, x1: number, y1: number, x2: number, y2: number): string => rec([0, "LINE"], [5, h], [8, "0"], [10, x1], [20, y1], [30, 0], [11, x2], [21, y2], [31, 0]);
const section = (name: string, body: string[]): string => [rec([0, "SECTION"], [2, name]), ...body, rec([0, "ENDSEC"])].join("\n");

interface Opts {
  withObjects?: boolean;
  props?: P[];
  omitSpecParam?: boolean;
}

/** A 900-wide frame stretched by a linear parameter (geometry beyond x=800 moves), with two visibility states. */
function fixture(o: Opts = {}): string {
  const tables = section("TABLES", [
    rec([0, "TABLE"], [2, "BLOCK_RECORD"]),
    rec([0, "BLOCK_RECORD"], [5, "20"], [102, "{ACAD_XDICTIONARY"], [360, "30"], [102, "}"], [2, "WIN"]),
    rec([0, "BLOCK_RECORD"], [5, "21"], [2, "*U1"], [1001, "AcDbBlockRepBTag"], [1005, "20"]),
    rec([0, "ENDTAB"]),
  ]);
  const blocks = section("BLOCKS", [
    rec([0, "BLOCK"], [2, "WIN"], [10, 0], [20, 0], [30, 0]),
    line("A1", 0, 0, 900, 0),
    line("A2", 900, 0, 900, 100),
    line("A3", 0, 0, 0, 100),
    rec([0, "ENDBLK"]),
    rec([0, "BLOCK"], [2, "*U1"], [10, 0], [20, 0], [30, 0]),
    line("B1", 0, 0, 1300, 0),
    line("B2", 1300, 0, 1300, 100),
    line("B3", 0, 0, 0, 100),
    rec([0, "ENDBLK"]),
  ]);
  const props: P[] = o.props ?? [[1001, "AcDbDynamicBlockReferenceProperty"], [1000, "Width"], [1040, 1300], [1000, "Vis"], [1000, "Closed"]];
  const insert = rec([0, "INSERT"], [5, "90"], [8, "0"], [2, "*U1"], [10, 5000], [20, 0], [30, 0], ...props);
  const entities = section("ENTITIES", [insert]);
  const objects =
    o.withObjects === false
      ? section("OBJECTS", [])
      : section("OBJECTS", [
          rec([0, "DICTIONARY"], [5, "30"], [3, "ACAD_ENHANCEDBLOCK"], [360, "31"]),
          rec([0, "EVALUATION_GRAPH"], [5, "31"], [360, "40"], [360, "41"], [360, "42"], [360, "43"], [360, "44"]),
          rec([0, "BLOCKLINEARPARAMETER"], [5, "40"], [305, "Width"], [1010, 0], [1020, 0], [1030, 0], [1011, 900], [1021, 0], [1031, 0], [140, 600], [141, 1800], [142, 100]),
          rec([0, "BLOCKSTRETCHACTION"], [5, "41"], [301, o.omitSpecParam ? "Nope" : "Width"], [1012, 800], [1022, -50], [1012, 1000], [1022, 150]),
          rec([0, "BLOCKVISIBILITYPARAMETER"], [5, "42"], [305, "Vis"], [303, "Open"], [332, "A1"], [303, "Closed"], [332, "A2"], [332, "A3"]),
          rec([0, "BLOCKFLIPPARAMETER"], [5, "43"], [305, "Flip"], [1010, 0], [1020, 50], [1011, 900], [1021, 50]),
          rec([0, "BLOCKLOOKUPPARAMETER"], [5, "44"], [305, "Sz"]),
        ]);
  return [tables, blocks, entities, objects, rec([0, "EOF"])].join("\n");
}

describe("DXF import of AutoCAD dynamic blocks", () => {
  it("maps parameters, actions and visibility and re-opens the *U state live", () => {
    const r = parseDxf(fixture());
    const def = r.blocks.find((b) => b.name === "WIN")!;
    const spec = dynamicSpecOf(def)!;
    expect(spec.params.map((p) => p.kind)).toEqual(["linear", "visibility", "flip"]);
    expect(spec.actions.map((a) => a.kind)).toEqual(["stretch"]);
    expect(spec.visibilityStates!.map((s) => s.name)).toEqual(["Open", "Closed"]);
    expect(spec.visibilityStates![1].visible).toHaveLength(2); // handles resolved to ids
    const ins = r.entities.find((e) => e.type === "insert")!;
    expect(ins.type === "insert" && ins.block).toBe("WIN");
    expect(ins.type === "insert" && ins.params).toEqual({ Width: 1300, Vis: "Closed" });
    // the live evaluation reproduces the *U geometry's extent
    const body = evaluateDynamic(def, { Width: 1300 });
    const xs = body.flatMap((e) => (e.type === "line" ? [e.a.x, e.b.x] : []));
    expect(Math.max(...xs)).toBeCloseTo(1300, 6);
    expect(r.warnings.some((w) => /lookup/.test(w))).toBe(true);
  });

  it("keeps the *U geometry as a static insert when the instance names no values", () => {
    const r = parseDxf(fixture({ props: [] }));
    expect(r.entities.some((e) => e.type === "insert")).toBe(false);
    const xs = r.entities.flatMap((e) => (e.type === "line" ? [e.a.x, e.b.x] : []));
    expect(Math.max(...xs)).toBeCloseTo(6300, 6);
    expect(r.warnings.some((w) => /static/.test(w))).toBe(true);
  });

  it("without any parameter objects the *U state stays static (no throw)", () => {
    const r = parseDxf(fixture({ withObjects: false }));
    expect(r.entities.some((e) => e.type === "insert")).toBe(false);
    expect(r.blocks.find((b) => b.name === "WIN")!.dynamic).toBeUndefined();
  });

  it("drops an action that names an unknown parameter", () => {
    const r = parseDxf(fixture({ omitSpecParam: true }));
    const spec = dynamicSpecOf(r.blocks.find((b) => b.name === "WIN")!)!;
    expect(spec.actions).toEqual([]);
    expect(r.warnings.some((w) => /unknown parameter/.test(w))).toBe(true);
  });

  it("explode mode ignores dynamic data", () => {
    const r = parseDxf(fixture(), { blocks: "explode" });
    expect(r.blocks).toEqual([]);
    expect(r.entities.length).toBeGreaterThan(0);
  });

  it("malformed input never throws: truncated, garbage and cyclic records", () => {
    const text = fixture();
    for (const cut of [0, 50, 200, 400, 700, 1000, 1500, text.length - 5]) expect(() => parseDxf(text.slice(0, cut))).not.toThrow();
    const pr = (pairs: P[]) => pairs.map(([code, value]) => ({ code, value: String(value) }));
    const plan = planDynamicImport(
      [{ type: "BLOCK_RECORD", pairs: pr([[5, "20"], [2, "WIN"], [102, "{ACAD_XDICTIONARY"], [360, "20"]]) }],
      [
        { type: "DICTIONARY", pairs: pr([[5, "20"], [3, "ACAD_ENHANCEDBLOCK"], [360, "20"]]) },
        { type: "BLOCKLINEARPARAMETER", pairs: pr([[5, "zz"], [1010, "NaN"]]) },
      ],
      1,
    );
    expect(plan.has("WIN")).toBe(false);
    expect(plan.represent("*U1", [], () => {})).toBeNull();
    const nonsense = parseDxf(fixture().replace(/1010\n0/g, "1010\nabc").replace(/\n140\n600/, "\n140\nxx"));
    expect(nonsense.entities.length).toBeGreaterThan(0);
  });
});
