/**
 * A post profile is what a cutting machine actually obeys. A wrong dwell
 * unit pierces for 300 seconds instead of 0.3 (or 0.3 ms instead of 0.3 s,
 * blowing back slag); a comment character a controller doesn't know halts
 * the program; and a profile loaded from storage is untrusted text that ends
 * up as G-code. Every built-in is round-tripped through the existing reader
 * (N-44) so its motion means what the nest says.
 */
import { describe, expect, it } from "vitest";
import type { Entity } from "@sketchor/core";
import { gcodeToEntities } from "./parse";
import { BUILTIN_POSTS, builtinPost, DEFAULT_POST_ID, postProfileFromSpec, validatePostSpec } from "./posts";
import { buildCutPlan, type GcodePlacement } from "./toolpath";
import { writeGcode } from "./write";

const line = (id: string, a: { x: number; y: number }, b: { x: number; y: number }): Entity => ({ id, type: "line", a, b });
const rect = (x: number, y: number, w: number, h: number): Entity[] => {
  const p = [{ x, y }, { x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h }];
  return [0, 1, 2, 3].map((i) => line(`r${i}`, p[i], p[(i + 1) % 4]));
};
const part: GcodePlacement = { id: "p", number: 1, outerEntities: rect(10, 10, 80, 40), holeEntities: [{ id: "h", type: "circle", center: { x: 50, y: 30 }, radius: 8 }] };
const plan = buildCutPlan([part]);

describe("built-in posts", () => {
  it("include the plan's profiles and a usable default", () => {
    const ids = BUILTIN_POSTS.map((p) => p.id);
    expect(ids).toEqual(expect.arrayContaining(["generic-laser", "generic-plasma", "linuxcnc", "mach"]));
    expect(builtinPost(DEFAULT_POST_ID)).toBeDefined();
    expect(new Set(ids).size).toBe(ids.length);
  });

  for (const spec of BUILTIN_POSTS) {
    it(`${spec.name}: valid, ends correctly, and its motion round-trips through the reader`, () => {
      expect(validatePostSpec(spec)).toEqual({ ok: true, spec });
      const profile = postProfileFromSpec(spec);
      const text = writeGcode(plan.features, { unit: "mm", scale: 1, feedRateMmPerMin: 3000, pierceTimeSec: 0.3, profile });
      const lines = text.trim().split("\n");
      expect(lines[lines.length - 1]).toBe(spec.end);
      for (const h of spec.header) expect(lines).toContain(h);
      expect(lines.filter((l) => l === spec.on).length).toBe(plan.features.length); // one pierce per feature
      const comment = spec.comments === "paren" ? /^\(.*\)$/ : /^; /;
      expect(lines[0]).toMatch(comment);
      const parsed = gcodeToEntities(text);
      expect(parsed.commands.length).toBeGreaterThan(0);
      expect(parsed.stats.unitSource).toBe("declared");
      expect(parsed.stats.paths).toBe(plan.features.length);
    });
  }
});

describe("postProfileFromSpec", () => {
  const base = builtinPost("mach")!;
  it("writes the dwell in the profile's unit", () => {
    expect(postProfileFromSpec({ ...base, dwellUnit: "s" }).pierceDwell(0.25)).toBe("G4 P0.25");
    expect(postProfileFromSpec({ ...base, dwellUnit: "ms" }).pierceDwell(0.25)).toBe("G4 P250");
  });
  it("keeps comments from ending early or starting a new block", () => {
    expect(postProfileFromSpec({ ...base, comments: "paren" }).comment("Part (2); edge\nnext")).toBe("(Part 2 edge next)");
    expect(postProfileFromSpec({ ...base, comments: "semicolon" }).comment("a;b")).toBe("; a b");
  });
});

describe("validatePostSpec", () => {
  const good = { id: "my", name: "My laser", on: "m3 s800", off: "M5", dwellUnit: "ms", comments: "semicolon", header: ["g17  g40", ""], end: "M30" };
  it("accepts and normalises a hand-edited profile", () => {
    expect(validatePostSpec(good)).toEqual({
      ok: true,
      spec: { id: "my", name: "My laser", on: "M3 S800", off: "M5", dwellUnit: "ms", comments: "semicolon", header: ["G17 G40"], end: "M30" },
    });
  });
  it("rejects anything that isn't plain G-code words", () => {
    for (const bad of [{ on: "M3; G0 X999" }, { off: "(stop) M5" }, { end: "M30\nG0 X0" }, { header: ["G17", "rm -rf"] }, { on: "" }, { dwellUnit: "min" }, { comments: "hash" }]) {
      const r = validatePostSpec({ ...good, ...bad });
      expect(r.ok, JSON.stringify(bad)).toBe(false);
    }
    expect(validatePostSpec(null).ok).toBe(false);
  });
});
