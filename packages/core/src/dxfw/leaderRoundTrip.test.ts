/**
 * D-10 (LEADER / MULTILEADER): what breaks in a user's drawing if this
 * regresses - callouts turning into loose lines on save/open, a leader's text
 * coming back as a second, separate note, balloons or extra leader lines lost,
 * a file in inches whose leader comes back 25.4x off, and foreign leaders (read
 * from other CAD) importing as nothing at all.
 */
import { describe, expect, it } from "vitest";
import { parseDxf } from "../dxf";
import { entitiesToDxf } from "../dxfExport";
import { leaderFromRecord, mleaderFromRecord } from "../dimensions/dxfLeader";
import { layoutOf } from "../dimensions/resolve";
import { addLeaderLine, buildLeader } from "../dimensions/leaderOps";
import type { DimensionEntity, Entity } from "../entities";
import "../kinds/builtin";
import { entitiesToDxf2018 } from "./index";

const P = (x: number, y: number) => ({ x, y });
const L = (extra: Partial<DimensionEntity> = {}): DimensionEntity => ({
  ...buildLeader([P(0, 0), P(10, 10), P(20, 10)], { text: "SEE NOTE 4" }, { id: "ld1", layer: "Notes" })!,
  ...extra,
});
const back = (e: Entity[], opts: Parameters<typeof entitiesToDxf2018>[1] = {}) => parseDxf(entitiesToDxf2018(e, opts)).entities;
const pairsOf = (...p: [number, string | number][]) => p.map(([code, value]) => ({ code, value: String(value) }));

describe("LEADER in AC1032", () => {
  it("writes a real LEADER with an associated MTEXT, and reads back one leader (not leader + note)", () => {
    const dxf = entitiesToDxf2018([L()]);
    expect(dxf).toContain("\nLEADER\n");
    expect(dxf).toContain("AcDbLeader");
    expect(dxf).not.toContain("MULTILEADER");
    const out = back([L()]);
    expect(out.length).toBe(1);
    const d = out[0] as DimensionEntity;
    expect(d.type).toBe("dimension");
    expect(d.kind).toBe("leader");
    expect(d.id).toBe("ld1");
    expect(d.layer).toBe("Notes");
    expect(d.defPoints).toEqual([P(0, 0), P(10, 10), P(20, 10)]);
    expect(d.textOverride).toBe("SEE NOTE 4");
  });

  it("keeps spline, landing and an empty leader (no annotation record)", () => {
    const e = L({ leaderSpline: true, landing: 0, textOverride: undefined });
    const dxf = entitiesToDxf2018([e]);
    expect(dxf).not.toContain("MTEXT");
    const d = back([e])[0] as DimensionEntity;
    expect(d.leaderSpline).toBe(true);
    expect(d.landing).toBe(0);
    expect(d.textOverride).toBeUndefined();
  });

  it("redraws the same geometry after a round trip", () => {
    const d = back([L()])[0] as DimensionEntity;
    expect(layoutOf(d).lines).toEqual(layoutOf(L()).lines);
    expect(layoutOf(d).text?.text).toBe("SEE NOTE 4");
  });

  it("converts units: the same leader in an inch file comes back at the same size", () => {
    const e = L({ id: "ld2" });
    const d = back([e], { insUnits: 1, scale: 1 / 25.4 })[0] as DimensionEntity;
    const l0 = layoutOf(L({ id: "ld2" }));
    const l1 = layoutOf(d);
    expect(l1.text!.height).toBeCloseTo(l0.text!.height, 4);
    expect(l1.text!.at.x).toBeCloseTo(l0.text!.at.x, 3);
  });
});

describe("MULTILEADER in AC1032", () => {
  const ML = (): DimensionEntity => ({ ...addLeaderLine(L({ id: "ml1", balloon: "hexagon", textOverride: "12" }), P(0, 25)) });

  it("writes MULTILEADER + the MLEADERSTYLE it points at for branches and balloons", () => {
    const dxf = entitiesToDxf2018([ML()]);
    expect(dxf).toContain("\nMULTILEADER\n");
    expect(dxf).toContain("CONTEXT_DATA{");
    expect(dxf.match(/LEADER_LINE\{/g)?.length).toBe(2);
    expect(dxf).toContain("ACAD_MLEADERSTYLE");
    expect(dxf).toContain("\nMLEADERSTYLE\n");
    const style = /0\nMLEADERSTYLE\n5\n([0-9A-F]+)\n/.exec(dxf)![1];
    expect(dxf).toContain(`340\n${style}\n`);
  });

  it("round trips branches, balloon shape and content exactly", () => {
    const out = back([ML()]);
    expect(out.length).toBe(1);
    const d = out[0] as DimensionEntity;
    expect(d.kind).toBe("leader");
    expect(d.balloon).toBe("hexagon");
    expect(d.textOverride).toBe("12");
    expect(d.branches).toEqual([[P(0, 25)]]);
    expect(d.defPoints).toEqual(ML().defPoints);
  });

  it("every handle is unique and the handle seed is past them", () => {
    const dxf = entitiesToDxf2018([ML(), L({ id: "ld9" })]);
    const lines = dxf.split("\n");
    const handles: string[] = [];
    for (let i = 0; i + 1 < lines.length; i += 2) if (lines[i].trim() === "5" && lines[i - 1]?.trim() !== "$HANDSEED") handles.push(lines[i + 1]);
    expect(new Set(handles).size).toBe(handles.length);
    const seed = parseInt(/\$HANDSEED\n5\n([0-9A-F]+)\n/.exec(dxf)![1], 16);
    expect(Math.max(...handles.map((h) => parseInt(h, 16)))).toBeLessThan(seed);
  });
});

describe("leaders from other CAD (no SKETCHOR data)", () => {
  it("reads a LEADER's vertices, spline flag, no-arrow flag and hookline", () => {
    const d = leaderFromRecord(
      { type: "LEADER", pairs: pairsOf([3, "ISO-25"], [71, 0], [72, 1], [73, 0], [75, 0], [40, 3.5], [76, 3], [10, 0], [20, 0], [30, 0], [10, 5], [20, 5], [30, 0], [10, 9], [20, 5], [30, 0]) },
      "Hello",
    )!;
    expect(d.defPoints).toEqual([P(0, 0), P(5, 5), P(9, 5)]);
    expect(d.leaderSpline).toBe(true);
    expect(d.style).toBe("ISO-25");
    expect(d.landing).toBe(0);
    expect(d.overrides).toEqual({ leaderArrow: "none", textHeight: 3.5 });
    expect(d.textOverride).toBe("Hello");
    expect(leaderFromRecord({ type: "LEADER", pairs: pairsOf([76, 1], [10, 0], [20, 0]) }, "")).toBeNull();
  });

  it("reads a MULTILEADER's lines, dogleg, text and sizes (layout as ezdxf writes it)", () => {
    const rec = {
      type: "MULTILEADER",
      pairs: pairsOf(
        [300, "CONTEXT_DATA{"], [40, 1], [10, 18], [20, 18.75], [30, 0], [41, 2.5], [140, 4], [145, 2], [290, 1], [304, "Hello"], [11, 0], [21, 0], [31, 1],
        [302, "LEADER{"], [290, 1], [291, 1], [10, 10], [20, 18.75], [30, 0], [11, 1], [21, 0], [31, 0], [90, 0], [40, 8],
        [304, "LEADER_LINE{"], [10, 0], [20, 0], [30, 0], [10, 10], [20, 10], [30, 0], [91, 0], [92, -1056964608], [305, "}"],
        [304, "LEADER_LINE{"], [10, 0], [20, 30], [30, 0], [91, 1], [305, "}"],
        [271, 0], [303, "}"], [272, 9], [273, 9], [301, "}"],
        [340, "2C"], [90, 2147483647], [170, 1], [91, -1056964608], [171, -2], [290, 1], [291, 1], [41, 8], [42, 4], [172, 2],
      ),
    };
    const d = mleaderFromRecord(rec)!;
    expect(d.defPoints).toEqual([P(0, 0), P(10, 10), P(10, 18.75)]);
    expect(d.branches).toEqual([[P(0, 30)]]);
    expect(d.landing).toBe(8);
    expect(d.textOverride).toBe("Hello");
    expect(d.overrides).toEqual({ textHeight: 2.5, arrowSize: 4 });
    expect(d.leaderSpline).toBeUndefined();
  });

  it("imports a LEADER whose MTEXT comes before it in the file as one leader", () => {
    const text = [
      "0\nSECTION\n2\nENTITIES",
      "0\nMTEXT\n5\nAB\n8\n0\n10\n20.0\n20\n10.0\n40\n2.5\n71\n4\n1\nNOTE",
      "0\nLEADER\n5\nAC\n8\n0\n3\nStandard\n73\n0\n76\n2\n10\n0.0\n20\n0.0\n10\n10.0\n20\n10.0\n340\nAB",
      "0\nENDSEC\n0\nEOF\n",
    ].join("\n");
    const r = parseDxf(text);
    expect(r.entities.length).toBe(1);
    const d = r.entities[0] as DimensionEntity;
    expect(d.kind).toBe("leader");
    expect(d.textOverride).toBe("NOTE");
    expect(r.report.skipped.map((s) => s.type)).not.toContain("LEADER");
  });

  it("never throws on truncated or empty leader records", () => {
    const text = "0\nSECTION\n2\nENTITIES\n0\nLEADER\n5\nAC\n0\nMULTILEADER\n5\nAD\n300\nCONTEXT_DATA{\n302\nLEADER{\n0\nENDSEC\n0\nEOF\n";
    expect(() => parseDxf(text)).not.toThrow();
    expect(parseDxf(text).entities.length).toBe(0);
  });
});

describe("leaders in R12", () => {
  it("still draw (lines, arrow and text) because R12 has no leader worth writing", () => {
    const dxf = entitiesToDxf([L()]);
    expect(dxf).not.toContain("LEADER");
    expect(dxf).toContain("SEE NOTE 4");
  });
});
