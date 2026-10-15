import { describe, expect, it } from "vitest";
import { APP_ALIASES, TOOL_ALIASES, commandSuggestions, parseCommand, pushHistory, recallHistory } from "./commandLine";

/**
 * The command line is a text box that starts tools and edits the drawing,
 * so a mis-parse is not a typo — it is the wrong tool running on the user's
 * geometry. The two dangerous confusions are a coordinate read as a command
 * (`-5,10` is a point, not a flag) and an unknown word silently doing
 * *something*; both are pinned here, along with the alias table staying
 * pointed at tools that actually exist.
 */

describe("parseCommand", () => {
  it("starts a tool from an AutoCAD alias or its full name", () => {
    expect(parseCommand("l")).toEqual({ kind: "tool", tool: "line", argument: null });
    expect(parseCommand("LINE")).toEqual({ kind: "tool", tool: "line", argument: null });
    expect(parseCommand("  rec  ")).toEqual({ kind: "tool", tool: "rectangle", argument: null });
  });

  it("keeps the rest of the line as the tool's argument", () => {
    expect(parseCommand("o 5")).toEqual({ kind: "tool", tool: "offset", argument: "5" });
    expect(parseCommand("f 2.5mm")).toEqual({ kind: "tool", tool: "fillet", argument: "2.5mm" });
  });

  it("recognises the non-tool commands", () => {
    expect(parseCommand("u")).toEqual({ kind: "app", id: "undo" });
    expect(parseCommand("erase")).toEqual({ kind: "app", id: "delete" });
    expect(parseCommand("rz")).toEqual({ kind: "app", id: "relativeZero" });
  });

  it("treats anything starting like a number as a point for the active tool", () => {
    expect(parseCommand("100,50")).toEqual({ kind: "point", text: "100,50" });
    expect(parseCommand("@30<45")).toEqual({ kind: "point", text: "@30<45" });
    expect(parseCommand("-5,10")).toEqual({ kind: "point", text: "-5,10" });
    expect(parseCommand(".5")).toEqual({ kind: "point", text: ".5" });
  });

  it("says it doesn't know rather than guessing", () => {
    expect(parseCommand("frobnicate")).toEqual({ kind: "unknown", text: "frobnicate" });
    expect(parseCommand("")).toEqual({ kind: "empty" });
    expect(parseCommand("   ")).toEqual({ kind: "empty" });
  });

  it("reads the letters AutoCAD spends on commands as commands, not as this app's tool keys", () => {
    // `x` and `e` are the text and... nothing, here — on the keyboard `x`
    // is the text tool. On the command line they keep AutoCAD's meaning,
    // which is what someone typing into a command line expects.
    expect(parseCommand("x")).toEqual({ kind: "app", id: "explode" });
    expect(parseCommand("e")).toEqual({ kind: "app", id: "delete" });
  });

  it("spline edit aliases (C-07): spe, splinedit, and rebuild keeps its verb as the argument", () => {
    expect(parseCommand("spe")).toEqual({ kind: "tool", tool: "splinedit", argument: null });
    expect(parseCommand("splinedit")).toEqual({ kind: "tool", tool: "splinedit", argument: null });
    expect(parseCommand("rebuild 8")).toEqual({ kind: "tool", tool: "splinedit", argument: "rebuild 8" });
  });

  it("parses simplify (P-03)", () => {
    expect(parseCommand("simplify")).toEqual({ kind: "app", id: "simplify" });
  });
});

describe("the alias tables", () => {
  it("map only to tools the app has", () => {
    const known = new Set([
      "select", "line", "polyline", "rectangle", "circle", "arc", "ellipse", "spline", "splinedit", "polygon", "slot", "point", "image",
      "measure", "straighten", "fill", "text", "dim", "dimlinear", "dimaligned", "dimangular", "dimradial", "dimdiametric", "dimarc", "dimordinate", "dimjogged", "dimbaseline", "dimcontinue", "qdim", "pan", "move", "copy", "rotate", "scale", "mirror",
      "trim", "split", "fillet", "chamfer", "offset", "zoom", "divide", "align", "lengthen", "match", "stretch", "block", "blockbase", "insert", "attdef",
    ]);
    for (const [alias, tool] of Object.entries(TOOL_ALIASES)) {
      expect(known.has(tool), `${alias} -> ${tool}`).toBe(true);
    }
  });

  it("don't collide", () => {
    // An app command would win (see parseCommand), so an accidental overlap
    // is a tool that quietly stops starting. Keep them disjoint.
    expect(Object.keys(TOOL_ALIASES).filter((a) => a in APP_ALIASES)).toEqual([]);
  });
});

describe("commandSuggestions", () => {
  it("completes a prefix, shortest first", () => {
    expect(commandSuggestions("ro")).toEqual(["ro", "rotate"]);
    expect(commandSuggestions("cha")).toEqual(["cha", "chamfer"]);
  });

  it("offers nothing for an empty box or a coordinate", () => {
    expect(commandSuggestions("")).toEqual([]);
    expect(commandSuggestions("100,")).toEqual([]);
  });
});

describe("history", () => {
  it("walks back with up and forward with down, stopping at the new line", () => {
    const h = ["l", "c", "o 5"];
    let step = recallHistory(h, -1, -1);
    expect(step).toEqual({ index: 0, text: "o 5" });
    step = recallHistory(h, step.index, -1);
    expect(step).toEqual({ index: 1, text: "c" });
    step = recallHistory(h, step.index, 1);
    expect(step).toEqual({ index: 0, text: "o 5" });
    step = recallHistory(h, step.index, 1);
    expect(step).toEqual({ index: -1, text: "" });
    // Already at the new line: down does nothing.
    expect(recallHistory(h, -1, 1)).toEqual({ index: -1, text: "" });
  });

  it("stops at the oldest entry instead of wrapping", () => {
    const h = ["a", "b"];
    expect(recallHistory(h, 1, -1)).toEqual({ index: 1, text: "a" });
  });

  it("has nothing to recall from an empty history", () => {
    expect(recallHistory([], -1, -1)).toEqual({ index: -1, text: "" });
  });

  it("drops blanks and immediate repeats, and caps the list", () => {
    expect(pushHistory(["l"], "l")).toEqual(["l"]);
    expect(pushHistory(["l"], "  ")).toEqual(["l"]);
    expect(pushHistory(["l"], "c")).toEqual(["l", "c"]);
    expect(pushHistory(Array.from({ length: 50 }, (_, i) => `c${i}`), "new", 50)).toHaveLength(50);
  });
});
