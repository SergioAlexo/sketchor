import type { PostProfile } from "./write";

/**
 * N-42: post-processor profiles as plain data, so a profile can be listed in
 * a picker, saved with a job, copied and edited, and validated when it comes
 * back from storage. `postProfileFromSpec` turns one into the `PostProfile`
 * the writer calls.
 *
 * What differs between controllers for 2D cutting is small and is all here:
 * how the beam / torch turns on and off, the dwell command and its unit
 * (seconds or milliseconds), the comment style, a safety-line header, and how
 * the program ends. Motion is the same plain G0/G1/G2/G3 everywhere and no Z
 * is ever emitted (see write.ts), which is why one writer serves them all.
 *
 * Mach3/Mach4 read `G4 P` in seconds or milliseconds depending on the
 * controller's own configuration, so that profile's dwell unit is an edit
 * away rather than a guess baked in.
 */

export interface PostProfileSpec {
  id: string;
  name: string;
  /** Line(s) that start cutting (beam / torch on). */
  on: string;
  /** Line that stops cutting. */
  off: string;
  /** Dwell unit for the pierce: `G4 P<seconds>` or `G4 P<milliseconds>`. */
  dwellUnit: "s" | "ms";
  /** `paren` → `(text)`, `semicolon` → `; text`. */
  comments: "paren" | "semicolon";
  /** Lines after G90/G20|G21 (modal resets, units checks). */
  header: string[];
  /** Program end. */
  end: string;
}

export const BUILTIN_POSTS: readonly PostProfileSpec[] = [
  { id: "generic-laser", name: "Generic laser", on: "M3", off: "M5", dwellUnit: "s", comments: "paren", header: [], end: "M30" },
  {
    id: "generic-plasma",
    name: "Generic plasma",
    on: "M3",
    off: "M5",
    dwellUnit: "s",
    comments: "paren",
    // Cutter compensation and canned cycles off: the path already has the kerf baked in.
    header: ["G40", "G80"],
    end: "M30",
  },
  { id: "linuxcnc", name: "LinuxCNC", on: "M3 S1", off: "M5", dwellUnit: "s", comments: "paren", header: ["G17 G40 G49 G80 G94"], end: "M2" },
  { id: "mach", name: "Mach3 / Mach4", on: "M3", off: "M5", dwellUnit: "s", comments: "paren", header: ["G17 G40 G49 G80"], end: "M30" },
  // GRBL laser mode: M4 is dynamic power (scales with speed, so corners don't burn); S sets the power.
  { id: "grbl-laser", name: "GRBL laser", on: "M4 S1000", off: "M5", dwellUnit: "s", comments: "semicolon", header: [], end: "M2" },
];

export const DEFAULT_POST_ID = "generic-laser";

export function builtinPost(id: string): PostProfileSpec | undefined {
  return BUILTIN_POSTS.find((p) => p.id === id);
}

function round(n: number, places: number): number {
  const f = 10 ** places;
  const r = Math.round(n * f) / f;
  return Object.is(r, -0) ? 0 : r;
}

/** A comment can't contain the characters that would end it early or start a new one. */
const clean = (text: string) => text.replace(/[()\r\n;]/g, " ").replace(/\s+/g, " ").trim();

export function postProfileFromSpec(spec: PostProfileSpec): PostProfile {
  return {
    name: spec.name,
    laserOnCode: spec.on,
    laserOffCode: spec.off,
    pierceDwell: (sec) => (spec.dwellUnit === "ms" ? `G4 P${Math.round(sec * 1000)}` : `G4 P${round(sec, 3)}`),
    comment: (text) => (spec.comments === "semicolon" ? `; ${clean(text)}` : `(${clean(text)})`),
    header: spec.header,
    programEnd: spec.end,
  };
}

/** A G-code line a user may type into a profile: words like `M3`, `S1000`, `G17`; no comments, no line breaks, nothing a controller would read as a second block. */
// Spaces and tabs only between words: a newline would start a second block the user never typed.
const GCODE_LINE = /^(?:[A-Z][-+]?\d+(?:\.\d+)?(?:[ \t]+|$))+$/i;

export type PostValidation = { ok: true; spec: PostProfileSpec } | { ok: false; errors: string[] };

/** Checks a profile that came from storage or a user's edit before it can drive a machine. */
export function validatePostSpec(input: unknown): PostValidation {
  const errors: string[] = [];
  const o = (input ?? {}) as Record<string, unknown>;
  const str = (k: string) => (typeof o[k] === "string" ? (o[k] as string).trim() : "");
  const code = (k: string, required = true) => {
    const v = str(k);
    if (!v) {
      if (required) errors.push(`${k} is empty`);
      return v;
    }
    if (!GCODE_LINE.test(v)) errors.push(`${k} "${v}" is not a plain G-code line`);
    return v.toUpperCase().replace(/[ \t]+/g, " ");
  };
  const id = str("id");
  const name = str("name");
  if (!id) errors.push("id is empty");
  if (!name) errors.push("name is empty");
  const on = code("on");
  const off = code("off");
  const end = code("end");
  const dwellUnit = o.dwellUnit === "ms" ? "ms" : o.dwellUnit === "s" ? "s" : null;
  if (!dwellUnit) errors.push(`dwellUnit must be "s" or "ms"`);
  const comments = o.comments === "semicolon" ? "semicolon" : o.comments === "paren" ? "paren" : null;
  if (!comments) errors.push(`comments must be "paren" or "semicolon"`);
  const header: string[] = [];
  if (o.header !== undefined && !Array.isArray(o.header)) errors.push("header must be a list of lines");
  for (const [i, raw] of (Array.isArray(o.header) ? o.header : []).entries()) {
    const v = typeof raw === "string" ? raw.trim() : "";
    if (!v) continue;
    if (!GCODE_LINE.test(v)) errors.push(`header line ${i + 1} "${v}" is not a plain G-code line`);
    else header.push(v.toUpperCase().replace(/[ \t]+/g, " "));
  }
  if (errors.length) return { ok: false, errors };
  return { ok: true, spec: { id, name, on, off, end, dwellUnit: dwellUnit!, comments: comments!, header } };
}
