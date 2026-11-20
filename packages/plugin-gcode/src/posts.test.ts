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
import { BUILTIN_POSTS, builtinPost, DEFAULT_POST_ID, isCustomPostId, MAX_CUSTOM_POSTS, newCustomPostId, parseCustomPosts, postProfileFromSpec, removeCustomPost, resolvePost, upsertCustomPost, validatePostSpec, type PostProfileSpec } from "./posts";
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

describe("custom post-processors (N-42 editor)", () => {
  const mach = builtinPost("mach")!;

  it("editing a built-in saves a custom copy under a custom- id, never changing the built-in", () => {
    const r = upsertCustomPost([], { ...mach, on: "M3 S500" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(isCustomPostId(r.id)).toBe(true);
    expect(r.list).toHaveLength(1);
    expect(r.list[0]).toMatchObject({ id: r.id, on: "M3 S500", name: "Mach3 / Mach4 (custom)" });
    expect(builtinPost("mach")!.on).toBe("M3");
  });

  it("editing one of the user's own replaces it in place", () => {
    const first = upsertCustomPost([], { ...mach, name: "Shop plasma" });
    if (!first.ok) throw new Error("save failed");
    const again = upsertCustomPost(first.list, { ...first.list[0], off: "M5 M9" });
    expect(again).toMatchObject({ ok: true, id: first.id });
    if (again.ok) expect(again.list).toEqual([{ ...first.list[0], off: "M5 M9" }]);
  });

  it("refuses anything that isn't plain G-code, so an edit can't smuggle a second block onto the machine", () => {
    for (const bad of [{ on: "M3\nG0 X0" }, { off: "M5 (bye)" }, { end: "" }, { header: ["G17", "M3; G1 X999"] }]) {
      const r = upsertCustomPost([], { ...mach, ...bad });
      expect(r.ok).toBe(false);
    }
  });

  it("stops at the cap, but still lets an existing one be edited", () => {
    let list: PostProfileSpec[] = [];
    for (let i = 0; i < MAX_CUSTOM_POSTS; i++) {
      const r = upsertCustomPost(list, { ...mach, name: `P${i}` });
      if (!r.ok) throw new Error(r.errors.join());
      list = r.list;
    }
    expect(upsertCustomPost(list, { ...mach, name: "one too many" }).ok).toBe(false);
    expect(upsertCustomPost(list, { ...list[0], on: "M3 S1" }).ok).toBe(true);
  });

  it("ids are unique, short enough for a job's postId, and can't collide with a built-in", () => {
    expect(newCustomPostId("Shop plasma!", [])).toBe("custom-shop-plasma");
    expect(newCustomPostId("Shop plasma", ["custom-shop-plasma"])).toBe("custom-shop-plasma-2");
    expect(newCustomPostId("???", [])).toBe("custom-post");
    const long = newCustomPostId("x".repeat(200), []);
    expect(long.length).toBeLessThanOrEqual(40);
    expect(isCustomPostId(long)).toBe(true);
    for (const b of BUILTIN_POSTS) expect(isCustomPostId(b.id)).toBe(false);
  });

  it("re-validates what comes back from storage: invalid, built-in-shaped and duplicate entries are dropped", () => {
    const good = { ...mach, id: "custom-a", name: "A" };
    const stored = [good, { ...good }, { ...mach, id: "mach", name: "fake built-in" }, { ...good, id: "custom-b", on: "M3\nM30" }, "junk", null];
    expect(parseCustomPosts(stored)).toEqual([good]);
    expect(parseCustomPosts({ not: "a list" })).toEqual([]);
  });

  it("a job's postId resolves to a built-in, then the user's own, then the default", () => {
    const own = { ...mach, id: "custom-a", name: "A" };
    expect(resolvePost("linuxcnc", [own]).id).toBe("linuxcnc");
    expect(resolvePost("custom-a", [own])).toBe(own);
    expect(resolvePost("custom-gone", [own]).id).toBe(DEFAULT_POST_ID);
    expect(resolvePost(undefined, []).id).toBe(DEFAULT_POST_ID);
    expect(removeCustomPost([own], "custom-a")).toEqual([]);
  });
});
